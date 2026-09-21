/**
 * @proofloop/kernel — Canonical Validators (Pure TypeScript)
 *
 * Shared fail-closed validation machinery retained by the neutral kernel
 * core:
 * - `SchemaValidationError` (RUNTIME.SCHEMA_MISMATCH, §7 Error Contracts);
 * - the canonical Stage ID guard (S09-C-T03) — the SINGLE shared `^S\d+$`
 *   rule for candidate parser, compiler, Mechanical Validator,
 *   plan/stage/review status and every admission seam;
 * - RuntimeLock validation (§4 File / Artifact Contracts —
 *   `.proofloop/runtime.lock`), including the closed unknown-field / version
 *   shape checks.
 *
 * Receipt / Manifest / Finding / Runtime Proof validators moved out with the
 * old business stack. The vNext validators (vnext/) reuse the shared
 * `SchemaValidationError` and their own internal helpers (vnext/internal.ts).
 *
 * This file has ZERO external dependencies — all validation is performed
 * with plain typeof checks, null checks, Array.isArray, and regex patterns.
 */

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
// Internal helpers (shared by the retained validators)
// ============================================================

/** Collected field error during validation. */
interface FieldError {
  path: string;
  message: string;
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

function isNumber(x: unknown): x is number {
  return typeof x === 'number' && !Number.isNaN(x);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

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

/** Validate a required string field (min length enforced). */
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

/** Validate a required number field. */
function expectNumber(value: unknown, path: string, errors: FieldError[]): number | undefined {
  if (!isNumber(value)) {
    errors.push({ path, message: `Expected number, got ${value === null ? 'null' : typeof value}` });
    return undefined;
  }
  return value;
}

/** Validate a required object (Record). */
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
 * Run a validator that pushes into a shared error list and throw a single
 * SchemaValidationError when any error was collected.
 */
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
// Canonical Stage ID guard (S09-C-T03)
// ============================================================

/**
 * Canonical Stage ID grammar: `S` followed by one or more decimal digits.
 *
 * This is the SINGLE shared rule for candidate parser, compiler, Mechanical
 * Validator, plan/stage/review status and every admission seam. Legacy
 * parked labels such as `S08B0` / `S08B` do not match and fail closed before
 * any Runtime read/write.
 */
export const CANONICAL_STAGE_ID_RE: RegExp = /^S\d+$/;

export type CanonicalStageId = string;

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
 * Validate an unknown value as a canonical RuntimeLock (§4).
 *
 * Unknown fields and any version/field shape outside the closed contract
 * fail closed.
 *
 * @throws {SchemaValidationError} if data is not a valid RuntimeLock.
 */
export function validateRuntimeLock(data: unknown): ValidatedRuntimeLock {
  return collectErrors('RuntimeLock', (errors) =>
    validateRuntimeLockData(data, '', errors) as Record<string, unknown>,
  ) as unknown as ValidatedRuntimeLock;
}