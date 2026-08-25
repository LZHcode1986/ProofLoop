/**
 * Deterministic Git boundary closure for the public `proofloop boundary close`
 * command (docs/ProofLoop_v2_Technical_Architecture_Blueprint_Committer_to_Boundary_CLI.md,
 * Part B §4–§7; .agents/contracts/brain/commit-boundary.md is the semantic
 * source for per-type scope and canonical commit messages).
 *
 * This module owns only mechanical Git facts and writes. Brain decides when a
 * boundary is appropriate and performs any recovery; this function never
 * stashes, resets, restores, rebases, merges, pushes, or edits artifacts.
 *
 * Worktree semantics: the worktree may carry unrelated dirty/untracked files
 * (parallel Worker sessions, user edits). The adapter commits ONLY the paths
 * derived from the closed boundary scope and reports remaining dirtiness
 * through `dirty_after`; it never decides whether an unrelated dirty file
 * belongs to someone else (that is Brain's recovery decision, blueprint §13).
 * Any dirty path that resolves to `.git/**` / `.proofloop/**` or escapes the
 * project root fails closed before staging (`BOUNDARY.SCOPE_VIOLATION`).
 */

import { execFileSync } from 'node:child_process';
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
  readonly manifest_digest?: string;
  readonly cv_receipt_digest?: string;
  readonly old_manifest_digest?: string;
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
  readonly cv_receipt_digest?: string;
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
  | 'BOUNDARY.SLICE_POLICY_REQUIRED';

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

const SHA256_RE = /^[a-f0-9]{64}$/;
const STAGE_RE = /^S\d+$/;
const SLICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** Boundary types whose canonical commit message embeds ids/digests, not a free-form description. */
const ID_MESSAGE_TYPES: ReadonlySet<BoundaryType> = new Set([
  'baseline-authority',
  'stage-plan',
  'artifact-archive',
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

function validateSlice(value: string | undefined): void {
  if (value !== undefined && !SLICE_RE.test(value)) {
    fail('BOUNDARY.REQUEST_INVALID', `slice must be a canonical identifier, received "${value}"`);
  }
}

function validateDigest(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!SHA256_RE.test(value)) fail('BOUNDARY.REQUEST_INVALID', `${label} must be a lowercase SHA-256 digest`);
  return value;
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

function requirePaths(request: BoundaryCloseRequest, root: string): string[] {
  if (request.paths === undefined || request.paths.length === 0) {
    fail('BOUNDARY.REQUEST_INVALID', `${request.boundary_type} requires a non-empty paths array`);
  }
  const values = request.paths.map((value, index) => relativePath(root, value, `paths[${index}]`));
  if (new Set(values).size !== values.length) fail('BOUNDARY.REQUEST_INVALID', 'paths contains duplicate entries');
  return values.sort();
}

/** Approved authority roots (commit-boundary.md authority-update scope). */
const AUTHORITY_ROOTS: readonly string[] = ['CONTEXT.md', 'PRD.md', 'progress.md', 'tech-spec'];

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
      const bases: readonly string[] = ['.agents/skills', '.agents/contracts', '.opencode/agents'];
      for (const value of declared) {
        if (!bases.some((base) => pathWithin(value, base))) {
          fail(
            'BOUNDARY.SCOPE_VIOLATION',
            `workflow-contract-update paths are limited to active Skill/Contract/opencode-agent paths (${bases.join(', ')}): ${value}`,
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
      return ['CONTEXT.md', 'PRD.md', 'tech-spec'];
    case 'stage-plan':
      return [`delivery/stages/${stage as string}`];
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
 *  - prefix types: every currently dirty path inside the fixed contract scope.
 * Unrelated dirty paths outside the resolved scope stay untouched and are
 * reported through `dirty_after` (blueprint §13: Brain owns recovery).
 */
function requestedPaths(
  request: BoundaryCloseRequest,
  root: string,
  actual: readonly string[],
): string[] {
  if (EXACT_PATH_TYPES.has(request.boundary_type)) {
    const declared = requirePaths(request, root);
    assertExactTypeScope(request, declared);
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
  const allowed = prefixScope(request);
  const selected = actual.filter((value) => allowed.some((base) => pathWithin(value, base)));
  if (selected.length === 0) {
    fail(
      'BOUNDARY.NO_CHANGES',
      `no pending Git changes inside the ${request.boundary_type} scope (${allowed.join(', ')})`,
    );
  }
  return selected;
}

function assertBranch(root: string, expected: string | undefined): void {
  if (expected === undefined) return;
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
 * artifact-archive accepts exactly one pre-staged pure rename (Brain ran
 * `git mv` itself; the adapter never moves content) covering precisely the
 * declared paths, inside the SAME delivery/stages/<stage>/ directory, with
 * the digest-qualified destination carrying the invalidated Manifest digest.
 * Blob identity is verified against the pre-commit HEAD: the staged
 * destination entry must carry the SAME blob and mode the source had at
 * HEAD, and the source must be fully removed from the index. This catches
 * drift that is already `git add`-ed (clean worktree, changed staged
 * content), which porcelain status alone cannot see. Unrelated
 * untracked/dirty files elsewhere do not matter here — only the staged set.
 */
function assertArtifactArchiveRename(
  root: string,
  request: BoundaryCloseRequest,
  before: readonly StatusEntry[],
  requested: readonly string[],
  oldManifestDigest: string,
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
  // The digest-qualified side must be the mechanically identified
  // DESTINATION itself — not merely "some path in the pair" whose name
  // happens to contain the digest (a digest-bearing SOURCE name must not
  // satisfy this policy).
  if (!destination.includes(oldManifestDigest)) {
    fail(
      'BOUNDARY.RENAME_INVALID',
      'artifact-archive destination must be digest-qualified with old_manifest_digest',
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
function commitMessage(request: BoundaryCloseRequest, oldManifestDigest: string | undefined): string {
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
        return `artifact-archive: ${request.stage as string} ${oldManifestDigest as string}`;
    }
  }
  if (request.description === undefined) {
    fail('BOUNDARY.REQUEST_INVALID', `${type} requires a 1..200 character single-line description`);
  }
  return `${type}: ${validateDescriptionFormat(request.description, type)}`;
}

/**
 * Narrow post-stage guard: every path this boundary committed to must be
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
  validateDigest(request.manifest_digest, 'manifest_digest');
  const cvReceiptDigest = validateDigest(request.cv_receipt_digest, 'cv_receipt_digest');
  const oldManifestDigest = validateDigest(request.old_manifest_digest, 'old_manifest_digest');
  validateSlice(request.slice);
  if (request.expected_branch !== undefined && request.expected_branch.length === 0) {
    fail('BOUNDARY.REQUEST_INVALID', 'expected_branch must be a non-empty branch name');
  }
  if (request.boundary_type === 'prototype-checkpoint' && request.expected_branch === undefined) {
    fail('BOUNDARY.REQUEST_INVALID', 'prototype-checkpoint requires expected_branch');
  }
  if (request.boundary_type === 'slice-output') {
    // Slice-output has a Runtime-owned scope/credential policy shared with
    // `stage admit-slice-commit` (blueprint §8). Until that policy seam is
    // extracted, this generic adapter must not become a second admission
    // consumer: fail closed instead of committing on partial checks.
    fail(
      'BOUNDARY.SLICE_POLICY_REQUIRED',
      'slice-output requires the shared Runtime slice-commit policy before it can close a boundary',
    );
  }
  if (request.boundary_type === 'artifact-archive' && oldManifestDigest === undefined) {
    fail('BOUNDARY.REQUEST_INVALID', 'artifact-archive requires old_manifest_digest');
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
  assertBranch(gitRoot, request.expected_branch);

  const before = parseStatus(runGit(gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'BOUNDARY.GIT_UNAVAILABLE'));
  if (hasStagedIndex(before) && request.boundary_type !== 'artifact-archive') {
    fail('BOUNDARY.INDEX_NOT_EMPTY', 'boundary close requires an initially empty Git index');
  }
  // Root-bound/protection gate over EVERY dirty path: a modified tracked file
  // under .git/**/.proofloop/** (or anything resolving outside the root) is a
  // broken repository state that Brain must recover — never silently commit
  // around it.
  const actual = statusPaths(before).map((value, index) => relativePath(gitRoot, value, `Git changed path[${index}]`));
  const requested = requestedPaths(request, gitRoot, actual);

  let pureArchiveRename = false;
  if (request.boundary_type === 'artifact-archive') {
    assertArtifactArchiveRename(gitRoot, request, before, requested, oldManifestDigest as string, preCommitHead);
    pureArchiveRename = true;
  }
  const message = commitMessage(request, oldManifestDigest);

  // ---- Stage exactly the validated set ----
  if (pureArchiveRename) {
    // The rename is already staged by the caller's `git mv`; only validate it.
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
    ...(cvReceiptDigest !== undefined ? { cv_receipt_digest: cvReceiptDigest } : {}),
  };
}
