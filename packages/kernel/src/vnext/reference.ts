/**
 * @proofloop/kernel — vNext Reference Index validator (S0-A, Slice 0.2).
 *
 * Validates ReferenceDescriptor values and the `reference_index` object.
 * Fail-closed: unknown fields, empty refs, invalid kinds, non-canonical ref
 * grammar, malformed digest shapes, empty ref_ids, and empty indexes are all
 * rejected.
 */

import { VNEXT_REFERENCE_KINDS } from './types';
import type {
  VNextReferenceDescriptor,
  VNextReferenceIndex,
} from './types';
import { VNEXT_REF_GRAMMAR_RE } from './canonical';
import {
  collectErrors,
  checkUnknownFields,
  expectNonEmptyString,
  expectObject,
  expectSha256Hex,
  type FieldError,
} from './internal';

const DESCRIPTOR_KNOWN_FIELDS = new Set([
  'kind',
  'ref',
  'file_digest',
  'section_digest',
]);

/**
 * Validate a single ReferenceDescriptor, pushing errors into the shared list.
 * The descriptor must NOT carry its own ref_id/id (the object key is the id).
 */
export function validateReferenceDescriptorInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): VNextReferenceDescriptor | undefined {
  const obj = expectObject(value, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, DESCRIPTOR_KNOWN_FIELDS, path, errors);

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

  const ref = expectNonEmptyString(obj.ref, `${path}.ref`, errors);
  if (ref && !VNEXT_REF_GRAMMAR_RE.test(ref)) {
    errors.push({
      path: `${path}.ref`,
      message:
        'Expected canonical entity ref "<path>#/entities/<entity-id>" or "<path>#/<json-pointer>"',
    });
  }

  expectSha256Hex(obj.file_digest, `${path}.file_digest`, errors);
  expectSha256Hex(obj.section_digest, `${path}.section_digest`, errors);

  return obj as unknown as VNextReferenceDescriptor;
}

/**
 * Validate a `reference_index` object (keyed by ref_id), pushing errors into
 * the shared list. Rejects empty ref_id keys and empty indexes.
 */
export function validateReferenceIndexInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): VNextReferenceIndex | undefined {
  const obj = expectObject(value, path, errors);
  if (!obj) return undefined;

  const keys = Object.keys(obj);
  if (keys.length === 0) {
    errors.push({ path, message: 'Must contain at least one registered ref' });
  }

  for (const key of keys) {
    if (key.length === 0) {
      errors.push({ path, message: 'ref_id must be non-empty' });
      continue;
    }
    validateReferenceDescriptorInto(obj[key], `${path}.${key}`, errors);
  }

  return obj as unknown as VNextReferenceIndex;
}

/**
 * Fail-closed validation of a single ReferenceDescriptor.
 *
 * @throws {SchemaValidationError} on any violation.
 */
export function validateVNextReferenceDescriptor(
  value: unknown,
): VNextReferenceDescriptor {
  return collectErrors('VNextReferenceDescriptor', (errors) =>
    validateReferenceDescriptorInto(value, 'reference_descriptor', errors),
  ) as VNextReferenceDescriptor;
}

/**
 * Fail-closed validation of a `reference_index` object.
 *
 * @throws {SchemaValidationError} on any violation.
 */
export function validateVNextReferenceIndex(value: unknown): VNextReferenceIndex {
  return collectErrors('VNextReferenceIndex', (errors) =>
    validateReferenceIndexInto(value, 'reference_index', errors),
  ) as VNextReferenceIndex;
}
