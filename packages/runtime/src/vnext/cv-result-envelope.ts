/**
 * Pure, closed vNext CV result envelope validator.
 *
 * Kept separate from the CV admission consumer so Integration and historical
 * lineage readers can validate the same envelope without importing a consumer.
 */
import { SchemaValidationError } from '@proofloop/kernel';
import { assertClosedVNextCvPayload } from './cv-validation';
import { VNextHandoffError } from './errors';
import { CANONICAL_STAGE_ID_RE } from './stage-id';
import type { VNextCvResultEnvelope } from './types';

interface FieldError {
  readonly path: string;
  readonly message: string;
}

const KNOWN_FIELDS = new Set([
  'schema_version', 'type', 'stage_id', 'slice_id', 'worker_receipt_digest',
  'manifest_digest', 'plan_digest', 'proof_index_digest', 'context_ref',
  'context_digest', 'snapshot_digest', 'verification_type', 'verdict',
  'summary', 'acceptance_refs_checked', 'seam_refs_checked',
  'oracle_refs_checked', 'risk_refs_considered', 'failed_acceptance_refs',
  'invalid_tests', 'counterexamples', 'scope_violations',
  'forbidden_substitutions', 'regression_failures', 'failed_criterion',
  'failure_signature', 'required_recheck_scope', 'previous_failure_signature',
  'repair_diff_digest', 'stage_contract_digest', 'slice_contract_digest',
  'execution_binding_digest',
]);
const IDENTIFIER_RE = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function add(errors: FieldError[], path: string, message: string): void {
  errors.push({ path, message });
}

function checkUnknownFields(value: Record<string, unknown>, errors: FieldError[]): void {
  for (const key of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(key)) add(errors, `cv_result.${key}`, `Unknown field "${key}"`);
  }
}

function nonEmptyString(value: unknown, fieldPath: string, errors: FieldError[]): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    add(errors, fieldPath, 'Expected a non-empty string');
    return false;
  }
  return true;
}

function identifier(value: unknown, fieldPath: string, errors: FieldError[]): void {
  if (!nonEmptyString(value, fieldPath, errors)) return;
  if (!IDENTIFIER_RE.test(value)) add(errors, fieldPath, 'Expected an identifier matching ^[A-Za-z0-9_-]+$');
}

function canonicalStageId(value: unknown, fieldPath: string, errors: FieldError[]): void {
  if (!nonEmptyString(value, fieldPath, errors)) return;
  if (!CANONICAL_STAGE_ID_RE.test(value)) {
    add(errors, fieldPath, 'Expected a canonical Stage ID matching /^S\\d+$/ (e.g. S09); legacy labels such as S08B0/S08B are rejected');
  }
}

function throwValidationError(errors: readonly FieldError[]): never {
  throw new SchemaValidationError(
    `VNextCvResultEnvelope schema validation failed: ${errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`,
    [...errors],
  );
}

/** Validate a vNext CV result without admission or filesystem I/O. */
export function validateVNextCvResultEnvelope(value: unknown): VNextCvResultEnvelope {
  if (!isRecord(value)) {
    throwValidationError([{ path: 'cv_result', message: 'Expected a non-null object' }]);
  }
  const errors: FieldError[] = [];
  checkUnknownFields(value, errors);
  canonicalStageId(value.stage_id, 'cv_result.stage_id', errors);
  identifier(value.slice_id, 'cv_result.slice_id', errors);
  if (errors.length > 0) throwValidationError(errors);
  try {
    assertClosedVNextCvPayload(value);
  } catch (error) {
    if (error instanceof VNextHandoffError) throwValidationError([{ path: 'cv_result', message: error.message }]);
    throw error;
  }
  return value as unknown as VNextCvResultEnvelope;
}

/** Acronym-compatible aliases retained for Runtime consumers. */
export const validateVNextCVResultEnvelope = validateVNextCvResultEnvelope;
export const validateVNextCvResult = validateVNextCvResultEnvelope;
export const validateVNextCVResult = validateVNextCvResultEnvelope;
