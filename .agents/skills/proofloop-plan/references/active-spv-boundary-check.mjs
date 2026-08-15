#!/usr/bin/env node

/**
 * pluginv2 read-only Stage Plan Verifier boundary helper (active SPV).
 *
 * A closed, mechanical, read-only check that lets the read-only SPV verify
 * the canonical Stage Plan boundary WITHOUT opening an arbitrary `node -e`:
 *
 *   1. canonical Git root (realpath + `git rev-parse --show-toplevel`);
 *   2. clean worktree (`git status --porcelain=v1 --untracked-files=all`);
 *   3. HEAD snapshot equals the dispatched `--snapshot`;
 *   4. vNext Manifest is realpath-root-bound (no outside / symlink escape);
 *   5. canonical digests recomputed with the REAL @proofloop/kernel
 *      `computeDigest` loaded from <root>/packages/kernel/dist/index.js:
 *      manifest digest, plan digest (persisted), reference index digest and
 *      proof index digest (the Manifest runtime_proof field was deleted; no
 *      runtime-proof digest is checked anymore).
 *
 * Everything is closed and fail-closed:
 *   - only the flags below are accepted; unknown/missing/duplicate flags,
 *     a relative --project-root, an absolute --manifest and non-hex values
 *     are rejected;
 *   - every git/fs/kernel error fails closed;
 *   - the helper never writes a file, never executes a shell string and
 *     never accepts an arbitrary command;
 *   - digest computation always uses the kernel `computeDigest`; the helper
 *     never re-implements hashing or JSON canonicalization.
 *
 * Exit codes: 2 = CLI usage error (closed argument contract); 1 = any
 * verification/environment failure; 0 = verified. On success a single line
 * of closed JSON is written to stdout; every failure writes a single line of
 * closed JSON to stderr and never degrades.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Lowercase 40-hex Git commit snapshot shape (git emits lowercase). */
const SHA1_HEX_RE = /^[a-f0-9]{40}$/;

/** Lowercase 64-hex SHA-256 digest shape (matches kernel SHA256_HEX_RE). */
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * The closed flag contract. `kind` is validated mechanically:
 *   - absolute-path   : must be an absolute filesystem path
 *   - root-relative   : must be a non-empty root-relative path
 *   - sha1-hex        : lowercase 40-hex
 *   - sha256-hex      : lowercase 64-hex
 */
const FLAG_SPECS = Object.freeze([
  { flag: '--project-root', key: 'projectRoot', kind: 'absolute-path' },
  { flag: '--manifest', key: 'manifest', kind: 'root-relative-path' },
  { flag: '--snapshot', key: 'snapshot', kind: 'sha1-hex' },
  { flag: '--plan-digest', key: 'planDigest', kind: 'sha256-hex' },
  { flag: '--manifest-digest', key: 'manifestDigest', kind: 'sha256-hex' },
  { flag: '--reference-index-digest', key: 'referenceIndexDigest', kind: 'sha256-hex' },
  { flag: '--proof-index-digest', key: 'proofIndexDigest', kind: 'sha256-hex' },
]);

const REQUIRED_FLAGS = Object.freeze(FLAG_SPECS.map((spec) => spec.flag));

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ============================================================
// Closed argument parser (pure, testable)
// ============================================================

function validateFlagValue(kind, value) {
  if (typeof value !== 'string' || value.length === 0) {
    return `missing value`;
  }
  if (kind === 'absolute-path') {
    if (!path.isAbsolute(value)) {
      return `must be an absolute path, got "${value}"`;
    }
    return null;
  }
  if (kind === 'root-relative-path') {
    if (path.isAbsolute(value) || value.startsWith('..')) {
      return `must be a root-relative path, got "${value}"`;
    }
    return null;
  }
  if (kind === 'sha1-hex') {
    if (!SHA1_HEX_RE.test(value)) {
      return `must be a lowercase 40-hex Git snapshot, got "${value}"`;
    }
    return null;
  }
  if (kind === 'sha256-hex') {
    if (!SHA256_HEX_RE.test(value)) {
      return `must be a lowercase 64-hex SHA-256 digest, got "${value}"`;
    }
    return null;
  }
  return `unknown value kind "${kind}"`;
}

/**
 * Parse `argv` (process.argv.slice(2)) against the closed flag contract.
 * Returns `{ ok: true, args }` or `{ ok: false, error: { code, message } }`.
 * Unknown flags, positional arguments, duplicates, missing required flags
 * and invalid values all fail closed with `ARG_*` codes.
 */
export function parseArgs(argv) {
  const seen = new Set();
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const spec = FLAG_SPECS.find((entry) => entry.flag === token);
    if (spec === undefined) {
      return {
        ok: false,
        error: { code: 'ARG_UNKNOWN', message: `unknown argument "${token}"` },
      };
    }
    if (seen.has(spec.flag)) {
      return {
        ok: false,
        error: { code: 'ARG_DUPLICATE', message: `duplicate argument "${spec.flag}"` },
      };
    }
    seen.add(spec.flag);
    const value = argv[index + 1];
    const problem = validateFlagValue(spec.kind, value);
    if (problem !== null) {
      return {
        ok: false,
        error: { code: 'ARG_INVALID', message: `"${spec.flag}" ${problem}` },
      };
    }
    args[spec.key] = value;
    index += 1;
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!seen.has(flag)) {
      return {
        ok: false,
        error: { code: 'ARG_MISSING', message: `missing required argument "${flag}"` },
      };
    }
  }
  return { ok: true, args };
}

// ============================================================
// Root-bound path resolution (pure over fs, testable)
// ============================================================

/**
 * Resolve a root-relative Manifest path against an already-canonical root.
 * Fails closed on: non-relative input, missing/unreadable file, a resolved
 * path outside the root, and any symlink identity change (`realpath` differs
 * from the lexical path) — the same identity strictness the compiler's write
 * boundary uses. Returns `{ ok: true, absolute }` or
 * `{ ok: false, error: { code, message } }`.
 */
export function resolveRootBoundPath(rootReal, manifestArg) {
  if (typeof manifestArg !== 'string' || manifestArg.length === 0 || path.isAbsolute(manifestArg) || manifestArg.startsWith('..')) {
    return {
      ok: false,
      error: {
        code: 'PATH_NOT_RELATIVE',
        message: `manifest must be a root-relative path, got "${String(manifestArg)}"`,
      },
    };
  }
  const lexical = path.resolve(rootReal, manifestArg);
  let canonical;
  try {
    canonical = fs.realpathSync(lexical);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'PATH_ABSENT',
        message: `manifest "${manifestArg}" is not a readable file: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (canonical !== lexical) {
    return {
      ok: false,
      error: {
        code: 'PATH_ESCAPE',
        message: `manifest "${manifestArg}" traverses a symlink or changed identity`,
      },
    };
  }
  if (canonical === rootReal || !canonical.startsWith(`${rootReal}${path.sep}`)) {
    return {
      ok: false,
      error: {
        code: 'PATH_OUTSIDE_ROOT',
        message: `manifest "${manifestArg}" resolves outside the project root`,
      },
    };
  }
  return { ok: true, absolute: canonical };
}

// ============================================================
// Kernel computeDigest loader
// ============================================================

/**
 * Load the canonical `computeDigest` from `<root>/packages/kernel/dist/index.js`.
 * The helper must never re-implement hashing/canonicalization; if the kernel
 * module is missing or exposes no `computeDigest` function, fail closed.
 * Returns `{ ok: true, computeDigest }` or `{ ok: false, error }`.
 */
export function loadKernelComputeDigest(kernelIndexPath) {
  if (typeof kernelIndexPath !== 'string' || kernelIndexPath.length === 0 || !fs.existsSync(kernelIndexPath)) {
    return {
      ok: false,
      error: {
        code: 'KERNEL_MISSING',
        message: `kernel dist index does not exist: "${String(kernelIndexPath)}"`,
      },
    };
  }
  let mod;
  try {
    const require = createRequire(import.meta.url);
    mod = require(kernelIndexPath);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'KERNEL_LOAD_FAILED',
        message: `kernel dist index could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  const computeDigest = mod?.computeDigest ?? mod?.default?.computeDigest;
  if (typeof computeDigest !== 'function') {
    return {
      ok: false,
      error: {
        code: 'KERNEL_NO_EXPORT',
        message: `kernel dist index has no "computeDigest" export`,
      },
    };
  }
  return { ok: true, computeDigest };
}

// ============================================================
// Digest projection verification (pure, testable)
// ============================================================

/**
 * Verify every canonical digest binding of a vNext Manifest against the
 * dispatched expected digests, recomputing with the real kernel
 * `computeDigest`. Every mismatch or structural violation fails closed and
 * is reported — the caller never degrades.
 *
 * @returns {ok: true, digests} | {ok: false, mismatches: [{field, ...}]}
 */
export function verifyDigestProjections(manifest, expected, computeDigest) {
  const mismatches = [];
  const safeCompute = (field, value) => {
    try {
      return computeDigest(value);
    } catch (error) {
      mismatches.push({
        field,
        detail: `not deterministically digestible: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  };

  if (!isRecord(manifest)) {
    return {
      ok: false,
      mismatches: [{ field: 'manifest', detail: 'manifest is not a JSON object' }],
    };
  }

  const manifestDigest = safeCompute('manifest_digest', manifest);
  if (manifestDigest !== undefined && manifestDigest !== expected.manifestDigest) {
    mismatches.push({
      field: 'manifest_digest',
      expected: expected.manifestDigest,
      actual: manifestDigest,
      detail: 'recomputed manifest digest does not match --manifest-digest',
    });
  }

  const planDigest = isRecord(manifest.plan) ? manifest.plan.plan_digest : undefined;
  if (planDigest !== expected.planDigest) {
    mismatches.push({
      field: 'plan_digest',
      expected: expected.planDigest,
      actual: planDigest,
      detail: 'manifest.plan.plan_digest does not match --plan-digest',
    });
  }

  let referenceIndexDigest;
  if (isRecord(manifest.reference_index)) {
    referenceIndexDigest = safeCompute('reference_index_digest', manifest.reference_index);
    if (referenceIndexDigest !== undefined && referenceIndexDigest !== expected.referenceIndexDigest) {
      mismatches.push({
        field: 'reference_index_digest',
        expected: expected.referenceIndexDigest,
        actual: referenceIndexDigest,
        detail: 'recomputed reference_index digest does not match --reference-index-digest',
      });
    }
  } else {
    mismatches.push({
      field: 'reference_index_digest',
      detail: 'manifest.reference_index is missing or not an object',
    });
  }

  const slices = manifest.slices;
  let proofIndexDigest;
  if (Array.isArray(slices) && slices.every((slice) => isRecord(slice) && isRecord(slice.proof_index))) {
    proofIndexDigest = safeCompute('proof_index_digest', slices.map((slice) => slice.proof_index));
    if (proofIndexDigest !== undefined && proofIndexDigest !== expected.proofIndexDigest) {
      mismatches.push({
        field: 'proof_index_digest',
        expected: expected.proofIndexDigest,
        actual: proofIndexDigest,
        detail: 'recomputed slices proof_index digest does not match --proof-index-digest',
      });
    }
  } else {
    mismatches.push({
      field: 'proof_index_digest',
      detail: 'manifest.slices is not an array of proof_index objects',
    });
  }

  if (mismatches.length > 0) {
    return { ok: false, mismatches };
  }

  return {
    ok: true,
    digests: {
      manifest_digest: manifestDigest,
      plan_digest: planDigest,
      reference_index_digest: referenceIndexDigest,
      proof_index_digest: proofIndexDigest,
    },
  };
}

// ============================================================
// Git boundary checks (spawnSync, shell:false — never a shell string)
// ============================================================

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error !== undefined) {
    return { ok: false, error: `git ${args.join(' ')} failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    return { ok: false, error: `git ${args.join(' ')} exited ${result.status}${stderr ? `: ${stderr}` : ''}` };
  }
  return { ok: true, value: String(result.stdout ?? '').trim() };
}

/**
 * Verify the canonical Git boundary for a stage plan:
 *   - `git rev-parse --show-toplevel` (realpath) equals the canonical root;
 *   - `git status --porcelain=v1 --untracked-files=all` is empty;
 *   - `git rev-parse HEAD` equals the dispatched snapshot.
 * Every command failure fails closed. Returns
 * `{ ok: true, head }` or `{ ok: false, error: { code, message } }`.
 */
export function verifyGitBoundary(rootReal, snapshot) {
  const toplevel = runGit(rootReal, ['rev-parse', '--show-toplevel']);
  if (!toplevel.ok) {
    return { ok: false, error: { code: 'GIT_TOPLEVEL_FAILED', message: toplevel.error } };
  }
  let toplevelReal;
  try {
    toplevelReal = fs.realpathSync(toplevel.value);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'GIT_ROOT_MISMATCH',
        message: `git toplevel "${toplevel.value}" is not resolvable: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (toplevelReal !== rootReal) {
    return {
      ok: false,
      error: {
        code: 'GIT_ROOT_MISMATCH',
        message: `git toplevel "${toplevelReal}" does not equal the canonical project root "${rootReal}"`,
      },
    };
  }

  const status = runGit(rootReal, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status.ok) {
    return { ok: false, error: { code: 'GIT_STATUS_FAILED', message: status.error } };
  }
  if (status.value.length > 0) {
    return {
      ok: false,
      error: {
        code: 'GIT_DIRTY',
        message: `worktree is not clean; git status --porcelain=v1 --untracked-files=all reported:\n${status.value}`,
      },
    };
  }

  const head = runGit(rootReal, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    return { ok: false, error: { code: 'GIT_HEAD_FAILED', message: head.error } };
  }
  if (head.value !== snapshot) {
    return {
      ok: false,
      error: {
        code: 'SNAPSHOT_MISMATCH',
        message: `git HEAD "${head.value}" does not equal the dispatched snapshot "${snapshot}"`,
      },
    };
  }
  return { ok: true, head: head.value };
}

// ============================================================
// CLI
// ============================================================

function emitJsonError(error) {
  process.stderr.write(`${JSON.stringify({ valid: false, error })}\n`);
}

function emitSuccess(args, rootReal, head, bound, digests) {
  process.stdout.write(
    `${JSON.stringify({
      valid: true,
      project_root: rootReal,
      head,
      clean: true,
      manifest_path: bound.absolute,
      digests,
    })}\n`,
  );
}

export function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    emitJsonError(parsed.error);
    return 2;
  }
  const args = parsed.args;

  let rootReal;
  try {
    rootReal = fs.realpathSync(args.projectRoot);
  } catch (error) {
    emitJsonError({
      code: 'ROOT_NOT_RESOLVABLE',
      message: `project root "${args.projectRoot}" is not resolvable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }

  const gitBoundary = verifyGitBoundary(rootReal, args.snapshot);
  if (!gitBoundary.ok) {
    emitJsonError(gitBoundary.error);
    return 1;
  }

  const bound = resolveRootBoundPath(rootReal, args.manifest);
  if (!bound.ok) {
    emitJsonError(bound.error);
    return 1;
  }

  let raw;
  try {
    raw = fs.readFileSync(bound.absolute, 'utf8');
  } catch (error) {
    emitJsonError({
      code: 'MANIFEST_UNREADABLE',
      message: `manifest "${args.manifest}" is not readable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    emitJsonError({
      code: 'MANIFEST_INVALID_JSON',
      message: `manifest "${args.manifest}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }

  const kernel = loadKernelComputeDigest(path.join(rootReal, 'packages', 'kernel', 'dist', 'index.js'));
  if (!kernel.ok) {
    emitJsonError(kernel.error);
    return 1;
  }

  const verification = verifyDigestProjections(
    manifest,
    {
      manifestDigest: args.manifestDigest,
      planDigest: args.planDigest,
      referenceIndexDigest: args.referenceIndexDigest,
      proofIndexDigest: args.proofIndexDigest,
    },
    kernel.computeDigest,
  );
  if (!verification.ok) {
    emitJsonError({ code: 'DIGEST_MISMATCH', mismatches: verification.mismatches });
    return 1;
  }

  emitSuccess(args, rootReal, gitBoundary.head, bound, verification.digests);
  return 0;
}

// Only run the CLI when this file is executed directly; importing it (e.g.
// from the spec) must not trigger any side effect.
const IS_DIRECT_EXECUTION =
  typeof process.argv[1] === 'string' && process.argv[1].length > 0
    && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (IS_DIRECT_EXECUTION) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    emitJsonError({
      code: 'UNEXPECTED',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
