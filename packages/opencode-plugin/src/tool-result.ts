/**
 * @proofloop/opencode-plugin — unified ToolResult contract (AWI-003 / OUT-S1-05).
 *
 * S01-C-T01: defines the canonical result envelope shared by every plugin
 * tool and the fail-closed error mapping boundary.
 *
 * Shape (OUT-S1-05 / PO-S01-C-04):
 *   { ok: boolean, data?: Record<string, unknown>,
 *     findings: readonly ValidatedFinding[], refs: readonly ReceiptRef[],
 *     runtime: RuntimeMetadata }
 *
 * - findings reuse the kernel Finding shape and are verified at construction
 *   through the REAL kernel validator (`validateFinding`), re-exported by
 *   `@proofloop/runtime`. The kernel closed set of Finding codes is
 *   authoritative — this module never invents a Finding code or new flow
 *   semantics.
 * - refs are a `{ ref, digest }` projection of Receipts: the full Receipt
 *   payload never leaks into a ToolResult (compact budget contract, T02
 *   consumes this projection).
 * - runtime is the runtime-metadata projection the doctor (T03) fills.
 * - the error mapping boundary (`toErrorResult`) is fail-closed: a thrown
 *   kernel SchemaValidationError / generic error / structured condition is
 *   mapped to `ok:false` plus a canonical Finding; a bare exception never
 *   leaks into a ToolResult.
 *
 * No new Finding codes, Receipt semantics, or flow state are introduced.
 */

import { SchemaValidationError, validateFinding } from '@proofloop/runtime';
import type { ValidatedFinding } from '@proofloop/runtime';
import type { Receipt } from '@proofloop/kernel';

/**
 * Runtime metadata projection (doctor fills it in S01-C-T03; T01 defines the
 * shape and locks it with tests).
 */
export interface RuntimeMetadata {
  /** Actual @proofloop/runtime version. */
  runtimeVersion: string;
  /** Actual @proofloop/opencode-plugin version. */
  pluginVersion: string;
  /** Declared supported domain schema version. */
  schemaVersion: number;
}

/**
 * Receipt reference projection: only `ref` + `digest` are exposed. The full
 * Receipt payload is never included in a ToolResult (OUT-S1-05 / FR-012).
 */
export interface ReceiptRef {
  /** Canonical reference to the persisted receipt. */
  ref: string;
  /** Content-addressed receipt digest. */
  digest: string;
}

/**
 * Unified tool result envelope shared by every plugin tool (AWI-003).
 *
 * `data` is optional; `findings`, `refs` and `runtime` are always present so
 * consumers can rely on the fixed shape. On `ok:false` the `findings` array
 * carries at least one canonical Finding (fail-closed, never empty).
 */
export interface ToolResult {
  /** Overall success flag. */
  ok: boolean;
  /** Optional structured data payload (check-specific output). */
  data?: Record<string, unknown>;
  /** Canonical kernel-shaped findings (validated at construction). */
  findings: readonly ValidatedFinding[];
  /** Receipt reference projections ({ ref, digest } only). */
  refs: readonly ReceiptRef[];
  /** Runtime metadata projection. */
  runtime: RuntimeMetadata;
}

/**
 * Sentinel used when runtime metadata is not available at mapping time (e.g.
 * the deep fail-closed path). Empty version strings and `0` schema version are
 * explicit "unknown" markers — never fabricated version claims.
 */
export const UNKNOWN_RUNTIME_METADATA: RuntimeMetadata = {
  runtimeVersion: '',
  pluginVersion: '',
  schemaVersion: 0,
};

/** Input accepted by `successResult`. */
export interface SuccessResultInput {
  /** Optional structured data payload. */
  data?: Record<string, unknown>;
  /** Canonical kernel Findings; validated at construction (fail-closed). */
  findings?: readonly ValidatedFinding[];
  /** Receipt reference projections. */
  refs?: readonly ReceiptRef[];
  /** Runtime metadata projection. */
  runtime?: RuntimeMetadata;
}

/**
 * Build an `ok:true` ToolResult.
 *
 * Every finding is validated through the real kernel `validateFinding`
 * (re-exported by `@proofloop/runtime`); a non-canonical Finding throws
 * `SchemaValidationError` instead of silently entering a ToolResult
 * (fail-closed, kernel closed set authoritative).
 */
export function successResult(input: SuccessResultInput): ToolResult {
  for (const finding of input.findings ?? []) {
    validateFinding(finding);
  }

  const result: ToolResult = {
    ok: true,
    findings: input.findings ?? [],
    refs: input.refs ?? [],
    runtime: input.runtime ?? UNKNOWN_RUNTIME_METADATA,
  };
  if (input.data !== undefined) {
    result.data = input.data;
  }
  return result;
}

/**
 * Map a thrown error to a canonical kernel Finding.
 *
 * A kernel `SchemaValidationError` is mapped to its canonical
 * `RUNTIME.SCHEMA_MISMATCH` code; every other thrown value is mapped to the
 * same canonical code (the kernel closed set has no generic "internal error"
 * code, so schema mismatch is the fail-closed, structured representation).
 * This function never throws.
 */
export function toFinding(error: unknown): ValidatedFinding {
  if (error instanceof SchemaValidationError) {
    return {
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return {
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
      message: `Tool execution failed: ${error.message}`,
    };
  }
  return {
    code: 'RUNTIME.SCHEMA_MISMATCH',
    severity: 'error',
    message: `Tool execution failed: ${String(error)}`,
  };
}

/** Optional context the error boundary carries into the result. */
export interface ErrorResultOptions {
  /** Receipt reference projections known at mapping time. */
  refs?: readonly ReceiptRef[];
  /** Runtime metadata projection known at mapping time. */
  runtime?: RuntimeMetadata;
}

/**
 * Unified fail-closed error mapping boundary (PO-S01-C-03 / PO-S01-C-04).
 *
 * Accepts either a thrown error (`unknown`) or a structured condition (an
 * array of already-canonical kernel Findings) and always returns an
 * `ok:false` ToolResult with at least one canonical Finding. A bare exception
 * never leaks into a ToolResult, and no Finding code outside the kernel closed
 * set is ever produced.
 *
 * Structured condition inputs are verified through the REAL kernel
 * `validateFinding` (re-exported by `@proofloop/runtime`): any element that
 * fails the kernel Finding validator (unknown code, invalid severity, empty
 * message) fails the whole condition closed to a canonical
 * `RUNTIME.SCHEMA_MISMATCH` Finding — a non-canonical code can never enter a
 * ToolResult.
 */
export function toErrorResult(
  failure: unknown | readonly ValidatedFinding[],
  options?: ErrorResultOptions,
): ToolResult {
  const findings = Array.isArray(failure)
    ? validateStructuredFindings(failure)
    : [toFinding(failure)];

  return {
    ok: false,
    findings,
    refs: options?.refs ?? [],
    runtime: options?.runtime ?? UNKNOWN_RUNTIME_METADATA,
  };
}

/**
 * Verify a structured condition against the kernel Finding validator.
 *
 * An empty array and any array containing a non-canonical element fail closed
 * to a single canonical `RUNTIME.SCHEMA_MISMATCH` Finding — the kernel closed
 * set is authoritative, so malformed conditions never surface raw.
 */
function validateStructuredFindings(
  findings: readonly ValidatedFinding[],
): readonly ValidatedFinding[] {
  if (findings.length === 0) {
    return [
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message: 'Fail-closed: no structured Finding was provided.',
      },
    ];
  }
  try {
    for (const finding of findings) {
      validateFinding(finding);
    }
    return findings;
  } catch {
    return [
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'Fail-closed: structured condition contains a non-canonical Finding.',
      },
    ];
  }
}

/**
 * Project a Receipt to the `{ ref, digest }` reference shape.
 *
 * Accepts any object carrying the canonical `digest` (including a full kernel
 * Receipt) and returns ONLY the projection — the full Receipt payload,
 * timestamp, signature and other fields never enter a ToolResult.
 */
export function projectReceiptRef(
  ref: string,
  receipt: Pick<Receipt, 'digest'>,
): ReceiptRef {
  return { ref, digest: receipt.digest };
}
