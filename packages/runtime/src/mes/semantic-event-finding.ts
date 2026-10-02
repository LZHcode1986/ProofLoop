/**
 * @proofloop/runtime — mechanical catalog family: Finding disposition
 * (R3-C / G6, ADR-026 / E2E-33 / STATIC-41, tech-spec/contracts.md §2.2.3,
 * architecture #/entities/mes-operational-transaction-boundary).
 *
 * Brain-owned arbitration of a verifier finding. ONE high-level semantic
 * event `finding.disposition` makes the Runtime:
 *
 *   - resolve the real durable source `finding` fact from the caller's
 *     `finding_ref` (exact fact_id match against the current relation — a
 *     missing / non-finding / PASS-finding / candidate-bound target is a
 *     typed no-write);
 *   - validate the Brain decision through the existing
 *     `validateFindingDisposition` seam (closed disposition set, route-code
 *     fork, VERIFIER_OVERREACH closure, closed resume_target, bounded
 *     basis/reason);
 *   - derive the durable `disposition_ref` deterministically from the
 *     semantic source (never caller-supplied) and assemble the durable
 *     `finding_disposition` fact via the existing `buildFindingDisposition`
 *     builder, which binds the finding's claim verbatim (evidence, never
 *     editable) and re-checks the accepted Plan binding of the finding.
 *
 * Runtime NEVER selects a route from `accepted_route_code`; it only records
 * Brain's arbitration.
 *
 * Caller-owned (semantic sources that cannot be derived from current durable
 * state — contracts §2.2.3 YAML):
 *   - the source finding identity (`finding_ref`);
 *   - Brain's arbitration (`finding_disposition`, `accepted_route_code`),
 *     the bounded `basis_refs` / `reason` and the closed `resume_target`.
 *
 * Runtime-derived (never caller-supplied): the source finding relation,
 * `disposition_ref` / `fact_id`, the verifier claim carried verbatim, the
 * accepted binding / scope / Git basis inherited from the finding.
 */
import { createHash } from 'node:crypto';
import { canonicalStringify } from '../cli/proofloop-common';
import { materializeFail } from './materialization-error';
import {
  buildFindingDisposition,
  validateFindingDisposition,
} from '../execute/finding-disposition';
import type {
  MesSemanticEvent,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
} from './semantic-event';
import type { MesFactEnvelope } from './types';

/** The one Finding-disposition event kind. */
export const FINDING_DISPOSITION_EVENT_KIND = 'finding.disposition';

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

/** Deterministic opaque identity of one semantic disposition source. */
function sourceIdentityDigest(parts: readonly string[]): string {
  return createHash('sha256').update(Buffer.from(canonicalStringify(parts), 'utf8')).digest('hex');
}

/**
 * The ONE mechanical Finding-disposition family handler.
 */
export const findingDispositionHandler: MesSemanticEventHandler = (
  event,
  context,
): MesSemanticEventMaterialization => {
  const eventKind = event.event_kind;
  const findingRef = payloadString(event, 'finding_ref', eventKind);
  const findingDisposition = event.payload.finding_disposition;
  const acceptedRouteCode = event.payload.accepted_route_code ?? null;
  const basisRefs = event.payload.basis_refs ?? [];
  const reason = event.payload.reason;
  const resumeTarget = event.payload.resume_target;

  if (typeof reason !== 'string' || reason.length === 0) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty reason — no-write`, eventKind);
  }
  if (!Array.isArray(basisRefs)) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires basis_refs to be an array of refs — no-write`, eventKind);
  }
  for (const ref of basisRefs) {
    if (typeof ref !== 'string' || ref.length === 0) {
      materializeFail('invalid-field', `semantic event ${eventKind} basis_refs entries must be non-empty refs — no-write`, eventKind);
    }
  }

  // Resolve the REAL durable source finding (exact fact_id, current relation).
  const findings = context.current.filter((fact) => fact.fact_kind === 'finding' && fact.fact_id === findingRef);
  if (findings.length === 0) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finding_ref ${JSON.stringify(findingRef)} does not exact-resolve to a durable finding fact in the current relation — no-write`,
      eventKind,
    );
  }
  if (findings.length > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finding_ref ${JSON.stringify(findingRef)} is ambiguous (${findings.length} durable findings) — no-write`,
      eventKind,
    );
  }
  const sourceFinding = findings[0];

  // Deterministic, replay-stable durable disposition identity.
  const identity = sourceIdentityDigest([
    findingRef,
    String(findingDisposition),
    acceptedRouteCode === null ? 'null' : String(acceptedRouteCode),
    String(resumeTarget),
    String(reason),
    canonicalStringify(basisRefs),
  ]);
  const dispositionRef = `mes:disposition:${sourceFinding.scope?.stage_id ?? 'S00'}:${identity}`;

  // Assemble the durable disposition via the existing builder (it re-validates
  // the decision, binds the finding claim verbatim, checks the accepted Plan
  // binding of the finding, and applies the VERIFIER_OVERREACH closure).
  let dispositionFact: MesFactEnvelope;
  try {
    dispositionFact = buildFindingDisposition({
      executionMode: 'NORMAL',
      created_by: 'brain',
      disposition_ref: dispositionRef,
      finding_ref: findingRef,
      finding_disposition: findingDisposition,
      claimed_route_code: sourceFinding.claimed_route_code,
      accepted_route_code: acceptedRouteCode,
      basis_refs: basisRefs,
      reason,
      resume_target: resumeTarget,
      finding: sourceFinding,
    });
  } catch (error) {
    // validateFindingDisposition / buildFindingDisposition raise
    // SchemaValidationError with a structured message.
    const detail = error instanceof Error ? error.message : String(error);
    materializeFail('invalid-field', `semantic event ${eventKind} disposition decision is invalid: ${detail} — no-write`, eventKind);
  }

  return { facts: [dispositionFact] };
};

/**
 * The ONE mechanical catalog entry of the Finding-disposition family.
 */
export const FINDING_DISPOSITION_ENTRY: MesSemanticEventCatalogEntry = {
  event_kind: FINDING_DISPOSITION_EVENT_KIND,
  caller_fields: ['finding_ref', 'finding_disposition', 'accepted_route_code', 'basis_refs', 'reason', 'resume_target'],
  required_caller_fields: ['finding_ref', 'finding_disposition', 'basis_refs', 'reason', 'resume_target'],
  runtime_derived_fields: [
    'disposition_ref',
    'fact_id',
    'claimed_route_code',
    'finding',
    'source_finding',
    'plan_binding',
    'scope',
    'git_basis',
    'authority_refs',
  ],
  durable_outputs: [{ fact_kind: 'finding_disposition', mutability: 'immutable' }],
  reused_oracles: ['validateFindingDisposition', 'buildFindingDisposition'],
  forbidden_caller_fields: [
    'disposition_ref',
    'fact_id',
    'claimed_route_code',
    'finding',
    'source_finding',
    'plan_binding',
    'scope',
    'git_basis',
    'authority_refs',
    'facts',
    'route',
    'next_action',
  ],
  failure_codes: ['invalid-field', 'binding-mismatch', 'conflict', 'invalid-derived-fact', 'unreadable'],
  replay_identity: ['finding_ref', 'finding_disposition', 'accepted_route_code', 'resume_target', 'reason', 'basis_refs'],
  canonicalization: [
    'disposition_ref / fact_id = mes:disposition:<stage>:sha256(canonicalStringify(replay_identity)) (no timestamps, no snapshot digest, no insertion order)',
    'claimed_route_code carried verbatim from the durable source finding (evidence, never editable)',
    'accepted binding / scope / Git basis / authority_refs inherited from the source finding',
    'VERIFIER_OVERREACH closure (accepted_route_code null + resume_target verifier-lane) via buildFindingDisposition',
  ],
};