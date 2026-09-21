/**
 * Git worktree lifecycle mechanical seam tests.
 *
 * # PO: PO-S03-E-01
 *
 * Every case uses a throwaway Git fixture.  The production worktree is never
 * touched; create/remove/list are observed through the Git worktree seam.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { makeFixture, commitAll, type Fixture } from './helpers';
import {
  canonicalWorktreePath,
  createGitWorktree,
  listGitWorktrees,
  removeGitWorktree,
  GitWorktreeError,
  type GitWorktreeRequest,
} from '../dist/git-worktree';

function expectWorktreeCode(fn: () => unknown, code: GitWorktreeError['code']): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof GitWorktreeError) {
      assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
      return error.message;
    }
    throw error;
  }
  assert.fail(`expected GitWorktreeError ${code}, but no error was thrown`);
}

function setupFixture(): Fixture {
  const fixture = makeFixture();
  fixture.write('README.md', 'baseline\n');
  commitAll(fixture, 'baseline');
  return fixture;
}

function request(overrides: Partial<GitWorktreeRequest> = {}): GitWorktreeRequest {
  return { stage: 'S03', slice: 'S03-E', ...overrides };
}

describe('Git worktree lifecycle (PO-S03-E-01; temp Git fixture)', () => {
  test('creates a canonical detached worktree, lists it, and removes it consistently', () => {
    const fixture = setupFixture();
    try {
      const baseHead = fixture.head();
      const created = createGitWorktree(fixture.dir, request());

      assert.equal(created.relative_path, '.proofloop/worktrees/S03-S03-E');
      assert.equal(created.path, path.join(fixture.dir, created.relative_path));
      assert.equal(created.base_ref, baseHead);
      assert.equal(created.head, baseHead);
      assert.equal(created.detached, true);
      assert.equal(fixture.head(), baseHead, 'creating a worktree must not move the main HEAD');
      assert.equal(fixture.run(['status', '--porcelain']).trim(), '', 'main worktree stays clean');

      const listed = listGitWorktrees(fixture.dir);
      const entry = listed.find((candidate) => candidate.relative_path === created.relative_path);
      assert.ok(entry, 'created worktree must be present in git worktree list');
      assert.equal(entry?.head, baseHead);
      assert.equal(entry?.detached, true);
      assert.equal(entry?.branch, null);

      const removed = removeGitWorktree(fixture.dir, request());
      assert.equal(removed.removed, true);
      assert.equal(removed.relative_path, created.relative_path);
      assert.equal(fs.existsSync(created.path), false);
      assert.equal(
        listGitWorktrees(fixture.dir).some((candidate) => candidate.relative_path === created.relative_path),
        false,
        'removed worktree must not remain in the Git worktree list',
      );
      assert.equal(fixture.head(), baseHead, 'removing a worktree must not move the main HEAD');
      assert.equal(fixture.run(['status', '--porcelain']).trim(), '');
    } finally {
      fixture.cleanup();
    }
  });

  test('accepts an existing empty canonical directory but rejects a non-empty target', () => {
    const fixture = setupFixture();
    try {
      const target = canonicalWorktreePath(fixture.dir, 'S03', 'S03-E');
      fs.mkdirSync(target, { recursive: true });
      const created = createGitWorktree(fixture.dir, request());
      assert.equal(created.path, target);
      removeGitWorktree(fixture.dir, request());

      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'occupied.txt'), 'do not overwrite\n', 'utf8');
      const message = expectWorktreeCode(
        () => createGitWorktree(fixture.dir, request()),
        'WORKTREE.PATH_OCCUPIED',
      );
      assert.match(message, /empty|occupied|target/i);
      assert.equal(fs.readFileSync(path.join(target, 'occupied.txt'), 'utf8'), 'do not overwrite\n');
      assert.equal(fixture.run(['status', '--porcelain']).trim(), '');
      fs.rmSync(target, { recursive: true, force: true });
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects path traversal and protected-name components before Git writes', () => {
    const fixture = setupFixture();
    try {
      const headBefore = fixture.head();
      const traversal = expectWorktreeCode(
        () => createGitWorktree(fixture.dir, request({ slice: '../outside' })),
        'WORKTREE.REQUEST_INVALID',
      );
      assert.match(traversal, /slice|canonical|identifier/i);
      const protectedName = expectWorktreeCode(
        () => createGitWorktree(fixture.dir, request({ slice: '.git' })),
        'WORKTREE.REQUEST_INVALID',
      );
      assert.match(protectedName, /slice|canonical|identifier/i);
      assert.equal(fixture.head(), headBefore);
      assert.equal(fixture.run(['status', '--porcelain']).trim(), '');
      assert.equal(
        listGitWorktrees(fixture.dir).some((entry) => entry.relative_path === '.proofloop/worktrees/S03-S03-E'),
        false,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('returns a typed remove failure and preserves the worktree until cleanup succeeds', () => {
    const fixture = setupFixture();
    try {
      const created = createGitWorktree(fixture.dir, request());
      fs.writeFileSync(path.join(created.path, 'README.md'), 'uncommitted change\n', 'utf8');
      const message = expectWorktreeCode(
        () => removeGitWorktree(fixture.dir, request()),
        'WORKTREE.REMOVE_FAILED',
      );
      assert.match(message, /remove|dirty|uncommitted/i);
      assert.equal(fs.existsSync(created.path), true);
      assert.equal(
        listGitWorktrees(fixture.dir).some((entry) => entry.relative_path === created.relative_path),
        true,
      );

      // Restore the fixture worktree and prove the same mechanical removal can
      // then complete.  This is test-only Git plumbing inside the temp fixture.
      fixture.run(['-C', created.path, 'restore', '--worktree', '--staged', '.']);
      const removed = removeGitWorktree(fixture.dir, request());
      assert.equal(removed.removed, true);
    } finally {
      fixture.cleanup();
    }
  });
  test('refuses to hide dirty or staged state in the main worktree', () => {
    const fixture = setupFixture();
    try {
      fixture.write('README.md', 'dirty\n');
      expectWorktreeCode(() => createGitWorktree(fixture.dir, request()), 'WORKTREE.DIRTY_WORKTREE');
      fixture.run(['restore', '--worktree', '.']);
      fixture.write('staged.txt', 'staged\n');
      fixture.run(['add', 'staged.txt']);
      expectWorktreeCode(() => createGitWorktree(fixture.dir, request()), 'WORKTREE.INDEX_NOT_EMPTY');
      assert.equal(fixture.run(['rev-parse', 'HEAD']).trim(), fixture.head());
    } finally {
      fixture.cleanup();
    }
  });

  test('tolerates legitimate external worktrees outside the project root without blocking in-root cleanup', () => {
    const fixture = setupFixture();
    try {
      const baseHead = fixture.head();
      // A legitimate worktree registered against this repository but placed
      // OUTSIDE the canonical project root (e.g. created by another tool)
      // appears in `git worktree list` and must not poison in-root ops.
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-external-'));
      try {
        fixture.run(['worktree', 'add', '--detach', externalDir, 'HEAD']);
        assert.equal(fs.readFileSync(path.join(externalDir, 'README.md'), 'utf8'), 'baseline\n');

        const listed = listGitWorktrees(fixture.dir);
        assert.equal(
          listed.some((entry) => entry.path === externalDir),
          false,
          'external worktree must be tolerated (omitted) by the list for this project',
        );

        // In-root create/list/remove must keep working while the external
        // entry is present.
        const created = createGitWorktree(fixture.dir, request());
        assert.equal(created.relative_path, '.proofloop/worktrees/S03-S03-E');
        assert.equal(
          listGitWorktrees(fixture.dir).some((candidate) => candidate.relative_path === created.relative_path),
          true,
        );
        const removed = removeGitWorktree(fixture.dir, request());
        assert.equal(removed.removed, true);
        assert.equal(fs.existsSync(created.path), false);
        assert.equal(fixture.head(), baseHead);

        // The seam never inspects/removes/rewrites the external worktree.
        assert.equal(fs.existsSync(path.join(externalDir, 'README.md')), true);
        assert.equal(fs.readFileSync(path.join(externalDir, 'README.md'), 'utf8'), 'baseline\n');
      } finally {
        fixture.run(['worktree', 'remove', '--force', externalDir]);
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    } finally {
      fixture.cleanup();
    }
  });

});
