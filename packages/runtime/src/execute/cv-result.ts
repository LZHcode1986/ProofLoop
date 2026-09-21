/**
 * @proofloop/runtime — Slice-level CV result envelope + verdict gate
 * (S03-D-T01; bounded repair S03-D-CV1-r2).
 *
 * Pure, read-only, fail-closed seam for the Code Verifier's allowed-result
 * envelope (code-verifier-template "允许的结果" + HP-005 + E2E-08 / E2E-20 +
 * STATIC-20 / ADR-005). The canonical schema is intentionally MIXED exactly
 * as the template owns it:
 *
 *   - snake_case (template-owned): execution_mode / stage_id / slice_id /
 *     verification_type / acceptance_refs_checked / failed_acceptance_refs /
 *     invalid_tests / counterexamples / scope_violations /
 *     forbidden_substitutions / regression_failures / claimed_route_code /
 *     failed_criterion / failure_signature / required_recheck_scope /
 *     previous_failure_signature / repair_diff_basis / subtype / reason /
 *     invalidation_scope / resume_target;
 *   - template camelCase (must remain EXACTLY these): actionToken / verdict /
 *     summary / planRef / authorityRefs / gitBasis (nested head /
 *     candidateRef / diffRef) / resultRef.
 *
 * All-snake substitutions (plan_ref / authority_refs / git_basis /
 * result_ref / candidate_ref / diff_ref) are NOT canonical — they are
 * unknown keys and fail closed, exactly like any other smuggling attempt.
 *
 *   - `validateCvResult` closed-set-validates a Slice-level CV result:
 *     verdict ∈ {PASS, FINDINGS, BLOCKED} (REVIEW_RESET_REQUIRED is a
 *     lifecycle signal only and is never substituted for a verdict),
 *     verification_type ∈ {initial, recheck}, canonical stage/slice ids,
 *     root-relative planRef, canonical authorityRefs, closed gitBasis {head
 *     40-hex, candidateRef, diffRef}, resultRef required under NORMAL and
 *     forbidden under PRE_MES_BOOTSTRAP, non-empty summary, the closed
 *     acceptance list fields, claimed_route_code closed (or null),
 *     FINDINGS-only fields (failed_criterion / failure_signature /
 *     required_recheck_scope) and recheck-only fields
 *     (previous_failure_signature / repair_diff_basis) required exactly in
 *     their owning combinations;
 *   - NON-SUCCESS closure (code-verifier-template: 非成功结果必须包含
 *     claimed_route_code、subtype、reason、invalidation_scope 与
 *     resume_target): verdict FINDINGS/BLOCKED requires a non-null closed
 *     claimed_route_code (CV evidence only), a non-empty subtype, a
 *     non-empty reason, an invalidation_scope ref list and a closed
 *     resume_target ∈ {producer, planner, authority-owner, research,
 *     recovery, verifier-lane} (§2.2.3). On PASS these non-success fields
 *     are out-of-place and fail closed (closed-set, no smuggling);
 *   - `gateCvResult` implements the verdict gate (PO-S03-D-02): ONLY
 *     `PASS` (+ candidate ref durable) → READY_TO_INTEGRATE; PASS without a
 *     durable candidate ref is PASS_PENDING_CANDIDATE_REF (never ready);
 *     FINDINGS / BLOCKED are structured findings/blockers routed back to
 *     Brain (E2E-08). The gate never emits a route code, never claims
 *     CV PASS == INTEGRATED (ADR-005: integration is a separate step) and
 *     never makes a route decision — it closes over a fixed state set only.
 *
 * The CV reads its verification basis only from the dispatch packet target /
 * Authority / Plan / Git facts — MES status is never evidence for a
 * PASS/FINDING (HP-005) and Worker Result refs are only supporting evidence,
 * never primary (code-verifier-template). No MES reasoning, no route, no
 * second state machine (STATIC-20/05/14).
 */
import { SchemaValidationError, CANONICAL_STAGE_ID_RE } from '@proofloop/kernel';
import { isCanonicalAuthorityRef, isCanonicalRootRelativeRef } from '../mes/binding';
import { MES_RESUME_TARGETS } from '../mes/types';
import type { MesResumeTarget } from '../mes/types';
import { MAINTENANCE_LANE_PLAN_REF, MAINTENANCE_LANE_STAGE } from '../mes/maintenance-seam';

/** Closed CV verdicts (code-verifier-template; HP-005). */
export const CV_VERDICTS = ['PASS', 'FINDINGS', 'BLOCKED'] as const;
export type CvVerdict = (typeof CV_VERDICTS)[number];


/**
 * Closed CV claimed-route set (code-verifier-template "允许的结果"): the CV
 * evidence never claims Product→Technical `AUTHORITY_GAP` — the downstream
 * legal classification is exactly IMPLEMENTATION_DEFECT | PLAN_GAP |
 * TECHNICAL_UNKNOWN | RUNTIME_BLOCKER | USER_DECISION_REQUIRED |
 * EVIDENCE_GAP (or null on PASS).
 */
export const CV_CLAIMED_ROUTE_CODES = [
  'IMPLEMENTATION_DEFECT',
  'PLAN_GAP',
  'TECHNICAL_UNKNOWN',
  'RUNTIME_BLOCKER',
  'USER_DECISION_REQUIRED',
  'EVIDENCE_GAP',
] as const;
export type CvClaimedRouteCode = (typeof CV_CLAIMED_ROUTE_CODES)[number];
/**
 * Lifecycle signal requesting a fresh full initial — NOT a verdict. It can
 * never be substituted for PASS / FINDINGS / BLOCKED inside the result
 * envelope (code-verifier-template: "REVIEW_RESET_REQUIRED 只用于要求 fresh
 * full initial 的 lifecycle 信号，不是可替代 PASS 的结果").
 */
export const CV_REVIEW_RESET_SIGNAL = 'REVIEW_RESET_REQUIRED' as const;

/** Closed verification types (initial full vs bounded recheck). */
export const CV_VERIFICATION_TYPES = ['initial', 'recheck'] as const;
export type CvVerificationType = (typeof CV_VERIFICATION_TYPES)[number];

/** Closed execution modes carried by the CV result envelope. */
export const CV_EXECUTION_MODES = ['NORMAL', 'PRE_MES_BOOTSTRAP', 'MES_MAINTENANCE'] as const;
export type CvExecutionMode = (typeof CV_EXECUTION_MODES)[number];


/**
 * Closed MES_MAINTENANCE binding carried by a CV result (code-verifier
 * template, camelCase canonical fields). Omitted for NORMAL /
 * PRE_MES_BOOTSTRAP; required under MES_MAINTENANCE.
 */
export interface CvMaintenanceBinding {
  readonly frozenSnapshotRef: string;
  readonly frozenSnapshotSha256: string;
  readonly frozenFactCount: number;
  readonly forensicRef: string;
  readonly forensicSha256: string;
  readonly auditRef: string;
  readonly auditSha256: string;
}
/** Closed Git basis of the verified candidate (packet basis, not MES status). */
export interface CvGitBasis {
  readonly head: string;
  readonly candidateRef: string;
  readonly diffRef: string;
}

/**
 * Closed Slice-level CV result envelope (code-verifier-template "允许的结果").
 * Canonical schema is intentionally mixed: snake_case fields below + template
 * camelCase fields (actionToken / verdict / summary / planRef / authorityRefs
 * / gitBasis / resultRef). All-snake or all-camel substitutes are unknown
 * keys and fail closed.
 */
export interface CvResultEnvelope {
  readonly execution_mode: CvExecutionMode;
  readonly actionToken: string;
  readonly verdict: CvVerdict;
  readonly stage_id: string;
  readonly slice_id: string;
  readonly verification_type: CvVerificationType;
  readonly planRef: string;
  readonly authorityRefs: string[];
  readonly gitBasis: CvGitBasis;
  /** NORMAL: required root-relative MES result ref; bootstrap/maintenance: omitted. */
  readonly resultRef?: string;
  /** MES_MAINTENANCE only; omitted for NORMAL / PRE_MES_BOOTSTRAP. */
  readonly maintenanceBinding?: CvMaintenanceBinding;
  readonly summary: string;
  readonly acceptance_refs_checked: string[];
  readonly failed_acceptance_refs: string[];
  readonly invalid_tests: string[];
  readonly counterexamples: string[];
  readonly scope_violations: string[];
  readonly forbidden_substitutions: string[];
  readonly regression_failures: string[];
  readonly claimed_route_code: CvClaimedRouteCode | null;
  /** FINDINGS-only (required exactly when verdict === FINDINGS). */
  readonly failed_criterion?: string;
  readonly failure_signature?: string;
  readonly required_recheck_scope?: string[];
  /** recheck-only (required exactly when verification_type === recheck). */
  readonly previous_failure_signature?: string;
  readonly repair_diff_basis?: string;
  /** Non-success only (required exactly when verdict is FINDINGS/BLOCKED). */
  readonly subtype?: string;
  readonly reason?: string;
  readonly invalidation_scope?: string[];
  readonly resume_target?: MesResumeTarget;
}

/** Closed gate state set — never a route code, never INTEGRATED itself. */
export type CvGateState =
  | 'READY_TO_INTEGRATE'
  | 'PASS_PENDING_CANDIDATE_REF'
  | 'FINDINGS'
  | 'BLOCKED';

export const CV_GATE_STATES: readonly CvGateState[] = [
  'READY_TO_INTEGRATE',
  'PASS_PENDING_CANDIDATE_REF',
  'FINDINGS',
  'BLOCKED',
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

function expectNonEmptyString(
  value: unknown,
  path: string,
  errors: FieldError[],
  label: string,
): string | undefined {
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

/** Canonical Git ref name: no whitespace/control, no backslash, no `..`, no leading `/`. */
function isCanonicalGitRef(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (hasControlCharacter(value) || /\s/.test(value)) return false;
  if (value.includes('\\') || value.includes('..') || value.startsWith('/')) return false;
  return true;
}

/** Canonical stage scope for a Slice-level CV result. */
function expectStageAndSlice(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  if (typeof value !== 'string' || !CANONICAL_STAGE_ID_RE.test(value)) {
    errors.push({ path, message: 'Expected a canonical Stage ID matching /^S\\d+$/, e.g. S03' });
  }
}

const CV_RESULT_KNOWN_FIELDS = new Set([
  'execution_mode',
  'actionToken',
  'verdict',
  'stage_id',
  'slice_id',
  'verification_type',
  'planRef',
  'authorityRefs',
  'gitBasis',
  'resultRef',
  'maintenanceBinding',
  'summary',
  'acceptance_refs_checked',
  'failed_acceptance_refs',
  'invalid_tests',
  'counterexamples',
  'scope_violations',
  'forbidden_substitutions',
  'regression_failures',
  'claimed_route_code',
  'failed_criterion',
  'failure_signature',
  'required_recheck_scope',
  'previous_failure_signature',
  'repair_diff_basis',
  'subtype',
  'reason',
  'invalidation_scope',
  'resume_target',
]);

const GIT_BASIS_KNOWN_FIELDS = new Set(['head', 'candidateRef', 'diffRef']);

function validateGitBasisInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): CvGitBasis | undefined {
  const obj = isObject(value) ? value : undefined;
  if (!obj) {
    errors.push({ path, message: 'gitBasis must be an object with head / candidateRef / diffRef' });
    return undefined;
  }
  checkUnknownFields(obj, GIT_BASIS_KNOWN_FIELDS, path, errors);
  const head = obj.head;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) {
    errors.push({ path: `${path}.head`, message: 'head must be a 40-char lowercase hex commit SHA' });
  }
  const candidateRef = obj.candidateRef;
  if (!isCanonicalGitRef(candidateRef)) {
    errors.push({
      path: `${path}.candidateRef`,
      message: 'candidateRef must be a canonical Git ref (no whitespace/control, no .., no leading /, no backslash)',
    });
  }
  const diffRef = obj.diffRef;
  if (typeof diffRef !== 'string' || hasControlCharacter(diffRef) || !isCanonicalRootRelativeRef(diffRef)) {
    errors.push({
      path: `${path}.diffRef`,
      message: 'diffRef must be a canonical root-relative path (no traversal / absolute / backslash / empty segment)',
    });
  }
  return { head: head as string, candidateRef: candidateRef as string, diffRef: diffRef as string };
}

/** A ref-list field: array of non-empty strings without control characters. */
function validateRefListInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'Expected an array of ref strings' });
    return;
  }
  value.forEach((entry, i) => {
    if (typeof entry !== 'string' || entry.length === 0 || hasControlCharacter(entry)) {
      errors.push({ path: `${path}[${i}]`, message: 'Expected a non-empty ref string without control characters' });
    }
  });
}

/** Closed maintenance binding fields on a CV result (camelCase). */
const CV_MAINTENANCE_BINDING_FIELDS = new Set([
  'frozenSnapshotRef',
  'frozenSnapshotSha256',
  'frozenFactCount',
  'forensicRef',
  'forensicSha256',
  'auditRef',
  'auditSha256',
]);

/** Closed-shape validation of the CV result maintenanceBinding (schema-only). */
function validateCvMaintenanceBindingInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  const binding = isObject(value) ? value : undefined;
  if (!binding) {
    errors.push({ path, message: 'maintenanceBinding must be an object with the frozen/forensic/audit tuple' });
    return;
  }
  checkUnknownFields(binding, CV_MAINTENANCE_BINDING_FIELDS, path, errors);
  for (const refField of ['frozenSnapshotRef', 'forensicRef', 'auditRef'] as const) {
    const ref = binding[refField];
    if (typeof ref !== 'string' || !isCanonicalRootRelativeRef(ref)) {
      errors.push({ path: `${path}.${refField}`, message: 'Expected a canonical root-relative ref' });
    }
  }
  for (const digestField of ['frozenSnapshotSha256', 'forensicSha256', 'auditSha256'] as const) {
    const digest = binding[digestField];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      errors.push({ path: `${path}.${digestField}`, message: 'Expected a 64-char lowercase hex sha256' });
    }
  }
  const count = binding.frozenFactCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
    errors.push({ path: `${path}.frozenFactCount`, message: 'Expected a positive integer' });
  }
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
 * Fail-closed closed-set validation of a Slice-level CV result envelope
 * (code-verifier-template "允许的结果"; intentionally mixed canonical schema).
 *
 * @returns the validated, typed envelope.
 * @throws {SchemaValidationError} on any violation.
 */
export function validateCvResult(value: unknown): CvResultEnvelope {
  return collectErrors('CvResultEnvelope', (errors) => {
    const obj = isObject(value) ? value : undefined;
    if (!obj) {
      errors.push({ path: 'cv_result', message: 'Expected a CV result object' });
      return undefined;
    }
    checkUnknownFields(obj, CV_RESULT_KNOWN_FIELDS, 'cv_result', errors);

    const executionMode = obj.execution_mode;
    if (
      typeof executionMode !== 'string' ||
      !(CV_EXECUTION_MODES as readonly string[]).includes(executionMode)
    ) {
      errors.push({
        path: 'cv_result.execution_mode',
        message: `Expected one of: ${CV_EXECUTION_MODES.map((m) => JSON.stringify(m)).join(', ')}`,
      });
    }

    observeStringNoControl(obj.actionToken, 'cv_result.actionToken', errors, 'actionToken');

    const verdict = obj.verdict;
    if (typeof verdict !== 'string' || !(CV_VERDICTS as readonly string[]).includes(verdict)) {
      if (verdict === CV_REVIEW_RESET_SIGNAL) {
        errors.push({
          path: 'cv_result.verdict',
          message:
            'REVIEW_RESET_REQUIRED is a lifecycle signal requesting a fresh full initial, never a verdict inside the result envelope (it cannot substitute PASS/FINDINGS/BLOCKED)',
        });
      } else {
        errors.push({
          path: 'cv_result.verdict',
          message: `Expected one of: ${CV_VERDICTS.map((v) => JSON.stringify(v)).join(', ')}`,
        });
      }
    }

    const stageId = obj.stage_id;
    expectStageAndSlice(stageId, 'cv_result.stage_id', errors);
    const sliceId = obj.slice_id;
    if (typeof sliceId !== 'string' || !/^S\d+-[A-Z]+(?:-[A-Z]+)?$/.test(sliceId)) {
      errors.push({ path: 'cv_result.slice_id', message: 'Expected a canonical Slice ID shape like S03-D' });
    } else if (typeof stageId === 'string' && CANONICAL_STAGE_ID_RE.test(stageId)) {
      // (S03-STAGE-REVIEW-F001) Stage/slice closure: the Slice's stage prefix
      // must EXACTLY equal the result's stage_id — a CV result declaring
      // stage_id S03 together with slice_id S04-F is a cross-stage smuggling
      // attempt and fails closed, never silently narrowed.
      const sliceStagePrefix = sliceId.slice(0, sliceId.indexOf('-'));
      if (sliceStagePrefix !== stageId) {
        errors.push({
          path: 'cv_result.slice_id',
          message: `Slice ID ${JSON.stringify(sliceId)} stage prefix ${JSON.stringify(sliceStagePrefix)} must equal the CV result stage_id ${JSON.stringify(stageId)} (cross-stage slice failed closed)`,
        });
      }
    }

    const verificationType = obj.verification_type;
    if (
      typeof verificationType !== 'string' ||
      !(CV_VERIFICATION_TYPES as readonly string[]).includes(verificationType)
    ) {
      errors.push({
        path: 'cv_result.verification_type',
        message: `Expected one of: ${CV_VERIFICATION_TYPES.map((t) => JSON.stringify(t)).join(', ')}`,
      });
    }

    const planRef = obj.planRef;
    if (executionMode === 'MES_MAINTENANCE') {
      if (typeof stageId === 'string' && stageId !== MAINTENANCE_LANE_STAGE) {
        errors.push({
          path: 'cv_result.stage_id',
          message: `MES_MAINTENANCE CV results must carry stage_id EXACTLY ${MAINTENANCE_LANE_STAGE} — the maintenance lane is ${MAINTENANCE_LANE_STAGE}-scoped (no lane widening)`,
        });
      }
      if (typeof planRef === 'string' && planRef !== MAINTENANCE_LANE_PLAN_REF) {
        errors.push({
          path: 'cv_result.planRef',
          message: `MES_MAINTENANCE planRef must EXACTLY equal the recovery candidate ${MAINTENANCE_LANE_PLAN_REF} (stale candidate / accepted Plan substitution fails closed)`,
        });
      }
    }
    if (typeof planRef !== 'string' || !isCanonicalRootRelativeRef(planRef)) {
      errors.push({
        path: 'cv_result.planRef',
        message: 'planRef must be a canonical root-relative Plan ref (no absolute path, no .., no backslash, no empty segment)',
      });
    }

    const authorityRefs = obj.authorityRefs;
    if (!Array.isArray(authorityRefs) || authorityRefs.length === 0) {
      errors.push({ path: 'cv_result.authorityRefs', message: 'Expected a non-empty array of canonical authority refs' });
    } else {
      authorityRefs.forEach((ref, i) => {
        if (!isCanonicalAuthorityRef(ref)) {
          errors.push({
            path: `cv_result.authorityRefs[${i}]`,
            message: 'Expected canonical authority ref "<root-relative-path>#<section/entity>"',
          });
        }
      });
    }

    validateGitBasisInto(obj.gitBasis, 'cv_result.gitBasis', errors);

    const resultRef = obj.resultRef;
    if (executionMode === 'NORMAL') {
      if (typeof resultRef !== 'string' || !isCanonicalRootRelativeRef(resultRef)) {
        errors.push({
          path: 'cv_result.resultRef',
          message: 'resultRef is required under NORMAL and must be a canonical root-relative MES result ref',
        });
      }
    } else if (resultRef !== undefined) {
      errors.push({
        path: 'cv_result.resultRef',
        message: 'Non-NORMAL CV results (PRE_MES_BOOTSTRAP / MES_MAINTENANCE) must omit resultRef (Git-bound Link evidence only)',
      });
    }
    // maintenanceBinding: REQUIRED exactly under MES_MAINTENANCE; forbidden
    // under NORMAL / PRE_MES_BOOTSTRAP (no second schema, no smuggling).
    if (executionMode === 'MES_MAINTENANCE' && obj.maintenanceBinding === undefined) {
      errors.push({
        path: 'cv_result.maintenanceBinding',
        message: 'MES_MAINTENANCE CV results require a maintenanceBinding (frozen/forensic/audit exact tuple)',
      });
    } else if (executionMode !== 'MES_MAINTENANCE' && obj.maintenanceBinding !== undefined) {
      errors.push({
        path: 'cv_result.maintenanceBinding',
        message: 'maintenanceBinding is only valid under MES_MAINTENANCE',
      });
    } else if (obj.maintenanceBinding !== undefined) {
      validateCvMaintenanceBindingInto(obj.maintenanceBinding, 'cv_result.maintenanceBinding', errors);
    }

    observeStringNoControl(obj.summary, 'cv_result.summary', errors, 'summary');

    validateRefListInto(obj.acceptance_refs_checked, 'cv_result.acceptance_refs_checked', errors);
    validateRefListInto(obj.invalid_tests, 'cv_result.invalid_tests', errors);
    validateRefListInto(obj.counterexamples, 'cv_result.counterexamples', errors);
    validateRefListInto(obj.scope_violations, 'cv_result.scope_violations', errors);
    validateRefListInto(obj.forbidden_substitutions, 'cv_result.forbidden_substitutions', errors);
    validateRefListInto(obj.regression_failures, 'cv_result.regression_failures', errors);

    // failed_acceptance_refs is a referential subset closure: a failed
    // acceptance ref must have been part of the checked set (a forged failure
    // outside the checked refs fails closed).
    validateRefListInto(obj.failed_acceptance_refs, 'cv_result.failed_acceptance_refs', errors);
    if (Array.isArray(obj.acceptance_refs_checked) && Array.isArray(obj.failed_acceptance_refs)) {
      const checked = new Set(obj.acceptance_refs_checked);
      (obj.failed_acceptance_refs as unknown[]).forEach((ref, i) => {
        if (typeof ref === 'string' && !checked.has(ref)) {
          errors.push({
            path: `cv_result.failed_acceptance_refs[${i}]`,
            message: `failed acceptance ref ${JSON.stringify(ref)} is not part of acceptance_refs_checked (referential closure)`,
          });
        }
      });
    }

    // Non-success closure (code-verifier-template): claimed_route_code is
    // REQUIRED non-null on FINDINGS/BLOCKED (CV evidence only); subtype,
    // reason, invalidation_scope and resume_target are REQUIRED on
    // FINDINGS/BLOCKED and OUT-OF-PLACE on PASS (no smuggling).
    const isNonSuccess = verdict === 'FINDINGS' || verdict === 'BLOCKED';
    const claimed = obj.claimed_route_code;
    if (isNonSuccess) {
      if (typeof claimed !== 'string' || !(CV_CLAIMED_ROUTE_CODES as readonly string[]).includes(claimed)) {
        errors.push({
          path: 'cv_result.claimed_route_code',
          message: `non-success results require a closed claimed_route_code (CV evidence only): one of ${CV_CLAIMED_ROUTE_CODES.map((c) => JSON.stringify(c)).join(', ')}`,
        });
      }
    } else if (claimed !== null && (typeof claimed !== 'string' || !(CV_CLAIMED_ROUTE_CODES as readonly string[]).includes(claimed))) {
      errors.push({
        path: 'cv_result.claimed_route_code',
        message: `claimed_route_code must be null or one of: ${CV_CLAIMED_ROUTE_CODES.map((c) => JSON.stringify(c)).join(', ')}`,
      });
    }

    const nonSuccessFields = ['subtype', 'reason', 'invalidation_scope', 'resume_target'] as const;
    for (const field of nonSuccessFields) {
      const present = obj[field] !== undefined;
      if (isNonSuccess && !present) {
        errors.push({ path: `cv_result.${field}`, message: `${field} is REQUIRED on a non-success verdict (FINDINGS/BLOCKED structured blocker closure)` });
      } else if (!isNonSuccess && present) {
        errors.push({ path: `cv_result.${field}`, message: `${field} is only valid on a non-success verdict (FINDINGS/BLOCKED)` });
      }
    }
    if (isNonSuccess) {
      observeStringNoControl(obj.subtype, 'cv_result.subtype', errors, 'subtype');
      observeStringNoControl(obj.reason, 'cv_result.reason', errors, 'reason');
      validateRefListInto(obj.invalidation_scope, 'cv_result.invalidation_scope', errors);
      const resumeTarget = obj.resume_target;
      if (typeof resumeTarget !== 'string' || !(MES_RESUME_TARGETS as readonly string[]).includes(resumeTarget)) {
        errors.push({
          path: 'cv_result.resume_target',
          message: `Expected one of: ${MES_RESUME_TARGETS.map((t) => JSON.stringify(t)).join(', ')}`,
        });
      }
    }

    // FINDINGS-only fields: required exactly when verdict === FINDINGS; any
    // presence under another verdict fails closed (closed-set, no smuggling).
    const isFindings = verdict === 'FINDINGS';
    const findingsOnly = ['failed_criterion', 'failure_signature', 'required_recheck_scope'] as const;
    for (const field of findingsOnly) {
      const present = obj[field] !== undefined;
      if (isFindings && !present) {
        errors.push({ path: `cv_result.${field}`, message: `${field} is REQUIRED on a FINDINGS verdict (failed criterion, failure signature and bounded recheck scope)` });
      } else if (!isFindings && present) {
        errors.push({ path: `cv_result.${field}`, message: `${field} is only valid on a FINDINGS verdict` });
      }
    }
    if (isFindings) {
      observeStringNoControl(obj.failed_criterion, 'cv_result.failed_criterion', errors, 'failed_criterion');
      observeStringNoControl(obj.failure_signature, 'cv_result.failure_signature', errors, 'failure_signature');
      const recheckScope = obj.required_recheck_scope;
      if (!Array.isArray(recheckScope) || recheckScope.length === 0) {
        errors.push({ path: 'cv_result.required_recheck_scope', message: 'required_recheck_scope must be a non-empty array of bounded recheck refs' });
      } else {
        validateRefListInto(recheckScope, 'cv_result.required_recheck_scope', errors);
      }
    }

    // recheck-only fields: required exactly when verification_type === recheck.
    const isRecheck = verificationType === 'recheck';
    const recheckOnly = ['previous_failure_signature', 'repair_diff_basis'] as const;
    for (const field of recheckOnly) {
      const present = obj[field] !== undefined;
      if (isRecheck && !present) {
        errors.push({ path: `cv_result.${field}`, message: `${field} is REQUIRED on a recheck (bounded CV continuation)` });
      } else if (!isRecheck && present) {
        errors.push({ path: `cv_result.${field}`, message: `${field} is only valid on a recheck (verification_type === "recheck")` });
      }
    }
    if (isRecheck) {
      observeStringNoControl(obj.previous_failure_signature, 'cv_result.previous_failure_signature', errors, 'previous_failure_signature');
      observeStringNoControl(obj.repair_diff_basis, 'cv_result.repair_diff_basis', errors, 'repair_diff_basis');
    }

    // PASS requires no concrete counterexample (code-verifier-template: PASS =
    // no counterexample after refutation completes).
    if (verdict === 'PASS' && Array.isArray(obj.counterexamples) && obj.counterexamples.length > 0) {
      errors.push({
        path: 'cv_result.counterexamples',
        message: 'PASS verdict is inconsistent with concrete counterexamples (PASS requires refutation completed with no counterexample)',
      });
    }

    return obj as unknown as CvResultEnvelope;
  }) as CvResultEnvelope;
}

/**
 * Verdict gate (PO-S03-D-02 / E2E-08 / ADR-005).
 *
 * Only `PASS` **with a durable candidate ref** closes READY_TO_INTEGRATE.
 * PASS without a durable candidate ref is PASS_PENDING_CANDIDATE_REF (the
 * CV verdict is not the integration trigger — the candidate ref durability
 * is a separate Git fact). FINDINGS / BLOCKED are structured findings or
 * blockers routed back to Brain; the gate never chooses a route code, never
 * claims CV PASS == INTEGRATED and never decides the owner of a repair.
 *
 * @param candidateRefDurable whether the candidate Git ref is durable
 *   (a Git fact, not MES status — HP-005).
 */
export function gateCvResult(
  result: CvResultEnvelope,
  opts: { readonly candidateRefDurable: boolean },
): { readonly state: CvGateState } {
  if (result.verdict !== 'PASS') {
    return { state: result.verdict };
  }
  return opts.candidateRefDurable
    ? { state: 'READY_TO_INTEGRATE' }
    : { state: 'PASS_PENDING_CANDIDATE_REF' };
}

/** Convenience closed-predicate view of the gate. */
export function isReadyToIntegrate(
  result: CvResultEnvelope,
  opts: { readonly candidateRefDurable: boolean },
): boolean {
  return gateCvResult(result, opts).state === 'READY_TO_INTEGRATE';
}