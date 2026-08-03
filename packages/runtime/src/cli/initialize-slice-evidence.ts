/**
 * initialize-slice-evidence — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Creates the standard Slice Evidence skeleton files for every slice
 * declared in a compiled Manifest. Legacy-compatible contract:
 *
 *   node packages/runtime/dist/cli/initialize-slice-evidence.js <manifest-path> [delivery-root]
 *
 * Security (fail closed):
 *  - the manifest is validated through the kernel `validateManifest` seam;
 *  - evidence paths must match the canonical pattern
 *    `delivery/stages/<stage-id>/evidence/<slice-id>.md` and resolve inside
 *    the stage evidence directory (no path traversal, no symlink targets);
 *  - existing non-empty evidence files are never overwritten; creation uses
 *    exclusive-create so concurrent writers cannot clobber.
 *
 * No-follow write hardening (S03-A diagnose round 4, Brain-authorized limited
 * runtime hardening; CV S03-A|PO-S03-A-03|EVIDENCE_PARENT_SYMLINK_ESCAPE):
 *  - the evidence PARENT directory chain is created/verified component-by-
 *    component WITHOUT following symlinks: an existing symlinked or
 *    non-directory parent component fails closed (an `errors` entry) and the
 *    slice is skipped — the initializer never writes outside the delivery root
 *    through a symlinked parent;
 *  - the evidence FILE is created with an atomic no-follow exclusive open
 *    (`O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`), so the final component is
 *    never followed (a symlink at open time → ELOOP → fail closed) and the
 *    skeleton is guaranteed to be created only by this run (O_EXCL);
 *  - the open targets the VERIFIED physical evidence directory (the no-follow
 *    walk result), never the lexical path, so a parent swap between the walk
 *    and the open cannot redirect the write;
 *  - PRE-EXISTING files are NEVER deleted or replaced: a non-empty file is
 *    skipped; an existing EMPTY file is conservatively fail-closed with an
 *    `errors` entry (the original empty-file unlink+replace is removed — a
 *    pre-existing outside file touched by the creation flow is never consumed);
 *  - the physical directory ownership (whether this run created the evidence
 *    dir and its realpath identity) is tracked per slice; a rollback/cleanup
 *    may only remove a directory whose physical identity matches the recorded
 *    one AND is now empty — a swap-introduced or pre-existing physical
 *    directory is never deleted.
 *
 * Output: JSON `{ created, skipped, errors }`; exit 0 no errors / 1 errors.
 * The output shape and the `InitializeSliceEvidenceOptions` /
 * `InitializeSliceEvidenceResult` interfaces are UNCHANGED (parity oracle
 * compatible).
 *
 * Zero host dependencies: Node builtins + `@proofloop/kernel` only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateManifest } from '@proofloop/kernel';
import type { Manifest } from '@proofloop/kernel';

// ============================================================
// Shapes
// ============================================================

export interface InitializeSliceEvidenceOptions {
  /** Kernel-validated Manifest. */
  readonly manifest: Manifest;
  /** Delivery root — evidence paths resolve under it (default cwd). */
  readonly deliveryRoot?: string;
}

export interface InitializeSliceEvidenceResult {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Test-only hooks for `initializeSliceEvidence` (round-5). Production callers
 * never pass them; tests use them to deterministically inject a concurrent
 * parent swap / concurrent file creation at the exact TOCTOU windows:
 *  - `beforeDirOpen`: called immediately AFTER the no-follow parent-chain
 *    verification and IMMEDIATELY BEFORE the evidence dirfd is opened — a
 *    parent swap injected here must be caught by the dirfd dev/ino
 *    cross-check (the opened fd would fstat to a different inode);
 *  - `beforeFileOpen`: called immediately AFTER the final-component ENOENT
 *    lstat and IMMEDIATELY BEFORE the `O_CREAT|O_EXCL|O_NOFOLLOW` file open — a
 *    file created here must cause the exclusive open to fail (EEXIST → skip /
 *    fail closed), proving the O_EXCL protection is mutation-sensitive.
 */
export interface InitializeEvidenceTestHooks {
  beforeDirOpen?: () => void;
  beforeFileOpen?: () => void;
}

/** Per-slice physical evidence-directory ownership record (round-4/5). */
export interface EvidenceDirOwnership {
  /** Realpath of the physical evidence directory used by this run. */
  readonly physicalDir: string;
  /** True when this run created the evidence directory (it did not exist). */
  readonly createdByRun: boolean;
  /**
   * dev/ino of the evidence directory captured during the no-follow walk
   * (round-5): the dirfd opened afterwards must fstat to the SAME identity —
   * a parent swap between the walk and the open is detected and fails closed.
   */
  readonly dev: number;
  readonly ino: number;
}

// ============================================================
// Skeleton
// ============================================================

function generateEvidenceSkeleton(
  sliceId: string,
  stageId: string,
  sliceGoal: string,
  publicSeam: string,
  manifestDigest: string,
): string {
  return `# Slice ${sliceId} Evidence

## Slice Context

- Slice ID: ${sliceId}
- Stage ID: ${stageId}
- Slice Goal: ${sliceGoal}
- Public Seam: ${publicSeam}
- Manifest Digest: ${manifestDigest}

## Task Evidence

*No tasks have been executed yet.*

## Current Slice Evidence

### Snapshot

*Not yet captured.*

### Proof Obligation Coverage

| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |
|---|---|---|---|---|
| *None* | | | | |

### Changed Files

*No changes yet.*

### Verification Commands

*Not yet run.*

### Actual Observations

*Not yet observed.*

### Limitations

*None identified.*

## Current CV Status

- Status: NOT_RUN
- Level: *Not yet determined*
- Latest CV Receipt: *None*
- Open Finding: *None*
`;
}

// ============================================================
// No-follow evidence directory chain
// ============================================================

/** Atomic no-follow exclusive-create flags for evidence FILE creation. */
const CREATE_NOFOLLOW_EXCL_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

/**
 * Outcome of `ensureEvidenceDirNoFollow`.
 * `ok:false` carries a machine reason plus the offending component; the caller
 * formats the `errors` entry with the slice id.
 */
export type EnsureEvidenceDirResult =
  | { ok: true; ownership: EvidenceDirOwnership }
  | {
      ok: false;
      reason: 'not-under-root' | 'symlink' | 'not-directory' | 'create-failed';
      component: string;
      message: string;
    };

/**
 * Create/verify the evidence parent directory chain component-by-component
 * WITHOUT following symlinks (S03-A diagnose round 4).
 *
 * - walks `delivery/stages/<stage>/evidence` below `deliveryRoot`; a MISSING
 *   component is created with a plain (non-recursive) `mkdirSync` — a fresh
 *   directory cannot be a symlink;
 * - an EXISTING component is `lstat`-checked: a symlink (or anything that is
 *   not a directory) fails closed — the initializer NEVER writes through a
 *   symlinked parent, so a swapped/escaped parent cannot smuggle a write
 *   outside the delivery root;
 * - returns the PHYSICAL evidence directory realpath and whether THIS run
 *   created it (physical directory ownership tracking). A rollback/cleanup
 *   may only remove a directory whose physical identity matches the recorded
 *   `physicalDir` AND is now empty — a swap-introduced or pre-existing
 *   physical directory is never deleted by this module.
 */
export function ensureEvidenceDirNoFollow(
  deliveryRoot: string,
  evidenceDir: string,
): EnsureEvidenceDirResult {
  const rel = path.relative(deliveryRoot, evidenceDir);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      reason: 'not-under-root',
      component: evidenceDir,
      message: `evidence directory "${evidenceDir}" is not under the delivery root "${deliveryRoot}"`,
    };
  }
  const parts = rel.split(path.sep).filter((p) => p.length > 0);
  let current = deliveryRoot;
  let createdByRun = false;
  let dev = -1;
  let ino = -1;
  for (let i = 0; i < parts.length; i += 1) {
    const candidate = path.join(current, parts[i]);
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(candidate);
    } catch {
      try {
        fs.mkdirSync(candidate);
      } catch (err) {
        return {
          ok: false,
          reason: 'create-failed',
          component: candidate,
          message:
            `cannot create evidence parent "${candidate}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (i === parts.length - 1) {
        createdByRun = true;
        // A freshly created directory cannot be a symlink; capture its
        // physical identity for the dirfd cross-check.
        const fresh = fs.statSync(candidate);
        dev = fresh.dev;
        ino = fresh.ino;
      }
      current = candidate;
      continue;
    }
    if (lst.isSymbolicLink()) {
      return {
        ok: false,
        reason: 'symlink',
        component: candidate,
        message: `evidence parent "${candidate}" is a symlink — refusing to write through a symlinked parent (no-follow)`,
      };
    }
    if (!lst.isDirectory()) {
      return {
        ok: false,
        reason: 'not-directory',
        component: candidate,
        message: `evidence parent "${candidate}" is not a directory`,
      };
    }
    if (i === parts.length - 1) {
      // Capture the VERIFIED evidence directory's physical identity at walk
      // time (round-5): the dirfd opened afterwards must match this dev/ino.
      dev = lst.dev;
      ino = lst.ino;
    }
    current = candidate;
  }
  return { ok: true, ownership: { physicalDir: current, createdByRun, dev, ino } };
}

// ============================================================
// Main initializer
// ============================================================

const EVIDENCE_PATH_RE = /^delivery\/stages\/(S\d[\w-]*)\/evidence\/(S\d{2,}-[A-Z])\.md$/;

/** Canonical digest used to bind the skeleton to the manifest. */
function manifestDigest(manifest: Manifest): string {
  return require('node:crypto')
    .createHash('sha256')
    .update(JSON.stringify(manifest, Object.keys(manifest).sort(), 2), 'utf-8')
    .digest('hex');
}

/**
 * Initialize Slice Evidence files for all slices in a compiled Manifest.
 *
 * For each slice:
 *  1. evidence_path must match the canonical pattern;
 *  2. the resolved path must stay inside the stage evidence directory;
 *  3. the evidence PARENT chain is created/verified NO-FOLLOW (a symlinked
 *     parent fails closed — never write outside the delivery root);
 *  4. the evidence FILE is created with an atomic no-follow exclusive open;
 *  5. existing non-empty files are skipped; existing EMPTY files are NEVER
 *     deleted or replaced (conservative fail-closed `errors` entry).
 *
 * The output `{ created, skipped, errors }` shape is unchanged (parity oracle).
 */
export function initializeSliceEvidence(
  options: InitializeSliceEvidenceOptions,
  testHooks?: InitializeEvidenceTestHooks,
): InitializeSliceEvidenceResult {
  const manifest = options.manifest;
  const deliveryRoot = path.resolve(options.deliveryRoot ?? process.cwd());
  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  let digest: string;
  try {
    digest = manifestDigest(manifest);
  } catch (err) {
    errors.push(`Manifest digest computation failed: ${err instanceof Error ? err.message : String(err)}`);
    return { created, skipped, errors };
  }

  const canonicalEvidenceDir = path.resolve(
    deliveryRoot,
    'delivery',
    'stages',
    manifest.stage_id,
    'evidence',
  );

  // Round-5 root fix: the evidence directory handle (dirfd) is opened once on
  // the VERIFIED physical evidence dir; ALL file operations go through
  // `/proc/self/fd/<fd>/<name>`, which atomically binds to the opened inode —
  // a parent rename/swap after the open cannot redirect any read/write, and a
  // swap BEFORE the open is caught by the dev/ino cross-check.
  let dirHandle: { dirfd: number; procPrefix: string } | null = null;

  for (const slice of manifest.slices) {
    const evidencePath = slice.evidence_path;
    if (!evidencePath) {
      errors.push(`Slice "${slice.slice_id}" has no evidence_path in manifest`);
      continue;
    }
    const match = evidencePath.match(EVIDENCE_PATH_RE);
    if (!match || match[1] !== manifest.stage_id || match[2] !== slice.slice_id) {
      errors.push(
        `Slice "${slice.slice_id}" evidence_path "${evidencePath}" does not match ` +
          `the canonical pattern "delivery/stages/${manifest.stage_id}/evidence/${slice.slice_id}.md"`,
      );
      continue;
    }
    const resolvedPath = path.resolve(deliveryRoot, evidencePath);
    const resolvedDir = path.dirname(resolvedPath);
    if (resolvedDir !== canonicalEvidenceDir) {
      errors.push(
        `Slice "${slice.slice_id}" evidence_path "${evidencePath}" resolves to "${resolvedPath}" ` +
          `outside the stage evidence directory "${canonicalEvidenceDir}" — path traversal rejected`,
      );
      continue;
    }
    // No-follow evidence parent chain (round-4): a symlinked/escaped parent
    // fails closed BEFORE any file read/write through it.
    const chain = ensureEvidenceDirNoFollow(deliveryRoot, canonicalEvidenceDir);
    if (!chain.ok) {
      errors.push(
        `Slice "${slice.slice_id}" ${chain.message}`,
      );
      continue;
    }
    // Open the VERIFIED physical evidence directory handle once (round-5). The
    // fd keeps the inode binding — a later parent rename/swap cannot change
    // what it points to. The fstat dev/ino cross-check against the walk-captured
    // identity closes the walk-to-open swap window.
    if (dirHandle === null) {
      // Documented test-only seam: inject a parent swap between the chain
      // verification and the dirfd open — the dev/ino cross-check must catch it.
      testHooks?.beforeDirOpen?.();
      try {
        const dirfd = fs.openSync(
          chain.ownership.physicalDir,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        );
        const st = fs.fstatSync(dirfd);
        if (st.dev !== chain.ownership.dev || st.ino !== chain.ownership.ino) {
          fs.closeSync(dirfd);
          errors.push(
            `Slice "${slice.slice_id}" evidence directory "${chain.ownership.physicalDir}" ` +
              'was swapped between verification and open (dev/ino mismatch); refusing to ' +
              'write outside the delivery root',
          );
          continue;
        }
        dirHandle = { dirfd, procPrefix: `/proc/self/fd/${dirfd}` };
      } catch (err) {
        errors.push(
          `Slice "${slice.slice_id}" cannot open evidence directory "${chain.ownership.physicalDir}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }
    const name = path.basename(resolvedPath);
    const procPath = `${dirHandle.procPrefix}/${name}`;

    // Final component check through the dirfd-relative path (never the lexical
    // path): a symlink final component is refused, and a pre-existing file is
    // never read through a swapped path — everything binds to the opened inode.
    try {
      const stat = fs.lstatSync(procPath);
      if (stat.isSymbolicLink()) {
        errors.push(`Slice "${slice.slice_id}" evidence path "${resolvedPath}" is a symlink — refusing to overwrite`);
        continue;
      }
      if (stat.isDirectory()) {
        errors.push(`Slice "${slice.slice_id}" evidence path "${resolvedPath}" is a directory`);
        continue;
      }
      const content = fs.readFileSync(procPath, 'utf-8');
      if (content.trim().length > 0) {
        skipped.push(resolvedPath);
        continue;
      }
      // Existing EMPTY file: pre-existing files are NEVER deleted or replaced
      // (round-4 no-follow hardening) — conservatively fail closed.
      errors.push(
        `Slice "${slice.slice_id}" evidence path "${resolvedPath}" exists as an empty file; ` +
          'pre-existing files are never deleted or replaced (no-follow) — refusing to touch',
      );
      continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(
          `Slice "${slice.slice_id}" cannot inspect evidence path "${resolvedPath}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      // ENOENT: the file does not exist — create it below.
    }

    const skeleton = generateEvidenceSkeleton(
      slice.slice_id,
      manifest.stage_id,
      slice.goal,
      slice.public_seam,
      digest,
    );
    // Documented test-only seam: inject a concurrent file creation between the
    // ENOENT lstat and the exclusive open — O_EXCL must fail (EEXIST → skip /
    // fail closed) rather than truncate the concurrent file.
    testHooks?.beforeFileOpen?.();
    try {
      const fd = fs.openSync(procPath, CREATE_NOFOLLOW_EXCL_FLAGS);
      try {
        fs.writeSync(fd, skeleton, null, 'utf-8');
      } finally {
        fs.closeSync(fd);
      }
      created.push(resolvedPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        try {
          const existing = fs.readFileSync(procPath, 'utf-8');
          if (existing.trim().length > 0) {
            skipped.push(resolvedPath);
          } else {
            errors.push(`Slice "${slice.slice_id}" race: empty file created concurrently at "${resolvedPath}"`);
          }
        } catch {
          errors.push(`Slice "${slice.slice_id}" TOCTOU race writing evidence file "${resolvedPath}"`);
        }
      } else if (code === 'ELOOP') {
        errors.push(`Slice "${slice.slice_id}" evidence path "${resolvedPath}" is a symlink at open time (no-follow) — refusing to write`);
      } else {
        errors.push(`Slice "${slice.slice_id}" failed to write evidence file "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (dirHandle !== null) {
    try {
      fs.closeSync(dirHandle.dirfd);
    } catch {
      /* best-effort */
    }
  }
  return { created, skipped, errors };
}

// ============================================================
// CLI entry
// ============================================================

/**
 * Legacy-compatible CLI:
 *   node dist/cli/initialize-slice-evidence.js <manifest-path> [delivery-root]
 */
export function initializeSliceEvidenceCli(argv: readonly string[]): number {
  const [manifestPath, deliveryRoot] = argv;
  if (!manifestPath) {
    console.error('Usage: node dist/cli/initialize-slice-evidence.js <manifest-path> [delivery-root]');
    console.error('');
    console.error('Creates Slice Evidence skeletons for every slice of a compiled Manifest.');
    console.error('Existing non-empty evidence files are never overwritten.');
    return 1;
  }
  let manifest: Manifest;
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    manifest = validateManifest(JSON.parse(content));
  } catch (err) {
    console.error(`Failed to load manifest: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const result = initializeSliceEvidence({ manifest, deliveryRoot });
  for (const created of result.created) console.log(`Created: ${created}`);
  for (const skipped of result.skipped) console.log(`Skipped (existing): ${skipped}`);
  for (const err of result.errors) console.error(`Error: ${err}`);
  console.log(JSON.stringify({ created: result.created, skipped: result.skipped, errors: result.errors }));
  return result.errors.length > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = initializeSliceEvidenceCli(process.argv.slice(2));
}
