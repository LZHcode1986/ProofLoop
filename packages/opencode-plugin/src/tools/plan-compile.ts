/**
 * @proofloop/opencode-plugin — proofloop_plan(compile) contract layer
 * (S03-A-T01/T02, PO-S03-A-01 primary; PO-S03-A-02/PO-S03-A-04).
 *
 * The compile dispatch consumes the runtime `compileManifest` library seam
 * IN-PROCESS (`@proofloop/runtime` re-export, S03-A-T01) — never a CLI
 * subprocess, never a parser copy. `compileManifest(tasksPath)` reads the
 * Stage tasks.md, compiles it into a canonical Manifest and passes it through
 * the kernel `validateManifest` seam BEFORE returning, so only a kernel-valid
 * Manifest is ever produced (fail closed: an invalid tasks file throws and no
 * artifact is written).
 *
 * Path boundary (contract-state-matrix.md#§1.1): `tasks_path` and
 * `manifest_path` are required for compile; both resolve against the canonical
 * trust root (relative inside it, absolute must stay inside it); out-of-bounds
 * → HOST.PATH_OUTSIDE_PROJECT; missing/malformed → RUNTIME.SCHEMA_MISMATCH.
 * Caller `project_root` is a consistency assertion only (mismatch →
 * HOST.PROJECT_NOT_TRUSTED, `plan-common.ts`). TOCTOU identity re-verify
 * (`reverifyPlanPaths`) runs before the runtime read AND immediately before
 * the Manifest write.
 *
 * Manifest owner write: the plugin writes the kernel-valid Manifest JSON to
 * the root-bound `manifest_path` (the CLI writes the output file itself; the
 * plugin reuses the same semantics through a root-bound path). compile is a
 * Manifest/Evidence owner write — it NEVER writes Receipts and never mutates
 * `.proofloop/receipts/**` / `.proofloop/runtime/**`.
 *
 * Canonical data projection (T02, parity baseline = CLI `compile-manifest`):
 * `{ stage_id, source_digest, manifest_digest, manifest_ref }` — the traceable
 * stage id, the tasks.md source digest, the canonical Manifest content digest
 * (`canonicalManifestDigest` — identical to `manifestFileDigest` of the WRITTEN
 * file, since the plugin writes the very object `compileManifest` returned)
 * and the ROOT-BOUND RELATIVE Manifest artifact ref (`path.relative` from the
 * trust root to the written file, the canonical artifact reference form).
 * `refs` stay empty: compile produces no Receipt refs.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { canonicalManifestDigest, compileManifest } from '@proofloop/runtime';
import type { Manifest } from '@proofloop/kernel';
import { successResult, toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import { resolveWithinRoot } from '../path-boundary.js';
import { assertPlanProjectRootArg, reverifyPlanPaths } from './plan-common.js';

/** Canonical compile inputs resolved inside the trust root. */
export interface ResolvedCompileArgs {
  /** Absolute tasks.md path inside the trust root. */
  tasksPath: string;
  /** Absolute output Manifest path inside the trust root. */
  manifestPath: string;
}

/** Outcome of the compile path-boundary resolution (fail-closed). */
export type ResolveCompilePathsResult =
  | { ok: true; args: ResolvedCompileArgs }
  | { ok: false; result: ToolResult };

/**
 * Resolve and bound the two canonical `compile` input paths against the trust
 * root. `tasks_path` and `manifest_path` are both required; relative paths
 * resolve against `canonicalRoot`; absolute paths must stay inside it (a
 * symlink escape is additionally realpath-checked by the shared resolver).
 * Every failure is a canonical kernel Finding via `toErrorResult`.
 */
export function resolveCompilePaths(
  canonicalRoot: string,
  rawArgs: unknown,
): ResolveCompilePathsResult {
  if (typeof rawArgs !== 'object' || rawArgs === null) {
    return failClosed(
      'proofloop_plan: args must be an object carrying `tasks_path` and `manifest_path`.',
    );
  }
  const args = rawArgs as Record<string, unknown>;

  const tasksArg = args['tasks_path'];
  if (typeof tasksArg !== 'string' || tasksArg.length === 0) {
    return failClosed(
      'proofloop_plan: `tasks_path` is required and must be a non-empty string.',
    );
  }
  const tasksPath = resolveWithinRoot(canonicalRoot, tasksArg);
  if (tasksPath === null) {
    return failClosed(
      `proofloop_plan: tasks_path "${tasksArg}" resolves outside the trust root ` +
        `(${canonicalRoot}).`,
      'HOST.PATH_OUTSIDE_PROJECT',
    );
  }

  const manifestArg = args['manifest_path'];
  if (typeof manifestArg !== 'string' || manifestArg.length === 0) {
    return failClosed(
      'proofloop_plan: `manifest_path` is required and must be a non-empty string.',
    );
  }
  const manifestPath = resolveWithinRoot(canonicalRoot, manifestArg);
  if (manifestPath === null) {
    return failClosed(
      `proofloop_plan: manifest_path "${manifestArg}" resolves outside the trust ` +
        `root (${canonicalRoot}).`,
      'HOST.PATH_OUTSIDE_PROJECT',
    );
  }

  return { ok: true, args: { tasksPath, manifestPath } };
}

/**
 * Project the compiled Manifest into the canonical compile `data` payload:
 * traceable `stage_id`, `source_digest` (tasks.md), `manifest_digest`
 * (canonical Manifest content digest via the runtime
 * `canonicalManifestDigest` seam — identical to `manifestFileDigest` of the
 * WRITTEN file) and `manifest_ref` (the ROOT-BOUND RELATIVE path from the
 * trust root to the written output Manifest artifact).
 */
export function projectCompileData(
  manifest: Manifest,
  manifestRef: string,
): Record<string, unknown> {
  return {
    stage_id: manifest.stage_id,
    source_digest: manifest.source_digest,
    manifest_digest: canonicalManifestDigest(manifest),
    manifest_ref: manifestRef,
  };
}

/**
 * In-process compile adapter: resolve + bound the compile inputs, run the
 * runtime `compileManifest` library directly, and write the kernel-valid
 * Manifest to the root-bound output path.
 *
 * Fail-closed ordering:
 *   1. project_root consistency assertion (mismatch → HOST.PROJECT_NOT_TRUSTED);
 *   2. path resolution (out-of-root → HOST.PATH_OUTSIDE_PROJECT, before any read);
 *   3. TOCTOU identity re-verify before the runtime read;
 *   4. `compileManifest` (invalid tasks → canonical Finding, NO write);
 *   5. TOCTOU identity re-verify of the output path before the write;
 *   6. root-bound mkdir + Manifest write (kernel-valid only — `compileManifest`
 *      already ran `validateManifest`, so no invalid artifact is ever published).
 *
 * compile never writes Receipts and never touches `.proofloop/runtime/**`.
 */
export function runPlanCompile(
  canonicalRoot: string,
  rawArgs: unknown,
): ToolResult {
  const rootAssertion = assertPlanProjectRootArg(canonicalRoot, rawArgs);
  if (rootAssertion !== null) {
    return rootAssertion;
  }
  const resolved = resolveCompilePaths(canonicalRoot, rawArgs);
  if (!resolved.ok) {
    return resolved.result;
  }
  const preRead = reverifyPlanPaths(canonicalRoot, [
    { label: 'tasks_path', path: resolved.args.tasksPath },
    { label: 'manifest_path', path: resolved.args.manifestPath },
  ]);
  if (preRead !== null) {
    return preRead;
  }

  let manifest: Manifest;
  try {
    manifest = compileManifest(resolved.args.tasksPath);
  } catch (error) {
    // Invalid / unreadable tasks file: `compileManifest` already failed closed
    // through the kernel `validateManifest` seam — no Manifest is written.
    return toErrorResult(error);
  }

  const preWrite = reverifyPlanPaths(canonicalRoot, [
    { label: 'manifest_path', path: resolved.args.manifestPath },
  ]);
  if (preWrite !== null) {
    return preWrite;
  }

  try {
    fs.mkdirSync(path.dirname(resolved.args.manifestPath), { recursive: true });
    fs.writeFileSync(
      resolved.args.manifestPath,
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  } catch (error) {
    return toErrorResult(error);
  }

  return successResult({
    data: projectCompileData(
      manifest,
      path.relative(canonicalRoot, resolved.args.manifestPath),
    ),
  });
}

/** Build a canonical fail-closed boundary result (findings validated by S1). */
function failClosed(
  message: string,
  code: 'RUNTIME.SCHEMA_MISMATCH' | 'HOST.PATH_OUTSIDE_PROJECT' = 'RUNTIME.SCHEMA_MISMATCH',
): ResolveCompilePathsResult {
  return {
    ok: false,
    result: toErrorResult([{ code, severity: 'error', message }]),
  };
}
