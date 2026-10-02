/**
 * @proofloop/runtime — mechanical catalog family: Planning acceptance.
 *
 * ONE high-level semantic event (`planning.acceptance`) replaces the Brain-side
 * hand-assembly of the accepted `planning_verification_result` + `plan_acceptance`
 * pair (ADR-026 / E2E-33 / STATIC-41; contracts.md §2.1.3 / §2.2.2 /
 * architecture #/entities/planning-acceptance-succession).
 *
 * Caller-owned (semantic sources that cannot be derived from current durable
 * state — contracts §2.1.3):
 *   - the brain-authorized transition subject (`stage_id`);
 *   - the candidate Thin Plan ref + digest established by Planning Flow;
 *   - the accepted SPV structured outcome (`verdict`, `action_token`);
 *   - the delivery cycle identity when it is a NEW cycle (the cycle id is a new
 *     semantic source identity minted at Propose completion — contracts §2.1.3).
 *
 * Runtime-derived (never caller-supplied):
 *   - the current open delivery cycle (ambiguous / closed cycle fail closed);
 *   - the current accepted generation tip of the same (stage, cycle) cohort;
 *   - the PVR durable identity + `work_id` + `result_ref`;
 *   - the PVR candidate binding and the PA accepted binding (via the existing
 *     `promotePlanReadyToAccepted` promotion oracle);
 *   - `supersedes_plan_acceptance_ref`, the PA durable identity;
 *   - support/succession closure (reused oracles; the transaction layer owns the
 *     atomic resulting-set validation).
 *
 * The handler never selects route, repair, Replan, next Task, next Stage or the
 * next action, never persists anything itself, and never accepts a fact delta
 * from the caller.
 */
import { createHash } from 'node:crypto';
import { canonicalStringify } from '../cli/proofloop-common';
import {
  promotePlanReadyToAccepted,
  resolvePlanAcceptanceGenerationTips,
} from './binding';
import { materializeFail } from './materialization-error';
import { verifyProjectReadySupportError } from './terminal';
import type {
  MesSemanticEvent,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
  MesSemanticEventMaterializationContext,
} from './semantic-event';
import type { MesFactEnvelope, MesGitBasis, MesPlanBinding } from './types';

/** The one Planning acceptance event kind. */
export const PLANNING_ACCEPTANCE_EVENT_KIND = 'planning.acceptance';

/** Canonical Plan location for one Stage (`delivery/stages/<stage>/...`). */
function candidatePlanRefBelongsToStage(candidatePlanRef: string, stageId: string): boolean {
  return candidatePlanRef.startsWith(`delivery/stages/${stageId}/`);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Deterministic opaque identity of one semantic acceptance source. */
function sourceIdentityDigest(parts: readonly string[]): string {
  return createHash('sha256').update(Buffer.from(canonicalStringify(parts), 'utf8')).digest('hex');
}

function payloadString(event: MesSemanticEvent, field: string, eventKind: string): string {
  const value = event.payload[field];
  if (!isNonEmptyString(value)) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty string ${field}`, eventKind);
  }
  return value;
}


/**
 * A cycle anchor for current-cycle resolution: ANY cycle-bearing PVR/PA
 * planning fact — the SAME set the store's `planningBindingCycles` derives,
 * so the materializer's pre-check can never disagree with the write boundary.
 */
function isCycleAnchoredPlanningFact(fact: MesFactEnvelope): boolean {
  if (fact.fact_kind !== 'planning_verification_result' && fact.fact_kind !== 'plan_acceptance') return false;
  return isNonEmptyString(fact.plan_binding?.delivery_cycle_id);
}
function isClosedCycle(context: MesSemanticEventMaterializationContext, cycle: string): boolean {
  return context.current.some(
    (fact) =>
      fact.fact_kind === 'project_ready' &&
      fact.delivery_cycle_id === cycle &&
      verifyProjectReadySupportError(fact, context.current) === undefined,
  );
}

/**
 * Resolve the current open delivery cycle and validate the caller's cycle
 * identity against it (reusing the store's own open/closed semantics: a cycle
 * is closed only by a LEGAL matching cycle-bearing PROJECT_READY terminal).
 */
function resolveCurrentCycle(
  context: MesSemanticEventMaterializationContext,
  eventKind: string,
  callerCycle: string,
): void {
  const planningCycles = new Set<string>();
  for (const fact of context.current) {
    if (!isCycleAnchoredPlanningFact(fact)) continue;
    const cycle = fact.plan_binding?.delivery_cycle_id;
    if (isNonEmptyString(cycle) && !isClosedCycle(context, cycle)) planningCycles.add(cycle);
  }
  if (planningCycles.size > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} cannot resolve a unique current open delivery cycle（multiple open cycles: ${[...planningCycles].sort().join(', ')}）— no-write`,
      eventKind,
    );
  }
  if (planningCycles.size === 1) {
    const current = [...planningCycles][0];
    if (current !== callerCycle) {
      materializeFail(
        'binding-mismatch',
        `semantic event ${eventKind} delivery_cycle_id ${JSON.stringify(callerCycle)} does not equal the current open delivery cycle ${JSON.stringify(current)} — no-write`,
        eventKind,
      );
    }
    return;
  }
  if (isClosedCycle(context, callerCycle)) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} delivery_cycle_id ${JSON.stringify(callerCycle)} is already CLOSED by a legal matching terminal — closed-cycle planning facts are history-only and never accept a new generation — no-write`,
      eventKind,
    );
  }
}

/**
 * Resolve the current accepted generation tip of the (stage, cycle) cohort, or
 * `null` for a fresh chain root. Ambiguous / branched / malformed successions
 * fail closed instead of guessing a predecessor.
 */
function resolvePredecessor(
  context: MesSemanticEventMaterializationContext,
  eventKind: string,
  stageId: string,
  cycle: string,
): string | null {
  const resolved = resolvePlanAcceptanceGenerationTips(context.current);
  if (!resolved.ok) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} cannot resolve the current generation tip: ${resolved.error}`, eventKind);
  }
  const cohortTips = resolved.tips.filter(
    (fact) =>
      fact.scope?.stage_id === stageId &&
      fact.plan_binding?.binding_stage === 'accepted' &&
      fact.plan_binding.delivery_cycle_id === cycle,
  );
  if (cohortTips.length > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} found ${cohortTips.length} current generation tips for stage ${JSON.stringify(stageId)} cycle ${JSON.stringify(cycle)} — no-write`,
      eventKind,
    );
  }
  return cohortTips.length === 1 ? cohortTips[0].fact_id : null;
}

/** The ONE mechanical Planning acceptance family handler. */
export const planningAcceptanceHandler: MesSemanticEventHandler = (
  event,
  context,
): MesSemanticEventMaterialization => {
  const eventKind = event.event_kind;
  const stageId = payloadString(event, 'stage_id', eventKind);
  const cycle = payloadString(event, 'delivery_cycle_id', eventKind);
  const candidatePlanRef = payloadString(event, 'candidate_plan_ref', eventKind);
  const actionToken = payloadString(event, 'action_token', eventKind);
  const planDigest = event.payload.plan_digest;
  const verdict = payloadString(event, 'verdict', eventKind);

  if (!candidatePlanRefBelongsToStage(candidatePlanRef, stageId)) {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} candidate_plan_ref ${JSON.stringify(candidatePlanRef)} does not belong to stage ${JSON.stringify(stageId)} — candidate revision/stage mismatch, no-write`,
      eventKind,
    );
  }
  if (!isSha256Hex(planDigest)) {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} requires plan_digest to be a 64-character lowercase SHA-256 digest of the candidate Plan`,
      eventKind,
    );
  }
  if (verdict !== 'PLAN_READY') {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} verdict must be PLAN_READY to accept a Plan, got ${JSON.stringify(verdict)} — FINDINGS/BLOCKED never produce an acceptance`,
      eventKind,
    );
  }

  resolveCurrentCycle(context, eventKind, cycle);

  // Deterministic, replay-stable durable identities derived from the semantic
  // source identity alone (never from insertion order / timestamps / the
  // snapshot digest).
  const identity = sourceIdentityDigest([stageId, cycle, candidatePlanRef, planDigest, actionToken, verdict]);
  const resultRef = `mes:result:planning:${identity}`;
  const workId = `mes:work:planning:${identity}`;
  const paId = `mes:fact:plan_acceptance:${identity}`;
  const gitBasis = event.binding.git_basis;

  // Replay stability: a replayed semantic event must reproduce its already
  // durable generation byte-for-byte, so an existing generation keeps its
  // stored predecessor; only a genuinely new generation resolves the current
  // tip (still never caller-supplied).
  const existingGeneration = context.current.find((fact) => fact.fact_id === paId);
  const predecessor =
    existingGeneration !== undefined
      ? (existingGeneration.supersedes_plan_acceptance_ref ?? null)
      : resolvePredecessor(context, eventKind, stageId, cycle);

  const pvrId = `mes:fact:planning_verification_result:${identity}`;
  const candidateBinding: MesPlanBinding = {
    binding_stage: 'candidate',
    candidate_plan_ref: candidatePlanRef,
    accepted_plan_ref: null,
    verdict: 'PLAN_READY',
    plan_digest: planDigest,
    delivery_cycle_id: cycle,
  };
  const verification: MesFactEnvelope = {
    schema_version: 2,
    fact_id: pvrId,
    fact_kind: 'planning_verification_result',
    created_by: 'brain',
    authority_refs: [...event.binding.authority_refs],
    scope: { stage_id: stageId },
    work_id: workId,
    result_ref: resultRef,
    verifier_role: 'stage-plan-verifier',
    action_token: actionToken,
    plan_binding: candidateBinding,
    ...(gitBasis !== undefined ? { git_basis: gitBasis } : {}),
  } as MesFactEnvelope;

  const acceptedBinding = promotePlanReadyToAccepted({
    candidate: candidateBinding,
    verification_result_ref: resultRef,
  });
  const acceptance: MesFactEnvelope = {
    schema_version: 2,
    fact_id: paId,
    fact_kind: 'plan_acceptance',
    created_by: 'brain',
    authority_refs: [...event.binding.authority_refs],
    scope: { stage_id: stageId },
    supersedes_plan_acceptance_ref: predecessor,
    plan_binding: acceptedBinding,
    ...(gitBasis !== undefined ? { git_basis: gitBasis } : {}),
  } as MesFactEnvelope;

  return { facts: [verification, acceptance] };
};

/**
 * The ONE mechanical catalog entry of the Planning acceptance family. Every
 * field is machine data consumed by the materializer and the table-driven
 * tests — never a second Authority document.
 */
export const PLANNING_ACCEPTANCE_ENTRY: MesSemanticEventCatalogEntry = {
  event_kind: PLANNING_ACCEPTANCE_EVENT_KIND,
  caller_fields: ['stage_id', 'delivery_cycle_id', 'candidate_plan_ref', 'plan_digest', 'action_token', 'verdict'],
  required_caller_fields: ['stage_id', 'delivery_cycle_id', 'candidate_plan_ref', 'plan_digest', 'action_token', 'verdict'],
  runtime_derived_fields: [
    'fact_id',
    'work_id',
    'result_ref',
    'supersedes_plan_acceptance_ref',
    'plan_binding',
    'verifier_role',
  ],
  durable_outputs: [
    { fact_kind: 'planning_verification_result', mutability: 'immutable' },
    { fact_kind: 'plan_acceptance', mutability: 'immutable' },
  ],
  reused_oracles: [
    'promotePlanReadyToAccepted',
    'resolvePlanAcceptanceGenerationTips',
    'isCycleBearingPlanAcceptanceGeneration',
    'verifyProjectReadySupportError',
  ],
  forbidden_caller_fields: [
    'work_id',
    'result_ref',
    'verifier_role',
    'supersedes_plan_acceptance_ref',
    'plan_binding',
    'accepted_plan_ref',
    'binding_stage',
  ],
  failure_codes: ['invalid-field', 'binding-mismatch', 'conflict', 'invalid-derived-fact'],
  replay_identity: ['stage_id', 'delivery_cycle_id', 'candidate_plan_ref', 'plan_digest', 'action_token', 'verdict'],
  canonicalization: [
    'fact_id / work_id / result_ref = sha256(canonicalStringify(replay_identity)) prefixes (no timestamps, no snapshot digest, no insertion order)',
    'candidate binding is exactly the caller-owned candidate identity; accepted binding comes from promotePlanReadyToAccepted',
  ],
};
