/**
 * @proofloop/runtime — mechanical catalog family: HUMAN_REQUIRED resolution
 * (R5-C / G6, ADR-026 / E2E-33 / STATIC-41, tech-spec/contracts.md §2.2.4 /
 * §5.1, architecture #/entities/mes-operational-transaction-boundary).
 *
 * Brain-owned Finding-level HUMAN_REQUIRED condition closure. ONE high-level
 * semantic event `human_required.resolve` makes the Runtime:
 *
 *   - resolve the REAL durable source Finding + its qualifying origin
 *     disposition by EXACT fact_id from the current relation (missing /
 *     ambiguous / non-finding / non-qualifying → typed no-write);
 *   - validate the Brain decision through the existing
 *     `resolveHumanRequiredResolutionLegalityError` seam (same-Stage /
 *     same-cycle, origin-binding exactness, one-outcome conflict closure);
 *   - for REPLAN: materialize a FRESH PVR + FRESH PLAN_ACCEPTANCE in the
 *     SAME semantic transaction (reusing the planning family handler) and
 *     attach the `human_required_resolution(REPLAN)` fact whose
 *     `resolution_plan_acceptance_ref` exact-points at that fresh PA — a
 *     pre-existing / unrelated PA can NEVER close the condition (A4 atomic
 *     causal rule, enforced again by the transaction boundary);
 *   - for RESUME: materialize ONLY the resolution record (no Plan target),
 *     binding the EXACT origin generation of the source disposition.
 *
 * No condition is closed by timestamp / newest-wins / cycle change, and no
 * second pause/decision store is created. Caller never supplies fact IDs /
 * plan binding / work identity / digest.
 */
import { createHash } from 'node:crypto';
import { canonicalStringify } from '../cli/proofloop-common';
import { materializeFail } from './materialization-error';
import { resolveHumanRequiredResolutionLegalityError } from './human-required-oracle';
import { planningAcceptanceHandler } from './semantic-event-planning';
import type {
  MesSemanticEvent,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
} from './semantic-event';
import type { MesFactEnvelope, MesGitBasis, MesPlanBinding } from './types';

/** The one HUMAN_REQUIRED-resolution event kind. */
export const HUMAN_REQUIRED_RESOLUTION_EVENT_KIND = 'human_required.resolve';

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

/** The git basis for the durable resolution record. */
function resolutionGitBasis(event: MesSemanticEvent, eventKind: string): MesGitBasis {
  const basis = event.binding.git_basis;
  if (basis === undefined || typeof basis !== 'object' || basis === null) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a git_basis — no-write`, eventKind);
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
  if (!isNonEmptyString(worktree) || worktree.startsWith('/') || worktree.startsWith('./') || worktree.includes('../') || worktree.includes('\\')) {
    materializeFail('invalid-field', `semantic event ${eventKind} git_basis.worktree must be a canonical root-relative path — no-write`, eventKind);
  }
  return { head, branch, worktree };
}

/**
 * The ONE mechanical HUMAN_REQUIRED-resolution family handler.
 */
export const humanRequiredResolutionHandler: MesSemanticEventHandler = (
  event,
  context,
): MesSemanticEventMaterialization => {
  const eventKind = event.event_kind;
  const stageId = payloadString(event, 'stage_id', eventKind);
  const sourceFindingRef = payloadString(event, 'source_finding_ref', eventKind);
  const sourceDispositionRef = payloadString(event, 'source_disposition_ref', eventKind);
  const resolutionKind = event.payload.resolution_kind;
  const basisRefs = event.payload.basis_refs;
  const reason = event.payload.reason;
  if (resolutionKind !== 'REPLAN' && resolutionKind !== 'RESUME') {
    materializeFail('invalid-field', `semantic event ${eventKind} requires resolution_kind REPLAN | RESUME — no-write`, eventKind);
  }
  if (!Array.isArray(basisRefs) || basisRefs.length === 0) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty basis_refs array — no-write`, eventKind);
  }
  for (const ref of basisRefs) {
    if (typeof ref !== 'string' || ref.length === 0) {
      materializeFail('invalid-field', `semantic event ${eventKind} basis_refs entries must be non-empty refs — no-write`, eventKind);
    }
  }
  if (!isNonEmptyString(reason)) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty reason — no-write`, eventKind);
  }

  // Resolve the REAL durable source Finding + qualifying origin disposition
  // by EXACT fact_id from the current relation.
  const findings = context.current.filter((fact) => fact.fact_kind === 'finding' && fact.fact_id === sourceFindingRef);
  if (findings.length !== 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} source_finding_ref ${JSON.stringify(sourceFindingRef)} does not exact-resolve to exactly one durable finding fact — no-write`,
      eventKind,
    );
  }
  const dispositions = context.current.filter(
    (fact) => fact.fact_kind === 'finding_disposition' && fact.fact_id === sourceDispositionRef,
  );
  if (dispositions.length !== 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} source_disposition_ref ${JSON.stringify(sourceDispositionRef)} does not exact-resolve to exactly one durable finding_disposition fact — no-write`,
      eventKind,
    );
  }
  const sourceFinding = findings[0];
  const sourceDisposition = dispositions[0];

  const gitBasis = resolutionGitBasis(event, eventKind);

  // REPLAN: materialize a FRESH PVR + FRESH PLAN_ACCEPTANCE in the SAME
  // transaction (reusing the planning family handler for deterministic
  // identities / promotion / predecessor derivation), then attach the
  // resolution record pointing at that fresh PA.
  let facts: MesFactEnvelope[];
  let resolutionBinding: MesPlanBinding;

  if (resolutionKind === 'REPLAN') {
    const candidatePlanRef = payloadString(event, 'candidate_plan_ref', eventKind);
    const actionToken = payloadString(event, 'action_token', eventKind);
    const planDigest = event.payload.plan_digest;
    if (typeof planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(planDigest)) {
      materializeFail('invalid-field', `semantic event ${eventKind} REPLAN requires a 64-hex plan_digest of the fresh candidate Plan — no-write`, eventKind);
    }
    // The delivery cycle is derived from the source disposition's origin
    // binding — a REPLAN stays in the SAME Stage and SAME cycle as the
    // condition it closes (cross-cycle resolution no-write).
    const sourceBinding = sourceDisposition.plan_binding;
    const cycle =
      sourceBinding !== undefined && sourceBinding.binding_stage === 'accepted'
        ? sourceBinding.delivery_cycle_id
        : undefined;
    if (!isNonEmptyString(cycle)) {
      materializeFail('binding-mismatch', `semantic event ${eventKind} source disposition ${JSON.stringify(sourceDisposition.fact_id)} carries no NORMAL accepted binding / delivery cycle — no-write`, eventKind);
    }
    if (sourceDisposition.scope?.stage_id !== stageId) {
      materializeFail('binding-mismatch', `semantic event ${eventKind} source disposition Stage does not match the requested stage_id — no-write`, eventKind);
    }

    const planningEvent: MesSemanticEvent = {
      event_kind: 'planning.acceptance',
      payload: {
        stage_id: stageId,
        delivery_cycle_id: cycle,
        candidate_plan_ref: candidatePlanRef,
        plan_digest: planDigest,
        action_token: actionToken,
        verdict: 'PLAN_READY',
      },
      binding: event.binding,
    } as unknown as MesSemanticEvent;
    const planning = planningAcceptanceHandler(planningEvent, context);
    const freshPa = planning.facts.find((fact) => fact.fact_kind === 'plan_acceptance');
    const freshPvr = planning.facts.find((fact) => fact.fact_kind === 'planning_verification_result');
    if (freshPa === undefined || freshPvr === undefined) {
      materializeFail('invalid-derived-fact', `semantic event ${eventKind} REPLAN did not produce a fresh PVR + PA — no-write`, eventKind);
    }
    if (freshPa.plan_binding === undefined || freshPa.plan_binding.binding_stage !== 'accepted') {
      materializeFail('invalid-derived-fact', `semantic event ${eventKind} REPLAN fresh PA carries no accepted binding — no-write`, eventKind);
    }
    resolutionBinding = freshPa.plan_binding as MesPlanBinding;

    // Deterministic, replay-stable resolution fact identity. The record's
    // identity binds the source Finding + disposition + the FRESH PA target
    // (so a changed target is a NEW resolution identity, never an in-place
    // edit of a durable closure).
    const identity = sourceIdentityDigest([sourceFindingRef, sourceDispositionRef, 'REPLAN', freshPa.fact_id]);
    const resolution: MesFactEnvelope = {
      schema_version: 2,
      fact_id: `mes:fact:human_required_resolution:${stageId}:${identity}`,
      fact_kind: 'human_required_resolution',
      created_by: 'brain',
      authority_refs: [...event.binding.authority_refs],
      scope: { stage_id: stageId },
      plan_binding: resolutionBinding,
      git_basis: gitBasis,
      source_finding_ref: sourceFindingRef,
      source_disposition_ref: sourceDispositionRef,
      resolution_kind: 'REPLAN',
      resolution_plan_acceptance_ref: freshPa.fact_id,
      basis_refs: basisRefs,
      reason,
    } as MesFactEnvelope;

    facts = [...planning.facts, resolution];
  } else {
    // RESUME: the resolution record itself is the closure evidence — bind
    // the EXACT origin generation of the source disposition (no new Plan
    // target, no rebind to a successor generation).
    const originBinding = sourceDisposition.plan_binding;
    if (originBinding === undefined || originBinding.binding_stage !== 'accepted') {
      materializeFail('binding-mismatch', `semantic event ${eventKind} source disposition ${JSON.stringify(sourceDisposition.fact_id)} carries no NORMAL accepted binding — RESUME requires the origin generation, no-write`, eventKind);
    }
    if (sourceDisposition.scope?.stage_id !== stageId) {
      materializeFail('binding-mismatch', `semantic event ${eventKind} source disposition Stage does not match the requested stage_id — no-write`, eventKind);
    }
    resolutionBinding = originBinding as MesPlanBinding;

    const identity = sourceIdentityDigest([sourceFindingRef, sourceDispositionRef, 'RESUME']);
    const resolution: MesFactEnvelope = {
      schema_version: 2,
      fact_id: `mes:fact:human_required_resolution:${stageId}:${identity}`,
      fact_kind: 'human_required_resolution',
      created_by: 'brain',
      authority_refs: [...event.binding.authority_refs],
      scope: { stage_id: stageId },
      plan_binding: resolutionBinding,
      git_basis: gitBasis,
      source_finding_ref: sourceFindingRef,
      source_disposition_ref: sourceDispositionRef,
      resolution_kind: 'RESUME',
      basis_refs: basisRefs,
      reason,
    } as MesFactEnvelope;

    facts = [resolution];
  }

  // Pre-validate the assembled resolution with the SAME legality oracle the
  // write boundary uses (source refs, qualifying origin, same-Stage / same-
  // cycle, origin-binding exactness, one-outcome conflict closure) over
  // current ∪ submitted — a typed no-write here, and the transaction / store
  // re-checks atomically.
  const resolutionFact = facts[facts.length - 1];
  const legalityError = resolveHumanRequiredResolutionLegalityError(resolutionFact, [...context.current, ...facts]);
  if (legalityError !== undefined) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} HUMAN_REQUIRED resolution legality failed: ${legalityError} — no-write`, eventKind);
  }

  return { facts };
};

/**
 * The ONE mechanical catalog entry of the HUMAN_REQUIRED-resolution family.
 */
export const HUMAN_REQUIRED_RESOLUTION_ENTRY: MesSemanticEventCatalogEntry = {
  event_kind: HUMAN_REQUIRED_RESOLUTION_EVENT_KIND,
  caller_fields: [
    'stage_id',
    'source_finding_ref',
    'source_disposition_ref',
    'resolution_kind',
    'basis_refs',
    'reason',
    'candidate_plan_ref',
    'plan_digest',
    'action_token',
  ],
  required_caller_fields: ['stage_id', 'source_finding_ref', 'source_disposition_ref', 'resolution_kind', 'basis_refs', 'reason'],
  runtime_derived_fields: [
    'fact_id',
    'resolution_plan_acceptance_ref',
    'delivery_cycle_id',
    'source_finding',
    'source_disposition',
    'plan_binding',
    'git_basis',
    'fresh_pvr',
    'fresh_pa',
    'legality_closure',
  ],
  durable_outputs: [
    { fact_kind: 'human_required_resolution', mutability: 'immutable' },
    { fact_kind: 'planning_verification_result', mutability: 'immutable' },
    { fact_kind: 'plan_acceptance', mutability: 'immutable' },
  ],
  reused_oracles: ['resolveHumanRequiredResolutionLegalityError', 'planningAcceptanceHandler'],
  forbidden_caller_fields: [
    'fact_id',
    'resolution_plan_acceptance_ref',
    'delivery_cycle_id',
    'source_finding',
    'source_disposition',
    'plan_binding',
    'git_basis',
    'fresh_pvr',
    'fresh_pa',
    'legality_closure',
    'facts',
    'route',
    'next_action',
  ],
  failure_codes: ['invalid-field', 'binding-mismatch', 'conflict', 'invalid-derived-fact', 'unreadable'],
  replay_identity: ['source_finding_ref', 'source_disposition_ref', 'resolution_kind', 'resolution_plan_acceptance_ref'],
  canonicalization: [
    'resolution fact_id = mes:fact:human_required_resolution:<stage>:sha256(canonicalStringify(replay_identity)) (no timestamps, no snapshot digest, no insertion order)',
    'REPLAN: fresh PVR + fresh PA materialized in the SAME transaction (reusing the planning family); resolution_plan_acceptance_ref exact-points at the fresh PA',
    'RESUME: no Plan target; binds the EXACT origin generation of the source disposition',
    'same-Stage / same-cycle / one-outcome conflict closure via resolveHumanRequiredResolutionLegalityError (pre-checked and store re-checked)',
  ],
};