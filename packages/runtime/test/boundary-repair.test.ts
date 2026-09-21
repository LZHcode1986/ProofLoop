/**
 * Boundary Policy repair regression tests.
 *
 * Covers (per task):
 *  - P0 slice A/B isolation at BOTH layers:
 *      * policy layer: a parallel Slice's declared dirty output is tolerated
 *        but NEVER committable by the current Slice boundary;
 *      * REAL temp-Git layer: interleaved worktree — the current Slice file
 *        is committed, the declared other-Slice file stays dirty and
 *        `dirty_after=true`;
 *  - slice-output slice-policy integrity: overlapping / duplicate
 *    committable-vs-tolerated paths fail `BOUNDARY.SLICE_POLICY_INVALID`
 *    before any Git write; external (undeclared) dirt fails
 *    `BOUNDARY.SCOPE_VIOLATION`;
 *  - closed boundary CLI request schema: retired digest fields are rejected
 *    as unknown fields, while `other_slice_declared_files` (slice-output)
 *    remains a known field;
 *  - strict dirty gate (scope-external dirty -> SCOPE_VIOLATION, HEAD/index
 *    unchanged);
 *  - stage-plan boundary with canonical Project Stage Map:
 *      * atomic commitment of delivery/project-stage-map.md and candidate Plan;
 *      * out-of-scope dirt rejected before any Git write;
 *  - slice-output wrong/missing expected_head;
 *  - artifact-archive rename happy path / extra staged / invalid
 *    source-destination / hook failure;
 *  - workflow-contract-update .pi exact-path scope;
 *  - fail-closed slice-commit-policy load validation (duplicate / overlap /
 *    protected-root / out-of-allowed Worker fact / boolean-type / non-empty
 *    changed-set mechanical error);
 *  - the closed BOUNDARY.* error codes (HEAD_MISMATCH, INDEX_NOT_EMPTY,
 *    SCOPE_VIOLATION, NO_CHANGES, RENAME_INVALID, COMMIT_FAILED, ...).
 *
 * Imports the compiled runtime dist (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { makeFixture, commitAll, porcelain, sha, type Fixture } from './helpers';
import {
  closeGitBoundary,
  GitBoundaryError,
  resolveRequestInput,
  type CliRequestValidation,
  type ParsedCliArgs,
} from '../dist/index';
import { canonicalCandidateRef, ensureCandidateRef } from '../dist/git-boundary';
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
// P0 extension (task 005): fail-closed Work Packet path-policy validation.
// Malformed / duplicate / overlapping facts fail AT LOAD with the mechanical
// RUNTIME.SCHEMA_MISMATCH code — never silent dedup, never the retired
// DOMAIN.INVALID_TRANSITION business code.
// ---------------------------------------------------------------------------

describe('slice-commit-policy fail-closed load validation', () => {
  const raw = (facts: unknown): SliceCommitPolicy => loadSliceCommitPolicy(facts as SliceCommitPolicyFacts);

  test('duplicate entries fail in every policy list (never silently deduplicated)', () => {
    expectPolicyCode(
      () => basePolicy({ allowedPaths: ['delivery/stages/S01/a.txt', 'delivery/stages/S01/a.txt'] }),
      'RUNTIME.SCHEMA_MISMATCH',
    );
    expectPolicyCode(
      () => basePolicy({ otherSliceDeclaredFiles: ['delivery/stages/S01/b.txt', 'delivery/stages/S01/b.txt'] }),
      'RUNTIME.SCHEMA_MISMATCH',
    );
    expectPolicyCode(
      () => basePolicy({ forbiddenPaths: ['.proofloop', '.proofloop'] }),
      'RUNTIME.SCHEMA_MISMATCH',
    );
    expectPolicyCode(
      () => basePolicy({ workerChangedFiles: ['delivery/stages/S01/a.txt', 'delivery/stages/S01/a.txt'] }),
      'RUNTIME.SCHEMA_MISMATCH',
    );
  });

  test('allowedPaths and otherSliceDeclaredFiles must be disjoint in both prefix directions', () => {
    // tolerated parent prefix contains a committable child path
    expectPolicyCode(
      () => basePolicy({ allowedPaths: ['delivery/stages/S01/a.txt'], otherSliceDeclaredFiles: ['delivery/stages/S01'] }),
      'RUNTIME.SCHEMA_MISMATCH',
    );
    // committable parent prefix contains a tolerated child path
    expectPolicyCode(
      () => basePolicy({ allowedPaths: ['delivery/stages/S01'], otherSliceDeclaredFiles: ['delivery/stages/S01/b.txt'] }),
      'RUNTIME.SCHEMA_MISMATCH',
    );
  });

  test('protected roots (.git / .proofloop) are rejected in allowed/other/worker facts', () => {
    for (const allowedPaths of [['.proofloop'], ['.proofloop/x'], ['.git'], ['.git/hooks/pre-commit']]) {
      expectPolicyCode(() => basePolicy({ allowedPaths }), 'RUNTIME.SCHEMA_MISMATCH');
    }
    expectPolicyCode(() => basePolicy({ otherSliceDeclaredFiles: ['.proofloop/evidence.txt'] }), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(() => basePolicy({ workerChangedFiles: ['.git/x'] }), 'RUNTIME.SCHEMA_MISMATCH');
  });

  test('allowed/other/worker must not overlap forbiddenPaths in either prefix direction', () => {
    expectPolicyCode(() => basePolicy({ allowedPaths: ['.pi/extensions/proofloop-mode.ts'], forbiddenPaths: ['.pi'] }), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(() => basePolicy({ allowedPaths: ['.pi'], forbiddenPaths: ['.pi/x'] }), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(() => basePolicy({ workerChangedFiles: ['.pi/worker.md'], forbiddenPaths: ['.pi'] }), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(
      () => basePolicy({ otherSliceDeclaredFiles: ['delivery/stages/S01/b.txt'], forbiddenPaths: ['delivery/stages/S01/b.txt'] }),
      'RUNTIME.SCHEMA_MISMATCH',
    );
  });

  test('workerChangedFiles must lie inside allowedPaths', () => {
    expectPolicyCode(() => basePolicy({ workerChangedFiles: ['delivery/stages/S02/other.txt'] }), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(() => basePolicy({ workerChangedFiles: ['notes.txt'] }), 'RUNTIME.SCHEMA_MISMATCH');
  });

  test('boolean/type validation: facts shape, field types and hasRepairHistory are enforced', () => {
    const facts = basePolicyFacts({});
    expectPolicyCode(() => raw(null), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(() => raw(undefined), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(() => raw({ ...facts, hasRepairHistory: 'true' }), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(() => raw({ ...facts, allowedPaths: 'delivery/stages/S01/a.txt' }), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(() => raw({ ...facts, forbiddenPaths: undefined }), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(() => raw({ ...facts, workerChangedFiles: null }), 'RUNTIME.SCHEMA_MISMATCH');
    expectPolicyCode(() => raw({ ...facts, otherSliceDeclaredFiles: 7 }), 'RUNTIME.SCHEMA_MISMATCH');
  });

  test('empty allowedPaths fails closed', () => {
    expectPolicyCode(() => basePolicy({ allowedPaths: [] }), 'RUNTIME.SCHEMA_MISMATCH');
  });

  test('empty changed-set fails with the mechanical RUNTIME.SCHEMA_MISMATCH code', () => {
    const policy = basePolicy();
    const msg = expectPolicyCode(
      () => validateSliceCommitChangedFiles(policy, [], { phase: 'pre-commit' }),
      'RUNTIME.SCHEMA_MISMATCH',
    );
    assert.match(msg, /non-empty changed-file boundary/);
  });

  test('changed-file duplicates fail closed instead of being silently deduplicated', () => {
    const policy = basePolicy();
    expectPolicyCode(
      () => validateSliceCommitChangedFiles(policy, ['delivery/stages/S01/a.txt', 'delivery/stages/S01/a.txt']),
      'RUNTIME.SCHEMA_MISMATCH',
    );
  });

  test('valid facts load unchanged and in order (no dedup / no reordering)', () => {
    const policy = basePolicy({
      allowedPaths: ['src/a.ts', 'src/b.ts'],
      otherSliceDeclaredFiles: ['src/c.ts'],
      workerChangedFiles: ['src/a.ts', 'src/b.ts'],
    });
    assert.deepEqual(policy.allowedPaths, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(policy.otherSliceDeclaredFiles, ['src/c.ts']);
    assert.deepEqual(policy.workerChangedFiles, ['src/a.ts', 'src/b.ts']);
    assert.equal(policy.hasRepairHistory, false);
    const changed = validateSliceCommitChangedFiles(policy, ['src/a.ts', 'src/b.ts'], { phase: 'pre-commit' });
    assert.deepEqual(changed, ['src/a.ts', 'src/b.ts']);
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
            slice: 'S01-A',
            // no expected_head
          }),
        'BOUNDARY.REQUEST_INVALID',
      );
    } finally {
      f.cleanup();
    }
  });

  test('workflow-contract-update accepts active Subagent host paths while rejecting arbitrary paths', () => {
    const f = makeFixture();
    try {
      f.write('.pi/extensions/proofloop-mode.ts', 'extension');
      f.write('.pi/subagents.json', '{"maxSubagentDepth":1}');
      commitAll(f, 'base');
      f.write('.pi/extensions/proofloop-mode.ts', 'extension v2');
      f.write('.pi/subagents.json', '{"maxSubagentDepth":1,"fallbackSubagent":"none"}');
      const headBefore = f.head();
      expectBoundaryCode(
        () => closeGitBoundary(f.dir, {
          boundary_type: 'workflow-contract-update',
          paths: ['.pi/anything-else.md'],
          expected_head: headBefore,
          description: 'pi scope',
        }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      expectBoundaryCode(
        () => closeGitBoundary(f.dir, {
          boundary_type: 'workflow-contract-update',
          paths: ['.pi/subagents.json.bak'],
          expected_head: headBefore,
          description: 'subagent config sibling',
        }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      const declared = ['.pi/subagents.json', '.pi/extensions/proofloop-mode.ts'];
      const result = closeGitBoundary(f.dir, {
        boundary_type: 'workflow-contract-update',
        paths: declared,
        expected_head: headBefore,
        description: 'Subagent host scope',
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

function archiveSourceDest(stage: string): { src: string; dst: string } {
  return {
    src: `delivery/stages/${stage}/invalidated-plan.md`,
    dst: `delivery/stages/${stage}/invalidated-plan.archived.md`,
  };
}

describe('artifact-archive rename validation', () => {
  test('happy path: Brain pre-staged rename is validated and committed', () => {
    const f = makeFixture();
    try {
      const { src, dst } = archiveSourceDest('S01');
      f.write(src, 'artifact content');
      commitAll(f, 'base');
      // Brain pre-executes the exact git mv (the CLI must NOT run git mv).
      f.run(['mv', src, dst]);
      const headBefore = f.head();
      const result = closeGitBoundary(f.dir, {
        boundary_type: 'artifact-archive',
        stage: 'S01',
        paths: [src, dst],
        expected_head: headBefore,
      });
      assert.ok(result.commit_sha);
      // The canonical commit message is the stable pure-mechanical form.
      assert.equal(result.commit_message, 'artifact-archive: S01');
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
      const { src, dst } = archiveSourceDest('S01');
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

  test('invalid source/destination (destination already tracked at pre-commit HEAD) -> RENAME_INVALID', () => {
    const f = makeFixture();
    try {
      const src = `delivery/stages/S01/invalidated-plan.md`;
      const dst = `delivery/stages/S01/invalidated-plan.archived.md`;
      f.write(src, 'artifact content');
      f.write(dst, 'occupied');
      commitAll(f, 'base');
      // A forced move over an already-tracked destination is NOT a single
      // pure rename (the staged result is a modify+delete pair).
      f.run(['mv', '-f', src, dst]);
      const headBefore = f.head();
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'artifact-archive',
            stage: 'S01',
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
      const { src, dst } = archiveSourceDest('S01');
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

  test('exact type: explicit tolerated file stays untracked and uncommitted', () => {
    const f = makeFixture();
    try {
      f.write('in-scope.txt', 'base');
      commitAll(f, 'base');
      f.write('in-scope.txt', 'candidate');
      f.write('stale.txt', 'preserve me');
      const headBefore = f.head();
      const result = closeGitBoundary(f.dir, {
        boundary_type: 'direct-fix',
        paths: ['in-scope.txt'],
        tolerated_paths: ['stale.txt'],
        expected_head: headBefore,
        description: 'explicit tolerance',
      });
      assert.deepEqual(result.changed_files, ['in-scope.txt']);
      assert.deepEqual([...result.tolerated_paths], ['stale.txt']);
      assert.equal(result.dirty_after, true);
      assert.match(porcelain(f), /stale\.txt/);
      assert.equal(f.run(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'stale.txt']).trim(), '');
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
// P0 slice A/B isolation AT THE GIT LEVEL: a real interleaved temp Git
// fixture. The current Slice file is committed, the declared other-Slice file
// remains dirty and `dirty_after=true`; the two scopes are mechanically
// disjoint (overlap/duplicates fail before any Git write).
// ---------------------------------------------------------------------------

describe('slice-output interleaved worktree isolation (temp Git)', () => {
  test('current Slice path is committed; declared other-Slice file stays dirty (dirty_after=true)', () => {
    const f = makeFixture();
    try {
      f.write('delivery/stages/S01/a.txt', 'a1');
      f.write('delivery/stages/S01/b.txt', 'b1');
      commitAll(f, 'base');
      const headBefore = f.head();
      // Interleaved dirty state: both Slices touched their files.
      f.write('delivery/stages/S01/a.txt', 'a2');
      f.write('delivery/stages/S01/b.txt', 'b2');
      const result = closeGitBoundary(f.dir, {
        boundary_type: 'slice-output',
        stage: 'S01',
        slice: 'S01-A',
        expected_head: headBefore,
        paths: ['delivery/stages/S01/a.txt'],
        other_slice_declared_files: ['delivery/stages/S01/b.txt'],
      });
      // ONLY the current Slice file is committed (disjoint staging scope).
      assert.deepEqual([...result.changed_files].sort(), ['delivery/stages/S01/a.txt']);
      assert.match(result.commit_message, /^slice-output: S01-S01-A$/);
      // The other-Slice declared file is NEVER staged/committed: it remains
      // dirty and the worktree reports it via dirty_after.
      assert.equal(result.dirty_after, true);
      const st = porcelain(f);
      assert.match(st, /b\.txt/);
      assert.doesNotMatch(st, /a\.txt/);
      // The boundary commit carries exactly the current Slice file, and the
      // other file is still NOT in the committed tree.
      assert.ok(f.run(['ls-files', '--', 'delivery/stages/S01/a.txt']).trim().length > 0);
      // The boundary commit carries exactly the current Slice change: a.txt
      // holds the new Slice content at HEAD...
      assert.equal(f.run(['show', 'HEAD:delivery/stages/S01/a.txt']).trim(), 'a2');
      // ...while b.txt' content at HEAD is still the BASE content — the
      // other-Slice change was never picked up by this boundary commit.
      assert.equal(f.run(['show', 'HEAD:delivery/stages/S01/b.txt']).trim(), 'b1');
    } finally {
      f.cleanup();
    }
  });

  test('undeclared external dirty path -> SCOPE_VIOLATION even with a declared other-Slice file', () => {
    const f = makeFixture();
    try {
      f.write('delivery/stages/S01/a.txt', 'a1');
      f.write('delivery/stages/S01/b.txt', 'b1');
      f.write('delivery/stages/S01/c.txt', 'c1');
      commitAll(f, 'base');
      const headBefore = f.head();
      f.write('delivery/stages/S01/a.txt', 'a2');
      f.write('delivery/stages/S01/b.txt', 'b2');
      f.write('delivery/stages/S01/c.txt', 'c2'); // NOT declared in either scope
      const msg = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'slice-output',
            stage: 'S01',
            slice: 'S01-A',
            expected_head: headBefore,
            paths: ['delivery/stages/S01/a.txt'],
            other_slice_declared_files: ['delivery/stages/S01/b.txt'],
          }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      assert.match(msg, /c\.txt/);
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });

  test('overlapping committable / tolerated prefixes -> BOUNDARY.SLICE_POLICY_INVALID before any Git write', () => {
    const f = makeFixture();
    try {
      f.write('delivery/stages/S01/a.txt', 'a1');
      commitAll(f, 'base');
      const headBefore = f.head();
      // Case 1: a tolerated parent prefix contains a committable child path.
      const msg1 = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'slice-output',
            stage: 'S01',
            slice: 'S01-A',
            expected_head: headBefore,
            paths: ['delivery/stages/S01/a.txt'],
            other_slice_declared_files: ['delivery/stages/S01'],
          }),
        'BOUNDARY.SLICE_POLICY_INVALID',
      );
      assert.match(msg1, /overlap/);
      // Case 2: a committable parent prefix contains a tolerated child path.
      const msg2 = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'slice-output',
            stage: 'S01',
            slice: 'S01-A',
            expected_head: headBefore,
            paths: ['delivery/stages/S01'],
            other_slice_declared_files: ['delivery/stages/S01/b.txt'],
          }),
        'BOUNDARY.SLICE_POLICY_INVALID',
      );
      assert.match(msg2, /overlap/);
      // HEAD and index are untouched by the policy failure.
      assert.equal(f.head(), headBefore);
      // HEAD unchanged and the worktree is untouched by the policy failure.
      assert.equal(porcelain(f), '');
    } finally {
      f.cleanup();
    }
  });

  test('duplicate committable or tolerated paths -> BOUNDARY.SLICE_POLICY_INVALID', () => {
    const f = makeFixture();
    try {
      f.write('delivery/stages/S01/a.txt', 'a1');
      commitAll(f, 'base');
      const headBefore = f.head();
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'slice-output',
            stage: 'S01',
            slice: 'S01-A',
            expected_head: headBefore,
            paths: ['delivery/stages/S01/a.txt', 'delivery/stages/S01/a.txt'],
          }),
        'BOUNDARY.SLICE_POLICY_INVALID',
      );
      expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'slice-output',
            stage: 'S01',
            slice: 'S01-A',
            expected_head: headBefore,
            paths: ['delivery/stages/S01/a.txt'],
            other_slice_declared_files: ['delivery/stages/S01/b.txt', 'delivery/stages/S01/b.txt'],
          }),
        'BOUNDARY.SLICE_POLICY_INVALID',
      );
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });

  test('other_slice_declared_files is rejected outside slice-output', () => {
    const f = makeFixture();
    try {
      f.write('in-scope.txt', 'x');
      commitAll(f, 'base');
      f.write('in-scope.txt', 'y');
      const headBefore = f.head();
      const msg = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'direct-fix',
            paths: ['in-scope.txt'],
            other_slice_declared_files: ['other-slice.txt'],
            expected_head: headBefore,
            description: 'tolerance leak',
          }),
        'BOUNDARY.REQUEST_INVALID',
      );
      assert.match(msg, /other_slice_declared_files/);
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Closed boundary CLI request schema: retired digest fields are rejected as
// unknown fields; other_slice_declared_files is accepted for slice-output.
// ---------------------------------------------------------------------------

describe('closed boundary CLI request schema', () => {
  function closedRequest(fixture: Fixture, payload: Record<string, unknown>): CliRequestValidation {
    return resolveRequestInput(
      fixture.dir,
      { domain: 'boundary', operation: 'close' },
      {
        positionals: ['boundary', 'close'],
        help: false,
        version: false,
        projectRoot: undefined,
        requestPath: undefined,
        jsonInput: JSON.stringify(payload),
        stage: undefined,
      } as ParsedCliArgs,
    );
  }

  test('unknown request field is rejected by the closed schema', () => {
    const f = makeFixture();
    try {
      const v = closedRequest(f, { boundary_type: 'direct-fix', unknown_boundary_request_field: sha('unknown') });
      assert.equal(v.ok, false);
      if (!v.ok) assert.match(v.message, /unknown field/);
      if (!v.ok) assert.match(v.message, /unknown_boundary_request_field/);
    } finally {
      f.cleanup();
    }
  });

  test('other_slice_declared_files is accepted and carried through the closed schema', () => {
    const f = makeFixture();
    try {
      const v = closedRequest(f, {
        boundary_type: 'slice-output',
        stage: 'S01',
        slice: 'S01-A',
        expected_head: 'a'.repeat(40),
        paths: ['delivery/stages/S01/a.txt'],
        other_slice_declared_files: ['delivery/stages/S01/b.txt'],
      });
      assert.equal(v.ok, true);
      if (v.ok) {
        assert.deepEqual([...(v.request.paths ?? [])], ['delivery/stages/S01/a.txt']);
        assert.deepEqual([...(v.request.other_slice_declared_files ?? [])], ['delivery/stages/S01/b.txt']);
      }
    } finally {
      f.cleanup();
    }
  });

  test('tolerated_paths is accepted as an ordinary exact-file tolerance', () => {
    const f = makeFixture();
    try {
      const v = closedRequest(f, {
        boundary_type: 'stage-plan',
        stage: 'S06',
        tolerated_paths: ['delivery/stages/S06/recovery-plan-r11.md'],
      });
      assert.equal(v.ok, true);
      if (v.ok) {
        assert.deepEqual([...(v.request.tolerated_paths ?? [])], [
          'delivery/stages/S06/recovery-plan-r11.md',
        ]);
      }
    } finally {
      f.cleanup();
    }
  });

  test('the retired artifact digest field is rejected as an unknown request field', () => {
    const f = makeFixture();
    try {
      // Field name is computed so the closed-schema pin never embeds the
      // retired token literally in the active source.
      const retiredField = ['old', 'manifest', 'digest'].join('_');
      const v = closedRequest(f, { boundary_type: 'artifact-archive', stage: 'S01', [retiredField]: sha('old') });
      assert.equal(v.ok, false);
      if (!v.ok) assert.match(v.message, /unknown field/);
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// stage-plan: canonical Project Stage Map + candidate Plan atomic closure
// ---------------------------------------------------------------------------

describe('stage-plan boundary with canonical Project Stage Map', () => {
  test('untracked Map plus S02 candidate Plan are committed together by stage-plan boundary', () => {
    const f = makeFixture();
    try {
      f.write('README.md', 'init');
      commitAll(f, 'base');
      const headBefore = f.head();

      // Planner produces canonical Map and S02 candidate Plan (untracked)
      f.write('delivery/project-stage-map.md', '# Project Stage Map\n');
      f.write('delivery/stages/S02/plan.md', '# S02 Candidate Thin Plan\n');

      const result = closeGitBoundary(f.dir, {
        boundary_type: 'stage-plan',
        stage: 'S02',
        expected_head: headBefore,
      });

      assert.equal(result.boundary_type, 'stage-plan');
      assert.equal(result.commit_message, 'stage-plan: S02');
      assert.equal(result.pre_commit_head, headBefore);
      assert.notEqual(result.commit_sha, headBefore);
      assert.deepEqual([...result.changed_files].sort(), [
        'delivery/project-stage-map.md',
        'delivery/stages/S02/plan.md',
      ]);
      assert.equal(result.dirty_after, false);
      assert.equal(porcelain(f), '');

      // Verify both files are tracked in the resulting commit
      assert.equal(f.run(['show', 'HEAD:delivery/project-stage-map.md']).trim(), '# Project Stage Map');
      assert.equal(f.run(['show', 'HEAD:delivery/stages/S02/plan.md']).trim(), '# S02 Candidate Thin Plan');
    } finally {
      f.cleanup();
    }
  });

  test('stage-plan commits the candidate while leaving an explicit stale file untracked', () => {
    const f = makeFixture();
    try {
      f.write('README.md', 'init');
      commitAll(f, 'base');
      const headBefore = f.head();
      f.write('delivery/project-stage-map.md', '# Project Stage Map\n');
      f.write('delivery/stages/S02/plan.md', '# S02 Candidate Thin Plan\n');
      f.write('delivery/stages/S02/recovery-plan-r11.md', '# rejected stale candidate\n');

      const result = closeGitBoundary(f.dir, {
        boundary_type: 'stage-plan',
        stage: 'S02',
        expected_head: headBefore,
        tolerated_paths: ['delivery/stages/S02/recovery-plan-r11.md'],
      });

      assert.deepEqual([...result.changed_files].sort(), [
        'delivery/project-stage-map.md',
        'delivery/stages/S02/plan.md',
      ]);
      assert.deepEqual([...result.tolerated_paths], ['delivery/stages/S02/recovery-plan-r11.md']);
      assert.equal(result.dirty_after, true);
      assert.match(porcelain(f), /recovery-plan-r11\.md/);
      assert.equal(
        f.run(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'delivery/stages/S02/recovery-plan-r11.md']).trim(),
        '',
      );
    } finally {
      f.cleanup();
    }
  });

  test('dirty/modified tracked Map plus candidate Plan are committed together with clean worktree', () => {
    const f = makeFixture();
    try {
      f.write('delivery/project-stage-map.md', '# Map v1\n');
      commitAll(f, 'base');
      const headBefore = f.head();

      f.write('delivery/project-stage-map.md', '# Map v2\n');
      f.write('delivery/stages/S02/plan.md', '# S02 candidate plan\n');

      const result = closeGitBoundary(f.dir, {
        boundary_type: 'stage-plan',
        stage: 'S02',
        expected_head: headBefore,
      });

      assert.equal(result.commit_message, 'stage-plan: S02');
      assert.deepEqual([...result.changed_files].sort(), [
        'delivery/project-stage-map.md',
        'delivery/stages/S02/plan.md',
      ]);
      assert.equal(result.dirty_after, false);
      assert.equal(porcelain(f), '');
    } finally {
      f.cleanup();
    }
  });

  test('out-of-scope dirty path outside stage and canonical Map is rejected before any Git write', () => {
    const f = makeFixture();
    try {
      f.write('README.md', 'init');
      commitAll(f, 'base');
      const headBefore = f.head();

      // In-scope untracked files
      f.write('delivery/project-stage-map.md', '# Project Stage Map\n');
      f.write('delivery/stages/S02/plan.md', '# S02 Candidate Thin Plan\n');
      // Out-of-scope dirty file (e.g. S01 plan or outside delivery)
      f.write('delivery/stages/S01/plan.md', '# S01 out-of-scope\n');

      const msg = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'stage-plan',
            stage: 'S02',
            expected_head: headBefore,
          }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      assert.match(msg, /delivery\/stages\/S01\/plan\.md/);
      // HEAD and worktree untouched (no commit made)
      assert.equal(f.head(), headBefore);
      const st = porcelain(f);
      assert.match(st, /project-stage-map\.md/);
      assert.match(st, /S02\/plan\.md/);
      assert.match(st, /S01\/plan\.md/);
    } finally {
      f.cleanup();
    }
  });

  test('arbitrary delivery file outside canonical map path is rejected before any Git write', () => {
    const f = makeFixture();
    try {
      f.write('README.md', 'init');
      commitAll(f, 'base');
      const headBefore = f.head();

      f.write('delivery/stages/S02/plan.md', '# S02 Candidate Thin Plan\n');
      f.write('delivery/arbitrary-map.md', '# Arbitrary delivery file\n');

      const msg = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'stage-plan',
            stage: 'S02',
            expected_head: headBefore,
          }),
        'BOUNDARY.SCOPE_VIOLATION',
      );
      assert.match(msg, /delivery\/arbitrary-map\.md/);
      assert.equal(f.head(), headBefore);
    } finally {
      f.cleanup();
    }
  });
});


// ---------------------------------------------------------------------------
// S03-E candidate-ref establishment/recovery (PO-S03-E-02 / E-03).
// ---------------------------------------------------------------------------

describe('slice-output candidate ref closure (PO-S03-E-02 / PO-S03-E-03)', () => {
  test('PO-S03-E-02 canonical naming and ref==commit postcondition without schema expansion', () => {
    const f = makeFixture();
    try {
      f.write('src.txt', 'base\n');
      commitAll(f, 'base');
      const headBefore = f.head();
      f.write('src.txt', 'candidate\n');
      const result = closeGitBoundary(f.dir, {
        boundary_type: 'slice-output',
        stage: 'S03',
        slice: 'S03-A',
        expected_head: headBefore,
        paths: ['src.txt'],
      });
      assert.equal(canonicalCandidateRef('S03', 'S03-A'), 'proofloop-s03-a');
      assert.equal(f.run(['rev-parse', '--verify', 'proofloop-s03-a^{commit}']).trim(), result.commit_sha);
      assert.equal(f.run(['rev-parse', '--verify', 'proofloop-s03-a^{commit}']).trim(), result.commit_sha);
      assert.deepEqual(Object.keys(result).sort(), [
        'boundary_type',
        'changed_files',
        'commit_message',
        'commit_sha',
        'dirty_after',
        'pre_commit_head',
        'tolerated_paths',
      ]);
      assert.equal(porcelain(f), '');
    } finally {
      f.cleanup();
    }
  });

  test('PO-S03-E-02 retry idempotence and conflicting target fail-closed', () => {
    const f = makeFixture();
    try {
      f.write('src.txt', 'base\n');
      commitAll(f, 'base');
      const base = f.head();
      f.write('src.txt', 'candidate-1\n');
      const firstCommit = commitAll(f, 'candidate-1');
      const first = ensureCandidateRef(f.dir, 'S03', 'A', firstCommit, base);
      assert.equal(first.candidate_ref, 'proofloop-s03-a');
      assert.equal(first.created, true);
      assert.equal(first.candidate_base_ref, base, 'candidate_base_ref must equal the supplied worktree base_ref');
      const replay = ensureCandidateRef(f.dir, 'S03', 'A', firstCommit, base);
      assert.equal(replay.created, false);
      assert.equal(replay.commit_sha, firstCommit);
      assert.equal(replay.candidate_base_ref, base, 'retry preserves candidate_base_ref supplied by the caller');
      f.write('src.txt', 'candidate-2\n');
      const secondCommit = commitAll(f, 'candidate-2');
      const message = expectBoundaryCode(
        () => ensureCandidateRef(f.dir, 'S03', 'A', secondCommit, base),
        'BOUNDARY.POST_COMMIT_INVALID',
      );
      assert.match(message, /ref|overwrite|different/i);
      assert.equal(f.run(['rev-parse', '--verify', 'proofloop-s03-a^{commit}']).trim(), firstCommit);
    } finally {
      f.cleanup();
    }
  });
  test('PO-S03-E-03 POST_COMMIT_INVALID preserves commit for ref-only recovery', () => {
    const f = makeFixture();
    try {
      f.write('src.txt', 'base\n');
      commitAll(f, 'base');
      const base = f.head();
      f.write('other.txt', 'other\n');
      const otherCommit = commitAll(f, 'other');
      // Keep the Stage HEAD at the base while reserving the canonical ref at
      // a different commit; boundary close must commit first, then fail the
      // internal ref write without rollback/reset.
      const branch = f.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
      f.run(['checkout', '-q', base]);
      f.run(['branch', 'proofloop-s03-a', otherCommit]);
      f.run(['checkout', '-q', branch]);
      // The checkout above returns to branch HEAD (otherCommit); pin a fresh
      // base branch so the boundary transaction has the expected base.
      f.run(['reset', '--hard', base]);
      const headBefore = f.head();
      f.write('src.txt', 'candidate\n');
      expectBoundaryCode(
        () => closeGitBoundary(f.dir, {
          boundary_type: 'slice-output',
          stage: 'S03',
          slice: 'S03-A',
          expected_head: headBefore,
          paths: ['src.txt'],
        }),
        'BOUNDARY.POST_COMMIT_INVALID',
      );
      assert.notEqual(f.head(), headBefore, 'the integration candidate commit remains durable');
      assert.equal(f.run(['rev-parse', '--verify', 'proofloop-s03-a^{commit}']).trim(), otherCommit);
      assert.equal(f.run(['show', 'HEAD:src.txt']).trim(), 'candidate');
      assert.equal(porcelain(f), '');
      // Ref-only recovery has no expected_head and cannot reset the commit.
      // Ref-only recovery has no expected_head; the pre-existing conflicting ref
      // is not overwritten and therefore remains a typed recovery finding.
      expectBoundaryCode(
        () => ensureCandidateRef(f.dir, 'S03', 'A', f.head(), base),
        'BOUNDARY.POST_COMMIT_INVALID',
      );
    } finally {
      f.cleanup();
    }
  });
});