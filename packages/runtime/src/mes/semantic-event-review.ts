/**
 * @proofloop/runtime — mechanical catalog family: Execute Stage Review
 * (R5-A / G6, ADR-026 / E2E-33 / STATIC-41, tech-spec/contracts.md §2.1.3 /
 * §5.1, architecture #/entities/mes-operational-transaction-boundary,
 * review-result-contract).
 *
 * ONE high-level semantic event `execute.stage_review` (E2E-33 case 3)
 * materializes the durable Stage Review outcome on the semantic-event seam:
 *
 *   - PASS: durable Review-owned `result` (stage-only scope) + the accepted
 *     `stage` fact atomically — the accepted stage's `result_ref`
 *     exact-resolves to that Review result and its `verification_result_ref`
 *     exact-resolves to the current accepted generation's durable PLAN_READY
 *     PVR (store-boundary closure, verifyAcceptedStageReviewResultSupport);
 *   - FINDINGS / BLOCKED: durable Review-owned `result` + the required
 *     `finding` fact(s) — Brain arbitration is a SEPARATE later event
 *     (R3-C), never materialized here.
 *
 * Caller-owned (semantic sources that cannot be derived from current durable
 * state): the reviewer verdict + stage identity (`verdict`, `stage_id`), the
 * bounded reviewer basis (`basis_refs`, `summary`), the verifier claim
 * (`claimed_route_code`, required on FINDINGS/BLOCKED) and the integrated
 * snapshot Git basis (`git_basis`) at which the Review ran.
 *
 * Runtime derives (never caller-supplied): the current open cycle, the
 * current accepted generation binding (`accepted_plan_ref` /
 * `verification_result_ref` / `plan_digest` / `delivery_cycle_id`), the
 * Review Work identity, the durable `result`/`finding`/`stage` fact
 * identities and the exact relation closure. No route / next-action /
 * reasoning.
 */
import { createHash } from 'node:crypto';
import { canonicalStringify } from '../cli/proofloop-common';
import {
  isCycleBearingPlanAcceptanceGeneration,
  resolvePlanAcceptanceGenerationTips,
} from './binding';
import { materializeFail } from './materialization-error';
import type {
  MesSemanticEvent,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
} from './semantic-event';
import type { MesFactEnvelope, MesGitBasis, MesPlanBinding } from './types';

/** The one Stage-Review event kind. */
export const STAGE_REVIEW_EVENT_KIND = 'execute.stage_review';

const REVIEW_VERDICTS = ['PASS', 'FINDINGS', 'BLOCKED'] as const;
type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

const CLAIMED_ROUTE_CODES = [
  'IMPLEMENTATION_DEFECT',
  'PLAN_GAP',
  'AUTHORITY_GAP',
  'TECHNICAL_UNKNOWN',
  'RUNTIME_BLOCKER',
  'USER_DECISION_REQUIRED',
  'EVIDENCE_GAP',
] as const;

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

function sourceIdentityDigest(parts: readonly string[]): string {
  return createHash('sha256').update(Buffer.from(canonicalStringify(parts), 'utf8')).digest('hex');
}

function isCycleAnchoredPlanningFact(fact: MesFactEnvelope): boolean {
  if (fact.fact_kind !== 'planning_verification_result' && fact.fact_kind !== 'plan_acceptance') return false;
  return isNonEmptyString(fact.plan_binding?.delivery_cycle_id);
}

function isClosedCycle(context: readonly MesFactEnvelope[], cycle: string, eventKind: string): boolean {
  const terminal = context.find(
    (fact) => fact.fact_kind === 'project_ready' && fact.delivery_cycle_id === cycle,
  );
  if (terminal === undefined) return false;
  if (!Array.isArray(terminal.planned_stage_ids) || terminal.planned_stage_ids.length === 0) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} legal terminal closure is not re-readable — no-write`, eventKind);
  }
  return true;
}

function resolveCurrentOpenCycle(eventKind: string, current: readonly MesFactEnvelope[]): string {
  const openCycles = new Set<string>();
  for (const fact of current) {
    if (!isCycleAnchoredPlanningFact(fact)) continue;
    const cycle = fact.plan_binding?.delivery_cycle_id;
    if (isNonEmptyString(cycle) && !isClosedCycle(current, cycle, eventKind)) openCycles.add(cycle);
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
    `semantic event ${eventKind} has no open delivery cycle — no Review materialization before an accepted Plan generation exists, no-write`,
    eventKind,
  );
}

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
      `semantic event ${eventKind} finds no current accepted Plan generation for stage ${JSON.stringify(stageId)} cycle ${JSON.stringify(cycle)} — no-write`,
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

/** Integrated-snapshot Git basis of the Review (caller-owned mechanical basis). */
function reviewGitBasis(event: MesSemanticEvent, eventKind: string): MesGitBasis {
  const basis = event.binding.git_basis;
  if (basis === undefined || typeof basis !== 'object' || basis === null) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a git_basis (integrated snapshot basis) — no-write`, eventKind);
  }
  const record = basis as unknown as Record<string, unknown>;
  const head = record.head;
  const branch = record.branch;
  const worktree = record.worktree;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) {
    materializeFail('invalid-field', `semantic event ${eventKind} git_basis.head must be a 40-char lowercase Git SHA — no-write`, eventKind);
  }
  if (!isNonEmptyString(branch)) {
    materializeFail('invalid-field', `semantic event ${eventKind} git_basis.branch must be a non-empty string — no-write`, eventKind);
  }
  if (!isNonEmptyString(worktree)) {
    materializeFail('invalid-field', `semantic event ${eventKind} git_basis.worktree must be a root-relative path — no-write`, eventKind);
  }
  return { head, branch, worktree };
}

function reviewPayloadDigest(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

/** Deterministic Review-owned payload of the review result fact. */
function reviewResultEnvelope(
  eventKind: string,
  context: { readonly current: readonly MesFactEnvelope[] },
  event: MesSemanticEvent,
): {
  readonly stageId: string;
  readonly verdict: ReviewVerdict;
  readonly basisRefs: readonly string[];
  readonly claim: string | null;
  readonly identity: string;
  readonly resultRef: string;
  readonly resultFactId: string;
  readonly workId: string;
  readonly gitBasis: MesGitBasis;
  readonly acceptedBinding: MesPlanBinding & { verification_result_ref: string; delivery_cycle_id: string };
} {
  const stageId = payloadString(event, 'stage_id', eventKind);
  const verdict = event.payload.verdict;
  if (typeof verdict !== 'string' || !(REVIEW_VERDICTS as readonly string[]).includes(verdict as ReviewVerdict)) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires verdict PASS | FINDINGS | BLOCKED — no-write`, eventKind);
  }
  const basisRefs = event.payload.basis_refs;
  if (!Array.isArray(basisRefs) || basisRefs.length === 0) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty basis_refs array — no-write`, eventKind);
  }
  for (const ref of basisRefs) {
    if (typeof ref !== 'string' || ref.length === 0) {
      materializeFail('invalid-field', `semantic event ${eventKind} basis_refs entries must be non-empty refs — no-write`, eventKind);
    }
  }
  if (!isNonEmptyString(event.payload.summary)) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty summary — no-write`, eventKind);
  }
  const claim = event.payload.claimed_route_code === undefined ? null : event.payload.claimed_route_code;
  if (verdict !== 'PASS' && (typeof claim !== 'string' || !(CLAIMED_ROUTE_CODES as readonly string[]).includes(claim))) {
    materializeFail('invalid-field', `semantic event ${eventKind} verdict ${JSON.stringify(verdict)} requires a closed claimed_route_code — no-write`, eventKind);
  }
  if (verdict === 'PASS' && claim !== null) {
    materializeFail('invalid-field', `semantic event ${eventKind} PASS verdict must not carry a claimed_route_code — no-write`, eventKind);
  }

  const cycle = resolveCurrentOpenCycle(eventKind, context.current);
  const generation = resolveCurrentAcceptedGeneration(eventKind, context.current, stageId, cycle);
  const acceptedBinding = generation.plan_binding;
  if (acceptedBinding === undefined || acceptedBinding.binding_stage !== 'accepted') {
    materializeFail('binding-mismatch', `semantic event ${eventKind} accepted generation ${JSON.stringify(generation.fact_id)} carries no accepted binding — no-write`, eventKind);
  }
  const verificationRef = acceptedBinding.verification_result_ref;
  if (!isNonEmptyString(verificationRef)) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} accepted generation carries no verification_result_ref — no-write`, eventKind);
  }

  const gitBasis = reviewGitBasis(event, eventKind);
  // The durable identity is the REVIEW OUTCOME identity (stage, cycle,
  // verification, verdict, basis) — the mutable summary is NOT part of the
  // fact identity, so a changed payload under the SAME identity is a typed
  // conflict (same-identity-different-payload no-write), exactly like the
  // other families. The summary still enters the payload digest.
  const identity = sourceIdentityDigest([stageId, cycle, verificationRef, verdict, ...basisRefs]);
  return {
    stageId,
    verdict: verdict as ReviewVerdict,
    basisRefs,
    claim: typeof claim === 'string' ? claim : null,
    identity,
    resultRef: `mes:result:${stageId}:${identity}`,
    resultFactId: `mes:fact:result:${stageId}:${identity}`,
    workId: `mes:work:${stageId}:review:${identity}`,
    gitBasis,
    acceptedBinding: acceptedBinding as unknown as MesPlanBinding & { verification_result_ref: string; delivery_cycle_id: string },
  };
}

/**
 * The ONE mechanical Execute Stage-Review family handler.
 */
export const stageReviewHandler: MesSemanticEventHandler = (event, context) => {
  const eventKind = event.event_kind;
  const r = reviewResultEnvelope(eventKind, context, event);

  const payloadDigest = reviewPayloadDigest({
    stage_id: r.stageId,
    verdict: r.verdict,
    basis_refs: r.basisRefs,
    summary: event.payload.summary,
    claimed_route_code: r.claim,
  });

  // Deterministic replay / conflict gate over the review result identity.
  const existingResult = context.current.find(
    (fact) => fact.fact_kind === 'result' && fact.fact_id === r.resultFactId,
  );
  if (existingResult !== undefined) {
    if (existingResult.result_payload_digest !== payloadDigest) {
      materializeFail(
        'conflict',
        `semantic event ${eventKind} durable review result ${JSON.stringify(r.resultFactId)} already exists with a different payload digest — same Review identity, different payload, no-write`,
        eventKind,
      );
    }
    const reviewResult = existingResult;
    const facts: MesFactEnvelope[] = [reviewResult];
    if (r.verdict === 'PASS') {
      const stageId = `mes:fact:stage:${r.stageId}:${r.identity}`;
      const existingStage = context.current.find((fact) => fact.fact_id === stageId && fact.fact_kind === 'stage');
      if (existingStage !== undefined) facts.push(existingStage);
    } else {
      const findingId = `mes:fact:finding:${r.stageId}:${r.identity}`;
      const existingFinding = context.current.find((fact) => fact.fact_id === findingId && fact.fact_kind === 'finding');
      if (existingFinding !== undefined) facts.push(existingFinding);
    }
    return { facts };
  }

  const planBinding = r.acceptedBinding as unknown as MesPlanBinding;
  const reviewResult: MesFactEnvelope = {
    schema_version: 2,
    fact_id: r.resultFactId,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: [...event.binding.authority_refs],
    scope: { stage_id: r.stageId },
    work_id: r.workId,
    result_ref: r.resultRef,
    plan_binding: planBinding,
    git_basis: r.gitBasis,
    result_id: `review-${r.identity}`,
    result_payload_digest: payloadDigest,
  } as MesFactEnvelope;

  const facts: MesFactEnvelope[] = [reviewResult];

  if (r.verdict === 'PASS') {
    // Accepted stage support: result_ref → this Review result; the accepted
    // binding's verification_result_ref exact-resolves to the durable PVR.
    const stageFact: MesFactEnvelope = {
      schema_version: 2,
      fact_id: `mes:fact:stage:${r.stageId}:${r.identity}`,
      fact_kind: 'stage',
      created_by: 'brain',
      authority_refs: [...event.binding.authority_refs],
      scope: { stage_id: r.stageId },
      result_ref: r.resultRef,
      plan_binding: planBinding,
      git_basis: r.gitBasis,
    } as MesFactEnvelope;
    facts.push(stageFact);
  } else {
    const findingFact: MesFactEnvelope = {
      schema_version: 2,
      fact_id: `mes:fact:finding:${r.stageId}:${r.identity}`,
      fact_kind: 'finding',
      created_by: 'brain',
      authority_refs: [...event.binding.authority_refs],
      scope: { stage_id: r.stageId },
      work_id: r.workId,
      plan_binding: planBinding,
      git_basis: r.gitBasis,
      verifier_verdict: r.verdict,
      claimed_route_code: r.claim as string,
      finding_evidence_refs: [r.resultRef],
    } as MesFactEnvelope;
    facts.push(findingFact);
  }

  return { facts };
};

/**
 * The ONE mechanical catalog entry of the Execute Stage-Review family.
 */
export const STAGE_REVIEW_ENTRY: MesSemanticEventCatalogEntry = {
  event_kind: STAGE_REVIEW_EVENT_KIND,
  caller_fields: ['stage_id', 'verdict', 'basis_refs', 'summary', 'claimed_route_code'],
  required_caller_fields: ['stage_id', 'verdict', 'basis_refs', 'summary'],
  runtime_derived_fields: [
    'fact_id',
    'result_ref',
    'result_id',
    'result_payload_digest',
    'work_id',
    'plan_binding',
    'delivery_cycle_id',
    'verification_result_ref',
    'generation',
    'stage_fact',
    'finding_fact',
  ],
  durable_outputs: [
    { fact_kind: 'result', mutability: 'immutable' },
    { fact_kind: 'stage', mutability: 'immutable' },
    { fact_kind: 'finding', mutability: 'immutable' },
  ],
  reused_oracles: [
    'resolvePlanAcceptanceGenerationTips',
    'isCycleBearingPlanAcceptanceGeneration',
    'verifyAcceptedStageReviewResultSupport',
  ],
  forbidden_caller_fields: [
    'fact_id',
    'result_ref',
    'result_id',
    'result_payload_digest',
    'work_id',
    'plan_binding',
    'delivery_cycle_id',
    'verification_result_ref',
    'generation',
    'stage_fact',
    'finding_fact',
    'facts',
    'route',
    'next_action',
  ],
  failure_codes: ['invalid-field', 'binding-mismatch', 'conflict', 'invalid-derived-fact', 'unreadable'],
  replay_identity: ['stage_id', 'delivery_cycle_id', 'verification_result_ref', 'verdict', 'basis_refs'],
  canonicalization: [
    'result_ref / result fact_id / stage fact_id / finding fact_id = sha256(canonicalStringify(replay_identity)) prefixes (no timestamps, no snapshot digest, no insertion order)',
    'result_payload_digest = S03-A-T01 canonical digest over the validated review semantic payload',
    'result_id = review-<identity> (durable replay key, never caller-supplied)',
    'accepted binding + verification_result_ref from the current accepted generation; work_id = mes:work:<stage>:review:<identity>',
    'PASS materializes Review Result + accepted Stage atomically; FINDINGS/BLOCKED materialize Review Result + Finding(s) (Brain arbitration is a separate later event)',
  ],
};