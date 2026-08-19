/**
 * Shared closed CV_RESULT payload and CV Receipt chain validation
 * (S08-REVIEW-006).
 *
 * This module is deliberately independent of both `./cv-admission` and
 * `./next`: cv-admission already imports `readVNextAdmissionAuthority` from
 * `./next`, so a reverse import would create a direct circular dependency.
 * The `next` execution consumer applies the SAME closed validation strength
 * as CV admission through this module instead of re-implementing a weaker
 * "equivalent" subset. S12-D-T04 (§8.3) extends the shared payload seam to
 * the slice-local (schema_version 3) shape: the same validator discriminates
 * v2 (no binding fields) from v3 (three binding fields required) and never
 * produces a second validation logic; the admission-level schema_version
 * discrimination helper (`credentialSchemaVersionMismatch`) is shared by the
 * Worker/CV/Commit/Integration consumers. Per the S12-D REPLAN, schema_version
 * 3 IS the slice-local credential version: a v3 credential in a slice-local
 * Stage is the legal credential of that Stage (binding fields validated and
 * bound to the Manifest contract digests), while a v2 credential in a
 * slice-local Stage and a v3 credential in a legacy Stage are both
 * BINDING.MODE_MIXED. The exported checks cover:
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
  VNEXT_BINDING_FIELD_EXECUTION_BINDING_DIGEST,
  VNEXT_BINDING_FIELD_SLICE_CONTRACT_DIGEST,
  VNEXT_BINDING_FIELD_STAGE_CONTRACT_DIGEST,
  VNEXT_CREDENTIAL_BINDING_FIELDS,
  VNEXT_CREDENTIAL_SCHEMA_VERSION_LEGACY,
  VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL,
  VNEXT_CREDENTIAL_SCHEMA_VERSION_V2,
  VNEXT_CV_RESULT_TYPE,
  VNEXT_CV_RISK_APPLICABILITIES,
  VNEXT_CV_VERDICTS,
  VNEXT_CV_VERIFICATION_TYPES,
} from './types';
import type { VNextManifest, VNextManifestSlice } from '@proofloop/kernel';
import {
  computeExecutionBindingDigest,
  type VNextDependencyBinding,
} from '@proofloop/kernel/dist/vnext';

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
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
  // S12-D-T04 (§8.3): slice-local binding fields — only admissible on a
  // schema_version 3 payload; a v2 payload carrying any of them is rejected
  // below (never silently ignored).
  VNEXT_BINDING_FIELD_STAGE_CONTRACT_DIGEST,
  VNEXT_BINDING_FIELD_SLICE_CONTRACT_DIGEST,
  VNEXT_BINDING_FIELD_EXECUTION_BINDING_DIGEST,
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
  /**
   * S12-D-T04 (§8.3, S12-D REPLAN): slice-local (schema_version 3) binding
   * expectation. When provided and the payload is a v3 credential, the three
   * binding fields must exactly match the Manifest stage/slice contract
   * digests and the recomputed execution binding digest; a v2 payload
   * carrying any binding field is rejected (never silently ignored).
   */
  readonly sliceLocalBinding?: VNextSliceLocalBindingExpectation;
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
 * S12-D-T04 (§8.3): explicit credential schema_version discrimination for a
 * CV payload. The shared validator understands BOTH the current vNext (2)
 * and the slice-local (3) payload shapes — one validation logic, no second
 * schema. For v3 the three binding fields are required (each a lowercase
 * SHA-256); for v2 the binding fields are forbidden (a v2 payload carrying
 * them would silently smuggle slice-local fields past v2 consumers).
 * Legacy (1), unknown future (>3) and malformed values fail closed with an
 * explicit message.
 */
function assertCredentialSchemaVersion(
  payload: Record<string, unknown>,
  label: string,
): void {
  const schemaVersion = payload.schema_version;
  if (schemaVersion === VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL) {
    for (const field of VNEXT_CREDENTIAL_BINDING_FIELDS) {
      requireSha256Digest(payload[field], `${label}.${field}`);
    }
    return;
  }
  if (schemaVersion === VNEXT_CREDENTIAL_SCHEMA_VERSION_V2) {
    for (const field of VNEXT_CREDENTIAL_BINDING_FIELDS) {
      if (hasOwn(payload, field)) {
        failAdmission(
          `${label} is a v2 credential and must not carry the slice-local binding field "${field}" (schema_version must be ${VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL} for binding fields)`,
        );
      }
    }
    return;
  }
  if (schemaVersion === VNEXT_CREDENTIAL_SCHEMA_VERSION_LEGACY) {
    failAdmission(
      `${label} is a legacy schema_version ${VNEXT_CREDENTIAL_SCHEMA_VERSION_LEGACY} credential; legacy facts cannot be consumed by the vNext consumer`,
    );
  }
  if (
    typeof schemaVersion === 'number' &&
    Number.isInteger(schemaVersion) &&
    schemaVersion > VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL
  ) {
    failAdmission(
      `${label} carries an unknown future schema_version ${schemaVersion} (>${VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL}); explicit fail-closed in every consumer`,
    );
  }
  failAdmission(
    `${label}.schema_version must be ${VNEXT_CREDENTIAL_SCHEMA_VERSION_V2} (current vNext) or ${VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL} (slice-local)`,
  );
}

/**
 * S12-D-T04 (§8.3/§8.4, S12-D REPLAN): admission-level credential
 * schema_version discrimination shared by every vNext admission consumer.
 *
 * A credential (Receipt payload) entering a vNext consumer is rejected when
 * its schema_version is not the mode the consumer admits:
 *  - legacy credential (1) never enters a vNext chain (blocked, unchanged);
 *  - a credential whose mode contradicts the Stage mode (manifest.binding
 *    present vs absent) fails closed with BINDING.MODE_MIXED — including a
 *    v2 (no-binding) credential in a slice-local Stage: every consumer
 *    rejects it, there is no Phase-1 acceptance policy (S12-D repair);
 *  - a slice-local credential (3) in a slice-local Stage is the LEGAL
 *    credential of that Stage (S12-D REPLAN: schema_version 3 = slice-local
 *    credential version; the binding fields are validated and bound by each
 *    consumer through `assertSliceLocalCredentialBindingFields`);
 *  - unknown/future schema_version (>3) fails closed explicitly in every
 *    consumer (BINDING.SCHEMA_FUTURE);
 *  - malformed values fail closed as RUNTIME.SCHEMA_MISMATCH.
 *
 * Returns null when the credential is admissible for the Stage mode.
 */
export type CredentialSchemaMismatchKind =
  | 'LEGACY_BLOCKED'
  | 'SCHEMA_FUTURE'
  | 'MODE_MIXED'
  | 'SCHEMA_UNKNOWN'
  | 'SCHEMA_MALFORMED';

export interface CredentialSchemaMismatch {
  readonly kind: CredentialSchemaMismatchKind;
  readonly code: 'RUNTIME.SCHEMA_MISMATCH' | 'BINDING.SCHEMA_FUTURE' | 'BINDING.MODE_MIXED';
  readonly message: string;
}

export function credentialSchemaVersionMismatch(
  schemaVersion: unknown,
  stageHasBinding: boolean,
  label: string,
): CredentialSchemaMismatch | null {
  if (schemaVersion === VNEXT_CREDENTIAL_SCHEMA_VERSION_V2) {
    if (!stageHasBinding) return null;
    return {
      kind: 'MODE_MIXED',
      code: 'BINDING.MODE_MIXED',
      message:
        `${label} is a v2 (no-binding) credential in a slice-local Stage: the Stage mixes two credential modes (BINDING.MODE_MIXED)`,
    };
  }
  if (schemaVersion === VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL) {
    if (!stageHasBinding) {
      return {
        kind: 'MODE_MIXED',
        code: 'BINDING.MODE_MIXED',
        message:
          `${label} is a slice-local (schema_version ${VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL}) credential in a legacy Stage: the Stage mixes two credential modes (BINDING.MODE_MIXED)`,
      };
    }
    // S12-D REPLAN: schema_version 3 IS the slice-local credential version.
    // A v3 credential in a slice-local Stage is the legal credential of that
    // Stage — the binding fields are validated (64-hex, Manifest contract
    // digest consistency, recomputed execution binding) by every consumer
    // through `assertSliceLocalCredentialBindingFields`.
    return null;
  }
  if (schemaVersion === VNEXT_CREDENTIAL_SCHEMA_VERSION_LEGACY) {
    return {
      kind: 'LEGACY_BLOCKED',
      code: 'RUNTIME.SCHEMA_MISMATCH',
      message:
        `${label} is a legacy schema_version ${VNEXT_CREDENTIAL_SCHEMA_VERSION_LEGACY} credential; legacy facts cannot be mixed into a vNext chain`,
    };
  }
  if (
    typeof schemaVersion === 'number' &&
    Number.isInteger(schemaVersion) &&
    schemaVersion > VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL
  ) {
    return {
      kind: 'SCHEMA_UNKNOWN',
      code: 'BINDING.SCHEMA_FUTURE',
      message:
        `${label} carries an unknown future schema_version ${schemaVersion} (>${VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL}): explicit fail-closed in every consumer (BINDING.SCHEMA_FUTURE)`,
    };
  }
  return {
    kind: 'SCHEMA_MALFORMED',
    code: 'RUNTIME.SCHEMA_MISMATCH',
    message:
      `${label}.schema_version must be ${VNEXT_CREDENTIAL_SCHEMA_VERSION_LEGACY}, ${VNEXT_CREDENTIAL_SCHEMA_VERSION_V2}, or ${VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL}`,
  };
}

/**
 * S12-D-T04 (§8.3): the slice-local binding-field expectation a v3
 * credential must satisfy — the Manifest `binding.stage_contract_digest`, the
 * Slice's `slice_contract_digest` and the execution binding digest recomputed
 * through the kernel bindings.ts oracle (never caller-supplied).
 */
export interface VNextSliceLocalBindingExpectation {
  readonly stageContractDigest: string;
  readonly sliceContractDigest: string;
  readonly executionBindingDigest: string;
}

/**
 * S12-D-T04 (§8.3): shared slice-local binding-field validation for v3
 * credential payloads, applied by EVERY consumer (Worker/CV/Commit/
 * Integration) to every credential it consumes:
 *  - a v2 credential carrying any binding field is rejected (never silently
 *    ignored — the binding fields belong to the v3 shape only);
 *  - a v3 credential must carry the three binding fields as lowercase
 *    SHA-256 digests (same closed rule as `assertCredentialSchemaVersion`);
 *  - when `expected` is provided (slice-local Stage), the three fields must
 *    exactly match the Manifest stage/slice contract digests and the
 *    recomputed execution binding digest.
 */
export function assertSliceLocalCredentialBindingFields(
  payload: Record<string, unknown>,
  label: string,
  expected?: VNextSliceLocalBindingExpectation,
): void {
  if (payload.schema_version === VNEXT_CREDENTIAL_SCHEMA_VERSION_V2) {
    for (const field of VNEXT_CREDENTIAL_BINDING_FIELDS) {
      if (hasOwn(payload, field)) {
        failAdmission(
          `${label} is a v2 credential and must not carry the slice-local binding field "${field}" (schema_version must be ${VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL} for binding fields)`,
        );
      }
    }
    return;
  }
  if (payload.schema_version !== VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL) return;
  for (const field of VNEXT_CREDENTIAL_BINDING_FIELDS) {
    requireSha256Digest(payload[field], `${label}.${field}`);
  }
  if (expected === undefined) return;
  if (payload.stage_contract_digest !== expected.stageContractDigest) {
    failAdmission(`${label}.stage_contract_digest does not match the Manifest slice-local binding`);
  }
  if (payload.slice_contract_digest !== expected.sliceContractDigest) {
    failAdmission(`${label}.slice_contract_digest does not match the Manifest Slice contract`);
  }
  if (payload.execution_binding_digest !== expected.executionBindingDigest) {
    failAdmission(`${label}.execution_binding_digest does not match the recomputed slice-local execution binding`);
  }
}

/**
 * T04b (user authorization) + S12-D repair (v3 historical base snapshot):
 * the slice-local binding expectation a persisted v3 credential must
 * satisfy, computed by the READ-ONLY currentness consumers (`next` /
 * `validate-vnext-stage`) from the Manifest and the credential's own bound
 * facts.
 *
 * The stage/slice contract digests come from the current Manifest (the
 * compiler computed them through the kernel bindings.ts oracle, S12-C); the
 * execution binding digest is recomputed through the same kernel oracle from
 * the receipt-bound dependency bindings and the credential's OWN payload
 * `snapshot_digest` — the HISTORICAL base snapshot the execution binding
 * was computed against at admission (a Worker/CV/Commit credential is
 * admitted at the then-current snapshot, and the INTEGRATION_PASS tuple
 * snapshot equals the admitted SPV snapshot, stable for the whole Stage).
 * The admission consumers keep using `computeSliceLocalBindingExpectation`
 * (worker-admission) which derives dependency bindings from the persisted
 * dependency receipts; this pure helper derives them from the credential's
 * own payload facts (no filesystem or Git I/O, matching this module's
 * contract).
 *
 * S12-D repair (v3 historical base snapshot): the base MUST be the
 * credential's own payload snapshot, never the CURRENT authority snapshot.
 * After an integration commit + fresh SPV the current snapshot legitimately
 * advances while every historical credential of an integrated CURRENT
 * slice stays bound to its own snapshot; recomputing against the current
 * authority snapshot would change the digest and wrongly block RUN_CV for
 * a slice that is integrated and current (FR-020). The execution binding
 * digest is recomputed over the credential's own bound facts, so a v3
 * credential whose execution binding cannot be recomputed from them fails
 * closed — the credential is not self-consistent and can never back a
 * slice-local currentness claim.
 */
export function computeSliceLocalCredentialExpectation(
  manifest: VNextManifest,
  sliceId: string,
  dependencyBindings: readonly VNextDependencyBinding[],
  payload: Record<string, unknown>,
): VNextSliceLocalBindingExpectation {
  // The credential's own tuple snapshot is the execution-binding base
  // snapshot the admission consumer computed against (§8.2): for the
  // INTEGRATION_PASS credential the payload snapshot equals the admitted
  // SPV snapshot, and for Worker/CV/Commit credentials the payload snapshot
  // is the snapshot the credential was admitted at. The historical value
  // stays stable across HEAD advances / fresh SPV passes, so the recompute
  // reproduces the write-side digest (S12-D repair).
  return computeSliceLocalCredentialExpectationForBase(
    manifest,
    sliceId,
    dependencyBindings,
    requireSnapshotDigest(
      payload.snapshot_digest,
      'INTEGRATION_PASS.payload.snapshot_digest',
    ),
    'INTEGRATION_PASS.payload',
  );
}

/**
 * The shared pure recomputation behind {@link computeSliceLocalCredential-
 * Expectation}: the slice-local expectation of a v3 credential whose
 * execution binding was computed by its admission consumer against a given
 * base snapshot. Every read-side consumer MUST pass the credential's OWN
 * payload `snapshot_digest` as the base (the historical value the admission
 * consumer computed against) — NEVER the current authority snapshot: after
 * an integration commit + fresh SPV the current snapshot legitimately
 * advances while the historical credential stays bound to its own
 * snapshot, and a base-snapshot mismatch would wrongly reject an
 * integrated CURRENT slice (FR-020). A tampered credential (wrong
 * stage/slice contract digests or a non-recomputable execution binding)
 * still fails closed.
 */
export function computeSliceLocalCredentialExpectationForBase(
  manifest: VNextManifest,
  sliceId: string,
  dependencyBindings: readonly VNextDependencyBinding[],
  baseSnapshotDigest: string,
  label = 'INTEGRATION_PASS.payload',
): VNextSliceLocalBindingExpectation {
  if (manifest.binding === undefined) {
    failAdmission('slice-local binding expectation requires a Manifest binding');
  }
  const slice = manifest.slices.find((candidate) => candidate.slice_id === sliceId);
  if (slice === undefined) {
    failAdmission(`Manifest does not declare slice ${sliceId}`);
  }
  const stageContractDigest = requireSha256Digest(
    manifest.binding.stage_contract_digest,
    'Manifest binding.stage_contract_digest',
  );
  const sliceContractDigest = requireSha256Digest(
    slice.slice_contract_digest,
    `Manifest slice ${sliceId}.slice_contract_digest`,
  );
  requireSnapshotDigest(baseSnapshotDigest, `${label}.snapshot_digest`);
  let executionBindingDigest: string;
  try {
    executionBindingDigest = computeExecutionBindingDigest({
      stage_id: manifest.stage_id,
      slice_id: sliceId,
      stage_contract_digest: stageContractDigest,
      slice_contract_digest: sliceContractDigest,
      dependency_bindings: [...dependencyBindings],
      base_snapshot_digest: baseSnapshotDigest,
    });
  } catch (error) {
    failAdmission(
      `${label} execution binding could not be recomputed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { stageContractDigest, sliceContractDigest, executionBindingDigest };
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
  assertCredentialSchemaVersion(payload, 'CV_RESULT');
  // S12-D-T04 (§8.3, S12-D REPLAN): when the caller supplies the slice-local
  // binding expectation (slice-local Stage), a v3 CV credential must bind the
  // Manifest contract digests and the recomputed execution binding; a v2
  // credential carrying binding fields was already rejected above.
  if (binding !== undefined && binding.sliceLocalBinding !== undefined) {
    assertSliceLocalCredentialBindingFields(payload, 'CV_RESULT', binding.sliceLocalBinding);
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
 * S12-E REPAIR-FINAL — upstream credential semantic validation.
 *
 * A persisted INTEGRATION_PASS credential is only CURRENT when the upstream
 * fact chain it references (TASK_COMPLETE → CV_PASS → SLICE_COMMIT) EXISTS in
 * its persisted chains (each chain valid) AND every upstream payload carries
 * the complete field semantics.  Digest self-consistency (the receipt's own
 * digest is correct) and outer chain validity are never sufficient: a forged
 * upstream credential that is self-digest-correct but semantically incomplete
 * (missing fields / missing CV PASS / missing SLICE_COMMIT) fails closed.
 * These helpers are shared by every INTEGRATION_PASS chain consumer
 * (evidence-refresh rebind preflight, next slice-local chain read, A8
 * cross-slice boundary helpers).
 */

/**
 * S12-E REPAIR-FINAL round 3 — upstream credential semantic options.
 *
 * The shared upstream semantics are I/O-free; the callers supply the
 * I/O-bound verification callback and the Manifest-derived facts they have
 * already read:
 *  - `verifyContextPersisted` — the context_ref file must EXIST at
 *    `.proofloop/context/<context_digest>.json` and its content digest must
 *    equal context_digest (context 落盘绑定). The callback throws on
 *    failure; a context_ref naming a nonexistent or non-matching file is
 *    never a binding.
 *  - `expectedSliceLocalBinding` — the slice-local binding expectation
 *    (Manifest contract digests + execution binding recomputed through the
 *    kernel oracle) a v3 credential must exactly match (64-hex + 可重算).
 *  - `allowedScope` — the root-relative Manifest scope (task/slice
 *    allowedCodeScope union + evidence/plan projections) the changed_files
 *    must stay inside.
 */
export interface VNextUpstreamSemanticsOptions {
  readonly verifyContextPersisted?: (contextRef: string, contextDigest: string) => void;
  readonly expectedSliceLocalBinding?: VNextSliceLocalBindingExpectation;
  readonly allowedScope?: readonly string[];
  /**
   * S12-E REPAIR-FINAL round 4: whether the Stage is slice-local (the
   * Manifest carries a `binding`).  Required at EVERY upstream credential
   * read point: the schema_version ↔ Stage-mode discrimination runs here
   * so a forged v2 (no-binding) upstream TASK_COMPLETE/CV_PASS/SLICE_COMMIT
   * can never back a slice-local CURRENT chain (BINDING.MODE_MIXED), and a
   * v3 credential in a legacy Stage is MODE_MIXED as well — the same
   * closed rule every admission consumer applies to the credential itself.
   */
  readonly stageHasBinding: boolean;
}

/**
 * S12-E REPAIR-FINAL round 4 — canonical root-relative normalization of one
 * changed-file declaration, mirroring the `rootRelativePath` /
 * `rootRelativeFactPath` semantics (no filesystem I/O, pure lexical form):
 *  - absolute paths, `//`-leading paths, backslashes and NUL bytes are
 *    rejected (never a canonical root-relative path);
 *  - empty and `.` segments are rejected (a canonical root-relative path
 *    never contains them);
 *  - `..` segments are RESOLVED (a trailing `..` chain that would escape the
 *    project root is rejected — the path identity must stay root-bound);
 *  - percent-encoded separators/traversal markers (`..%2F`, `%2e%2e`,
 *    `%252e`) are rejected — an encoded marker must never reach a scope
 *    check as a literal segment.
 *
 * The scope check then runs against the CANONICAL form, so a lexical path
 * like `<allowed-file>/../../outside.ts` — whose canonical form leaves the
 * admitted scope — can no longer bypass the string-prefix test.
 */
function normalizeRootRelativeChangedFile(value: string, label: string): string {
  if (
    value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('\u0000')
  ) {
    failAdmission(`${label} must be a canonical root-relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.')) {
    failAdmission(`${label} must be a canonical root-relative path`);
  }
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (stack.length === 0) {
        failAdmission(`${label} escapes the project root`);
      }
      stack.pop();
      continue;
    }
    if (part.includes('%')) {
      failAdmission(`${label} contains an encoded path separator or traversal marker`);
    }
    stack.push(part);
  }
  return stack.join('/');
}

function requireUpstreamChangedFiles(
  payload: Record<string, unknown>,
  label: string,
  allowedScope: readonly string[] | undefined,
): string[] {
  const rawChangedFiles = requireUniqueNonEmptyStringArray(payload.changed_files, `${label}.changed_files`);
  // S12-E REPAIR-FINAL round 4: canonical root-relative normalization runs
  // BEFORE the Manifest task/slice scope check — a lexical path such as
  // `<allowed-file>/../../outside.ts` satisfies a naive string-prefix scope
  // test while its canonical form leaves the admitted scope.
  const changedFiles = rawChangedFiles.map((file, index) =>
    normalizeRootRelativeChangedFile(file, `${label}.changed_files[${index}]`),
  );
  if (allowedScope === undefined) return changedFiles;
  for (const file of changedFiles) {
    if (!allowedScope.some((base) => file === base || file.startsWith(`${base}/`))) {
      failAdmission(
        `${label}.changed_files declares a file outside the admitted Manifest scope: ${file}`,
      );
    }
  }
  return changedFiles;
}

/**
 * S12-E REPAIR-FINAL round 4 — upstream credential schema_version ↔ Stage
 * mode discrimination plus binding-field validation, applied at EVERY
 * upstream credential read point (TASK_COMPLETE / CV_PASS / SLICE_COMMIT):
 *  - the shared `credentialSchemaVersionMismatch` runs FIRST: in a
 *    slice-local Stage (stageHasBinding) a v2 (no-binding) upstream
 *    credential fails closed as BINDING.MODE_MIXED — a forged v2 chain can
 *    never back a slice-local CURRENT claim; in a legacy Stage a v3
 *    credential is MODE_MIXED too, and legacy/future/malformed versions
 *    fail closed with their explicit codes;
 *  - after the discrimination, a v3 credential must carry the three binding
 *    fields (64-hex always; exact Manifest contract digest match +
 *    recomputed execution binding when the caller supplies the expectation
 *    — 可重算); a v2 credential carrying any binding field is rejected
 *    (never silently ignored).
 */
function assertUpstreamCredentialBindingFields(
  payload: Record<string, unknown>,
  label: string,
  stageHasBinding: boolean,
  expectedSliceLocalBinding: VNextSliceLocalBindingExpectation | undefined,
): void {
  const schemaMismatch = credentialSchemaVersionMismatch(payload.schema_version, stageHasBinding, label);
  if (schemaMismatch !== null) {
    failAdmission(schemaMismatch.message);
  }
  if (payload.schema_version === VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL) {
    assertSliceLocalCredentialBindingFields(payload, label, expectedSliceLocalBinding);
  } else if (payload.schema_version === VNEXT_CREDENTIAL_SCHEMA_VERSION_V2) {
    assertSliceLocalCredentialBindingFields(payload, label);
  }
}

/**
 * TASK_COMPLETE upstream credential semantics: the closed completion
 * vocabulary (mode ∈ {implement-task, recover-task}, outcome=completed), a
 * non-empty changed_files array inside the task/slice Manifest scope, the
 * Manifest-bound evidence_ref, the digest-addressed context binding AND the
 * context 落盘绑定 (the context_ref file exists and its content digest equals
 * context_digest — verified by the I/O-bound caller through
 * `verifyContextPersisted`).  `expectedEvidencePath` (when supplied) binds
 * evidence_ref to the Manifest Slice evidence path.
 */
export function assertUpstreamTaskCompleteSemantics(
  payload: unknown,
  expectedEvidencePath: string | undefined,
  label: string,
  options: VNextUpstreamSemanticsOptions,
): void {
  if (!isRecord(payload)) {
    failAdmission(`${label} payload must be a JSON object`);
  }
  const mode = payload.mode;
  if (mode !== 'implement-task' && mode !== 'recover-task') {
    failAdmission(`${label}.mode is outside the closed completion vocabulary (implement-task|recover-task)`);
  }
  if (payload.outcome !== 'completed') {
    failAdmission(`${label}.outcome must be 'completed'`);
  }
  requireNonEmptyString(payload.task_id, `${label}.task_id`);
  requireUpstreamChangedFiles(payload, label, options?.allowedScope);
  if (expectedEvidencePath !== undefined && payload.evidence_ref !== expectedEvidencePath) {
    failAdmission(`${label}.evidence_ref is not bound to the Manifest Slice evidence path`);
  }
  const contextRef = payload.context_ref;
  const contextDigest = payload.context_digest;
  if (
    typeof contextRef !== 'string' ||
    contextRef.length === 0 ||
    typeof contextDigest !== 'string' ||
    !SHA256_RE.test(contextDigest)
  ) {
    failAdmission(`${label}.context_ref/context_digest are required (context binding)`);
  }
  if (contextRef !== `.proofloop/context/${contextDigest}.json`) {
    failAdmission(`${label}.context_ref is not digest-addressed by context_digest`);
  }
  if (options.verifyContextPersisted !== undefined) {
    options.verifyContextPersisted(contextRef, contextDigest);
  }
  assertUpstreamCredentialBindingFields(payload, label, options.stageHasBinding, options.expectedSliceLocalBinding);
}

/**
 * CV_RESULT upstream credential semantics: only a CV_PASS fact with verdict
 * PASS whose worker_receipt_digest is bound to the Worker chain tip is a
 * CURRENT upstream credential.  A CV_REPAIR — or a PASS missing the tip
 * binding — never backs a CURRENT claim.
 */
export function assertUpstreamCvPassSemantics(
  payload: unknown,
  label: string,
  options: VNextUpstreamSemanticsOptions,
  expectedWorkerTipDigest?: string,
): void {
  if (!isRecord(payload)) {
    failAdmission(`${label} payload must be a JSON object`);
  }
  if (payload.verdict !== 'PASS') {
    failAdmission(`${label}.verdict must be PASS for a CURRENT CV credential`);
  }
  const workerReceiptDigest = payload.worker_receipt_digest;
  if (typeof workerReceiptDigest !== 'string' || !SHA256_RE.test(workerReceiptDigest)) {
    failAdmission(`${label}.worker_receipt_digest is required and must be a SHA-256 digest`);
  }
  if (expectedWorkerTipDigest !== undefined && workerReceiptDigest !== expectedWorkerTipDigest) {
    failAdmission(`${label}.worker_receipt_digest is not bound to the Worker chain tip`);
  }
  assertUpstreamCredentialBindingFields(payload, label, options.stageHasBinding, options.expectedSliceLocalBinding);
}

/**
 * SLICE_COMMIT upstream credential semantics: the commit boundary field must
 * be present and well-formed (Git existence/ancestry is verified by the
 * I/O-bound callers — `commit_sha 真实 Git 祖先`), the changed_files must be
 * non-empty and stay inside the Slice Manifest scope, and a v3 credential
 * must carry the three binding fields.
 */
export function assertUpstreamSliceCommitSemantics(
  payload: unknown,
  label: string,
  options: VNextUpstreamSemanticsOptions,
): void {
  if (!isRecord(payload)) {
    failAdmission(`${label} payload must be a JSON object`);
  }
  const commitSha = payload.commit_sha;
  if (typeof commitSha !== 'string' || !GIT_SHA_RE.test(commitSha)) {
    failAdmission(`${label}.commit_sha is required and must be a Git commit SHA`);
  }
  requireUpstreamChangedFiles(payload, label, options.allowedScope);
  assertUpstreamCredentialBindingFields(payload, label, options.stageHasBinding, options.expectedSliceLocalBinding);
}

/**
 * The ordered Task ids of one Slice (proof_index.task_refs order).
 */
export function vnextTaskIdsForSlice(manifest: VNextManifest, slice: VNextManifestSlice): string[] {
  return slice.proof_index.task_refs.map((refId) => {
    const descriptor = manifest.reference_index[refId];
    const match = descriptor === undefined ? undefined : /#\/entities\/([^/]+)$/.exec(descriptor.ref);
    if (descriptor?.kind !== 'task' || match?.[1] === undefined) {
      failAdmission(`Slice "${slice.slice_id}" contains an invalid vNext task anchor`);
    }
    return match[1];
  });
}

function vnextTaskCodeTestScope(manifest: VNextManifest, taskId: string): string[] {
  const binding = manifest.task_scopes[taskId];
  if (binding === undefined) {
    failAdmission(`Task "${taskId}" has no bound execution scope`);
  }
  const scope = binding.execution_scope;
  if (
    scope.kind !== 'implementation' ||
    scope.code_paths.length === 0 ||
    scope.test_paths.length === 0
  ) {
    failAdmission(`Task "${taskId}" has no non-empty implementation code/test scope`);
  }
  return [...scope.code_paths, ...scope.test_paths];
}

/**
 * S12-E REPAIR-FINAL round 3: the root-relative Manifest allowed scope of
 * ONE Task — its own code/test paths, the code/test paths of every PRIOR
 * task of the same Slice (a later task's TASK_COMPLETE may legitimately
 * carry the uncommitted output of earlier tasks — the same prior-scope
 * extension the admission consumers apply), plus the Slice Evidence and
 * Plan projection paths.
 */
export function vnextTaskAllowedScope(manifest: VNextManifest, sliceId: string, taskId: string): string[] {
  const slice = manifest.slices.find((candidate) => candidate.slice_id === sliceId);
  if (slice === undefined) {
    failAdmission(`Manifest does not declare Slice ${sliceId}`);
  }
  const taskIds = vnextTaskIdsForSlice(manifest, slice);
  const index = taskIds.indexOf(taskId);
  if (index === -1) {
    failAdmission(`Task "${taskId}" is not bound to Slice "${sliceId}"`);
  }
  const prior = taskIds.slice(0, index).flatMap((priorTaskId) => vnextTaskCodeTestScope(manifest, priorTaskId));
  return uniqueValues([...prior, ...vnextTaskCodeTestScope(manifest, taskId), slice.evidence_path, manifest.plan.ref]);
}

/**
 * S12-E REPAIR-FINAL round 3: the root-relative Manifest allowed scope of
 * one Slice — the union of every Task's allowedCodeScope plus the Slice
 * Evidence and Plan projection paths (the A8/upstream changed_files
 * boundary: 该 slice 所有 task 的 allowedCodeScope 并集 + evidence/plan 投影).
 */
export function vnextSliceAllowedScope(manifest: VNextManifest, sliceId: string): string[] {
  const slice = manifest.slices.find((candidate) => candidate.slice_id === sliceId);
  if (slice === undefined) {
    failAdmission(`Manifest does not declare Slice ${sliceId}`);
  }
  const taskIds = vnextTaskIdsForSlice(manifest, slice);
  if (taskIds.length === 0) {
    failAdmission(`Slice "${sliceId}" declares no tasks`);
  }
  return uniqueValues([
    ...taskIds.flatMap((taskId) => vnextTaskCodeTestScope(manifest, taskId)),
    slice.evidence_path,
    manifest.plan.ref,
  ]);
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * S12-E REPAIR-FINAL round 3: the slice-local binding expectation a v3
 * UPSTREAM credential (TASK_COMPLETE / CV_RESULT / SLICE_COMMIT) must
 * exactly match — computed through the kernel oracle over the Slice's
 * receipt-bound dependency bindings and the credential's OWN payload
 * snapshot (the historical base the admission consumer computed against).
 * Returns undefined for a legacy Manifest or a non-v3 credential (the
 * binding fields do not apply to those shapes).
 */
export function vnextUpstreamSliceLocalBindingExpectation(
  manifest: VNextManifest,
  sliceId: string,
  dependencyBindings: readonly VNextDependencyBinding[],
  payload: Record<string, unknown>,
  label: string,
): VNextSliceLocalBindingExpectation | undefined {
  if (
    manifest.binding === undefined ||
    payload.schema_version !== VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL
  ) {
    return undefined;
  }
  return computeSliceLocalCredentialExpectationForBase(
    manifest,
    sliceId,
    dependencyBindings,
    requireSnapshotDigest(payload.snapshot_digest, `${label}.snapshot_digest`),
    label,
  );
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
