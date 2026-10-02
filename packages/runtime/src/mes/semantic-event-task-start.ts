/**
 * @proofloop/runtime — mechanical catalog family: Execute Task start.
 *
 * ONE high-level semantic event `execute.task.start` (Authority closure
 * `tech-spec/contracts.md` §4.3 / §5.1 / §5.3, E2E-19 / E2E-33 /
 * STATIC-41, ADR-026 / ADR-027).
 *
 * Brain owns dependency-ready Task selection (Brain selects the current
 * Task from the accepted Plan's stable order); Runtime NEVER selects a Task.
 * `execute.task.start` only mechanically verifies that the requested Task is
 * legally startable in the current durable relation and materializes the
 * single `Task(IN_PROGRESS)` fact:
 *
 *   - current accepted generation unique;
 *   - current Work lineage tip unique;
 *   - requested task belongs to the current accepted Plan graph;
 *   - requested task belongs to the current Slice (derived from the
 *     canonical task id);
 *   - requested task is dependency-ready in the current stable order
 *     (every dependency edge target has a durable `TASK_COMPLETE` of the
 *     current Work attempt);
 *   - current durable Task status = `PLANNED`;
 *   - lane `actionToken` current (re-derived deterministically from the
 *     caller token against the current Work identity — the token itself is
 *     NOT durable, contracts.md §4.3);
 *   - submitted event Git basis equals the current Work lane basis
 *     (relation owner: event → current Work, NOT → planning generation,
 *     contracts.md §5.3).
 *
 * It NEVER selects the next Task, routes, outputs a next action, dispatches
 * a Worker, interprets Plan prose or mutates the dependency graph. Replay of
 * the same legal task.start is byte-stable: it returns the already-durable
 * IN_PROGRESS fact (transaction dedup) and never mints a second IN_PROGRESS
 * history; stale token / wrong task / blocked dependency / stale Work /
 * wrong basis are all typed no-write.
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
import { materializeFail } from './materialization-error';
import { readAcceptedPlanExecutionGraph } from './accepted-plan-reader';
import { selectNextReadyTask } from '../execute/successor-barrier';
import { buildTaskFact, TASK_STATUSES } from '../execute/lane';
import { MES_TASK_ID_RE } from './types';
import type {
  MesSemanticEvent,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
} from './semantic-event';
import type { MesFactEnvelope, MesGitBasis, MesPlanBinding } from './types';

/** The one Execute Task-start event kind. */
export const TASK_START_EVENT_KIND = 'execute.task.start';

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

/** Deterministic opaque identity of one semantic task-start source. */
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
    `semantic event ${eventKind} has no open delivery cycle — no task can start before an accepted Plan generation exists, no-write`,
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
      `semantic event ${eventKind} finds no current accepted Plan generation for stage ${JSON.stringify(stageId)} cycle ${JSON.stringify(cycle)} — no task can start, no-write`,
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

/** Resolve the unique current Work-lineage tip of the (stage, slice, cycle, generation) lane. */
function resolveCurrentWorkTip(
  eventKind: string,
  current: readonly MesFactEnvelope[],
  stageId: string,
  sliceId: string,
  acceptedBinding: MesPlanBinding & { accepted_plan_ref: string; plan_digest: string },
): MesFactEnvelope {
  const tips = resolveWorkLineageTips(current);
  if (!tips.ok) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} cannot resolve current Work lineage tips: ${tips.error}`, eventKind);
  }
  const lineageKey = workLineageKeyOf({
    schema_version: 2,
    fact_id: '',
    fact_kind: 'work',
    created_by: 'brain',
    authority_refs: [],
    scope: { stage_id: stageId, slice_id: sliceId },
    plan_binding: acceptedBinding,
    supersedes_work_ref: null,
  } as MesFactEnvelope);
  const cohortTips = tips.tips.filter((fact) => workLineageKeyOf(fact) === lineageKey);
  if (cohortTips.length > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds ${cohortTips.length} current Work tips for the same (stage, slice, cycle, generation) lane — no-write`,
      eventKind,
    );
  }
  if (cohortTips.length === 0) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds no current Work attempt for stage ${JSON.stringify(stageId)} slice ${JSON.stringify(sliceId)} — lane start must precede task start, no-write`,
      eventKind,
    );
  }
  return cohortTips[0];
}

/** Find the current durable status of one Task within one Work attempt. */
function resolveCurrentTaskStatus(
  eventKind: string,
  current: readonly MesFactEnvelope[],
  taskId: string,
  workId: string,
): MesFactEnvelope | undefined {
  const taskFacts = current.filter(
    (fact) => fact.fact_kind === 'task' && fact.work_id === workId && fact.scope?.task_id === taskId,
  );
  if (taskFacts.length === 0) return undefined;
  // The status with the highest position in the closed status list is the
  // current one (append-only Task history; same-machine order is never used).
  let currentFact = taskFacts[0];
  for (const fact of taskFacts) {
    if (fact.task_status !== undefined && currentFact.task_status !== undefined) {
      const a = TASK_STATUSES.indexOf(fact.task_status);
      const b = TASK_STATUSES.indexOf(currentFact.task_status);
      if (a > b) currentFact = fact;
    }
  }
  return currentFact;
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
 * The ONE mechanical Execute Task-start family handler.
 */
export const taskStartHandler: MesSemanticEventHandler = (event, context): MesSemanticEventMaterialization => {
  const eventKind = event.event_kind;
  const taskId = payloadString(event, 'task_id', eventKind);
  if (!MES_TASK_ID_RE.test(taskId)) {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} task_id ${JSON.stringify(taskId)} is not a canonical Task ID — no-write`,
      eventKind,
    );
  }
  const laneActionToken = payloadString(event, 'lane_action_token', eventKind);
  // Stage/slice derive from the canonical task id (S03-A-T01 → S03 / S03-A).
  const sliceId = taskId.slice(0, taskId.lastIndexOf('-'));
  const stageId = sliceId.slice(0, sliceId.indexOf('-'));
  if (!isNonEmptyString(stageId) || !isNonEmptyString(sliceId)) {
    materializeFail('invalid-field', `semantic event ${eventKind} cannot derive stage/slice from task_id ${JSON.stringify(taskId)} — no-write`, eventKind);
  }

  // Fail-fast closed-input validation BEFORE any state read: a task-start
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

  // Requested task must belong to the current accepted Plan graph.
  if (!graph.task_ids.includes(taskId)) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} task ${JSON.stringify(taskId)} is not in the current accepted Plan graph — no-write`,
      eventKind,
    );
  }
  // Requested task must belong to the current Slice (canonical slice of the
  // derived lane; the graph carries the slice's task set).
  const sliceTasks = graph.task_ids.filter((id) => id.slice(0, id.lastIndexOf('-')) === sliceId);
  if (!sliceTasks.includes(taskId)) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} task ${JSON.stringify(taskId)} does not belong to slice ${JSON.stringify(sliceId)} of the accepted Plan graph — no-write`,
      eventKind,
    );
  }

  const acceptedBindingTyped = acceptedBinding as unknown as MesPlanBinding & { accepted_plan_ref: string; plan_digest: string };
  const workTip = resolveCurrentWorkTip(eventKind, context.current, stageId, sliceId, acceptedBindingTyped);
  const workId = workTip.work_id as string;

  // Lane actionToken current: the token is NOT durable (contracts.md §4.3);
  // the Work identity embeds it deterministically, so re-deriving the lane's
  // work identity from the caller token must equal the current Work tip.
  const expectedWorkTag = sourceIdentityDigest([stageId, sliceId, cycle, verification_result_ref, laneActionToken]);
  const expectedWorkId = `mes:work:${stageId}:${sliceId}:${expectedWorkTag}`;
  if (workId !== expectedWorkId) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} lane action token does not resolve to the current Work attempt (stale token / non-current lane, no-write; §4.3)`,
      eventKind,
    );
  }

  // Submitted event Git basis must equal the current Work lane basis
  // (relation owner: event → current Work, NOT → planning generation; §5.3).
  const workBasis = workTip.git_basis;
  if (
    workBasis === undefined ||
    workBasis.head !== gitBasis.head ||
    workBasis.branch !== gitBasis.branch ||
    workBasis.worktree !== gitBasis.worktree
  ) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} submitted event Git basis does not equal the current Work lane basis — no-write（§5.3）`,
      eventKind,
    );
  }

  // Dependency-ready in the current stable order: every dependency edge
  // target must have a durable accepted predecessor (`TASK_COMPLETE`) of the
  // current Work attempt (successor consumes only durable accepted
  // predecessor output; §4.3).
  const dependencies = graph.edges
    .filter((edge) => edge.kind === 'dependency' && edge.from === taskId)
    .map((edge) => edge.to);
  for (const dep of dependencies) {
    const depStatus = resolveCurrentTaskStatus(eventKind, context.current, dep, workId);
    if (depStatus === undefined || depStatus.task_status !== 'TASK_COMPLETE') {
      materializeFail(
        'binding-mismatch',
        `semantic event ${eventKind} task ${JSON.stringify(taskId)} is not dependency-ready: predecessor ${JSON.stringify(dep)} has no durable TASK_COMPLETE in the current Work attempt — no-write`,
        eventKind,
      );
    }
  }

  // Deterministic, replay-stable IN_PROGRESS identity.
  const identity = sourceIdentityDigest([stageId, sliceId, cycle, verification_result_ref, taskId, laneActionToken]);
  const inProgressFactId = `mes:fact:task:${taskId}:${identity}:IN_PROGRESS`;
  const existing = context.current.find((fact) => fact.fact_kind === 'task' && fact.fact_id === inProgressFactId);
  if (existing !== undefined) {
    // Byte-identical replay: return the already-durable IN_PROGRESS fact;
    // the transaction dedups byte-identical facts, so there is never a second
    // IN_PROGRESS history and the snapshot semantics never change.
    return { facts: [existing], acceptedPlanTaskGraph: graph };
  }
  // (Authority E2E-19 stable-order) the requested Task must be the FIRST
  // dependency-ready Task of the accepted-Plan stable order. The Runtime
  // oracle computes first-ready deterministically from the durable state;
  // Brain owns Task SELECTION, but a request that skips a ready predecessor
  // (same Slice, both dependency-ready) is typed no-write. Reuses the
  // existing successor-barrier oracle (no reinvented selection rules).
  let firstReady: string[] = [];
  try {
    firstReady = selectNextReadyTask({
      sliceId,
      taskOrder: sliceTasks.map((task) => ({
        taskId: task,
        dependsOnTaskIds: graph.edges
          .filter((edge) => edge.kind === 'dependency' && edge.from === task)
          .map((edge) => edge.to),
      })),
      durableFacts: context.current,
      binding: {
        accepted_plan_ref,
        plan_digest,
        work_id: workId,
        git_basis: workBasis,
      },
    });
  } catch (error) {
    materializeFail(
      'invalid-derived-fact',
      `semantic event ${eventKind} ready-task oracle failed: ${error instanceof Error ? error.message : String(error)}`,
      eventKind,
    );
  }
  if (firstReady.length === 0 || firstReady[0] !== taskId) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} task ${JSON.stringify(taskId)} is not the first dependency-ready Task of the accepted-Plan stable order (first-ready: ${JSON.stringify(firstReady[0] ?? '(none)')}) — wrong Task relative to stable ready order, no-write（E2E-19）`,
      eventKind,
    );
  }


  // Fresh start: the current durable Task status must be PLANNED.
  const currentTask = resolveCurrentTaskStatus(eventKind, context.current, taskId, workId);
  if (currentTask === undefined) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds no durable Task ${JSON.stringify(taskId)} in the current Work attempt — lane start must precede task start, no-write`,
      eventKind,
    );
  }
  if (currentTask.task_status !== 'PLANNED') {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} Task ${JSON.stringify(taskId)} is at ${JSON.stringify(currentTask.task_status)} — task.start requires the durable status PLANNED, no-write`,
      eventKind,
    );
  }

  const planBinding = acceptedBinding as unknown as MesPlanBinding;
  let inProgressFact: MesFactEnvelope;
  try {
    inProgressFact = buildTaskFact({
      task_id: taskId,
      task_status: 'IN_PROGRESS',
      depends_on_task_ids: dependencies,
      work_id: workId,
      fact_id: inProgressFactId,
      authority_refs: [...event.binding.authority_refs],
      plan_binding: planBinding,
      git_basis: workBasis,
    });
  } catch (error) {
    materializeFail(
      'invalid-derived-fact',
      `semantic event ${eventKind} IN_PROGRESS construction failed: ${error instanceof Error ? error.message : String(error)}`,
      eventKind,
    );
  }

  return {
    facts: [inProgressFact],
    acceptedPlanTaskGraph: graph,
  };
};

/**
 * The ONE mechanical catalog entry of the Execute Task-start family.
 */
export const TASK_START_ENTRY: MesSemanticEventCatalogEntry = {
  event_kind: TASK_START_EVENT_KIND,
  caller_fields: ['task_id', 'lane_action_token'],
  required_caller_fields: ['task_id', 'lane_action_token'],
  runtime_derived_fields: [
    'fact_id',
    'stage_id',
    'slice_id',
    'work_id',
    'work_tip',
    'task_fact',
    'task_status',
    'depends_on_task_ids',
    'plan_binding',
    'delivery_cycle_id',
    'generation',
    'graph',
  ],
  durable_outputs: [
    { fact_kind: 'task', mutability: 'immutable' },
  ],
  reused_oracles: [
    'readAcceptedPlanExecutionGraph',
    'buildAcceptedPlanTaskGraph',
    'buildTaskFact',
    'resolvePlanAcceptanceGenerationTips',
    'isCycleBearingPlanAcceptanceGeneration',
    'verifyProjectReadySupportError',
    'resolveWorkLineageTips',
    'workLineageKeyOf',
  ],
  forbidden_caller_fields: [
    'fact_id',
    'stage_id',
    'slice_id',
    'work_id',
    'work_fact',
    'task_fact',
    'task_status',
    'depends_on_task_ids',
    'plan_binding',
    'delivery_cycle_id',
    'generation',
    'work_tip',
    'graph',
    'durable_facts',
    'facts',
    'supersedes_work_ref',
    'accepted_plan_ref',
    'accepted_plan_digest',
    'accepted_plan_task_graph',
    'graph_digest',
    'thin_plan_ref',
    'plan_digest',
    'verification_result_ref',
  ],
  failure_codes: ['invalid-field', 'binding-mismatch', 'conflict', 'invalid-derived-fact', 'unreadable'],
  replay_identity: ['stage_id', 'slice_id', 'delivery_cycle_id', 'verification_result_ref', 'task_id', 'lane_action_token'],
  canonicalization: [
    'IN_PROGRESS fact_id = sha256(canonicalStringify(replay_identity)) prefixes (no timestamps, no snapshot digest, no insertion order)',
    'stage/slice derived from the canonical task id (never caller-supplied)',
    'work_id re-derived from the caller lane token must equal the current Work lineage tip (stale token → no-write)',
    'event Git basis must equal the current Work lane basis (relation owner: event → current Work, §5.3)',
    'task_status = IN_PROGRESS; depends_on_task_ids EXACTLY the accepted-Plan dependency edge set of the task',
    'dependency-ready: every dependency edge target has a durable TASK_COMPLETE of the current Work attempt',
    'accepted binding + plan_digest + Git basis copied from the current accepted generation fact',
    'task.start never selects next Task / routes / dispatches / mutates the dependency graph',
  ],
};
