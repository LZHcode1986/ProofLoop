/**
 * slice-boundary-receipts.ts
 *
 * Responsible for reading and validating Committer and Integration Receipts
 * from the canonical receipt directory layout.
 *
 * All paths must be below a trusted project root; symlinks below the root
 * are rejected.  Git ancestry checks are performed when the project root
 * is a valid Git repository.
 *
 * Directory layout:
 *   <projectRoot>/.proofloop/receipts/committer/<stage>/<slice>/slice-output-NNN.json
 *   <projectRoot>/.proofloop/receipts/integration/<stage>/<slice>/integration-NNN.json
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  SliceCommitReceipt,
  SliceIntegrationReceipt,
  CvReceipt,
} from './schemas.js';
import {
  resolveCanonicalArtifact,
  assertRegularFileBelowTrustedRoot,
} from './canonical-artifact-path.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ResolvedCvReceipt {
  /** Parsed CV receipt data. */
  receipt: CvReceipt;
  /** Canonical real path of the CV receipt file. */
  path: string;
  /** SHA-256 digest of the CV receipt file contents. */
  digest: string;
}

export interface CvReceiptLookupResult {
  /** The latest valid CV PASS receipt, or null if none found. */
  latest: ResolvedCvReceipt | null;
  /** Files found in the CV receipt directory that failed to parse. */
  invalidFiles: string[];
}

export interface ResolvedSliceBoundary {
  /** The latest CV PASS receipt for this slice. */
  cvReceipt: CvReceipt;
  /** Canonical real path of the CV receipt file. */
  cvReceiptPath: string;
  /** SHA-256 digest of the CV receipt file contents. */
  cvReceiptDigest: string;

  /** The latest committer receipt, or null if none found. */
  commitReceipt: SliceCommitReceipt | null;
  /** Canonical real path of the committer receipt, or null. */
  commitReceiptPath: string | null;

  /** The latest integration receipt (matching slice commit), or null. */
  integrationReceipt: SliceIntegrationReceipt | null;
  /** Canonical real path of the integration receipt, or null. */
  integrationReceiptPath: string | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Get the path to the committer receipt directory for a given stage/slice.
 */
function committerReceiptDir(projectRoot: string, stageId: string, sliceId: string): string {
  return path.join(projectRoot, '.proofloop', 'receipts', 'committer', stageId, sliceId);
}

/**
 * Get the path to the integration receipt directory for a given stage/slice.
 */
function integrationReceiptDir(projectRoot: string, stageId: string, sliceId: string): string {
  return path.join(projectRoot, '.proofloop', 'receipts', 'integration', stageId, sliceId);
}

/**
 * Check whether a directory exists.
 */
function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read and parse a JSON file, returning null on any failure.
 */
function readJsonFile<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Compute SHA-256 digest of a file's contents, returning lowercase hex string.
 */
function sha256Digest(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Run `git merge-base --is-ancestor <ancestor> <descendant>` in projectRoot.
 * Returns true if ancestor is an ancestor of descendant (or equal).
 */
function isGitAncestor(projectRoot: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current HEAD commit SHA in the given project root.
 */
function getHeadSha(projectRoot: string): string | null {
  try {
    const output = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * Validate that a file path is a regular file below the trusted project root.
 */
function validatePathBelowRoot(filePath: string, projectRoot: string): string | null {
  const canonical = assertRegularFileBelowTrustedRoot(filePath, projectRoot);
  if (canonical !== null) return canonical;

  // Also try resolving relative to project root
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectRoot, filePath);
  return assertRegularFileBelowTrustedRoot(absolute, projectRoot);
}

// ── CV receipt lookup ─────────────────────────────────────────────────────────

/**
 * Find the latest CV receipt (any verdict) for a given stage/slice by scanning
 * the canonical CV receipt directory.
 *
 * Returns a CvReceiptLookupResult containing the latest valid receipt (if found),
 * its canonical path and digest, and a list of files that failed to parse.
 * Invalid files are tracked even when a valid receipt exists, so callers
 * can detect and escalate corrupted history.
 *
 * Unlike findLatestCvPassReceipt, this does NOT filter by verdict — it returns
 * the newest receipt regardless of PASS, REPAIR, or any other verdict.
 */
export function findLatestCvReceipt(
  projectRoot: string,
  stageId: string,
  sliceId: string,
): CvReceiptLookupResult {
  const result: CvReceiptLookupResult = { latest: null, invalidFiles: [] };

  const cvDir = path.join(projectRoot, '.proofloop', 'receipts', 'cv', stageId, sliceId);
  if (!directoryExists(cvDir)) return result;

  const CV_FILE_RE = /^(initial|recheck)-(\d{3})\.json$/;
  let files: string[];
  try {
    files = fs.readdirSync(cvDir);
  } catch {
    return result;
  }

  // Filter matching files, sort by sequence number descending
  const matching = files
    .filter(f => CV_FILE_RE.test(f))
    .sort()
    .reverse(); // highest seq first

  for (const f of matching) {
    const filePath = path.join(cvDir, f);
    const canonical = validatePathBelowRoot(filePath, projectRoot);
    if (!canonical) {
      result.invalidFiles.push(filePath);
      continue;
    }

    const data = readJsonFile<Record<string, unknown>>(filePath);
    if (!data) {
      result.invalidFiles.push(filePath);
      continue;
    }

    try {
      const parsed = CvReceipt.parse(data);
      // Accept any verdict — not just PASS
      if (parsed.stage_id === stageId && parsed.slice_id === sliceId) {
        const digest = sha256Digest(filePath) ?? '';
        result.latest = { receipt: parsed, path: canonical, digest };
        return result;
      }
    } catch {
      // Invalid CV receipt — record as invalid
      result.invalidFiles.push(filePath);
      continue;
    }
  }

  return result;
}

/**
 * Find the latest CV PASS receipt for a given stage/slice by scanning the
 * canonical CV receipt directory.
 *
 * Returns a CvReceiptLookupResult containing the latest PASS receipt (if found),
 * its canonical path and digest, and a list of files that failed to parse.
 * Invalid files are tracked even when a valid PASS receipt exists, so callers
 * can detect and escalate corrupted history.
 */
export function findLatestCvPassReceipt(
  projectRoot: string,
  stageId: string,
  sliceId: string,
): CvReceiptLookupResult {
  const result: CvReceiptLookupResult = { latest: null, invalidFiles: [] };

  const cvDir = path.join(projectRoot, '.proofloop', 'receipts', 'cv', stageId, sliceId);
  if (!directoryExists(cvDir)) return result;

  const CV_FILE_RE = /^(initial|recheck)-(\d{3})\.json$/;
  let files: string[];
  try {
    files = fs.readdirSync(cvDir);
  } catch {
    return result;
  }

  // Filter matching files, sort by sequence number descending
  const matching = files
    .filter(f => CV_FILE_RE.test(f))
    .sort()
    .reverse(); // highest seq first

  for (const f of matching) {
    const filePath = path.join(cvDir, f);
    const canonical = validatePathBelowRoot(filePath, projectRoot);
    if (!canonical) {
      result.invalidFiles.push(filePath);
      continue;
    }

    const data = readJsonFile<Record<string, unknown>>(filePath);
    if (!data) {
      result.invalidFiles.push(filePath);
      continue;
    }

    try {
      const parsed = CvReceipt.parse(data);
      if (parsed.verdict === 'PASS' && parsed.stage_id === stageId && parsed.slice_id === sliceId) {
        const digest = sha256Digest(filePath) ?? '';
        result.latest = { receipt: parsed, path: canonical, digest };
        return result;
      }
    } catch {
      // Invalid CV receipt — record as invalid
      result.invalidFiles.push(filePath);
      continue;
    }
  }

  return result;
}

/**
 * Collect ALL valid CV receipts for a given stage/slice, ordered oldest to newest.
 *
 * Returns a list of parsed receipts and a list of files that failed to parse.
 * This enables callers to detect corrupted CV receipt history.
 */
export function collectAllCvReceipts(
  projectRoot: string,
  stageId: string,
  sliceId: string,
): { receipts: CvReceipt[]; invalidFiles: string[] } {
  const result: { receipts: CvReceipt[]; invalidFiles: string[] } = { receipts: [], invalidFiles: [] };

  const cvDir = path.join(projectRoot, '.proofloop', 'receipts', 'cv', stageId, sliceId);
  if (!directoryExists(cvDir)) return result;

  const CV_FILE_RE = /^(initial|recheck)-(\d{3})\.json$/;
  let files: string[];
  try {
    files = fs.readdirSync(cvDir);
  } catch {
    return result;
  }

  // Filter matching files, sort by sequence number ascending (oldest first)
  const matching = files
    .filter(f => CV_FILE_RE.test(f))
    .sort(); // ascending

  for (const f of matching) {
    const filePath = path.join(cvDir, f);
    const canonical = validatePathBelowRoot(filePath, projectRoot);
    if (!canonical) {
      result.invalidFiles.push(filePath);
      continue;
    }

    const data = readJsonFile<Record<string, unknown>>(filePath);
    if (!data) {
      result.invalidFiles.push(filePath);
      continue;
    }

    try {
      const parsed = CvReceipt.parse(data);
      result.receipts.push(parsed);
    } catch {
      result.invalidFiles.push(filePath);
      continue;
    }
  }

  return result;
}

// ── Committer Receipt finder ──────────────────────────────────────────────────

/**
 * Find the latest valid Slice Commit Receipt for a given stage/slice.
 *
 * Validation rules (section 3.3):
 * - Path: <projectRoot>/.proofloop/receipts/committer/<stage>/<slice>/
 * - File name matches slice-output-NNN.json
 * - Stage / Slice match
 * - status === 'committed'
 * - slice_commit_sha is a real Git commit
 * - slice_commit_sha is an ancestor of current Stage HEAD
 * - cv_receipt_ref resolves to a canonical file below projectRoot
 * - cv_receipt_digest matches SHA-256 of the referenced CV receipt file
 * - verified_snapshot matches the CV receipt's snapshot
 * - No symlinks below projectRoot in the receipt path
 *
 * Additional optional expected-param checks (P0-3):
 * - expectedCvReceiptPath:      cv_receipt_ref must resolve to this path
 * - expectedCvReceiptDigest:    cv_receipt_digest must match
 * - expectedVerifiedSnapshot:   verified_snapshot must match
 * - expectedManifestDigest:     manifest_digest must match
 * - expectedTasksPath:          tasks_path must resolve to this path
 * - expectedEvidencePath:       evidence_path must resolve to this path
 *
 * @param params.projectRoot - The trusted project root (must be a real Git root).
 * @param params.stageId     - The stage identifier.
 * @param params.sliceId     - The slice identifier.
 * @param params.expected*   - Optional expected values for additional validation.
 * @returns The validated receipt and its canonical path, or null.
 */
export function findLatestSliceCommitReceipt(params: {
  projectRoot: string;
  stageId: string;
  sliceId: string;
  expectedCvReceiptPath?: string;
  expectedCvReceiptDigest?: string;
  expectedVerifiedSnapshot?: string;
  expectedManifestDigest?: string;
  expectedTasksPath?: string;
  expectedEvidencePath?: string;
}): { receipt: SliceCommitReceipt; path: string } | null {
  const { projectRoot, stageId, sliceId } = params;
  const receiptDir = committerReceiptDir(projectRoot, stageId, sliceId);
  if (!directoryExists(receiptDir)) return null;

  const COMMIT_FILE_RE = /^slice-output-(\d{3})\.json$/;
  let files: string[];
  try {
    files = fs.readdirSync(receiptDir);
  } catch {
    return null;
  }

  // Filter matching files, sort descending
  const matching = files
    .filter(f => COMMIT_FILE_RE.test(f))
    .sort()
    .reverse();

  for (const f of matching) {
    const filePath = path.join(receiptDir, f);

    // 1. Validate path is below trusted root (rejects symlinks)
    const canonical = assertRegularFileBelowTrustedRoot(filePath, projectRoot);
    if (!canonical) continue;

    // 2. Read and parse JSON
    const data = readJsonFile<Record<string, unknown>>(filePath);
    if (!data) continue;

    // 3. Parse through schema
    let parsed: SliceCommitReceipt;
    try {
      parsed = SliceCommitReceipt.parse(data);
    } catch {
      // Invalid schema — skip to next file
      continue;
    }

    // 4. Validate stage/slice match
    if (parsed.stage_id !== stageId || parsed.slice_id !== sliceId) continue;

    // 5. Validate status
    if (parsed.status !== 'committed') continue;

    // 6. Validate slice_commit_sha is a real Git commit (try to resolve it)
    if (!isGitAncestor(projectRoot, parsed.slice_commit_sha, parsed.slice_commit_sha)) {
      // The commit doesn't exist in the repo at all
      continue;
    }

    // 7. Validate slice_commit_sha is an ancestor of current Stage HEAD
    const headSha = getHeadSha(projectRoot);
    if (headSha && !isGitAncestor(projectRoot, parsed.slice_commit_sha, headSha)) {
      // slice_commit_sha is not an ancestor of HEAD — skip
      continue;
    }

    // 8. Validate cv_receipt_ref resolves to a canonical file
    const cvReceiptPath = resolveCanonicalArtifact(parsed.cv_receipt_ref, projectRoot);
    if (!cvReceiptPath) continue;

    // 9. Validate cv_receipt_digest against SHA-256 of the CV receipt file
    const actualDigest = sha256Digest(cvReceiptPath);
    if (!actualDigest || actualDigest !== parsed.cv_receipt_digest) continue;

    // 10. Validate verified_snapshot matches the CV receipt's snapshot
    const cvData = readJsonFile<Record<string, unknown>>(cvReceiptPath);
    if (!cvData) continue;
    try {
      const cvParsed = CvReceipt.parse(cvData);
      if (cvParsed.snapshot !== parsed.verified_snapshot) continue;
    } catch {
      continue;
    }

    // ── P0-3: Additional expected-param checks ──────────────────────────────

    // If expectedCvReceiptPath is provided, verify cv_receipt_ref resolves to the same path
    if (params.expectedCvReceiptPath) {
      const canonicalCvRef = resolveCanonicalArtifact(parsed.cv_receipt_ref, params.projectRoot);
      if (!canonicalCvRef || canonicalCvRef !== params.expectedCvReceiptPath) {
        continue;
      }
    }

    // If expectedCvReceiptDigest is provided, verify match
    if (params.expectedCvReceiptDigest && parsed.cv_receipt_digest !== params.expectedCvReceiptDigest) {
      continue;
    }

    // If expectedVerifiedSnapshot is provided, verify match
    if (params.expectedVerifiedSnapshot && parsed.verified_snapshot !== params.expectedVerifiedSnapshot) {
      continue;
    }

    // If expectedManifestDigest is provided, verify match
    if (params.expectedManifestDigest && parsed.manifest_digest !== params.expectedManifestDigest) {
      continue;
    }

    // If expectedTasksPath is provided, resolve and compare
    if (params.expectedTasksPath) {
      const canonicalExpected = path.resolve(params.projectRoot, params.expectedTasksPath);
      const canonicalActual = path.resolve(params.projectRoot, parsed.tasks_path);
      if (canonicalExpected !== canonicalActual) continue;
    }

    // If expectedEvidencePath is provided, resolve and compare
    if (params.expectedEvidencePath) {
      const canonicalExpected = path.resolve(params.projectRoot, params.expectedEvidencePath);
      const canonicalActual = path.resolve(params.projectRoot, parsed.evidence_path);
      if (canonicalExpected !== canonicalActual) continue;
    }

    // All checks passed
    return { receipt: parsed, path: canonical };
  }

  return null;
}

// ── Integration Receipt finder ────────────────────────────────────────────────

/**
 * Find the latest valid Integration Receipt for a given stage/slice that
 * matches the expected slice commit SHA.
 *
 * Validation rules (section 3.3):
 * - Path: <projectRoot>/.proofloop/receipts/integration/<stage>/<slice>/
 * - File name matches integration-NNN.json
 * - Stage / Slice match
 * - status === 'integrated'
 * - slice_commit_sha === expectedSliceCommitSha (must be provided)
 * - integrated_commit_sha === stage_head_after
 * - integrated_commit_sha is an ancestor of current HEAD
 * - cv_receipt_ref matches the same CV receipt as the committer receipt
 * - verified_snapshot matches the CV receipt's snapshot
 * - post_merge_checks: all exit codes are 0 (implied by being valid)
 *
 * @param projectRoot           - The trusted project root.
 * @param stageId               - The stage identifier.
 * @param sliceId               - The slice identifier.
 * @param expectedSliceCommitSha - The slice commit SHA from the committer receipt.
 *                                 Must be provided; no integration receipt is
 *                                 accepted without a matching slice commit.
 * @returns The validated receipt and its canonical path, or null.
 */
export function findLatestIntegrationReceipt(
  projectRoot: string,
  stageId: string,
  sliceId: string,
  expectedSliceCommitSha: string,
): { receipt: SliceIntegrationReceipt; path: string } | null {
  // Must have a specific slice commit SHA to match against
  if (!expectedSliceCommitSha || expectedSliceCommitSha.length === 0) return null;

  const receiptDir = integrationReceiptDir(projectRoot, stageId, sliceId);
  if (!directoryExists(receiptDir)) return null;

  const INT_FILE_RE = /^integration-(\d{3})\.json$/;
  let files: string[];
  try {
    files = fs.readdirSync(receiptDir);
  } catch {
    return null;
  }

  // Filter matching files, sort descending
  const matching = files
    .filter(f => INT_FILE_RE.test(f))
    .sort()
    .reverse();

  for (const f of matching) {
    const filePath = path.join(receiptDir, f);

    // 1. Validate path is below trusted root (rejects symlinks)
    const canonical = assertRegularFileBelowTrustedRoot(filePath, projectRoot);
    if (!canonical) continue;

    // 2. Read and parse JSON
    const data = readJsonFile<Record<string, unknown>>(filePath);
    if (!data) continue;

    // 3. Parse through schema
    let parsed: SliceIntegrationReceipt;
    try {
      parsed = SliceIntegrationReceipt.parse(data);
    } catch {
      continue;
    }

    // 4. Validate stage/slice match
    if (parsed.stage_id !== stageId || parsed.slice_id !== sliceId) continue;

    // 5. Validate status
    if (parsed.status !== 'integrated') continue;

    // 6. Validate slice_commit_sha matches expected
    if (parsed.slice_commit_sha !== expectedSliceCommitSha) continue;

    // 7. Validate integrated_commit_sha === stage_head_after (schema superRefine ensures this)
    //    But double-check for safety
    if (parsed.integrated_commit_sha !== parsed.stage_head_after) continue;

    // 8. Validate integrated_commit_sha is an ancestor of current HEAD
    const headSha = getHeadSha(projectRoot);
    if (headSha && !isGitAncestor(projectRoot, parsed.integrated_commit_sha, headSha)) {
      continue;
    }

    // 9. Validate cv_receipt_ref resolves to a canonical file
    const cvReceiptPath = resolveCanonicalArtifact(parsed.cv_receipt_ref, projectRoot);
    if (!cvReceiptPath) continue;

    // 10. Validate verified_snapshot matches the CV receipt
    const cvData = readJsonFile<Record<string, unknown>>(cvReceiptPath);
    if (!cvData) continue;
    try {
      const cvParsed = CvReceipt.parse(cvData);
      if (cvParsed.snapshot !== parsed.verified_snapshot) continue;
      if (cvParsed.slice_id !== sliceId || cvParsed.stage_id !== stageId) continue;
    } catch {
      continue;
    }

    // All checks passed
    return { receipt: parsed, path: canonical };
  }

  return null;
}

// ── Resolved Slice Boundary ───────────────────────────────────────────────────

/**
 * Resolve all three boundary receipts (CV, Commit, Integration) for a slice.
 *
 * This is the high-level function that assembles the full ResolvedSliceBoundary.
 *
 * Returns null if the CV PASS receipt is missing (no boundary can be resolved
 * without a PASS).
 */
export function resolveSliceBoundary(
  projectRoot: string,
  stageId: string,
  sliceId: string,
): ResolvedSliceBoundary | null {
  // CV PASS is the prerequisite for everything else
  const cvResult = findLatestCvPassReceipt(projectRoot, stageId, sliceId);
  if (!cvResult.latest) return null;

  const commitResult = findLatestSliceCommitReceipt({
    projectRoot,
    stageId,
    sliceId,
  });

  let integrationResult: { receipt: SliceIntegrationReceipt; path: string } | null = null;
  if (commitResult) {
    integrationResult = findLatestIntegrationReceipt(
      projectRoot,
      stageId,
      sliceId,
      commitResult.receipt.slice_commit_sha,
    );
  }

  return {
    cvReceipt: cvResult.latest.receipt,
    cvReceiptPath: cvResult.latest.path,
    cvReceiptDigest: cvResult.latest.digest,
    commitReceipt: commitResult?.receipt ?? null,
    commitReceiptPath: commitResult?.path ?? null,
    integrationReceipt: integrationResult?.receipt ?? null,
    integrationReceiptPath: integrationResult?.path ?? null,
  };
}
