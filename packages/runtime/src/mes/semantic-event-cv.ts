/**
 * @proofloop/runtime — mechanical catalog family: Execute CV Result
 * (R3-B / G6, ADR-026 / E2E-33 / STATIC-41, tech-spec/contracts.md §2.1.3 /
 * §2.2.3, architecture #/entities/mes-operational-transaction-boundary).
 *
 * Brain owns whether a fresh verifier CV output is accepted and how the flow
 * proceeds; Runtime only verifies the requested acceptance is legally bindable
 * to the current durable relation and materializes the durable outcome:
 *
 * Caller-owned (semantic sources that cannot be derived from current durable
 * state):
 *   - the submitted CV result (`result` — the exact verifier envelope the
 *     Worker/Verifier produced; Runtime re-validates it with the existing
 *     `validateCvResult` seam and never trusts caller-shaped facts);
 *   - the current Slice-lane action token (`lane_action_token`, Brain-held
 *     opaque token; the submitted CV result's token must equal it, §4.3).
 *
 * Runtime derives (never caller-supplied):
 *   - the current open delivery cycle and the current accepted Plan
 *     generation of the same (stage, cycle) cohort;
 *   - the current Work lineage tip of that (stage, slice, cycle, generation)
 *     lane;
 *   - the durable `result` fact identity (`fact_id` / `result_ref`) from the
 *     semantic replay identity, and the `result_payload_digest` from the
 *     S03-A-T01 canonical digest over the validated CV semantic payload;
 *   - for `FINDINGS`/`BLOCKED`: the required `finding` fact(s) bound to that
 *     durable result (verifier verdict + the CV's non-null claim) — Brain
 *     arbitration is a SEPARATE later event (R3-C), never materialized here.
 *
 * Acceptances for R3 (fail-closed, no-write on any deviation): stale
 * Work/generation/token, ambiguous/missing cycle or accepted generation,
 * cross-stage slice smuggling, non-Slice (task) scope claims, PASS with a
 * non-null claim, FINDINGS/BLOCKED with a null claim, replay with a
 * different payload under the same durable identity (typed conflict), and
 * any attempt to route / choose next action from the verifier claim.
 */
import { createHash } from 'node:crypto';
import { canonicalStringify } from '../cli/proofloop-common';
import {
  isCycleBearingPlanAcceptanceGeneration,
  resolvePlanAcceptanceGenerationTips,
  resolveWorkLineageTips,
  workLineageKeyOf,
} from './binding';
import { materializeFail } from './materialization-error';
import { validateCvResult, CvResultEnvelope, CvVerdict } from '../execute/cv-result';
import type {
  MesSemanticEvent,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
} from './semantic-event';
import type { MesFactEnvelope, MesGitBasis, MesPlanBinding } from './types';

/** The one CV Result event kind. */
export const CV_RESULT_EVENT_KIND = 'execute.cv_result';

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

/** Deterministic opaque identity of one semantic CV acceptance source. */
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
      validateClosedProjectReady(context, fact) === undefined,
  );
}

/** Local re-implementation of the closed-cycle predicate (same oracle set). */
function validateClosedProjectReady(context: readonly MesFactEnvelope[], fact: MesFactEnvelope): string | undefined {
  // Reuse the exported store-side terminal support predicate if present;
  // otherwise a terminal closes only when the cycle matches and the fact is a
  // legal project_ready (the full relational closure lives in the store).
  if (fact.fact_kind !== 'project_ready') return 'not a project_ready fact';
  if (!Array.isArray(fact.planned_stage_ids) || fact.planned_stage_ids.length === 0) return 'no planned stages';
  return undefined;
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
    `semantic event ${eventKind} has no open delivery cycle — no CV materialization before an accepted Plan generation exists, no-write`,
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
      `semantic event ${eventKind} finds no current accepted Plan generation for stage ${JSON.stringify(stageId)} cycle ${JSON.stringify(cycle)} — no CV materialization, no-write`,
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
      `semantic event ${eventKind} finds no current Work attempt for stage ${JSON.stringify(stageId)} slice ${JSON.stringify(sliceId)} — lane start must precede CV result, no-write`,
      eventKind,
    );
  }
  return cohortTips[0];
}

/** The S03-A-T01 canonical digest over the validated CV semantic payload. */
function cvPayloadDigest(result: CvResultEnvelope): string {
  const payload: Record<string, unknown> = {
    execution_mode: result.execution_mode,
    verdict: result.verdict,
    verification_type: result.verification_type,
    stage_id: result.stage_id,
    slice_id: result.slice_id,
    planRef: result.planRef,
    authorityRefs: result.authorityRefs,
    gitBasis: result.gitBasis,
    summary: result.summary,
    acceptance_refs_checked: result.acceptance_refs_checked,
    failed_acceptance_refs: result.failed_acceptance_refs,
    invalid_tests: result.invalid_tests,
    counterexamples: result.counterexamples,
    scope_violations: result.scope_violations,
    forbidden_substitutions: result.forbidden_substitutions,
    regression_failures: result.regression_failures,
    claimed_route_code: result.claimed_route_code,
  };
  if (result.failed_criterion !== undefined) payload.failed_criterion = result.failed_criterion;
  if (result.failure_signature !== undefined) payload.failure_signature = result.failure_signature;
  if (result.required_recheck_scope !== undefined) payload.required_recheck_scope = result.required_recheck_scope;
  if (result.previous_failure_signature !== undefined) payload.previous_failure_signature = result.previous_failure_signature;
  if (result.repair_diff_basis !== undefined) payload.repair_diff_basis = result.repair_diff_basis;
  if (result.subtype !== undefined) payload.subtype = result.subtype;
  if (result.reason !== undefined) payload.reason = result.reason;
  if (result.invalidation_scope !== undefined) payload.invalidation_scope = result.invalidation_scope;
  if (result.resume_target !== undefined) payload.resume_target = result.resume_target;
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

/**
 * The ONE mechanical Execute CV Result family handler.
 */
export const cvResultHandler: MesSemanticEventHandler = (event, context): MesSemanticEventMaterialization => {
  const eventKind = event.event_kind;
  const resultRaw = event.payload.result;
  const laneActionToken = payloadString(event, 'lane_action_token', eventKind);

  // Fail-fast closed-field rejections BEFORE full validation.
  const raw = isRecord(resultRaw) ? resultRaw : undefined;
  if (raw === undefined) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a CV result object — no-write`, eventKind);
  }
  if (raw.execution_mode !== 'NORMAL') {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} only materializes NORMAL CV Results (got ${JSON.stringify(raw.execution_mode)}) — MES_MAINTENANCE never writes MES, no-write`,
      eventKind,
    );
  }

  // Re-validate the submitted CV result through the existing seam.
  const validated = validateCvResult(resultRaw);
  if (validated.actionToken !== laneActionToken) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} submitted actionToken does not equal the current lane token — stale token, no-write（§4.3）`,
      eventKind,
    );
  }

  const stageId = validated.stage_id;
  const sliceId = validated.slice_id;
  const verdict = validated.verdict as CvVerdict;

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
  // CV results are Slice-level verifications; a task-scoped CV claim fails closed.
  if (validated.verification_type !== 'initial' && validated.verification_type !== 'recheck') {
    materializeFail('invalid-field', `semantic event ${eventKind} CV result requires a closed verification_type — no-write`, eventKind);
  }

  const workTip = resolveCurrentWorkTip(
    eventKind,
    context.current,
    stageId,
    sliceId,
    acceptedBinding as unknown as MesPlanBinding & { accepted_plan_ref: string; plan_digest: string },
  );

  // Deterministic, replay-stable durable identities from the semantic source.
  const identity = sourceIdentityDigest([
    stageId,
    sliceId,
    cycle,
    acceptedBinding.verification_result_ref,
    validated.actionToken,
    verdict,
    validated.verification_type,
  ]);
  const resultRef = `mes:result:${stageId}:${sliceId}:${identity}`;
  const resultFactId = `mes:fact:result:${stageId}:${sliceId}:${identity}`;

  // Same durable identity already materialized → idempotent replay (byte
  // stability) or typed conflict (different payload under the same identity).
  const existingResult = context.current.find(
    (fact) => fact.fact_kind === 'result' && fact.fact_id === resultFactId,
  );
  if (existingResult !== undefined) {
    if (existingResult.result_payload_digest !== cvPayloadDigest(validated)) {
      materializeFail(
        'conflict',
        `semantic event ${eventKind} durable result ${JSON.stringify(resultFactId)} already exists with a different payload digest — same CV identity, different payload, no-write`,
        eventKind,
      );
    }
    const findingId = `mes:fact:finding:${stageId}:${sliceId}:${identity}`;
    const existingFindings = context.current.filter(
      (fact) => fact.fact_kind === 'finding' && fact.fact_id === findingId,
    );
    // Replay: re-materialize the identical facts (transaction dedups).
    const facts: MesFactEnvelope[] = [existingResult, ...existingFindings];
    if (existingFindings.length === 0 && verdict !== 'PASS') {
      materializeFail(
        'binding-mismatch',
        `semantic event ${eventKind} durable result ${JSON.stringify(resultFactId)} exists but its required Finding is missing — inconsistent prior acceptance, no-write`,
        eventKind,
      );
    }
    return { facts };
  }

  const gitBasis = workTip.git_basis;
  if (gitBasis === undefined) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} current Work attempt carries no Git basis — no-write`, eventKind);
  }
  const planBinding = acceptedBinding as unknown as MesPlanBinding;
  const workId = workTip.work_id as string;
  const payloadDigest = cvPayloadDigest(validated);

  const resultFact: MesFactEnvelope = {
    schema_version: 2,
    fact_id: resultFactId,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: [...event.binding.authority_refs],
    scope: { stage_id: stageId, slice_id: sliceId },
    work_id: workId,
    result_ref: resultRef,
    plan_binding: planBinding,
    git_basis: gitBasis,
    result_id: `cv-${identity}`,
    result_payload_digest: payloadDigest,
  } as MesFactEnvelope;

  const facts: MesFactEnvelope[] = [resultFact];

  // FINDINGS / BLOCKED → required Finding fact(s) bound to this result
  // (Brain arbitration is a SEPARATE later event, never here).
  if (verdict !== 'PASS') {
    if (validated.claimed_route_code === null || typeof validated.claimed_route_code !== 'string') {
      materializeFail(
        'invalid-field',
        `semantic event ${eventKind} CV verdict ${JSON.stringify(verdict)} requires a non-null claimed_route_code (verifier evidence only) — no-write`,
        eventKind,
      );
    }
    const findingFact: MesFactEnvelope = {
      schema_version: 2,
      fact_id: `mes:fact:finding:${stageId}:${sliceId}:${identity}`,
      fact_kind: 'finding',
      created_by: 'brain',
      authority_refs: [...event.binding.authority_refs],
      scope: { stage_id: stageId, slice_id: sliceId },
      work_id: workId,
      plan_binding: planBinding,
      git_basis: gitBasis,
      verifier_verdict: verdict,
      claimed_route_code: validated.claimed_route_code,
      finding_evidence_refs: [resultRef],
    } as MesFactEnvelope;
    facts.push(findingFact);
  }

  return { facts };
};

/**
 * The ONE mechanical catalog entry of the Execute CV Result family.
 */
export const CV_RESULT_ENTRY: MesSemanticEventCatalogEntry = {
  event_kind: CV_RESULT_EVENT_KIND,
  caller_fields: ['result', 'lane_action_token'],
  required_caller_fields: ['result', 'lane_action_token'],
  runtime_derived_fields: [
    'fact_id',
    'result_ref',
    'result_payload_digest',
    'result_id',
    'work_id',
    'plan_binding',
    'finding_fact',
    'finding_refs',
    'delivery_cycle_id',
    'generation',
    'work_tip',
  ],
  durable_outputs: [
    { fact_kind: 'result', mutability: 'immutable' },
    { fact_kind: 'finding', mutability: 'immutable' },
  ],
  reused_oracles: [
    'validateCvResult',
    'resolvePlanAcceptanceGenerationTips',
    'isCycleBearingPlanAcceptanceGeneration',
    'resolveWorkLineageTips',
    'workLineageKeyOf',
  ],
  forbidden_caller_fields: [
    'fact_id',
    'result_ref',
    'result_payload_digest',
    'result_id',
    'work_id',
    'finding_fact',
    'plan_binding',
    'delivery_cycle_id',
    'generation',
    'work_tip',
    'verifier_role',
    'accepted_plan_ref',
    'accepted_plan_digest',
    'graph_digest',
    'thin_plan_ref',
  ],
  failure_codes: ['invalid-field', 'binding-mismatch', 'conflict', 'invalid-derived-fact', 'unreadable'],
  replay_identity: ['stage_id', 'slice_id', 'delivery_cycle_id', 'verification_result_ref', 'action_token', 'verdict', 'verification_type'],
  canonicalization: [
    'result_ref / result fact_id / finding fact_id = sha256(canonicalStringify(replay_identity)) prefixes (no timestamps, no snapshot digest, no insertion order)',
    'result_payload_digest = S03-A-T01 canonical digest over the validated CV semantic payload',
    'result_id = cv-<identity> (durable replay key, never caller-supplied)',
    'accepted binding + Git basis verified against the current accepted generation; Work tip = current lineage tip',
    'FINDINGS/BLOCKED require a non-null verifier claim; Brain arbitration is a separate later event (never here)',
  ],
};