/**
 * Deterministic Git boundary closure for the public `proofloop boundary close`
 * command (the Boundary CLI architecture blueprint,
 * Part B §4–§7; .agents/contracts/brain/commit-boundary.md is the semantic
 * source for per-type scope and canonical commit messages).
 *
 * This module owns only mechanical Git facts and writes. Brain decides when a
 * boundary is appropriate and performs any recovery; this function never
 * stashes, resets, restores, rebases, merges, pushes, or edits artifacts.
 *
 * Worktree semantics: a STRICT dirty gate runs before any Git write — every
 * actual dirty/untracked path must belong to this boundary's normal scope or be
 * explicitly listed in `tolerated_paths`; otherwise the boundary fails closed with
 * `BOUNDARY.SCOPE_VIOLATION` and leaves HEAD and the index unchanged. Explicit
 * tolerated paths are exact files, must already be dirty, and are never staged or
 * committed. `slice-output` keeps its separate typed other-Slice tolerance. Any
 * dirty path that resolves to `.git/**` / `.proofloop/**` or escapes the project
 * root also fails closed before staging (`BOUNDARY.SCOPE_VIOLATION`).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalPathWithinRoot } from './path-guard';
import { readGitHead, resolveGitRoot } from './git-source';

export const BOUNDARY_TYPES = [
  'baseline-authority',
  'stage-plan',
  'artifact-archive',
  'slice-output',
  'authority-update',
  'workflow-contract-update',
  'prototype-checkpoint',
  'stage-close',
  'direct-fix',
  'runtime-repair',
] as const;

export type BoundaryType = (typeof BOUNDARY_TYPES)[number];

export interface BoundaryCloseRequest {
  readonly boundary_type: BoundaryType;
  readonly expected_head?: string;
  readonly stage?: string;
  readonly slice?: string;
  /**
   * Files declared dirty by OTHER Slices' persisted Worker facts (slice-output
   * only). Tolerance scope ONLY: these paths may remain dirty in an
   * interleaved worktree but are NEVER selected, staged or committed by this
   * boundary.
   */
  /**
   * Explicitly tolerated dirty files for this boundary. These are exact
   * root-relative paths: they may remain dirty but are never selected, staged,
   * or committed. Every listed path must be dirty at transaction start.
   */
  readonly tolerated_paths?: readonly string[];
  readonly other_slice_declared_files?: readonly string[];
  readonly paths?: readonly string[];
  readonly description?: string;
  readonly expected_branch?: string;
}

export interface BoundaryCloseResult {
  readonly boundary_type: BoundaryType;
  readonly pre_commit_head: string;
  readonly commit_sha: string;
  readonly commit_message: string;
  readonly changed_files: readonly string[];
  readonly dirty_after: boolean;
  /** Dirty paths explicitly tolerated and left uncommitted. */
  readonly tolerated_paths: readonly string[];
}

export type GitBoundaryErrorCode =
  | 'BOUNDARY.REQUEST_INVALID'
  | 'BOUNDARY.GIT_UNAVAILABLE'
  | 'BOUNDARY.HEAD_MISMATCH'
  | 'BOUNDARY.BRANCH_MISMATCH'
  | 'BOUNDARY.INDEX_NOT_EMPTY'
  | 'BOUNDARY.SCOPE_VIOLATION'
  | 'BOUNDARY.NO_CHANGES'
  | 'BOUNDARY.DIFF_INVALID'
  | 'BOUNDARY.RENAME_INVALID'
  | 'BOUNDARY.COMMIT_FAILED'
  | 'BOUNDARY.POST_COMMIT_INVALID'
  | 'BOUNDARY.SLICE_POLICY_REQUIRED'
  | 'BOUNDARY.SLICE_POLICY_INVALID';

export class GitBoundaryError extends Error {
  public readonly code: GitBoundaryErrorCode;

  constructor(code: GitBoundaryErrorCode, message: string) {
    super(message);
    this.name = 'GitBoundaryError';
    this.code = code;
  }
}

interface StatusEntry {
  readonly index: string;
  readonly worktree: string;
  readonly paths: readonly string[];
}

const STAGE_RE = /^S\d+$/;
/**
 * Closed canonical Slice identity language (S08-B / PO-S08-B-01): stage-scoped
 * `S<digits>-<UPPER>` / `S<digits>-<UPPER>-<UPPER>` (normal / maintenance) and their
 * bare-token equivalents `UPPER` / `UPPER-UPPER`.  Anything else — empty or
 * whitespace-only, lowercase or mixed case, embedded digits, `.`, `_`, `..`, `@{`,
 * control characters, a stage-only value, three or more tokens, or a stage prefix
 * that differs from the request stage — fails closed before any Git access.
 */
const STAGE_SCOPED_SLICE_RE = /^(S\d+)-([A-Z]+(?:-[A-Z]+)?)$/;
const SLICE_TOKEN_RE = /^[A-Z]+(?:-[A-Z]+)?$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

const SHA_RE = /^[a-f0-9]{40}$/;
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;
const CANDIDATE_REF_PREFIX = 'proofloop';
/** Boundary types whose canonical commit message embeds ids/digests, not a free-form description. */
const ID_MESSAGE_TYPES: ReadonlySet<BoundaryType> = new Set([
  'baseline-authority',
  'stage-plan',
  'artifact-archive',
  'slice-output',
  'stage-close',
]);

/** Boundary types whose exact commit set is declared by the request `paths`. */
const EXACT_PATH_TYPES: ReadonlySet<BoundaryType> = new Set([
  'artifact-archive',
  'authority-update',
  'workflow-contract-update',
  'prototype-checkpoint',
  'direct-fix',
  'runtime-repair',
]);

/** Boundary types that must declare a canonical stage id. */
const STAGE_REQUIRED_TYPES: ReadonlySet<BoundaryType> = new Set([
  'stage-plan',
  'artifact-archive',
  'slice-output',
  'stage-close',
]);

function fail(code: GitBoundaryErrorCode, message: string): never {
  throw new GitBoundaryError(code, message);
}


function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runGit(root: string, args: readonly string[], code: GitBoundaryErrorCode): string {
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

/** Read a commit ref without turning a missing candidate into a subprocess error. */
function optionalCommitRef(root: string, ref: string): string | undefined {
  try {
    const output = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return SHA_RE.test(output) ? output : undefined;
  } catch {
    return undefined;
  }
}


function isProtectedPath(relative: string): boolean {
  return relative === '.git' || relative.startsWith('.git/') ||
    relative === '.proofloop' || relative.startsWith('.proofloop/');
}

function relativePath(root: string, value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) {
    fail('BOUNDARY.REQUEST_INVALID', `${label} must be a non-empty root-relative path`);
  }
  const canonical = canonicalPathWithinRoot(root, value);
  if (canonical === null) fail('BOUNDARY.SCOPE_VIOLATION', `${label} escapes the project root: ${value}`);
  const relative = path.relative(root, canonical).split(path.sep).join('/');
  if (relative.length === 0 || relative === '..' || relative.startsWith('../')) {
    fail('BOUNDARY.SCOPE_VIOLATION', `${label} escapes the project root: ${value}`);
  }
  if (isProtectedPath(relative)) {
    fail('BOUNDARY.SCOPE_VIOLATION', `${label} targets a protected path: ${relative}`);
  }
  return relative;
}

function validateStage(value: string | undefined, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) fail('BOUNDARY.REQUEST_INVALID', 'boundary requires a canonical stage (S<digits>)');
    return undefined;
  }
  if (!STAGE_RE.test(value)) fail('BOUNDARY.REQUEST_INVALID', `stage must match /^S\\d+$/, received "${value}"`);
  return value;
}

/**
 * Pre-Git Slice identity validation for direct `closeGitBoundary` callers.
 * The accepted language, the stage-equality rule and the derived candidate ref
 * all come from the single canonical identity source below, so a `slice-output`
 * request can never reach Git with an identity that no canonical ref could have
 * been derived from.
 */
function validateSlice(stageId: string | undefined, value: string | undefined): void {
  if (value === undefined) return;
  if (stageId === undefined) {
    fail('BOUNDARY.REQUEST_INVALID', `slice requires a canonical stage (S<digits>), received "${value}"`);
  }
  canonicalSliceToken(stageId, value);
}

/**
 * Resolve a Slice identity request input against the closed canonical language
 * and return its token (stage prefix stripped).
 *
 * Accepted (exactly the closed set of the S08-B obligation):
 *  - stage-scoped `S<digits>-<UPPER>` / `S<digits>-<UPPER>-<UPPER>`, whose
 *    stage prefix MUST equal `stageId`;
 *  - bare `UPPER` / `UPPER-UPPER`, which bind to `stageId`.
 *
 * Everything else fails closed with `BOUNDARY.REQUEST_INVALID`.  This is the
 * single canonical identity source: it serves both the derived candidate ref
 * and the pre-Git `slice-output` request validation.
 */
function canonicalSliceToken(stageId: string, sliceToken: string): string {
  if (typeof sliceToken !== 'string' || sliceToken.length === 0) {
    fail('BOUNDARY.REQUEST_INVALID', `slice must be a canonical Slice identity, received ${JSON.stringify(sliceToken)}`);
  }
  const scoped = STAGE_SCOPED_SLICE_RE.exec(sliceToken);
  if (scoped !== null) {
    if (scoped[1] !== stageId) {
      fail(
        'BOUNDARY.REQUEST_INVALID',
        `slice stage prefix "${scoped[1]}" must equal the request stage "${stageId}", received "${sliceToken}"`
      );
    }
    return scoped[2];
  }
  if (!SLICE_TOKEN_RE.test(sliceToken)) {
    fail(
      'BOUNDARY.REQUEST_INVALID',
      `slice must be a canonical Slice identity (S<digits>-<UPPER>[-<UPPER>] or <UPPER>[-<UPPER>]), received "${sliceToken}"`
    );
  }
  return sliceToken;
}

/**
 * Canonical candidate ref for the Worktree → Integration edge.  A Slice id may
 * be supplied as either its full `S03-A` form or its token `A`; the Stage prefix
 * is emitted exactly once (`proofloop-s03-a`).
 */
export function canonicalCandidateRef(stageId: string, sliceToken: string): string {
  if (!STAGE_RE.test(stageId)) {
    fail('BOUNDARY.REQUEST_INVALID', `stage_id must match /^S\\d+$/, received "${stageId}"`);
  }
  const token = canonicalSliceToken(stageId, sliceToken);
  return `${CANDIDATE_REF_PREFIX}-${stageId.toLowerCase()}-${token.toLowerCase()}`;
}



function validateExpectedHead(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{40}$/.test(value)) fail('BOUNDARY.REQUEST_INVALID', 'expected_head must be a full lowercase Git SHA');
  return value;
}

function validateDescriptionFormat(value: string, type: BoundaryType): string {
  if (value.length === 0 || value.length > 200 || CONTROL_CHARS_RE.test(value)) {
    fail(
      'BOUNDARY.REQUEST_INVALID',
      `${type} description must be 1..200 characters with no control characters or newline`,
    );
  }
  return value;
}

function parseStatus(output: string): StatusEntry[] {
  if (output.length === 0) return [];
  const tokens = output.split('\u0000');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length === 0) continue;
    if (token.length < 4 || token[2] !== ' ') {
      fail('BOUNDARY.GIT_UNAVAILABLE', `unexpected porcelain status record: ${JSON.stringify(token)}`);
    }
    const status = token.slice(0, 2);
    const firstPath = token.slice(3);
    const paths: string[] = [firstPath];
    if (status.includes('R') || status.includes('C')) {
      const secondPath = tokens[index + 1];
      if (secondPath === undefined || secondPath.length === 0) {
        fail('BOUNDARY.GIT_UNAVAILABLE', `rename/copy status record has no destination: ${JSON.stringify(token)}`);
      }
      paths.push(secondPath);
      index += 1;
    }
    entries.push({ index: status[0], worktree: status[1], paths });
  }
  return entries;
}

function statusPaths(entries: readonly StatusEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.paths))].sort();
}

function hasStagedIndex(entries: readonly StatusEntry[]): boolean {
  return entries.some((entry) => entry.index !== ' ' && entry.index !== '?');
}

function pathWithin(relative: string, base: string): boolean {
  return relative === base || relative.startsWith(`${base.replace(/\/$/, '')}/`);
}

/**
 * Slice-output Work Packet path policy (P0 interleaved isolation).
 *
 * Every committable path (`paths`) and every tolerated other-Slice path
 * (`other_slice_declared_files`) is canonical, root-bound and never
 * protected (via `relativePath`); each list is duplicate-free; and the two
 * lists are mutually NON-OVERLAPPING — a prefix overlap would silently widen
 * the tolerated scope into the committable scope, so it fails closed with
 * `BOUNDARY.SLICE_POLICY_INVALID` before any Git write.
 *
 * `paths` is required for slice-output (`BOUNDARY.SLICE_POLICY_REQUIRED`).
 */
function assertSliceOutputPolicy(request: BoundaryCloseRequest, root: string): void {
  if (request.paths === undefined || request.paths.length === 0) {
    fail('BOUNDARY.SLICE_POLICY_REQUIRED', 'slice-output requires a declared Work Packet allowed scope (paths)');
  }
  const committable = request.paths.map((value, index) => relativePath(root, value, `paths[${index}]`));
  if (new Set(committable).size !== committable.length) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', 'slice-output paths must be duplicate-free');
  }
  const tolerated = (request.other_slice_declared_files ?? []).map((value, index) =>
    relativePath(root, value, `other_slice_declared_files[${index}]`),
  );
  if (new Set(tolerated).size !== tolerated.length) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', 'slice-output other_slice_declared_files must be duplicate-free');
  }
  for (const value of committable) {
    for (const base of tolerated) {
      if (pathWithin(value, base) || pathWithin(base, value)) {
        fail(
          'BOUNDARY.SLICE_POLICY_INVALID',
          `slice-output committable path and other-Slice tolerated path must not overlap: ${value} vs ${base}`
        );
      }
    }
  }
}

function requirePaths(request: BoundaryCloseRequest, root: string): string[] {
  if (request.paths === undefined || request.paths.length === 0) {
    fail('BOUNDARY.REQUEST_INVALID', `${request.boundary_type} requires a non-empty paths array`);
  }
  const values = request.paths.map((value, index) => relativePath(root, value, `paths[${index}]`));
  if (new Set(values).size !== values.length) fail('BOUNDARY.REQUEST_INVALID', 'paths contains duplicate entries');
  return values.sort();
}

/**
 * Normalize the explicit dirty paths that this boundary must leave alone.
 * Unlike slice-output's other-Slice list, these are exact files rather than
 * prefixes, so a caller cannot hide an entire subtree from the strict gate.
 */
function requireToleratedPaths(request: BoundaryCloseRequest, root: string): string[] {
  if (request.tolerated_paths === undefined) return [];
  if (request.boundary_type === 'slice-output') {
    fail(
      'BOUNDARY.REQUEST_INVALID',
      'tolerated_paths is not valid for slice-output; use other_slice_declared_files',
    );
  }
  const values = request.tolerated_paths.map((value, index) =>
    relativePath(root, value, `tolerated_paths[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    fail('BOUNDARY.REQUEST_INVALID', 'tolerated_paths contains duplicate entries');
  }
  if (EXACT_PATH_TYPES.has(request.boundary_type)) {
    const committed = requirePaths(request, root);
    if (values.some((value) => committed.includes(value))) {
      fail('BOUNDARY.REQUEST_INVALID', 'tolerated_paths overlaps a committable path');
    }
  }
  return values.sort();
}

/** Approved authority roots (commit-boundary.md authority-update scope). */
const AUTHORITY_ROOTS: readonly string[] = ['CONTEXT.md', 'PRD.md', 'progress.md', 'tech-spec'];

/** Canonical Project Stage Map path (commit-boundary.md stage-plan scope). */
export const CANONICAL_STAGE_MAP_PATH = 'delivery/project-stage-map.md';

/** runtime-repair forbidden roots: Stage artifacts, authority documents and agent configuration. */
const RUNTIME_REPAIR_DENIED_ROOTS: readonly string[] = [
  'delivery',
  'CONTEXT.md',
  'PRD.md',
  'progress.md',
  'tech-spec',
  '.agents',
  '.opencode',
  '.pi',
];

/**
 * Per-type containment policy over the declared exact paths (blueprint §6 +
 * commit-boundary.md scope column). direct-fix and prototype-checkpoint stay
 * caller-bounded ("bounded scope per task"); the global protected-path guard
 * (.git/** and .proofloop/** trees) always applies on top for every type.
 */
function assertExactTypeScope(request: BoundaryCloseRequest, declared: readonly string[]): void {
  switch (request.boundary_type) {
    case 'authority-update':
      for (const value of declared) {
        if (!AUTHORITY_ROOTS.some((base) => pathWithin(value, base))) {
          fail(
            'BOUNDARY.SCOPE_VIOLATION',
            `authority-update paths are limited to approved authority roots (${AUTHORITY_ROOTS.join(', ')}): ${value}`,
          );
        }
      }
      return;
    case 'workflow-contract-update': {
      // The exact-path policy covers active Skills, Contracts, the configured
      // agent map, and active host surfaces. It must NOT expand to arbitrary
      // files under .agents or .pi.
      const bases: readonly string[] = [
        '.agents/skills',
        '.agents/contracts',
        '.opencode/agents',
        '.pi/agents',
        '.pi/brain-workflow.md',
        '.pi/subagents.json',
        '.pi/extensions',
      ];
      for (const value of declared) {
        if (!bases.some((base) => pathWithin(value, base))) {
          fail(
            'BOUNDARY.SCOPE_VIOLATION',
            `workflow-contract-update paths are limited to active Skill/Contract/agent-config/host paths (${bases.join(', ')}): ${value}`,
          );
        }
      }
      return;
    }
    case 'runtime-repair':
      for (const value of declared) {
        if (RUNTIME_REPAIR_DENIED_ROOTS.some((base) => pathWithin(value, base))) {
          fail(
            'BOUNDARY.SCOPE_VIOLATION',
            `runtime-repair forbids Stage/Receipt/Authority/agent-configuration paths: ${value}`,
          );
        }
      }
      return;
    default:
      return;
  }
}

/** Fixed/prefix scope for the boundary types whose area is defined by the contract, not by `paths`. */
function prefixScope(request: BoundaryCloseRequest): readonly string[] {
  const type = request.boundary_type;
  const stage = validateStage(request.stage, STAGE_REQUIRED_TYPES.has(type));
  switch (type) {
    case 'baseline-authority':
      return ['CONTEXT.md', 'PRD.md', 'progress.md', 'tech-spec'];
    case 'stage-plan':
      return [`delivery/stages/${stage as string}`, CANONICAL_STAGE_MAP_PATH];
    case 'stage-close':
      return [`delivery/stages/${stage as string}`, 'progress.md'];
    default:
      return [];
  }
}

/**
 * Resolve the exact path set this boundary will commit:
 *  - exact-path types: the declared `paths`, each of which must actually be
 *    dirty (a declared-but-clean path is a request/state mismatch);
 *  - prefix types: every currently dirty path inside the fixed contract scope,
 *    after the caller's exact `tolerated_paths` have been excluded.
 *
 * The caller MUST run assertStrictBoundaryScope() BEFORE this function: the
 * strict dirty gate has already rejected any dirty/untracked path outside the
 * allowed or explicitly tolerated scope.
 */
function requestedPaths(
  request: BoundaryCloseRequest,
  root: string,
  actual: readonly string[],
): string[] {
  if (EXACT_PATH_TYPES.has(request.boundary_type)) {
    const declared = requirePaths(request, root);
    assertExactTypeScope(request, declared);
    if (request.boundary_type === 'artifact-archive') return declared;
    const dirty = new Set(actual);
    const missing = declared.filter((value) => !dirty.has(value));
    if (missing.length > 0) {
      fail(
        'BOUNDARY.NO_CHANGES',
        `declared boundary paths have no pending Git changes: ${missing.join(', ')}`,
      );
    }
    return declared;
  }
  const allowed = request.boundary_type === 'slice-output'
    ? (request.paths ?? [])
    : prefixScope(request);
  if (request.boundary_type === 'slice-output' && (request.paths === undefined || request.paths.length === 0)) {
    fail('BOUNDARY.SLICE_POLICY_REQUIRED', 'slice-output requires a declared Work Packet allowed scope (paths)');
  }
  const selected = actual.filter((value) => allowed.some((base) => pathWithin(value, base)));
  if (selected.length === 0) {
    fail(
      'BOUNDARY.NO_CHANGES',
      `no pending Git changes inside the ${request.boundary_type} scope (${allowed.join(', ')})`,
    );
  }
  return selected;
}

/**
 * Slice-output is the only boundary that may legitimately run inside a
 * DETACHED Slice worktree: `createGitWorktree` creates detached worktrees
 * (`git worktree add --detach`), so the canonical Slice transaction pins the
 * detached identity with the `expected_branch: "HEAD"` sentinel.  The
 * sentinel is VERIFIED, never assumed — the boundary accepts it only when
 * HEAD is genuinely detached; every other boundary type/name keeps the
 * strict symbolic-ref comparison unchanged.
 */
function assertBranch(root: string, expected: string | undefined, boundaryType: BoundaryType): void {
  if (expected === undefined) return;
  if (boundaryType === 'slice-output' && expected === 'HEAD') {
    // On a detached HEAD, `git symbolic-ref --quiet --short HEAD` exits
    // non-zero (HEAD is not a symbolic ref).  readGitHead has already
    // resolved HEAD successfully before this check, so a non-zero exit at
    // this point can only mean genuinely detached — an unborn/broken
    // repository never reaches this branch identity check.  A SUCCESSFUL
    // symbolic-ref proves an attached branch: the caller claimed detached
    // but HEAD sits on a real branch, so fail closed before any Git write.
    let attached: string | undefined;
    try {
      attached = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // Non-zero exit: HEAD is not a symbolic ref — genuinely detached.
      // The detached commit identity is already pinned by the expected_head
      // check that runs before this function.
      return;
    }
    fail('BOUNDARY.BRANCH_MISMATCH', `expected detached HEAD, current branch is "${attached ?? '<unknown>'}"`);
  }
  const current = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'BOUNDARY.GIT_UNAVAILABLE').trim();
  if (current !== expected) fail('BOUNDARY.BRANCH_MISMATCH', `expected branch "${expected}", current branch is "${current}"`);
}

function parseGitObjectLine(line: string, label: string): { readonly mode: string; readonly blob: string } {
  const tab = line.indexOf('\t');
  const meta = tab === -1 ? line : line.slice(0, tab);
  const parts = meta.split(' ');
  if (parts.length !== 3 || parts[1] !== 'blob' || !/^[a-f0-9]{40}$/.test(parts[2])) {
    fail('BOUNDARY.RENAME_INVALID', `${label} is not a tracked regular Git blob: ${JSON.stringify(line)}`);
  }
  return { mode: parts[0], blob: parts[2] };
}

function parseIndexEntryLine(line: string, label: string): { readonly mode: string; readonly blob: string; readonly stage: string } {
  const tab = line.indexOf('\t');
  const meta = tab === -1 ? line : line.slice(0, tab);
  const parts = meta.split(' ');
  if (parts.length !== 3 || !/^[a-f0-9]{40}$/.test(parts[1])) {
    fail('BOUNDARY.RENAME_INVALID', `${label} has an unexpected index record: ${JSON.stringify(line)}`);
  }
  return { mode: parts[0], blob: parts[1], stage: parts[2] };
}

function readIndexEntries(root: string, path: string): readonly string[] {
  return runGit(root, ['ls-files', '-s', '--', path], 'BOUNDARY.RENAME_INVALID')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * Validate the already-staged exact pure rename for artifact-archive.
 * Brain (not this adapter) pre-executes the `git mv`; the adapter verifies that
 * the staged result covers precisely the declared source/destination paths
 * inside the same Stage directory, preserves the source blob/mode, and stages
 * no other path. It understands only source/destination/path/stage/Git facts,
 * never any Manifest credential or naming convention. This validator never
 * changes the worktree or index.
 */
function assertArtifactArchiveRename(
  root: string,
  request: BoundaryCloseRequest,
  before: readonly StatusEntry[],
  requested: readonly string[],
  preCommitHead: string,
): void {
  const stagedEntries = before.filter((entry) => entry.index !== ' ' && entry.index !== '?');
  const renamePaths = statusPaths(stagedEntries);
  if (
    stagedEntries.length !== 1 ||
    stagedEntries[0].index !== 'R' ||
    stagedEntries[0].worktree !== ' ' ||
    requested.length !== 2 ||
    renamePaths.length !== 2 ||
    renamePaths[0] !== requested[0] ||
    renamePaths[1] !== requested[1]
  ) {
    fail(
      'BOUNDARY.RENAME_INVALID',
      'artifact-archive requires exactly one staged pure Git rename (worktree clean for both paths) covering exactly the declared paths',
    );
  }
  // Porcelain -z rename records carry both paths without a stable side
  // order; identify the roles mechanically: after `git mv`, EXACTLY ONE
  // side remains in the index (the destination) while the other was removed
  // by the move (the source). This also proves the source is fully unstaged.
  const pathA = stagedEntries[0].paths[0];
  const pathB = stagedEntries[0].paths[1];
  const indexEntriesA = readIndexEntries(root, pathA);
  const indexEntriesB = readIndexEntries(root, pathB);
  let source: string;
  let destination: string;
  let destinationEntries: readonly string[];
  if (indexEntriesA.length > 0 && indexEntriesB.length === 0) {
    destination = pathA;
    destinationEntries = indexEntriesA;
    source = pathB;
  } else if (indexEntriesB.length > 0 && indexEntriesA.length === 0) {
    destination = pathB;
    destinationEntries = indexEntriesB;
    source = pathA;
  } else {
    fail(
      'BOUNDARY.RENAME_INVALID',
      `artifact-archive requires exactly one staged rename side (one path in the index, the other fully removed): ${pathA}, ${pathB}`,
    );
  }
  // Same-Stage containment (commit-boundary.md: source and destination are
  // explicit paths inside the same Stage directory).
  const stageBase = `delivery/stages/${request.stage as string}`;
  if (!pathWithin(source, stageBase) || !pathWithin(destination, stageBase)) {
    fail(
      'BOUNDARY.SCOPE_VIOLATION',
      `artifact-archive source and destination must stay inside ${stageBase}/`,
    );
  }
  // Blob identity: HEAD:<source> vs the staged destination index entry.
  const headLines = runGit(root, ['ls-tree', preCommitHead, '--', source], 'BOUNDARY.RENAME_INVALID')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  if (headLines.length !== 1) {
    fail('BOUNDARY.RENAME_INVALID', `artifact-archive source is not tracked at the pre-commit HEAD: ${source}`);
  }
  const headObject = parseGitObjectLine(headLines[0], `HEAD:${source}`);
  // Destination novelty (commit-boundary.md: the destination is absent):
  // nothing may be tracked at that path in the pre-commit HEAD.
  const destinationHeadLines = runGit(root, ['ls-tree', preCommitHead, '--', destination], 'BOUNDARY.RENAME_INVALID')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  if (destinationHeadLines.length !== 0) {
    fail(
      'BOUNDARY.RENAME_INVALID',
      `artifact-archive destination must be absent at the pre-commit HEAD: ${destination}`,
    );
  }
  if (destinationEntries.length !== 1) {
    fail('BOUNDARY.RENAME_INVALID', `artifact-archive destination is not staged uniquely: ${destination}`);
  }
  const destinationEntry = parseIndexEntryLine(destinationEntries[0], `index:${destination}`);
  if (destinationEntry.stage !== '0') {
    fail(
      'BOUNDARY.RENAME_INVALID',
      `artifact-archive destination has unresolved merge-conflict stages: ${destination}`,
    );
  }
  if (destinationEntry.blob !== headObject.blob || destinationEntry.mode !== headObject.mode) {
    fail(
      'BOUNDARY.RENAME_INVALID',
      `artifact-archive must be a pure rename: the staged destination blob/mode differs from the HEAD source (${destinationEntry.blob} ${destinationEntry.mode} != ${headObject.blob} ${headObject.mode})`,
    );
  }
}
/**
 * Canonical commit messages (commit-boundary.md workflows, blueprint §19):
 * id-bearing types use the fixed `<type>: <ids>` form and reject a free-form
 * description; the rest require a single-line description and emit
 * `<type>: <description>`. No silent dropping of caller input.
 */
function commitMessage(request: BoundaryCloseRequest): string {
  const type = request.boundary_type;
  if (ID_MESSAGE_TYPES.has(type)) {
    if (request.description !== undefined) {
      fail(
        'BOUNDARY.REQUEST_INVALID',
        `description is not part of the canonical ${type} commit message`,
      );
    }
    switch (type) {
      case 'baseline-authority':
        return 'baseline-authority: initial authority documents';
      case 'stage-plan':
      case 'stage-close':
        return `${type}: ${request.stage as string}`;
      case 'artifact-archive':
        return `artifact-archive: ${request.stage as string}`;
      case 'slice-output':
        return `slice-output: ${request.stage as string}-${request.slice as string}`;
    }
  }
  if (request.description === undefined) {
    fail('BOUNDARY.REQUEST_INVALID', `${type} requires a 1..200 character single-line description`);
  }
  return `${type}: ${validateDescriptionFormat(request.description, type)}`;
}

/** Result of the internal candidate-ref establishment/recovery seam. */
export interface CandidateRefResult {
  readonly candidate_ref: string;
  readonly candidate_base_ref: string;
  readonly commit_sha: string;
  readonly created: boolean;
}

function validateCandidateRefInput(stageId: string, sliceToken: string, commitSha: string, baseRef: string): void {
  if (!STAGE_RE.test(stageId)) {
    fail('BOUNDARY.REQUEST_INVALID', `stage_id must match /^S\\d+$/, received "${stageId}"`);
  }
  // canonicalCandidateRef performs the closed Slice-token validation.
  canonicalCandidateRef(stageId, sliceToken);
  if (!SHA_RE.test(commitSha)) {
    fail('BOUNDARY.POST_COMMIT_INVALID', `candidate commit_sha is not a 40-char lowercase Git SHA: ${commitSha}`);
  }
  if (typeof baseRef !== 'string' || baseRef.length === 0 || CONTROL_CHARS_RE.test(baseRef) || !GIT_REF_RE.test(baseRef) || baseRef.includes('..') || baseRef.includes('@{')) {
    fail('BOUNDARY.POST_COMMIT_INVALID', `candidate base_ref is not a safe Git ref: ${baseRef}`);
  }
}

function resolveRequiredCommit(root: string, ref: string, label: string): string {
  const resolved = optionalCommitRef(root, ref);
  if (resolved === undefined) {
    fail('BOUNDARY.POST_COMMIT_INVALID', `cannot resolve ${label} as a commit: ${ref}`);
  }
  return resolved;
}

/**
 * Establish or recover the canonical candidate ref after a slice-output commit.
 * This is intentionally ref-only: it never calls boundary close, does not pin an
 * expected HEAD, and never resets/unstages the worktree.  Existing refs are
 * idempotent only when they already point to the same commit.
 */
export function ensureCandidateRef(
  root: string,
  stage_id: string,
  slice_token: string,
  commit_sha: string,
  base_ref: string,
 ): CandidateRefResult {
  validateCandidateRefInput(stage_id, slice_token, commit_sha, base_ref);
  const gitRoot = (() => {
    try {
      return resolveGitRoot(root);
    } catch (error) {
      fail('BOUNDARY.POST_COMMIT_INVALID', `canonical Git project root is unavailable: ${errorText(error)}`);
    }
  })();
  const baseSha = resolveRequiredCommit(gitRoot, base_ref, 'candidate base_ref');
  if (!isAncestorCommit(gitRoot, baseSha, commit_sha)) {
    fail('BOUNDARY.POST_COMMIT_INVALID', `candidate base_ref ${base_ref} is not an ancestor of candidate commit ${commit_sha}`);
  }
  const candidate_ref = `refs/heads/${canonicalCandidateRef(stage_id, slice_token)}`;
  const existing = optionalCommitRef(gitRoot, candidate_ref);
  if (existing !== undefined) {
    if (existing !== commit_sha) {
      fail(
        'BOUNDARY.POST_COMMIT_INVALID',
        `candidate ref ${candidate_ref} already points to ${existing}, not ${commit_sha}; refusing to overwrite`,
      );
    }
    return {
      candidate_ref: candidate_ref.slice('refs/heads/'.length),
      candidate_base_ref: base_ref,
      commit_sha,
      created: false,
    };
  }
  try {
    // Supplying the zero old-value makes creation fail closed if a concurrent
    // writer establishes the ref between the read and this update.  We never
    // overwrite an existing candidate ref.
    runGit(
      gitRoot,
      ['update-ref', candidate_ref, commit_sha, '0000000000000000000000000000000000000000'],
      'BOUNDARY.POST_COMMIT_INVALID',
    );
  } catch (error) {
    if (error instanceof GitBoundaryError && error.code === 'BOUNDARY.POST_COMMIT_INVALID') {
      const now = optionalCommitRef(gitRoot, candidate_ref);
      if (now === commit_sha) {
        return {
          candidate_ref: candidate_ref.slice('refs/heads/'.length),
          candidate_base_ref: base_ref,
          commit_sha,
          created: false,
        };
      }
      throw error;
    }
    fail('BOUNDARY.POST_COMMIT_INVALID', `candidate ref write failed: ${errorText(error)}`);
  }
  const written = optionalCommitRef(gitRoot, candidate_ref);
  if (written !== commit_sha) {
    fail('BOUNDARY.POST_COMMIT_INVALID', `candidate ref ${candidate_ref} did not resolve to ${commit_sha} after write`);
  }
  return {
    candidate_ref: candidate_ref.slice('refs/heads/'.length),
    candidate_base_ref: base_ref,
    commit_sha,
    created: true,
  };
}

/** True when `ancestor` is an ancestor of `commit` (or equal). */
function isAncestorCommit(root: string, ancestor: string, commit: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, commit], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Narrow post-stage guard: every path this boundary committed to must be
 * fully staged (no worktree drift between status snapshot and add). Dirty
 * paths OUTSIDE the boundary scope are irrelevant and never block here.
 */
function assertBoundaryPathsStaged(
  root: string,
  requested: readonly string[],
): void {
  const requestedSet = new Set(requested);
  const entries = parseStatus(runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'BOUNDARY.GIT_UNAVAILABLE'));
  for (const entry of entries) {
    if (entry.worktree !== ' ' && entry.worktree !== '?' && entry.paths.some((value) => requestedSet.has(value))) {
      fail(
        'BOUNDARY.DIFF_INVALID',
        `boundary path changed while the boundary was being closed (unstaged drift): ${entry.paths.join(', ')}`,
      );
    }
  }
}

function stagedPaths(root: string): string[] {
  // --no-renames keeps the staged listing deterministic regardless of the
  // caller's diff.renames config: a pure staged rename lists BOTH paths,
  // matching the porcelain rename record parsed above.
  const output = runGit(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--'], 'BOUNDARY.GIT_UNAVAILABLE');
  return output.split('\u0000').filter((entry) => entry.length > 0).sort();
}

function assertStagedSet(root: string, expected: readonly string[]): void {
  const staged = stagedPaths(root).map((value, index) => relativePath(root, value, `staged path[${index}]`));
  if (staged.length === 0) fail('BOUNDARY.NO_CHANGES', 'boundary close produced an empty Git index');
  const actual = [...new Set(staged)].sort();
  const wanted = [...new Set(expected)].sort();
  if (actual.length !== wanted.length || actual.some((value, index) => value !== wanted[index])) {
    fail(
      'BOUNDARY.SCOPE_VIOLATION',
      `staged path set does not match the validated boundary (expected=${wanted.join(',')} actual=${actual.join(',')})`,
    );
  }
}


function readCommittedPaths(root: string, commitSha: string): string[] {
  // Plumbing diff-tree has no rename detection by default; --no-renames makes
  // that explicit so a pure archive rename reports both paths deterministically.
  const output = runGit(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', commitSha, '--'], 'BOUNDARY.POST_COMMIT_INVALID');
  return output.split('\u0000').filter((entry) => entry.length > 0).map((value, index) => relativePath(root, value, `committed path[${index}]`)).sort();
}

/**
 * Derive this boundary's tolerated scope without inspecting the dirty set or
 * selected commit paths. Explicit `tolerated_paths` are exact files that stay
 * dirty but are never selected, staged, or committed by this transaction.
 */
function toleratedBoundaryScope(
  request: BoundaryCloseRequest,
  root: string,
  explicitTolerated: readonly string[],
 ): readonly string[] {
  if (request.boundary_type === 'slice-output') {
    // slice-output has its own typed other-Slice tolerance field.
    return [...(request.paths ?? []), ...(request.other_slice_declared_files ?? [])];
  }
  if (EXACT_PATH_TYPES.has(request.boundary_type)) {
    const declared = requirePaths(request, root);
    assertExactTypeScope(request, declared);
    return [...declared, ...explicitTolerated];
  }
  return [...prefixScope(request), ...explicitTolerated];
}

function assertToleratedPathsAreDirty(
  tolerated: readonly string[],
  actual: readonly string[],
 ): void {
  const actualSet = new Set(actual);
  const missing = tolerated.filter((value) => !actualSet.has(value));
  if (missing.length > 0) {
    fail(
      'BOUNDARY.SCOPE_VIOLATION',
      `tolerated_paths are not dirty at transaction start: ${missing.join(', ')}`,
    );
  }
}

/**
 * Strict dirty gate (blueprint): runs BEFORE any Git write AND before
 * requestedPaths(). Every actual dirty/untracked path must belong to the
 * boundary prefix/exact scope or be explicitly listed as tolerated; tolerated
 * files remain in the worktree and are never staged by requestedPaths().
 */
function assertStrictBoundaryScope(
  request: BoundaryCloseRequest,
  root: string,
  actual: readonly string[],
  explicitTolerated: readonly string[],
 ): void {
  const tolerated = toleratedBoundaryScope(request, root, explicitTolerated);
  const outside = actual.filter((value) => !tolerated.some((base) => pathWithin(value, base)));
  if (outside.length > 0) {
    fail(
      'BOUNDARY.SCOPE_VIOLATION',
      `boundary scope violation: dirty/untracked path(s) outside the ${request.boundary_type} scope: ${outside.join(', ')}`,
    );
  }
}

/** Close one deterministic Git boundary. The caller owns recovery decisions. */
export function closeGitBoundary(root: string, request: BoundaryCloseRequest): BoundaryCloseResult {
  // ---- Closed static request validation (no Git access, fail fast) ----
  // Public-export contract: direct callers bypass the CLI closed-schema
  // parser, so the boundary_type closed set is re-checked HERE, before any
  // Git access (an unknown value must never fall through scope derivation).
  if (!(BOUNDARY_TYPES as readonly string[]).includes(request.boundary_type)) {
    fail(
      'BOUNDARY.REQUEST_INVALID',
      `boundary_type must be one of ${BOUNDARY_TYPES.join('|')}`,
    );
  }
  // Stage ids are mechanically required by their types regardless of scope
  // shape (exact-path types never reach prefixScope()).
  validateStage(request.stage, STAGE_REQUIRED_TYPES.has(request.boundary_type));
  const expectedHead = validateExpectedHead(request.expected_head);
  validateSlice(request.stage, request.slice);
  if (request.expected_branch !== undefined && request.expected_branch.length === 0) {
    fail('BOUNDARY.REQUEST_INVALID', 'expected_branch must be a non-empty branch name');
  }
  if (request.boundary_type === 'prototype-checkpoint' && request.expected_branch === undefined) {
    fail('BOUNDARY.REQUEST_INVALID', 'prototype-checkpoint requires expected_branch');
  }
  if (request.boundary_type === 'slice-output') {
    // expected_head is REQUIRED for slice-output: the current HEAD must be
    // pinned so that a HEAD mismatch fails before any Git write. The Work
    // Packet declares the allowed scope via `paths` (no receipt/manifest
    // binding).
    if (
      request.stage === undefined ||
      request.slice === undefined ||
      expectedHead === undefined
    ) {
      fail(
        'BOUNDARY.REQUEST_INVALID',
        'slice-output requires stage, slice, and expected_head',
      );
    }
  }
  // other_slice_declared_files is slice-output ONLY: the tolerance-scope
  // separation is a Slice boundary policy, never an exact/prefix-type field.
  if (request.boundary_type !== 'slice-output' && request.other_slice_declared_files !== undefined) {
    fail(
      'BOUNDARY.REQUEST_INVALID',
      `other_slice_declared_files is only valid for slice-output, not ${request.boundary_type}`
    );
  }
  if (request.boundary_type === 'slice-output' && request.tolerated_paths !== undefined) {
    fail(
      'BOUNDARY.REQUEST_INVALID',
      'tolerated_paths is not valid for slice-output; use other_slice_declared_files',
    );
  }

  // ---- Canonical Git facts ----
  const gitRoot = (() => {
    try {
      return resolveGitRoot(root);
    } catch (error) {
      fail('BOUNDARY.GIT_UNAVAILABLE', `canonical Git project root is unavailable: ${errorText(error)}`);
    }
  })();
  const preCommitHead = (() => {
    try {
      return readGitHead(gitRoot);
    } catch (error) {
      fail('BOUNDARY.GIT_UNAVAILABLE', `current Git HEAD is unavailable: ${errorText(error)}`);
    }
  })();
  if (expectedHead !== undefined && expectedHead !== preCommitHead) {
    fail('BOUNDARY.HEAD_MISMATCH', `expected_head "${expectedHead}" does not match current HEAD "${preCommitHead}"`);
  }
  assertBranch(gitRoot, request.expected_branch, request.boundary_type);
  // Slice-output Work Packet path policy (canonical/root-bound/protected,
  // duplicate-free, mutually non-overlapping) runs BEFORE any status parse or
  // strict dirty gate: a malformed policy fails closed without any Git
  // inspection, and the tolerated-scope derivation below can trust the
  // already-validated lists.
  if (request.boundary_type === 'slice-output') {
    assertSliceOutputPolicy(request, gitRoot);
  }

  const before = parseStatus(runGit(gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'BOUNDARY.GIT_UNAVAILABLE'));
  // Ordinary boundaries require an initially empty Git index. artifact-archive
  // is the ONE exception: Brain pre-executes the exact `git mv`, so the index
  // already carries a single staged rename, which assertArtifactArchiveRename
  // verifies is the ONLY staged entry before commit.
  if (request.boundary_type !== 'artifact-archive' && hasStagedIndex(before)) {
    fail('BOUNDARY.INDEX_NOT_EMPTY', 'boundary close requires an initially empty Git index');
  }
  // Root-bound/protection gate over EVERY dirty path: a modified tracked file
  // under .git/**/.proofloop/** (or anything resolving outside the root) is a
  // broken repository state that Brain must recover — never silently commit
  // around it.
  const actual = statusPaths(before).map((value, index) => relativePath(gitRoot, value, `Git changed path[${index}]`));
  const toleratedPaths = requireToleratedPaths(request, gitRoot);
  assertToleratedPathsAreDirty(toleratedPaths, actual);
  // Strict dirty gate runs before staging: listed tolerated files are allowed
  // to remain dirty, but the candidate selection below excludes them exactly.
  assertStrictBoundaryScope(request, gitRoot, actual, toleratedPaths);
  const selectionActual = actual.filter((value) => !toleratedPaths.includes(value));
  const requested = requestedPaths(request, gitRoot, selectionActual);

  let pureArchiveRename = false;
  if (request.boundary_type === 'artifact-archive') {
    // Artifact-archive responsibility: Brain pre-executes the exact `git mv`
    // and leaves the rename staged. This adapter NEVER runs `git mv`; it only
    // validates the already-staged exact pure rename and commits it. All
    // source/destination, same-stage, HEAD tracked/absent and blob/mode checks
    // complete against the CURRENT status before commit; a validation failure
    // must not change worktree or index.
    assertArtifactArchiveRename(gitRoot, request, before, requested, preCommitHead);
    pureArchiveRename = true;
  }
  const message = commitMessage(request);

  // ---- Stage exactly the validated set ----
  if (pureArchiveRename) {
    // Brain already staged the exact rename; only validate and commit it.
  } else {
    runGit(gitRoot, ['diff', '--check', '--', ...requested], 'BOUNDARY.DIFF_INVALID');
    runGit(gitRoot, ['add', '--', ...requested], 'BOUNDARY.COMMIT_FAILED');
  }
  assertBoundaryPathsStaged(gitRoot, requested);
  assertStagedSet(gitRoot, requested);
  runGit(gitRoot, ['diff', '--cached', '--check', '--'], 'BOUNDARY.DIFF_INVALID');
  runGit(gitRoot, ['commit', '-m', message], 'BOUNDARY.COMMIT_FAILED');

  // ---- Post-commit facts ----
  let commitSha: string;
  try {
    commitSha = readGitHead(gitRoot);
  } catch (error) {
    fail('BOUNDARY.POST_COMMIT_INVALID', `committed HEAD is unavailable: ${errorText(error)}`);
  }

  // A slice-output commit is also the candidate-ref establishment boundary.
  // The public BoundaryCloseResult remains unchanged; the ref is an internal
  // traceability fact and is never deleted here.  If this post-commit write
  // fails, the commit remains durable and POST_COMMIT_INVALID is returned.
  if (request.boundary_type === 'slice-output') {
    ensureCandidateRef(gitRoot, request.stage as string, request.slice as string, commitSha, preCommitHead);
  }
  const committed = readCommittedPaths(gitRoot, commitSha);
  if (committed.length === 0 || committed.some(isProtectedPath)) {
    fail('BOUNDARY.POST_COMMIT_INVALID', 'commit changed-file set is empty or contains a protected path');
  }
  if (
    committed.length !== requested.length ||
    committed.some((value, index) => value !== requested[index])
  ) {
    fail(
      'BOUNDARY.POST_COMMIT_INVALID',
      `committed changed-file set drifted from the validated boundary (expected=${requested.join(',')} actual=${committed.join(',')})`,
    );
  }
  const dirtyAfter = runGit(gitRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'BOUNDARY.POST_COMMIT_INVALID').trim().length > 0;
  return {
    boundary_type: request.boundary_type,
    pre_commit_head: preCommitHead,
    commit_sha: commitSha,
    commit_message: message,
    changed_files: committed,
    dirty_after: dirtyAfter,
    tolerated_paths: toleratedPaths,
  };
}
