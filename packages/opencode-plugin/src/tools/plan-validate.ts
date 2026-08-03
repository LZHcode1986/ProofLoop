/**
 * @proofloop/opencode-plugin — proofloop_plan(validate) contract layer
 * (AWI-007 / AWI-013, PO-S02-B-01/02/03).
 *
 * S02-B-T01: exposes the existing validate-stage library semantics as a public
 * runtime seam and defines the `validate` path-boundary, canonical payload and
 * Finding projection that T02 wires into the real `Hooks.tool.proofloop_plan`
 * definition.
 *
 * Runtime seam: `validateStage` is consumed IN-PROCESS through the
 * `@proofloop/runtime` re-export — never a CLI subprocess, never a parser
 * copy. The CLI canonical payload `{ valid, stage_id, errors }` is the parity
 * baseline (S02-D deep-equal), so the ToolResult `data` preserves it verbatim.
 *
 * Path boundary (contract-state-matrix.md#§1.1): `tasks_path` (required),
 * `manifest_path` (required) and optional `evidence_dir` resolve against the
 * canonical trust root. Relative paths resolve inside it; absolute paths must
 * stay inside it; out-of-bounds → HOST.PATH_OUTSIDE_PROJECT; missing or
 * malformed inputs → RUNTIME.SCHEMA_MISMATCH (fail-closed, same style as S02-A
 * `parseStageArgs` / `resolveWithinRoot`).
 *
 * Canonical payload & Finding projection: ToolResult `data` preserves
 * `valid` / `stage_id` / `errors` with the exact `{ type, message, sliceId? }`
 * error shape and original order for parity comparison. Every invalid error
 * maps to a canonical kernel Finding (RUNTIME.SCHEMA_MISMATCH, severity error,
 * message preserved, order preserved). valid → ok:true with EMPTY findings
 * (never a fake PASS); invalid → ok:false with non-empty findings. `refs` stay
 * empty — validate is read-only and produces no Receipt refs.
 *
 * T01 does NOT register the plan tool and does NOT implement `execute`; the
 * operation rejection (S2 accepts only `validate`) is delivered by T02's host
 * tool definition. This module is a pure, dependency-light contract layer.
 */

import { validateStage } from '@proofloop/runtime';
import type { ValidateStageResult, ValidatedFinding } from '@proofloop/runtime';
import { successResult, toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import { resolveWithinRoot, reverifyCanonicalPath } from '../path-boundary.js';
import { FINDINGS_BUDGET } from '../compact.js';

/** The ONLY S2 plan operation (contract-state-matrix.md#§1.1). */
export const PLAN_VALIDATE_OPERATION = 'validate' as const;

/**
 * Plan operations that are NOT implemented in S2 (contract-state-matrix.md#§1.1:
 * compile / initialize_evidence / admit_spv_result are later-slice operations).
 * The S2 plan tool rejects every non-`validate` operation at the execute
 * boundary (T02) so a write-capable branch is never smuggled through.
 */
export const PLAN_FORBIDDEN_OPERATIONS = [
  'compile',
  'initialize_evidence',
  'admit_spv_result',
] as const;

/** Canonical validate inputs resolved inside the trust root. */
export interface ResolvedValidateArgs {
  /** Absolute tasks.md path inside the trust root. */
  tasksPath: string;
  /** Absolute manifest.json path inside the trust root. */
  manifestPath: string;
  /** Absolute evidence directory inside the trust root (optional). */
  evidenceDir?: string;
}

/** Outcome of the path-boundary resolution (fail-closed). */
export type ResolveValidatePathsResult =
  | { ok: true; args: ResolvedValidateArgs }
  | { ok: false; result: ToolResult };

/**
 * Resolve and bound the three canonical `validate` input paths against the
 * trust root.
 *
 * - `tasks_path` is required; `manifest_path` is required (mirrors the CLI
 *   usage `<tasks.md> <manifest.json> [evidence-dir]` and the §1.1 input
 *   contract); `evidence_dir` is optional.
 * - Relative paths resolve against `canonicalRoot`; absolute paths must stay
 *   inside it (a symlink escape is additionally realpath-checked).
 * - Every failure is a canonical kernel Finding verified through the S1
 *   `toErrorResult` boundary — never a bare exception.
 */
export function resolveValidatePaths(
  canonicalRoot: string,
  rawArgs: unknown,
): ResolveValidatePathsResult {
  if (typeof rawArgs !== 'object' || rawArgs === null) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_plan: args must be an object carrying `tasks_path` and `manifest_path`.',
      },
    ]);
  }
  const args = rawArgs as Record<string, unknown>;

  const tasksArg = args['tasks_path'];
  if (typeof tasksArg !== 'string' || tasksArg.length === 0) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_plan: `tasks_path` is required and must be a non-empty string.',
      },
    ]);
  }
  const tasksPath = resolveWithinRoot(canonicalRoot, tasksArg);
  if (tasksPath === null) {
    return failClosed([
      {
        code: 'HOST.PATH_OUTSIDE_PROJECT',
        severity: 'error',
        message:
          `proofloop_plan: tasks_path "${tasksArg}" resolves outside the trust ` +
          `root (${canonicalRoot}).`,
      },
    ]);
  }

  const manifestArg = args['manifest_path'];
  if (typeof manifestArg !== 'string' || manifestArg.length === 0) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_plan: `manifest_path` is required and must be a non-empty string.',
      },
    ]);
  }
  const manifestPath = resolveWithinRoot(canonicalRoot, manifestArg);
  if (manifestPath === null) {
    return failClosed([
      {
        code: 'HOST.PATH_OUTSIDE_PROJECT',
        severity: 'error',
        message:
          `proofloop_plan: manifest_path "${manifestArg}" resolves outside the ` +
          `trust root (${canonicalRoot}).`,
      },
    ]);
  }

  let evidenceDir: string | undefined;
  const evidenceArg = args['evidence_dir'];
  if (evidenceArg !== undefined) {
    if (typeof evidenceArg !== 'string' || evidenceArg.length === 0) {
      return failClosed([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'proofloop_plan: `evidence_dir` must be a non-empty string when provided.',
        },
      ]);
    }
    const resolvedEvidence = resolveWithinRoot(canonicalRoot, evidenceArg);
    if (resolvedEvidence === null) {
      return failClosed([
        {
          code: 'HOST.PATH_OUTSIDE_PROJECT',
          severity: 'error',
          message:
            `proofloop_plan: evidence_dir "${evidenceArg}" resolves outside the ` +
            `trust root (${canonicalRoot}).`,
        },
      ]);
    }
    evidenceDir = resolvedEvidence;
  }

  return {
    ok: true,
    args: {
      tasksPath,
      manifestPath,
      ...(evidenceDir !== undefined ? { evidenceDir } : {}),
    },
  };
}

/**
 * Project the canonical `ValidateStageResult` into the ToolResult `data`
 * payload.
 *
 * `valid` / `stage_id` / `errors` are preserved verbatim — exact CLI field
 * names, exact `{ type, message, sliceId? }` error shape, original order — so
 * a parity assertion can deep-equal the plugin payload against the CLI JSON
 * output (S02-D).
 */
export function projectValidateData(
  result: ValidateStageResult,
): Record<string, unknown> {
  return {
    valid: result.valid,
    stage_id: result.stage_id,
    errors: result.errors.map((e) =>
      e.sliceId !== undefined
        ? { type: e.type, message: e.message, sliceId: e.sliceId }
        : { type: e.type, message: e.message },
    ),
  };
}

/**
 * Project every invalid error into a canonical kernel Finding.
 *
 * Each error maps to `RUNTIME.SCHEMA_MISMATCH` (the canonical fail-closed code
 * for structured validation mismatches in the kernel closed set), severity
 * `error`, message preserved, order preserved. A valid result yields NO
 * findings (never a fake PASS finding).
 */
export function projectValidateFindings(
  result: ValidateStageResult,
): readonly ValidatedFinding[] {
  if (result.valid) {
    return [];
  }
  return result.errors.map((e) => ({
    code: 'RUNTIME.SCHEMA_MISMATCH',
    severity: 'error',
    message: e.message,
  }));
}

/**
 * Build the unified ToolResult for a validate result.
 *
 * - valid=true → ok:true with EMPTY findings and the canonical data payload
 *   (honest PASS — the payload itself carries `valid: true`).
 * - valid=false → ok:false with non-empty canonical findings capped at
 *   FINDINGS_BUDGET (FR-012 ≤ 20) at the ToolResult layer; the FULL canonical
 *   payload stays in `data` (errors complete, order preserved) so parity and
 *   log traceability are never truncated. A defensively-malformed invalid
 *   result with zero errors still yields at least one canonical Finding.
 * - refs stay empty: validate is read-only and never produces Receipt refs.
 */
export function buildValidateToolResult(
  result: ValidateStageResult,
): ToolResult {
  const data = projectValidateData(result);
  if (result.valid) {
    return successResult({ data });
  }
  const projected = projectValidateFindings(result);
  const capped = projected.slice(0, FINDINGS_BUDGET);
  const findings: readonly ValidatedFinding[] =
    capped.length > 0
      ? capped
      : [
          {
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message:
              'validate-stage reported invalid without structured errors.',
          },
        ];
  const base = successResult({ data, findings });
  return { ...base, ok: false };
}

/**
 * In-process adapter seam: resolve + bound the validate inputs and run the
 * runtime `validateStage` library directly.
 *
 * This is the library seam T02 wires into the host tool `execute`; it never
 * starts the CLI and never parses CLI stdout. Path-boundary failures fail
 * closed before any file read; the runtime result is projected through
 * `buildValidateToolResult`.
 *
 * TOCTOU narrowing: after the first resolve, the resolved paths are RE-VERIFIED
 * against the trust root immediately before the runtime read. Combined with
 * `resolveWithinRoot` returning REALPATH-normalized canonical paths for
 * existing targets, a symlink swapped into an escape between the two passes
 * fails closed instead of silently redirecting the read. Residual TOCTOU (a
 * swap between the re-verify and the open itself) is a Node/OS inherent window
 * and is honestly recorded as a limitation.
 */
export function runPlanValidate(
  canonicalRoot: string,
  rawArgs: unknown,
): ToolResult {
  const resolved = resolveValidatePaths(canonicalRoot, rawArgs);
  if (!resolved.ok) {
    return resolved.result;
  }
  const reverified = reverifyResolvedPaths(canonicalRoot, resolved.args);
  if (reverified !== null) {
    return reverified;
  }
  const result = validateStage(
    resolved.args.tasksPath,
    resolved.args.manifestPath,
    resolved.args.evidenceDir,
  );
  return buildValidateToolResult(result);
}

/**
 * Re-verify every resolved validate path against the trust root immediately
 * before the runtime read (TOCTOU narrowing, CV S02-B-RECHECK-PO01-INROOT-
 * SYMLINK-REDIRECT).
 *
 * Returns `null` when all paths still resolve inside the root AND each
 * re-resolved path is IDENTICAL to the canonical first-resolve path; otherwise
 * a fail-closed ToolResult with HOST.PATH_OUTSIDE_PROJECT naming the offending
 * input.
 *
 * The identity check closes the in-root symlink redirect: a swapped canonical
 * path that re-resolves to a DIFFERENT path — even when the alternate target
 * is still inside the root — is rejected, because the runtime read would
 * otherwise silently open the alternate file and break canonical parity.
 */
export function reverifyResolvedPaths(
  canonicalRoot: string,
  args: ResolvedValidateArgs,
): ToolResult | null {
  const checks: ReadonlyArray<{ label: string; path: string }> = [
    { label: 'tasks_path', path: args.tasksPath },
    { label: 'manifest_path', path: args.manifestPath },
    ...(args.evidenceDir !== undefined
      ? [{ label: 'evidence_dir', path: args.evidenceDir }]
      : []),
  ];
  for (const check of checks) {
    const reResolved = reverifyCanonicalPath(canonicalRoot, check.path);
    if (reResolved === null) {
      // Either the path escaped the root entirely, or it re-resolved to a
      // DIFFERENT canonical path (in-root symlink redirect).
      const direct = resolveWithinRoot(canonicalRoot, check.path);
      return toErrorResult([
        {
          code: 'HOST.PATH_OUTSIDE_PROJECT',
          severity: 'error',
          message:
            direct === null
              ? `proofloop_plan: ${check.label} "${check.path}" escaped the trust ` +
                `root (${canonicalRoot}) during verification (TOCTOU).`
              : `proofloop_plan: ${check.label} "${check.path}" was redirected to ` +
                `"${direct}" during verification (in-root symlink redirect); ` +
                'the canonical path must be read unchanged.',
        },
      ]);
    }
  }
  return null;
}

/** Build a canonical fail-closed boundary result (findings validated by S1). */
function failClosed(
  findings: readonly ValidatedFinding[],
): ResolveValidatePathsResult {
  return { ok: false, result: toErrorResult(findings) };
}
