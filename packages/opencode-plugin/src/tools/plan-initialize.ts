/**
 * @proofloop/opencode-plugin — proofloop_plan(initialize_evidence) contract
 * layer (S03-A-T01, PO-S03-A-01 primary; PO-S03-A-03/PO-S03-A-04 partial;
 * PO-S03-A-03 repair: evidence-parent symlink closure).
 *
 * The initialize_evidence dispatch consumes the runtime
 * `initializeSliceEvidence` library seam IN-PROCESS (`@proofloop/runtime`
 * re-export, S03-A-T01) — never a CLI subprocess, never a copied template.
 * The initializer creates the standard Slice Evidence skeleton for every slice
 * declared in a compiled Manifest with canonical path validation, non-empty
 * skip and exclusive-create semantics (`{ created, skipped, errors }`); the
 * plugin supplies the canonical trust root as the delivery root so evidence
 * writes always stay inside the canonical worktree.
 *
 * Path boundary (contract-state-matrix.md#§1.1): `manifest_path` is required
 * for initialize_evidence; it resolves against the canonical trust root
 * (relative inside it, absolute must stay inside it); out-of-bounds →
 * HOST.PATH_OUTSIDE_PROJECT; missing/malformed → RUNTIME.SCHEMA_MISMATCH.
 * Caller `project_root` is a consistency assertion only (mismatch →
 * HOST.PROJECT_NOT_TRUSTED, `plan-common.ts`). TOCTOU identity re-verify
 * (`reverifyPlanPaths`) runs before the manifest read.
 *
 * Manifest trust boundary: the plugin reads the root-bound manifest, parses
 * JSON and passes it through the kernel `validateManifest` seam (matching the
 * CLI initializer) before calling the runtime — an unreadable / non-JSON /
 * schema-invalid manifest fails closed and never reaches the initializer
 * (no evidence write).
 *
 * Evidence-parent trust-root closure (CV S03-A|PO-S03-A-03|
 * EVIDENCE_PARENT_SYMLINK_ESCAPE, S03-A repair): the runtime initializer's
 * `canonicalEvidenceDir` / `resolvedPath` checks are LEXICAL
 * (`path.resolve`), so a symlinked evidence PARENT directory
 * (`delivery/stages/<stage>` or `.../evidence`) pointing OUTSIDE the trust
 * root passes the lexical checks and `mkdirSync`/`writeFileSync` would follow
 * the symlink and write OUTSIDE the root. The plugin closes that hole in
 * `verifyEvidencePathsWithinRoot` BEFORE any mkdir/write: every slice
 * evidence_path must resolve through `resolveWithinRoot` (which realpath-
 * checks EVERY existing ancestor component) AND resolve to the IDENTICAL
 * lexical path under the trust root (an in-root parent symlink redirect to a
 * DIFFERENT canonical path is rejected too, consistent with the S2 TOCTOU
 * identity semantics). Any violation fails closed with HOST.PATH_OUTSIDE_PROJECT
 * and the initializer never runs (no partial create, no outside write).
 *
 * Evidence owner write: initialize_evidence is an Evidence owner write — it
 * NEVER writes Receipts and never mutates `.proofloop/receipts/**` /
 * `.proofloop/runtime/**`. `refs` stay empty: no Receipt refs are produced.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { initializeSliceEvidence, validateManifest } from '@proofloop/runtime';
import type { InitializeSliceEvidenceResult } from '@proofloop/runtime';
import type { Manifest } from '@proofloop/kernel';
import { FINDINGS_BUDGET } from '../compact.js';
import { successResult, toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import { resolveWithinRoot, reverifyCanonicalPath } from '../path-boundary.js';
import { assertPlanProjectRootArg, reverifyPlanPaths } from './plan-common.js';

/** Canonical initialize_evidence inputs resolved inside the trust root. */
export interface ResolvedInitializeArgs {
  /** Absolute Manifest path inside the trust root. */
  manifestPath: string;
}

/** Outcome of the initialize path-boundary resolution (fail-closed). */
export type ResolveInitializePathsResult =
  | { ok: true; args: ResolvedInitializeArgs }
  | { ok: false; result: ToolResult };

/**
 * Resolve and bound the canonical `initialize_evidence` input path against
 * the trust root. `manifest_path` is required; relative paths resolve against
 * `canonicalRoot`; absolute paths must stay inside it (a symlink escape is
 * additionally realpath-checked by the shared resolver). Every failure is a
 * canonical kernel Finding via `toErrorResult`.
 */
export function resolveInitializePaths(
  canonicalRoot: string,
  rawArgs: unknown,
): ResolveInitializePathsResult {
  if (typeof rawArgs !== 'object' || rawArgs === null) {
    return failClosed(
      'proofloop_plan: args must be an object carrying `manifest_path`.',
    );
  }
  const args = rawArgs as Record<string, unknown>;

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

  return { ok: true, args: { manifestPath } };
}

/**
 * Project the runtime initializer result into the canonical
 * `{ created, skipped, errors }` data payload (verbatim field names, exact
 * per-path entries, original order — parity baseline with the CLI
 * initialize-slice-evidence JSON result).
 */
export function projectInitializeData(
  result: InitializeSliceEvidenceResult,
): Record<string, unknown> {
  return {
    created: [...result.created],
    skipped: [...result.skipped],
    errors: [...result.errors],
  };
}

/**
 * Build the unified ToolResult for an initializer result.
 *
 * - errors empty → ok:true with the canonical `{ created, skipped, errors }`
 *   payload (an honest PASS — nothing failed).
 * - errors non-empty → ok:false with canonical RUNTIME.SCHEMA_MISMATCH
 *   findings (message preserved, capped at FINDINGS_BUDGET, FR-012); the FULL
 *   `{ created, skipped, errors }` payload stays in `data` for parity and log
 *   traceability.
 * - refs stay empty: initialize_evidence never produces Receipt refs.
 */
export function buildInitializeToolResult(
  result: InitializeSliceEvidenceResult,
): ToolResult {
  const data = projectInitializeData(result);
  if (result.errors.length === 0) {
    return successResult({ data });
  }
  const findings = result.errors.slice(0, FINDINGS_BUDGET).map((message) => ({
    code: 'RUNTIME.SCHEMA_MISMATCH' as const,
    severity: 'error' as const,
    message,
  }));
  const base = successResult({ data, findings });
  return { ...base, ok: false };
}

/**
 * Trust-root pre-validation of every derived evidence PARENT directory BEFORE
 * the runtime initializer runs (CV S03-A|PO-S03-A-03|EVIDENCE_PARENT_SYMLINK_ESCAPE).
 *
 * The runtime initializer's `canonicalEvidenceDir` / `resolvedPath` checks are
 * LEXICAL (`path.resolve`), so a symlinked evidence PARENT directory
 * (`delivery/stages/<stage>` or `.../evidence`) pointing outside the trust
 * root passes the lexical checks and `mkdirSync` / `writeFileSync` would follow
 * the symlink and write OUTSIDE the root. This plugin-layer check closes that
 * hole BEFORE any write:
 *
 *   - for every slice, the evidence PARENT directory
 *     (`path.dirname(evidence_path)`) must resolve through `resolveWithinRoot`,
 *     which realpath-checks EVERY existing ancestor component — a parent
 *     symlink escaping the root (or a symlink chain cycle) returns `null`;
 *   - the resolved canonical parent must be IDENTICAL to the lexical parent
 *     under the trust root — an in-root parent symlink redirecting to a
 *     DIFFERENT canonical path is rejected, consistent with the S2 TOCTOU
 *     identity semantics (`reverifyCanonicalPath`).
 *
 * The FINAL evidence file component is deliberately NOT checked here: the
 * runtime initializer handles a symlinked final component by refusing to
 * overwrite it (explicit `errors` entry / non-empty skip) and never follows
 * it for a write. Only the PARENT chain can smuggle a write outside the root
 * via `mkdirSync`/parent traversal, which is what this check closes.
 *
 * A normal fixture (real or missing parents) resolves to the lexical path and
 * passes. Any violation returns a fail-closed HOST.PATH_OUTSIDE_PROJECT
 * ToolResult and the initializer never runs — no mkdir through a symlink, no
 * partial create, no outside write.
 */
export function verifyEvidencePathsWithinRoot(
  canonicalRoot: string,
  manifest: Manifest,
): ToolResult | null {
  for (const slice of manifest.slices) {
    const evidenceDir = path.dirname(slice.evidence_path);
    const lexicalDir = path.resolve(canonicalRoot, evidenceDir);
    const canonicalDir = resolveWithinRoot(canonicalRoot, evidenceDir);
    if (canonicalDir === null || canonicalDir !== lexicalDir) {
      return toErrorResult([
        {
          code: 'HOST.PATH_OUTSIDE_PROJECT',
          severity: 'error',
          message:
            `proofloop_plan: slice "${slice.slice_id}" evidence_path ` +
            `"${slice.evidence_path}" has a parent directory ("${evidenceDir}") ` +
            `that resolves through a symlinked or escaped component (canonical: ` +
            `${canonicalDir ?? '(outside root)'}, lexical: ${lexicalDir}); ` +
            'refusing to initialize evidence outside the canonical worktree ' +
            'trust root.',
        },
      ]);
    }
  }
  return null;
}

/**
 * Optional dependency seam for `runPlanInitialize`. Production callers never
 * pass it (the plan tool default handler calls `runPlanInitialize(root, args)`
 * with no deps); tests use `beforeInitialize` to deterministically inject a
 * parent swap between the static pre-check and the runtime write — the
 * documented fault-injection seam for the TOCTOU check-to-write race.
 */
export interface PlanInitializeDeps {
  /**
   * Test-only hook: runs synchronously AFTER `verifyEvidencePathsWithinRoot`
   * (the static pre-check) and IMMEDIATELY BEFORE the runtime
   * `initializeSliceEvidence` call. A test may use it to replace an evidence
   * parent with an outside symlink / in-root redirect to simulate a concurrent
   * swap; the hardened runtime (no-follow) and the plugin post-write re-verify
   * must then fail closed. Production never supplies this.
   */
  beforeInitialize?: () => void;
  /**
   * Test-only hook forwarded to the runtime initializer: runs inside the
   * runtime AFTER the no-follow parent-chain verification and IMMEDIATELY
   * BEFORE the evidence dirfd is opened. A parent swap injected here must be
   * caught by the dirfd dev/ino cross-check (round-5 race). Production never
   * supplies this.
   */
  beforeDirOpen?: () => void;
  /**
   * Test-only hook forwarded to the runtime initializer: runs inside the
   * runtime AFTER the final-component ENOENT lstat and IMMEDIATELY BEFORE the
   * `O_CREAT|O_EXCL|O_NOFOLLOW` file open. A file created here must cause the
   * exclusive open to fail (EEXIST → skip / fail closed), proving O_EXCL is
   * mutation-sensitive. Production never supplies this.
   */
  beforeFileOpen?: () => void;
}

/**
 * Post-write canonical identity re-verify over EVERY slice evidence FINAL path
 * (CV S03-A|PO-S03-A-03|EVIDENCE_PARENT_SYMLINK_ESCAPE, diagnose rounds).
 *
 * Since the runtime initializer was hardened with NO-FOLLOW semantics
 * (round 4), it never writes outside the delivery root: a symlinked/escaped
 * evidence parent fails closed inside the runtime (an `errors` entry) and the
 * run-created skeletons live only at verified real paths. This plugin-layer
 * closure adds defense-in-depth by re-verifying AFTER the initializer returns:
 *
 *   - EVERY slice's evidence PARENT directory is identity re-verified (same
 *     semantics as the pre-check — `dirname` via `resolveWithinRoot` must stay
 *     inside the root and match the lexical path): a swapped-parent
 *     skipped/success must never report success, even when `created` is empty;
 *   - every `created` file must exist at its expected lexical path: a created
 *     file whose path re-verifies identically now but is ABSENT (a parent swap
 *     restored after the runtime write) fails closed WITHOUT deleting.
 *
 * No rollback is performed here: the hardened runtime guarantees no outside
 * write, so there are no run-created outside skeletons to remove, and a
 * rollback across a swapped parent could otherwise delete a pre-existing file.
 * Any violation returns a fail-closed HOST.PATH_OUTSIDE_PROJECT Finding.
 */
export function verifyEvidenceAfterWrite(
  canonicalRoot: string,
  manifest: Manifest,
  created: readonly string[],
): ToolResult | null {
  // 1. Re-verify the FINAL evidence path's PARENT directory for EVERY slice:
  //    a swapped-parent skipped/success must never report success. The check
  //    mirrors the pre-check semantics — a symlinked FINAL component (which
  //    the initializer never follows; it refuses to overwrite) is NOT flagged,
  //    while a symlinked/escaped PARENT swapped after the pre-check IS.
  const escapedFinalPaths: string[] = [];
  for (const slice of manifest.slices) {
    const finalPath = path.resolve(canonicalRoot, slice.evidence_path);
    const evidenceDir = path.dirname(slice.evidence_path);
    const canonicalDir = resolveWithinRoot(canonicalRoot, evidenceDir);
    const lexicalDir = path.resolve(canonicalRoot, evidenceDir);
    if (canonicalDir === null || canonicalDir !== lexicalDir) {
      escapedFinalPaths.push(finalPath);
    }
  }
  if (escapedFinalPaths.length > 0) {
    return toErrorResult([
      {
        code: 'HOST.PATH_OUTSIDE_PROJECT',
        severity: 'error',
        message:
          `proofloop_plan: evidence path(s) ${escapedFinalPaths
            .map((p) => `"${p}"`)
            .join(', ')} escaped the trust root or were redirected during or ` +
          'after the write (TOCTOU parent swap). The hardened runtime writes ' +
          'no-follow, so no outside skeleton was created; a pre-existing ' +
          'outside file or directory is never deleted. Refusing to report ' +
          'evidence initialized outside the canonical worktree.',
      },
    ]);
  }

  // 2. Double-swap leak: a created file whose path re-verifies identically NOW
  //    but is absent at the expected lexical path (parent swapped and restored
  //    during the write) → fail closed WITHOUT deleting.
  const missingAtExpected = created.filter((p) => !fs.existsSync(p));
  if (missingAtExpected.length > 0) {
    return toErrorResult([
      {
        code: 'HOST.PATH_OUTSIDE_PROJECT',
        severity: 'error',
        message:
          `proofloop_plan: created evidence path(s) ${missingAtExpected
            .map((p) => `"${p}"`)
            .join(', ')} re-verify inside the trust root but the file is not ` +
          'present at that path (TOCTOU parent swap restored after the write); ' +
          'refusing to report evidence initialized outside the canonical worktree.',
      },
    ]);
  }

  return null;
}

/**
 * In-process initialize adapter: resolve + bound the manifest path, read and
 * kernel-validate the Manifest, verify every derived evidence path stays
 * inside the trust root, then run the runtime `initializeSliceEvidence`
 * library with the canonical trust root as the delivery root.
 *
 * Fail-closed ordering:
 *   1. project_root consistency assertion (mismatch → HOST.PROJECT_NOT_TRUSTED);
 *   2. path resolution (out-of-root → HOST.PATH_OUTSIDE_PROJECT, before any read);
 *   3. TOCTOU identity re-verify before the runtime read;
 *   4. read + parse + kernel `validateManifest` (fail closed, no evidence write);
 *   5. `verifyEvidencePathsWithinRoot` — evidence PARENT symlink closure
 *      (static outside-root escape / in-root redirect → HOST.PATH_OUTSIDE_PROJECT,
 *      before any mkdir/write);
 *   6. (test-only) `deps.beforeInitialize` — documented fault-injection seam;
 *   7. `initializeSliceEvidence({ manifest, deliveryRoot: canonicalRoot })`
 *      (exclusive-create, non-empty skip — the initializer never overwrites);
 *   8. `verifyCreatedEvidenceAfterWrite` — post-write canonical identity
 *      re-verify + surgical rollback of skeletons written through a
 *      concurrently-swapped parent (TOCTOU closure, diagnose round).
 *
 * initialize_evidence never writes Receipts and never touches
 * `.proofloop/runtime/**`.
 */
export function runPlanInitialize(
  canonicalRoot: string,
  rawArgs: unknown,
  deps?: PlanInitializeDeps,
): ToolResult {
  const rootAssertion = assertPlanProjectRootArg(canonicalRoot, rawArgs);
  if (rootAssertion !== null) {
    return rootAssertion;
  }
  const resolved = resolveInitializePaths(canonicalRoot, rawArgs);
  if (!resolved.ok) {
    return resolved.result;
  }
  const preRead = reverifyPlanPaths(canonicalRoot, [
    { label: 'manifest_path', path: resolved.args.manifestPath },
  ]);
  if (preRead !== null) {
    return preRead;
  }

  let manifest: Manifest;
  try {
    const raw = fs.readFileSync(resolved.args.manifestPath, 'utf-8');
    manifest = validateManifest(JSON.parse(raw));
  } catch {
    return toErrorResult([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          `proofloop_plan: manifest at ${resolved.args.manifestPath} is not ` +
          'readable, not valid JSON, or failed kernel validation; refusing to ' +
          'initialize evidence from an untrusted manifest.',
      },
    ]);
  }

  // Evidence-parent trust-root closure (CV EVIDENCE_PARENT_SYMLINK_ESCAPE):
  // every derived evidence path must resolve inside the root AND identically —
  // a symlinked/redirected parent fails closed BEFORE any mkdir/write.
  const evidenceBoundary = verifyEvidencePathsWithinRoot(canonicalRoot, manifest);
  if (evidenceBoundary !== null) {
    return evidenceBoundary;
  }

  // Documented test-only fault-injection seam (production never passes it).
  deps?.beforeInitialize?.();

  const result = initializeSliceEvidence(
    { manifest, deliveryRoot: canonicalRoot },
    { beforeDirOpen: deps?.beforeDirOpen, beforeFileOpen: deps?.beforeFileOpen },
  );

  // Post-write TOCTOU closure (diagnose rounds): re-verify EVERY slice final
  // evidence path (not just `created` — a swapped-parent skipped/success must
  // never report success). The hardened runtime writes no-follow, so no
  // rollback is needed here — any escape fails closed with
  // HOST.PATH_OUTSIDE_PROJECT.
  const postWrite = verifyEvidenceAfterWrite(canonicalRoot, manifest, result.created);
  if (postWrite !== null) {
    return postWrite;
  }

  return buildInitializeToolResult(result);
}

/** Build a canonical fail-closed boundary result (findings validated by S1). */
function failClosed(
  message: string,
  code: 'RUNTIME.SCHEMA_MISMATCH' | 'HOST.PATH_OUTSIDE_PROJECT' = 'RUNTIME.SCHEMA_MISMATCH',
): ResolveInitializePathsResult {
  return {
    ok: false,
    result: toErrorResult([{ code, severity: 'error', message }]),
  };
}
