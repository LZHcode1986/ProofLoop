/**
 * @proofloop/runtime — mechanical catalog family: Execute Task Result
 * acceptance.
 *
 * ONE high-level semantic event `execute.task_result.accept` (R3-A / G6,
 * ADR-026 / E2E-33 / STATIC-41, tech-spec/contracts.md §2.1.3 / §4.3 /
 * §5.1, architecture #/entities/mes-operational-transaction-boundary).
 *
 * Brain owns whether a fresh Worker Task Result is accepted and whether the
 * lane continues or pauses; Runtime only verifies that the requested
 * acceptance is legally bindable to the current durable relation and
 * materializes the durable outcome:
 *
 * Caller-owned (semantic sources that cannot be derived from current durable
 * state):
 *   - the submitted Worker Task Result (`result` — the exact envelope the
 *     Worker produced; Runtime re-validates it with the existing
 *     `validateWorkerTaskResult` seam and never trusts caller-shaped facts);
 *   - the Brain acceptance disposition (`ACCEPTED + CONTINUE|PAUSE`) as
 *     control input (REJECTED never produces a durable result / Task
 *     completion, so it is not a materializable acceptance);
 *   - the current Slice-lane action token (`lane_action_token`, Brain-held
 *     opaque token; the submitted result's token must equal it — the token is
 *     NOT durable, contracts.md §4.3).
 *
 * Runtime derives (never caller-supplied):
 *   - the current open delivery cycle and the current accepted Plan
 *     generation of the same (stage, cycle) cohort;
 *   - the current Work lineage tip of that (stage, slice, cycle, generation)
 *     lane, and the current Task of that attempt (its durable status is the
 *     transition source for TASK_COMPLETE);
 *   - the durable `result` fact identity (`fact_id` / `result_ref`) from the
 *     semantic replay identity, and the `result_payload_digest` from the
 *     existing S03-A-T01 digest oracle;
 *   - the TASK_COMPLETE Task fact (via the existing lane builder, whose
 *     TASK_COMPLETE gate requires the accepted durable result bound to the
 *     exact Task);
 *   - the closed TASK_RESULT_ACK envelope via the existing ACK builder over
 *     the durable facts — Brain never supplies raw `durableFacts`.
 *
 * Acceptances for R3 (fail-closed, no-write on any deviation): stale
 * Work/generation:
 *   - ambiguous / missing current open cycle or accepted generation;
 *   - the submitted result's stage/slice/task do not belong to the current
 *     lane; the Task is not the current one of the current Work attempt;
 *   - the Task is already TASK_COMPLETE (cannot re-accept);
 *   - the lane token is stale (submitted token != current lane token);
 *   - replay with a different payload under the same durable identity is a
 *     typed conflict; idempotent replay is byte-stable and returns the
 *     equivalent ACK without a duplicate TASK_COMPLETE.
 *
 * The handler never selects route / next Task / next Stage / next action,
 * never parses Plan Markdown, never reads a caller-supplied graph/fact
 * envelope, and never persists anything but the derived fact delta.
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
import { buildTaskResultAck, TaskResultAckError } from '../execute/task-result-ack';
import {
  validateWorkerTaskResult,
  TaskResultValidationError,
} from '../execute/task-result';
import { buildTaskFact, TASK_STATUSES } from '../execute/lane';
import type {
  MesSemanticEvent,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
} from './semantic-event';
import type { MesFactEnvelope, MesGitBasis, MesPlanBinding } from './types';

/** The one Task-Result-acceptance event kind. */
export const TASK_RESULT_ACCEPT_EVENT_KIND = 'execute.task_result.accept';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


function payloadString(event: MesSemanticEvent, field: string, eventKind: string): string {
  const value = event.payload[field];
  if (!isNonEmptyString(value)) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty string ${field}`, eventKind);
  }
  return value;
}

/** Deterministic opaque identity of one semantic acceptance source. */
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
    `semantic event ${eventKind} has no open delivery cycle — no acceptance before an accepted Plan generation exists, no-write`,
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
      `semantic event ${eventKind} finds no current accepted Plan generation for stage ${JSON.stringify(stageId)} cycle ${JSON.stringify(cycle)} — no acceptance, no-write`,
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
      `semantic event ${eventKind} finds no current Work attempt for stage ${JSON.stringify(stageId)} slice ${JSON.stringify(sliceId)} — lane start must precede result acceptance, no-write`,
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

/**
 * The ONE mechanical Execute Task-Result-acceptance family handler.
 */
export const taskResultAcceptHandler: MesSemanticEventHandler = (
  event,
  context,
): MesSemanticEventMaterialization => {
  const eventKind = event.event_kind;
  const resultRaw = event.payload.result;
  const laneActionToken = payloadString(event, 'lane_action_token', eventKind);
  const resultDisposition = event.payload.result_disposition;
  const continuationDisposition = event.payload.continuation_disposition;

  if (resultDisposition !== 'ACCEPTED') {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} requires result_disposition ACCEPTED to materialize an acceptance (REJECTED never writes MES; got ${JSON.stringify(resultDisposition)}) — no-write`,
      eventKind,
    );
  }
  if (continuationDisposition !== 'CONTINUE' && continuationDisposition !== 'PAUSE') {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} requires continuation_disposition CONTINUE or PAUSE (control input) — no-write`,
      eventKind,
    );
  }
  const reasonCode = event.payload.reason_code;
  if (continuationDisposition === 'PAUSE' && isNonEmptyString(reasonCode) === false) {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} requires a non-empty reason_code when continuation_disposition is PAUSE (mirrors the closed ACK rule) — no-write`,
      eventKind,
    );
  }
  if (continuationDisposition === 'CONTINUE' && reasonCode !== undefined) {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} forbids reason_code on ACCEPTED + CONTINUE (mirrors the closed ACK rule) — no-write`,
      eventKind,
    );
  }


  // Fail-fast on the raw envelope's discriminating fields BEFORE the full
  // Worker Result re-validation: this family is NORMAL + per-task only, so
  // MES_MAINTENANCE results and taskless (slice-ready/repair) results are
  // closed-field rejections (invalid-field), not derived-fact failures.
  const rawResult = isRecord(resultRaw) ? resultRaw : undefined;
  if (rawResult === undefined) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a Worker Task Result object — no-write`, eventKind);
  }
  if (rawResult.executionMode !== 'NORMAL') {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} only materializes NORMAL Executions (got ${JSON.stringify(rawResult.executionMode)}) — MES_MAINTENANCE never writes MES, no-write`,
      eventKind,
    );
  }
  if (rawResult.taskId === undefined || typeof rawResult.taskId !== 'string' || rawResult.taskId.length === 0) {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} requires a per-task validated Result (subShape 'task'); taskless slice-ready/repair results are not Task acceptances — no-write`,
      eventKind,
    );
  }
  // Re-validate the submitted Worker Task Result through the existing seam
  // (never trusts caller-shaped facts; digest is Runtime-computed).
  let validated: ReturnType<typeof validateWorkerTaskResult>;
  try {
    validated = validateWorkerTaskResult(resultRaw);
  } catch (error) {
    const detail =
      error instanceof TaskResultValidationError ? error.message : String(error);
    materializeFail('invalid-derived-fact', `semantic event ${eventKind} carries an invalid Worker Task Result: ${detail}`, eventKind);
  }
  if (validated.executionMode !== 'NORMAL') {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} only materializes NORMAL Executions (got ${JSON.stringify(validated.executionMode)}) — MES_MAINTENANCE never writes MES, no-write`,
      eventKind,
    );
  }
  if (validated.subShape !== 'task' || validated.taskId === undefined) {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} requires a per-task validated Result (subShape 'task'); taskless slice-ready/repair results are not Task acceptances — no-write`,
      eventKind,
    );
  }
  if ((validated.actionToken as string) !== laneActionToken) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} submitted actionToken does not equal the current lane token — stale token, no-write（§4.3）`,
      eventKind,
    );
  }

  const stageId = validated.stageId;
  const sliceId = validated.sliceId;
  const taskId = validated.taskId;

  const cycle = resolveCurrentOpenCycle(eventKind, context.current);
  const generation = resolveCurrentAcceptedGeneration(eventKind, context.current, stageId, cycle);
  const acceptedBinding = generation.plan_binding;
  if (acceptedBinding === undefined || acceptedBinding.binding_stage !== 'accepted') {
    materializeFail('binding-mismatch', `semantic event ${eventKind} accepted generation ${JSON.stringify(generation.fact_id)} carries no accepted binding — no-write`, eventKind);
  }
  if (acceptedBinding.accepted_plan_ref !== validated.planRef) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} submitted planRef ${JSON.stringify(validated.planRef)} does not equal the current accepted Plan ${JSON.stringify(acceptedBinding.accepted_plan_ref)} — stale generation, no-write`,
      eventKind,
    );
  }
  const gitBasisHead = generation.git_basis?.head;
  if (typeof gitBasisHead !== 'string' || validated.gitBasis.head !== gitBasisHead) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} submitted Git basis head does not equal the current accepted generation Git basis (stale Git basis, no-write)`,
      eventKind,
    );
  }

  // Replay stability: deterministic durable identities from the semantic
  // source — computed BEFORE any write decision, so a replay is recognised
  // against the already-durable acceptance (never from insertion order).
  const identity = sourceIdentityDigest([
    stageId,
    sliceId,
    cycle,
    acceptedBinding.verification_result_ref,
    taskId,
    validated.resultId,
  ]);
  const resultRef = `mes:result:${stageId}:${sliceId}:${identity}`;
  const resultFactId = `mes:fact:result:${stageId}:${sliceId}:${identity}`;

  // R3-A: the TASK_COMPLETE Task fact write triggers the store's accepted-Plan
  // graph binding gate, so the handler reconstructs the branded graph from the
  // durable accepted-Plan identity (same process, G6) — never from the caller.
  const planDigest = acceptedBinding.plan_digest;
  if (typeof planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(planDigest)) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} accepted generation ${JSON.stringify(generation.fact_id)} has no valid plan_digest — no-write`, eventKind);
  }
  const gitRoot = context.root;
  if (!isNonEmptyString(gitRoot)) {
    materializeFail('unreadable', `semantic event ${eventKind} requires a canonical project root to rebuild the accepted Plan graph — no-write`, eventKind);
  }
  const graph = readAcceptedPlanExecutionGraph({
    gitRoot,
    acceptedPlanRef: acceptedBinding.accepted_plan_ref,
    expectedPlanDigest: planDigest,
    gitBasisHead,
  });

  // Idempotent replay: the EXACT acceptance (same durable identity) is
  // already materialized. Return the already-durable fact pair plus the
  // equivalent closed ACK over the durable state — the transaction dedups
  // byte-identical facts, so there is never a second TASK_COMPLETE.
  const existingResult = context.current.find(
    (fact) => fact.fact_kind === 'result' && fact.fact_id === resultFactId,
  );
  if (existingResult !== undefined) {
    if (existingResult.result_payload_digest !== validated.resultPayloadDigest) {
      materializeFail(
        'conflict',
        `semantic event ${eventKind} durable result ${JSON.stringify(resultFactId)} already exists with a different payload digest (${JSON.stringify(existingResult.result_payload_digest)} vs ${JSON.stringify(validated.resultPayloadDigest)}) — same acceptance identity, different payload, no-write`,
        eventKind,
      );
    }
    const completedTaskId = `mes:fact:task:${taskId}:${identity}:TASK_COMPLETE`;
    const existingCompleted = context.current.find(
      (fact) => fact.fact_kind === 'task' && fact.fact_id === completedTaskId,
    );
    if (existingCompleted === undefined) {
      materializeFail(
        'binding-mismatch',
        `semantic event ${eventKind} durable result ${JSON.stringify(resultFactId)} exists but no matching TASK_COMPLETE task fact ${JSON.stringify(completedTaskId)} — inconsistent prior acceptance, no-write`,
        eventKind,
      );
    }
    let replayAck: unknown;
    try {
      replayAck = buildTaskResultAck({
        laneActionToken,
        submitted: validated,
        decision: {
          resultDisposition: 'ACCEPTED',
          continuationDisposition,
          acceptedResultRef: resultRef,
          ...(typeof reasonCode === 'string' ? { reasonCode } : {}),
        },
        durableFacts: context.current,
      });
    } catch (error) {
      if (error instanceof TaskResultAckError) {
        materializeFail(
          'binding-mismatch',
          `semantic event ${eventKind} TASK_RESULT_ACK construction failed: ${error.message}`,
          eventKind,
        );
      }
      materializeFail(
        'invalid-derived-fact',
        `semantic event ${eventKind} TASK_RESULT_ACK construction failed: ${error instanceof Error ? error.message : String(error)}`,
        eventKind,
      );
    }
    return {
      facts: [existingResult, existingCompleted],
      acceptedPlanTaskGraph: graph,
      ack: replayAck,
    };
  }

  // (fresh path) the branded accepted-Plan graph was already rebuilt above.
  const workTip = resolveCurrentWorkTip(eventKind, context.current, stageId, sliceId, acceptedBinding as unknown as MesPlanBinding & { accepted_plan_ref: string; plan_digest: string });
  const currentTask = resolveCurrentTaskStatus(eventKind, context.current, taskId, workTip.work_id as string);
  if (currentTask === undefined) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds no durable Task ${JSON.stringify(taskId)} in the current Work attempt ${JSON.stringify(workTip.work_id)} — no acceptance, no-write`,
      eventKind,
    );
  }
  if (currentTask.task_status === 'TASK_COMPLETE') {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} Task ${JSON.stringify(taskId)} is already TASK_COMPLETE in the current attempt — cannot re-accept, no-write`,
      eventKind,
    );
  }
  // (S03-A-T01 migration table) TASK_COMPLETE is ONLY reachable from a
  // durable TASK_RESULT_SUBMITTED Task of the current attempt (the ordered
  // progression PLANNED → IN_PROGRESS → TASK_RESULT_SUBMITTED → TASK_COMPLETE
  // is the single closed path; neither PLANNED nor IN_PROGRESS can jump
  // straight to COMPLETE).
  if (currentTask.task_status !== 'TASK_RESULT_SUBMITTED') {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} Task ${JSON.stringify(taskId)} is at ${JSON.stringify(currentTask.task_status)} — TASK_COMPLETE requires the durable predecessor TASK_RESULT_SUBMITTED of the current attempt, no-write`,
      eventKind,
    );
  }


  const gitBasis: MesGitBasis = {
    head: validated.gitBasis.head,
    branch: validated.gitBasis.branch,
    worktree: validated.gitBasis.worktree,
  };
  const planBinding = acceptedBinding as unknown as MesPlanBinding;
  const resultFact: MesFactEnvelope = {
    schema_version: 2,
    fact_id: resultFactId,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: [...event.binding.authority_refs],
    scope: { stage_id: stageId, slice_id: sliceId, task_id: taskId },
    work_id: workTip.work_id,
    result_ref: resultRef,
    plan_binding: planBinding,
    git_basis: gitBasis,
    result_id: validated.resultId,
    result_payload_digest: validated.resultPayloadDigest,
  } as MesFactEnvelope;

  let completedTaskFact: MesFactEnvelope;
  try {
    completedTaskFact = buildTaskFact(
      {
        task_id: taskId,
        task_status: 'TASK_COMPLETE',
        depends_on_task_ids: currentTask.depends_on_task_ids ?? [],
        ...(currentTask.blocked_by_task_id !== undefined
          ? { blocked_by_task_id: currentTask.blocked_by_task_id }
          : {}),
        work_id: workTip.work_id,
        fact_id: `mes:fact:task:${taskId}:${identity}:TASK_COMPLETE`,
        authority_refs: [...event.binding.authority_refs],
        plan_binding: planBinding,
        git_basis: gitBasis,
      },
      { resultDisposition: 'ACCEPTED', durableResult: resultFact, acceptedResultRef: resultRef },
    );
  } catch (error) {
    materializeFail(
      'invalid-derived-fact',
      `semantic event ${eventKind} TASK_COMPLETE construction failed: ${error instanceof Error ? error.message : String(error)}`,
      eventKind,
    );
  }

  // Build the closed TASK_RESULT_ACK over the durable facts (current +
  // this submission) — Brain never supplies raw durableFacts.
  let ack: unknown;
  try {
    ack = buildTaskResultAck({
      laneActionToken,
      submitted: validated,
      decision: {
        resultDisposition: 'ACCEPTED',
        continuationDisposition,
        acceptedResultRef: resultRef,
        ...(typeof reasonCode === 'string' ? { reasonCode } : {}),
      },
      durableFacts: [...context.current, resultFact, completedTaskFact],
    });
  } catch (error) {
    if (error instanceof TaskResultAckError) {
      materializeFail(
        'binding-mismatch',
        `semantic event ${eventKind} TASK_RESULT_ACK construction failed: ${error.message}`,
        eventKind,
      );
    }
    materializeFail(
      'invalid-derived-fact',
      `semantic event ${eventKind} TASK_RESULT_ACK construction failed: ${error instanceof Error ? error.message : String(error)}`,
      eventKind,
    );
  }

  return {
    facts: [resultFact, completedTaskFact],
    acceptedPlanTaskGraph: graph,
    ack,
  };
};

/**
 * The ONE mechanical catalog entry of the Execute Task-Result-acceptance
 * family.
 */
export const TASK_RESULT_ACCEPT_ENTRY: MesSemanticEventCatalogEntry = {
  event_kind: TASK_RESULT_ACCEPT_EVENT_KIND,
  caller_fields: ['result', 'lane_action_token', 'result_disposition', 'continuation_disposition', 'reason_code'],
  required_caller_fields: ['result', 'lane_action_token', 'result_disposition', 'continuation_disposition'],
  runtime_derived_fields: [
    'fact_id',
    'result_ref',
    'result_payload_digest',
    'work_id',
    'plan_binding',
    'delivery_cycle_id',
    'generation',
    'work_tip',
    'task_fact',
    'ack',
  ],
  durable_outputs: [
    { fact_kind: 'result', mutability: 'immutable' },
    { fact_kind: 'task', mutability: 'immutable' },
  ],
  reused_oracles: [
    'validateWorkerTaskResult',
    'computeResultPayloadDigest',
    'buildTaskResultAck',
    'buildTaskFact',
    'resolvePlanAcceptanceGenerationTips',
    'isCycleBearingPlanAcceptanceGeneration',
    'verifyProjectReadySupportError',
    'resolveWorkLineageTips',
    'workLineageKeyOf',
  ],
  forbidden_caller_fields: [
    'fact_id',
    'result_ref',
    'result_payload_digest',
    'work_id',
    'work_fact',
    'task_fact',
    'plan_binding',
    'delivery_cycle_id',
    'generation',
    'work_tip',
    'ack',
    'durable_facts',
    'facts',
    'supersedes_work_ref',
    'accepted_plan_ref',
    'accepted_plan_digest',
    'graph_digest',
    'thin_plan_ref',
  ],
  failure_codes: ['invalid-field', 'binding-mismatch', 'conflict', 'invalid-derived-fact', 'unreadable'],
  replay_identity: ['stage_id', 'slice_id', 'delivery_cycle_id', 'verification_result_ref', 'task_id', 'result_id'],
  canonicalization: [
    'result_ref / result fact_id / TASK_COMPLETE fact_id = sha256(canonicalStringify(replay_identity)) prefixes (no timestamps, no snapshot digest, no insertion order)',
    'result_payload_digest from the S03-A-T01 oracle over the validated Worker Task Result',
    'accepted binding + Git basis verified against the current accepted generation; Work tip = current lineage tip',
    'TASK_COMPLETE only via the lane builder gate (ACCEPTED + durable Result bound to exact Task)',
    'TASK_RESULT_ACK built by the existing ACK oracle over durable facts (never caller-supplied durableFacts)',
  ],
};