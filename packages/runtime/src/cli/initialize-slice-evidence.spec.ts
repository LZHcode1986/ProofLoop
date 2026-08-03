/**
 * @proofloop/runtime — initialize-slice-evidence no-follow write hardening
 * spec (S03-A diagnose round 4, Brain-authorized limited runtime hardening;
 * CV S03-A|PO-S03-A-03|EVIDENCE_PARENT_SYMLINK_ESCAPE).
 *
 * The runtime initializer now creates evidence with NO-FOLLOW semantics:
 *   - the evidence PARENT chain is created/verified component-by-component
 *     WITHOUT following symlinks (`ensureEvidenceDirNoFollow`) — a symlinked
 *     or non-directory parent fails closed (errors entry), so the initializer
 *     never writes outside the delivery root through a symlinked parent;
 *   - the evidence FILE is created with an atomic no-follow exclusive open
 *     (`O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`), targeting the VERIFIED
 *     physical evidence directory (not the lexical path);
 *   - PRE-EXISTING files are NEVER deleted or replaced: a non-empty file is
 *     skipped; an existing EMPTY file fails closed (the old unlink+replace is
 *     removed).
 *
 * The `{ created, skipped, errors }` output shape is unchanged (parity oracle
 * compatible).
 */

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import {
  ensureEvidenceDirNoFollow,
  initializeSliceEvidence,
} from './initialize-slice-evidence';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function sliceDef(sid: string): ManifestSlice {
  return {
    slice_id: sid,
    goal: 'goal',
    observable_outcome: 'outcome',
    public_seam: 'seam',
    dependencies: [],
    proof_obligations: [
      {
        po_id: `PO-${sid}-01`,
        behavior: 'behavior',
        public_seam: 'seam',
        oracle_source: 'oracle',
        success_criteria: 'success when X',
        required_observation: 'observe X',
        applicable_risk_facts: [],
      },
    ],
    tasks: [`${sid}-T01`],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/S03/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  };
}

function twoSliceManifest(): Manifest {
  return {
    stage_id: 'S03',
    source_path: 'delivery/stages/S03/tasks.md',
    source_digest: 'a'.repeat(64),
    stage_goal: 'goal',
    outcomes: ['OUT-01'],
    slices: [sliceDef('S03-A'), sliceDef('S03-B')],
    dependencies: [],
    risk_facts: ['public_api_change'],
  };
}

function makeRoot(prefix = 'proofloop-init-ev-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  return dir;
}

const evidencePath = (root: string, sliceId: string): string =>
  path.join(root, 'delivery', 'stages', 'S03', 'evidence', `${sliceId}.md`);

// ============================================================
// Normal semantics (unchanged output shape)
// ============================================================

describe('initialize-slice-evidence normal semantics (unchanged shape)', () => {
  it('creates the skeleton for every slice (empty evidence dir)', () => {
    const dir = makeRoot();
    const result = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(result.errors).toEqual([]);
    expect(result.created).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    for (const sid of ['S03-A', 'S03-B']) {
      const p = evidencePath(dir, sid);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, 'utf-8')).toContain(`# Slice ${sid} Evidence`);
    }
  });

  it('skips existing non-empty evidence files (bytes untouched)', () => {
    const dir = makeRoot();
    const p = evidencePath(dir, 'S03-A');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, 'PRECIOUS CONTENT', 'utf-8');
    const result = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(result.skipped).toHaveLength(1);
    expect(result.created).toHaveLength(1);
    expect(readFileSync(p, 'utf-8')).toBe('PRECIOUS CONTENT');
  });

  it('partial multi-slice: created + skipped mix', () => {
    const dir = makeRoot();
    const p = evidencePath(dir, 'S03-A');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, 'existing A\n', 'utf-8');
    const result = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('exclusive-create ownership: a second call skips everything (never overwrites)', () => {
    const dir = makeRoot();
    const first = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(first.created).toHaveLength(2);
    const bytes = new Map(
      first.created.map((p) => [p, readFileSync(p, 'utf-8')]),
    );
    const second = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(2);
    for (const [p, b] of bytes) {
      expect(readFileSync(p, 'utf-8')).toBe(b);
    }
  });
});

// ============================================================
// No-follow parent chain (round-4 hardening)
// ============================================================

describe('initialize-slice-evidence no-follow parent chain (round-4)', () => {
  it('fails closed on a symlinked `delivery/stages/S03` parent: NO outside write, nothing outside', () => {
    const dir = makeRoot();
    const outside = mkdtempSync(path.join(tmpdir(), 'proofloop-init-ev-outside-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    mkdirSync(path.join(dir, 'delivery', 'stages'), { recursive: true });
    symlinkSync(outside, path.join(dir, 'delivery', 'stages', 'S03'));

    const result = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(result.created).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('symlink');
    // Nothing was created or read outside through the symlinked parent.
    expect(readdirSync(outside)).toEqual([]);
  });

  it('fails closed on a symlinked `.../evidence` parent: nothing outside', () => {
    const dir = makeRoot();
    const outside = mkdtempSync(path.join(tmpdir(), 'proofloop-init-ev-outside-ev-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    mkdirSync(path.join(dir, 'delivery', 'stages', 'S03'), { recursive: true });
    symlinkSync(outside, path.join(dir, 'delivery', 'stages', 'S03', 'evidence'));

    const result = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(result.created).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('symlink');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('never reads, deletes or overwrites PRE-EXISTING outside files/dirs through a swapped parent', () => {
    const dir = makeRoot();
    const outside = mkdtempSync(path.join(tmpdir(), 'proofloop-init-ev-outside-pre-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    // Pre-existing NON-EMPTY outside files AND a pre-existing outside
    // evidence directory: a no-follow initializer must never read/skip/delete
    // them (the swapped parent fails closed before any file access).
    mkdirSync(path.join(outside, 'evidence'), { recursive: true });
    writeFileSync(path.join(outside, 'evidence', 'S03-A.md'), 'outside A\n', 'utf-8');
    writeFileSync(path.join(outside, 'evidence', 'S03-B.md'), 'outside B\n', 'utf-8');
    mkdirSync(path.join(dir, 'delivery', 'stages'), { recursive: true });
    symlinkSync(outside, path.join(dir, 'delivery', 'stages', 'S03'));

    const result = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]); // never read through the symlink
    expect(result.errors.length).toBeGreaterThan(0);
    // The pre-existing outside files and dir survive byte-for-byte.
    expect(readFileSync(path.join(outside, 'evidence', 'S03-A.md'), 'utf-8')).toBe('outside A\n');
    expect(readFileSync(path.join(outside, 'evidence', 'S03-B.md'), 'utf-8')).toBe('outside B\n');
    expect(readdirSync(path.join(outside, 'evidence')).sort()).toEqual(['S03-A.md', 'S03-B.md']);
  });

  it('never deletes a pre-existing EMPTY outside evidence file through a swapped parent', () => {
    const dir = makeRoot();
    const outside = mkdtempSync(path.join(tmpdir(), 'proofloop-init-ev-outside-empty-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    // Pre-existing EMPTY outside evidence file — the original initializer
    // would unlink it; the no-follow chain fails closed BEFORE any touch.
    mkdirSync(path.join(outside, 'evidence'), { recursive: true });
    writeFileSync(path.join(outside, 'evidence', 'S03-A.md'), '', 'utf-8');
    mkdirSync(path.join(dir, 'delivery', 'stages'), { recursive: true });
    symlinkSync(outside, path.join(dir, 'delivery', 'stages', 'S03'));

    const result = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(result.created).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    // The pre-existing empty file was NOT deleted (bytes preserved).
    expect(existsSync(path.join(outside, 'evidence', 'S03-A.md'))).toBe(true);
    expect(readFileSync(path.join(outside, 'evidence', 'S03-A.md'), 'utf-8')).toBe('');
  });
});

// ============================================================
// No-follow final component + empty-file fail-closed
// ============================================================

describe('initialize-slice-evidence no-follow final component (round-4)', () => {
  it('refuses to overwrite a symlinked FINAL component (inside root), symlink untouched', () => {
    const dir = makeRoot();
    const realFile = path.join(dir, 'real-evidence.md');
    writeFileSync(realFile, '# real\n', 'utf-8');
    mkdirSync(path.join(dir, 'delivery', 'stages', 'S03', 'evidence'), { recursive: true });
    symlinkSync(realFile, evidencePath(dir, 'S03-A'));

    const result = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('symlink'))).toBe(true);
    // The symlink itself and its target are untouched.
    expect(fs.lstatSync(evidencePath(dir, 'S03-A')).isSymbolicLink()).toBe(true);
    expect(readFileSync(realFile, 'utf-8')).toBe('# real\n');
  });

  it('fails closed on an existing EMPTY evidence file (pre-existing files are never replaced)', () => {
    const dir = makeRoot();
    const p = evidencePath(dir, 'S03-A');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '', 'utf-8');
    const result = initializeSliceEvidence({ manifest: twoSliceManifest(), deliveryRoot: dir });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('empty file');
    // The valid sibling slice is still created; the empty file survives
    // (never unlinked/replaced).
    expect(result.created).toHaveLength(1);
    expect(readFileSync(p, 'utf-8')).toBe('');
  });
});

// ============================================================
// ensureEvidenceDirNoFollow unit checks
// ============================================================

describe('ensureEvidenceDirNoFollow ownership tracking', () => {
  it('creates a missing chain and records createdByRun=true for the evidence dir', () => {
    const dir = makeRoot();
    const evidenceDir = path.join(dir, 'delivery', 'stages', 'S03', 'evidence');
    const r = ensureEvidenceDirNoFollow(dir, evidenceDir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ownership.createdByRun).toBe(true);
      expect(r.ownership.physicalDir).toBe(evidenceDir);
      expect(fs.statSync(evidenceDir).isDirectory()).toBe(true);
    }
  });

  it('records createdByRun=false for a pre-existing evidence dir (never removed by cleanup)', () => {
    const dir = makeRoot();
    const evidenceDir = path.join(dir, 'delivery', 'stages', 'S03', 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    const r = ensureEvidenceDirNoFollow(dir, evidenceDir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ownership.createdByRun).toBe(false);
    }
  });

  it('fails closed on a symlinked parent component', () => {
    const dir = makeRoot();
    const outside = mkdtempSync(path.join(tmpdir(), 'proofloop-init-ev-unit-out-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    mkdirSync(path.join(dir, 'delivery', 'stages'), { recursive: true });
    symlinkSync(outside, path.join(dir, 'delivery', 'stages', 'S03'));
    const r = ensureEvidenceDirNoFollow(
      dir,
      path.join(dir, 'delivery', 'stages', 'S03', 'evidence'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('symlink');
    }
  });
});

// ============================================================
// Round-5 dirfd root fix: injected race / O_EXCL mutation
// ============================================================

describe('initialize-slice-evidence round-5 dirfd root fix', () => {
  it('a parent swap injected between chain verification and dirfd open is caught by the dev/ino cross-check (nothing outside)', () => {
    const dir = makeRoot();
    const outside = mkdtempSync(path.join(tmpdir(), 'proofloop-init-ev-r5-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    // Pre-existing OUTSIDE evidence files: the race must never touch them.
    mkdirSync(path.join(outside, 'evidence'), { recursive: true });
    writeFileSync(path.join(outside, 'evidence', 'S03-A.md'), '# outside A\n', 'utf-8');
    writeFileSync(path.join(outside, 'evidence', 'S03-B.md'), '# outside B\n', 'utf-8');
    mkdirSync(path.join(dir, 'delivery', 'stages', 'S03'), { recursive: true });

    const result = initializeSliceEvidence(
      { manifest: twoSliceManifest(), deliveryRoot: dir },
      {
        beforeDirOpen: () => {
          // The race: parent swapped AFTER the chain verification, BEFORE the
          // dirfd open. The dirfd fstat must mismatch the walk-captured inode.
          rmSync(path.join(dir, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
          symlinkSync(outside, path.join(dir, 'delivery', 'stages', 'S03'));
        },
      },
    );
    expect(result.created).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/swapped between verification and open|dev\/ino mismatch/);
    // The outside files were never read or written.
    expect(readFileSync(path.join(outside, 'evidence', 'S03-A.md'), 'utf-8')).toBe('# outside A\n');
    expect(readFileSync(path.join(outside, 'evidence', 'S03-B.md'), 'utf-8')).toBe('# outside B\n');
  });

  it('O_EXCL is mutation-sensitive: a file created between lstat and the exclusive open is SKIPPED, never truncated', () => {
    const dir = makeRoot();
    const concurrentPath = path.join(dir, 'delivery', 'stages', 'S03', 'evidence', 'S03-A.md');

    const result = initializeSliceEvidence(
      { manifest: twoSliceManifest(), deliveryRoot: dir },
      {
        beforeFileOpen: () => {
          // A concurrent writer creates the file after the ENOENT lstat, right
          // before the O_EXCL open. Without O_EXCL the file would be truncated;
          // with O_EXCL the open fails (EEXIST → skip).
          mkdirSync(path.dirname(concurrentPath), { recursive: true });
          writeFileSync(concurrentPath, 'concurrent writer\n', 'utf-8');
        },
      },
    );
    expect(result.errors).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.created).toHaveLength(1);
    // The concurrent file survives byte-for-byte (never truncated by the run).
    expect(readFileSync(concurrentPath, 'utf-8')).toBe('concurrent writer\n');
  });
});
