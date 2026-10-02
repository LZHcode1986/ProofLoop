/**
 * @proofloop/runtime — mechanical catalog family: Execute Slice lane start.
 *
 * ONE high-level semantic event `execute.lane.start` (R2-B / G6, ADR-026 /
 * E2E-33 / STATIC-41, tech-spec/contracts.md §2.1.3 / §5.1,
 * architecture #/entities/planning-acceptance-succession / work-lineage).
 *
 * Caller-owned (semantic sources that cannot be derived from current durable
 * state):
 *   - the Brain-authorized transition subject (`stage_id`, `slice_id`);
 *   - the existing lane `actionToken` (Brain-assigned lane token; each new
 *     lane binding requires a unique token — contracts.md §5.1 / §4.3).
 * The NORMAL execution binding (`authority_refs`, current mechanical worktree
 * `git_basis`) comes from the event binding.
 *
 * Runtime derives (never caller-supplied):
 *   - the current open delivery cycle and the current accepted Plan generation
 *     of the same (stage, cycle) cohort (ambiguous / missing → no-write);
 *   - the accepted-Plan execution-graph capability from the durable
 *     `accepted_plan_ref` blob at the accepted generation's canonical Git
 *     basis (bounded reader → `buildAcceptedPlanTaskGraph` in the SAME
 *     process, so the WeakSet brand stays valid);
 *   - a deterministic fresh Work identity (`work_id` + `fact_id`) from the
 *     semantic replay identity — never from insertion order / timestamps;
 *   - `supersedes_work_ref` when a restart creates a Work-lineage successor
 *     attempt (current lineage tip is the predecessor; a replay keeps the
 *     already-stored predecessor so the replayed event is byte-identical);
 *   - the initial `PLANNED` Task facts for the Slice, whose
 *     `depends_on_task_ids` EXACTLY equal the accepted-Plan dependency edge
 *     set of the same task.
 *
 * Non-goals: the handler never selects route / next Task / next Stage / next
 * action, never reads a caller-supplied graph / digest, never parses Plan
 * Markdown itself, and never persists anything but the derived fact delta.
 */
import { createHash } from 'node:crypto';
import { canonicalStringify } from '../cli/proofloop-common';
import {
  isCycleBearingPlanAcceptanceGeneration,
  resolvePlanAcceptanceGenerationTips,
  resolveWorkLineageTips,
  workLineageKeyOf,
} from './binding';
import { verifyProjectReadySupportError } from './terminal';
import { readAcceptedPlanExecutionGraph } from './accepted-plan-reader';
import { materializeFail } from './materialization-error';
import { buildLaneWorkFact } from '../execute/lane';
import { buildTaskFact } from '../execute/lane';
import type {
  MesSemanticEvent,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
} from './semantic-event';
import type { MesFactEnvelope, MesGitBasis, MesPlanBinding } from './types';

/** The one lane-start event kind. */
export const LANE_START_EVENT_KIND = 'execute.lane.start';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function payloadString(event: MesSemanticEvent, field: string, eventKind: string): string {
  const value = event.payload[field];
  if (!isNonEmptyString(value)) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty string ${field}`, eventKind);
  }
  return value;
}

/** Deterministic opaque identity of one semantic lane-start source. */
function sourceIdentityDigest(parts: readonly string[]): string {
  return createHash('sha256').update(Buffer.from(canonicalStringify(parts), 'utf8')).digest('hex');
}

/** Cycle anchor: ANY cycle-bearing PVR/PA planning fact (same set as store). */
function isCycleAnchoredPlanningFact(fact: MesFactEnvelope): boolean {
  if (fact.fact_kind !== 'planning_verification_result' && fact.fact_kind !== 'plan_acceptance') return false;
  return isNonEmptyString(fact.plan_binding?.delivery_cycle_id);
}

function isClosedCycle(context: readonly MesFactEnvelope[], cycle: string): boolean {
  return context.some(
    (fact) =>
      fact.fact_kind === 'project_ready' &&
      fact.delivery_cycle_id === cycle &&
      verifyProjectReadySupportError(fact, context) === undefined,
  );
}

/** Resolve the unique current open delivery cycle (fail closed). */
function resolveCurrentOpenCycle(eventKind: string, current: readonly MesFactEnvelope[]): string {
  const openCycles = new Set<string>();
  for (const fact of current) {
    if (!isCycleAnchoredPlanningFact(fact)) continue;
    const cycle = fact.plan_binding?.delivery_cycle_id;
    if (isNonEmptyString(cycle) && !isClosedCycle(current, cycle)) openCycles.add(cycle);
  }
  if (openCycles.size > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} cannot resolve a unique current open delivery cycle（multiple open cycles: ${[...openCycles].sort().join(', ')}）— no-write`,
      eventKind,
    );
  }
  if (openCycles.size === 1) return [...openCycles][0];
  materializeFail(
    'binding-mismatch',
    `semantic event ${eventKind} has no open delivery cycle — no lane can start before an accepted Plan generation exists, no-write`,
    eventKind,
  );
}

/** Resolve the unique current accepted generation of one (stage, cycle) cohort. */
function resolveCurrentAcceptedGeneration(
  eventKind: string,
  current: readonly MesFactEnvelope[],
  stageId: string,
  cycle: string,
): MesFactEnvelope {
  const resolved = resolvePlanAcceptanceGenerationTips(current);
  if (!resolved.ok) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} cannot resolve accepted-generation tips: ${resolved.error}`, eventKind);
  }
  const cohort = resolved.tips.filter(
    (fact) =>
      fact.scope?.stage_id === stageId &&
      fact.plan_binding?.binding_stage === 'accepted' &&
      fact.plan_binding.delivery_cycle_id === cycle &&
      isCycleBearingPlanAcceptanceGeneration(fact),
  );
  if (cohort.length === 0) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds no current accepted Plan generation for stage ${JSON.stringify(stageId)} cycle ${JSON.stringify(cycle)} — lane start requires an accepted Plan, no-write`,
      eventKind,
    );
  }
  if (cohort.length > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds ${cohort.length} accepted generations for stage ${JSON.stringify(stageId)} cycle ${JSON.stringify(cycle)} — no-write`,
      eventKind,
    );
  }
  return cohort[0];
}

/** Validate the NORMAL binding carries the mechanical worktree Git basis. */
function bindingGitBasis(event: MesSemanticEvent, eventKind: string): MesGitBasis {
  const basis = event.binding.git_basis;
  if (basis === undefined || typeof basis !== 'object' || basis === null) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a git_basis (current mechanical worktree basis)`, eventKind);
  }
  const record = basis as unknown as Record<string, unknown>;
  const head = record.head;
  const branch = record.branch;
  const worktree = record.worktree;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) {
    materializeFail('invalid-field', `semantic event ${eventKind} git_basis.head must be a 40-char lowercase Git SHA`, eventKind);
  }
  if (!isNonEmptyString(branch)) {
    materializeFail('invalid-field', `semantic event ${eventKind} git_basis.branch must be a non-empty string`, eventKind);
  }
  if (!isNonEmptyString(worktree)) {
    materializeFail('invalid-field', `semantic event ${eventKind} git_basis.worktree must be a root-relative path`, eventKind);
  }
  return { head, branch, worktree };
}

/**
 * The ONE mechanical Execute lane-start family handler.
 */
export const laneStartHandler: MesSemanticEventHandler = (event, context): MesSemanticEventMaterialization => {
  const eventKind = event.event_kind;
  const stageId = payloadString(event, 'stage_id', eventKind);
  const sliceId = payloadString(event, 'slice_id', eventKind);
  const actionToken = payloadString(event, 'action_token', eventKind);
  if (sliceId.slice(0, sliceId.indexOf('-')) !== stageId) {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} slice_id ${JSON.stringify(sliceId)} does not belong to stage ${JSON.stringify(stageId)} — no-write`,
      eventKind,
    );
  }
  // Fail-fast closed-input validation BEFORE any state read: a lane-start
  // request always requires the current mechanical worktree basis.
  const gitBasis = bindingGitBasis(event, eventKind);
  const gitRoot = context.root;
  if (!isNonEmptyString(gitRoot)) {
    materializeFail('unreadable', `semantic event ${eventKind} requires a canonical project root to read the accepted Plan blob — no-write`, eventKind);
  }

  const cycle = resolveCurrentOpenCycle(eventKind, context.current);
  const generation = resolveCurrentAcceptedGeneration(eventKind, context.current, stageId, cycle);
  const acceptedBinding = generation.plan_binding;
  if (acceptedBinding === undefined || acceptedBinding.binding_stage !== 'accepted') {
    materializeFail('binding-mismatch', `semantic event ${eventKind} accepted generation ${JSON.stringify(generation.fact_id)} carries no accepted binding — no-write`, eventKind);
  }
  const { accepted_plan_ref, plan_digest, verification_result_ref } = acceptedBinding;
  if (!isNonEmptyString(accepted_plan_ref) || !isNonEmptyString(verification_result_ref)) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} accepted generation ${JSON.stringify(generation.fact_id)} has no accepted_plan_ref / verification_result_ref — no-write`, eventKind);
  }
  if (typeof plan_digest !== 'string' || !/^[0-9a-f]{64}$/.test(plan_digest)) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} accepted generation ${JSON.stringify(generation.fact_id)} has no valid plan_digest — no-write`, eventKind);
  }
  const gitBasisHead = generation.git_basis?.head;
  if (typeof gitBasisHead !== 'string' || !/^[0-9a-f]{40}$/.test(gitBasisHead)) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} accepted generation ${JSON.stringify(generation.fact_id)} has no canonical Git basis — no-write`, eventKind);
  }

  // Bounded accepted-Plan execution-graph reader: same-process WeakSet brand.
  const graph = readAcceptedPlanExecutionGraph({
    gitRoot,
    acceptedPlanRef: accepted_plan_ref,
    expectedPlanDigest: plan_digest,
    gitBasisHead,
  });

  // Deterministic, replay-stable Work lineage identity. The replay identity is
  // (stage, slice, cycle, accepted generation, lane action token): a restart is
  // a NEW lane binding with a fresh actionToken, so it derives a fresh Work
  // attempt rather than rewriting the prior lineage tip's facts.
  const workTag = sourceIdentityDigest([stageId, sliceId, cycle, verification_result_ref, actionToken]);
  const workId = `mes:work:${stageId}:${sliceId}:${workTag}`;
  const workFactId = `mes:fact:work:${stageId}:${sliceId}:${workTag}`;

  // Replay stability: an already-durable attempt keeps its stored predecessor
  // (replayed event reproduces the durable envelope byte-for-byte); a genuinely
  // new attempt resolves the current lineage tip as its successor edge.
  const existingWork = context.current.find((fact) => fact.fact_id === workFactId && fact.fact_kind === 'work');
  let supersedesWorkRef: string | null;
  if (existingWork !== undefined) {
    supersedesWorkRef = existingWork.supersedes_work_ref ?? null;
  } else {
    const lineageKey = workLineageKeyOf({
      ...({} as MesFactEnvelope),
      fact_kind: 'work',
      scope: { stage_id: stageId, slice_id: sliceId },
      plan_binding: acceptedBinding,
      supersedes_work_ref: null,
    } as MesFactEnvelope);
    const tips = resolveWorkLineageTips(context.current);
    if (!tips.ok) {
      materializeFail('binding-mismatch', `semantic event ${eventKind} cannot resolve current Work lineage tips: ${tips.error}`, eventKind);
    }
    const cohortTips = tips.tips.filter((fact) => fact.fact_id !== workFactId && workLineageKeyOf(fact) === lineageKey);
    if (cohortTips.length > 1) {
      materializeFail(
        'binding-mismatch',
        `semantic event ${eventKind} finds ${cohortTips.length} current Work tips for the same (stage, slice, cycle, generation) lineage — no-write`,
        eventKind,
      );
    }
    supersedesWorkRef = cohortTips.length === 1 ? cohortTips[0].fact_id : null;
  }

  const planBinding = acceptedBinding as unknown as MesPlanBinding;

  let workFact: MesFactEnvelope;
  try {
    workFact = buildLaneWorkFact({
      stage_id: stageId,
      slice_id: sliceId,
      work_id: workId,
      fact_id: workFactId,
      authority_refs: [...event.binding.authority_refs],
      plan_binding: planBinding,
      git_basis: gitBasis,
      supersedes_work_ref: supersedesWorkRef,
    });
  } catch (error) {
    materializeFail(
      'invalid-derived-fact',
      `semantic event ${eventKind} Work fact construction failed: ${error instanceof Error ? error.message : String(error)}`,
      eventKind,
    );
  }

  // Initial Task facts for the Slice: every task of the slice from the accepted
  // Plan graph, status PLANNED, dependencies EXACTLY the accepted-Plan edge set.
  const sliceTasks = graph.task_ids.filter((taskId) => taskId.slice(0, taskId.lastIndexOf('-')) === sliceId);
  if (sliceTasks.length === 0) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} accepted Plan graph has no task for slice ${JSON.stringify(sliceId)} — no-write`,
      eventKind,
    );
  }
  const taskFacts: MesFactEnvelope[] = [];
  for (const taskId of sliceTasks) {
    const dependencies = graph.edges
      .filter((edge) => edge.kind === 'dependency' && edge.from === taskId)
      .map((edge) => edge.to);
    try {
      const taskFact = buildTaskFact({
        task_id: taskId,
        task_status: 'PLANNED',
        depends_on_task_ids: dependencies,
        work_id: workId,
        fact_id: `mes:fact:task:${taskId}:${workTag}:PLANNED`,
        authority_refs: [...event.binding.authority_refs],
        plan_binding: planBinding,
        git_basis: gitBasis,
      });
      taskFacts.push(taskFact);
    } catch (error) {
      materializeFail(
        'invalid-derived-fact',
        `semantic event ${eventKind} Task fact construction failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        eventKind,
      );
    }
  }

  return {
    facts: [workFact, ...taskFacts],
    acceptedPlanTaskGraph: graph,
  };
};

/**
 * The ONE mechanical catalog entry of the Execute lane-start family.
 */
export const LANE_START_ENTRY: MesSemanticEventCatalogEntry = {
  event_kind: LANE_START_EVENT_KIND,
  caller_fields: ['stage_id', 'slice_id', 'action_token'],
  required_caller_fields: ['stage_id', 'slice_id', 'action_token'],
  runtime_derived_fields: [
    'fact_id',
    'work_id',
    'supersedes_work_ref',
    'plan_binding',
    'delivery_cycle_id',
    'accepted_plan_ref',
    'accepted_plan_digest',
    'accepted_plan_task_graph',
    'task_facts',
  ],
  durable_outputs: [
    { fact_kind: 'work', mutability: 'immutable' },
    { fact_kind: 'task', mutability: 'immutable' },
  ],
  reused_oracles: [
    'resolvePlanAcceptanceGenerationTips',
    'isCycleBearingPlanAcceptanceGeneration',
    'verifyProjectReadySupportError',
    'resolveWorkLineageTips',
    'workLineageKeyOf',
    'readAcceptedPlanExecutionGraph',
    'buildAcceptedPlanTaskGraph',
    'buildLaneWorkFact',
    'buildTaskFact',
  ],
  forbidden_caller_fields: [
    'work_id',
    'fact_id',
    'work_fact',
    'task_facts',
    'supersedes_work_ref',
    'plan_binding',
    'delivery_cycle_id',
    'accepted_plan_ref',
    'accepted_plan_digest',
    'accepted_plan_task_graph',
    'graph_digest',
    'thin_plan_ref',
    'plan_digest',
    'verification_result_ref',
  ],
  failure_codes: ['invalid-field', 'binding-mismatch', 'conflict', 'invalid-derived-fact', 'unreadable'],
  replay_identity: ['stage_id', 'slice_id', 'delivery_cycle_id', 'verification_result_ref', 'action_token'],
  canonicalization: [
    'work_id / work fact_id / task fact_ids = sha256(canonicalStringify(replay_identity)) prefixes (no timestamps, no snapshot digest, no insertion order)',
    'supersedes_work_ref = current lineage tip (fresh attempt) or stored predecessor (byte-identical replay)',
    'task_status = PLANNED; depends_on_task_ids EXACTLY the accepted-Plan dependency edge set of the task',
    'accepted binding + plan_digest + Git basis copied from the current accepted generation fact',
  ],
};