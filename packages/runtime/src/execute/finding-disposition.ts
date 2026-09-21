/**
 * @proofloop/runtime — FINDING_DISPOSITION durable fact construct/validate
 * seam (S03-D-T02).
 *
 * Brain-owned arbitration of a verifier finding (contracts.md §2.2.3 /
 * mes.md FINDING_DISPOSITION YAML + E2E-20 + STATIC-13/14):
 *
 *   - `validateFindingDisposition` closed-set-validates the §2.2.3 YAML
 *     decision BEFORE it is assembled into a MES fact: disposition_ref
 *     (MES-generated), finding_ref, finding_disposition ∈ {ACCEPTED,
 *     VERIFIER_OVERREACH}, claimed_route_code (closed — evidence only),
 *     accepted_route_code (closed; VERIFIER_OVERREACH ⇒ must be null),
 *     basis_refs (array of refs), reason (non-empty, no control chars),
 *     resume_target ∈ {producer, planner, authority-owner, research,
 *     recovery, verifier-lane}, created_by: brain, executionMode: NORMAL;
 *   - `buildFindingDisposition` assembles the full durable
 *     `finding_disposition` MES fact envelope. It binds the REAL original
 *     finding: finding_ref must equal the finding fact_id; the claim is
 *     carried over verbatim (claimed_route_code === finding.claimed_route_code
 *     — the verifier's claim is evidence, never editable at arbitration
 *     time); VERIFIER_OVERREACH can only be produced by the Brain (the
 *     finding input never carries a disposition, so a verifier cannot
 *     self-claim overreach) and returns to the verifier lane
 *     (resume_target === verifier-lane) with accepted_route_code null — no
 *     automatic producer repair / Replan / HUMAN_REQUIRED; a PASS finding or
 *     a candidate-plan revision can never produce an acceptance
 *     (§2.2.2 / E2E-20); PRE_MES_BOOTSTRAP never writes this durable fact
 *     (STATIC-13/14: bootstrap evidence is Git-bound, no second decision
 *     store). The assembled envelope is re-validated through the canonical
 *     validateMesFactEnvelope so no field can bypass the MES closed set;
 *   - `effectiveRoute` exposes ONLY accepted_route_code read-only —
 *     claimed_route_code never drives routing, only the Brain-accepted route
 *     does, and the seam itself never routes.
 *
 * No MES reasoning, no route decision, no second state machine (STATIC-05/14).
 */
import { SchemaValidationError } from '@proofloop/kernel';
import { MES_EXECUTION_MODES } from '../mes/binding';
import {
  MES_SCHEMA_VERSION,
  MES_CREATED_BY,
  MES_FINDING_DISPOSITIONS,
  MES_ROUTE_CODES,
  MES_RESUME_TARGETS,
} from '../mes/types';
import type {
  MesFactEnvelope,
  MesFindingDisposition,
  MesRouteCode,
  MesResumeTarget,
} from '../mes/types';
import { validateMesFactEnvelope } from '../mes/validate';

/** Closed set of finding_disposition payload fields (§2.2.3 YAML). */
export const MES_FINDING_DISPOSITION_FIELDS = [
  'disposition_ref',
  'finding_ref',
  'finding_disposition',
  'claimed_route_code',
  'accepted_route_code',
  'basis_refs',
  'reason',
  'resume_target',
] as const;

export type MesFindingDispositionField = (typeof MES_FINDING_DISPOSITION_FIELDS)[number];

/** Closed resume targets of a finding disposition (§2.2.3 / mes.md). */
export const FINDING_DISPOSITION_RESUME_TARGETS: readonly MesResumeTarget[] = [
  'producer',
  'planner',
  'authority-owner',
  'research',
  'recovery',
  'verifier-lane',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

interface FieldError {
  path: string;
  message: string;
}

function checkUnknownFields(
  data: Record<string, unknown>,
  known: ReadonlySet<string>,
  path: string,
  errors: FieldError[],
): void {
  for (const key of Object.keys(data)) {
    if (!known.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `Unknown field "${key}"` });
    }
  }
}

function expectNonEmptyString(value: unknown, path: string, errors: FieldError[], label: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({
      path,
      message: `Expected a non-empty string for ${label}, got ${value === null ? 'null' : typeof value}`,
    });
    return undefined;
  }
  return value;
}

function observeStringNoControl(
  value: unknown,
  path: string,
  errors: FieldError[],
  label: string,
): string | undefined {
  const str = expectNonEmptyString(value, path, errors, label);
  if (str !== undefined && hasControlCharacter(str)) {
    errors.push({ path, message: `${label} must not contain control characters` });
    return undefined;
  }
  return str;
}

function collectErrors(label: string, fn: (errors: FieldError[]) => unknown): unknown {
  const errors: FieldError[] = [];
  const result = fn(errors);
  if (errors.length > 0) {
    throw new SchemaValidationError(
      `${label} validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      errors,
    );
  }
  return result;
}

/**
 * Closed-set validation of the §2.2.3 finding-disposition DECISION (the YAML
 * before it becomes a MES fact envelope). Pure and read-only; the finding
 * input is intentionally not consulted here (it only binds at construction).
 *
 * @throws {SchemaValidationError} on any violation.
 */
export function validateFindingDisposition(value: unknown): Record<string, unknown> {
  return collectErrors('FindingDisposition', (errors) => {
    const obj = isObject(value) ? value : undefined;
    if (!obj) {
      errors.push({ path: 'finding_disposition', message: 'Expected a finding disposition object' });
      return undefined;
    }
    checkUnknownFields(
      obj,
      new Set([...MES_FINDING_DISPOSITION_FIELDS, 'executionMode', 'created_by', 'finding']),
      'finding_disposition',
      errors,
    );

    const executionMode = obj.executionMode;
    if (
      typeof executionMode !== 'string' ||
      !(MES_EXECUTION_MODES as readonly string[]).includes(executionMode)
    ) {
      errors.push({
        path: 'finding_disposition.executionMode',
        message: `Expected one of: ${MES_EXECUTION_MODES.map((m) => JSON.stringify(m)).join(', ')}`,
      });
    } else if (executionMode !== 'NORMAL') {
      // STATIC-13/14: PRE_MES_BOOTSTRAP never writes a durable disposition
      // fact — bootstrap evidence is Git-bound, there is no second decision
      // store/log.
      errors.push({
        path: 'finding_disposition.executionMode',
        message: `finding_disposition is a NORMAL-only durable fact (PRE_MES_BOOTSTRAP never writes it; bootstrap evidence is Git-bound, no second decision store)`,
      });
    }

    observeStringNoControl(obj.disposition_ref, 'finding_disposition.disposition_ref', errors, 'disposition_ref');
    observeStringNoControl(obj.finding_ref, 'finding_disposition.finding_ref', errors, 'finding_ref');

    const disposition = obj.finding_disposition;
    if (typeof disposition !== 'string' || !(MES_FINDING_DISPOSITIONS as readonly string[]).includes(disposition)) {
      errors.push({
        path: 'finding_disposition.finding_disposition',
        message: `Expected one of: ${MES_FINDING_DISPOSITIONS.map((d) => JSON.stringify(d)).join(', ')}`,
      });
    }

    const claim = obj.claimed_route_code;
    if (typeof claim !== 'string' || !(MES_ROUTE_CODES as readonly string[]).includes(claim)) {
      errors.push({
        path: 'finding_disposition.claimed_route_code',
        message: `Expected one of: ${MES_ROUTE_CODES.map((c) => JSON.stringify(c)).join(', ')}`,
      });
    }

    const accepted = obj.accepted_route_code;
    const isOverreach = disposition === 'VERIFIER_OVERREACH';
    if (isOverreach) {
      if (accepted !== null) {
        errors.push({
          path: 'finding_disposition.accepted_route_code',
          message: 'accepted_route_code must be null when finding_disposition is VERIFIER_OVERREACH',
        });
      }
      // Overreach is Brain-owned and returns to the verifier lane; pointing
      // at producer/planner/research/recovery would auto-trigger a route
      // (E2E-20 BLOCK condition).
    } else if (disposition === 'ACCEPTED') {
      if (typeof accepted !== 'string' || !(MES_ROUTE_CODES as readonly string[]).includes(accepted)) {
        errors.push({
          path: 'finding_disposition.accepted_route_code',
          message: 'accepted_route_code must be a legal route code when finding_disposition is ACCEPTED',
        });
      }
    }

    const target = obj.resume_target;
    if (typeof target !== 'string' || !(MES_RESUME_TARGETS as readonly string[]).includes(target)) {
      errors.push({
        path: 'finding_disposition.resume_target',
        message: `Expected one of: ${MES_RESUME_TARGETS.map((t) => JSON.stringify(t)).join(', ')}`,
      });
    } else if (isOverreach && target !== 'verifier-lane') {
      errors.push({
        path: 'finding_disposition.resume_target',
        message:
          'VERIFIER_OVERREACH has no automatic producer repair / Replan / HUMAN_REQUIRED — resume_target must be verifier-lane (correct packet/scope/basis, then return to the verifier lane)',
      });
    }

    const basisRefs = obj.basis_refs;
    if (!Array.isArray(basisRefs)) {
      errors.push({ path: 'finding_disposition.basis_refs', message: 'basis_refs must be an array of refs' });
    } else {
      basisRefs.forEach((ref, i) => {
        if (typeof ref !== 'string' || ref.length === 0 || hasControlCharacter(ref)) {
          errors.push({ path: `finding_disposition.basis_refs[${i}]`, message: 'Expected a non-empty ref string without control characters' });
        }
      });
    }

    observeStringNoControl(obj.reason, 'finding_disposition.reason', errors, 'reason');

    const createdBy = obj.created_by;
    if (typeof createdBy !== 'string' || !(MES_CREATED_BY as readonly string[]).includes(createdBy)) {
      errors.push({
        path: 'finding_disposition.created_by',
        message: `finding_disposition is Brain-owned arbitration — created_by must be one of: ${MES_CREATED_BY.map((c) => JSON.stringify(c)).join(', ')}`,
      });
    }

    return obj;
  }) as Record<string, unknown>;
}

/** Closed validation of the finding input must bind (finding kind). */
function isFindingFact(value: unknown): value is MesFactEnvelope {
  return isObject(value) && value.fact_kind === 'finding';
}

/**
 * Assemble the durable `finding_disposition` MES fact envelope from a
 * validated decision + the REAL original finding fact.
 *
 * @throws {SchemaValidationError} on any closed-set or binding violation.
 */
export function buildFindingDisposition(input: unknown): MesFactEnvelope {
  return collectErrors('FindingDispositionFact', (errors) => {
    // Phase 1 — closed-set decision validation (same rules as
    // validateFindingDisposition; duplicated checks are cheap and keep the
    // constructor self-contained for consumers that skip the pre-check).
    const decision = validateFindingDisposition(input);
    const source = isObject(input) ? input : undefined;
    if (!source) {
      errors.push({ path: 'finding_disposition', message: 'Expected a finding disposition input object' });
      return undefined;
    }

    // Phase 2 — bind the REAL durable finding (contracts §2.2.3: disposition
    // binds finding_ref to the original verifier finding).
    const findingInput = source.finding;
    if (!isFindingFact(findingInput)) {
      errors.push({
        path: 'finding_disposition.finding',
        message: 'finding must be a real durable `finding` MES fact (verifier verdict + evidence)',
      });
      return undefined;
    }
    const finding = validateMesFactEnvelope(findingInput);
    if (finding.fact_kind !== 'finding') {
      errors.push({ path: 'finding_disposition.finding', message: `expected a finding fact, got ${JSON.stringify(finding.fact_kind)}` });
      return undefined;
    }
    const verdict = finding.verifier_verdict;
    if (verdict !== 'FINDINGS' && verdict !== 'BLOCKED') {
      errors.push({
        path: 'finding_disposition.finding.verifier_verdict',
        message: `only real FINDINGS/BLOCKED findings can be arbitrated — got ${JSON.stringify(verdict)} (a PASS finding never produces a disposition; candidate revisions never produce acceptance)`,
      });
      return undefined;
    }

    const binding = finding.plan_binding;
    if (binding === undefined || binding.binding_stage !== 'accepted') {
      errors.push({
        path: 'finding_disposition.finding.plan_binding',
        message: 'finding_disposition must bind the accepted Plan of its finding (a candidate revision can never produce acceptance — §2.2.2/§2.2.3)',
      });
      return undefined;
    }

    const findingRef = decision.finding_ref;
    if (findingRef !== finding.fact_id) {
      errors.push({
        path: 'finding_disposition.finding_ref',
        message: `finding_ref ${JSON.stringify(findingRef)} must equal the original finding fact_id ${JSON.stringify(finding.fact_id)}`,
      });
      return undefined;
    }

    // Phase 3 — claim carried over verbatim (evidence, never editable).
    const decisionClaim = decision.claimed_route_code;
    if (decisionClaim !== finding.claimed_route_code) {
      errors.push({
        path: 'finding_disposition.claimed_route_code',
        message: `claimed_route_code ${JSON.stringify(decisionClaim)} must equal the finding's claim ${JSON.stringify(finding.claimed_route_code)} (verifier claim is evidence, carried over verbatim)`,
      });
      return undefined;
    }

    // Phase 4 — assemble the durable envelope; the canonical MES validator
    // re-checks every field (no smuggling around the MES closed set).
    const disposition = decision.finding_disposition as MesFindingDisposition;
    const acceptedRoute = (decision.accepted_route_code as MesRouteCode | null) ?? null;
    const resumeTarget = decision.resume_target as MesResumeTarget;
    const dispositionRef = decision.disposition_ref as string;

    const envelope = validateMesFactEnvelope({
      schema_version: MES_SCHEMA_VERSION,
      fact_id: dispositionRef.replace(/^mes:disposition:/, 'mes:fact:finding_disposition:'),
      fact_kind: 'finding_disposition',
      created_by: 'brain',
      authority_refs: finding.authority_refs,
      scope: finding.scope,
      plan_binding: finding.plan_binding,
      git_basis: finding.git_basis,
      disposition_ref: dispositionRef,
      finding_ref: findingRef,
      finding_disposition: disposition,
      claimed_route_code: decisionClaim,
      accepted_route_code: acceptedRoute,
      basis_refs: decision.basis_refs as string[],
      reason: decision.reason as string,
      resume_target: resumeTarget,
    });

    // Overreach closure is enforced twice: the decision validator already
    // rejected non-null accepted_route_code / non-verifier-lane targets, and
    // the MES validator re-checks the ACCEPTED/OVERREACH fork. This assert is
    // a belt-and-braces guard for the seam contract.
    if (disposition === 'VERIFIER_OVERREACH') {
      if (envelope.accepted_route_code !== null || envelope.resume_target !== 'verifier-lane') {
        errors.push({
          path: 'finding_disposition.accepted_route_code',
          message: 'VERIFIER_OVERREACH must keep accepted_route_code null and resume_target verifier-lane (no automatic producer repair / Replan / HUMAN_REQUIRED)',
        });
        return undefined;
      }
    }

    return envelope;
  }) as MesFactEnvelope;
}

/**
 * Read-side route view of a disposition fact: ONLY accepted_route_code can
 * drive routing; claimed_route_code is evidence and this seam never routes.
 * Returns `null` for VERIFIER_OVERREACH (no automatic route).
 */
export function effectiveRoute(
  disposition: MesFactEnvelope | { readonly accepted_route_code?: MesRouteCode | null },
): MesRouteCode | null {
  const accepted = disposition.accepted_route_code;
  return accepted ?? null;
}