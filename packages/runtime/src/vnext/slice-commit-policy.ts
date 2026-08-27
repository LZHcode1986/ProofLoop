/**
 * Shared vNext Slice Commit policy.
 *
 * The policy is deliberately independent from the Git transaction and from
 * Receipt persistence.  `commit-admission.ts` loads the current Runtime facts;
 * `git-boundary.ts` applies the resulting policy before creating a commit; the
 * admission consumer applies the same checks again to the committed boundary.
 */

const SHA256_RE = /^[a-f0-9]{64}$/;
const CONTROLLED_PATH_RE = /^[^\u0000-\u001f\u007f\\]+$/;

export interface SliceCommitPolicyFacts {
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly snapshotDigest: string;
  readonly cvReceiptDigest: string;
  /**
   * Current Slice committable scope only — never includes another Slice's
   * declared files. A parallel Slice's dirty output is tolerated in the
   * worktree but MUST NOT be staged or committed by this Slice boundary (see
   * otherSliceDeclaredFiles).
   */
  readonly allowedPaths: readonly string[];

  /**
   * Files declared by OTHER Manifest Slices' persisted Worker facts. These are
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
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly snapshotDigest: string;
  readonly cvReceiptDigest: string;
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
  readonly code: 'RUNTIME.SCHEMA_MISMATCH' | 'DOMAIN.INVALID_TRANSITION';

  constructor(code: SliceCommitPolicyError['code'], message: string) {
    super(message);
    this.name = 'SliceCommitPolicyError';
    this.code = code;
  }
}

function fail(code: SliceCommitPolicyError['code'], message: string): never {
  throw new SliceCommitPolicyError(code, message);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
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

function assertDigest(value: string, label: string): void {
  if (!SHA256_RE.test(value)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a lowercase SHA-256 digest`);
  }
}

/** Build one immutable policy from Runtime-loaded facts. */
export function loadSliceCommitPolicy(facts: SliceCommitPolicyFacts): SliceCommitPolicy {
  if (typeof facts.root !== 'string' || facts.root.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit policy root is required');
  }
  if (typeof facts.stageId !== 'string' || facts.stageId.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit policy stageId is required');
  }
  if (typeof facts.sliceId !== 'string' || facts.sliceId.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit policy sliceId is required');
  }
  assertDigest(facts.manifestDigest, 'Slice Commit policy manifestDigest');
  assertDigest(facts.planDigest, 'Slice Commit policy planDigest');
  if (!/^[a-f0-9]{40}$/.test(facts.snapshotDigest)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit policy snapshotDigest must be a Git commit SHA');
  }
  assertDigest(facts.cvReceiptDigest, 'Slice Commit policy cvReceiptDigest');

  const allowedPaths = unique(facts.allowedPaths.map((value, index) => canonicalPath(value, `Slice Commit allowed path[${index}]`)));
  const forbiddenPaths = unique(facts.forbiddenPaths.map((value, index) => canonicalPath(value, `Slice Commit forbidden path[${index}]`)));
  const workerChangedFiles = unique(
    facts.workerChangedFiles.map((value, index) => canonicalPath(value, `Slice Commit Worker file[${index}]`)),
  );
  const otherSliceDeclaredFiles = unique(
    facts.otherSliceDeclaredFiles.map((value, index) => canonicalPath(value, `Slice Commit other-Slice declared file[${index}]`)),
  );
  if (allowedPaths.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit policy must contain a non-empty allowed scope');
  }
  return {
    root: facts.root,
    stageId: facts.stageId,
    sliceId: facts.sliceId,
    manifestDigest: facts.manifestDigest,
    planDigest: facts.planDigest,
    snapshotDigest: facts.snapshotDigest,
    cvReceiptDigest: facts.cvReceiptDigest,
    allowedPaths,
    otherSliceDeclaredFiles,
    forbiddenPaths,
    workerChangedFiles,
    hasRepairHistory: facts.hasRepairHistory,
  };
}

/** Validate the CV binding used by both pre-commit and post-commit consumers. */
export function validateSliceCommitCvBinding(
  policy: SliceCommitPolicy,
  cvReceiptDigest: string,
): void {
  assertDigest(cvReceiptDigest, 'cv_receipt_digest');
  if (cvReceiptDigest !== policy.cvReceiptDigest) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      `cv_receipt_digest does not match the latest vNext CV_PASS Receipt: ${cvReceiptDigest} != ${policy.cvReceiptDigest}`,
    );
  }
}

/**
 * Validate a real changed-file set against the loaded Runtime policy.
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
  const changed = unique(
    changedFiles.map((value, index) => canonicalPath(value, `Slice Commit changed path[${index}]`)),
  ).sort();
  if (changed.length === 0) {
    fail('DOMAIN.INVALID_TRANSITION', 'Slice Commit requires a non-empty changed-file boundary');
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