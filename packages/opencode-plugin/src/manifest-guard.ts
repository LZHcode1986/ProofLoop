/**
 * @proofloop/opencode-plugin — Manifest content trust-root guard (S2 review
 * finding S2-F-001, OUT-S2-01/03).
 *
 * The S2 stage/review tools only re-verify the caller-supplied `manifest_path`
 * / `tasks_path` ARGUMENTS (parse + reverify). The runtime then derives its
 * read paths from manifest CONTENT fields:
 *
 *   - `slice.evidence_path` is joined to `projectRoot` by `gitSource` and
 *     `NextActionService.buildExtras` (`path.join(projectRoot, evidence_path)`
 *     → `fs.readFileSync` / `fs.existsSync`);
 *   - `slice.slice_id` is joined into the receipt category directories by
 *     `reconcileStage` (`receiptCategoryDir(root, category, stageId, sliceId)`).
 *
 * The kernel `validateManifest` only requires these fields to be STRINGS, so a
 * schema-valid malicious manifest can smuggle `../../`, absolute paths or path
 * separators into them and redirect a runtime read OUTSIDE the canonical
 * worktree trust root. This guard is the plugin-layer trust-root fail-closed
 * check: before the runtime is called, every path-deriving content field is
 * validated so no runtime read can escape the worktree.
 *
 * Semantics (shared with `path-boundary.ts`, CV S02-B-INITIAL-PO01-SYMLINK):
 * `resolveWithinRoot` walks every existing ancestor component and realpath-
 * checks it, so `..` escapes, absolute escapes AND symlink escapes are all
 * rejected — a symlinked evidence directory/file pointing outside the root
 * fails closed even when the final target exists.
 *
 * The guard is deliberately shared by `proofloop_stage` (status/next) and
 * `proofloop_review(stage_status)` (which delegates to the stage status
 * handler), so the two S2 tools cannot drift on the same malicious fixture.
 *
 * TOCTOU post-check (S2-F-001 round 2): the runtime re-reads the manifest and
 * the evidence files AFTER the pre-check. `reverifyManifestContentAfterRead`
 * is the same-layer post-read closure as the existing `reverifyCanonicalPath`
 * reverify — the plugin re-reads the manifest after the runtime call and
 * compares the canonical content digest and the per-slice evidence path
 * resolutions against the pre-read baseline. Any change (manifest replaced,
 * evidence path redirected / symlinked away) fails closed and DISCARDS the
 * runtime result. Residual window: a double-swap that restores the original
 * file between the runtime read and the post-check read is the same honest
 * Node/OS TOCTOU limitation already recorded for `reverifyCanonicalPath`.
 */

import { readFileSync } from 'node:fs';
import { canonicalManifestDigest, validateManifest } from '@proofloop/runtime';
import type { Manifest } from '@proofloop/kernel';
import { toErrorResult } from './tool-result.js';
import type { ToolResult } from './tool-result.js';
import { resolveWithinRoot, reverifyCanonicalPath } from './path-boundary.js';

/**
 * Canonical slice id pattern (compile-manifest canonical form, e.g. S02-A).
 *
 * A canonical slice id can never contain a path separator (`/`, `\`), a `..`
 * segment or an absolute prefix, so the runtime's `receiptCategoryDir`
 * joins stay inside the trust root. The pattern mirrors the existing stage-id
 * canonical guard style (S02-A `CANONICAL_STAGE_ID` = `/^S\d+$/`).
 */
export const CANONICAL_SLICE_ID = /^S\d{2,}-[A-Z]$/;

/**
 * Pre-read baseline of the path-deriving manifest content fields, captured by
 * `checkManifestContentBaseline` and compared by the TOCTOU post-check
 * `reverifyManifestContentAfterRead`.
 */
export interface ManifestContentBaseline {
  /**
   * Canonical manifest content digest (SHA-256 over the canonical JSON — the
   * runtime's `canonicalManifestDigest`). ANY content change between the pre
   * and post reads (manifest replaced) fails the post-check.
   */
  readonly digest: string;
  /**
   * Pre-resolved canonical evidence path per `slice_id` (the resolved value of
   * `resolveWithinRoot(projectRoot, evidence_path)`). The post-check requires
   * IDENTITY per slice — an evidence path re-resolving to a DIFFERENT path
   * (symlink redirect / new symlink escape) fails the post-check.
   */
  readonly evidencePaths: ReadonlyMap<string, string>;
}

/** Outcome of the content baseline check (fail-closed). */
export type ManifestContentCheckResult =
  | { ok: true; baseline: ManifestContentBaseline }
  | { ok: false; result: ToolResult };

/**
 * Validate the manifest CONTENT fields the runtime derives read paths from
 * (per-slice `evidence_path` and `slice_id`) and capture the pre-read
 * baseline used by the TOCTOU post-check.
 *
 * Fail-closed — the guard NEVER calls the runtime:
 *   - manifest unreadable / invalid JSON        → DOMAIN.STAGE_NOT_FOUND
 *     (the same canonical condition the runtime manifest source raises);
 *   - manifest fails kernel schema validation   → RUNTIME.SCHEMA_MISMATCH;
 *   - a slice `evidence_path` that resolves
 *     outside the trust root (`..`, absolute,
 *     symlink escape)                           → HOST.PROJECT_NOT_TRUSTED;
 *   - a non-canonical `slice_id` (path
 *     separators, `..`, absolute)               → HOST.PROJECT_NOT_TRUSTED.
 */
export function checkManifestContentBaseline(
  projectRoot: string,
  manifestPath: string,
): ManifestContentCheckResult {
  // 1. Read + parse. A manifest that cannot be read cannot be trusted to
  //    derive ANY path — fail closed before the runtime (same canonical code
  //    as the runtime manifest source: DOMAIN.STAGE_NOT_FOUND).
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return {
      ok: false,
      result: toErrorResult([
        {
          code: 'DOMAIN.STAGE_NOT_FOUND',
          severity: 'error',
          message:
            `proofloop_stage: manifest at ${manifestPath} is not readable or not ` +
            'valid JSON; refusing to trust manifest content path fields.',
        },
      ]),
    };
  }

  // 2. Kernel schema validation (the runtime would reject a schema-invalid
  //    manifest too, but the guard must not trust malformed content either).
  let manifest: Manifest;
  try {
    manifest = validateManifest(parsed);
  } catch {
    return {
      ok: false,
      result: toErrorResult([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            `proofloop_stage: manifest at ${manifestPath} failed schema ` +
            'validation; refusing to trust manifest content path fields.',
        },
      ]),
    };
  }

  // 3. Per-slice content checks (the path-deriving fields only) + baseline.
  const evidencePaths = new Map<string, string>();
  for (const slice of manifest.slices) {
    // 3a. slice_id — canonical pattern rejects separators / `..` / absolute.
    if (!CANONICAL_SLICE_ID.test(slice.slice_id)) {
      return {
        ok: false,
        result: toErrorResult([
          {
            code: 'HOST.PROJECT_NOT_TRUSTED',
            severity: 'error',
            message:
              `proofloop_stage: manifest slice_id "${slice.slice_id}" is not a ` +
              'canonical slice id (expected /^S\\d{2,}-[A-Z]$/, e.g. S02-A); path ' +
              'traversal / absolute paths are rejected before any runtime read.',
          },
        ]),
      };
    }
    // 3b. evidence_path — must resolve inside the trust root (component-wise
    //     realpath walk rejects `..` / absolute / symlink escapes).
    const resolved = resolveWithinRoot(projectRoot, slice.evidence_path);
    if (resolved === null) {
      return {
        ok: false,
        result: toErrorResult([
          {
            code: 'HOST.PROJECT_NOT_TRUSTED',
            severity: 'error',
            message:
              `proofloop_stage: manifest slice "${slice.slice_id}" evidence_path ` +
              `"${slice.evidence_path}" resolves outside the trust root ` +
              `(${projectRoot}); rejected before any runtime read.`,
          },
        ]),
      };
    }
    evidencePaths.set(slice.slice_id, resolved);
  }

  return {
    ok: true,
    baseline: {
      digest: canonicalManifestDigest(parsed),
      evidencePaths,
    },
  };
}

/**
 * Pre-read-only content guard (S2-F-001 round 1 API): validate the manifest
 * content fields WITHOUT capturing a baseline. Returns `null` when every
 * path-deriving content field stays inside the trust root, else a fail-closed
 * ToolResult (ok:false with a canonical kernel Finding).
 */
export function validateManifestContentFields(
  projectRoot: string,
  manifestPath: string,
): ToolResult | null {
  const result = checkManifestContentBaseline(projectRoot, manifestPath);
  return result.ok ? null : result.result;
}

/**
 * Post-read TOCTOU check (S2-F-001 round 2): re-read the manifest AFTER the
 * runtime call and require the path-deriving content to be UNCHANGED relative
 * to the pre-read `baseline`.
 *
 * Fail-closed (the runtime result is DISCARDED):
 *   - the manifest is now unreadable / schema-invalid / malicious
 *     (the re-check itself fails)            → its fail-closed result;
 *   - the canonical manifest content digest changed (the manifest file was
 *     replaced during the runtime call)      → HOST.PROJECT_NOT_TRUSTED;
 *   - a slice's evidence path re-resolves to a DIFFERENT canonical path (an
 *     evidence symlink redirect / new symlink escape appeared mid-call)
 *                                             → HOST.PROJECT_NOT_TRUSTED.
 *
 * @returns `null` when the manifest content and every evidence path are
 *          unchanged, else a fail-closed ToolResult.
 */
export function reverifyManifestContentAfterRead(
  projectRoot: string,
  manifestPath: string,
  baseline: ManifestContentBaseline,
): ToolResult | null {
  const after = checkManifestContentBaseline(projectRoot, manifestPath);
  if (!after.ok) {
    // The manifest is no longer trusted — the runtime read may have consumed
    // a swapped file, so the runtime result cannot be trusted either.
    return after.result;
  }

  if (after.baseline.digest !== baseline.digest) {
    return toErrorResult([
      {
        code: 'HOST.PROJECT_NOT_TRUSTED',
        severity: 'error',
        message:
          'proofloop_stage: manifest content changed during the read (TOCTOU); ' +
          'the runtime result is discarded.',
      },
    ]);
  }

  if (after.baseline.evidencePaths.size !== baseline.evidencePaths.size) {
    return toErrorResult([
      {
        code: 'HOST.PROJECT_NOT_TRUSTED',
        severity: 'error',
        message:
          'proofloop_stage: manifest slice set changed during the read (TOCTOU); ' +
          'the runtime result is discarded.',
      },
    ]);
  }
  for (const [sliceId, prePath] of baseline.evidencePaths) {
    const postPath = after.baseline.evidencePaths.get(sliceId);
    if (postPath !== prePath) {
      return toErrorResult([
        {
          code: 'HOST.PROJECT_NOT_TRUSTED',
          severity: 'error',
          message:
            `proofloop_stage: manifest slice "${sliceId}" evidence path was ` +
            'redirected during the read (TOCTOU); the runtime result is discarded.',
        },
      ]);
    }
  }

  return null;
}

/**
 * Manifest-path canonical identity check (S2-F-001 round 3).
 *
 * The content TOCTOU closure (pre-baseline + post-check) compares the manifest
 * CONTENT, so a manifest path swapped to an external symlink BEFORE the
 * baseline is captured would make the baseline / runtime / post-check all read
 * the SAME external manifest (identical digest) and pass the content checks.
 * This identity check re-verifies the manifest PATH itself (same semantics as
 * the S2-A `reverifyStagePaths` reverify) and must be applied:
 *
 *   1. BEFORE `checkManifestContentBaseline` — closes the window between
 *      `reverifyStagePaths` and the baseline read; the returned canonical path
 *      is the path the baseline is read FROM;
 *   2. AFTER `reverifyManifestContentAfterRead` — a path swapped after the
 *      post-check read discards the runtime result.
 *
 * @returns `{ ok: true, path }` with the identity-verified canonical manifest
 *          path (the path the baseline/runtime/post-check must read from), or
 *          `{ ok: false, result }` (HOST.PATH_OUTSIDE_PROJECT) when the path
 *          was redirected or escaped during verification.
 */
export function reverifyManifestPathIdentity(
  projectRoot: string,
  manifestPath: string,
): { ok: true; path: string } | { ok: false; result: ToolResult } {
  const canonical = reverifyCanonicalPath(projectRoot, manifestPath);
  if (canonical === null) {
    return {
      ok: false,
      result: toErrorResult([
        {
          code: 'HOST.PATH_OUTSIDE_PROJECT',
          severity: 'error',
          message:
            `proofloop_stage: manifest_path "${manifestPath}" was redirected or ` +
            'escaped during verification (TOCTOU); the canonical manifest path ' +
            'must be read unchanged.',
        },
      ]),
    };
  }
  return { ok: true, path: canonical };
}
