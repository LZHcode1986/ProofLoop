/**
 * @proofloop/kernel — vNext Proof Index validator (S0-A, Slice 0.2).
 *
 * Validates the per-slice Proof Index against a resolved reference index
 * (ref_id → kind).
 *
 * Fail-closed invariants:
 * - goal_ref / task_refs / acceptance_refs / seam_refs / oracle_refs must be
 *   non-empty, unique, registered ref_ids with the expected kind;
 * - risk_refs[].ref_id must be a registered ref_id of kind `risk` (unique);
 * - risk binding `applies_to_acceptance_refs` must reference refs listed in
 *   the SAME Proof Index's acceptance_refs (kind=acceptance);
 * - risk binding `applies_to_seam_refs` must reference refs listed in the
 *   SAME Proof Index's seam_refs (kind=seam);
 * - unknown fields are rejected.
 */

import type { VNextReferenceKind } from './types';
import type { VNextProofIndex } from './types';
import {
  collectErrors,
  checkUnknownFields,
  expectArray,
  expectNonEmptyString,
  expectObject,
  type FieldError,
} from './internal';

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

/**
 * Validate a single required ref_id that must be registered with a specific
 * kind. Pushes errors into the shared list.
 */
function checkSingleRef(
  value: unknown,
  expectedKind: VNextReferenceKind,
  path: string,
  errors: FieldError[],
  registered: ReadonlyMap<string, VNextReferenceKind>,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({ path, message: 'Expected non-empty ref_id' });
    return undefined;
  }
  const kind = registered.get(value);
  if (kind === undefined) {
    errors.push({ path, message: `ref_id "${value}" is not registered in reference_index` });
    return undefined;
  }
  if (kind !== expectedKind) {
    errors.push({
      path,
      message: `ref_id "${value}" has kind "${kind}", expected "${expectedKind}"`,
    });
    return undefined;
  }
  return value;
}

/**
 * Validate a list of ref_ids that must each be registered with a specific
 * kind and be unique.
 */
function checkRefList(
  value: unknown,
  expectedKind: VNextReferenceKind,
  path: string,
  errors: FieldError[],
  registered: ReadonlyMap<string, VNextReferenceKind>,
): string[] | undefined {
  const arr = expectArray(value, path, errors);
  if (!arr) return undefined;

  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const sub = `${path}[${i}]`;
    if (typeof item !== 'string' || item.length === 0) {
      errors.push({ path: sub, message: 'Expected non-empty ref_id' });
      continue;
    }
    if (seen.has(item)) {
      errors.push({ path: sub, message: `Duplicate ref_id "${item}"` });
      continue;
    }
    seen.add(item);

    const kind = registered.get(item);
    if (kind === undefined) {
      errors.push({ path: sub, message: `ref_id "${item}" is not registered in reference_index` });
      continue;
    }
    if (kind !== expectedKind) {
      errors.push({
        path: sub,
        message: `ref_id "${item}" has kind "${kind}", expected "${expectedKind}"`,
      });
    }
    result.push(item);
  }
  return result;
}

/**
 * Validate a risk applicability list: every ref must be listed in the SAME
 * Proof Index's `allowed` set and registered with the expected kind.
 */
function checkAppliesTo(
  value: unknown,
  expectedKind: VNextReferenceKind,
  path: string,
  errors: FieldError[],
  allowed: ReadonlySet<string>,
  registered: ReadonlyMap<string, VNextReferenceKind>,
): void {
  const arr = expectArray(value, path, errors);
  if (!arr) return;

  const seen = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const sub = `${path}[${i}]`;
    if (typeof item !== 'string' || item.length === 0) {
      errors.push({ path: sub, message: 'Expected non-empty ref_id' });
      continue;
    }
    if (seen.has(item)) {
      errors.push({ path: sub, message: `Duplicate ref_id "${item}"` });
      continue;
    }
    seen.add(item);

    if (!allowed.has(item)) {
      errors.push({
        path: sub,
        message: `risk binding must reference a "${expectedKind}" ref listed in this Proof Index`,
      });
      continue;
    }
    const kind = registered.get(item);
    if (kind !== expectedKind) {
      errors.push({
        path: sub,
        message: `ref_id "${item}" has kind "${String(kind)}", expected "${expectedKind}"`,
      });
    }
  }
}

function validateRiskBinding(
  value: unknown,
  path: string,
  errors: FieldError[],
  ctx: {
    registered: ReadonlyMap<string, VNextReferenceKind>;
    acceptanceRefs: ReadonlySet<string>;
    seamRefs: ReadonlySet<string>;
    seenRisk: Set<string>;
  },
): void {
  const obj = expectObject(value, path, errors);
  if (!obj) return;

  checkUnknownFields(obj, RISK_BINDING_KNOWN_FIELDS, path, errors);

  const refId = obj.ref_id;
  if (typeof refId !== 'string' || refId.length === 0) {
    errors.push({ path: `${path}.ref_id`, message: 'Expected non-empty ref_id' });
  } else {
    if (ctx.seenRisk.has(refId)) {
      errors.push({ path: `${path}.ref_id`, message: `Duplicate risk ref_id "${refId}"` });
    }
    ctx.seenRisk.add(refId);

    const kind = ctx.registered.get(refId);
    if (kind === undefined) {
      errors.push({ path: `${path}.ref_id`, message: `ref_id "${refId}" is not registered in reference_index` });
    } else if (kind !== 'risk') {
      errors.push({
        path: `${path}.ref_id`,
        message: `ref_id "${refId}" has kind "${kind}", expected "risk"`,
      });
    }
  }

  checkAppliesTo(
    obj.applies_to_acceptance_refs,
    'acceptance',
    `${path}.applies_to_acceptance_refs`,
    errors,
    ctx.acceptanceRefs,
    ctx.registered,
  );
  checkAppliesTo(
    obj.applies_to_seam_refs,
    'seam',
    `${path}.applies_to_seam_refs`,
    errors,
    ctx.seamRefs,
    ctx.registered,
  );
}

/**
 * Validate a Proof Index, pushing errors into the shared list.
 *
 * @param registered — resolved reference index: ref_id → kind. Refs not in
 *   this map are unregistered and fail closed.
 */
export function validateProofIndexInto(
  value: unknown,
  path: string,
  errors: FieldError[],
  registered: ReadonlyMap<string, VNextReferenceKind>,
): VNextProofIndex | undefined {
  const obj = expectObject(value, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, PROOF_INDEX_KNOWN_FIELDS, path, errors);

  expectNonEmptyString(obj.slice_id, `${path}.slice_id`, errors);

  checkSingleRef(obj.goal_ref, 'goal', `${path}.goal_ref`, errors, registered);
  const taskRefs = checkRefList(obj.task_refs, 'task', `${path}.task_refs`, errors, registered);
  const acceptanceRefs = checkRefList(
    obj.acceptance_refs,
    'acceptance',
    `${path}.acceptance_refs`,
    errors,
    registered,
  );
  const seamRefs = checkRefList(obj.seam_refs, 'seam', `${path}.seam_refs`, errors, registered);
  checkRefList(obj.oracle_refs, 'oracle', `${path}.oracle_refs`, errors, registered);

  const riskRefs = expectArray(obj.risk_refs, `${path}.risk_refs`, errors);
  if (riskRefs) {
    const ctx = {
      registered,
      acceptanceRefs: new Set(acceptanceRefs ?? []),
      seamRefs: new Set(seamRefs ?? []),
      seenRisk: new Set<string>(),
    };
    for (let i = 0; i < riskRefs.length; i++) {
      validateRiskBinding(riskRefs[i], `${path}.risk_refs[${i}]`, errors, ctx);
    }
  }

  // slice_id consistency with the owning slice is a Manifest-level invariant
  // (checked in manifest.ts).
  return obj as unknown as VNextProofIndex;
}

/**
 * Fail-closed validation of a Proof Index against a resolved reference index.
 *
 * @param registered — ref_id → kind map from the Manifest reference_index.
 * @throws {SchemaValidationError} on any violation.
 */
export function validateVNextProofIndex(
  value: unknown,
  registered: ReadonlyMap<string, VNextReferenceKind>,
): VNextProofIndex {
  return collectErrors('VNextProofIndex', (errors) =>
    validateProofIndexInto(value, 'proof_index', errors, registered),
  ) as VNextProofIndex;
}
