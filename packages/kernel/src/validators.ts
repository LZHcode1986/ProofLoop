/**
 * @proofloop/kernel — Contract Validators (Pure TypeScript)
 *
 * Public validation seam for Receipt, Manifest, RuntimeLock, and Finding
 * JSON payloads.  Every validator is a pure TypeScript type guard that
 * produces the canonical type from contracts.ts and is fail-closed:
 * invalid inputs throw SchemaValidationError.
 *
 * §7 Error Contracts — RUNTIME.SCHEMA_MISMATCH
 *
 * This file has ZERO external dependencies — all validation is performed
 * with plain typeof checks, null checks, Array.isArray, and regex patterns.
 */

import type {
  CanonicalRuntimeProofStep,
  FindingCode,
  ReceiptType,
  RuntimeProofStepType,
} from './contracts';

// ============================================================
// SchemaValidationError
// ============================================================

/**
 * Error thrown when a contract payload fails schema validation.
 *
 * code: 'RUNTIME.SCHEMA_MISMATCH' (§7 Error Contracts)
 * fieldErrors: structured path + message for each violation.
 */
export class SchemaValidationError extends Error {
  /** Canonical error code. */
  public readonly code: 'RUNTIME.SCHEMA_MISMATCH' = 'RUNTIME.SCHEMA_MISMATCH';
  /** Per-field validation errors. */
  public readonly fieldErrors: Array<{ path: string; message: string }>;

  constructor(
    message: string,
    fieldErrors: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'SchemaValidationError';
    this.fieldErrors = fieldErrors;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, SchemaValidationError.prototype);
  }
}

// ============================================================
// Internal helpers
// ============================================================

/** Collected field error during validation. */
interface FieldError {
  path: string;
  message: string;
}

/** Validator function for a single field or value. */
type Validator<T = unknown> = (value: unknown, path: string, errors: FieldError[]) => T | undefined;

// -----------------------------------------------------------------
// Primitive type guards
// -----------------------------------------------------------------

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

function isNumber(x: unknown): x is number {
  return typeof x === 'number' && !Number.isNaN(x);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isArray(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === 'boolean';
}

// -----------------------------------------------------------------
// Field validators
// -----------------------------------------------------------------

/**
 * Validate a required string field (min length enforced).
 */
function expectString(value: unknown, path: string, errors: FieldError[], minLength = 1): string | undefined {
  if (!isString(value)) {
    errors.push({ path, message: `Expected string, got ${value === null ? 'null' : typeof value}` });
    return undefined;
  }
  if (value.length < minLength) {
    errors.push({ path, message: `String must be at least ${minLength} character(s)` });
    return undefined;
  }
  return value;
}

/**
 * Validate an optional string field.
 */
function expectOptionalString(value: unknown, path: string, errors: FieldError[]): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, path, errors);
}

/**
 * Validate a required number field.
 */
function expectNumber(value: unknown, path: string, errors: FieldError[]): number | undefined {
  if (!isNumber(value)) {
    errors.push({ path, message: `Expected number, got ${value === null ? 'null' : typeof value}` });
    return undefined;
  }
  return value;
}

/**
 * Validate an optional number field.
 */
function expectOptionalNumber(value: unknown, path: string, errors: FieldError[]): number | undefined {
  if (value === undefined) return undefined;
  return expectNumber(value, path, errors);
}

/**
 * Validate a required literal value (=== comparison).
 */
function expectLiteral<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
  path: string,
  errors: FieldError[],
): T | undefined {
  if (value !== expected) {
    errors.push({ path, message: `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}` });
    return undefined;
  }
  return expected;
}

/**
 * Validate a required union of string literal values.
 */
function expectStringLiteral<T extends string>(
  value: unknown,
  literals: readonly T[],
  path: string,
  errors: FieldError[],
): T | undefined {
  if (!isString(value)) {
    errors.push({ path, message: `Expected string, got ${value === null ? 'null' : typeof value}` });
    return undefined;
  }
  if (!(literals as readonly string[]).includes(value)) {
    errors.push({
      path,
      message: `Expected one of: ${literals.map(l => JSON.stringify(l)).join(', ')}`,
    });
    return undefined;
  }
  return value as T;
}

/**
 * Validate a required object (Record).
 */
function expectObject(value: unknown, path: string, errors: FieldError[]): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    errors.push({
      path,
      message: `Expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
    });
    return undefined;
  }
  return value;
}

/**
 * Validate an optional object field.
 */
function expectOptionalObject(value: unknown, path: string, errors: FieldError[]): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return expectObject(value, path, errors);
}

/**
 * Validate a required array.
 */
function expectArray(value: unknown, path: string, errors: FieldError[]): unknown[] | undefined {
  if (!isArray(value)) {
    errors.push({ path, message: `Expected array, got ${value === null ? 'null' : typeof value}` });
    return undefined;
  }
  return value;
}

/**
 * Validate a required array of strings.
 */
function expectStringArray(value: unknown, path: string, errors: FieldError[]): string[] | undefined {
  const arr = expectArray(value, path, errors);
  if (!arr) return undefined;

  for (let i = 0; i < arr.length; i++) {
    if (!isString(arr[i])) {
      errors.push({ path: `${path}[${i}]`, message: `Expected string, got ${typeof arr[i]}` });
    }
  }
  return arr as string[];
}

/**
 * Validate a required boolean.
 */
function expectBoolean(value: unknown, path: string, errors: FieldError[]): boolean | undefined {
  if (!isBoolean(value)) {
    errors.push({ path, message: `Expected boolean, got ${typeof value}` });
    return undefined;
  }
  return value;
}

// -----------------------------------------------------------------
// ISO 8601 datetime validation
// -----------------------------------------------------------------

/** Regex for ISO 8601 datetime with optional timezone offset. */
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

/**
 * Validate an ISO 8601 datetime string with semantic date validation.
 *
 * In addition to format validation via regex, this function:
 * 1. Parses the date with `new Date(str)` to reject NaN dates
 * 2. Validates month (1-12), day (1-31), hours (0-23), minutes (0-59), seconds (0-59)
 * 3. Validates day-of-month for each month/year (rejects Feb 29 in non-leap year,
 *    Apr 31, etc.) using JavaScript's Date month rollover
 */
function expectISODateTime(value: unknown, path: string, errors: FieldError[]): string | undefined {
  const str = expectString(value, path, errors);
  if (!str) return undefined;
  if (!ISO_8601_REGEX.test(str)) {
    errors.push({ path, message: `Expected ISO 8601 datetime string (e.g., "2025-01-01T00:00:00.000Z")` });
    return undefined;
  }

  // Semantic validation: parse date components to reject impossible dates
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    errors.push({ path, message: `Cannot parse ISO date components in "${str}"` });
    return undefined;
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hours = parseInt(match[4], 10);
  const minutes = parseInt(match[5], 10);
  const seconds = parseInt(match[6], 10);

  // Range checks
  if (month < 1 || month > 12) {
    errors.push({ path, message: `Month out of range: ${month} in "${str}"` });
    return undefined;
  }
  if (day < 1 || day > 31) {
    errors.push({ path, message: `Day out of range: ${day} in "${str}"` });
    return undefined;
  }
  if (hours < 0 || hours > 23) {
    errors.push({ path, message: `Hours out of range: ${hours} in "${str}"` });
    return undefined;
  }
  if (minutes < 0 || minutes > 59) {
    errors.push({ path, message: `Minutes out of range: ${minutes} in "${str}"` });
    return undefined;
  }
  if (seconds < 0 || seconds > 59) {
    errors.push({ path, message: `Seconds out of range: ${seconds} in "${str}"` });
    return undefined;
  }

  // Validate day-of-month (catches Feb 29 in non-leap year, Apr 31, etc.)
  // JS Date month is 0-indexed, so new Date(year, month, 0) gives the last day of month-1
  // e.g., new Date(2025, 2, 0) = Feb 28, 2025 (last day of February)
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) {
    errors.push({ path, message: `Invalid day ${day} for month ${month}/${year}: "${str}"` });
    return undefined;
  }

  // Final sanity check: Date.parse should not be NaN
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) {
    errors.push({ path, message: `Date.parse rejected: "${str}"` });
    return undefined;
  }

  return str;
}

// ============================================================
// Canonical Stage ID guard (S09-C-T03)
// ============================================================

/**
 * Canonical Stage ID grammar: `S` followed by one or more decimal digits.
 *
 * This is the SINGLE shared rule for candidate parser, compiler, Mechanical
 * Validator, plan/stage/review status and every admission seam.  Legacy
 * parked labels such as `S08B0` / `S08B` do not match and fail closed before
 * any Runtime read/write.
 */
export const CANONICAL_STAGE_ID_RE: RegExp = /^S\d+$/;

/**
 * True when `value` is a canonical Stage ID string (matches `^S\d+$`).
 */
export function isCanonicalStageId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_STAGE_ID_RE.test(value);
}

/**
 * Fail-closed canonical Stage ID assertion.
 *
 * @throws {SchemaValidationError} (RUNTIME.SCHEMA_MISMATCH) when the value
 *         is not a canonical Stage ID.
 */
export function assertCanonicalStageId(value: unknown, path = 'stage_id'): string {
  if (!isCanonicalStageId(value)) {
    throw new SchemaValidationError(
      `Schema validation failed: ${path} must match the canonical Stage ID grammar /^S\\d+$/ (e.g. S09); legacy labels such as S08B0/S08B are rejected`,
      [{ path, message: 'Expected a canonical Stage ID matching /^S\\d+$/' }],
    );
  }
  return value;
}

// ============================================================
// Finding Code literals (§7 Error Contracts)
// ============================================================

const FINDING_CODES = [
  'HOST.PROJECT_NOT_TRUSTED',
  'HOST.PATH_PROTECTED',
  'HOST.TOOL_NOT_ACTIVE',
  'HOST.PATH_OUTSIDE_PROJECT',
  'RUNTIME.VERSION_MISMATCH',
  'RUNTIME.RECEIPT_CHAIN_BROKEN',
  'RUNTIME.SCHEMA_MISMATCH',
  'DOMAIN.STAGE_NOT_FOUND',
  'DOMAIN.INVALID_TRANSITION',
] as const;

// ============================================================
// Receipt Type literals (§4 File / Artifact Contracts)
// ============================================================

const RECEIPT_TYPES = [
  'SLICE_PLAN',
  'STAGE_PLAN',
  'SPV_PASS',
  'TASK_COMPLETE',
  'CV_PASS',
  'CV_REPAIR',
  'SLICE_COMMIT',
  'INTEGRATION_PASS',
  'GATE_PASS',
  'GATE_FAIL',
  'GATE_INTERRUPTED',
  'STAGE_REVIEW_PASS',
  'PROJECT_REVIEW_PASS',
  // B1c additive project-level E2E gate verdict types (blueprint §6.4
  // run_e2e). Evidence-only receipts in the `project/` category — read by
  // finalize-project-review, never project_state facts (only
  // PROJECT_REVIEW_PASS triggers COMPLETED).
  'PROJECT_E2E_PASS',
  'PROJECT_E2E_FAIL',
  'PROJECT_E2E_BLOCKED',
] as const;

// ============================================================
// Validation helpers (non-zod equivalents)
// ============================================================

function checkUnknownFields(
  data: Record<string, unknown>,
  knownFields: Set<string>,
  path: string,
  errors: FieldError[],
): void {
  for (const key of Object.keys(data)) {
    if (!knownFields.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `Unknown field "${key}"` });
    }
  }
}

// ============================================================
// Receipt validation
// ============================================================

const RECEIPT_KNOWN_FIELDS = new Set([
  'version', 'type', 'stage_id', 'slice_id', 'timestamp',
  'digest', 'previous_digest', 'payload', 'signature',
]);

function validateReceiptData(data: unknown, path: string, errors: FieldError[]): Record<string, unknown> | undefined {
  const obj = expectObject(data, path, errors);
  if (!obj) return undefined;

  // Check for unknown fields (fail-closed / strict mode)
  checkUnknownFields(obj, RECEIPT_KNOWN_FIELDS, path, errors);

  // version: must be literal 1
  expectLiteral(obj.version, 1, `${path}.version`, errors);

  // type: must be one of the 16 receipt types (closed set)
  expectStringLiteral(obj.type, RECEIPT_TYPES, `${path}.type`, errors);

  // stage_id: required string (v1 legacy receipts keep the v1 contract; the
  // shared canonical Stage ID grammar ^S\d+$ is enforced at every vNext
  // Runtime boundary — S09-C-T03)
  expectString(obj.stage_id, `${path}.stage_id`, errors);

  // slice_id: optional string
  if (obj.slice_id !== undefined) {
    expectString(obj.slice_id, `${path}.slice_id`, errors);
  }

  // timestamp: required ISO 8601
  expectISODateTime(obj.timestamp, `${path}.timestamp`, errors);

  // digest: required string
  expectString(obj.digest, `${path}.digest`, errors);

  // previous_digest: optional string
  if (obj.previous_digest !== undefined) {
    expectString(obj.previous_digest, `${path}.previous_digest`, errors);
  }

  // payload: required object (record)
  expectObject(obj.payload, `${path}.payload`, errors);

  // signature: optional string
  if (obj.signature !== undefined) {
    expectString(obj.signature, `${path}.signature`, errors);
  }

  return obj;
}

// ============================================================
// Manifest slice validation
// ============================================================

const SLICE_KNOWN_FIELDS = new Set([
  'slice_id', 'goal', 'observable_outcome', 'public_seam',
  'dependencies', 'proof_obligations', 'tasks', 'risk_facts',
  'evidence_path', 'cv_minimum_level',
]);

function validateSliceData(data: unknown, path: string, errors: FieldError[]): Record<string, unknown> | undefined {
  const obj = expectObject(data, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, SLICE_KNOWN_FIELDS, path, errors);

  expectString(obj.slice_id, `${path}.slice_id`, errors);
  expectString(obj.goal, `${path}.goal`, errors);
  expectString(obj.observable_outcome, `${path}.observable_outcome`, errors);
  expectString(obj.public_seam, `${path}.public_seam`, errors);
  expectStringArray(obj.dependencies, `${path}.dependencies`, errors);
  validateProofObligationsArray(obj.proof_obligations, `${path}.proof_obligations`, errors);
  expectStringArray(obj.tasks, `${path}.tasks`, errors);
  expectStringArray(obj.risk_facts, `${path}.risk_facts`, errors);
  expectString(obj.evidence_path, `${path}.evidence_path`, errors);
  expectStringLiteral(obj.cv_minimum_level, ['lite', 'standard', 'enhanced'] as const, `${path}.cv_minimum_level`, errors);

  return obj;
}

// ============================================================
// Proof obligation validation
// ============================================================

const PO_KNOWN_FIELDS = new Set([
  'po_id', 'behavior', 'public_seam', 'oracle_source',
  'success_criteria', 'required_observation', 'applicable_risk_facts',
]);

function validateProofObligationData(data: unknown, path: string, errors: FieldError[]): Record<string, unknown> | undefined {
  const obj = expectObject(data, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, PO_KNOWN_FIELDS, path, errors);

  expectString(obj.po_id, `${path}.po_id`, errors);
  expectString(obj.behavior, `${path}.behavior`, errors);
  expectString(obj.public_seam, `${path}.public_seam`, errors);
  expectString(obj.oracle_source, `${path}.oracle_source`, errors);
  expectString(obj.success_criteria, `${path}.success_criteria`, errors);
  expectString(obj.required_observation, `${path}.required_observation`, errors);
  expectStringArray(obj.applicable_risk_facts, `${path}.applicable_risk_facts`, errors);

  return obj;
}

function validateProofObligationsArray(data: unknown, path: string, errors: FieldError[]): void {
  const arr = expectArray(data, path, errors);
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    validateProofObligationData(arr[i], `${path}[${i}]`, errors);
  }
}

// ============================================================
// Runtime proof step type literals
// ============================================================

const PROOF_STEP_TYPES = [
  'command',
  'service_start',
  'service_stop',
  'probe',
] as const;

// ============================================================
// Runtime proof step validation
// ============================================================

const PROOF_STEP_KNOWN_FIELDS = new Set([
  'id', 'type', 'executable', 'args', 'cwd', 'timeout_ms',
  'expected', 'not_applicable', 'service_ref', 'readiness_signal',
]);

const NOT_APPLICABLE_KNOWN_FIELDS = new Set(['reason']);

function validateRuntimeProofStepData(data: unknown, path: string, errors: FieldError[]): Record<string, unknown> | undefined {
  const obj = expectObject(data, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, PROOF_STEP_KNOWN_FIELDS, path, errors);

  expectString(obj.id, `${path}.id`, errors);
  expectStringLiteral(obj.type, PROOF_STEP_TYPES, `${path}.type`, errors);
  expectString(obj.executable, `${path}.executable`, errors);
  const args = expectArray(obj.args, `${path}.args`, errors);
  if (args) {
    for (let i = 0; i < args.length; i++) {
      if (!isString(args[i])) {
        errors.push({ path: `${path}.args[${i}]`, message: `Expected string, got ${typeof args[i]}` });
      }
    }
  }
  expectString(obj.cwd, `${path}.cwd`, errors);
  const timeoutMs = expectNumber(obj.timeout_ms, `${path}.timeout_ms`, errors);
  if (timeoutMs !== undefined) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      errors.push({ path: `${path}.timeout_ms`, message: `Expected positive integer, got ${timeoutMs}` });
    }
  }

  // expected: optional object with exit_code validation
  if (obj.expected !== undefined) {
    const expectedObj = expectObject(obj.expected, `${path}.expected`, errors);
    if (expectedObj) {
      // Validate exit_code if present (must be number or null)
      if (expectedObj.exit_code !== undefined && expectedObj.exit_code !== null) {
        if (typeof expectedObj.exit_code !== 'number' || Number.isNaN(expectedObj.exit_code)) {
          errors.push({ path: `${path}.expected.exit_code`, message: `Expected number or null, got ${typeof expectedObj.exit_code}` });
        }
      }
    }
  }

  // not_applicable: optional object with reason validation
  if (obj.not_applicable !== undefined) {
    const naObj = expectObject(obj.not_applicable, `${path}.not_applicable`, errors);
    if (naObj) {
      // Validate reason if present (must be non-empty string)
      if (naObj.reason !== undefined) {
        expectString(naObj.reason, `${path}.not_applicable.reason`, errors);
      }
    }
  }

  // service_ref: optional string (for service_stop steps)
  if (obj.service_ref !== undefined) {
    expectString(obj.service_ref, `${path}.service_ref`, errors);
  }

  // readiness_signal: optional string (for service_start steps)
  if (obj.readiness_signal !== undefined) {
    expectString(obj.readiness_signal, `${path}.readiness_signal`, errors);
  }

  return obj;
}

function validateRuntimeProofSteps(data: unknown, path: string, errors: FieldError[]): void {
  if (data === undefined) return; // optional field
  const arr = expectArray(data, path, errors);
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    validateRuntimeProofStepData(arr[i], `${path}[${i}]`, errors);
  }
}

// ============================================================
// Canonical executable Runtime Proof step validation (S09-C-T01)
// ============================================================

/**
 * Canonical closed validation for ONE Runtime Proof step (vNext seam).
 *
 * Each step is either a canonical executable step (`id`, `type`,
 * `executable`, `args`, `cwd`, `timeout_ms`, `expected`, optional
 * `service_ref` / `readiness_signal`) or an explicit
 * `not_applicable{reason}` boundary — never both, never a mixture.
 *
 * The type set is closed: `command | service_start | service_stop | probe`.
 * Unknown fields, unknown types, empty executables, non-string args,
 * non-positive timeout and missing required fields all fail closed.
 *
 * @throws {SchemaValidationError} on any violation.
 */
export function validateRuntimeProofStep(data: unknown): CanonicalRuntimeProofStep {
  return collectErrors('RuntimeProofStep', (errors) => {
    const obj = expectObject(data, 'step', errors);
    if (!obj) return undefined;

    checkUnknownFields(obj, PROOF_STEP_KNOWN_FIELDS, 'step', errors);

    if (obj.not_applicable !== undefined) {
      // Explicit not-applicable boundary: the step must carry ONLY
      // `not_applicable{reason}`.
      if (Object.keys(obj).some((key) => key !== 'not_applicable')) {
        errors.push({
          path: 'step',
          message: 'A not_applicable step must not carry executable fields',
        });
      }
      const naObj = expectObject(obj.not_applicable, 'step.not_applicable', errors);
      if (naObj) {
        checkUnknownFields(naObj, NOT_APPLICABLE_KNOWN_FIELDS, 'step.not_applicable', errors);
        expectString(naObj.reason, 'step.not_applicable.reason', errors);
      }
      return obj;
    }

    // Canonical executable step — every required field must be present.
    expectString(obj.id, 'step.id', errors);
    expectStringLiteral(obj.type, PROOF_STEP_TYPES, 'step.type', errors);
    expectString(obj.executable, 'step.executable', errors);
    const args = expectArray(obj.args, 'step.args', errors);
    if (args) {
      for (let i = 0; i < args.length; i++) {
        if (!isString(args[i])) {
          errors.push({ path: `step.args[${i}]`, message: `Expected string, got ${typeof args[i]}` });
        }
      }
    }
    expectString(obj.cwd, 'step.cwd', errors);
    const timeoutMs = expectNumber(obj.timeout_ms, 'step.timeout_ms', errors);
    if (timeoutMs !== undefined) {
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        errors.push({ path: 'step.timeout_ms', message: `Expected positive integer, got ${timeoutMs}` });
      }
    }
    const expected = expectObject(obj.expected, 'step.expected', errors);
    if (expected && expected.exit_code !== undefined && expected.exit_code !== null) {
      if (typeof expected.exit_code !== 'number' || Number.isNaN(expected.exit_code)) {
        errors.push({ path: 'step.expected.exit_code', message: `Expected number or null, got ${typeof expected.exit_code}` });
      }
    }
    if (obj.service_ref !== undefined) {
      expectString(obj.service_ref, 'step.service_ref', errors);
    }
    if (obj.readiness_signal !== undefined) {
      expectString(obj.readiness_signal, 'step.readiness_signal', errors);
    }
    return obj;
  }) as unknown as CanonicalRuntimeProofStep;
}

// ============================================================
// Manifest validation
// ============================================================

const MANIFEST_KNOWN_FIELDS = new Set([
  'stage_id', 'source_path', 'source_digest', 'stage_goal',
  'outcomes', 'slices', 'dependencies', 'risk_facts',
  'runtime_proof', 'compiled_at', 'compiled_by', 'repartition_requested',
]);

function validateManifestData(data: unknown, path: string, errors: FieldError[]): Record<string, unknown> | undefined {
  const obj = expectObject(data, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, MANIFEST_KNOWN_FIELDS, path, errors);

  // stage_id: required string (v1 legacy manifests keep the v1 contract; the
  // shared canonical Stage ID grammar ^S\d+$ is enforced at every vNext
  // Runtime boundary — S09-C-T03)
  expectString(obj.stage_id, `${path}.stage_id`, errors);
  expectString(obj.source_path, `${path}.source_path`, errors);
  expectString(obj.source_digest, `${path}.source_digest`, errors);
  expectString(obj.stage_goal, `${path}.stage_goal`, errors);
  expectStringArray(obj.outcomes, `${path}.outcomes`, errors);

  // slices: array of slice objects
  const slices = expectArray(obj.slices, `${path}.slices`, errors);
  if (slices) {
    for (let i = 0; i < slices.length; i++) {
      validateSliceData(slices[i], `${path}.slices[${i}]`, errors);
    }
  }

  expectStringArray(obj.dependencies, `${path}.dependencies`, errors);
  expectStringArray(obj.risk_facts, `${path}.risk_facts`, errors);

  // runtime_proof: optional array of proof step objects
  validateRuntimeProofSteps(obj.runtime_proof, `${path}.runtime_proof`, errors);

  // compiled_at: optional string
  if (obj.compiled_at !== undefined) {
    expectString(obj.compiled_at, `${path}.compiled_at`, errors);
  }

  // compiled_by: optional string
  if (obj.compiled_by !== undefined) {
    expectString(obj.compiled_by, `${path}.compiled_by`, errors);
  }

  // repartition_requested: optional boolean (canonical REPARTITION fact source,
  // §4 Manifest contract — F-S02-08); absent (undefined) is valid and defaults
  // to false/not requested
  if (obj.repartition_requested !== undefined) {
    expectBoolean(obj.repartition_requested, `${path}.repartition_requested`, errors);
  }

  return obj;
}

// ============================================================
// RuntimeLock validation
// ============================================================

const RUNTIME_LOCK_KNOWN_FIELDS = new Set([
  'runtime_version', 'domain_schema_version', 'risk_policy_version',
  'capability_policy_version', 'host_adapter', 'extension_package',
  'extension_version',
]);

function validateRuntimeLockData(data: unknown, path: string, errors: FieldError[]): Record<string, unknown> | undefined {
  const obj = expectObject(data, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, RUNTIME_LOCK_KNOWN_FIELDS, path, errors);

  expectString(obj.runtime_version, `${path}.runtime_version`, errors);
  if (typeof obj.runtime_version === 'string' && !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+(\+[a-zA-Z0-9.]+)?)?$/.test(obj.runtime_version)) {
    errors.push({ path: `${path}.runtime_version`, message: 'must be semver (x.y.z)' });
  }
  expectNumber(obj.domain_schema_version, `${path}.domain_schema_version`, errors);
  if (typeof obj.domain_schema_version === 'number' && (!Number.isInteger(obj.domain_schema_version) || obj.domain_schema_version < 1)) {
    errors.push({ path: `${path}.domain_schema_version`, message: 'must be a positive integer' });
  }
  expectNumber(obj.risk_policy_version, `${path}.risk_policy_version`, errors);
  expectNumber(obj.capability_policy_version, `${path}.capability_policy_version`, errors);
  expectString(obj.host_adapter, `${path}.host_adapter`, errors);
  expectString(obj.extension_package, `${path}.extension_package`, errors);
  expectString(obj.extension_version, `${path}.extension_version`, errors);

  return obj;
}

// ============================================================
// Finding validation
// ============================================================

const FINDING_KNOWN_FIELDS = new Set([
  'code', 'severity', 'message',
]);

function validateFindingData(data: unknown, path: string, errors: FieldError[]): Record<string, unknown> | undefined {
  const obj = expectObject(data, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, FINDING_KNOWN_FIELDS, path, errors);

  expectStringLiteral(obj.code, FINDING_CODES, `${path}.code`, errors);
  expectStringLiteral(obj.severity, ['error', 'warn'] as const, `${path}.severity`, errors);
  expectString(obj.message, `${path}.message`, errors);

  return obj;
}

// ============================================================
// Parse helpers — collect errors and throw SchemaValidationError
// ============================================================

function collectErrors(label: string, validateFn: (errors: FieldError[]) => Record<string, unknown> | undefined): Record<string, unknown> {
  const errors: FieldError[] = [];
  const result = validateFn(errors);

  if (errors.length > 0) {
    throw new SchemaValidationError(
      `Schema validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      errors,
    );
  }

  return result!;
}

// ============================================================
// Inferred types (re-exported for convenience)
// ============================================================

/**
 * Inferred Receipt type.
 * Matches the Receipt interface from contracts.ts.
 *
 * This type mirrors the shape returned by validateReceipt.
 */
export type ValidatedReceipt = {
  version: 1;
  type: ReceiptType;
  stage_id: string;
  slice_id?: string;
  timestamp: string;
  digest: string;
  previous_digest?: string;
  payload: Record<string, unknown>;
  signature?: string;
};

/**
 * Inferred Manifest type.
 * Matches the Manifest interface from contracts.ts.
 */
export type ValidatedManifest = {
  stage_id: string;
  source_path: string;
  source_digest: string;
  stage_goal: string;
  outcomes: string[];
  slices: Array<{
    slice_id: string;
    goal: string;
    observable_outcome: string;
    public_seam: string;
    dependencies: string[];
    proof_obligations: Array<{
      po_id: string;
      behavior: string;
      public_seam: string;
      oracle_source: string;
      success_criteria: string;
      required_observation: string;
      applicable_risk_facts: string[];
    }>;
    tasks: string[];
    risk_facts: string[];
    evidence_path: string;
    cv_minimum_level: string;
  }>;
  dependencies: string[];
  risk_facts: string[];
  runtime_proof?: Array<{
    id: string;
    type: RuntimeProofStepType;
    executable: string;
    args: string[];
    cwd: string;
    timeout_ms: number;
    expected?: Record<string, unknown>;
    not_applicable?: Record<string, unknown>;
    service_ref?: string;
    readiness_signal?: string;
  }>;
  compiled_at?: string;
  compiled_by?: string;
  repartition_requested?: boolean;
};

/**
 * Inferred RuntimeLock type.
 * Matches the RuntimeLock interface from contracts.ts.
 */
export type ValidatedRuntimeLock = {
  runtime_version: string;
  domain_schema_version: number;
  risk_policy_version: number;
  capability_policy_version: number;
  host_adapter: string;
  extension_package: string;
  extension_version: string;
};

/**
 * Inferred Finding type.
 * Matches the Finding interface from contracts.ts.
 */
export type ValidatedFinding = {
  code: FindingCode;
  severity: 'error' | 'warn';
  message: string;
};

// ============================================================
// Public validation functions
// ============================================================

/**
 * Validate an unknown value as a canonical Receipt (§4).
 *
 * @throws {SchemaValidationError} if data is not a valid Receipt.
 */
export function validateReceipt(data: unknown): ValidatedReceipt {
  return collectErrors('Receipt', (errors) =>
    validateReceiptData(data, '', errors) as Record<string, unknown>,
  ) as unknown as ValidatedReceipt;
}

/**
 * Validate an unknown value as a canonical Manifest (§4).
 *
 * @throws {SchemaValidationError} if data is not a valid Manifest.
 */
export function validateManifest(data: unknown): ValidatedManifest {
  return collectErrors('Manifest', (errors) =>
    validateManifestData(data, '', errors) as Record<string, unknown>,
  ) as unknown as ValidatedManifest;
}

/**
 * Validate an unknown value as a canonical RuntimeLock (§4).
 *
 * @throws {SchemaValidationError} if data is not a valid RuntimeLock.
 */
export function validateRuntimeLock(data: unknown): ValidatedRuntimeLock {
  return collectErrors('RuntimeLock', (errors) =>
    validateRuntimeLockData(data, '', errors) as Record<string, unknown>,
  ) as unknown as ValidatedRuntimeLock;
}

/**
 * Validate an unknown value as a canonical Finding (§5/§7).
 *
 * @throws {SchemaValidationError} if data is not a valid Finding.
 */
export function validateFinding(data: unknown): ValidatedFinding {
  return collectErrors('Finding', (errors) =>
    validateFindingData(data, '', errors) as Record<string, unknown>,
  ) as unknown as ValidatedFinding;
}
