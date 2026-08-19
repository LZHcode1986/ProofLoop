/**
 * @proofloop/kernel — vNext three-level binding fingerprint oracle (S12-B).
 *
 * THE single canonical oracle for the S12 binding contract (§8.1/§8.2 of
 * tech-spec/contract-state-matrix.md, §10.2 of ai-coding-architecture.md):
 *
 * - computeStageContractDigest(plan, referenceIndex)  → stage_contract_digest
 * - computeSliceContractDigest(manifest, sliceId)     → slice_contract_digest
 * - computeExecutionBindingDigest(input)              → execution_binding_digest
 *
 * Every projection is a CLOSED field list (§8.2); unknown fields, unknown
 * refs, missing lookups and malformed digests fail closed. The digest field
 * itself is never part of its own projection. All digest computation lives
 * HERE — compiler / admission / next must never re-implement hash logic or
 * accept caller-supplied digests as computation.
 *
 * Isolation invariant (§8.6): the stage projection contains NO slice content
 * and each slice projection contains ONLY its own proof-index task scopes and
 * reference closure — changing Slice C content cannot change the stage
 * contract or slice contracts A/B.
 */

import {
  VNEXT_BINDING_MODES,
  VNEXT_BINDING_SCHEMA_VERSION,
  VNEXT_EXECUTION_SCOPE_KINDS,
  VNEXT_REFERENCE_KINDS,
} from './types';
import type {
  VNextBindingMode,
  VNextBindingSchemaVersion,
  VNextCanonicalPlan,
  VNextDependencyBinding,
  VNextExecutionBindingInput,
  VNextExecutionBindingProjection,
  VNextManifest,
  VNextManifestSlice,
  VNextProofIndex,
  VNextReferenceBinding,
  VNextReferenceIndex,
  VNextRiskBinding,
  VNextSliceContractProjection,
  VNextStageContractProjection,
  VNextTaskScope,
} from './types';
import { canonicalJson, computeDigest } from './canonical';
import { canonicalizeStageNodeProjection, findStageNode } from './plan';
import { validateReferenceDescriptorInto } from './reference';
import { SchemaValidationError } from '../validators';
import {
  collectErrors,
  checkUnknownFields,
  expectArray,
  expectNonEmptyString,
  expectObject,
  expectSha256Hex,
  expectStringArray,
  type FieldError,
} from './internal';

// ============================================================
// Closed field lists
// ============================================================

const STAGE_CONTRACT_PROJECTION_KNOWN_FIELDS = new Set([
  'binding_schema_version',
  'stage_id',
  'stage_node',
  'stage_reference_bindings',
]);

const STAGE_NODE_PROJECTION_KNOWN_FIELDS = new Set([
  'id',
  'kind',
  'goal',
  'refs',
  'dependencies',
  'required_skills',
]);

const SLICE_CONTRACT_PROJECTION_KNOWN_FIELDS = new Set([
  'binding_schema_version',
  'stage_id',
  'slice_id',
  'proof_index',
  'required_skills',
  'depends_on',
  'evidence_path',
  'task_scopes',
  'reference_bindings',
]);

// Mirrors the Proof Index closed field set (proof-index.ts) — the projection
// validator re-checks closure so the digest never absorbs unknown fields.
const PROOF_INDEX_KNOWN_FIELDS = new Set([
  'slice_id',
  'goal_ref',
  'task_refs',
  'acceptance_refs',
  'seam_refs',
  'oracle_refs',
  'risk_refs',
]);

const RISK_BINDING_KNOWN_FIELDS = new Set([
  'ref_id',
  'applies_to_acceptance_refs',
  'applies_to_seam_refs',
]);

const TASK_SCOPE_KNOWN_FIELDS = new Set(['task_ref', 'execution_scope']);

const EXECUTION_SCOPE_KNOWN_FIELDS = new Set([
  'kind',
  'code_paths',
  'test_paths',
  'forbidden_paths',
]);

const REFERENCE_BINDING_KNOWN_FIELDS = new Set([
  'kind',
  'ref_id',
  'file_digest',
  'section_digest',
]);

const DEPENDENCY_BINDING_KNOWN_FIELDS = new Set([
  'slice_id',
  'slice_contract_digest',
  'integration_receipt_digest',
  'integration_head_sha',
]);

const EXECUTION_BINDING_PROJECTION_KNOWN_FIELDS = new Set([
  'binding_schema_version',
  'stage_id',
  'slice_id',
  'stage_contract_digest',
  'slice_contract_digest',
  'dependency_bindings',
  'base_snapshot_digest',
]);

/** Inputs of computeExecutionBindingDigest (projection minus the constant). */
const EXECUTION_BINDING_INPUT_KNOWN_FIELDS = new Set([
  'stage_id',
  'slice_id',
  'stage_contract_digest',
  'slice_contract_digest',
  'dependency_bindings',
  'base_snapshot_digest',
]);

// ============================================================
// Closed INPUT field lists (strict mode, §8.2)
// ============================================================
// Round 2 closed the reference descriptors; these extend strict-mode
// whitelisting to the raw plan / stage node / manifest / slice objects so
// unknown fields fail closed instead of being silently dropped while
// extracting the projection.

/** Raw Canonical Plan top-level closed fields. */
const PLAN_INPUT_KNOWN_FIELDS = new Set(['schema_version', 'items']);

/** Raw Plan stage node closed fields (mirrors plan.ts PLAN_ITEM_KNOWN_FIELDS). */
const STAGE_NODE_INPUT_KNOWN_FIELDS = new Set([
  'id',
  'kind',
  'goal',
  'refs',
  'dependencies',
  'required_skills',
  'execution_scope',
  'checkbox',
  'status',
  'cv_status',
]);

/** Raw Manifest top-level closed fields (mirrors manifest.ts MANIFEST_KNOWN_FIELDS). */
const MANIFEST_INPUT_KNOWN_FIELDS = new Set([
  'version',
  'stage_id',
  'plan',
  'reference_index',
  'authority_ref_ids',
  'binding',
  'task_scopes',
  'slices',
  'runtime_proof',
  'compiled_by',
]);

/** Raw Manifest slice object closed fields (mirrors manifest.ts SLICE_KNOWN_FIELDS). */
const SLICE_INPUT_KNOWN_FIELDS = new Set([
  'slice_id',
  'proof_index',
  'required_skills',
  'depends_on',
  'evidence_path',
  'slice_contract_digest',
]);

/** Git commit sha shape (canonical 40-hex, git-source.ts convention). */
const GIT_SHA_RE = /^[a-f0-9]{40}$/;

/**
 * Snapshot digest shape: canonical Git HEAD digest (40 hex) or a SHA-256
 * digest (64 hex) — the same convention as the Runtime snapshot seams.
 */
const SNAPSHOT_DIGEST_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

// ============================================================
// Closed binding validators
// ============================================================

/**
 * Validate the binding schema version (only `1` is admitted, §8.1/§8.2).
 * Pushes errors into the shared list.
 */
export function validateBindingSchemaVersionInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): VNextBindingSchemaVersion | undefined {
  if (value !== VNEXT_BINDING_SCHEMA_VERSION) {
    errors.push({
      path,
      message: `Expected binding schema version ${VNEXT_BINDING_SCHEMA_VERSION}, got ${JSON.stringify(value)}`,
    });
    return undefined;
  }
  return VNEXT_BINDING_SCHEMA_VERSION;
}

/**
 * Validate the binding mode against the closed set (only `slice-local` is
 * admitted, §8.1). Pushes errors into the shared list.
 */
export function validateBindingModeInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): VNextBindingMode | undefined {
  if (
    typeof value !== 'string' ||
    !(VNEXT_BINDING_MODES as readonly string[]).includes(value)
  ) {
    errors.push({
      path,
      message: `Expected one of: ${VNEXT_BINDING_MODES.map((m) => JSON.stringify(m)).join(', ')}`,
    });
    return undefined;
  }
  return value as VNextBindingMode;
}

/**
 * Fail-closed validation of the binding schema version.
 *
 * @throws {SchemaValidationError} unless `value === 1`.
 */
export function validateBindingSchemaVersion(value: unknown): VNextBindingSchemaVersion {
  return collectErrors('VNextBindingSchemaVersion', (errors) =>
    validateBindingSchemaVersionInto(value, 'binding_schema_version', errors),
  ) as VNextBindingSchemaVersion;
}

/**
 * Fail-closed validation of the binding mode.
 *
 * @throws {SchemaValidationError} unless `value === "slice-local"`.
 */
export function validateBindingMode(value: unknown): VNextBindingMode {
  return collectErrors('VNextBindingMode', (errors) =>
    validateBindingModeInto(value, 'binding_mode', errors),
  ) as VNextBindingMode;
}

/**
 * Validate one resolved reference binding ({kind, ref_id, file_digest,
 * section_digest}). Pushes errors into the shared list.
 */
export function validateReferenceBindingInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): VNextReferenceBinding | undefined {
  const obj = expectObject(value, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, REFERENCE_BINDING_KNOWN_FIELDS, path, errors);

  const kind = obj.kind;
  if (
    typeof kind !== 'string' ||
    !(VNEXT_REFERENCE_KINDS as readonly string[]).includes(kind)
  ) {
    errors.push({
      path: `${path}.kind`,
      message: `Expected one of: ${VNEXT_REFERENCE_KINDS.map((k) => JSON.stringify(k)).join(', ')}`,
    });
  }

  expectNonEmptyString(obj.ref_id, `${path}.ref_id`, errors);
  expectSha256Hex(obj.file_digest, `${path}.file_digest`, errors);
  expectSha256Hex(obj.section_digest, `${path}.section_digest`, errors);

  return obj as unknown as VNextReferenceBinding;
}

/**
 * Fail-closed validation of one resolved reference binding.
 *
 * @throws {SchemaValidationError} on any violation.
 */
export function validateReferenceBinding(value: unknown): VNextReferenceBinding {
  return collectErrors('VNextReferenceBinding', (errors) =>
    validateReferenceBindingInto(value, 'reference_binding', errors),
  ) as VNextReferenceBinding;
}

/**
 * Validate one dependency binding entry. Pushes errors into the shared list.
 */
export function validateDependencyBindingInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): VNextDependencyBinding | undefined {
  const obj = expectObject(value, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, DEPENDENCY_BINDING_KNOWN_FIELDS, path, errors);

  expectNonEmptyString(obj.slice_id, `${path}.slice_id`, errors);
  expectSha256Hex(obj.slice_contract_digest, `${path}.slice_contract_digest`, errors);
  expectSha256Hex(obj.integration_receipt_digest, `${path}.integration_receipt_digest`, errors);
  if (typeof obj.integration_head_sha !== 'string' || !GIT_SHA_RE.test(obj.integration_head_sha)) {
    errors.push({
      path: `${path}.integration_head_sha`,
      message: 'Expected 40-char lowercase hex git commit sha',
    });
  }

  return obj as unknown as VNextDependencyBinding;
}

/**
 * Fail-closed validation of one dependency binding entry.
 *
 * @throws {SchemaValidationError} on any violation.
 */
export function validateDependencyBinding(value: unknown): VNextDependencyBinding {
  return collectErrors('VNextDependencyBinding', (errors) =>
    validateDependencyBindingInto(value, 'dependency_binding', errors),
  ) as VNextDependencyBinding;
}

// ============================================================
// Projection closed-field validation
// ============================================================

/**
 * Validate a stage contract projection (closed field list, §8.2).
 * Pushes errors into the shared list.
 */
export function validateStageContractProjectionInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  const obj = expectObject(value, path, errors);
  if (!obj) return;

  checkUnknownFields(obj, STAGE_CONTRACT_PROJECTION_KNOWN_FIELDS, path, errors);

  validateBindingSchemaVersionInto(obj.binding_schema_version, `${path}.binding_schema_version`, errors);
  expectNonEmptyString(obj.stage_id, `${path}.stage_id`, errors);

  const node = expectObject(obj.stage_node, `${path}.stage_node`, errors);
  if (node) {
    checkUnknownFields(node, STAGE_NODE_PROJECTION_KNOWN_FIELDS, `${path}.stage_node`, errors);
    expectNonEmptyString(node.id, `${path}.stage_node.id`, errors);
    if (node.kind !== 'stage') {
      errors.push({
        path: `${path}.stage_node.kind`,
        message: 'Expected stage node kind "stage"',
      });
    }
    expectNonEmptyString(node.goal, `${path}.stage_node.goal`, errors);
    expectStringArray(node.refs, `${path}.stage_node.refs`, errors);
    expectStringArray(node.dependencies, `${path}.stage_node.dependencies`, errors);
    expectStringArray(node.required_skills, `${path}.stage_node.required_skills`, errors);
  }

  validateReferenceBindingArrayInto(obj.stage_reference_bindings, `${path}.stage_reference_bindings`, errors);
}

/**
 * Validate a slice contract projection (closed field list, §8.2).
 * Pushes errors into the shared list.
 */
export function validateSliceContractProjectionInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  const obj = expectObject(value, path, errors);
  if (!obj) return;

  checkUnknownFields(obj, SLICE_CONTRACT_PROJECTION_KNOWN_FIELDS, path, errors);

  validateBindingSchemaVersionInto(obj.binding_schema_version, `${path}.binding_schema_version`, errors);
  expectNonEmptyString(obj.stage_id, `${path}.stage_id`, errors);
  expectNonEmptyString(obj.slice_id, `${path}.slice_id`, errors);

  validateProofIndexProjectionInto(obj.proof_index, `${path}.proof_index`, errors);

  expectStringArray(obj.required_skills, `${path}.required_skills`, errors);
  expectStringArray(obj.depends_on, `${path}.depends_on`, errors);
  expectNonEmptyString(obj.evidence_path, `${path}.evidence_path`, errors);

  const taskScopes = expectObject(obj.task_scopes, `${path}.task_scopes`, errors);
  if (taskScopes) {
    for (const taskId of Object.keys(taskScopes)) {
      validateTaskScopeProjectionInto(taskScopes[taskId], `${path}.task_scopes.${taskId}`, errors);
    }
  }

  validateReferenceBindingArrayInto(obj.reference_bindings, `${path}.reference_bindings`, errors);
}

/**
 * Validate an execution binding projection (closed field list, §8.2).
 * Pushes errors into the shared list.
 */
export function validateExecutionBindingProjectionInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  const obj = expectObject(value, path, errors);
  if (!obj) return;

  checkUnknownFields(obj, EXECUTION_BINDING_PROJECTION_KNOWN_FIELDS, path, errors);

  validateBindingSchemaVersionInto(obj.binding_schema_version, `${path}.binding_schema_version`, errors);
  expectNonEmptyString(obj.stage_id, `${path}.stage_id`, errors);
  expectNonEmptyString(obj.slice_id, `${path}.slice_id`, errors);
  expectSha256Hex(obj.stage_contract_digest, `${path}.stage_contract_digest`, errors);
  expectSha256Hex(obj.slice_contract_digest, `${path}.slice_contract_digest`, errors);

  const deps = expectArray(obj.dependency_bindings, `${path}.dependency_bindings`, errors);
  if (deps) {
    for (let i = 0; i < deps.length; i++) {
      validateDependencyBindingInto(deps[i], `${path}.dependency_bindings[${i}]`, errors);
    }
  }

  if (typeof obj.base_snapshot_digest !== 'string' || !SNAPSHOT_DIGEST_RE.test(obj.base_snapshot_digest)) {
    errors.push({
      path: `${path}.base_snapshot_digest`,
      message: 'Expected 40- or 64-char lowercase hex snapshot digest',
    });
  }
}

function validateReferenceBindingArrayInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  const arr = expectArray(value, path, errors);
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    validateReferenceBindingInto(arr[i], `${path}[${i}]`, errors);
  }
}

function validateProofIndexProjectionInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  const obj = expectObject(value, path, errors);
  if (!obj) return;

  checkUnknownFields(obj, PROOF_INDEX_KNOWN_FIELDS, path, errors);

  expectNonEmptyString(obj.slice_id, `${path}.slice_id`, errors);
  expectNonEmptyString(obj.goal_ref, `${path}.goal_ref`, errors);
  expectStringArray(obj.task_refs, `${path}.task_refs`, errors);
  expectStringArray(obj.acceptance_refs, `${path}.acceptance_refs`, errors);
  expectStringArray(obj.seam_refs, `${path}.seam_refs`, errors);
  expectStringArray(obj.oracle_refs, `${path}.oracle_refs`, errors);

  const riskRefs = expectArray(obj.risk_refs, `${path}.risk_refs`, errors);
  if (riskRefs) {
    for (let i = 0; i < riskRefs.length; i++) {
      const risk = expectObject(riskRefs[i], `${path}.risk_refs[${i}]`, errors);
      if (!risk) continue;
      checkUnknownFields(risk, RISK_BINDING_KNOWN_FIELDS, `${path}.risk_refs[${i}]`, errors);
      expectNonEmptyString(risk.ref_id, `${path}.risk_refs[${i}].ref_id`, errors);
      expectStringArray(risk.applies_to_acceptance_refs, `${path}.risk_refs[${i}].applies_to_acceptance_refs`, errors);
      expectStringArray(risk.applies_to_seam_refs, `${path}.risk_refs[${i}].applies_to_seam_refs`, errors);
    }
  }
}

function validateTaskScopeProjectionInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  const obj = expectObject(value, path, errors);
  if (!obj) return;

  checkUnknownFields(obj, TASK_SCOPE_KNOWN_FIELDS, path, errors);

  expectNonEmptyString(obj.task_ref, `${path}.task_ref`, errors);

  const scope = expectObject(obj.execution_scope, `${path}.execution_scope`, errors);
  if (!scope) return;

  checkUnknownFields(scope, EXECUTION_SCOPE_KNOWN_FIELDS, `${path}.execution_scope`, errors);

  const kind = scope.kind;
  if (
    typeof kind !== 'string' ||
    !(VNEXT_EXECUTION_SCOPE_KINDS as readonly string[]).includes(kind)
  ) {
    errors.push({
      path: `${path}.execution_scope.kind`,
      message: `Expected one of: ${VNEXT_EXECUTION_SCOPE_KINDS.map((k) => JSON.stringify(k)).join(', ')}`,
    });
  }

  expectStringArray(scope.code_paths, `${path}.execution_scope.code_paths`, errors);
  expectStringArray(scope.test_paths, `${path}.execution_scope.test_paths`, errors);
  expectStringArray(scope.forbidden_paths, `${path}.execution_scope.forbidden_paths`, errors);
}

/**
 * Fail-closed validation of a stage contract projection.
 *
 * @throws {SchemaValidationError} on any unknown field or malformed value.
 */
export function validateStageContractProjection(value: unknown): VNextStageContractProjection {
  return collectErrors('VNextStageContractProjection', (errors) => {
    validateStageContractProjectionInto(value, 'stage_contract_projection', errors);
    return value;
  }) as VNextStageContractProjection;
}

/**
 * Fail-closed validation of a slice contract projection.
 *
 * @throws {SchemaValidationError} on any unknown field or malformed value.
 */
export function validateSliceContractProjection(value: unknown): VNextSliceContractProjection {
  return collectErrors('VNextSliceContractProjection', (errors) => {
    validateSliceContractProjectionInto(value, 'slice_contract_projection', errors);
    return value;
  }) as VNextSliceContractProjection;
}

/**
 * Fail-closed validation of an execution binding projection.
 *
 * @throws {SchemaValidationError} on any unknown field or malformed value.
 */
export function validateExecutionBindingProjection(value: unknown): VNextExecutionBindingProjection {
  return collectErrors('VNextExecutionBindingProjection', (errors) => {
    validateExecutionBindingProjectionInto(value, 'execution_binding_projection', errors);
    return value;
  }) as VNextExecutionBindingProjection;
}

// ============================================================
// Digest computation (unique oracle)
// ============================================================

/** Extract the entity id of a canonical entity ref (`#/entities/<id>`). */
function entityIdFromRef(ref: string): string | undefined {
  const match = /#\/entities\/([^/]+)$/.exec(ref);
  return match?.[1];
}

function notRegisteredError(refId: string, path: string): SchemaValidationError {
  return new SchemaValidationError(
    `VNextReferenceBinding: ref_id "${refId}" is not registered in reference_index`,
    [{ path, message: `ref_id "${refId}" is not registered in reference_index` }],
  );
}

// ============================================================
// Deterministic array canonicalization (order-independence, §8.2)
// ============================================================
// Every array field of every binding projection is deterministically sorted
// AT PROJECTION CONSTRUCTION TIME (canonicalJson itself is a shared tool and
// intentionally keeps arrays in input order). Sorting is on copies — input
// objects are never mutated. Same elements in ANY input order therefore
// produce the same projection and the same digest.

/** Deterministic copy-sort of a string array (lexicographic). */
function sortStrings(values: string[]): string[] {
  return [...values].sort();
}

/**
 * Deterministic copy-sort of an object array by canonical-JSON serialization
 * of each element (stable: `Array.prototype.sort` is stable in ES2019+).
 */
function sortByCanonicalJson<T>(values: T[]): T[] {
  return [...values].sort((left, right) => {
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Canonicalize one risk binding: applies_to arrays sorted deterministically. */
function canonicalizeRiskBinding(risk: VNextRiskBinding): VNextRiskBinding {
  return {
    ref_id: risk.ref_id,
    applies_to_acceptance_refs: sortStrings(risk.applies_to_acceptance_refs),
    applies_to_seam_refs: sortStrings(risk.applies_to_seam_refs),
  };
}

/** Canonicalize a Proof Index projection copy with every array sorted. */
function canonicalizeProofIndex(proofIndex: VNextProofIndex): VNextProofIndex {
  return {
    slice_id: proofIndex.slice_id,
    goal_ref: proofIndex.goal_ref,
    task_refs: sortStrings(proofIndex.task_refs),
    acceptance_refs: sortStrings(proofIndex.acceptance_refs),
    seam_refs: sortStrings(proofIndex.seam_refs),
    oracle_refs: sortStrings(proofIndex.oracle_refs),
    risk_refs: sortByCanonicalJson(proofIndex.risk_refs.map(canonicalizeRiskBinding)),
  };
}

/** Canonicalize one task scope: execution-scope path arrays sorted. */
function canonicalizeTaskScope(scope: VNextTaskScope): VNextTaskScope {
  return {
    task_ref: scope.task_ref,
    execution_scope: {
      kind: scope.execution_scope.kind,
      code_paths: sortStrings(scope.execution_scope.code_paths),
      test_paths: sortStrings(scope.execution_scope.test_paths),
      forbidden_paths: sortStrings(scope.execution_scope.forbidden_paths),
    },
  };
}

/**
 * Resolve ref_ids against the reference_index into closed reference bindings
 * (`{kind, ref_id, file_digest, section_digest}`), preserving the given
 * order. Unknown refs and malformed descriptors fail closed.
 */
function resolveReferenceBindings(
  refIds: string[],
  referenceIndex: VNextReferenceIndex,
): VNextReferenceBinding[] {
  const bindings: VNextReferenceBinding[] = [];
  for (const refId of refIds) {
    const descriptor = referenceIndex[refId];
    if (descriptor === undefined) {
      throw notRegisteredError(refId, 'reference_bindings');
    }
    bindings.push(
      collectErrors('VNextReferenceBinding', (errors) => {
        // Fail closed on the RAW descriptor first: unknown fields, unknown
        // kinds, non-canonical refs and malformed digests must be rejected,
        // never silently dropped while constructing the closed projection
        // binding (§8.2 closed projection semantics).
        const validated = validateReferenceDescriptorInto(
          descriptor,
          `reference_bindings.${refId}`,
          errors,
        );
        if (!validated) return undefined;
        return validateReferenceBindingInto(
          {
            kind: validated.kind,
            ref_id: refId,
            file_digest: validated.file_digest,
            section_digest: validated.section_digest,
          },
          'reference_binding',
          errors,
        );
      }) as VNextReferenceBinding,
    );
  }
  return bindings;
}

/**
 * Collect the ref_ids of a slice's Proof Index reference closure in a
 * deterministic order (goal, tasks, acceptances, seams, oracles, risks),
 * deduplicated.
 */
function collectSliceRefIds(proofIndex: VNextProofIndex): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const push = (refId: string): void => {
    if (!seen.has(refId)) {
      seen.add(refId);
      refs.push(refId);
    }
  };
  push(proofIndex.goal_ref);
  for (const ref of proofIndex.task_refs) push(ref);
  for (const ref of proofIndex.acceptance_refs) push(ref);
  for (const ref of proofIndex.seam_refs) push(ref);
  for (const ref of proofIndex.oracle_refs) push(ref);
  for (const risk of proofIndex.risk_refs) {
    push(risk.ref_id);
    for (const ref of risk.applies_to_acceptance_refs) push(ref);
    for (const ref of risk.applies_to_seam_refs) push(ref);
  }
  return refs;
}

function findSlice(manifest: VNextManifest, sliceId: string): VNextManifestSlice {
  const matches = manifest.slices.filter((slice) => slice.slice_id === sliceId);
  if (matches.length === 0) {
    throw new SchemaValidationError(
      `VNextManifestSlice: slice "${sliceId}" not found in manifest`,
      [{ path: 'slices', message: `slice "${sliceId}" not found in manifest` }],
    );
  }
  if (matches.length > 1) {
    throw new SchemaValidationError(
      `VNextManifestSlice: duplicate slice "${sliceId}" in manifest`,
      [{ path: 'slices', message: `duplicate slice_id "${sliceId}"` }],
    );
  }
  return matches[0];
}

/**
 * Resolve ONLY the task scopes bound by this slice's `proof_index.task_refs`
 * (pass-through entries, so unknown fields fail closed in projection
 * validation). Missing scopes fail closed.
 */
function resolveSliceTaskScopes(
  manifest: VNextManifest,
  slice: VNextManifestSlice,
): Record<string, VNextTaskScope> {
  const scopes: Record<string, VNextTaskScope> = {};
  for (const refId of slice.proof_index.task_refs) {
    const descriptor = manifest.reference_index[refId];
    if (descriptor === undefined) {
      throw notRegisteredError(refId, `task_refs`);
    }
    const taskId = entityIdFromRef(descriptor.ref);
    if (taskId === undefined) {
      throw new SchemaValidationError(
        `VNextTaskScope: cannot derive task id from ref "${descriptor.ref}"`,
        [{ path: `task_scopes.${refId}`, message: `cannot derive task id from ref "${descriptor.ref}"` }],
      );
    }
    const scope = manifest.task_scopes[taskId];
    if (scope === undefined) {
      throw new SchemaValidationError(
        `VNextTaskScope: missing execution scope for task "${taskId}" (${refId})`,
        [{ path: `task_scopes.${taskId}`, message: `Missing execution scope for task "${taskId}" (${refId})` }],
      );
    }
    // Pass the entry through so unknown fields survive into projection
    // validation and fail closed (never silently dropped).
    scopes[taskId] = scope;
  }
  return scopes;
}

/**
 * Compute the Stage contract digest (stage_contract_digest, §8.2).
 *
 * Projection: `{binding_schema_version, stage_id, stage_node,
 * stage_reference_bindings}` — the immutable Plan stage node and the resolved
 * bindings of the stage's DIRECT refs only. Contains NO slice content, so
 * slice edits never change the stage contract.
 *
 * @throws {SchemaValidationError} on a non-object plan / reference_index
 *   input, a missing/duplicate stage node, a missing or non-array
 *   stage.refs (never a native TypeError), a non-object plan item element,
 *   unknown plan / stage-node fields (strict mode), an unregistered stage
 *   ref, a malformed descriptor, or any unknown field in the constructed
 *   projection.
 *
 * Order-independence invariant (§8.2): every array field of the projection
 * (stage_node refs / dependencies / required_skills and the resolved
 * stage_reference_bindings) is deterministically sorted at construction
 * time, so any input ordering yields the same digest.
 */
export function computeStageContractDigest(
  plan: VNextCanonicalPlan,
  referenceIndex: VNextReferenceIndex,
): string {
  const projection = collectErrors('VNextCanonicalPlan', (errors) => {
    // Fail closed on non-object plan / reference_index input and on a
    // malformed stage node (missing / non-array refs, dependencies,
    // required_skills) with a typed SchemaValidationError — never a native
    // TypeError from spreading / iterating raw input.
    const planObj = expectObject(plan, 'plan', errors);
    if (!planObj) return undefined;
    // Strict mode: unknown top-level plan fields fail closed instead of
    // being silently ignored while extracting the stage projection (§8.2).
    checkUnknownFields(planObj, PLAN_INPUT_KNOWN_FIELDS, 'plan', errors);
    const items = expectArray(planObj.items, 'plan.items', errors);
    if (!items) return undefined;
    // Per-element guard: a malformed element (e.g. null) fails closed as a
    // typed SchemaValidationError BEFORE findStageNode iterates it — never a
    // native TypeError from property access on a non-object element.
    const itemsErrorCount = errors.length;
    for (let i = 0; i < items.length; i++) {
      expectObject(items[i], `plan.items[${i}]`, errors);
    }
    if (errors.length > itemsErrorCount) return undefined;
    const indexObj = expectObject(referenceIndex, 'reference_index', errors);
    if (!indexObj) return undefined;

    const stage = findStageNode(plan as VNextCanonicalPlan);

    // Strict mode for the raw stage node object: unknown fields fail closed
    // instead of being silently dropped from the projection (§8.2). Known
    // mutable execution fields (checkbox / status / cv_status) stay allowed
    // and are excluded from the projection by design; execution_scope is
    // only valid on task nodes (mirrors plan.ts validatePlanNode).
    checkUnknownFields(
      stage as unknown as Record<string, unknown>,
      STAGE_NODE_INPUT_KNOWN_FIELDS,
      'plan.items.stage',
      errors,
    );
    if (stage.execution_scope !== undefined) {
      errors.push({
        path: 'plan.items.stage.execution_scope',
        message: 'execution_scope is only allowed on task nodes',
      });
    }

    const refs = expectStringArray(stage.refs, 'plan.items.stage.refs', errors);
    const dependencies = expectStringArray(stage.dependencies, 'plan.items.stage.dependencies', errors);
    const requiredSkills = expectStringArray(stage.required_skills, 'plan.items.stage.required_skills', errors);
    expectNonEmptyString(stage.id, 'plan.items.stage.id', errors);
    expectNonEmptyString(stage.goal, 'plan.items.stage.goal', errors);
    if (refs === undefined || dependencies === undefined || requiredSkills === undefined) {
      return undefined;
    }

    // Deterministic array order: refs are resolved from a sorted copy and
    // the resolved bindings are re-sorted by canonical JSON, so any input
    // ordering of refs / dependencies / required_skills yields the same
    // projection and the same digest (order-independence invariant, §8.2).
    const sortedRefs = sortStrings(refs);
    const projection: VNextStageContractProjection = {
      binding_schema_version: VNEXT_BINDING_SCHEMA_VERSION,
      stage_id: stage.id,
      // canonicalizeStageNodeProjection sorts refs / dependencies /
      // required_skills deterministically (plan.ts).
      stage_node: canonicalizeStageNodeProjection(stage),
      stage_reference_bindings: sortByCanonicalJson(
        resolveReferenceBindings(sortedRefs, referenceIndex as VNextReferenceIndex),
      ),
    };
    validateStageContractProjection(projection);
    return projection;
  }) as VNextStageContractProjection;

  return computeDigest(projection);
}

/**
 * Compute the static contract digest of ONE slice (slice_contract_digest,
 * §8.2).
 *
 * Projection: `{binding_schema_version, stage_id, slice_id, proof_index,
 * required_skills, depends_on, evidence_path, task_scopes (only this slice's
 * proof_index.task_refs), reference_bindings (this slice's reference
 * closure)}`. Other slices' content never participates.
 *
 * @throws {SchemaValidationError} on a non-object manifest input (never a
 *   native TypeError), a non-object slice element, an unknown slice id, an
 *   unregistered ref, a missing task scope, a malformed proof index, unknown
 *   manifest / slice / task-scope fields (strict mode), or any unknown field
 *   in the constructed projection.
 *
 * Order-independence invariant (§8.2): every array field of the projection
 * (proof_index refs, risk applies_to lists, required_skills, depends_on,
 * execution-scope paths, reference_bindings) is deterministically sorted at
 * construction time, so any input ordering yields the same digest.
 */
export function computeSliceContractDigest(
  manifest: VNextManifest,
  sliceId: string,
): string {
  const projection = collectErrors('VNextManifest', (errors) => {
    // Fail closed on non-object manifest input (null / undefined /
    // primitives / arrays) with a typed SchemaValidationError — never a
    // native TypeError from property access on null.
    const obj = expectObject(manifest, 'manifest', errors);
    if (!obj) return undefined;
    // Strict mode: unknown top-level manifest fields fail closed instead of
    // being silently ignored while extracting the slice projection (§8.2).
    checkUnknownFields(obj, MANIFEST_INPUT_KNOWN_FIELDS, 'manifest', errors);

    const slices = expectArray(obj.slices, 'manifest.slices', errors);
    if (!slices) return undefined;
    // Per-element guard: a malformed element (e.g. null) fails closed as a
    // typed SchemaValidationError BEFORE findSlice iterates it — never a
    // native TypeError from property access on a non-object element.
    const slicesErrorCount = errors.length;
    for (let i = 0; i < slices.length; i++) {
      expectObject(slices[i], `manifest.slices[${i}]`, errors);
    }
    if (errors.length > slicesErrorCount) return undefined;
    const indexObj = expectObject(obj.reference_index, 'manifest.reference_index', errors);
    if (!indexObj) return undefined;
    expectNonEmptyString(obj.stage_id, 'manifest.stage_id', errors);
    const taskScopes = expectObject(obj.task_scopes, 'manifest.task_scopes', errors);
    if (!taskScopes) return undefined;

    const slice = findSlice(manifest as VNextManifest, sliceId);

    // Strict mode for the raw slice object: unknown fields fail closed
    // instead of being silently dropped from the projection (§8.2).
    checkUnknownFields(
      slice as unknown as Record<string, unknown>,
      SLICE_INPUT_KNOWN_FIELDS,
      `manifest.slices.${sliceId}`,
      errors,
    );

    const proofIndex = expectObject(slice.proof_index, 'manifest.slices.proof_index', errors);
    if (!proofIndex) return undefined;
    const requiredSkills = expectStringArray(slice.required_skills, `manifest.slices.${sliceId}.required_skills`, errors);
    const dependsOn = expectStringArray(slice.depends_on, `manifest.slices.${sliceId}.depends_on`, errors);
    expectNonEmptyString(slice.evidence_path, `manifest.slices.${sliceId}.evidence_path`, errors);
    if (requiredSkills === undefined || dependsOn === undefined) {
      return undefined;
    }

    // Full shape validation of the raw proof index BEFORE any iteration
    // (resolveSliceTaskScopes / collectSliceRefIds), so missing, non-array
    // or element-malformed ref lists fail closed as SchemaValidationError —
    // never a native TypeError from iterating an undefined / null field.
    const proofIndexErrorCount = errors.length;
    validateProofIndexProjectionInto(slice.proof_index, 'manifest.slices.proof_index', errors);
    if (errors.length > proofIndexErrorCount) return undefined;

    // Resolve ONLY this slice's task scopes and validate the RAW entries
    // (closed fields incl. unknown-field rejection) BEFORE canonicalizing:
    // canonicalization must never silently drop a schema violation.
    const scopes = resolveSliceTaskScopes(manifest as VNextManifest, slice);
    const scopesErrorCount = errors.length;
    for (const taskId of Object.keys(scopes)) {
      validateTaskScopeProjectionInto(scopes[taskId], `manifest.task_scopes.${taskId}`, errors);
    }
    if (errors.length > scopesErrorCount) return undefined;
    const canonicalScopes: Record<string, VNextTaskScope> = {};
    for (const taskId of Object.keys(scopes)) {
      canonicalScopes[taskId] = canonicalizeTaskScope(scopes[taskId]);
    }

    // Deterministic array order: every array field of the projection is
    // sorted at construction time (order-independence invariant, §8.2).
    const canonicalProofIndex = canonicalizeProofIndex(slice.proof_index as VNextProofIndex);
    const projection: VNextSliceContractProjection = {
      binding_schema_version: VNEXT_BINDING_SCHEMA_VERSION,
      stage_id: manifest.stage_id as string,
      slice_id: slice.slice_id,
      proof_index: canonicalProofIndex,
      required_skills: sortStrings(requiredSkills),
      depends_on: sortStrings(dependsOn),
      evidence_path: slice.evidence_path,
      task_scopes: canonicalScopes,
      reference_bindings: sortByCanonicalJson(
        resolveReferenceBindings(
          collectSliceRefIds(canonicalProofIndex),
          manifest.reference_index as VNextReferenceIndex,
        ),
      ),
    };
    validateSliceContractProjection(projection);
    return projection;
  }) as VNextSliceContractProjection;

  return computeDigest(projection);
}

/**
 * Compute the execution-time binding digest (execution_binding_digest, §8.2).
 *
 * Projection: `{binding_schema_version, stage_id, slice_id,
 * stage_contract_digest, slice_contract_digest, dependency_bindings,
 * base_snapshot_digest}`. `dependency_bindings` is deterministically sorted
 * by canonical JSON at construction time, so any input ordering yields the
 * same digest (order-independence invariant, §8.2).
 *
 * @throws {SchemaValidationError} on unknown input fields, missing fields,
 *   malformed digest shapes, or malformed dependency bindings.
 */
export function computeExecutionBindingDigest(input: VNextExecutionBindingInput): string {
  const projection = collectErrors('VNextExecutionBindingInput', (errors) => {
    // Fail closed on non-object inputs (null / undefined / primitives /
    // arrays) with a typed SchemaValidationError — never a native TypeError
    // from Object.keys on null.
    const obj = expectObject(input, 'execution_binding_input', errors);
    if (!obj) return undefined;

    checkUnknownFields(
      obj,
      EXECUTION_BINDING_INPUT_KNOWN_FIELDS,
      'execution_binding_input',
      errors,
    );
    expectNonEmptyString(input.stage_id, 'execution_binding_input.stage_id', errors);
    expectNonEmptyString(input.slice_id, 'execution_binding_input.slice_id', errors);
    expectSha256Hex(input.stage_contract_digest, 'execution_binding_input.stage_contract_digest', errors);
    expectSha256Hex(input.slice_contract_digest, 'execution_binding_input.slice_contract_digest', errors);
    const depsErrorCount = errors.length;
    const deps = expectArray(input.dependency_bindings, 'execution_binding_input.dependency_bindings', errors);
    if (deps) {
      for (let i = 0; i < deps.length; i++) {
        validateDependencyBindingInto(deps[i], `execution_binding_input.dependency_bindings[${i}]`, errors);
      }
    }
    // Short-circuit BEFORE sorting: a missing / non-array / element-malformed
    // dependency_bindings must fail closed as SchemaValidationError and never
    // reach canonicalJson on malformed data (no native TypeError).
    if (deps === undefined || errors.length > depsErrorCount) {
      return undefined;
    }
    if (typeof input.base_snapshot_digest !== 'string' || !SNAPSHOT_DIGEST_RE.test(input.base_snapshot_digest)) {
      errors.push({
        path: 'execution_binding_input.base_snapshot_digest',
        message: 'Expected 40- or 64-char lowercase hex snapshot digest',
      });
    }

    // Deterministic array order: dependency_bindings is sorted by canonical
    // JSON at construction time so input ordering never changes the digest
    // (order-independence invariant, §8.2).
    const projection: VNextExecutionBindingProjection = {
      binding_schema_version: VNEXT_BINDING_SCHEMA_VERSION,
      stage_id: input.stage_id,
      slice_id: input.slice_id,
      stage_contract_digest: input.stage_contract_digest,
      slice_contract_digest: input.slice_contract_digest,
      dependency_bindings: sortByCanonicalJson(deps as VNextDependencyBinding[]),
      base_snapshot_digest: input.base_snapshot_digest,
    };
    validateExecutionBindingProjectionInto(projection, 'execution_binding_projection', errors);
    return projection;
  }) as VNextExecutionBindingProjection;

  return computeDigest(projection);
}
