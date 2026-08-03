/**
 * @proofloop/opencode-plugin — shared trust-root path boundary helpers
 * (AWI-003 / ADR-004; CV S02-B-INITIAL-PO01-SYMLINK, S02-B-RECHECK-PO01,
 * S02-B-RECHECK-3-STAGE-DEFAULT-PATH-SYMLINK-TARGET-DOTDOT).
 *
 * Resolve a caller-supplied path against the canonical worktree trust root and
 * enforce the root boundary at EVERY existing ancestor component — not just at
 * the final target.
 *
 * The previous per-file `resolveWithinRoot` only realpath-checked the FINAL
 * target; when the target did not exist yet the ENOENT from `realpathSync` was
 * swallowed and the lexical path was accepted. A parent symlink pointing
 * outside the root (with a missing final target) could then smuggle a read
 * outside the root. The shared resolver below:
 *
 *   - walks the raw path component-by-component WITHOUT pre-collapsing `..`
 *     lexically (path.join/path.resolve normalize `..` away, hiding a
 *     symlink + `..` mixed traversal);
 *   - keeps the walk on REAL paths (realpath of each existing component),
 *     so `..` is applied to the resolved directory, never to the lexical
 *     prefix;
 *   - distinguishes a broken symlink (lstat succeeds, realpath fails) and
 *     RESOLVES ITS FULL CHAIN component-by-component (CV S02-B-RECHECK-3): a
 *     symlink target is itself walked one component at a time, applying `..`
 *     to the resolved directory and following intermediate symlinks with
 *     per-component trust-root checks — a target like `B/../x.md` or `B/x.md`
 *     where `B` is a symlink to an OUTSIDE directory is rejected even when
 *     `path.resolve` would lexicalize it into an inside-root string;
 *   - returns the fully-resolved absolute path (REALPATH-normalized for
 *     existing targets) when every component stays inside the root, else
 *     `null` (HOST.PATH_OUTSIDE_PROJECT at the caller). Returning the
 *     canonical realpath for existing targets narrows the TOCTOU window: the
 *     subsequent open targets the canonical path, so a symlink swap on the
 *     caller-supplied lexical path no longer redirects it.
 *
 * Both the plan validate seam (`plan-validate.ts`) and the S02-A stage seam
 * (`stage.ts`) consume these helpers so the boundary semantics stay shared.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * True when `p` is inside `root` (lexically within, `..` never escapes).
 */
export function isWithinRoot(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Walk `parts` (already-split raw path components, with `..` retained) from
 * the resolved `start` directory, enforcing the trust root at EVERY component.
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
      real = realpathSync(next);
    } catch {
      // The component does not resolve through the real `current`. It may be
      // a broken symlink (still an existing directory entry) or a plain
      // missing component.
      let lst;
      try {
        lst = lstatSync(next);
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
      target = readlinkSync(current);
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
      lst = lstatSync(resolvedTarget);
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
 * Resolve `p` against the trust root and enforce the boundary at every
 * existing ancestor component.
 *
 * - Absolute paths must stay inside the root; relative paths resolve inside it.
 * - Every EXISTING component (including symlinks and symlink parents) is
 *   realpath-checked; a broken symlink is resolved through its FULL chain
 *   (recursive component-wise readlink with cycle detection).
 * - `..` is applied to the resolved directory (never to the lexical prefix),
 *   so a symlink + `..` mixed traversal cannot hide an escape.
 * - Returns the resolved absolute path (realpath-normalized for existing
 *   targets) or `null` when the boundary is violated (callers map `null` to
 *   HOST.PATH_OUTSIDE_PROJECT).
 */
export function resolveWithinRoot(root: string, p: string): string | null {
  let base: string;
  let rawParts: string[];
  if (path.isAbsolute(p)) {
    if (p === root) {
      return root;
    }
    if (!p.startsWith(`${root}${path.sep}`)) {
      // Not lexically under the trust root.
      return null;
    }
    base = root;
    rawParts = p.slice(root.length + 1).split(path.sep);
  } else {
    base = root;
    rawParts = p.split(path.sep);
  }
  const parts = rawParts.filter((part) => part.length > 0 && part !== '.');
  return walkComponents(root, base, parts);
}

/**
 * Re-verify a CANONICAL path (already resolved by `resolveWithinRoot`) against
 * the trust root, requiring IDENTITY (CV S02-B-RECHECK-PO01-INROOT-SYMLINK-
 * REDIRECT).
 *
 * A canonical path captured by an earlier resolve must still resolve to the
 * SAME path when re-read. This closes the in-root symlink redirect: if the
 * canonical path was swapped to a symlink pointing at a DIFFERENT path — even
 * when the alternate target stays inside the root — the re-resolve returns a
 * different string and this returns `null` (fail-closed).
 *
 * Returns the re-resolved path when it is unchanged, else `null`.
 */
export function reverifyCanonicalPath(
  root: string,
  canonicalPath: string,
): string | null {
  const reResolved = resolveWithinRoot(root, canonicalPath);
  if (reResolved === null || reResolved !== canonicalPath) {
    return null;
  }
  return reResolved;
}
