/**
 * @proofloop/kernel — vNext internal validation helpers (S0-A).
 *
 * Shared fail-closed helpers for the vNext validators. All validators reuse
 * the kernel's canonical `SchemaValidationError` (RUNTIME.SCHEMA_MISMATCH).
 */

import { SchemaValidationError } from '../validators';
import { isSha256Hex } from './canonical';

export interface FieldError {
  path: string;
  message: string;
}

/**
 * Run a validator that pushes into a shared error list and throw a single
 * SchemaValidationError when any error was collected.
 */
export function collectErrors(
  label: string,
  fn: (errors: FieldError[]) => unknown,
): unknown {
  const errors: FieldError[] = [];
  const result = fn(errors);
  if (errors.length > 0) {
    throw new SchemaValidationError(
      `${label} schema validation failed: ${errors
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ')}`,
      errors,
    );
  }
  return result;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkUnknownFields(
  data: Record<string, unknown>,
  known: Set<string>,
  path: string,
  errors: FieldError[],
): void {
  for (const key of Object.keys(data)) {
    if (!known.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `Unknown field "${key}"` });
    }
  }
}

export function expectObject(
  value: unknown,
  path: string,
  errors: FieldError[],
): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    errors.push({
      path,
      message: `Expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
    });
    return undefined;
  }
  return value;
}

export function expectNonEmptyString(
  value: unknown,
  path: string,
  errors: FieldError[],
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({
      path,
      message: `Expected non-empty string, got ${value === null ? 'null' : typeof value}`,
    });
    return undefined;
  }
  return value;
}

export function expectArray(
  value: unknown,
  path: string,
  errors: FieldError[],
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({
      path,
      message: `Expected array, got ${value === null ? 'null' : typeof value}`,
    });
    return undefined;
  }
  return value;
}

/**
 * Validate an array of non-empty strings.
 *
 * @param opts.unique — reject duplicate entries (used for ref_id lists).
 */
export function expectStringArray(
  value: unknown,
  path: string,
  errors: FieldError[],
  opts?: { unique?: boolean },
): string[] | undefined {
  const arr = expectArray(value, path, errors);
  if (!arr) return undefined;

  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item !== 'string' || item.length === 0) {
      errors.push({ path: `${path}[${i}]`, message: 'Expected non-empty string' });
      continue;
    }
    if (opts?.unique) {
      if (seen.has(item)) {
        errors.push({ path: `${path}[${i}]`, message: `Duplicate ref_id "${item}"` });
        continue;
      }
      seen.add(item);
    }
    result.push(item);
  }
  return result;
}

export function expectSha256Hex(
  value: unknown,
  path: string,
  errors: FieldError[],
): string | undefined {
  if (!isSha256Hex(value)) {
    errors.push({
      path,
      message: 'Expected 64-char lowercase hex SHA-256 digest',
    });
    return undefined;
  }
  return value;
}
