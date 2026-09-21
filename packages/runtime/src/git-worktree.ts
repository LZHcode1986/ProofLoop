/**
 * Deterministic Git worktree lifecycle primitives for Slice lanes.
 *
 * This module owns the mechanical worktree seam only.  Brain owns the Slice
 * lifecycle and candidate-ref decisions; the seam creates/removes/list worktrees
 * and reports the Git facts needed by those decisions.  It never commits,
 * merges, resets, stashes, or deletes candidate refs.
 *
 * The managed path is deliberately fixed and root-bound:
 *   <trust-root>/.proofloop/worktrees/<stage>-<slice>
 *
 * `.proofloop/worktrees/**` is a protected runtime-output tree for boundary and
 * integration purposes, but is the canonical destination for this mechanical
 * worktree operation itself.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalPathWithinRoot, isWithinRoot } from './path-guard';
import { resolveGitRoot } from './git-source';

export interface GitWorktreeRequest {
  /** Canonical Stage id (for example `S03`). */
  readonly stage?: string;
  /** Canonical Slice id/token (for example `S03-E` or `E`). */
  readonly slice?: string;
  /** Accepted Git ref from which the detached worktree is created. */
  readonly base_ref?: string;
  /** Compatibility spelling for callers using the Stage/Slice object vocabulary. */
  readonly stage_id?: string;
  readonly slice_id?: string;
  /** Compatibility spelling for a Git ref supplied by an adapter. */
  readonly baseRef?: string;
}

export interface GitWorktreeEntry {
  /** Canonical absolute worktree path. */
  readonly path: string;
  /** Canonical path relative to the trust root; the main worktree is `""`. */
  readonly relative_path: string;
  /** Resolved HEAD of this worktree. */
  readonly head: string;
  /** Branch name, or null for a detached worktree. */
  readonly branch: string | null;
  /** True when this worktree has no attached branch. */
  readonly detached: boolean;
  /** Whether Git reports the worktree as locked. */
  readonly locked: boolean;
  /** Whether Git reports stale/prunable administrative metadata. */
  readonly prunable: boolean;
}

export interface GitWorktreeCreateResult extends GitWorktreeEntry {
  readonly stage: string;
  readonly slice: string;
  /** Resolved commit SHA used as the worktree's creation base. */
  readonly base_ref: string;
}

export interface GitWorktreeRemoveResult {
  readonly stage: string;
  readonly slice: string;
  readonly path: string;
  readonly relative_path: string;
  readonly removed: true;
  /** Remaining worktrees after removal/prune validation. */
  readonly worktrees: readonly GitWorktreeEntry[];
}

export type GitWorktreeErrorCode =
  | 'WORKTREE.REQUEST_INVALID'
  | 'WORKTREE.GIT_UNAVAILABLE'
  | 'WORKTREE.BASE_REF_INVALID'
  | 'WORKTREE.PATH_INVALID'
  | 'WORKTREE.PATH_OCCUPIED'
  | 'WORKTREE.CREATE_FAILED'
  | 'WORKTREE.REMOVE_FAILED'
  | 'WORKTREE.LIST_FAILED'
  | 'WORKTREE.POST_CREATE_INVALID'
  | 'WORKTREE.INDEX_NOT_EMPTY'
  | 'WORKTREE.DIRTY_WORKTREE';

export class GitWorktreeError extends Error {
  public readonly code: GitWorktreeErrorCode;

  constructor(code: GitWorktreeErrorCode, message: string) {
    super(message);
    this.name = 'GitWorktreeError';
    this.code = code;
    Object.setPrototypeOf(this, GitWorktreeError.prototype);
  }
}

const STAGE_RE = /^S\d+$/;
const SLICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA_RE = /^[a-f0-9]{40}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const WORKTREE_PREFIX = '.proofloop/worktrees';

function fail(code: GitWorktreeErrorCode, message: string): never {
  throw new GitWorktreeError(code, message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runGit(root: string, args: readonly string[], code: GitWorktreeErrorCode): string {
  try {
    return execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    fail(code, `git ${args.join(' ')} failed: ${errorText(error)}`);
  }
}

/** Worktree creation never hides dirty main-worktree state. */
function assertMainWorktreeClean(root: string): void {
  const output = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'WORKTREE.GIT_UNAVAILABLE');
  const entries = output.split('\u0000').filter((entry) => entry.length > 0);
  if (entries.length === 0) return;
  const hasStaged = entries.some((entry) => entry.length >= 2 && entry[0] !== ' ' && entry[0] !== '?');
  if (hasStaged) {
    fail('WORKTREE.INDEX_NOT_EMPTY', 'worktree creation requires an initially empty Git index');
  }
  fail('WORKTREE.DIRTY_WORKTREE', `worktree creation requires a clean main worktree; dirty path(s): ${entries.map((entry) => entry.slice(3)).join(', ')}`);
}

function normalizeIdentity(request: GitWorktreeRequest): { stage: string; slice: string; baseRef: string } {
  if (request === null || typeof request !== 'object') {
    fail('WORKTREE.REQUEST_INVALID', 'worktree request must be an object');
  }

  const stage = request.stage ?? request.stage_id;
  const slice = request.slice ?? request.slice_id;
  if (request.stage !== undefined && request.stage_id !== undefined && request.stage !== request.stage_id) {
    fail('WORKTREE.REQUEST_INVALID', 'stage and stage_id must agree when both are supplied');
  }
  if (request.slice !== undefined && request.slice_id !== undefined && request.slice !== request.slice_id) {
    fail('WORKTREE.REQUEST_INVALID', 'slice and slice_id must agree when both are supplied');
  }
  if (stage === undefined || !STAGE_RE.test(stage)) {
    fail('WORKTREE.REQUEST_INVALID', `stage must match /^S\\d+$/, received "${String(stage)}"`);
  }
  if (slice === undefined || !SLICE_RE.test(slice)) {
    fail('WORKTREE.REQUEST_INVALID', `slice must be a canonical identifier, received "${String(slice)}"`);
  }

  const baseRef = request.base_ref ?? request.baseRef ?? 'HEAD';
  if (request.base_ref !== undefined && request.baseRef !== undefined && request.base_ref !== request.baseRef) {
    fail('WORKTREE.REQUEST_INVALID', 'base_ref and baseRef must agree when both are supplied');
  }
  if (
    typeof baseRef !== 'string' ||
    baseRef.length === 0 ||
    CONTROL_CHARS_RE.test(baseRef) ||
    !REF_RE.test(baseRef) ||
    baseRef.includes('..') ||
    baseRef.includes('@{')
  ) {
    fail('WORKTREE.REQUEST_INVALID', 'base_ref must be a safe non-empty Git ref');
  }
  return { stage, slice, baseRef };
}

function canonicalRelativePath(root: string, stage: string, slice: string): string {
  const relative = `${WORKTREE_PREFIX}/${stage}-${slice}`;
  const canonical = canonicalPathWithinRoot(root, relative);
  if (canonical === null) {
    fail('WORKTREE.PATH_INVALID', `canonical worktree path escapes the project root: ${relative}`);
  }
  // The final destination is a managed directory, never a symlink.  Check the
  // lexical entry (not only canonicalPathWithinRoot's resolved output) so an
  // inside-root symlink cannot silently redirect create/remove to another path.
  const lexicalTarget = path.join(path.resolve(root), relative);
  try {
    if (fs.lstatSync(lexicalTarget).isSymbolicLink()) {
      fail('WORKTREE.PATH_INVALID', `canonical worktree target must not be a symlink: ${relative}`);
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      fail('WORKTREE.PATH_INVALID', `cannot inspect canonical worktree target: ${errorText(error)}`);
    }
  }
  if (path.resolve(canonical) !== lexicalTarget) {
    fail('WORKTREE.PATH_INVALID', `canonical worktree path uses a symlinked ancestor: ${relative}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(canonical);
  const relativeResolved = path.relative(resolvedRoot, resolved).split(path.sep).join('/');
  if (
    relativeResolved.length === 0 ||
    relativeResolved === '..' ||
    relativeResolved.startsWith('../') ||
    relativeResolved === '.git' ||
    relativeResolved.startsWith('.git/')
  ) {
    fail('WORKTREE.PATH_INVALID', `canonical worktree path is outside the protected root: ${relative}`);
  }
  return relativeResolved;
}

/** Return the canonical absolute path for a Slice worktree without creating it. */
export function canonicalWorktreePath(root: string, stage: string, slice: string): string;
export function canonicalWorktreePath(root: string, request: GitWorktreeRequest): string;
export function canonicalWorktreePath(
  root: string,
  stageOrRequest: string | GitWorktreeRequest,
  sliceArgument?: string,
 ): string {
  if (typeof root !== 'string' || root.length === 0) {
    fail('WORKTREE.REQUEST_INVALID', 'project root must be a non-empty path');
  }
  const stage = typeof stageOrRequest === 'string' ? stageOrRequest : stageOrRequest.stage ?? stageOrRequest.stage_id;
  const slice = typeof stageOrRequest === 'string' ? sliceArgument : stageOrRequest.slice ?? stageOrRequest.slice_id;
  if (typeof stage !== 'string' || !STAGE_RE.test(stage)) {
    fail('WORKTREE.REQUEST_INVALID', `stage must match /^S\\d+$/, received "${String(stage)}"`);
  }
  if (typeof slice !== 'string' || !SLICE_RE.test(slice)) {
    fail('WORKTREE.REQUEST_INVALID', `slice must be a canonical identifier, received "${String(slice)}"`);
  }
  const rootAbsolute = path.resolve(root);
  const canonicalRoot = canonicalPathWithinRoot(rootAbsolute, '.');
  if (canonicalRoot === null) {
    fail('WORKTREE.PATH_INVALID', `project root cannot be resolved inside its trust boundary: ${root}`);
  }
  const relative = canonicalRelativePath(canonicalRoot, stage, slice);
  return path.join(canonicalRoot, relative);
}

function resolveBaseCommit(root: string, baseRef: string): string {
  let output: string;
  try {
    output = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    fail('WORKTREE.BASE_REF_INVALID', `cannot resolve base_ref "${baseRef}": ${errorText(error)}`);
  }
  if (!SHA_RE.test(output)) {
    fail('WORKTREE.BASE_REF_INVALID', `base_ref "${baseRef}" does not resolve to exactly one commit`);
  }
  return output;
}

function assertTargetAvailable(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    fail('WORKTREE.PATH_INVALID', `cannot inspect canonical worktree path ${target}: ${errorText(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('WORKTREE.PATH_OCCUPIED', `canonical worktree target is not an empty directory: ${target}`);
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(target);
  } catch (error) {
    fail('WORKTREE.PATH_INVALID', `cannot inspect canonical worktree directory ${target}: ${errorText(error)}`);
  }
  if (entries.length > 0) {
    fail('WORKTREE.PATH_OCCUPIED', `canonical worktree target must be absent or empty: ${target}`);
  }
}

/**
 * Classify one `git worktree list` path against the trust root.
 *
 * - In-root entry: returned with canonical path + relative path.  Protected
 *   (`.git`) paths and in-root canonical violations (a lexically in-root
 *   path whose component walk escapes via a symlink / broken chain) still
 *   fail closed with `WORKTREE.PATH_INVALID` — never silenced.
 * - External entry: a path OUTSIDE the trust root that Git legitimately
 *   registers against this repository (e.g. a worktree created by another
 *   tool, like Herdr's own external lanes).  Returns `null` so the seam can
 *   tolerate it: the entry is ignored for this project's list/cleanup and
 *   never inspected, removed or rewritten (EXEC-S05-CLEANUP-WORKTREE-001).
 */
function canonicalPathFromGit(
  root: string,
  listedPath: string,
): { path: string; relative_path: string } | null {
  const candidate = path.resolve(listedPath);
  const canonical = canonicalPathWithinRoot(root, candidate);
  if (canonical !== null) {
    const relative = path.relative(root, canonical).split(path.sep).join('/');
    if (relative === '.git' || relative.startsWith('.git/')) {
      fail('WORKTREE.PATH_INVALID', `Git worktree list contains a protected path: ${relative}`);
    }
    return { path: canonical, relative_path: relative };
  }
  // Failed canonical resolution is only tolerable when the path is genuinely
  // external.  A lexically in-root path that cannot be canonically resolved
  // (symlink escape / broken chain) stays fail-closed.
  const absRoot = path.resolve(root);
  if (isWithinRoot(absRoot, candidate)) {
    fail(
      'WORKTREE.PATH_INVALID',
      `Git worktree list contains a path that fails canonical resolution inside the project root: ${listedPath}`
    );
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(absRoot);
  } catch {
    canonicalRoot = absRoot;
  }
  if (canonicalRoot !== absRoot && isWithinRoot(canonicalRoot, candidate)) {
    fail(
      'WORKTREE.PATH_INVALID',
      `Git worktree list contains a path that fails canonical resolution inside the project root: ${listedPath}`
    );
  }
  return null;
}

function parseWorktreeList(root: string, output: string): GitWorktreeEntry[] {
  const lines = output.split(/\r?\n/);
  const entries: GitWorktreeEntry[] = [];
  let current: { path?: string; head?: string; branch?: string | null; detached?: boolean; locked?: boolean; prunable?: boolean } | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    if (current.path === undefined || current.head === undefined || !SHA_RE.test(current.head)) {
      fail('WORKTREE.LIST_FAILED', `Git worktree list entry is incomplete: ${JSON.stringify(current)}`);
    }
    const resolved = canonicalPathFromGit(root, current.path);
    if (resolved === null) {
      // External worktree outside the trust root: tolerated (skipped) for
      // this project's list/cleanup operations; never inspected here.
      current = undefined;
      return;
    }
    const branch = current.branch ?? null;
    entries.push({
      path: resolved.path,
      relative_path: resolved.relative_path,
      head: current.head,
      branch,
      detached: current.detached === true || branch === null,
      locked: current.locked === true,
      prunable: current.prunable === true,
    });
    current = undefined;
  };

  for (const line of lines) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length) };
      continue;
    }
    if (current === undefined) {
      fail('WORKTREE.LIST_FAILED', `unexpected Git worktree list record: ${JSON.stringify(line)}`);
    }
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      current.detached = false;
    } else if (line === 'detached') {
      current.branch = null;
      current.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    } else {
      fail('WORKTREE.LIST_FAILED', `unexpected Git worktree list record: ${JSON.stringify(line)}`);
    }
  }
  flush();
  return entries;
}

/**
 * List the Git worktrees rooted from the canonical project root.
 *
 * Worktrees Git registers against this repository but placed OUTSIDE the
 * trust root (external entries, e.g. created by another tool) are tolerated
 * and omitted: they never block or poison in-root list/create/remove, and
 * the seam never inspects, removes or rewrites them.
 */
export function listGitWorktrees(root: string): readonly GitWorktreeEntry[] {
  const gitRoot = (() => {
    try {
      return resolveGitRoot(root);
    } catch (error) {
      fail('WORKTREE.GIT_UNAVAILABLE', `canonical Git project root is unavailable: ${errorText(error)}`);
    }
  })();
  const output = runGit(gitRoot, ['worktree', 'list', '--porcelain'], 'WORKTREE.LIST_FAILED');
  return parseWorktreeList(gitRoot, output);
}

function findWorktree(root: string, target: string): GitWorktreeEntry | undefined {
  return listGitWorktrees(root).find((entry) => entry.path === target);
}

/**
 * Create one detached Slice worktree at the canonical path and return its
 * creation base.  The main worktree's HEAD/index/worktree are not changed.
 */
export function createGitWorktree(root: string, request: GitWorktreeRequest): GitWorktreeCreateResult;
export function createGitWorktree(root: string, stage: string, slice: string, baseRef?: string): GitWorktreeCreateResult;
export function createGitWorktree(
  root: string,
  requestOrStage: GitWorktreeRequest | string,
  sliceArgument?: string,
  baseRefArgument?: string,
 ): GitWorktreeCreateResult {
  const request = typeof requestOrStage === 'string'
    ? {
        stage: requestOrStage,
        slice: sliceArgument,
        ...(baseRefArgument !== undefined ? { base_ref: baseRefArgument } : {}),
      }
    : requestOrStage;
  const identity = normalizeIdentity(request);
  const gitRoot = (() => {
    try {
      return resolveGitRoot(root);
    } catch (error) {
      fail('WORKTREE.GIT_UNAVAILABLE', `canonical Git project root is unavailable: ${errorText(error)}`);
    }
  })();
  const relativePath = canonicalRelativePath(gitRoot, identity.stage, identity.slice);
  assertMainWorktreeClean(gitRoot);
  const target = path.join(gitRoot, relativePath);
  assertTargetAvailable(target);
  const baseHead = resolveBaseCommit(gitRoot, identity.baseRef);

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (error) {
    fail('WORKTREE.CREATE_FAILED', `cannot create worktree parent directory: ${errorText(error)}`);
  }
  runGit(gitRoot, ['worktree', 'add', '--detach', target, identity.baseRef], 'WORKTREE.CREATE_FAILED');

  let created = findWorktree(gitRoot, target);
  if (created === undefined || created.head !== baseHead || !created.detached) {
    fail(
      'WORKTREE.POST_CREATE_INVALID',
      `created worktree failed detached/base postcondition: expected ${baseHead} at ${target}`,
    );
  }
  // `findWorktree` returns a fresh object from the list parser; retain its
  // canonical path and facts as the source of truth for the result.
  created = { ...created, path: target, relative_path: relativePath };
  return {
    ...created,
    stage: identity.stage,
    slice: identity.slice,
    base_ref: baseHead,
  };
}

/**
 * Remove one canonical Slice worktree and verify Git's administrative list no
 * longer contains it.  Dirty worktrees are not force-removed: the typed error
 * preserves uncommitted work for Brain cleanup/recovery decisions.
 */
export function removeGitWorktree(root: string, request: GitWorktreeRequest): GitWorktreeRemoveResult;
export function removeGitWorktree(root: string, stage: string, slice: string): GitWorktreeRemoveResult;
export function removeGitWorktree(
  root: string,
  requestOrStage: GitWorktreeRequest | string,
  sliceArgument?: string,
 ): GitWorktreeRemoveResult {
  const request = typeof requestOrStage === 'string'
    ? { stage: requestOrStage, slice: sliceArgument }
    : requestOrStage;
  const identity = normalizeIdentity(request);
  const gitRoot = (() => {
    try {
      return resolveGitRoot(root);
    } catch (error) {
      fail('WORKTREE.GIT_UNAVAILABLE', `canonical Git project root is unavailable: ${errorText(error)}`);
    }
  })();
  const relativePath = canonicalRelativePath(gitRoot, identity.stage, identity.slice);
  const target = path.join(gitRoot, relativePath);
  const existing = findWorktree(gitRoot, target);
  if (existing === undefined || existing.relative_path.length === 0) {
    fail('WORKTREE.REMOVE_FAILED', `canonical worktree is not registered: ${relativePath}`);
  }

  runGit(gitRoot, ['worktree', 'remove', target], 'WORKTREE.REMOVE_FAILED');
  runGit(gitRoot, ['worktree', 'prune', '--expire', 'now'], 'WORKTREE.REMOVE_FAILED');
  const remaining = listGitWorktrees(gitRoot);
  if (remaining.some((entry) => entry.path === target || entry.relative_path === relativePath)) {
    fail('WORKTREE.REMOVE_FAILED', `Git worktree list still contains removed path: ${relativePath}`);
  }
  return {
    stage: identity.stage,
    slice: identity.slice,
    path: target,
    relative_path: relativePath,
    removed: true,
    worktrees: remaining,
  };
}

// Explicit aliases keep the mechanical seam readable to adapters that use the
// shorter verb names; no alias changes the Git transaction or its error model.
export const createWorktree = createGitWorktree;
export const removeWorktree = removeGitWorktree;
export const listWorktrees = listGitWorktrees;
