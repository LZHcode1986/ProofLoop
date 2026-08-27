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
 * actual dirty/untracked path must belong to this boundary's tolerated scope,
 * otherwise the boundary fails closed with `BOUNDARY.SCOPE_VIOLATION` and
 * leaves HEAD and the index unchanged. The one deliberate tolerance is
 * `slice-output`: a parallel Slice's declared dirty output may remain in the
 * worktree (reported via `dirty_after`) but is NEVER staged or committed by
 * the current Slice boundary. Any dirty path that resolves to `.git/**` /
 * `.proofloop/**` or escapes the project root also fails closed before
 * staging (`BOUNDARY.SCOPE_VIOLATION`).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest } from '@proofloop/kernel';
import type { VNextManifest } from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from './path-guard';
import { isSliceEvidenceFinalized, readGitHead, resolveGitRoot } from './git-source';
import { stageGateReceiptDir, reviewReceiptDir } from './receipt-layout';
import { loadVNextSliceCommitPolicyFacts } from './vnext/commit-admission';
import { readVNextManifest } from './vnext/dispatch';
import { readReceiptChain } from './vnext/integration-validation';
import { readVNextStageReviewStatus } from './vnext/review-admission';
import {
  loadSliceCommitPolicy,
  validateSliceCommitChangedFiles,
  validateSliceCommitCvBinding,
} from './vnext/slice-commit-policy';
import type { SliceCommitPolicy } from './vnext/slice-commit-policy';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      // Pi is the active harness: the exact-path policy must cover the live
      // `.pi/brain-workflow.md` workflow doc and the active `.pi/agents/*`
      // alignment, alongside the Skill/Contract/opencode-agent paths. It must
      // NOT expand to arbitrary `.pi` files (only the two approved roots).
      const bases: readonly string[] = [
        '.agents/skills',
        '.agents/contracts',
        '.opencode/agents',
        '.pi/brain-workflow.md',
        '.pi/agents',
      ];
      for (const value of declared) {
        if (!bases.some((base) => pathWithin(value, base))) {
          fail(
            'BOUNDARY.SCOPE_VIOLATION',
            `workflow-contract-update paths are limited to active Skill/Contract/agent/pi-workflow paths (${bases.join(', ')}): ${value}`,
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
 *
 * The caller MUST run assertStrictBoundaryScope() BEFORE this function: the
 * strict dirty gate has already rejected any dirty/untracked path outside the
 * tolerated scope, so only in-scope dirty paths remain by the time this runs.
 */
function requestedPaths(
  request: BoundaryCloseRequest,
  root: string,
  actual: readonly string[],
  slicePolicy?: SliceCommitPolicy,
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
    ? slicePolicy?.allowedPaths ?? []
    : prefixScope(request);
  if (request.boundary_type === 'slice-output' && slicePolicy === undefined) {
    fail('BOUNDARY.SLICE_POLICY_REQUIRED', 'slice-output requires the shared Runtime slice-commit policy');
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
 * Validate the already-staged exact pure rename for artifact-archive.
 * Brain (not this adapter) pre-executes the `git mv`; the adapter verifies that
 * the staged result covers precisely the declared source/destination paths
 * inside the same Stage directory, preserves the source blob/mode, and stages
 * no other path. This validator never changes the worktree or index.
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

function readTreePaths(root: string, commitSha: string): string[] {
  return runGit(
    root,
    ['ls-tree', '-r', '--name-only', commitSha, '--'],
    'BOUNDARY.GIT_UNAVAILABLE',
  )
    .split('\n')
    .map((value) => value.trimEnd())
    .filter((value) => value.length > 0)
    .map((value, index) => relativePath(root, value, `Git tree path[${index}]`));
}

function readCommittedPaths(root: string, commitSha: string): string[] {
  // Plumbing diff-tree has no rename detection by default; --no-renames makes
  // that explicit so a pure archive rename reports both paths deterministically.
  const output = runGit(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', commitSha, '--'], 'BOUNDARY.POST_COMMIT_INVALID');
  return output.split('\u0000').filter((entry) => entry.length > 0).map((value, index) => relativePath(root, value, `committed path[${index}]`)).sort();
}

/**
 * stage-plan machine preflight: the request MUST declare manifest_digest and it
 * MUST equal the digest of the current Runtime-persisted vNext Manifest. This
 * reuses the canonical manifest reader + kernel digest validator; it adds no
 * state. A wrong or missing digest fails before any Git write.
 */
function assertStagePlanManifestPreflight(root: string, stage: string, manifestDigest: string | undefined): void {
  if (manifestDigest === undefined) {
    fail('BOUNDARY.REQUEST_INVALID', 'stage-plan requires manifest_digest matching the persisted vNext Manifest');
  }
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${stage}.json`);
  let persisted: unknown;
  try {
    persisted = readVNextManifest(root, manifestPath);
  } catch (error) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', `stage-plan cannot read the persisted vNext Manifest: ${errorText(error)}`);
  }
  const actualDigest = computeDigest(persisted);
  if (actualDigest !== manifestDigest) {
    fail(
      'BOUNDARY.SCOPE_VIOLATION',
      `stage-plan manifest_digest does not match the persisted vNext Manifest: ${manifestDigest} != ${actualDigest}`,
    );
  }
}

/**
 * Pure, testable gate/review tip-binding check for the stage-close preflight.
 * Enforces (fail-closed):
 *  - the Stage Gate tip is a GATE_PASS bound EXACTLY to the integrated HEAD;
 *  - the Stage Review tip is an ACCEPTED STAGE_REVIEW_PASS whose snapshot EXACTLY
 *    equals the integrated HEAD and which binds the current Stage Gate tip digest.
 * `label` prefixes the error message; throws GitBoundaryError(SLICE_POLICY_INVALID).
 */
export function assertStageCloseTipBindings(
  gateTip: { readonly type: string; readonly digest: string; readonly payload: unknown } | null,
  reviewTip: { readonly type: string; readonly digest: string; readonly payload: unknown } | null,
  integratedHead: string,
  label: string,
): void {
  if (gateTip === null || !isRecord(gateTip.payload)) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', `${label} requires a persisted Stage Gate fact`);
  }
  const gatePayload = gateTip.payload as Record<string, unknown>;
  if (gateTip.type !== 'GATE_PASS' || gatePayload.verdict !== 'PASS') {
    fail('BOUNDARY.SLICE_POLICY_INVALID', `${label} requires the current Stage Gate tip to be PASS`);
  }
  if (typeof gatePayload.snapshot_digest !== 'string' || gatePayload.snapshot_digest !== integratedHead) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', `${label} Gate tip snapshot does not match the current integrated HEAD (fresh Gate required)`);
  }
  if (reviewTip === null || !isRecord(reviewTip.payload)) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', `${label} requires a persisted Stage Review fact`);
  }
  const reviewPayload = reviewTip.payload as Record<string, unknown>;
  if (reviewTip.type !== 'STAGE_REVIEW_PASS' || reviewPayload.verdict !== 'ACCEPTED') {
    fail('BOUNDARY.SLICE_POLICY_INVALID', `${label} requires the current Stage Review tip to be ACCEPTED`);
  }
  if (typeof reviewPayload.stage_gate_receipt_digest !== 'string' || reviewPayload.stage_gate_receipt_digest !== gateTip.digest) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', `${label} Review tip does not bind the current Stage Gate tip`);
  }
  if (typeof reviewPayload.snapshot_digest !== 'string' || reviewPayload.snapshot_digest !== integratedHead) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', `${label} Review tip snapshot does not match the current integrated HEAD`);
  }
}

/**
 * stage-close machine preflight (strong, fail-closed): before any Git write,
 * revalidate that the Stage is genuinely closable:
 *  1. the Stage is NOT already archived (stage-close is write-once);
 *  2. the current Stage Gate tip is a GATE_PASS whose snapshot EXACTLY equals
 *     the current integrated Git HEAD;
 *  3. the current Stage Review tip is an ACCEPTED STAGE_REVIEW_PASS whose
 *     snapshot EXACTLY equals the current integrated Git HEAD and which binds
 *     the current Stage Gate tip digest;
 *  4. every Manifest-declared Slice Evidence is finalized (present, root-bound).
 * Uses only read-only Runtime validators; never writes a Receipt.
 */
function assertStageClosePreflight(root: string, stage: string): void {
  let status: ReturnType<typeof readVNextStageReviewStatus>;
  try {
    status = readVNextStageReviewStatus(root, stage);
  } catch (error) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', `stage-close preflight could not read the Stage Gate/Review status: ${errorText(error)}`);
  }
  if (status.archived === true) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', 'stage-close preflight refuses an already-archived Stage');
  }
  let integratedHead: string;
  try {
    integratedHead = readGitHead(resolveGitRoot(root));
  } catch (error) {
    fail('BOUNDARY.GIT_UNAVAILABLE', `stage-close preflight cannot resolve the integrated Git HEAD: ${errorText(error)}`);
  }

  const gateChain = readReceiptChain(root, stageGateReceiptDir(root, stage), 'stage-gate chain');
  const gateTip = gateChain.receipts.length > 0 ? gateChain.receipts[gateChain.receipts.length - 1] : null;
  const reviewChain = readReceiptChain(root, reviewReceiptDir(root, stage), 'stage review chain');
  const reviewTip = reviewChain.receipts.length > 0 ? reviewChain.receipts[reviewChain.receipts.length - 1] : null;
  assertStageCloseTipBindings(gateTip, reviewTip, integratedHead, 'stage-close');

  // Every Manifest-declared Slice Evidence must be finalized: present, root-bound
  // (no-follow open) AND structured (non-skeleton) via the canonical
  // isSliceEvidenceFinalized content check. A skeleton/placeholder Evidence is
  // rejected, exactly matching the "all Manifest-declared Slice Evidence
  // finalized" stage-close precondition.
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${stage}.json`);
  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    fail('BOUNDARY.SLICE_POLICY_INVALID', `stage-close preflight could not read the persisted vNext Manifest: ${errorText(error)}`);
  }
  for (const slice of manifest.slices) {
    const opened = openNoFollowRead(root, path.resolve(root, slice.evidence_path));
    if (!opened.ok) {
      fail(
        'BOUNDARY.SLICE_POLICY_INVALID',
        `stage-close requires Manifest Slice Evidence finalized: ${slice.evidence_path} is missing or not a root-bound file`,
      );
    }
    let content: string;
    try {
      content = fs.readFileSync(opened.fd, 'utf8');
    } finally {
      fs.closeSync(opened.fd);
    }
    if (!isSliceEvidenceFinalized(content)) {
      fail(
        'BOUNDARY.SLICE_POLICY_INVALID',
        `stage-close requires Manifest Slice Evidence finalized (skeleton/placeholder Evidence): ${slice.evidence_path}`,
      );
    }
  }
}

/**
 * Derive this boundary's TOLERATED scope WITHOUT inspecting the dirty set or
 * the selected commit paths. This is the set of paths that may legitimately be
 * dirty/untracked before any Git write:
 *  - exact-path types: the declared `paths` (the commit scope);
 *  - prefix types: the fixed contract prefix scope;
 *  - slice-output: the current Slice committable paths PLUS the other-Slice
 *    declared dirty files (dirty-eligible but never committable — P0 isolation).
 */
function toleratedBoundaryScope(
  request: BoundaryCloseRequest,
  root: string,
  slicePolicy: SliceCommitPolicy | undefined,
): readonly string[] {
  if (request.boundary_type === 'slice-output') {
    return [...(slicePolicy?.allowedPaths ?? []), ...(slicePolicy?.otherSliceDeclaredFiles ?? [])];
  }
  if (EXACT_PATH_TYPES.has(request.boundary_type)) {
    const declared = requirePaths(request, root);
    assertExactTypeScope(request, declared);
    return declared;
  }
  return prefixScope(request);
}

/**
 * Strict dirty gate (blueprint): runs BEFORE any Git write AND before
 * requestedPaths() so that an outside-only dirty worktree returns
 * BOUNDARY.SCOPE_VIOLATION (never mis-reported as NO_CHANGES). Every actual
 * dirty/untracked path must be inside this boundary's tolerated scope; on
 * failure HEAD and the index are left unchanged.
 */
function assertStrictBoundaryScope(
  request: BoundaryCloseRequest,
  root: string,
  actual: readonly string[],
  slicePolicy: SliceCommitPolicy | undefined,
): void {
  const tolerated = toleratedBoundaryScope(request, root, slicePolicy);
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
    // expected_head is REQUIRED for slice-output: the current HEAD must be
    // pinned so that a HEAD mismatch fails before any Git write.
    if (
      request.stage === undefined ||
      request.slice === undefined ||
      cvReceiptDigest === undefined ||
      expectedHead === undefined
    ) {
      fail(
        'BOUNDARY.REQUEST_INVALID',
        'slice-output requires stage, slice, cv_receipt_digest, and expected_head',
      );
    }
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
  let slicePolicy: SliceCommitPolicy | undefined;
  if (request.boundary_type === 'slice-output') {
    try {
      const facts = loadVNextSliceCommitPolicyFacts(
        {
          stageId: request.stage as string,
          sliceId: request.slice as string,
          cvReceiptDigest: cvReceiptDigest as string,
        },
        { projectRoot: gitRoot },
      );
      slicePolicy = loadSliceCommitPolicy(facts);
      validateSliceCommitCvBinding(slicePolicy, cvReceiptDigest as string);
      if (request.manifest_digest !== undefined && request.manifest_digest !== slicePolicy.manifestDigest) {
        fail(
          'BOUNDARY.SCOPE_VIOLATION',
          `manifest_digest does not match the active vNext Manifest: ${request.manifest_digest} != ${slicePolicy.manifestDigest}`,
        );
      }
    } catch (error) {
      if (error instanceof GitBoundaryError) throw error;
      fail('BOUNDARY.SLICE_POLICY_INVALID', `vNext Slice Commit policy is unavailable: ${errorText(error)}`);
    }
  }

  // Boundary-specific machine preflight (read-only; runs before any Git write).
  if (request.boundary_type === 'stage-plan') {
    assertStagePlanManifestPreflight(gitRoot, request.stage as string, request.manifest_digest);
  } else if (request.boundary_type === 'stage-close') {
    assertStageClosePreflight(gitRoot, request.stage as string);
  }

  // Strict dirty gate FIRST (before any Git write and before requestedPaths):
  // every dirty/untracked path must be inside this boundary's tolerated scope,
  // so an outside-only dirty worktree returns SCOPE_VIOLATION (never
  // NO_CHANGES) and HEAD and the index are left unchanged on failure.
  assertStrictBoundaryScope(request, gitRoot, actual, slicePolicy);

  const requested = requestedPaths(request, gitRoot, actual, slicePolicy);

  if (slicePolicy !== undefined) {
    try {
      validateSliceCommitChangedFiles(slicePolicy, requested, {
        treePaths: readTreePaths(gitRoot, preCommitHead),
        phase: 'pre-commit',
      });
    } catch (error) {
      if (error instanceof GitBoundaryError) throw error;
      fail('BOUNDARY.SLICE_POLICY_INVALID', `slice-output changed-file policy rejected the boundary: ${errorText(error)}`);
    }
  }
  let pureArchiveRename = false;
  if (request.boundary_type === 'artifact-archive') {
    // Artifact-archive responsibility: Brain pre-executes the exact `git mv`
    // and leaves the rename staged. This adapter NEVER runs `git mv`; it only
    // validates the already-staged exact pure rename and commits it. All
    // source/destination, same-stage, HEAD tracked/absent, digest-qualified
    // destination and blob/mode checks complete against the CURRENT status
    // before commit; a validation failure must not change worktree or index.
    assertArtifactArchiveRename(gitRoot, request, before, requested, oldManifestDigest as string, preCommitHead);
    pureArchiveRename = true;
  }
  const message = commitMessage(request, oldManifestDigest);

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
  if (slicePolicy !== undefined) {
    try {
      validateSliceCommitCvBinding(slicePolicy, cvReceiptDigest as string);
      validateSliceCommitChangedFiles(slicePolicy, committed, {
        treePaths: readTreePaths(gitRoot, commitSha),
        phase: 'post-commit',
      });
    } catch (error) {
      if (error instanceof GitBoundaryError) throw error;
      fail('BOUNDARY.POST_COMMIT_INVALID', `slice-output post-commit policy validation failed: ${errorText(error)}`);
    }
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
