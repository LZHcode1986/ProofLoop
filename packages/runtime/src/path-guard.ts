/**
 * @proofloop/runtime — shared trust-root path boundary helpers (S2-F-003)
 *
 * Runtime-owned mirror of the retired plugin's `path-boundary.ts` semantics
 * (CV S02-B-INITIAL-PO01-SYMLINK, S02-B-RECHECK-PO01): resolve a path against
 * the canonical project-root trust boundary and enforce the boundary at EVERY
 * existing ancestor component — not just at the final target.
 *
 * The runtime package is independent (the plugin package was retired with the
 * OpenCode plugin, 2026-08-14), so this module re-implements the SAME
 * component-wise walk semantics:
 *
 *   - walks the raw path component-by-component WITHOUT pre-collapsing `..`
 *     lexically (path.join/path.resolve normalize `..` away, hiding a
 *     symlink + `..` mixed traversal);
 *   - keeps the walk on REAL paths (realpath of each existing component), so
 *     `..` is applied to the resolved directory, never to the lexical prefix;
 *   - distinguishes a broken symlink (lstat succeeds, realpath fails) and
 *     RESOLVES ITS FULL CHAIN component-by-component (CV
 *     S02-B-RECHECK-3): a symlink target is itself walked one component at a
 *     time, applying `..` to the resolved directory and following
 *     intermediate symlinks with per-component trust-root checks — a target
 *     like `B/../x.md` or `B/x.md` where `B` is a symlink to an OUTSIDE
 *     directory is rejected even when `path.resolve` would lexicalize it into
 *     an inside-root string;
 *   - detects symlink cycles via a shared visited set threaded through the
 *     recursion (never reset per frame);
 *   - returns the fully-resolved absolute path (REALPATH-normalized for
 *     existing targets) when every component stays inside the root, else
 *     `null` — callers map `null` to their own fail-closed condition.
 *
 * Root canonicalization: the retired plugin's callers always passed an
 * already-canonical root (the plugin realpathed the worktree in
 * `createRuntimeContext`), but the runtime receives `projectRoot` from
 * arbitrary callers. The root is therefore
 * canonicalized first (realpath when it resolves) so a symlinked root (e.g.
 * macOS `/tmp` → `/private/tmp`) can neither cause false escapes nor hide an
 * escape. Existing legal-path read semantics are unchanged: the guard is a
 * precondition check, never a path rewrite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * True when `p` is inside `root` (lexically within, `..` never escapes).
 */
export function isWithinRoot(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Canonicalize the trust root: realpath when it resolves (symlink-safe), else
 * the lexical absolute path (a non-existent root has no real path to compare
 * against and cannot redirect a read).
 */
function canonicalRootOf(absRoot: string): string {
  try {
    return fs.realpathSync(absRoot);
  } catch {
    return absRoot;
  }
}

/**
 * Walk `parts` (already-split raw path components, with `..` retained) from the
 * resolved `start` directory, enforcing the trust root at EVERY component.
 *
 * - `..` is applied to the RESOLVED directory (never the lexical prefix).
 * - An existing component is realpath-checked; a symlink component is resolved
 *   through its FULL chain recursively (see `resolveSymlinkChain`).
 * - A missing component becomes a lexical tail from that point.
 *
 * `visited` (when provided) is the shared symlink-cycle set threaded through
 * recursive chain resolution so a cycle across recursion boundaries is
 * detected once, not reset per frame. Returns the resolved absolute path when
 * every component stays inside the root, else `null`.
 */
function walkComponents(
  root: string,
  start: string,
  parts: readonly string[],
  visited?: Set<string>,
): string | null {
  let current = start;
  for (const part of parts) {
    if (part === '..') {
      const parent = path.dirname(current);
      if (!isWithinRoot(root, parent)) {
        return null;
      }
      current = parent;
      continue;
    }
    const next = path.join(current, part);
    let real: string;
    try {
      real = fs.realpathSync(next);
    } catch {
      // The component does not resolve through the real `current`. It may be
      // a broken symlink (still an existing directory entry) or a plain
      // missing component.
      let lst;
      try {
        lst = fs.lstatSync(next);
      } catch {
        // Plain missing component: the remaining tail is lexical from here.
        current = next;
        continue;
      }
      if (lst.isSymbolicLink()) {
        // Broken symlink: resolve its FULL chain (component-wise, recursive)
        // and fail closed when any hop escapes the root.
        const chainTarget = resolveSymlinkChain(root, next, visited);
        if (chainTarget === null) {
          return null;
        }
        current = chainTarget;
        continue;
      }
      // Existing non-symlink that realpathSync failed on — fail closed.
      return null;
    }
    if (!isWithinRoot(root, real)) {
      return null;
    }
    current = real;
  }
  if (!isWithinRoot(root, current)) {
    return null;
  }
  return current;
}

/**
 * Follow a symlink chain from `start` (which lstat says is a symlink) to its
 * FINAL resolved target, checking EVERY component of every hop against the
 * trust root (CV S02-B-RECHECK-3).
 *
 * The readlink target is itself walked component-by-component from the
 * symlink's resolved directory: `..` is applied to the resolved directory and
 * intermediate symlink components are followed recursively with per-component
 * checks. This rejects targets like `B/../x.md` or `B/x.md` where `B` is a
 * symlink to an OUTSIDE directory — a plain `path.resolve` would lexicalize
 * those into inside-root strings and hide the escape. Cycles are detected via
 * a shared visited set threaded through the recursion (never reset per frame).
 * Returns the final lexical/realpath target when every hop and component stays
 * inside the root, else `null`.
 */
function resolveSymlinkChain(
  root: string,
  start: string,
  visited?: Set<string>,
): string | null {
  const seen = visited ?? new Set<string>();
  let current = start;
  for (;;) {
    if (seen.has(current)) {
      // Symlink cycle — fail closed.
      return null;
    }
    seen.add(current);
    let target: string;
    try {
      target = fs.readlinkSync(current);
    } catch {
      // Unreadable symlink — fail closed.
      return null;
    }
    // Determine the starting directory and raw components of the target path.
    // Absolute targets must be lexically inside the root (walk from root after
    // stripping the prefix); relative targets walk from the symlink's resolved
    // directory.
    let base: string;
    let rawParts: string[];
    if (path.isAbsolute(target)) {
      if (target === root) {
        return root;
      }
      if (!target.startsWith(`${root}${path.sep}`)) {
        // Absolute target outside the trust root — fail closed.
        return null;
      }
      base = root;
      rawParts = target.slice(root.length + 1).split(path.sep);
    } else {
      base = path.dirname(current);
      rawParts = target.split(path.sep);
    }
    const parts = rawParts.filter((part) => part.length > 0 && part !== '.');
    const resolvedTarget = walkComponents(root, base, parts, seen);
    if (resolvedTarget === null) {
      return null;
    }
    // If the resolved target is itself an existing symlink, keep following the
    // chain (cycle detection via the shared visited set).
    let lst;
    try {
      lst = fs.lstatSync(resolvedTarget);
    } catch {
      // Target does not exist — this is the end of the chain; every existing
      // component already passed the trust-root check.
      return resolvedTarget;
    }
    if (lst.isSymbolicLink()) {
      current = resolvedTarget;
      continue;
    }
    return resolvedTarget;
  }
}

/**
 * Resolve `p` against the canonical trust root and enforce the boundary at
 * every existing ancestor component.
 *
 * - The root is canonicalized first (realpath when it resolves) so a
 *   symlinked root cannot produce false escapes.
 * - Absolute paths must stay lexically under the given root (or under the
 *   canonical root when it differs, e.g. a path built from a realpath'd
 *   root); relative paths resolve inside it.
 * - Every EXISTING component (including symlinks and symlink parents) is
 *   realpath-checked; a broken symlink is resolved through its FULL chain
 *   (recursive component-wise readlink with cycle detection).
 * - `..` is applied to the resolved directory (never to the lexical prefix),
 *   so a symlink + `..` mixed traversal cannot hide an escape.
 *
 * @returns the resolved absolute path (realpath-normalized for existing
 *          targets) when every component stays inside the root, else `null`.
 */
export function canonicalPathWithinRoot(root: string, p: string): string | null {
  if (typeof root !== 'string' || root.length === 0) return null;
  if (typeof p !== 'string' || p.length === 0) return null;
  const absRoot = path.resolve(root);
  const canonicalRoot = canonicalRootOf(absRoot);

  let base: string;
  let rawParts: string[];
  if (path.isAbsolute(p)) {
    if (p === absRoot || p === canonicalRoot) {
      return canonicalRoot;
    }
    if (p.startsWith(`${absRoot}${path.sep}`)) {
      base = canonicalRoot;
      rawParts = p.slice(absRoot.length + 1).split(path.sep);
    } else if (canonicalRoot !== absRoot && p.startsWith(`${canonicalRoot}${path.sep}`)) {
      base = canonicalRoot;
      rawParts = p.slice(canonicalRoot.length + 1).split(path.sep);
    } else {
      // Absolute path lexically outside the trust root.
      return null;
    }
  } else {
    base = canonicalRoot;
    rawParts = p.split(path.sep);
  }
  const parts = rawParts.filter((part) => part.length > 0 && part !== '.');
  return walkComponents(canonicalRoot, base, parts);
}

/**
 * Structured trust-root escape condition raised by `assertCanonicalWithinRoot`.
 * Callers with their own canonical error type (e.g. `GitSourceError`) check
 * `canonicalPathWithinRoot` directly instead.
 */
export class PathEscapeError extends Error {
  public readonly root: string;
  public readonly path: string;

  constructor(root: string, p: string) {
    super(`path "${p}" escapes the project root trust boundary (${root})`);
    this.name = 'PathEscapeError';
    this.root = root;
    this.path = p;
  }
}

/**
 * Assert that `p` resolves inside the canonical trust root.
 *
 * @throws {PathEscapeError} when the path escapes the root.
 * @returns the canonical path (callers that need it may use it).
 */
export function assertCanonicalWithinRoot(root: string, p: string): string {
  const canonical = canonicalPathWithinRoot(root, p);
  if (canonical === null) {
    throw new PathEscapeError(root, p);
  }
  return canonical;
}

// ============================================================
// No-follow atomic open (S2-F-003 round 3 — path-based TOCTOU closure)
// ============================================================

/**
 * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` read flags:
 *   - `O_NOFOLLOW` — the FINAL component is opened atomically without
 *     following a symlink (a symlink at open time → ELOOP), so a path-based
 *     check cannot be bypassed by a concurrent symlink replacement between
 *     the check and the open;
 *   - `O_NONBLOCK` — a FIFO / special file open returns IMMEDIATELY instead of
 *     blocking forever (a FIFO with no writer would otherwise block the
 *     O_RDONLY open; S2-F-003-R3-FIFO-BLOCK-BEFORE-FSTAT). The post-open
 *     `fstatSync(fd).isFile()` check then rejects non-regular files without
 *     ever blocking on a read.
 */
const READ_NOFOLLOW_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** Outcome of `openNoFollowRead`. */
export type NoFollowOpenResult =
  | { ok: true; fd: number; filePath: string }
  | {
      ok: false;
      reason: 'escape' | 'inode-mismatch' | 'not-regular-file' | 'unreadable';
    };

/**
 * Open `filePath` for reading with an atomic no-follow boundary (S2-F-003
 * round 3, failure signature S2-F-003-R2-PATH-OPEN-TOCTOU) plus an
 * open-after-fstat dev/ino identity check (S2-F-003 final supplement).
 *
 *   - The PARENT chain is canonicalized first: the open target is built from
 *     the canonical parent realpath (`canonicalPathWithinRoot` on the parent),
 *     so a lexical-parent symlink swap cannot redirect the open; the parent
 *     must stay inside the trust root.
 *   - The FINAL component is opened with `O_NOFOLLOW | O_NONBLOCK`: at open
 *     time it is atomically NOT followed (a symlink → ELOOP) and a FIFO /
 *     special file open returns immediately (no blocking, failure signature
 *     S2-F-003-R3-FIFO-BLOCK-BEFORE-FSTAT). The post-open `isFile` check
 *     rejects non-regular files (FIFO/socket/device) fail-closed.
 *   - Post-open identity check: the expected file identity (`dev`/`ino`) is
 *     captured with `statSync` BEFORE the open; after the open the opened fd's
 *     `fstatSync` identity must match it. A mismatch means the target was
 *     replaced between the expectation capture and the open — the fd is closed
 *     and the open fails closed (`inode-mismatch`), so a swap of the canonical
 *     path cannot smuggle a different inode past the boundary.
 *   - `ENOENT` (legal absence) and other unreadable conditions are reported
 *     as `{ reason: 'unreadable' }` so callers keep their existing
 *     missing/unreadable semantics.
 *
 * Callers read through the returned fd (`fs.readFileSync(fd)` / `readSync`)
 * and MUST close it with `fs.closeSync(fd)` — reading from the fd, not the
 * path, closes the check-then-use window.
 *
 * @returns the fd plus the canonical path actually opened, or a fail-closed
 *          outcome. `null` is never returned — use `!opened.ok`.
 */
export function openNoFollowRead(
  root: string,
  filePath: string,
): NoFollowOpenResult {
  if (typeof root !== 'string' || root.length === 0) {
    return { ok: false, reason: 'escape' };
  }
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, reason: 'escape' };
  }
  // 1. Canonicalize the parent chain (never the final component). The open
  //    target is `canonicalParent/<basename>`, so a lexical-parent swap
  //    between this step and the open cannot redirect the open.
  const canonicalParent = canonicalPathWithinRoot(root, path.dirname(filePath));
  if (canonicalParent === null) {
    return { ok: false, reason: 'escape' };
  }
  const name = path.basename(filePath);
  if (name.length === 0 || name === '.' || name === '..') {
    return { ok: false, reason: 'escape' };
  }
  const openTarget = path.join(canonicalParent, name);
  // 2. Capture the EXPECTED file identity before the open: a replacement of
  //    the target between this stat and the open is detected by comparing the
  //    opened fd's identity below.
  let expected: fs.Stats;
  try {
    expected = fs.statSync(openTarget);
  } catch {
    // ENOENT (legal absence) or unreadable — keep the existing semantics.
    return { ok: false, reason: 'unreadable' };
  }
  // 3. Atomic no-follow open of the final component.
  let fd: number;
  try {
    fd = fs.openSync(openTarget, READ_NOFOLLOW_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      // The final component is (or became) a symlink at open time — fail
      // closed: a symlink's path ownership cannot be proven.
      return { ok: false, reason: 'escape' };
    }
    // ENOENT (legal absence) or any other unreadable condition.
    return { ok: false, reason: 'unreadable' };
  }
  // 4. Post-open identity + regular-file checks: the fd must reference the
  //    SAME inode the expectation was captured from (a mismatch means the
  //    target was swapped between step 2 and step 3), and it must be a REGULAR
  //    file — a FIFO / socket / device is not a valid receipt/envelope source
  //    and is rejected here without ever blocking on a read (O_NONBLOCK made
  //    the open itself non-blocking).
  let actual: fs.Stats;
  try {
    actual = fs.fstatSync(fd);
  } catch {
    fs.closeSync(fd);
    return { ok: false, reason: 'unreadable' };
  }
  if (!actual.isFile()) {
    fs.closeSync(fd);
    return { ok: false, reason: 'not-regular-file' };
  }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    fs.closeSync(fd);
    return { ok: false, reason: 'inode-mismatch' };
  }
  return { ok: true, fd, filePath: openTarget };
}
