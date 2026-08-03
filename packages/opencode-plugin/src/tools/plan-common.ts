/**
 * @proofloop/opencode-plugin — proofloop_plan S3 shared path/trust-root
 * boundary helpers (S03-A-T01, PO-S03-A-01).
 *
 * The compile and initialize_evidence contract layers share two fail-closed
 * boundaries:
 *
 *   - `assertPlanProjectRootArg`: the caller-supplied `project_root` is a
 *     canonical-root consistency assertion ONLY (ADR-004). A mismatch fails
 *     closed with HOST.PROJECT_NOT_TRUSTED — it never overrides the trust
 *     root, never weakens the boundary.
 *   - `reverifyPlanPaths`: TOCTOU identity re-verify (the plan-validate
 *     `reverifyResolvedPaths` pattern, CV S02-B-RECHECK-PO01-INROOT-SYMLINK-
 *     REDIRECT). Every canonical path must STILL re-resolve inside the trust
 *     root AND to the SAME canonical path immediately before the runtime
 *     read/write; an escape or an in-root symlink redirect fails closed with
 *     HOST.PATH_OUTSIDE_PROJECT.
 *
 * Every failure is a canonical kernel Finding verified through the S1
 * `toErrorResult` boundary — never a bare exception.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import { resolveWithinRoot, reverifyCanonicalPath } from '../path-boundary.js';

/** One canonical path checked by the shared TOCTOU identity re-verify. */
export interface PlanPathCheck {
  /** Host wire field name (tasks_path / manifest_path / …). */
  label: string;
  /** Canonical absolute path (already root-bound + realpath-normalized). */
  path: string;
}

/**
 * Canonical-root consistency assertion (ADR-004 / host-compatibility §trust
 * root). The caller-supplied `project_root` may only assert equality with the
 * trusted worktree root; a mismatch fails closed with
 * HOST.PROJECT_NOT_TRUSTED — it never overrides the trust root.
 *
 * Returns `null` when no assertion is present or the assertion matches;
 * otherwise a fail-closed ToolResult.
 */
export function assertPlanProjectRootArg(
  canonicalRoot: string,
  rawArgs: unknown,
): ToolResult | null {
  if (typeof rawArgs !== 'object' || rawArgs === null) {
    return null;
  }
  const args = rawArgs as Record<string, unknown>;
  const projectRootArg = args['project_root'];
  if (projectRootArg === undefined) {
    return null;
  }
  if (typeof projectRootArg !== 'string' || projectRootArg.length === 0) {
    return toErrorResult([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_plan: `project_root` must be a non-empty string when provided.',
      },
    ]);
  }
  const assertedRoot = canonicalizeRoot(projectRootArg);
  if (assertedRoot !== canonicalRoot) {
    return toErrorResult([
      {
        code: 'HOST.PROJECT_NOT_TRUSTED',
        severity: 'error',
        message:
          `proofloop_plan: project_root "${projectRootArg}" does not match the ` +
          `canonical worktree trust root (${canonicalRoot}); project_root can ` +
          'only assert consistency, never override the trust root.',
      },
    ]);
  }
  return null;
}

/**
 * TOCTOU identity re-verify (CV S02-B-RECHECK-PO01-INROOT-SYMLINK-REDIRECT).
 *
 * Every canonical path must STILL re-resolve inside the trust root AND to the
 * SAME canonical path immediately before the runtime read/write. An escape or
 * an in-root symlink redirect (a re-resolve that yields a DIFFERENT path)
 * fails closed with HOST.PATH_OUTSIDE_PROJECT naming the offending input.
 *
 * Returns `null` when every check passes, else a fail-closed ToolResult.
 */
export function reverifyPlanPaths(
  canonicalRoot: string,
  checks: readonly PlanPathCheck[],
): ToolResult | null {
  for (const check of checks) {
    const reResolved = reverifyCanonicalPath(canonicalRoot, check.path);
    if (reResolved === null) {
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
                `"${direct}" during verification (in-root symlink redirect); the ` +
                'canonical path must be read unchanged.',
        },
      ]);
    }
  }
  return null;
}

/** Canonical root normalization: realpath when possible, else resolved path. */
function canonicalizeRoot(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
