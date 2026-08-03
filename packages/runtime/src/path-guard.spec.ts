/**
 * path-guard — shared trust-root path boundary helpers (S2-F-003)
 *
 * Unit tests over REAL filesystem fixtures (temp dirs + real symlinks),
 * verifying the component-wise walk semantics that the plugin path-boundary
 * (CV S02-B-INITIAL-PO01-SYMLINK, S02-B-RECHECK-3) established:
 *
 *   - legal paths resolve inside the root (canonical path returned);
 *   - `..` is applied to the RESOLVED directory (never the lexical prefix),
 *     so a symlink + `..` mixed traversal cannot hide an escape;
 *   - an existing symlink component whose FULL chain escapes the root is
 *     rejected (including a broken symlink whose target stays outside);
 *   - a symlink cycle is detected (fail closed);
 *   - a missing component becomes a lexical tail (legal, still inside);
 *   - an in-root symlink resolves to its realpath (legal);
 *   - absolute escapes and root-identity are handled.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  canonicalPathWithinRoot,
  assertCanonicalWithinRoot,
  PathEscapeError,
  openNoFollowRead,
} from './path-guard.js';

// Inode-mismatch / stat-error injection (S2-F-003 final supplement + stat-error
// fix): mock `node:fs` so `statSync` can be (a) fabricated with a DIFFERENT
// dev/ino than the real file (simulating the file being replaced between the
// expectation capture and the open) or (b) forced to throw a non-ENOENT error
// (EIO/EACCES) — the expected identity cannot be captured, which must fail
// closed. The mock is transparent (`...real`) except when a toggle is set.
const inodeState = vi.hoisted(() => ({
  mismatchPath: undefined as string | undefined,
  statErrorPath: undefined as string | undefined,
  statErrorCode: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    statSync: ((p: fs.PathLike, _opts?: fs.StatOptions | undefined) => {
      if (
        inodeState.statErrorPath !== undefined &&
        inodeState.statErrorCode !== undefined &&
        String(p) === inodeState.statErrorPath
      ) {
        const err = new Error('injected statSync error') as NodeJS.ErrnoException;
        err.code = inodeState.statErrorCode;
        throw err;
      }
      const st = real.statSync(p as string);
      if (inodeState.mismatchPath !== undefined && String(p) === inodeState.mismatchPath) {
        return { ...st, dev: st.dev + 1, ino: st.ino + 1 } as fs.Stats;
      }
      return st;
    }) as unknown as typeof real.statSync,
  };
});

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function makeRoot(prefix = 'proofloop-runtime-pathguard-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });
  return root;
}

function makeExternal(prefix = 'proofloop-runtime-pathguard-out-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });
  return dir;
}

function writeFile(root: string, rel: string, content = 'x'): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// ============================================================
// Legal paths
// ============================================================

describe('canonicalPathWithinRoot — legal paths resolve inside the root', () => {
  it('returns the canonical path for a normal nested path', () => {
    const root = makeRoot();
    const p = writeFile(root, '.proofloop/receipts/cv/S02-C/a.json');
    expect(canonicalPathWithinRoot(root, p)).toBe(fs.realpathSync(p));
  });

  it('resolves a relative path inside the root', () => {
    const root = makeRoot();
    writeFile(root, '.proofloop/receipts/a.json');
    expect(canonicalPathWithinRoot(root, '.proofloop/receipts')).toBe(
      path.join(fs.realpathSync(root), '.proofloop', 'receipts'),
    );
  });

  it('returns the canonical root for p === root', () => {
    const root = makeRoot();
    expect(canonicalPathWithinRoot(root, root)).toBe(fs.realpathSync(root));
  });

  it('applies .. to the resolved directory so an in-root ascent stays legal', () => {
    const root = makeRoot();
    writeFile(root, 'a/b/c.txt');
    // root/a/b/../c.txt → root/a/c.txt (inside root).
    const p = path.join(root, 'a', 'b', '..', 'c.txt');
    expect(canonicalPathWithinRoot(root, p)).toBe(
      path.join(fs.realpathSync(root), 'a', 'c.txt'),
    );
  });

  it('treats a missing tail as a legal lexical path inside the root', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    const p = path.join(root, 'a', 'missing', 'deep', 'file.json');
    expect(canonicalPathWithinRoot(root, p)).not.toBeNull();
    expect(canonicalPathWithinRoot(root, p)).toBe(
      path.join(fs.realpathSync(root), 'a', 'missing', 'deep', 'file.json'),
    );
  });

  it('resolves an in-root symlink to its real target (legal redirect)', () => {
    const root = makeRoot();
    writeFile(root, 'real/dir/target.json');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), 'dir');
    const p = path.join(root, 'alias', 'dir', 'target.json');
    expect(canonicalPathWithinRoot(root, p)).toBe(
      path.join(fs.realpathSync(root), 'real', 'dir', 'target.json'),
    );
  });
});

// ============================================================
// Escapes — fail closed
// ============================================================

describe('canonicalPathWithinRoot — escapes return null (fail closed)', () => {
  it('rejects an absolute path lexically outside the root', () => {
    const root = makeRoot();
    const outside = makeExternal();
    expect(canonicalPathWithinRoot(root, path.join(outside, 'secret.txt'))).toBeNull();
  });

  it('rejects .. that escapes the root', () => {
    const root = makeRoot();
    // parent/outside.json
    const outsideFile = path.join(path.dirname(root), `escape-${path.basename(root)}.json`);
    writeFile(path.dirname(root), path.basename(outsideFile));
    const p = path.join(root, '..', path.basename(outsideFile));
    expect(canonicalPathWithinRoot(root, p)).toBeNull();
  });

  it('rejects a symlink component whose target is outside the root', () => {
    const root = makeRoot();
    const outside = makeExternal();
    writeFile(outside, 'secret.json');
    fs.symlinkSync(outside, path.join(root, 'leak'), 'dir');
    expect(canonicalPathWithinRoot(root, path.join(root, 'leak', 'secret.json'))).toBeNull();
    // Even a missing tail under the escaped symlink is rejected.
    expect(canonicalPathWithinRoot(root, path.join(root, 'leak', 'missing.json'))).toBeNull();
  });

  it('rejects a symlink + .. mixed traversal (.. applies to the resolved dir)', () => {
    const root = makeRoot();
    const outside = makeExternal();
    writeFile(outside, 'sub/inner.txt');
    fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'leak'), 'dir');
    // root/leak/sub/../inner.txt — the .. must NOT collapse lexically to
    // root/leak/inner.txt; it applies to the RESOLVED outside dir.
    const p = path.join(root, 'leak', 'sub', '..', 'inner.txt');
    expect(canonicalPathWithinRoot(root, p)).toBeNull();
  });

  it('rejects a broken symlink whose full chain escapes the root', () => {
    const root = makeRoot();
    const outside = makeExternal();
    // Target outside/does-not-exist.txt does NOT exist — a plain path.resolve
    // would lexicalize it; the component-wise chain walk still rejects it.
    fs.symlinkSync(path.join(outside, 'does-not-exist.txt'), path.join(root, 'broken'));
    expect(canonicalPathWithinRoot(root, path.join(root, 'broken'))).toBeNull();
  });

  it('rejects an absolute-target symlink that escapes the root', () => {
    const root = makeRoot();
    const outside = makeExternal();
    writeFile(outside, 'target.json');
    fs.symlinkSync(path.join(outside, 'target.json'), path.join(root, 'abs-link'));
    expect(canonicalPathWithinRoot(root, path.join(root, 'abs-link'))).toBeNull();
  });

  it('detects a symlink cycle and fails closed', () => {
    const root = makeRoot();
    // a → b and b → a: realpathSync loops (ELOOP) and the chain walk must
    // detect the cycle via the shared visited set and fail closed.
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a'), 'dir');
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'), 'dir');
    expect(canonicalPathWithinRoot(root, path.join(root, 'a', 'x'))).toBeNull();
  });

  it('rejects an empty/missing root as a boundary violation', () => {
    expect(canonicalPathWithinRoot('', 'x')).toBeNull();
    expect(canonicalPathWithinRoot('/nonexistent-proofloop-root', '')).toBeNull();
  });
});

// ============================================================
// assert variant
// ============================================================

describe('assertCanonicalWithinRoot — structured PathEscapeError', () => {
  it('returns the canonical path for a legal path', () => {
    const root = makeRoot();
    const p = writeFile(root, 'a/b.json');
    expect(assertCanonicalWithinRoot(root, p)).toBe(fs.realpathSync(p));
  });

  it('throws PathEscapeError on an escape', () => {
    const root = makeRoot();
    const outside = makeExternal();
    fs.symlinkSync(outside, path.join(root, 'leak'), 'dir');
    const p = path.join(root, 'leak', 'x.json');
    expect(() => assertCanonicalWithinRoot(root, p)).toThrow(PathEscapeError);
    expect(() => assertCanonicalWithinRoot(root, p)).toThrow(/trust boundary/);
  });
});

// ============================================================
// openNoFollowRead — atomic no-follow open (S2-F-003 round 3)
// ============================================================

describe('openNoFollowRead — atomic no-follow boundary (S2-F-003 round 3)', () => {
  it('opens a real file and reads through the fd (content identical to readFileSync)', () => {
    const root = makeRoot();
    const p = writeFile(root, 'dir/data.json', '{"hello":"world"}');
    const opened = openNoFollowRead(root, p);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      try {
        expect(fs.readFileSync(opened.fd, 'utf-8')).toBe('{"hello":"world"}');
        expect(opened.filePath).toBe(fs.realpathSync(p));
      } finally {
        fs.closeSync(opened.fd);
      }
    }
  });

  it('fails closed (escape) when the final component is a symlink to an external file', () => {
    const root = makeRoot();
    const outside = makeExternal();
    const target = path.join(outside, 'secret.json');
    fs.writeFileSync(target, '{"secret":true}', 'utf-8');
    fs.mkdirSync(path.join(root, 'dir'), { recursive: true });
    fs.symlinkSync(target, path.join(root, 'dir', 'fake.json'));
    const opened = openNoFollowRead(root, path.join(root, 'dir', 'fake.json'));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe('escape');
    }
  });

  it('fails closed (escape) when the final component is an in-root symlink (no-follow rejects it)', () => {
    const root = makeRoot();
    const real = writeFile(root, 'real.json', 'x');
    fs.symlinkSync(real, path.join(root, 'alias.json'));
    const opened = openNoFollowRead(root, path.join(root, 'alias.json'));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe('escape');
    }
  });

  it('reports unreadable (legal absence) for a missing file', () => {
    const root = makeRoot();
    const opened = openNoFollowRead(root, path.join(root, 'missing.json'));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe('unreadable');
    }
  });

  it('fails closed (escape) when the parent chain escapes the root', () => {
    const root = makeRoot();
    const outside = makeExternal();
    fs.writeFileSync(path.join(outside, 'x.json'), 'x', 'utf-8');
    fs.symlinkSync(outside, path.join(root, 'leak'), 'dir');
    const opened = openNoFollowRead(root, path.join(root, 'leak', 'x.json'));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe('escape');
    }
  });

  it('opens the canonical parent: a lexical parent swap cannot redirect the open', () => {
    const root = makeRoot();
    const realDir = path.join(root, 'real');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, path.join(root, 'alias'), 'dir');
    const p = writeFile(root, 'real/data.json', 'canonical');
    // Open through the LEXICAL path (root/alias/data.json).
    const opened = openNoFollowRead(root, path.join(root, 'alias', 'data.json'));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      try {
        // The open targeted the canonical parent realpath.
        expect(opened.filePath).toBe(path.join(realDir, 'data.json'));
        expect(fs.readFileSync(opened.fd, 'utf-8')).toBe('canonical');
      } finally {
        fs.closeSync(opened.fd);
      }
    }
    // Swap the lexical alias to an external symlink — the canonical target is
    // unaffected (open of the already-computed canonical path still works).
    const outside = makeExternal();
    fs.rmSync(path.join(root, 'alias'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(root, 'alias'), 'dir');
    const reopened = openNoFollowRead(root, path.join(root, 'alias', 'data.json'));
    // Re-resolving now walks the swapped lexical parent → escape (fail-closed).
    expect(reopened.ok).toBe(false);
    if (!reopened.ok) {
      expect(reopened.reason).toBe('escape');
    }
  });

  it('dev/ino identity matches on the normal path (no swap → fd returned)', () => {
    const root = makeRoot();
    const p = writeFile(root, 'dir/data.json', '{"a":1}');
    const opened = openNoFollowRead(root, p);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      try {
        expect(fs.readFileSync(opened.fd, 'utf-8')).toBe('{"a":1}');
        expect(opened.filePath).toBe(fs.realpathSync(p));
      } finally {
        fs.closeSync(opened.fd);
      }
    }
  });

  it('fails closed (inode-mismatch) when the expected file identity differs from the opened fd', () => {
    const root = makeRoot();
    const p = writeFile(root, 'dir/data.json', '{"a":1}');
    // Inject: the expectation stat (before open) reports a DIFFERENT dev/ino
    // than the real file the O_NOFOLLOW open actually opens — simulating the
    // canonical path being replaced between the expectation capture and the
    // open. The fd must be closed and the open must fail closed.
    inodeState.mismatchPath = p;
    try {
      const opened = openNoFollowRead(root, p);
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe('inode-mismatch');
      }
    } finally {
      inodeState.mismatchPath = undefined;
    }
  });

  it('fails closed (not-regular-file) on a FIFO WITHOUT blocking (O_NONBLOCK, S2-F-003-R3-FIFO-BLOCK-BEFORE-FSTAT)', () => {
    const root = makeRoot();
    const fifoPath = path.join(root, 'dir', 'fake.json');
    fs.mkdirSync(path.dirname(fifoPath), { recursive: true });
    // Node has no mkfifo API — use the coreutils binary in the TEST (the
    // production path never shells out). A FIFO with no writer would block an
    // O_RDONLY open forever; O_NONBLOCK must return immediately and the
    // post-open isFile check must reject it (fail-closed, never read).
    execFileSync('mkfifo', [fifoPath]);

    const opened = openNoFollowRead(root, fifoPath);

    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe('not-regular-file');
    }
  });

  it('a FIFO with buffered data is still rejected (isFile before any read)', () => {
    const root = makeRoot();
    const fifoPath = path.join(root, 'dir', 'fake.json');
    fs.mkdirSync(path.dirname(fifoPath), { recursive: true });
    execFileSync('mkfifo', [fifoPath]);
    // Hold the read end open (O_RDONLY|O_NONBLOCK) and write a payload into the
    // FIFO — even with data available, the open must not be followed by a read
    // because the post-open isFile check rejects the FIFO first.
    const readerFd = fs.openSync(
      fifoPath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    try {
      fs.writeFileSync(fifoPath, '{"attacker":true}', 'utf-8');
      const opened = openNoFollowRead(root, fifoPath);
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe('not-regular-file');
      }
    } finally {
      fs.closeSync(readerFd);
    }
  });

  it('fails closed (unreadable, no fd) when statSync fails with EIO on the expected identity capture', () => {
    const root = makeRoot();
    const p = writeFile(root, 'dir/data.json', '{"a":1}');
    inodeState.statErrorPath = p;
    inodeState.statErrorCode = 'EIO';
    try {
      const opened = openNoFollowRead(root, p);
      // The expected identity cannot be captured — the open must NOT proceed
      // and no fd may be returned (fail-closed, existing unreadable semantics).
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe('unreadable');
      }
    } finally {
      inodeState.statErrorPath = undefined;
      inodeState.statErrorCode = undefined;
    }
  });

  it('fails closed (unreadable, no fd) when statSync fails with EACCES on the expected identity capture', () => {
    const root = makeRoot();
    const p = writeFile(root, 'dir/data.json', '{"a":1}');
    inodeState.statErrorPath = p;
    inodeState.statErrorCode = 'EACCES';
    try {
      const opened = openNoFollowRead(root, p);
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe('unreadable');
      }
    } finally {
      inodeState.statErrorPath = undefined;
      inodeState.statErrorCode = undefined;
    }
  });
});
