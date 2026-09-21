/**
 * @proofloop/runtime — Git source facts (S02-C-T02, mechanical subset).
 *
 * Provides only the pure Git work-tree facts consumed by the surviving
 * mechanical seams:
 *   - asserts `projectRoot` IS the git root (`git rev-parse --show-toplevel`
 *     with resolved-path equality) — a non-git root / git-subdir-as-root
 *     makes the Git source unavailable (structured `GitSourceError`,
 *     canonical code `RUNTIME.SCHEMA_MISMATCH`, PO-S02-C-02);
 *   - reads HEAD via `git rev-parse HEAD` (deterministic git subprocess).
 *
 * The retired tasks.md checkbox / slice-Evidence parsers and the composite
 * `gitSource` reader (business reconcile layer) were removed with their
 * owning consumer; no Host / Skill consumer remains.
 *
 * Determinism (HP-003): the git subprocess output is the canonical 40-hex
 * HEAD sha; all parsing is locale-independent plain string matching — the
 * same input always yields the same output. Read-only; never writes or
 * repairs.
 *
 * Failure semantics (fail-closed, never guess): non-git root and unborn HEAD
 * throw `GitSourceError`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Structured Git-source-unavailable condition (PO-S02-C-02): the canonical
 * code for a non-git root / unavailable Git source is RUNTIME.SCHEMA_MISMATCH.
 */
export class GitSourceError extends Error {
  public readonly code: 'RUNTIME.SCHEMA_MISMATCH' = 'RUNTIME.SCHEMA_MISMATCH';
  public readonly source: 'git' = 'git';
  public readonly reason: string;

  constructor(message: string) {
    super(message);
    this.name = 'GitSourceError';
    this.reason = message;
  }
}

/** True when the subprocess failed because the `git` executable is missing. */
function isExecutableMissing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Assert that `projectRoot` IS the git root (not merely inside a work tree).
 *
 * Uses `git rev-parse --show-toplevel` and compares the resolved real paths
 * (symlink/alias safe, e.g. macOS `/tmp` → `/private/tmp`). Any git failure
 * or a toplevel that differs from `projectRoot` → `GitSourceError`
 * (`RUNTIME.SCHEMA_MISMATCH` — Git source unavailable, PO-S02-C-02).
 */
export function resolveGitRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  let toplevel: string;
  try {
    toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolved,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (isExecutableMissing(err)) {
      throw new GitSourceError(
        `git executable is unavailable; cannot resolve a git work tree for ${resolved}`,
      );
    }
    throw new GitSourceError(`projectRoot is not inside a git work tree: ${resolved}`);
  }
  if (toplevel.length === 0) {
    throw new GitSourceError(`projectRoot is not inside a git work tree: ${resolved}`);
  }
  let realTop: string;
  let realRoot: string;
  try {
    realTop = fs.realpathSync(toplevel);
    realRoot = fs.realpathSync(resolved);
  } catch {
    throw new GitSourceError(`projectRoot cannot be resolved: ${resolved}`);
  }
  if (realTop !== realRoot) {
    throw new GitSourceError(`projectRoot is not the git root (git root is ${toplevel})`);
  }
  return toplevel;
}

/**
 * Read the git HEAD sha (`git rev-parse HEAD`). An unborn repository (git
 * init without any commit) fails closed with `GitSourceError` — never
 * guessed.
 */
export function readGitHead(gitRoot: string): string {
  let head: string;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (isExecutableMissing(err)) {
      throw new GitSourceError('git executable is unavailable; cannot read HEAD');
    }
    throw new GitSourceError(
      'cannot resolve HEAD (unborn repository?) — Git source unavailable',
    );
  }
  if (head.length === 0) {
    throw new GitSourceError('cannot resolve HEAD (unborn repository?) — Git source unavailable');
  }
  return head;
}