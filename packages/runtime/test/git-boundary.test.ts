/**
 * slice-output detached-worktree boundary regression tests (finding
 * EXEC-S05-SLICE-OUTPUT-001).
 *
 * The canonical Slice worktree seam (`createGitWorktree`) creates DETACHED
 * worktrees (`git worktree add --detach`).  The slice-output boundary pins the
 * detached identity with `expected_branch: "HEAD"`; before the repair,
 * `assertBranch` ran `git symbolic-ref --quiet --short HEAD`, which exits
 * non-zero on a detached HEAD, and the generic `runGit` mapping turned that
 * into `BOUNDARY.GIT_UNAVAILABLE` before any write.
 *
 * Coverage (RED/GREEN evidence for the repair):
 *  - slice-output on a detached Slice worktree accepts the real `HEAD`
 *    sentinel, still fails closed on a wrong `expected_head` (HEAD pin wins),
 *    commits exactly the six declared CV-PASS paths (exact six-path freeze),
 *    creates the canonical candidate ref, and reports a clean worktree;
 *  - the `HEAD` sentinel is verified, never assumed: slice-output on an
 *    ATTACHED branch fails `BOUNDARY.BRANCH_MISMATCH`;
 *  - non-slice boundary types keep their strict branch check: a detached
 *    worktree with `expected_branch` still fails closed (no detached
 *    acceptance outside slice-output);
 *  - slice-output with a REAL branch name on a detached worktree keeps the
 *    unchanged symbolic-ref failure path and never establishes a candidate
 *    ref, proving only the detached `HEAD` sentinel is special-cased.
 *
 * Imports the compiled runtime dist (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { makeFixture, commitAll, type Fixture } from './helpers';
import { closeGitBoundary, GitBoundaryError, canonicalCandidateRef, ensureCandidateRef } from '../dist/git-boundary';
import { buildCandidateFact, validateCandidateFact, IntegrationStateError } from '../dist/execute/integration-state';
import { createGitWorktree } from '../dist/git-worktree';

/** The exact six CV-PASS Slice output paths observed in finding EXEC-S05-SLICE-OUTPUT-001. */
const SIX_MES_PATHS: readonly string[] = [
  'packages/runtime/src/mes/types.ts',
  'packages/runtime/src/mes/validate.ts',
  'packages/runtime/src/mes/binding.ts',
  'packages/runtime/test/mes-schema.test.ts',
  'packages/runtime/test/mes-execute-schema.test.ts',
  'packages/runtime/test/mes-binding.test.ts',
];

const SORTED_SIX = [...SIX_MES_PATHS].sort();

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

/** True when the git ref resolves to a commit (missing ref -> false, no throw). */
function refResolves(fixture: Fixture, ref: string): boolean {
  try {
    return fixture.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim().length === 40;
  } catch {
    return false;
  }
}

/** Write a file inside a (possibly detached) worktree path. */
function writeWorktreeFile(worktree: string, relative: string, content: string): void {
  const abs = path.join(worktree, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

/** Every canonical candidate ref currently present in the fixture. */
function proofloopRefs(fixture: Fixture): string[] {
  return fixture
    .run(['for-each-ref', '--format=%(refname)', 'refs/heads/'])
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('refs/heads/proofloop-'));
}

/** Assert a closed-Slice-identity rejection, labelled with its category. */
function expectRejectedSlice(fn: () => unknown, label: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof GitBoundaryError) {
      assert.equal(
        error.code,
        'BOUNDARY.REQUEST_INVALID',
        `${label}: expected BOUNDARY.REQUEST_INVALID, got ${error.code}: ${error.message}`
      );
      return;
    }
    throw error;
  }
  assert.fail(`${label}: expected BOUNDARY.REQUEST_INVALID, but no error was thrown`);
}

describe('slice-output detached-worktree boundary (EXEC-S05-SLICE-OUTPUT-001)', () => {
  test('detached Slice worktree: HEAD sentinel accepted, exact six-path freeze, canonical candidate ref (GREEN)', () => {
    const f = makeFixture();
    try {
      f.write('README.md', 'init');
      commitAll(f, 'base');
      const base = f.head();

      // The canonical Slice worktree seam: DETACHED at the accepted base.
      const wt = createGitWorktree(f.dir, { stage: 'S05', slice: 'S05-A', base_ref: base });
      assert.equal(wt.detached, true, 'createGitWorktree must create a detached Slice worktree');
      assert.equal(wt.head, base);
      // The seam never changes the main worktree.
      assert.equal(f.head(), base);

      // Worker CV-PASS output lands in the detached worktree (six paths).
      for (const p of SIX_MES_PATHS) writeWorktreeFile(wt.path, p, `cv-passed ${p}\n`);

      // Fail-closed order is preserved: a wrong expected_head must fail with
      // HEAD_MISMATCH before the detached identity is considered.
      expectBoundaryCode(
        () =>
          closeGitBoundary(wt.path, {
            boundary_type: 'slice-output',
            stage: 'S05',
            slice: 'S05-A',
            expected_head: 'a'.repeat(40),
            expected_branch: 'HEAD',
            paths: [...SIX_MES_PATHS],
          }),
        'BOUNDARY.HEAD_MISMATCH',
      );
      assert.equal(f.run(['rev-parse', 'HEAD'], { cwd: wt.path }).trim(), base);

      // The real slice-output transaction freezes the detached worktree.
      const result = closeGitBoundary(wt.path, {
        boundary_type: 'slice-output',
        stage: 'S05',
        slice: 'S05-A',
        expected_head: base,
        expected_branch: 'HEAD',
        paths: [...SIX_MES_PATHS],
      });

      // Exact six-path freeze: committed set == declared set, nothing else.
      assert.deepEqual(result.changed_files, SORTED_SIX);
      assert.equal(result.commit_message, 'slice-output: S05-S05-A');
      assert.equal(result.pre_commit_head, base);
      assert.notEqual(result.commit_sha, base);
      assert.equal(result.dirty_after, false);

      // Canonical candidate-ref establishment (shared repo, visible from main).
      assert.equal(canonicalCandidateRef('S05', 'S05-A'), 'proofloop-s05-a');
      assert.equal(f.run(['rev-parse', '--verify', 'proofloop-s05-a^{commit}']).trim(), result.commit_sha);

      // The detached worktree is clean and the main worktree is untouched.
      assert.equal(f.run(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: wt.path }).trim(), '');
      assert.equal(f.head(), base);
    } finally {
      f.cleanup();
    }
  });

  test('detached worktree: non-slice boundary keeps the strict branch check (BOUNDARY.GIT_UNAVAILABLE)', () => {
    const f = makeFixture();
    try {
      f.write('README.md', 'init');
      commitAll(f, 'base');
      const base = f.head();
      const wt = createGitWorktree(f.dir, { stage: 'S05', slice: 'S05-B', base_ref: base });
      writeWorktreeFile(wt.path, 'packages/runtime/src/mes/types.ts', 'dirty\n');

      // direct-fix with expected_branch still requires a symbolic-ref HEAD;
      // a detached worktree must keep failing closed exactly as before.
      const msg = expectBoundaryCode(
        () =>
          closeGitBoundary(wt.path, {
            boundary_type: 'direct-fix',
            paths: ['packages/runtime/src/mes/types.ts'],
            expected_head: base,
            expected_branch: 'HEAD',
            description: 'non-slice detached',
          }),
        'BOUNDARY.GIT_UNAVAILABLE',
      );
      assert.match(msg, /symbolic-ref/);
      // No write happened: HEAD unchanged and no commit/ref was created.
      assert.equal(f.run(['rev-parse', 'HEAD'], { cwd: wt.path }).trim(), base);
      assert.equal(refResolves(f, 'proofloop-s05-b'), false);
    } finally {
      f.cleanup();
    }
  });

  test('slice-output HEAD sentinel on an ATTACHED branch fails closed (BOUNDARY.BRANCH_MISMATCH)', () => {
    const f = makeFixture();
    try {
      f.write('packages/runtime/src/mes/types.ts', 'base');
      commitAll(f, 'base');
      const base = f.head();
      // The main worktree is attached to a real branch: the `HEAD` sentinel
      // must NOT be accepted as the detached identity.
      assert.notEqual(f.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(), '');
      f.write('packages/runtime/src/mes/types.ts', 'dirty');

      const msg = expectBoundaryCode(
        () =>
          closeGitBoundary(f.dir, {
            boundary_type: 'slice-output',
            stage: 'S05',
            slice: 'S05-A',
            expected_head: base,
            expected_branch: 'HEAD',
            paths: ['packages/runtime/src/mes/types.ts'],
          }),
        'BOUNDARY.BRANCH_MISMATCH',
      );
      assert.match(msg, /detached/);
      // Nothing was written.
      assert.equal(f.head(), base);
      assert.equal(refResolves(f, 'proofloop-s05-a'), false);
    } finally {
      f.cleanup();
    }
  });

  test('slice-output with a REAL branch name on a detached worktree keeps the unchanged symbolic-ref failure', () => {
    const f = makeFixture();
    try {
      f.write('README.md', 'init');
      commitAll(f, 'base');
      const base = f.head();
      const wt = createGitWorktree(f.dir, { stage: 'S05', slice: 'S05-C', base_ref: base });
      writeWorktreeFile(wt.path, 'packages/runtime/src/mes/types.ts', 'dirty\n');

      // Only the `HEAD` sentinel is special-cased: a real branch expectation
      // on a detached worktree still fails exactly as before the repair and
      // never establishes a candidate ref.
      expectBoundaryCode(
        () =>
          closeGitBoundary(wt.path, {
            boundary_type: 'slice-output',
            stage: 'S05',
            slice: 'S05-C',
            expected_head: base,
            expected_branch: 'v2-herdr',
            paths: ['packages/runtime/src/mes/types.ts'],
          }),
        'BOUNDARY.GIT_UNAVAILABLE',
      );
      assert.equal(f.run(['rev-parse', 'HEAD'], { cwd: wt.path }).trim(), base);
      assert.equal(refResolves(f, 'proofloop-s05-c'), false);
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// S08-B canonical Slice identity closed language (PO-S08-B-01/02/03).
// ---------------------------------------------------------------------------

/**
 * One entry per rejected category of the closed canonical Slice identity
 * language; a category with several shapes carries several entries.
 */
const NON_CANONICAL_SLICE_IDENTITIES: readonly {
  readonly label: string;
  readonly stage: string;
  readonly slice: string;
}[] = [
  { label: 'empty value', stage: 'S08', slice: '' },
  { label: 'whitespace-only value', stage: 'S08', slice: '   ' },
  { label: 'lowercase token', stage: 'S08', slice: 'b' },
  { label: 'lowercase stage-scoped form', stage: 'S08', slice: 'S08-b' },
  { label: 'mixed-case maintenance form', stage: 'S06', slice: 'S06-R-d' },
  { label: 'digits inside the token', stage: 'S08', slice: 'S08-B1' },
  { label: 'digits inside a maintenance token', stage: 'S08', slice: 'S08-B1-C' },
  { label: 'dot separator', stage: 'S08', slice: 'S08-B.C' },
  { label: 'underscore separator', stage: 'S08', slice: 'S08_B' },
  { label: 'range dots', stage: 'S08', slice: 'S08..B' },
  { label: 'brace revision syntax', stage: 'S08', slice: 'S08-B@{}' },
  { label: 'control character', stage: 'S08', slice: 'S08-B\u0001' },
  { label: 'stage-only value', stage: 'S08', slice: 'S08' },
  { label: 'four tokens', stage: 'S08', slice: 'S08-B-C-D' },
  { label: 'three bare tokens', stage: 'S08', slice: 'B-C-D' },
  { label: 'foreign stage prefix', stage: 'S08', slice: 'S06-R-D' },
  { label: 'overlapping stage prefix', stage: 'S08', slice: 'S080-B' },
];

/** MES git-fact domain binding for the consumer-equality check (PO-S08-B-03). */
const CONSUMER_PLAN_BINDING = {
  binding_stage: 'accepted',
  accepted_plan_ref: 'delivery/stages/S08/plan.md',
  source_candidate_plan_ref: 'delivery/stages/S08/plan.md',
  verification_result_ref: 'mes:result:S08:planning-verification-1',
  plan_digest: 'a'.repeat(64),
};

const CONSUMER_GIT_BASIS = {
  head: 'b'.repeat(40),
  branch: 'HEAD',
  worktree: '.proofloop/worktrees/S08-S08-B',
};

describe('canonical Slice identity closed language / stage equality (PO-S08-B-01 / PO-S08-B-02 / PO-S08-B-03)', () => {
  test('slice-output rejects every non-canonical Slice identity before any Git write', () => {
    const f = makeFixture();
    try {
      f.write('a.txt', 'base\n');
      commitAll(f, 'base');
      const base = f.head();
      f.write('a.txt', 'dirty\n');
      const dirtyBefore = f.run(['status', '--porcelain=v1', '--untracked-files=all']).trim();
      assert.notEqual(dirtyBefore, '', 'fixture must carry a dirty change so a Git write would be observable');

      // Ordering proof: the rejection precedes ANY Git access.  A root that is
      // not a Git repository at all still reports the identity rejection ...
      const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-nongit-'));
      try {
        expectRejectedSlice(
          () =>
            closeGitBoundary(nonGitRoot, {
              boundary_type: 'slice-output',
              stage: 'S08',
              slice: 'S08-b',
              expected_head: 'a'.repeat(40),
              paths: ['a.txt'],
            }),
          'non-canonical identity with no Git repository at all'
        );
        // ... while a canonical identity in the same root does reach Git and
        // therefore fails on the missing repository, never on the identity.
        expectBoundaryCode(
          () =>
            closeGitBoundary(nonGitRoot, {
              boundary_type: 'slice-output',
              stage: 'S08',
              slice: 'S08-B',
              expected_head: 'a'.repeat(40),
              paths: ['a.txt'],
            }),
          'BOUNDARY.GIT_UNAVAILABLE'
        );
      } finally {
        fs.rmSync(nonGitRoot, { recursive: true, force: true });
      }

      for (const { label, stage, slice } of NON_CANONICAL_SLICE_IDENTITIES) {
        expectRejectedSlice(
          () =>
            closeGitBoundary(f.dir, {
              boundary_type: 'slice-output',
              stage,
              slice,
              expected_head: base,
              paths: ['a.txt'],
            }),
          label,
        );
        assert.equal(f.head(), base, `${label}: HEAD must stay unchanged`);
        assert.equal(f.run(['diff', '--cached', '--name-only']).trim(), '', `${label}: the Git index must stay empty`);
        assert.equal(
          f.run(['status', '--porcelain=v1', '--untracked-files=all']).trim(),
          dirtyBefore,
          `${label}: the worktree must stay unchanged`
        );
        assert.deepEqual(proofloopRefs(f), [], `${label}: no candidate ref may be created`);
      }
    } finally {
      f.cleanup();
    }
  });

  test('canonicalCandidateRef accepts exactly the closed canonical Slice identity language', () => {
    // Both directions of the ONE closed-set judgement: the four accepted forms
    // (stage-scoped normal / maintenance, bare normal / maintenance) ...
    assert.equal(canonicalCandidateRef('S08', 'S08-B'), 'proofloop-s08-b');
    assert.equal(canonicalCandidateRef('S06', 'S06-R-D'), 'proofloop-s06-r-d');
    assert.equal(canonicalCandidateRef('S08', 'B'), 'proofloop-s08-b');
    assert.equal(canonicalCandidateRef('S06', 'R-D'), 'proofloop-s06-r-d');
    // ... and every rejected category, one executable assertion per category.
    for (const { label, stage, slice } of NON_CANONICAL_SLICE_IDENTITIES) {
      expectRejectedSlice(() => canonicalCandidateRef(stage, slice), label);
    }
  });

  test('slice-output enforces stage equality and binds bare-token forms to the request stage', () => {
    const f = makeFixture();
    try {
      f.write('a.txt', 'base\n');
      commitAll(f, 'base');
      const base = f.head();
      f.write('a.txt', 'dirty\n');

      // Inside the closed language, but the stage prefix is not the request
      // stage: rejected before any Git write.
      for (const slice of ['S06-R-D', 'S09-B', 'S080-B']) {
        expectRejectedSlice(
          () =>
            closeGitBoundary(f.dir, {
              boundary_type: 'slice-output',
              stage: 'S08',
              slice,
              expected_head: base,
              paths: ['a.txt'],
            }),
          `stage equality for ${slice}`
        );
        assert.equal(f.head(), base, `${slice}: HEAD must stay unchanged`);
        assert.deepEqual(proofloopRefs(f), [], `${slice}: no candidate ref may be created`);
      }

      // The stage-scoped form carrying exactly the request stage is accepted and
      // establishes exactly the canonical ref.
      const scoped = closeGitBoundary(f.dir, {
        boundary_type: 'slice-output',
        stage: 'S08',
        slice: 'S08-B',
        expected_head: base,
        paths: ['a.txt'],
      });
      assert.equal(scoped.commit_message, 'slice-output: S08-S08-B');
      assert.equal(scoped.pre_commit_head, base);
      assert.deepEqual(scoped.changed_files, ['a.txt']);
      assert.equal(f.run(['rev-parse', '--verify', 'proofloop-s08-b^{commit}']).trim(), scoped.commit_sha);

      // A bare token binds to its OWN request stage: the same boundary run for
      // stage S06 with the bare maintenance token R-D resolves proofloop-s06-r-d.
      f.write('a.txt', 'dirty-2\n');
      const bare = closeGitBoundary(f.dir, {
        boundary_type: 'slice-output',
        stage: 'S06',
        slice: 'R-D',
        expected_head: scoped.commit_sha,
        paths: ['a.txt'],
      });
      assert.equal(bare.commit_message, 'slice-output: S06-R-D');
      assert.equal(f.run(['rev-parse', '--verify', 'proofloop-s06-r-d^{commit}']).trim(), bare.commit_sha);
    } finally {
      f.cleanup();
    }
  });

  test('equivalent full and bare-token Slice identities produce one canonical candidate ref', () => {
    // Same (stage, token) -> one identity, for both input forms of both modes.
    assert.equal(canonicalCandidateRef('S08', 'S08-B'), canonicalCandidateRef('S08', 'B'));
    assert.equal(canonicalCandidateRef('S06', 'S06-R-D'), canonicalCandidateRef('S06', 'R-D'));

    // End-to-end: establishing the ref from the bare token is an idempotent
    // replay of the stage-scoped form — one ref, one commit, no conflict.
    const f = makeFixture();
    try {
      f.write('src.txt', 'base\n');
      commitAll(f, 'base');
      const base = f.head();
      f.write('src.txt', 'candidate\n');
      const commit = commitAll(f, 'candidate');
      const scoped = ensureCandidateRef(f.dir, 'S08', 'S08-B', commit, base);
      assert.equal(scoped.candidate_ref, 'proofloop-s08-b');
      assert.equal(scoped.created, true);
      const bare = ensureCandidateRef(f.dir, 'S08', 'B', commit, base);
      assert.equal(bare.candidate_ref, scoped.candidate_ref);
      assert.equal(bare.created, false, 'the bare-token form must resolve to the already established ref');
      assert.equal(bare.commit_sha, scoped.commit_sha);
      assert.equal(f.run(['rev-parse', '--verify', 'proofloop-s08-b^{commit}']).trim(), commit);
    } finally {
      f.cleanup();
    }
  });

  test('canonical and maintenance Slice identities establish the exact canonical candidate ref', () => {
    // Exact ref literals (proofloop-<stage>-<lowercase canonical identity>) for
    // both input forms of both modes, taken from the S08-B obligation.
    assert.equal(canonicalCandidateRef('S03', 'S03-A'), 'proofloop-s03-a');
    assert.equal(canonicalCandidateRef('S08', 'S08-B'), 'proofloop-s08-b');
    assert.equal(canonicalCandidateRef('S08', 'B'), 'proofloop-s08-b');
    assert.equal(canonicalCandidateRef('S06', 'S06-R-D'), 'proofloop-s06-r-d');
    assert.equal(canonicalCandidateRef('S06', 'R-D'), 'proofloop-s06-r-d');

    // Consumer equality: the MES git-fact domain resolves the expected identity
    // through this same function and accepts exactly the ref above; a near-miss
    // ref is a typed binding mismatch.
    const binding = {
      stage_id: 'S08',
      slice_id: 'S08-B',
      work_id: 'mes:work:S08:S08-B:1',
      authority_refs: ['tech-spec/contracts.md#2.1.3'],
      plan_binding: CONSUMER_PLAN_BINDING,
      git_basis: CONSUMER_GIT_BASIS,
    };
    const candidate = buildCandidateFact({
      ...binding,
      candidate_ref: 'proofloop-s08-b',
      candidate_base_ref: 'c'.repeat(40),
      commit_sha: 'd'.repeat(40),
      changed_files: ['packages/runtime/src/git-boundary.ts'],
      fact_id: 'mes:fact:git:S08:S08-B:candidate',
    });
    assert.equal(validateCandidateFact(candidate).candidate_ref, 'proofloop-s08-b');
    assert.throws(
      () => validateCandidateFact({ ...candidate, candidate_ref: 'proofloop-S08-B' }),
      IntegrationStateError
    );
  });
});