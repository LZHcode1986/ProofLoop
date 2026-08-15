/**
 * Shared closed v2 CV_RESULT payload and CV Receipt chain validation
 * (S08-REVIEW-006).
 *
 * This module is deliberately independent of both `./cv-admission` and
 * `./next`: cv-admission already imports `readVNextAdmissionAuthority` from
 * `./next`, so a reverse import would create a direct circular dependency.
 * The `next` execution consumer applies the SAME closed validation strength
 * as CV admission through this module instead of re-implementing a weaker
 * "equivalent" subset. The exported checks cover:
 *
 *   1. the closed v2 CV_RESULT payload field set — schema/type/verdict/
 *      verification_type vocabulary, stage/slice and Manifest/Plan/Proof
 *      Index/Worker-tip tuple bindings, snapshot digest, context_ref/
 *      context_digest (digest-addressed), summary, the Proof Index reference
 *      arrays (acceptance/seam/oracle/risk), the PASS/REPAIR branch fields
 *      (REPAIR requires failed_criterion/failure_signature/
 *      required_recheck_scope; PASS forbids them) and the initial/recheck
 *      branch constraints (recheck requires previous_failure_signature/
 *      repair_diff_digest; initial forbids them);
 *   2. outer Receipt type ↔ payload verdict agreement (CV_PASS ↔ PASS,
 *      CV_REPAIR ↔ REPAIR);
 *   3. the legal CV chain sequence (a single initial genesis; every later
 *      member is a recheck whose preceding fact is a CV_REPAIR with a
 *      matching failure_signature; nothing may follow a CV_PASS).
 *
 * Failures are reported as `VNextHandoffError` (the same fail-closed error
 * the `next` consumer projects as VALIDATE); the module never performs
 * filesystem or Git I/O and never writes anything.
 */
import { VNextHandoffError } from './dispatch';
import {
  VNEXT_CV_RESULT_TYPE,
  VNEXT_CV_RISK_APPLICABILITIES,
  VNEXT_CV_SCHEMA_VERSION,
  VNEXT_CV_VERDICTS,
  VNEXT_CV_VERIFICATION_TYPES,
} from './types';

const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTEXT_REF_RE = /^\.proofloop\/context\/([a-f0-9]{64})\.json$/;
const RISK_REFERENCE_FIELDS = new Set(['ref_id', 'applicability', 'reason']);

const FAILURE_DETAIL_FIELDS = [
  'failed_acceptance_refs',
  'invalid_tests',
  'counterexamples',
  'scope_violations',
  'forbidden_substitutions',
  'regression_failures',
] as const;

/** The closed v2 CV_RESULT payload field vocabulary (mirrors CV admission). */
const KNOWN_CV_PAYLOAD_FIELDS = new Set([
  'schema_version',
  'type',
  'stage_id',
  'slice_id',
  'worker_receipt_digest',
  'manifest_digest',
  'plan_digest',
  'proof_index_digest',
  'context_ref',
  'context_digest',
  'snapshot_digest',
  'verification_type',
  'verdict',
  'summary',
  'acceptance_refs_checked',
  'seam_refs_checked',
  'oracle_refs_checked',
  'risk_refs_considered',
  ...FAILURE_DETAIL_FIELDS,
  'failed_criterion',
  'failure_signature',
  'required_recheck_scope',
  'previous_failure_signature',
  'repair_diff_digest',
]);

/**
 * The active execution tuple a persisted CV_RESULT payload must bind.
 *
 * This is the same binding set the CV admission seam enforces when a CV
 * verdict is admitted. The `next` consumer applies it to every persisted CV
 * Receipt payload of a Slice, so a self-digest-correct but non-closed CV fact
 * can never become the CV tip a SLICE_COMMIT binds.
 *
 * The optional members (S08-REVIEW-007) are the Manifest/Worker facts the
 * caller has already read: the exact Manifest Slice Proof Index reference
 * sets and the digest of the final Worker Context. When provided, the CV
 * reference arrays must be EXACTLY those sets and the CV context_digest must
 * equal the final Worker Context digest — the same bindings cv-admission
 * enforces, so the shared module is the single truth for both consumers.
 */
export interface VNextCvPayloadBinding {
  readonly stageId: string;
  readonly sliceId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  /** The self-digest of the Slice Worker chain tip (latest TASK_COMPLETE). */
  readonly workerTipDigest: string;
  /** Manifest Slice Proof Index acceptance ref set (exact match when set). */
  readonly expectedAcceptanceRefs?: readonly string[];
  /** Manifest Slice Proof Index seam ref set (exact match when set). */
  readonly expectedSeamRefs?: readonly string[];
  /** Manifest Slice Proof Index oracle ref set (exact match when set). */
  readonly expectedOracleRefs?: readonly string[];
  /** Manifest Slice Proof Index risk ref IDs (exact match when set). */
  readonly expectedRiskRefs?: readonly string[];
  /** Digest of the final completed Worker Context the CV must bind. */
  readonly expectedContextDigest?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function failAdmission(message: string): never {
  throw new VNextHandoffError('admission-invalid', message);
}

function failBinding(message: string): never {
  throw new VNextHandoffError('manifest-binding', message);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    failAdmission(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSha256Digest(value: unknown, label: string): string {
  const digest = requireNonEmptyString(value, label);
  if (!SHA256_RE.test(digest)) {
    failAdmission(`${label} is not a lowercase SHA-256 digest`);
  }
  return digest;
}

function requireSnapshotDigest(value: unknown, label: string): string {
  const digest = requireNonEmptyString(value, label);
  if (!SNAPSHOT_RE.test(digest)) {
    failAdmission(`${label} is not a Git snapshot digest (40 or 64 hexadecimal characters)`);
  }
  return digest;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    failAdmission(`${label} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function requireUniqueNonEmptyStringArray(value: unknown, label: string): string[] {
  const entries = requireStringArray(value, label);
  if (entries.length === 0) {
    failAdmission(`${label} must not be empty`);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) failAdmission(`${label} must not contain duplicate entries`);
    seen.add(entry);
  }
  return entries;
}

/**
 * Unique-but-possibly-empty string array check for the six CV failure-detail
 * arrays (S08-REVIEW-007): cv-admission's `uniqueStringArray` accepts an
 * empty array but rejects duplicate entries; the shared module must apply
 * the same strength. The PASS branch separately requires them to be empty.
 */
function requireUniqueStringArray(value: unknown, label: string): string[] {
  const entries = requireStringArray(value, label);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) failAdmission(`${label} must not contain duplicate entries`);
    seen.add(entry);
  }
  return entries;
}

function requireRiskReferences(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    failAdmission(`${label} must be a non-empty array of risk reference objects`);
  }
  const seen = new Set<string>();
  const refIds: string[] = [];
  value.forEach((item, index) => {
    const itemPath = `${label}[${index}]`;
    if (!isRecord(item)) failAdmission(`${itemPath} must be an object`);
    for (const key of Object.keys(item)) {
      if (!RISK_REFERENCE_FIELDS.has(key)) failAdmission(`${itemPath} contains unknown field "${key}"`);
    }
    const refId = requireNonEmptyString(item.ref_id, `${itemPath}.ref_id`);
    if (seen.has(refId)) failAdmission(`${itemPath}.ref_id risk reference IDs must be unique`);
    seen.add(refId);
    refIds.push(refId);
    const applicability = item.applicability;
    if (
      typeof applicability !== 'string' ||
      !(VNEXT_CV_RISK_APPLICABILITIES as readonly string[]).includes(applicability)
    ) {
      failAdmission(`${itemPath}.applicability is outside the closed vocabulary: ${String(applicability)}`);
    }
    requireNonEmptyString(item.reason, `${itemPath}.reason`);
  });
  return refIds;
}

function requireRiskReferenceIds(value: unknown, label: string): string[] {
  return requireRiskReferences(value, label);
}

/**
 * PASS/REPAIR branch and initial/recheck branch field constraints, mirroring
 * the CV admission branch validation:
 *  - initial must not carry previous_failure_signature / repair_diff_digest;
 *  - recheck requires both previous_failure_signature and repair_diff_digest;
 *  - PASS forbids failed_criterion / failure_signature /
 *    required_recheck_scope and requires the failure-detail arrays to be
 *    empty;
 *  - REPAIR requires failed_criterion / failure_signature /
 *    required_recheck_scope.
 */
function assertCvBranchFields(
  payload: Record<string, unknown>,
  verificationType: string,
  verdict: string,
): void {
  if (verificationType === 'initial') {
    for (const field of ['previous_failure_signature', 'repair_diff_digest']) {
      if (hasOwn(payload, field)) failAdmission(`CV_RESULT initial results must not contain ${field}`);
    }
  } else {
    requireNonEmptyString(payload.previous_failure_signature, 'CV_RESULT.previous_failure_signature');
    requireSha256Digest(payload.repair_diff_digest, 'CV_RESULT.repair_diff_digest');
  }

  if (verdict === 'PASS') {
    for (const field of ['failed_criterion', 'failure_signature', 'required_recheck_scope']) {
      if (hasOwn(payload, field)) failAdmission(`CV_RESULT PASS results must not contain ${field}`);
    }
    for (const field of FAILURE_DETAIL_FIELDS) {
      const entries = payload[field];
      if (Array.isArray(entries) && entries.length > 0) {
        failAdmission(`CV_RESULT PASS results require ${field} to be empty`);
      }
    }
    return;
  }

  requireNonEmptyString(payload.failed_criterion, 'CV_RESULT.failed_criterion');
  requireNonEmptyString(payload.failure_signature, 'CV_RESULT.failure_signature');
  requireUniqueNonEmptyStringArray(payload.required_recheck_scope, 'CV_RESULT.required_recheck_scope');
}

/**
 * Exact Manifest Proof Index reference set validation (S08-REVIEW-007),
 * mirroring cv-admission's `assertReferenceSet`: the CV checked/seam/oracle/
 * risk reference sets must be EXACTLY the Manifest Slice Proof Index sets
 * (same length AND same member set), and every `failed_acceptance_refs`
 * entry must be inside the Manifest acceptance set. This is exported so the
 * CV admission consumer applies the same single-truth binding instead of a
 * hand-written duplicate; `assertClosedVNextCvPayload` applies it whenever
 * the binding carries the expected reference sets.
 */
/** Exact Proof Index reference set binding (the Manifest facts the caller read). */
export interface VNextCvProofIndexBinding {
  readonly acceptanceRefs: readonly string[];
  readonly seamRefs: readonly string[];
  readonly oracleRefs: readonly string[];
  readonly riskRefIds: readonly string[];
}

export function assertVNextCvProofIndexBindings(
  payload: Record<string, unknown>,
  expected: VNextCvProofIndexBinding,
): void {
  const acceptanceRefs = requireUniqueNonEmptyStringArray(
    payload.acceptance_refs_checked,
    'CV_RESULT.acceptance_refs_checked',
  );
  const seamRefs = requireUniqueNonEmptyStringArray(payload.seam_refs_checked, 'CV_RESULT.seam_refs_checked');
  const oracleRefs = requireUniqueNonEmptyStringArray(
    payload.oracle_refs_checked,
    'CV_RESULT.oracle_refs_checked',
  );
  const riskRefIds = requireRiskReferenceIds(payload.risk_refs_considered, 'CV_RESULT.risk_refs_considered');
  if (!sameRefSet(acceptanceRefs, expected.acceptanceRefs)) {
    failAdmission('CV_RESULT.acceptance_refs_checked is not exactly the Manifest Proof Index binding');
  }
  if (!sameRefSet(seamRefs, expected.seamRefs)) {
    failAdmission('CV_RESULT.seam_refs_checked is not exactly the Manifest Proof Index binding');
  }
  if (!sameRefSet(oracleRefs, expected.oracleRefs)) {
    failAdmission('CV_RESULT.oracle_refs_checked is not exactly the Manifest Proof Index binding');
  }
  if (!sameRefSet(riskRefIds, expected.riskRefIds)) {
    failAdmission('CV_RESULT.risk_refs_considered is not exactly the Manifest Proof Index binding');
  }
  const failed = requireUniqueStringArray(payload.failed_acceptance_refs, 'CV_RESULT.failed_acceptance_refs');
  for (const refId of failed) {
    if (!expected.acceptanceRefs.includes(refId)) {
      failAdmission(`CV_RESULT.failed_acceptance_refs contains an out-of-scope ref ${refId}`);
    }
  }
}

function sameRefSet(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    [...new Set(actual)].sort().join('\u0000') === [...new Set(expected)].sort().join('\u0000')
  );
}

/**
 * Closed v2 CV_RESULT payload validation for a persisted CV Receipt.
 *
 * The check covers the full closed field set CV admission enforces:
 * vocabulary (schema/type/verdict/verification_type), stage/slice and
 * Manifest/Plan/Proof Index/Worker-tip tuple bindings, snapshot digest,
 * digest-addressed context_ref/context_digest, non-empty summary, the Proof
 * Index reference arrays (acceptance/seam/oracle/risk), the failure-detail
 * arrays, and the PASS/REPAIR + initial/recheck branch fields. Unknown
 * fields are rejected; nothing is defaulted or guessed.
 *
 * The binding is optional: with no binding this is the pure closed-schema
 * pass (the same check cv-admission applies before reading any fact). When a
 * binding is provided, the stage/slice/digest/Worker-tip tuple AND — when the
 * binding carries them (S08-REVIEW-007) — the exact Manifest Proof Index
 * reference sets and the final Worker Context digest are bound too.
 */
export function assertClosedVNextCvPayload(
  payload: unknown,
  binding?: VNextCvPayloadBinding,
): void {
  if (!isRecord(payload)) {
    failAdmission('CV Receipt payload must be a JSON object');
  }
  for (const key of Object.keys(payload)) {
    if (!KNOWN_CV_PAYLOAD_FIELDS.has(key)) {
      failAdmission(`CV Receipt payload contains unknown field "${key}"`);
    }
  }
  if (payload.schema_version !== VNEXT_CV_SCHEMA_VERSION) {
    failAdmission(
      `CV Receipt payload is not the closed v2 CV_RESULT schema (schema_version must be ${VNEXT_CV_SCHEMA_VERSION})`,
    );
  }
  if (payload.type !== VNEXT_CV_RESULT_TYPE) {
    failAdmission(
      `CV Receipt payload is not the closed v2 CV_RESULT fact (type must be ${VNEXT_CV_RESULT_TYPE})`,
    );
  }
  const verdict = payload.verdict;
  if (typeof verdict !== 'string' || !(VNEXT_CV_VERDICTS as readonly string[]).includes(verdict)) {
    failAdmission(`CV Receipt payload verdict is outside the closed vocabulary: ${String(verdict)}`);
  }
  const verificationType = payload.verification_type;
  if (
    typeof verificationType !== 'string' ||
    !(VNEXT_CV_VERIFICATION_TYPES as readonly string[]).includes(verificationType)
  ) {
    failAdmission(
      `CV Receipt payload verification_type is outside the closed vocabulary: ${String(verificationType)}`,
    );
  }
  if (binding !== undefined) {
    if (payload.stage_id !== binding.stageId || payload.slice_id !== binding.sliceId) {
      failBinding('CV Receipt payload stage/slice binding is invalid');
    }
  }
  const manifestDigest = requireSha256Digest(payload.manifest_digest, 'CV_RESULT.manifest_digest');
  const planDigest = requireSha256Digest(payload.plan_digest, 'CV_RESULT.plan_digest');
  const proofIndexDigest = requireSha256Digest(payload.proof_index_digest, 'CV_RESULT.proof_index_digest');
  const workerReceiptDigest = requireSha256Digest(
    payload.worker_receipt_digest,
    'CV_RESULT.worker_receipt_digest',
  );
  const contextDigest = requireSha256Digest(payload.context_digest, 'CV_RESULT.context_digest');
  requireSnapshotDigest(payload.snapshot_digest, 'CV_RESULT.snapshot_digest');
  if (
    binding !== undefined &&
    (manifestDigest !== binding.manifestDigest ||
      planDigest !== binding.planDigest ||
      proofIndexDigest !== binding.proofIndexDigest)
  ) {
    failBinding('CV Receipt payload is stale or not bound to the active Manifest/Plan/Proof Index');
  }
  if (binding !== undefined && workerReceiptDigest !== binding.workerTipDigest) {
    failBinding('CV Receipt payload worker_receipt_digest is not bound to the Slice Worker chain tip');
  }
  // context_ref must be digest-addressed by context_digest.
  const contextRef = requireNonEmptyString(payload.context_ref, 'CV_RESULT.context_ref');
  const match = CONTEXT_REF_RE.exec(contextRef);
  if (match === null) {
    failAdmission('CV_RESULT.context_ref must match .proofloop/context/<context_digest>.json');
  }
  if (match[1] !== contextDigest) {
    failAdmission('CV_RESULT.context_ref must be digest-addressed by context_digest');
  }
  // S08-REVIEW-007: the CV must bind the FINAL Worker Context — the digest
  // the caller read from the latest TASK_COMPLETE fact of the Slice. A
  // context_ref/context_digest that is self-digest-correct but points at a
  // nonexistent or earlier Context never binds (the exact-match binding).
  if (binding !== undefined && binding.expectedContextDigest !== undefined) {
    if (contextDigest !== binding.expectedContextDigest) {
      failBinding('CV_RESULT context_digest is not bound to the final Worker Context');
    }
  }
  requireNonEmptyString(payload.summary, 'CV_RESULT.summary');
  requireUniqueNonEmptyStringArray(payload.acceptance_refs_checked, 'CV_RESULT.acceptance_refs_checked');
  requireUniqueNonEmptyStringArray(payload.seam_refs_checked, 'CV_RESULT.seam_refs_checked');
  requireUniqueNonEmptyStringArray(payload.oracle_refs_checked, 'CV_RESULT.oracle_refs_checked');
  requireRiskReferences(payload.risk_refs_considered, 'CV_RESULT.risk_refs_considered');
  // S08-REVIEW-007: the six failure-detail arrays apply cv-admission's
  // uniqueStringArray strength (duplicate entries are rejected; empty arrays
  // stay legal for PASS). The PASS branch requires them to be empty.
  const failedAcceptanceRefs = requireUniqueStringArray(
    payload.failed_acceptance_refs,
    'CV_RESULT.failed_acceptance_refs',
  );
  requireUniqueStringArray(payload.invalid_tests, 'CV_RESULT.invalid_tests');
  requireUniqueStringArray(payload.counterexamples, 'CV_RESULT.counterexamples');
  requireUniqueStringArray(payload.scope_violations, 'CV_RESULT.scope_violations');
  requireUniqueStringArray(payload.forbidden_substitutions, 'CV_RESULT.forbidden_substitutions');
  requireUniqueStringArray(payload.regression_failures, 'CV_RESULT.regression_failures');
  // failed_acceptance_refs must be a subset of the declared acceptance refs
  // (payload-internal consistency; the exact Manifest binding is applied
  // below whenever the binding carries the expected sets).
  for (const refId of failedAcceptanceRefs) {
    if (!(payload.acceptance_refs_checked as readonly string[]).includes(refId)) {
      failAdmission(`CV_RESULT.failed_acceptance_refs contains an out-of-scope ref ${refId}`);
    }
  }
  // S08-REVIEW-007: when the caller supplies the Manifest Slice Proof Index
  // sets, the checked/considered arrays must be EXACTLY those sets and the
  // failure refs must stay inside the Manifest acceptance set — the same
  // binding cv-admission's assertCvProofBindings enforces.
  if (
    binding !== undefined &&
    (binding.expectedAcceptanceRefs !== undefined ||
      binding.expectedSeamRefs !== undefined ||
      binding.expectedOracleRefs !== undefined ||
      binding.expectedRiskRefs !== undefined)
  ) {
    assertVNextCvProofIndexBindings(payload, {
      acceptanceRefs: binding.expectedAcceptanceRefs ?? [],
      seamRefs: binding.expectedSeamRefs ?? [],
      oracleRefs: binding.expectedOracleRefs ?? [],
      riskRefIds: binding.expectedRiskRefs ?? [],
    });
  }
  assertCvBranchFields(payload, verificationType, verdict);
}

/**
 * Outer Receipt type ↔ payload verdict agreement: a CV_PASS Receipt must
 * carry a PASS verdict and a CV_REPAIR Receipt a REPAIR verdict. A
 * self-digest-correct Receipt whose discriminator contradicts its payload
 * can never be a legal CV chain member.
 */
export function assertVNextCvReceiptTypeVerdict(
  receiptType: string,
  payload: unknown,
): void {
  if (!isRecord(payload)) {
    failAdmission('CV Receipt payload must be a JSON object');
  }
  const verdict = payload.verdict;
  const expectedType = verdict === 'PASS' ? 'CV_PASS' : verdict === 'REPAIR' ? 'CV_REPAIR' : undefined;
  if (receiptType !== expectedType) {
    failAdmission(
      `CV Receipt type ${receiptType} does not match the payload verdict ${String(verdict)}`,
    );
  }
}

/**
 * Legal CV chain sequence validation, mirroring the CV admission transition
 * rules:
 *  - the chain genesis must be an `initial` verification (an initial CV
 *    admission exists only once per Slice);
 *  - every later member must be a `recheck` whose immediately preceding fact
 *    is a CV_REPAIR;
 *  - a recheck's previous_failure_signature must exactly equal the failure
 *    signature of the preceding CV_REPAIR fact;
 *  - nothing may follow a CV_PASS fact (a PASS closes the Slice CV chain).
 *
 * S08-REVIEW-007 — Worker predecessor de-duplication, aligned with CV
 * admission's `duplicatePredecessor` guard: a Worker repair does not produce
 * a new Worker Receipt, so the legal REPAIR → recheck successor rebinds the
 * SAME Worker tip as the preceding CV_REPAIR. Any other reuse of an already
 * bound Worker tip (a second initial, or a recheck that is not the direct
 * successor of the REPAIR that bound the tip) is illegal and fails closed.
 */
export function assertVNextCvChainSequence(
  receipts: readonly { readonly type: string; readonly payload: unknown }[],
): void {
  if (receipts.length === 0) return;
  const payloads = receipts.map((receipt) => {
    if (!isRecord(receipt.payload)) {
      failAdmission('CV Receipt payload must be a JSON object');
    }
    return receipt.payload as Record<string, unknown>;
  });
  const seenWorkerTips = new Set<string>();
  for (const [index, payload] of payloads.entries()) {
    const workerTip = payload.worker_receipt_digest;
    if (typeof workerTip === 'string' && seenWorkerTips.has(workerTip)) {
      const previous = payloads[index - 1];
      const legalReuse =
        index > 0 &&
        previous.worker_receipt_digest === workerTip &&
        previous.verdict === 'REPAIR' &&
        payload.verification_type === 'recheck';
      if (!legalReuse) {
        failAdmission(
          'CV chain reuses a Worker Receipt tip that is not the legal REPAIR→recheck successor',
        );
      }
    }
    if (typeof workerTip === 'string') seenWorkerTips.add(workerTip);
    if (index === 0) {
      if (payload.verification_type !== 'initial') {
        failAdmission('CV chain genesis must be an initial CV verification');
      }
    } else {
      if (payload.verification_type !== 'recheck') {
        failAdmission(
          'CV chain members after the genesis must be recheck verifications (an initial CV admission is already present)',
        );
      }
      const previous = payloads[index - 1];
      if (previous.verdict !== 'REPAIR') {
        failAdmission('CV recheck requires a preceding CV_REPAIR fact');
      }
      if (payload.previous_failure_signature !== previous.failure_signature) {
        failAdmission('CV recheck previous_failure_signature does not match the preceding CV_REPAIR fact');
      }
    }
  }
  // A CV_PASS fact closes the Slice CV chain: nothing may follow it. Any
  // non-terminal PASS is already rejected by the member rules above (the
  // member after a PASS would have to be a recheck, and a recheck requires a
  // preceding CV_REPAIR); this explicit pass keeps the terminal rule visible.
  for (const [index, payload] of payloads.entries()) {
    if (payload.verdict === 'PASS' && index < receipts.length - 1) {
      failAdmission('CV chain cannot continue after a CV_PASS fact');
    }
  }
}
