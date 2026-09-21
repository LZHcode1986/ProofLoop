/**
 * Deterministic Git Integration transaction for the public `proofloop
 * integration apply` command (.agents/contracts/brain/integration.md is the
 * semantic source for the closed request schema, the mechanical validation
 * order and the canonical commit message).
 *
 * Integration is the dedicated mechanical transaction that applies a CV
 * `PASS` + durable candidate ref (a Slice candidate commit) into the current
 * Stage worktree. It is deliberately NOT a `boundary close` boundary type and
 * shares no business semantics with it. Brain owns the ready/recovery
 * judgment; this module owns only deterministic Git facts and writes.
 *
 * Transaction order (contract §机械校验与事务顺序):
 *  1. prechecks: canonical root, expected branch, HEAD == expected_head,
 *     empty index, clean worktree (zero-write); under MES_MAINTENANCE the
 *     shared physical quarantine predicate (`verifyMaintenanceQuarantine`
 *     on `.proofloop/mes`, mode 0555) is checked BEFORE any Git write — a
 *     writable `.proofloop/mes` is a typed INTEGRATION.QUARANTINE_VIOLATED
 *     zero-write failure (refs/digests/count exactness alone is not enough);
 *  2. candidate shape: candidate_ref/base_ref resolve to commits, base is an
 *     ancestor of candidate (patch well-formed);
 *  3. base relationship (stale-base allowed): base must be an ancestor of the
 *     current Stage HEAD; fast-forward is NOT required;
 *  4. scope & protected paths: the candidate patch changed-path set must
 *     equal the declared `paths` exactly (no widening, no omission); every
 *     path root-bound, duplicate-free, and outside the .git / .proofloop trees;
 *  5. diff check: `git diff --check` on the candidate patch;
 *  6. conflict precheck: a three-way application of the candidate patch onto
 *     the current HEAD tree must be conflict-free (`git merge-tree
 *     --write-tree --merge-base=<base> <HEAD> <candidate>`); any genuine
 *     conflict fails with INTEGRATION.CONFLICT before any HEAD/index/worktree
 *     write;
 *  7. apply & commit: deterministic single staged apply (`git apply --3way
 *     --index`), re-verify the staged set equals the declared paths and
 *     `diff --check` passes, then commit with the canonical message
 *     `integration: <stage-id>-<slice-id>`;
 *  8. post-commit verification: HEAD/branch/index/worktree/changed-files/
 *     diff --check, and the candidate ref is never deleted.
 *
 * On commit/hook failure the factual partial staged state is preserved
 * exactly as the Contract specifies: no implicit reset/unstage. On
 * INTEGRATION.CONFLICT no Git write has happened and HEAD/index/worktree
 * equal the pre-call state.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalPathWithinRoot } from './path-guard';
import { readGitHead, resolveGitRoot } from './git-source';
import { MaintenanceSeamError, readBranchIdentity, rootRelativeWorktreeIdentity, verifyMaintenanceBindingTuple, verifyMaintenanceQuarantine } from './mes/maintenance-seam';
export interface IntegrationRequest {
  readonly expected_head: string;
  readonly expected_branch: string;
  readonly stage: string;
  readonly slice: string;
  readonly candidate_ref: string;
  readonly candidate_base_ref: string;
  readonly paths: readonly string[];
  /**
   * Integration Contract (D.1): NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE.
   * Defaults to NORMAL for direct seam callers; the public CLI enforces the
   * closed required schema.
   */
  readonly execution_mode?: 'NORMAL' | 'PRE_MES_BOOTSTRAP' | 'MES_MAINTENANCE';
  /** Root-relative mode-specific target worktree ('.' for NORMAL). */
  readonly expected_worktree?: string;
  /**
   * MES_MAINTENANCE only: the exact frozen/forensic/audit tuple. Its
   * refs+digests+count closure is machine-verified via the maintenance
   * entry seam (single fact source) before any Git write.
   */
  readonly maintenance_binding?: unknown;
}

export interface IntegrationResult {
  /** Integration Contract (D.1) handoff: the executed mode + target. */
  readonly execution_mode: 'NORMAL' | 'PRE_MES_BOOTSTRAP' | 'MES_MAINTENANCE';
  readonly expected_worktree: string;
  readonly pre_integration_head: string;
  readonly commit_sha: string;
  readonly commit_message: string;
  readonly changed_files: readonly string[];
  readonly candidate_ref: string;
  readonly candidate_base_ref: string;
  readonly dirty_after: readonly string[];
}

export type IntegrationErrorCode =
  | 'INTEGRATION.REQUEST_INVALID'
  | 'INTEGRATION.GIT_UNAVAILABLE'
  | 'INTEGRATION.HEAD_MISMATCH'
  | 'INTEGRATION.BRANCH_MISMATCH'
  | 'INTEGRATION.INDEX_NOT_EMPTY'
  | 'INTEGRATION.DIRTY_WORKTREE'
  | 'INTEGRATION.CANDIDATE_REF_INVALID'
  | 'INTEGRATION.CANDIDATE_BASE_INVALID'
  | 'INTEGRATION.BASE_NOT_ANCESTOR'
  | 'INTEGRATION.SCOPE_VIOLATION'
  | 'INTEGRATION.DIFF_INVALID'
  | 'INTEGRATION.CONFLICT'
  | 'INTEGRATION.QUARANTINE_VIOLATED'
  | 'INTEGRATION.COMMIT_FAILED'
  | 'INTEGRATION.POST_COMMIT_INVALID';

export class IntegrationError extends Error {
  public readonly code: IntegrationErrorCode;

  constructor(code: IntegrationErrorCode, message: string) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
  }
}

interface StatusEntry {
  readonly index: string;
  readonly worktree: string;
  readonly paths: readonly string[];
}

const STAGE_RE = /^S\d+$/;
const SLICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA_RE = /^[a-f0-9]{40}$/;
/**
 * Protected worktree identities that the MES_MAINTENANCE Integration must
 * NEVER write to: the main worktree ('.') and the frozen S06-C / S06-D stage
 * worktrees stay zero-write during the S06 hard-freeze (recovery-plan-r3 §Stage/
 * Slice 共享默认 / MES_MAINTENANCE execution binding).
 */
const MAINTENANCE_PROTECTED_WORKTREES = new Set([
  '.',
  '.proofloop/worktrees/S06-S06-C',
  '.proofloop/worktrees/S06-S06-D',
]);
function fail(code: IntegrationErrorCode, message: string): never {
  throw new IntegrationError(code, message);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runGit(root: string, args: readonly string[], code: IntegrationErrorCode): string {
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

/** Run git feeding `input` on stdin (used for the deterministic staged apply). */
function runGitInput(root: string, args: readonly string[], input: string, code: IntegrationErrorCode): string {
  try {
    return execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    fail(code, `git ${args.join(' ')} failed: ${errorText(error)}`);
  }
}

/** Return the git subprocess exit code (0 on success, 1 on failure). */
function gitExit(root: string, args: readonly string[]): number {
  try {
    execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return typeof status === 'number' ? status : 1;
  }
}

function isProtectedPath(relative: string): boolean {
  return (
    relative === '.git' ||
    relative.startsWith('.git/') ||
    relative === '.proofloop' ||
    relative.startsWith('.proofloop/')
  );
}

function relativePath(root: string, value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) {
    fail('INTEGRATION.REQUEST_INVALID', `${label} must be a non-empty root-relative path`);
  }
  const canonical = canonicalPathWithinRoot(root, value);
  if (canonical === null) {
    fail('INTEGRATION.SCOPE_VIOLATION', `${label} escapes the project root: ${value}`);
  }
  const relative = path.relative(root, canonical).split(path.sep).join('/');
  if (relative.length === 0 || relative === '..' || relative.startsWith('../')) {
    fail('INTEGRATION.SCOPE_VIOLATION', `${label} escapes the project root: ${value}`);
  }
  if (isProtectedPath(relative)) {
    fail('INTEGRATION.SCOPE_VIOLATION', `${label} targets a protected path: ${relative}`);
  }
  return relative;
}

function parseStatus(output: string): StatusEntry[] {
  if (output.length === 0) return [];
  const tokens = output.split('\u0000');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length === 0) continue;
    if (token.length < 4 || token[2] !== ' ') {
      fail('INTEGRATION.GIT_UNAVAILABLE', `unexpected porcelain status record: ${JSON.stringify(token)}`);
    }
    const status = token.slice(0, 2);
    const firstPath = token.slice(3);
    const paths: string[] = [firstPath];
    if (status.includes('R') || status.includes('C')) {
      const secondPath = tokens[index + 1];
      if (secondPath === undefined || secondPath.length === 0) {
        fail('INTEGRATION.GIT_UNAVAILABLE', `rename/copy status record has no destination: ${JSON.stringify(token)}`);
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

function requirePaths(root: string, paths: readonly string[] | undefined): string[] {
  if (paths === undefined || paths.length === 0) {
    fail('INTEGRATION.REQUEST_INVALID', 'integration requires a non-empty paths array');
  }
  const values = paths.map((value, index) => relativePath(root, value, `paths[${index}]`));
  if (new Set(values).size !== values.length) {
    fail('INTEGRATION.REQUEST_INVALID', 'paths contains duplicate entries');
  }
  return values.sort();
}

function assertBranch(root: string, expected: string): void {
  const current = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'INTEGRATION.GIT_UNAVAILABLE').trim();
  if (current !== expected) {
    fail('INTEGRATION.BRANCH_MISMATCH', `expected branch "${expected}", current branch is "${current}"`);
  }
}

/** Resolve a ref to exactly one commit (`<ref>^{commit}`); zero-write. */
function resolveCommit(root: string, ref: string, code: IntegrationErrorCode): string {
  const sha = runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], code)
    .trim();
  if (sha.length === 0 || !SHA_RE.test(sha)) {
    fail(code, `cannot resolve "${ref}" to exactly one commit`);
  }
  return sha;
}

/** True when `ancestor` is an ancestor of `commit` (or equal). */
function isAncestor(root: string, ancestor: string, commit: string): boolean {
  return gitExit(root, ['merge-base', '--is-ancestor', ancestor, commit]) === 0;
}

/** Exact changed-path set of the candidate patch (`base..candidate`), --no-renames deterministic. */
function patchChangedPaths(root: string, base: string, candidate: string): string[] {
  const output = runGit(
    root,
    ['diff-tree', '-r', '--name-only', '--no-renames', '--no-commit-id', '-z', base, candidate],
    'INTEGRATION.GIT_UNAVAILABLE',
  );
  return output.split('\u0000').filter((entry) => entry.length > 0);
}

function stagedPaths(root: string): string[] {
  const output = runGit(
    root,
    ['diff', '--cached', '--name-only', '-z', '--no-renames', '--'],
    'INTEGRATION.GIT_UNAVAILABLE',
  );
  return output.split('\u0000').filter((entry) => entry.length > 0);
}

function committedPaths(root: string, commitSha: string): string[] {
  const output = runGit(
    root,
    ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', commitSha, '--'],
    'INTEGRATION.POST_COMMIT_INVALID',
  );
  return output.split('\u0000').filter((entry) => entry.length > 0);
}

function assertExactSet(actual: readonly string[], expected: readonly string[], code: IntegrationErrorCode, what: string): void {
  const wanted = [...new Set(expected)].sort();
  const got = [...new Set(actual)].sort();
  if (wanted.length !== got.length || wanted.some((value, index) => value !== got[index])) {
    fail(code, `${what} set mismatch (expected=${wanted.join(',')} actual=${got.join(',')})`);
  }
}

/**
 * Apply one deterministic Integration transaction. The caller (Brain/Host)
 * owns the ready judgment (CV `PASS` + durable candidate ref); this function
 * owns only the mechanical Git transaction and returns the structured Git
 * facts. It never deletes the candidate ref.
 */
export function applyIntegration(root: string, request: IntegrationRequest): IntegrationResult {
  // ---- Closed static request validation (no Git access, fail fast) ----
  if (!STAGE_RE.test(request.stage)) {
    fail('INTEGRATION.REQUEST_INVALID', `stage must match /^S\\d+$/, received "${request.stage}"`);
  }
  if (!SLICE_RE.test(request.slice)) {
    fail('INTEGRATION.REQUEST_INVALID', `slice must be a canonical identifier, received "${request.slice}"`);
  }
  if (!SHA_RE.test(request.expected_head)) {
    fail('INTEGRATION.REQUEST_INVALID', 'expected_head must be a full lowercase Git SHA');
  }
  if (request.expected_branch === undefined || request.expected_branch.length === 0) {
    fail('INTEGRATION.REQUEST_INVALID', 'expected_branch must be a non-empty branch name');
  }
  if (request.candidate_ref === undefined || request.candidate_ref.length === 0) {
    fail('INTEGRATION.REQUEST_INVALID', 'candidate_ref must be a non-empty Git ref');
  }
  if (request.candidate_base_ref === undefined || request.candidate_base_ref.length === 0) {
    fail('INTEGRATION.REQUEST_INVALID', 'candidate_base_ref must be a non-empty Git ref');
  }
  const declared = requirePaths(root, request.paths);

  // ---- 1. Mode / target resolution + canonical Git facts / prechecks
  //         (zero-write; any failure before the staged apply leaves
  //         HEAD/index/worktree byte-identical) ----
  const mode = request.execution_mode ?? 'NORMAL';
  if (mode !== 'NORMAL' && mode !== 'PRE_MES_BOOTSTRAP' && mode !== 'MES_MAINTENANCE') {
    fail('INTEGRATION.REQUEST_INVALID', `execution_mode must be one of NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE, received ${JSON.stringify(mode)}`);
  }
  const expectedWorktree = request.expected_worktree ?? '.';
  // maintenance_binding is MES_MAINTENANCE-only: present under NORMAL or
  // PRE_MES_BOOTSTRAP is a closed-schema violation (zero-write).
  if (mode !== 'MES_MAINTENANCE' && request.maintenance_binding !== undefined) {
    fail('INTEGRATION.REQUEST_INVALID', 'maintenance_binding is only valid under execution_mode MES_MAINTENANCE');
  }
  if (mode === 'NORMAL') {
    if (expectedWorktree !== '.') {
      fail('INTEGRATION.REQUEST_INVALID', 'NORMAL integration targets the current Stage worktree — expected_worktree must be "."');
    }
  } else {
    if (expectedWorktree === '.') {
      fail('INTEGRATION.REQUEST_INVALID', `${mode} integration must target an isolated evidence worktree — expected_worktree must not be "."`);
    }
    if (mode === 'MES_MAINTENANCE') {
      if (request.maintenance_binding === undefined) {
        fail('INTEGRATION.REQUEST_INVALID', 'MES_MAINTENANCE integration requires a maintenance_binding (frozen/forensic/audit exact tuple)');
      }
      try {
        verifyMaintenanceBindingTuple(root, request.maintenance_binding);
      } catch (error) {
        if (error instanceof MaintenanceSeamError) {
          fail('INTEGRATION.REQUEST_INVALID', `maintenance_binding is not exact (${error.code}): ${error.reason}`);
        }
        throw error;
      }
      // Physical quarantine is the shared predicate (maintenance-seam.ts):
      // the MES_MAINTENANCE Integration must fail BEFORE any candidate
      // apply/stage/commit when `.proofloop/mes` is writable (e.g. mode
      // 0755) — refs/digests/count exactness alone is not enough.
      try {
        verifyMaintenanceQuarantine(root);
      } catch (error) {
        if (error instanceof MaintenanceSeamError) {
          fail('INTEGRATION.QUARANTINE_VIOLATED', `maintenance physical quarantine is not in place (${error.code}): ${error.reason} — no Git write`);
        }
        throw error;
      }
    }
  }

  const gitRoot = (() => {
    try {
      return resolveGitRoot(root);
    } catch (error) {
      fail('INTEGRATION.GIT_UNAVAILABLE', `canonical Git project root is unavailable: ${errorText(error)}`);
    }
  })();
  // The transaction runs IN the mode-specific target worktree (its own
  // HEAD/index/worktree): NORMAL = the current Stage worktree (== git root);
  // PRE_MES_BOOTSTRAP / MES_MAINTENANCE = the root-bound isolated evidence
  // worktree. The candidate refs live in the same repository (shared object
  // store), so ref resolution / ancestry / patch diff are worktree-agnostic.
  let target = gitRoot;
  if (mode !== 'NORMAL') {
    const resolvedTarget = canonicalPathWithinRoot(root, expectedWorktree);
    if (resolvedTarget === null) {
      fail('INTEGRATION.SCOPE_VIOLATION', `expected_worktree escapes the project root: ${expectedWorktree}`);
    }
    try {
      target = resolveGitRoot(resolvedTarget);
    } catch (error) {
      fail('INTEGRATION.GIT_UNAVAILABLE', `expected_worktree is not a git worktree: ${errorText(error)}`);
    }
  }

  // MES_MAINTENANCE Integration may only target the maintenance lane's
  // isolated evidence worktree: the protected main / S06-C / S06-D worktrees
  // are rejected HERE — before any Git write — while the expected_branch
  // exact check below and the NORMAL behavior stay unchanged.
  if (mode === 'MES_MAINTENANCE') {
    let targetIdentity: string;
    try {
      targetIdentity = rootRelativeWorktreeIdentity(target, target);
    } catch (error) {
      fail('INTEGRATION.GIT_UNAVAILABLE', `cannot resolve the target worktree identity: ${errorText(error)}`);
    }
    if (MAINTENANCE_PROTECTED_WORKTREES.has(targetIdentity)) {
      fail(
        'INTEGRATION.SCOPE_VIOLATION',
        `maintenance integration must not target the protected worktree "${targetIdentity}" (main / S06-C / S06-D are zero-write during the S06 hard-freeze → no Git write)`,
      );
    }
  }

  const preIntegrationHead = (() => {
    try {
      return readGitHead(target);
    } catch (error) {
      fail('INTEGRATION.GIT_UNAVAILABLE', `current Git HEAD is unavailable: ${errorText(error)}`);
    }
  })();
  if (mode === 'NORMAL') {
    assertBranch(target, request.expected_branch);
  } else {
    // Evidence worktrees are detached: the actual branch identity of a
    // detached HEAD is the literal `HEAD`. The EXACT expected branch
    // identity is checked BEFORE any Git write — a NOT-HEAD
    // expected_branch on a detached target (or a branch target when
    // expected_branch is HEAD) is a typed zero-write mismatch.
    const actualBranch = readBranchIdentity(target);
    if (actualBranch !== request.expected_branch) {
      fail('INTEGRATION.BRANCH_MISMATCH', `expected branch identity "${request.expected_branch}", current identity is "${actualBranch}"`);
    }
  }
  if (request.expected_head !== preIntegrationHead) {
    fail(
      'INTEGRATION.HEAD_MISMATCH',
      `expected_head "${request.expected_head}" does not match current HEAD "${preIntegrationHead}"`,
    );
  }
  // Integration targets the mode-specific worktree with NO other-Slice
  // tolerance scope: the index must be empty and the worktree fully clean.
  const before = parseStatus(
    runGit(target, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'INTEGRATION.GIT_UNAVAILABLE'),
  );
  if (hasStagedIndex(before)) {
    fail('INTEGRATION.INDEX_NOT_EMPTY', 'integration requires an initially empty Git index');
  }
  if (before.length > 0) {
    const dirty = statusPaths(before).map((value, index) =>
      relativePath(gitRoot, value, `Git changed path[${index}]`),
    );
    fail('INTEGRATION.DIRTY_WORKTREE', `integration requires a clean worktree; dirty path(s): ${dirty.join(', ')}`);
  }

  // ---- 2. Candidate shape (zero-write) ----
  const candidateSha = resolveCommit(target, request.candidate_ref, 'INTEGRATION.CANDIDATE_REF_INVALID');
  const candidateBaseSha = resolveCommit(target, request.candidate_base_ref, 'INTEGRATION.CANDIDATE_BASE_INVALID');
  if (!isAncestor(target, candidateBaseSha, candidateSha)) {
    fail(
      'INTEGRATION.CANDIDATE_BASE_INVALID',
      `candidate_base_ref "${request.candidate_base_ref}" is not an ancestor of candidate_ref "${request.candidate_ref}"`,
    );
  }

  // ---- 3. Base relationship (stale-base allowed, zero-write) ----
  if (!isAncestor(target, candidateBaseSha, preIntegrationHead)) {
    fail(
      'INTEGRATION.BASE_NOT_ANCESTOR',
      `candidate_base_ref "${request.candidate_base_ref}" is not an ancestor of the current Stage HEAD`,
    );
  }

  // ---- 4. Scope & protected paths (zero-write) ----
  const patchPaths = patchChangedPaths(target, candidateBaseSha, candidateSha);
  if (patchPaths.length === 0) {
    fail('INTEGRATION.SCOPE_VIOLATION', 'candidate patch has no changed paths');
  }
  const patchCanonical = patchPaths.map((value, index) =>
    relativePath(gitRoot, value, `candidate changed path[${index}]`),
  );
  assertExactSet(patchCanonical, declared, 'INTEGRATION.SCOPE_VIOLATION', 'candidate changed-path/declared-path');

  // ---- 5. diff check on the candidate patch (zero-write) ----
  runGit(target, ['diff', '--check', candidateBaseSha, candidateSha], 'INTEGRATION.DIFF_INVALID');

  // ---- 6. Conflict precheck: three-way application onto the current HEAD
  // tree. `git merge-tree --write-tree` computes the merge (exit 1 on
  // genuine conflict) WITHOUT touching HEAD/index/worktree; the current
  // Stage worktree stays byte-identical on failure. ----
  if (gitExit(target, ['merge-tree', '--quiet', '--write-tree', '--merge-base', candidateBaseSha, preIntegrationHead, candidateSha]) !== 0) {
    fail(
      'INTEGRATION.CONFLICT',
      'candidate patch conflicts with the current Stage HEAD (three-way precheck failed); no Git write was performed',
    );
  }

  // ---- 7. Deterministic single staged apply + commit ----
  const patch = runGit(
    target,
    ['diff', '--full-index', '--binary', '--no-renames', candidateBaseSha, candidateSha],
    'INTEGRATION.GIT_UNAVAILABLE',
  );
  runGitInput(target, ['apply', '--3way', '--index'], patch, 'INTEGRATION.COMMIT_FAILED');
  // Re-verify the staged set equals the declared paths and diff --check
  // passes before the canonical integration commit. Failures here are
  // post-staging: the factual partial staged state is preserved, never reset.
  const staged = stagedPaths(target).map((value, index) =>
    relativePath(gitRoot, value, `staged path[${index}]`),
  );
  assertExactSet(staged, declared, 'INTEGRATION.COMMIT_FAILED', 'staged/declared-path');
  runGit(target, ['diff', '--cached', '--check', '--'], 'INTEGRATION.COMMIT_FAILED');
  const message = `integration: ${request.stage}-${request.slice}`;
  runGit(target, ['commit', '-m', message], 'INTEGRATION.COMMIT_FAILED');

  // ---- 8. Post-commit verification (keep written facts for Brain recheck) ----
  let commitSha: string;
  try {
    commitSha = readGitHead(target);
  } catch (error) {
    fail('INTEGRATION.POST_COMMIT_INVALID', `committed HEAD is unavailable: ${errorText(error)}`);
  }
  if (mode === 'NORMAL') {
    assertBranch(target, request.expected_branch);
  } else if (readBranchIdentity(target) !== request.expected_branch) {
    fail('INTEGRATION.POST_COMMIT_INVALID', 'post-commit branch identity drifted from the expected branch identity');
  }
  const committed = committedPaths(target, commitSha);
  if (committed.length === 0 || committed.some(isProtectedPath)) {
    fail('INTEGRATION.POST_COMMIT_INVALID', 'commit changed-file set is empty or contains a protected path');
  }
  assertExactSet(committed, declared, 'INTEGRATION.POST_COMMIT_INVALID', 'committed changed-file/declared-path');
  const after = parseStatus(
    runGit(target, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'INTEGRATION.POST_COMMIT_INVALID'),
  );
  if (hasStagedIndex(after) || after.length > 0) {
    const dirty = statusPaths(after);
    fail('INTEGRATION.POST_COMMIT_INVALID', `integration did not produce a clean post-state; dirty path(s): ${dirty.join(', ')}`);
  }
  runGit(target, ['diff', '--check', '--'], 'INTEGRATION.POST_COMMIT_INVALID');
  // Candidate traceability: the transaction never deletes the candidate ref.
  resolveCommit(target, request.candidate_ref, 'INTEGRATION.POST_COMMIT_INVALID');
  resolveCommit(target, request.candidate_base_ref, 'INTEGRATION.POST_COMMIT_INVALID');

  return {
    execution_mode: mode,
    expected_worktree: expectedWorktree,
    pre_integration_head: preIntegrationHead,
    commit_sha: commitSha,
    commit_message: message,
    changed_files: committed,
    candidate_ref: request.candidate_ref,
    candidate_base_ref: request.candidate_base_ref,
    dirty_after: [],
  };
}
