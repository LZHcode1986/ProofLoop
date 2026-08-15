/**
 * @proofloop/kernel — vNext Manifest validator (S0-A, Schema Cutover).
 *
 * Validates the vNext Manifest (`version: 2`). The explicit version
 * discriminator ensures old v1 Manifests (which carry no `version`, or
 * `version: 1`) are rejected rather than silently interpreted as vNext facts
 * (§9.5 Schema Cutover).
 *
 * Cross-checks:
 * - reference_index descriptors are valid and non-empty;
 * - authority_ref_ids (if present) reference registered ref_ids;
 * - each slice's proof_index refs are registered with the expected kinds and
 *   its risk bindings point at the slice's own acceptance/seam refs;
 * - slice.proof_index.slice_id matches slice.slice_id.
 */

import { VNEXT_SCHEMA_VERSION } from './types';
import type {
  VNextManifest,
  VNextReferenceIndex,
  VNextReferenceKind,
} from './types';
import { VNEXT_REF_GRAMMAR_RE } from './canonical';
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
import { validateReferenceIndexInto } from './reference';
import { validateProofIndexInto } from './proof-index';
import { validateVNextExecutionScopeInto } from './plan';

const MANIFEST_KNOWN_FIELDS = new Set([
  'version',
  'stage_id',
  'plan',
  'reference_index',
  'authority_ref_ids',
  'task_scopes',
  'slices',
  'runtime_proof',
  'compiled_by',
]);

const PLAN_SECTION_KNOWN_FIELDS = new Set([
  'ref',
  'plan_digest',
  'schema_version',
]);

const SLICE_KNOWN_FIELDS = new Set([
  'slice_id',
  'proof_index',
  'required_skills',
  'depends_on',
  'evidence_path',
]);

const RUNTIME_PROOF_KNOWN_FIELDS = new Set([
  'spec_refs',
  'resolved_steps',
  'proof_digest',
]);

const TASK_SCOPE_KNOWN_FIELDS = new Set(['task_ref', 'execution_scope']);

function entityIdFromRef(ref: string): string | undefined {
  const match = /#\/entities\/([^/]+)$/.exec(ref);
  return match?.[1];
}

function validateTaskScopes(
  value: unknown,
  path: string,
  errors: FieldError[],
  referenceIndex: VNextReferenceIndex | undefined,
  rawSlices: unknown[] | undefined,
): void {
  const scopes = expectObject(value, path, errors);
  const expected = new Map<string, string>();

  if (referenceIndex !== undefined && rawSlices !== undefined) {
    for (const rawSlice of rawSlices) {
      if (rawSlice === null || typeof rawSlice !== 'object' || Array.isArray(rawSlice)) continue;
      const proofIndex = (rawSlice as Record<string, unknown>).proof_index;
      if (proofIndex === null || typeof proofIndex !== 'object' || Array.isArray(proofIndex)) continue;
      const taskRefs = (proofIndex as Record<string, unknown>).task_refs;
      if (!Array.isArray(taskRefs)) continue;
      for (const refId of taskRefs) {
        if (typeof refId !== 'string') continue;
        const descriptor = referenceIndex[refId];
        if (descriptor?.kind !== 'task') continue;
        const taskId = entityIdFromRef(descriptor.ref);
        if (taskId !== undefined) expected.set(taskId, descriptor.ref);
      }
    }
  }

  if (scopes === undefined) return;

  for (const taskId of Object.keys(scopes)) {
    const taskPath = `${path}.${taskId}`;
    const entry = expectObject(scopes[taskId], taskPath, errors);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
      errors.push({ path: taskPath, message: 'Task scope key must be a stable task id' });
    }
    if (!entry) continue;

    checkUnknownFields(entry, TASK_SCOPE_KNOWN_FIELDS, taskPath, errors);
    const taskRef = expectNonEmptyString(entry.task_ref, `${taskPath}.task_ref`, errors);
    if (taskRef && !VNEXT_REF_GRAMMAR_RE.test(taskRef)) {
      errors.push({ path: `${taskPath}.task_ref`, message: 'Expected a canonical entity reference' });
    }
    validateVNextExecutionScopeInto(entry.execution_scope, `${taskPath}.execution_scope`, errors);

    const expectedRef = expected.get(taskId);
    if (expectedRef === undefined) {
      errors.push({ path: taskPath, message: `Task scope "${taskId}" is not bound by a Manifest task ref` });
    } else if (taskRef !== undefined && taskRef !== expectedRef) {
      errors.push({ path: `${taskPath}.task_ref`, message: `must equal the registered task ref "${expectedRef}"` });
    }
  }

  for (const [taskId, taskRef] of expected) {
    if (scopes[taskId] === undefined) {
      errors.push({ path, message: `Missing execution scope for task "${taskId}" (${taskRef})` });
    }
  }
}

function validateSlice(
  value: unknown,
  path: string,
  errors: FieldError[],
  registered: ReadonlyMap<string, VNextReferenceKind>,
): void {
  const obj = expectObject(value, path, errors);
  if (!obj) return;

  checkUnknownFields(obj, SLICE_KNOWN_FIELDS, path, errors);

  const sliceId = expectNonEmptyString(obj.slice_id, `${path}.slice_id`, errors);

  const proofIndex = validateProofIndexInto(
    obj.proof_index,
    `${path}.proof_index`,
    errors,
    registered,
  );

  if (sliceId && proofIndex && proofIndex.slice_id !== sliceId) {
    errors.push({
      path: `${path}.proof_index.slice_id`,
      message: `must equal slice.slice_id ("${sliceId}")`,
    });
  }

  expectStringArray(obj.required_skills, `${path}.required_skills`, errors);
  expectStringArray(obj.depends_on, `${path}.depends_on`, errors, { unique: true });
  expectNonEmptyString(obj.evidence_path, `${path}.evidence_path`, errors);
}

function validateRuntimeProof(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  const obj = expectObject(value, path, errors);
  if (!obj) return;

  checkUnknownFields(obj, RUNTIME_PROOF_KNOWN_FIELDS, path, errors);

  // Deep Runtime Proof semantics are S0-B scope; here we only enforce the
  // closed field shape.
  expectStringArray(obj.spec_refs, `${path}.spec_refs`, errors, { unique: true });
  expectArray(obj.resolved_steps, `${path}.resolved_steps`, errors);
  expectSha256Hex(obj.proof_digest, `${path}.proof_digest`, errors);
}

/**
 * Fail-closed validation of a vNext Manifest (`version: 2`).
 *
 * @throws {SchemaValidationError} on any violation, including a wrong or
 *   missing `version` discriminator (old v1 Manifest must not be interpreted
 *   as vNext).
 */
export function validateVNextManifest(value: unknown): VNextManifest {
  return collectErrors('VNextManifest', (errors) => {
    const obj = expectObject(value, 'manifest', errors);
    if (!obj) return undefined;

    checkUnknownFields(obj, MANIFEST_KNOWN_FIELDS, 'manifest', errors);

    if (obj.version !== VNEXT_SCHEMA_VERSION) {
      errors.push({
        path: 'manifest.version',
        message: `Expected ${VNEXT_SCHEMA_VERSION}. v1 Manifest (no version or version 1) must not be interpreted as vNext.`,
      });
    }

    expectNonEmptyString(obj.stage_id, 'manifest.stage_id', errors);

    // plan section: normalized plan reference + plan_digest
    const plan = expectObject(obj.plan, 'manifest.plan', errors);
    if (plan) {
      checkUnknownFields(plan, PLAN_SECTION_KNOWN_FIELDS, 'manifest.plan', errors);
      // plan.ref is a root-relative path, NOT an entity ref (no # fragment).
      expectNonEmptyString(plan.ref, 'manifest.plan.ref', errors);
      expectSha256Hex(plan.plan_digest, 'manifest.plan.plan_digest', errors);
      if (plan.schema_version !== VNEXT_SCHEMA_VERSION) {
        errors.push({
          path: 'manifest.plan.schema_version',
          message: `Expected ${VNEXT_SCHEMA_VERSION}, got ${JSON.stringify(plan.schema_version)}`,
        });
      }
    }

    // reference_index → resolved ref_id → kind map
    const referenceIndex = validateReferenceIndexInto(
      obj.reference_index,
      'manifest.reference_index',
      errors,
    );
    const registered = new Map<string, VNextReferenceKind>();
    if (referenceIndex) {
      for (const key of Object.keys(referenceIndex)) {
        registered.set(key, referenceIndex[key].kind);
      }
    }

    // authority_ref_ids (optional)
    if (obj.authority_ref_ids !== undefined) {
      const auth = expectArray(obj.authority_ref_ids, 'manifest.authority_ref_ids', errors);
      if (auth) {
        const seen = new Set<string>();
        for (let i = 0; i < auth.length; i++) {
          const item = auth[i];
          const sub = `manifest.authority_ref_ids[${i}]`;
          if (typeof item !== 'string' || item.length === 0) {
            errors.push({ path: sub, message: 'Expected non-empty ref_id' });
            continue;
          }
          if (seen.has(item)) {
            errors.push({ path: sub, message: `Duplicate ref_id "${item}"` });
            continue;
          }
          seen.add(item);
          if (!registered.has(item)) {
            errors.push({ path: sub, message: `ref_id "${item}" is not registered in reference_index` });
          }
        }
      }
    }

    // slices
    const slices = expectArray(obj.slices, 'manifest.slices', errors);
    if (slices) {
      for (let i = 0; i < slices.length; i++) {
        validateSlice(slices[i], `manifest.slices[${i}]`, errors, registered);
      }
    }

    // Every task selected by a Proof Index must have an explicit immutable
    // scope binding. There is intentionally no Evidence-only fallback here.
    validateTaskScopes(
      obj.task_scopes,
      'manifest.task_scopes',
      errors,
      referenceIndex,
      slices,
    );

    // runtime_proof (optional)
    if (obj.runtime_proof !== undefined) {
      validateRuntimeProof(obj.runtime_proof, 'manifest.runtime_proof', errors);
    }

    // compiled_by (optional)
    if (obj.compiled_by !== undefined && typeof obj.compiled_by !== 'string') {
      errors.push({ path: 'manifest.compiled_by', message: 'Expected string' });
    }

    return obj as unknown as VNextManifest;
  }) as VNextManifest;
}

/** Re-exported for consumers that need the canonical entity-ref grammar. */
export { VNEXT_REF_GRAMMAR_RE };
