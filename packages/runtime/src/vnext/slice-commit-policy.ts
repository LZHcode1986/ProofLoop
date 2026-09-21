/**
 * Neutral Work Packet path policy (shared slice-commit scope policy).
 *
 * The policy is deliberately independent from the Git transaction, from the
 * plan projection and from Receipt persistence.  It validates a changed-file
 * set against the Work Packet execution scope:
 *   - `allowedPaths`      — the current Slice committable scope only; never
 *                           includes another Slice's declared files;
 *   - `otherSliceDeclaredFiles` — files declared by OTHER Slices' persisted
 *                           Worker facts; dirty-eligible (tolerated in an
 *                           interleaved worktree) but NEVER committable by
 *                           the current Slice boundary;
 *   - `forbiddenPaths`    — system-protected paths and any other policy-level
 *                           forbidden roots;
 *   - `workerChangedFiles` — every file the Worker declared as changed must
 *                           appear in the committed changed-file set;
 *   - `hasRepairHistory`  — REPAIR permits repair-only files, but still
 *                           requires every Worker fact file in the boundary.
 *
 * No root/stage/slice identity, Manifest/Plan/snapshot digest or CV Receipt
 * binding remains: those were retired with the business-collector consumers.
 *
 * Malformed facts fail closed at load time with the mechanical
 * `RUNTIME.SCHEMA_MISMATCH` code: every list must be a duplicate-free array of
 * canonical root-relative strings, committable/tolerated scopes must be
 * disjoint, protected/forbidden roots are unreachable, and every Worker fact
 * must stay inside the admitted committable scope. No entry is ever silently
 * deduplicated.
 */

const CONTROLLED_PATH_RE = /^[^\u0000-\u001f\u007f\\]+$/;

export interface SliceCommitPolicyFacts {
  /**
   * Current Slice committable scope only — never includes another Slice's
   * declared files. A parallel Slice's dirty output is tolerated in the
   * worktree but MUST NOT be staged or committed by this Slice boundary (see
   * otherSliceDeclaredFiles).
   */
  readonly allowedPaths: readonly string[];

  /**
   * Files declared by OTHER Slices' persisted Worker facts. These are
   * dirty-eligible (tolerated in an interleaved worktree) but NEVER committable by
   * the current Slice boundary; they remain outside the staging scope.
   */
  readonly otherSliceDeclaredFiles: readonly string[];

  /** System-protected paths and any other policy-level forbidden paths. */
  readonly forbiddenPaths: readonly string[];

  /** Files declared by the persisted Worker completion facts. */
  readonly workerChangedFiles: readonly string[];

  /** REPAIR permits repair-only files, but still requires every Worker fact file. */
  readonly hasRepairHistory: boolean;
}

export interface SliceCommitPolicy {
  readonly allowedPaths: readonly string[];
  /** Dirty-eligible but never committable: other Slices' declared worker outputs. */
  readonly otherSliceDeclaredFiles: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly workerChangedFiles: readonly string[];
  readonly hasRepairHistory: boolean;
}

export interface SliceCommitChangedFilesOptions {
  /** Files present in the committed tree; used for persisted prior outputs. */
  readonly treePaths?: readonly string[];
  readonly phase?: 'pre-commit' | 'post-commit';
}

export class SliceCommitPolicyError extends Error {
  readonly code: 'RUNTIME.SCHEMA_MISMATCH';

  constructor(code: SliceCommitPolicyError['code'], message: string) {
    super(message);
    this.name = 'SliceCommitPolicyError';
    this.code = code;
  }
}

function fail(code: SliceCommitPolicyError['code'], message: string): never {
  throw new SliceCommitPolicyError(code, message);
}

function requireList(values: unknown, label: string): asserts values is readonly string[] {
  if (!Array.isArray(values)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be an array of canonical root-relative strings`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `${label} contains a duplicate entry: ${value}`);
    }
    seen.add(value);
  }
}

const PROTECTED_ROOTS: readonly string[] = ['.git', '.proofloop'];

function assertNoProtectedRoot(values: readonly string[], label: string): void {
  for (const value of values) {
    for (const root of PROTECTED_ROOTS) {
      if (pathWithin(value, root)) {
        fail('RUNTIME.SCHEMA_MISMATCH', `${label} must not equal or descend from a protected root ${root}: ${value}`);
      }
    }
  }
}

function assertDisjoint(values: readonly string[], bases: readonly string[], label: string, baseLabel: string): void {
  for (const value of values) {
    for (const base of bases) {
      if (pathWithin(value, base) || pathWithin(base, value)) {
        fail('RUNTIME.SCHEMA_MISMATCH', `${label} overlaps ${baseLabel} ${base}: ${value}`);
      }
    }
  }
}

function pathWithin(value: string, base: string): boolean {
  return value === base || value.startsWith(`${base.replace(/\/$/, '')}/`);
}

function canonicalPath(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.startsWith('//') ||
    !CONTROLLED_PATH_RE.test(value) ||
    value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a canonical root-relative path`);
  }
  return value;
}

/** Build one immutable policy from the supplied Work Packet path facts. */
export function loadSliceCommitPolicy(facts: SliceCommitPolicyFacts): SliceCommitPolicy {
  if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit policy facts must be an object of path facts');
  }
  requireList(facts.allowedPaths, 'Slice Commit allowedPaths');
  requireList(facts.otherSliceDeclaredFiles, 'Slice Commit otherSliceDeclaredFiles');
  requireList(facts.forbiddenPaths, 'Slice Commit forbiddenPaths');
  requireList(facts.workerChangedFiles, 'Slice Commit workerChangedFiles');
  if (typeof facts.hasRepairHistory !== 'boolean') {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit hasRepairHistory must be a boolean');
  }

  const allowedPaths = facts.allowedPaths.map((value, index) => canonicalPath(value, `Slice Commit allowed path[${index}]`));
  const otherSliceDeclaredFiles = facts.otherSliceDeclaredFiles.map((value, index) =>
    canonicalPath(value, `Slice Commit other-Slice declared file[${index}]`),
  );
  const forbiddenPaths = facts.forbiddenPaths.map((value, index) => canonicalPath(value, `Slice Commit forbidden path[${index}]`));
  const workerChangedFiles = facts.workerChangedFiles.map((value, index) =>
    canonicalPath(value, `Slice Commit Worker file[${index}]`),
  );

  // Every list must be duplicate-free: duplicates are malformed facts and are
  // rejected, never silently deduplicated.
  assertUnique(allowedPaths, 'Slice Commit allowedPaths');
  assertUnique(otherSliceDeclaredFiles, 'Slice Commit otherSliceDeclaredFiles');
  assertUnique(forbiddenPaths, 'Slice Commit forbiddenPaths');
  assertUnique(workerChangedFiles, 'Slice Commit workerChangedFiles');

  if (allowedPaths.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit policy must contain a non-empty allowed scope');
  }

  // The committable and tolerated scopes are mechanically disjoint in both
  // prefix directions: one Slice can never claim or mask another Slice's paths.
  for (const allowed of allowedPaths) {
    for (const other of otherSliceDeclaredFiles) {
      if (pathWithin(allowed, other) || pathWithin(other, allowed)) {
        fail('RUNTIME.SCHEMA_MISMATCH', `Slice Commit allowedPaths and otherSliceDeclaredFiles overlap: ${allowed} / ${other}`);
      }
    }
  }

  assertNoProtectedRoot(allowedPaths, 'Slice Commit allowedPaths');
  assertNoProtectedRoot(otherSliceDeclaredFiles, 'Slice Commit otherSliceDeclaredFiles');
  assertNoProtectedRoot(workerChangedFiles, 'Slice Commit workerChangedFiles');

  assertDisjoint(allowedPaths, forbiddenPaths, 'Slice Commit allowedPaths', 'a forbidden path');
  assertDisjoint(otherSliceDeclaredFiles, forbiddenPaths, 'Slice Commit otherSliceDeclaredFiles', 'a forbidden path');
  assertDisjoint(workerChangedFiles, forbiddenPaths, 'Slice Commit workerChangedFiles', 'a forbidden path');

  // Every persisted Worker fact must lie inside the admitted committable scope.
  for (const workerFile of workerChangedFiles) {
    if (!allowedPaths.some((allowed) => pathWithin(workerFile, allowed))) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Slice Commit Worker file expands beyond the admitted execution scope: ${workerFile}`);
    }
  }

  return {
    allowedPaths,
    otherSliceDeclaredFiles,
    forbiddenPaths,
    workerChangedFiles,
    hasRepairHistory: facts.hasRepairHistory,
  };
}

/**
 * Validate a real changed-file set against the loaded Work Packet policy.
 *
 * `treePaths` lets a multi-Slice chain retain the existing rule that a Worker
 * declaration is satisfied when the file was already present in the current
 * committed tree.  A REPAIR history remains stricter: all Worker-declared
 * files must occur in the new boundary because repair-only files may be new.
 */
export function validateSliceCommitChangedFiles(
  policy: SliceCommitPolicy,
  changedFiles: readonly string[],
  options: SliceCommitChangedFilesOptions = {},
): string[] {
  const changed = changedFiles.map((value, index) => canonicalPath(value, `Slice Commit changed path[${index}]`)).sort();
  assertUnique(changed, 'Slice Commit changed files');
  if (changed.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit requires a non-empty changed-file boundary');
  }

  for (const value of changed) {
    if (
      value === '.git' ||
      value.startsWith('.git/') ||
      value === '.proofloop' ||
      value.startsWith('.proofloop/')
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Slice Commit changed files contain a protected path: ${value}`);
    }
    if (policy.forbiddenPaths.some((base) => pathWithin(value, base) || pathWithin(base, value))) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Slice Commit changed files contain a forbidden path: ${value}`);
    }
    if (!policy.allowedPaths.some((base) => pathWithin(value, base))) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Slice Commit changed files expand beyond the admitted execution scope: ${value}`);
    }
  }

  const tree = new Set(
    (options.treePaths ?? []).map((value, index) => canonicalPath(value, `Slice Commit tree path[${index}]`)),
  );
  const missingWorkerFiles = policy.workerChangedFiles.filter(
    (value) => !changed.includes(value) && !(tree.has(value) && !policy.hasRepairHistory),
  );
  if (missingWorkerFiles.length > 0) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `committed changed-file set does not contain every persisted Worker fact (missing=${missingWorkerFiles.join(', ')} actual=${changed.join(', ')})`,
    );
  }
  return changed;
}