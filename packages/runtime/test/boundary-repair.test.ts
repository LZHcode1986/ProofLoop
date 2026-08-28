/**
 * Boundary Policy repair regression tests.
 *
 * Covers (per task):
 *  - P0 slice A/B isolation (a parallel Slice's declared dirty output is
 *    tolerated but NEVER committable by the current Slice boundary);
 *  - strict dirty gate (scope-external dirty -> SCOPE_VIOLATION, HEAD/index
 *    unchanged);
 *  - stage-plan manifest_digest required+validated;
 *  - stage-close missing Gate/Review preflight;
 *  - slice-output wrong/missing expected_head;
 *  - artifact-archive rename happy path / extra staged / invalid
 *    source-destination / hook failure;
 *  - workflow-contract-update .pi exact-path scope;
 *  - the closed BOUNDARY.* error codes (HEAD_MISMATCH, INDEX_NOT_EMPTY,
 *    SCOPE_VIOLATION, NO_CHANGES, RENAME_INVALID, COMMIT_FAILED, ...).
 *
 * Imports the compiled runtime dist (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { makeFixture, commitAll, porcelain, sha, type Fixture } from './helpers';
import { persistValidManifest, buildValidManifest } from './manifest-fixture';
import {
  closeGitBoundary,
  GitBoundaryError,
  assertStageCloseTipBindings,
  isSliceEvidenceFinalized,
} from '../dist/index';
import {
  loadSliceCommitPolicy,
  validateSliceCommitChangedFiles,
  SliceCommitPolicyError,
  type SliceCommitPolicyFacts,
  type SliceCommitPolicy,
} from '../dist/index';

/** Assert that calling fn throws a SliceCommitPolicyError with the given code. */
function expectPolicyCode(fn: () => unknown, code: SliceCommitPolicyError['code']): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SliceCommitPolicyError) {
      assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
      return error.message;
    }
    throw error;
  }
  assert.fail(`expected SliceCommitPolicyError ${code}, but no error was thrown`);
}

/** Assert that calling fn throws a GitBoundaryError with the given code. */
function expectBoundaryCode(fn: () => unknown, code: GitBoundaryError['code']): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof GitBoundaryError) {
      assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
      return error.message;
    }
    throw error;
  }
  assert.fail(`expected GitBoundaryError ${code}, but no error was thrown`);
}

// ---------------------------------------------------------------------------
// Helpers to build a minimal-but-valid policy object (no Runtime fixture).
// ---------------------------------------------------------------------------

function basePolicyFacts(overrides: Partial<SliceCommitPolicyFacts>): SliceCommitPolicyFacts {
  return {
    root: '/repo',
    stageId: 'S01',
    sliceId: 'S01-sliceA',
    manifestDigest: sha('manifest'),
    planDigest: sha('plan'),
    snapshotDigest: 'a'.repeat(40),
    cvReceiptDigest: sha('cv'),
    allowedPaths: ['delivery/stages/S01/a.txt'],
    otherSliceDeclaredFiles: [],
    forbiddenPaths: ['.proofloop', '.git'],
    workerChangedFiles: ['delivery/stages/S01/a.txt'],
    hasRepairHistory: false,
    ...overrides,
  };
}

function basePolicy(overrides: Partial<SliceCommitPolicyFacts> = {}): SliceCommitPolicy {
  return loadSliceCommitPolicy(basePolicyFacts(overrides));
}

// ---------------------------------------------------------------------------
// P0: slice A/B isolation (policy layer).
// ---------------------------------------------------------------------------

describe('slice A/B isolation (P0)', () => {
  test('a parallel Slice declared file is NOT committable by the current Slice', () => {
    const policy = basePolicy({
      allowedPaths: ['delivery/stages/S01/a.txt'],
      otherSliceDeclaredFiles: ['delivery/stages/S01/b.txt'],
      workerChangedFiles: ['delivery/stages/S01/a.txt'],
    });
    // The current Slice's allowedPaths must NOT carry the other Slice's file.
    assert.ok(!policy.allowedPaths.includes('delivery/stages/S01/b.txt'));
    assert.deepEqual(policy.otherSliceDeclaredFiles, ['delivery/stages/S01/b.txt']);
    // A changed set that includes the other Slice file must be REJECTED.
    expectPolicyCode(
      () =>
        validateSliceCommitChangedFiles(policy, ['delivery/stages/S01/a.txt', 'delivery/stages/S01/b.txt'], {
          phase: 'pre-commit',
        }),
      'RUNTIME.SCHEMA_MISMATCH',
    );
  });

  test('the current Slice file is accepted and other-Slice files stay out of the commit', () => {
    const policy = basePolicy({
      allowedPaths: ['delivery/stages/S01/a.txt'],
      otherSliceDeclaredFiles: ['delivery/stages/S01/b.txt'],
      workerChangedFiles: ['delivery/stages/S01/a.txt'],
    });
    const changed = validateSliceCommitChangedFiles(policy, ['delivery/stages/S01/a.txt'], { phase: 'pre-commit' });
    assert.deepEqual(changed, ['delivery/stages/S01/a.txt']);
  });
});

// ---------------------------------------------------------------------------
// Strict dirty gate + BOUNDARY.* codes (temp Git fixture, no Runtime).
// ---------------------------------------------------------------------------

describe('closeGitBoundary strict dirty gate', () => {
  test('scope-external dirty path -> SCOPE_VIOLATION, HEAD/index unchanged (exact type)', () => {
    const f = makeFixture();
    try {
      f.write('in-scope.txt', 'one');
      f.write('out-of-scope.txt', 'two');
      commitAll(f, 'base');
      // Dirty two files; boundary declares only the in-scope one.
      f.write('in-scope.txt', 'changed-in');
      f.write('out-of-scope.txt', 'changed-out');
      const headBefore = f.head();
      const msg = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'direct-fix',
            paths: ['in-scope.txt'],
            expected_head: headBefore,
            description: 'strict gate',
          }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      assert.match(msg, /out-of-scope.txt/);
      // HEAD unchanged and neither file was staged or committed.
      assert.equal(f.head(), headBefore);
      assert.match(porcelain(f), /M  in-scope| M in-scope/);
      assert.match(porcelain(f), /out-of-scope/);
    } finally {
      f.cleanup();
    }
  });

  test('wrong expected_head -> HEAD_MISMATCH (exact type, no write)', () => {
    const f = makeFixture();
    try {
      f.write('f.txt', 'x');
      commitAll(f, 'base');
      f.write('f.txt', 'y');
      const headBefore = f.head();
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'direct-fix',
            paths: ['f.txt'],
            expected_head: 'a'.repeat(40),
            description: 'head',
          }),
        'BOUNDARY.HEAD_MISMATCH',
      );
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });

  test('declared-but-clean path -> NO_CHANGES (exact type)', () => {
    const f = makeFixture();
    try {
      f.write('f.txt', 'x');
      commitAll(f, 'base');
      const headBefore = f.head();
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'direct-fix',
            paths: ['f.txt'],
            expected_head: headBefore,
            description: 'nochange',
          }),
        'BOUNDARY.NO_CHANGES',
      );
    } finally {
      f.cleanup();
    }
  });

  test('slice-output requires expected_head -> REQUEST_INVALID (fails before any Runtime/Git work)', () => {
    const f = makeFixture();
    try {
      f.write('.proofloop/.gitkeep', '');
      commitAll(f, 'base');
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'slice-output',
            stage: 'S01',
            slice: 'S01-sliceA',
            cv_receipt_digest: sha('cv'),
            // no expected_head
          }),
        'BOUNDARY.REQUEST_INVALID',
      );
    } finally {
      f.cleanup();
    }
  });

  test('workflow-contract-update accepts .pi/brain-workflow.md and .pi/agents, rejects arbitrary .pi', () => {
    const f = makeFixture();
    try {
      f.write('.pi/brain-workflow.md', 'workflow');
      f.write('.pi/agents/worker.md', 'agent');
      commitAll(f, 'base');
      // Dirty the approved .pi files so the boundary has changes to commit.
      f.write('.pi/brain-workflow.md', 'workflow v2');
      f.write('.pi/agents/worker.md', 'agent v2');
      const headBefore = f.head();
      // Arbitrary .pi file is rejected by the exact-path policy.
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'workflow-contract-update',
            paths: ['.pi/anything-else.md'],
            expected_head: headBefore,
            description: 'pi scope',
          }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      // An approved .pi path is accepted by the scope policy.
      const declared = ['.pi/brain-workflow.md', '.pi/agents/worker.md'];
      const result = closeGitBoundary(f.dir, {
        boundary_type: 'workflow-contract-update',
        paths: declared,
        expected_head: headBefore,
        description: 'pi scope',
      });
      assert.deepEqual([...result.changed_files].sort(), [...declared].sort());
      assert.equal(result.dirty_after, false);
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// artifact-archive: Brain pre-stages the exact rename; the CLI validates+commits.
// ---------------------------------------------------------------------------

function archiveSourceDest(stage: string, oldDigest: string): { src: string; dst: string } {
  return {
    src: `delivery/stages/${stage}/invalidated-plan.md`,
    dst: `delivery/stages/${stage}/invalidated-plan.${oldDigest}.md`,
  };
}

describe('artifact-archive rename validation', () => {
  test('happy path: Brain pre-staged rename is validated and committed', () => {
    const f = makeFixture();
    try {
      const oldDigest = sha('old');
      const { src, dst } = archiveSourceDest('S01', oldDigest);
      f.write(src, 'artifact content');
      commitAll(f, 'base');
      // Brain pre-executes the exact git mv (the CLI must NOT run git mv).
      f.run(['mv', src, dst]);
      const headBefore = f.head();
      const result = closeGitBoundary(f.dir, {
        boundary_type: 'artifact-archive',
        stage: 'S01',
        old_manifest_digest: oldDigest,
        paths: [src, dst],
        expected_head: headBefore,
      });
      assert.ok(result.commit_sha);
      // The commit recorded the rename (both paths) and the source is gone.
      const trackedSrc = f.run(['ls-files', '--', src]).trim();
      const trackedDst = f.run(['ls-files', '--', dst]).trim();
      assert.equal(trackedSrc, '');
      assert.ok(trackedDst.length > 0);
      assert.equal(porcelain(f), '');
    } finally {
      f.cleanup();
    }
  });

  test('extra staged file -> RENAME_INVALID and worktree/index unchanged', () => {
    const f = makeFixture();
    try {
      const oldDigest = sha('old');
      const { src, dst } = archiveSourceDest('S01', oldDigest);
      f.write(src, 'artifact content');
      f.write('extra.txt', 'extra');
      commitAll(f, 'base');
      f.run(['mv', src, dst]);
      // Stage an extra file in addition to the rename.
      f.write('extra.txt', 'extra-changed');
      f.run(['add', 'extra.txt']);
      const headBefore = f.head();
      const porcelainBefore = porcelain(f);
      // The strict dirty gate fires before the rename validation: the extra
      // staged file is outside the artifact-archive tolerated scope.
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'artifact-archive',
            stage: 'S01',
            old_manifest_digest: oldDigest,
            paths: [src, dst],
            expected_head: headBefore,
          }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      // Nothing was committed and the index still holds the extra staged entry.
      assert.equal(f.head(), headBefore);
      assert.match(porcelain(f), /extra\.txt/);
    } finally {
      f.cleanup();
    }
  });

  test('invalid source/destination (destination not digest-qualified) -> RENAME_INVALID', () => {
    const f = makeFixture();
    try {
      const oldDigest = sha('old');
      const src = `delivery/stages/S01/invalidated-plan.md`;
      const dst = `delivery/stages/S01/invalidated-plan.moved.md`;
      f.write(src, 'artifact content');
      commitAll(f, 'base');
      f.run(['mv', src, dst]);
      const headBefore = f.head();
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'artifact-archive',
            stage: 'S01',
            old_manifest_digest: oldDigest,
            paths: [src, dst],
            expected_head: headBefore,
          }),
        'BOUNDARY.RENAME_INVALID',
      );
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });

  test('hook failure after staging -> COMMIT_FAILED and staged state is preserved (no reset/unstage)', () => {
    const f = makeFixture();
    try {
      const oldDigest = sha('old');
      const { src, dst } = archiveSourceDest('S01', oldDigest);
      f.write(src, 'artifact content');
      commitAll(f, 'base');
      // A pre-commit hook that always fails the commit.
      const hookDir = f.run(['rev-parse', '--git-path', 'hooks']).trim();
      f.write(`${hookDir}/pre-commit`, '#!/bin/sh\nexit 1\n');
      // hooks path may be relative to the git dir; make it executable.
      try {
        execFileSync('chmod', ['+x', `${f.dir}/.git/hooks/pre-commit`]);
      } catch {
        /* ignored */
      }
      f.run(['mv', src, dst]);
      const headBefore = f.head();
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'artifact-archive',
            stage: 'S01',
            old_manifest_digest: oldDigest,
            paths: [src, dst],
            expected_head: headBefore,
          }),
        'BOUNDARY.COMMIT_FAILED',
      );
      // HEAD unchanged AND the rename is still staged (the CLI did NOT reset).
      assert.equal(f.head(), headBefore);
      const staged = f.run(['diff', '--cached', '--name-only', '-z', '--no-renames', '--'])
        .split('\u0000')
        .filter((p) => p.length > 0)
        .sort();
      assert.deepEqual(staged, [src, dst].sort());
    } finally {
      f.cleanup();
    }
  });
});
// ---------------------------------------------------------------------------
// stage-plan / stage-close machine preflight.
// ---------------------------------------------------------------------------

describe('stage-plan manifest_digest preflight', () => {
  test('missing manifest_digest -> REQUEST_INVALID', () => {
    const f = makeFixture();
    try {
      f.write('delivery/stages/S01/src/f.txt', 'x');
      commitAll(f, 'base');
      const headBefore = f.head();
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'stage-plan',
            stage: 'S01',
            expected_head: headBefore,
            // no manifest_digest
          }),
        'BOUNDARY.REQUEST_INVALID',
      );
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });

  test('wrong manifest_digest -> SCOPE_VIOLATION (HEAD unchanged)', () => {
    const f = makeFixture();
    try {
      f.write('delivery/stages/S01/src/f.txt', 'x');
      commitAll(f, 'base');
      // Persist a schema-valid manifest so readVNextManifest succeeds.
      const actualDigest = persistValidManifest(f.dir, 'S01');
      assert.notEqual(actualDigest, sha('other'));
      const headBefore = f.head();
      const msg = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'stage-plan',
            stage: 'S01',
            expected_head: headBefore,
            manifest_digest: sha('other'),
          }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      assert.match(msg, /manifest_digest does not match/);
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });
});

describe('stage-close Gate/Review preflight', () => {
  test('missing Gate/Review receipts -> SLICE_POLICY_INVALID (HEAD unchanged)', () => {
    const f = makeFixture();
    try {
      f.write('delivery/stages/S01/src/f.txt', 'x');
      commitAll(f, 'base');
      const headBefore = f.head();
      // No stage-gate / review chain exists; readVNextStageReviewStatus fails.
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'stage-close',
            stage: 'S01',
            expected_head: headBefore,
          }),
        'BOUNDARY.SLICE_POLICY_INVALID',
      );
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Strict dirty gate ordering (reviewer issue 1): the gate MUST run before
// requestedPaths so an outside-only dirty worktree returns SCOPE_VIOLATION
// (never NO_CHANGES).
// ---------------------------------------------------------------------------

describe('strict dirty gate ordering (exact/prefix/outside-only)', () => {
  test('exact type: outside-only dirty (declared path clean) -> SCOPE_VIOLATION, not NO_CHANGES', () => {
    const f = makeFixture();
    try {
      f.write('in-scope.txt', 'x');
      f.write('out-of-scope.txt', 'y');
      commitAll(f, 'base');
      // Only the OUT-OF-SCOPE file is dirty; the declared path is clean.
      f.write('out-of-scope.txt', 'changed');
      const headBefore = f.head();
      const msg = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'direct-fix',
            paths: ['in-scope.txt'],
            expected_head: headBefore,
            description: 'outside only',
          }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      assert.match(msg, /out-of-scope\.txt/);
      assert.doesNotMatch(msg, /NO_CHANGES/);
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });

  test('exact type: exact-only dirty (declared path dirty, nothing else) commits', () => {
    const f = makeFixture();
    try {
      f.write('in-scope.txt', 'x');
      f.write('other.txt', 'y');
      commitAll(f, 'base');
      f.write('in-scope.txt', 'changed-in');
      const headBefore = f.head();
      const result = closeGitBoundary(f.dir, {
        boundary_type: 'direct-fix',
        paths: ['in-scope.txt'],
        expected_head: headBefore,
        description: 'exact only',
      });
      assert.deepEqual(result.changed_files, ['in-scope.txt']);
      assert.equal(result.dirty_after, false);
      assert.equal(f.run(['ls-files', '--', 'in-scope.txt']).trim().length > 0, true);
    } finally {
      f.cleanup();
    }
  });

  test('prefix type (baseline-authority): outside-only dirty -> SCOPE_VIOLATION, not NO_CHANGES', () => {
    const f = makeFixture();
    try {
      f.write('CONTEXT.md', 'ctx');
      f.write('unrelated.txt', 'u');
      commitAll(f, 'base');
      // Only the out-of-prefix file is dirty.
      f.write('unrelated.txt', 'changed-u');
      const headBefore = f.head();
      const msg = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'baseline-authority',
            expected_head: headBefore,
          }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      assert.match(msg, /unrelated\.txt/);
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });

  test('prefix type (baseline-authority): prefix-only dirty commits and clean unrelated stays clean', () => {
    const f = makeFixture();
    try {
      f.write('CONTEXT.md', 'ctx');
      f.write('PRD.md', 'prd');
      f.write('unrelated.txt', 'u');
      commitAll(f, 'base');
      f.write('CONTEXT.md', 'ctx v2');
      const headBefore = f.head();
      const result = closeGitBoundary(f.dir, {
        boundary_type: 'baseline-authority',
        expected_head: headBefore,
      });
      assert.ok(result.changed_files.includes('CONTEXT.md'));
      assert.equal(result.dirty_after, false);
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// stage-close tip-binding fail-closed unit tests (reviewer issue 2). These
// exercise the pure helper directly (no full Runtime receipt fixture needed),
// covering stale snapshot, stale gate binding, and wrong verdicts.
// ---------------------------------------------------------------------------

function gateTip(verdict: string, snapshotDigest: string, digest: string): { type: string; digest: string; payload: Record<string, unknown> } {
  return { type: 'GATE_PASS', digest, payload: { verdict, snapshot_digest: snapshotDigest } };
}
function reviewTip(verdict: string, snapshotDigest: string, gateDigest: string, digest: string): { type: string; digest: string; payload: Record<string, unknown> } {
  return { type: 'STAGE_REVIEW_PASS', digest, payload: { verdict, snapshot_digest: snapshotDigest, stage_gate_receipt_digest: gateDigest } };
}

describe('stage-close tip-binding fail-closed (assertStageCloseTipBindings)', () => {
  const head = 'b'.repeat(40);
  const gate = 'g'.repeat(64);
  const review = 'r'.repeat(64);
  test('happy: PASS gate + ACCEPTED review both bound to integrated HEAD passes', () => {
    assertStageCloseTipBindings(gateTip('PASS', head, gate), reviewTip('ACCEPTED', head, gate, review), head, 'stage-close');
  });

  test('stale gate snapshot (gate not bound to integrated HEAD) -> SLICE_POLICY_INVALID', () => {
    expectBoundaryCode(
      () => assertStageCloseTipBindings(gateTip('PASS', 'c'.repeat(40), gate), reviewTip('ACCEPTED', head, gate, review), head, 'stage-close'),
      'BOUNDARY.SLICE_POLICY_INVALID',
    );
  });

  test('stale review snapshot (review not bound to integrated HEAD) -> SLICE_POLICY_INVALID', () => {
    expectBoundaryCode(
      () => assertStageCloseTipBindings(gateTip('PASS', head, gate), reviewTip('ACCEPTED', 'd'.repeat(40), gate, review), head, 'stage-close'),
      'BOUNDARY.SLICE_POLICY_INVALID',
    );
  });

  test('stale gate binding (review does not bind current gate tip) -> SLICE_POLICY_INVALID', () => {
    expectBoundaryCode(
      () => assertStageCloseTipBindings(gateTip('PASS', head, gate), reviewTip('ACCEPTED', head, '0'.repeat(64), review), head, 'stage-close'),
      'BOUNDARY.SLICE_POLICY_INVALID',
    );
  });

  test('gate tip not PASS -> SLICE_POLICY_INVALID', () => {
    expectBoundaryCode(
      () => assertStageCloseTipBindings(gateTip('FAIL', head, gate), reviewTip('ACCEPTED', head, gate, review), head, 'stage-close'),
      'BOUNDARY.SLICE_POLICY_INVALID',
    );
  });

  test('review tip not ACCEPTED -> SLICE_POLICY_INVALID', () => {
    expectBoundaryCode(
      () => assertStageCloseTipBindings(gateTip('PASS', head, gate), reviewTip('REPAIR', head, gate, review), head, 'stage-close'),
      'BOUNDARY.SLICE_POLICY_INVALID',
    );
  });

  test('missing gate fact -> SLICE_POLICY_INVALID', () => {
    expectBoundaryCode(
      () => assertStageCloseTipBindings(null, reviewTip('ACCEPTED', head, gate, review), head, 'stage-close'),
      'BOUNDARY.SLICE_POLICY_INVALID',
    );
  });

  test('missing review fact -> SLICE_POLICY_INVALID', () => {
    expectBoundaryCode(
      () => assertStageCloseTipBindings(gateTip('PASS', head, gate), null, head, 'stage-close'),
      'BOUNDARY.SLICE_POLICY_INVALID',
    );
  });
});

// ---------------------------------------------------------------------------
// stage-close evidence finalized check (reviewer issue): a skeleton/placeholder
// Evidence must be rejected by the isSliceEvidenceFinalized check that the
// stage-close preflight now applies to EVERY Manifest-declared Slice Evidence.
// ---------------------------------------------------------------------------

describe('stage-close Evidence finalized (isSliceEvidenceFinalized)', () => {
  const SKELETON = [
    '## Current Slice Evidence',
    '',
    '### Proof Obligation Coverage',
    '| | | | | | |',
    '| --- | --- | --- | --- | --- | --- |',
    '| *None* | | | | |',
  ].join('\n');

  const FINALIZED = [
    '## Current Slice Evidence',
    '',
    '### Proof Obligation Coverage',
    '| Obligation | Ref | Status | Evidence |',
    '| --- | --- | --- | --- |',
    '| S01-A01 | #/acceptance/a01 | COMPLETE | evidence text |',
  ].join('\n');

  test('skeleton/placeholder Evidence is NOT finalized -> stage-close preflight rejects it', () => {
    assert.equal(isSliceEvidenceFinalized(SKELETON), false);
  });

  test('finalized Evidence (filled Proof Obligation Coverage row) IS finalized', () => {
    assert.equal(isSliceEvidenceFinalized(FINALIZED), true);
  });

  test('missing Proof Obligation Coverage section is NOT finalized', () => {
    assert.equal(isSliceEvidenceFinalized('## Current Slice Evidence\n\nNo matrix here.'), false);
  });
});
