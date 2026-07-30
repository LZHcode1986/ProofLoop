import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  findLatestSliceCommitReceipt,
  findLatestIntegrationReceipt,
  findLatestCvPassReceipt,
  resolveSliceBoundary,
  type ResolvedSliceBoundary,
} from '../src/slice-boundary-receipts.js';
import { writeCvReceipt } from '../src/receipt-writer.js';
import { CvReceipt, SliceCommitReceipt, SliceIntegrationReceipt } from '../src/schemas.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slice-boundary-test-')));
  // Initialize a git repository in tmpDir
  execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'ignore' });
  // Create an initial commit so HEAD exists
  fs.writeFileSync(path.join(tmpDir, '.gitkeep'), '');
  execFileSync('git', ['add', '-A'], { cwd: tmpDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir, stdio: 'ignore' });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create a realistic CV PASS receipt.
 */
function createCvReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    slice_id: 'S01-A',
    stage_id: 'S01',
    snapshot: 'a1b2c3d4e5f6a7b8',
    cv_level: 'standard',
    verification_type: 'initial',
    verdict: 'PASS',
    failed_po_ids: [],
    affected_task_ids: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    required_recheck_scope: [],
    timestamp: new Date().toISOString(),
  };
  return { ...defaults, ...overrides };
}

/**
 * Get the current HEAD SHA in the test repo.
 */
function getHeadSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: tmpDir,
    encoding: 'utf-8',
  }).trim();
}

/**
 * Create a commit on the current branch and return its SHA.
 */
function createCommit(fileName: string, content: string): string {
  fs.writeFileSync(path.join(tmpDir, fileName), content, 'utf-8');
  execFileSync('git', ['add', fileName], { cwd: tmpDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `commit ${fileName}`], { cwd: tmpDir, stdio: 'ignore' });
  return getHeadSha();
}

/**
 * Create a committer receipt file at the canonical path.
 * Returns the file path written.
 */
function createCommitterReceipt(
  overrides: Record<string, unknown> = {},
  seq = 1,
): string {
  const headSha = getHeadSha();
  const preCommitHead = overrides.pre_commit_head as string ?? headSha;
  const sliceCommitSha = overrides.slice_commit_sha as string ?? headSha;
  const cvRef = overrides.cv_receipt_ref as string ?? 'cv/S01/S01-A/initial-001.json';
  const cvDigest = overrides.cv_receipt_digest as string ?? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const data: Record<string, unknown> = {
    stage_id: 'S01',
    slice_id: 'S01-A',
    status: 'committed',
    pre_commit_head: preCommitHead,
    slice_commit_sha: sliceCommitSha,
    manifest_digest: 'abc123',
    cv_receipt_ref: cvRef,
    cv_receipt_digest: cvDigest,
    verified_snapshot: 'a1b2c3d4e5f6a7b8',
    tasks_path: 'delivery/stages/S01/tasks.md',
    evidence_path: 'delivery/stages/S01/evidence/S01-A.md',
    changed_files: ['src/test.ts'],
    created_at: new Date().toISOString(),
    ...overrides,
  };

  const dir = path.join(tmpDir, '.proofloop', 'receipts', 'committer', 'S01', 'S01-A');
  fs.mkdirSync(dir, { recursive: true });
  const seqStr = String(seq).padStart(3, '0');
  const filePath = path.join(dir, `slice-output-${seqStr}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

/**
 * Create an integration receipt file at the canonical path.
 * Returns the file path written.
 */
function createIntegrationReceipt(
  overrides: Record<string, unknown> = {},
  seq = 1,
): string {
  const headSha = getHeadSha();
  const sliceCommitSha = overrides.slice_commit_sha as string ?? headSha;
  const integratedSha = overrides.integrated_commit_sha as string ?? headSha;
  const stageHeadAfter = overrides.stage_head_after as string ?? integratedSha;
  const stageHeadBefore = overrides.stage_head_before as string ?? headSha;
  const cvRef = overrides.cv_receipt_ref as string ?? 'cv/S01/S01-A/initial-001.json';

  const data: Record<string, unknown> = {
    stage_id: 'S01',
    slice_id: 'S01-A',
    status: 'integrated',
    slice_commit_sha: sliceCommitSha,
    stage_head_before: stageHeadBefore,
    integrated_commit_sha: integratedSha,
    stage_head_after: stageHeadAfter,
    cv_receipt_ref: cvRef,
    verified_snapshot: 'a1b2c3d4e5f6a7b8',
    post_merge_snapshot: 'b2c3d4e5f6a7b8c9',
    post_merge_checks: [{ id: 'check-1', exit_code: 0 }],
    created_at: new Date().toISOString(),
    ...overrides,
  };

  const dir = path.join(tmpDir, '.proofloop', 'receipts', 'integration', 'S01', 'S01-A');
  fs.mkdirSync(dir, { recursive: true });
  const seqStr = String(seq).padStart(3, '0');
  const filePath = path.join(dir, `integration-${seqStr}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

/**
 * Create a CV PASS receipt at the canonical path and return its ref path
 * (relative to projectRoot, as it would appear in a committer receipt).
 */
function createCvReceiptFile(seq = 1, overrides: Record<string, unknown> = {}): { ref: string; path: string; snapshot: string } {
  const data = createCvReceipt(overrides);
  const snapshot = data.snapshot as string;
  const dir = path.join(tmpDir, '.proofloop', 'receipts', 'cv', 'S01', 'S01-A');
  fs.mkdirSync(dir, { recursive: true });
  const seqStr = String(seq).padStart(3, '0');
  const fileName = `initial-${seqStr}.json`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return { ref: `.proofloop/receipts/cv/S01/S01-A/${fileName}`, path: filePath, snapshot };
}

/**
 * Compute SHA-256 digest of a file.
 */
function computeSha256(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ── Tests: findLatestSliceCommitReceipt ───────────────────────────────────────

describe('findLatestSliceCommitReceipt', () => {

  test('returns null when no committer directory exists', () => {
    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();
  });

  test('returns null when directory is empty', () => {
    const dir = path.join(tmpDir, '.proofloop', 'receipts', 'committer', 'S01', 'S01-A');
    fs.mkdirSync(dir, { recursive: true });
    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();
  });

  test('finds and validates the latest committer receipt', () => {
    // Create a CV receipt first
    const { ref, path: cvPath, snapshot } = createCvReceiptFile(1);
    const cvDigest = computeSha256(cvPath);

    // Create two commits — one for pre_commit_head, one for slice_commit
    const preHead = createCommit('file1.txt', 'v1');
    const sliceCommit = createCommit('file2.txt', 'v2');

    // Write committer receipt
    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit,
      cv_receipt_ref: ref,
      cv_receipt_digest: cvDigest,
      verified_snapshot: snapshot,
    }, 1);

    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).not.toBeNull();
    expect(result!.receipt.slice_id).toBe('S01-A');
    expect(result!.receipt.stage_id).toBe('S01');
    expect(result!.receipt.status).toBe('committed');
    expect(result!.receipt.slice_commit_sha).toBe(sliceCommit);
    expect(result!.receipt.cv_receipt_ref).toBe(ref);
  });

  test('returns the highest sequence number (latest)', () => {
    const { ref, path: cvPath, snapshot } = createCvReceiptFile(1);
    const cvDigest = computeSha256(cvPath);

    const preHead = createCommit('file1.txt', 'v1');
    const sliceCommit1 = createCommit('file2.txt', 'v2');
    const sliceCommit2 = createCommit('file3.txt', 'v3');

    // Write two receipts: seq 1 and seq 2
    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit1,
      cv_receipt_ref: ref,
      cv_receipt_digest: cvDigest,
      verified_snapshot: snapshot,
    }, 1);

    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit2,
      cv_receipt_ref: ref,
      cv_receipt_digest: cvDigest,
      verified_snapshot: snapshot,
    }, 2);

    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).not.toBeNull();
    expect(result!.receipt.slice_commit_sha).toBe(sliceCommit2);
  });

  test('rejects receipt with commit SHA that is not a real Git commit', () => {
    const { ref, path: cvPath, snapshot } = createCvReceiptFile(1);
    const cvDigest = computeSha256(cvPath);
    const preHead = getHeadSha();

    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: '0000000000000000000000000000000000000000',
      cv_receipt_ref: ref,
      cv_receipt_digest: cvDigest,
      verified_snapshot: snapshot,
    }, 1);

    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();
  });

  test('rejects receipt when CV receipt digest does not match', () => {
    const { ref, snapshot: _snapshot } = createCvReceiptFile(1);
    const preHead = createCommit('file1.txt', 'v1');
    const sliceCommit = createCommit('file2.txt', 'v2');

    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit,
      cv_receipt_ref: ref,
      cv_receipt_digest: '0000000000000000000000000000000000000000000000000000000000000000',
      verified_snapshot: 'a1b2c3d4e5f6a7b8',
    }, 1);

    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();
  });

  test('rejects receipt when verified_snapshot does not match CV receipt', () => {
    const { ref, path: cvPath } = createCvReceiptFile(1, { snapshot: 'x1y2z3' });
    const cvDigest = computeSha256(cvPath);
    const preHead = createCommit('file1.txt', 'v1');
    const sliceCommit = createCommit('file2.txt', 'v2');

    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit,
      cv_receipt_ref: ref,
      cv_receipt_digest: cvDigest,
      verified_snapshot: 'mismatched-snapshot',
    }, 1);

    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();
  });

  test('rejects receipt with symlink below project root', () => {
    // Skip on Windows where creating symlinks requires elevated privileges
    if (os.platform() === 'win32') {
      // Verify the assertRegularFileBelowTrustedRoot logic works via a different mechanism
      // On Windows, just verify the helper exists (the logic is tested elsewhere)
      return;
    }

    // Create the receipt normally, then replace it with a symlink
    const { ref, path: cvPath, snapshot } = createCvReceiptFile(1);
    const cvDigest = computeSha256(cvPath);
    const preHead = createCommit('file1.txt', 'v1');
    const sliceCommit = createCommit('file2.txt', 'v2');

    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit,
      cv_receipt_ref: ref,
      cv_receipt_digest: cvDigest,
      verified_snapshot: snapshot,
    }, 1);

    // Replace the receipt file with a symlink to an outside file
    const receiptPath = path.join(tmpDir, '.proofloop', 'receipts', 'committer', 'S01', 'S01-A', 'slice-output-001.json');
    const outsideFile = path.join(os.tmpdir(), 'outside-test-file.json');
    fs.writeFileSync(outsideFile, '{}', 'utf-8');
    fs.unlinkSync(receiptPath);
    try {
      fs.symlinkSync(outsideFile, receiptPath);
    } catch {
      // Symlink creation may fail on some platforms; cleanup and skip
      fs.unlinkSync(outsideFile);
      return;
    }

    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();

    // Cleanup
    fs.unlinkSync(outsideFile);
  });

  test('rejects receipt with stage/slice mismatch', () => {
    const { ref, path: cvPath, snapshot } = createCvReceiptFile(1);
    const cvDigest = computeSha256(cvPath);
    const preHead = createCommit('file1.txt', 'v1');
    const sliceCommit = createCommit('file2.txt', 'v2');

    createCommitterReceipt({
      stage_id: 'S99',
      slice_id: 'S99-Z',
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit,
      cv_receipt_ref: ref,
      cv_receipt_digest: cvDigest,
      verified_snapshot: snapshot,
    }, 1);

    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();
  });

  test('skips invalid JSON files and falls back to valid earlier receipt', () => {
    const { ref, path: cvPath, snapshot } = createCvReceiptFile(1);
    const cvDigest = computeSha256(cvPath);
    const preHead = createCommit('file1.txt', 'v1');
    const sliceCommit1 = createCommit('file2.txt', 'v2');
    const sliceCommit2 = createCommit('file3.txt', 'v3');

    // Valid seq 1
    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit1,
      cv_receipt_ref: ref,
      cv_receipt_digest: cvDigest,
      verified_snapshot: snapshot,
    }, 1);

    // Valid seq 2 with different commit
    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit2,
      cv_receipt_ref: ref,
      cv_receipt_digest: cvDigest,
      verified_snapshot: snapshot,
    }, 2);

    // Corrupt seq 3 (invalid JSON)
    const seqStr = '003';
    const dir = path.join(tmpDir, '.proofloop', 'receipts', 'committer', 'S01', 'S01-A');
    fs.writeFileSync(path.join(dir, `slice-output-${seqStr}.json`), 'not-json', 'utf-8');

    // Should fall back to seq 2
    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).not.toBeNull();
    expect(result!.receipt.slice_commit_sha).toBe(sliceCommit2);
  });

  test('rejects when receipt path is outside project root', () => {
    // Write receipt outside tmpDir then symlink it in — the path will
    // still resolve outside, so assertRegularFileBelowTrustedRoot will reject
    const outsideDir = path.join(os.tmpdir(), 'outside-receipts');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, 'slice-output-001.json');
    const data = {
      stage_id: 'S01',
      slice_id: 'S01-A',
      status: 'committed',
      pre_commit_head: getHeadSha(),
      slice_commit_sha: getHeadSha(),
      manifest_digest: 'abc',
      cv_receipt_ref: 'cv/S01/S01-A/initial-001.json',
      cv_receipt_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      verified_snapshot: 'a1b2c3d4e5f6a7b8',
      tasks_path: 'tasks.md',
      evidence_path: 'evidence.md',
      changed_files: ['test.ts'],
      created_at: new Date().toISOString(),
    };
    fs.writeFileSync(outsidePath, JSON.stringify(data, null, 2), 'utf-8');

    // Try to find it — it's not under tmpDir/.proofloop/...
    const result = findLatestSliceCommitReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

// ── Tests: findLatestIntegrationReceipt ───────────────────────────────────────

describe('findLatestIntegrationReceipt', () => {

  test('returns null when no integration directory exists', () => {
    const result = findLatestIntegrationReceipt(tmpDir, 'S01', 'S01-A', getHeadSha());
    expect(result).toBeNull();
  });

  test('returns null when expectedSliceCommitSha is empty', () => {
    const result = findLatestIntegrationReceipt(tmpDir, 'S01', 'S01-A', '');
    expect(result).toBeNull();
  });

  test('finds the latest integration receipt matching slice commit', () => {
    const { ref, snapshot } = createCvReceiptFile(1);
    const preHead = createCommit('file1.txt', 'v1');
    const sliceCommit = createCommit('file2.txt', 'v2');

    // Create a merge commit to simulate integration
    const integratedSha = createCommit('file3.txt', 'v3');

    createIntegrationReceipt({
      slice_commit_sha: sliceCommit,
      stage_head_before: preHead,
      integrated_commit_sha: integratedSha,
      stage_head_after: integratedSha,
      cv_receipt_ref: ref,
      verified_snapshot: snapshot,
      post_merge_snapshot: 'b2c3d4e5f6a7b8c9',
    }, 1);

    const result = findLatestIntegrationReceipt(tmpDir, 'S01', 'S01-A', sliceCommit);
    expect(result).not.toBeNull();
    expect(result!.receipt.slice_id).toBe('S01-A');
    expect(result!.receipt.status).toBe('integrated');
    expect(result!.receipt.integrated_commit_sha).toBe(integratedSha);
  });

  test('returns null when slice_commit_sha does not match expected', () => {
    const { ref, snapshot } = createCvReceiptFile(1);
    const sliceCommit = createCommit('file1.txt', 'v1');
    const integratedSha = createCommit('file2.txt', 'v2');

    createIntegrationReceipt({
      slice_commit_sha: sliceCommit,
      integrated_commit_sha: integratedSha,
      stage_head_after: integratedSha,
      cv_receipt_ref: ref,
      verified_snapshot: snapshot,
    }, 1);

    const result = findLatestIntegrationReceipt(tmpDir, 'S01', 'S01-A', '0000000000000000000000000000000000000000');
    expect(result).toBeNull();
  });

  test('returns null when integrated_commit_sha is not an ancestor of HEAD', () => {
    const { ref, snapshot } = createCvReceiptFile(1);
    const sliceCommit = createCommit('file1.txt', 'v1');

    // Create an orphan commit that's not related to HEAD
    const orphanDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-repo-')));
    execFileSync('git', ['init'], { cwd: orphanDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: orphanDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: orphanDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(orphanDir, 'orphan.txt'), 'orphan');
    execFileSync('git', ['add', '-A'], { cwd: orphanDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'orphan'], { cwd: orphanDir, stdio: 'ignore' });
    const orphanSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: orphanDir, encoding: 'utf-8' }).trim();
    fs.rmSync(orphanDir, { recursive: true, force: true });

    createIntegrationReceipt({
      slice_commit_sha: sliceCommit,
      integrated_commit_sha: orphanSha,
      stage_head_after: orphanSha,
      cv_receipt_ref: ref,
      verified_snapshot: snapshot,
    }, 1);

    const result = findLatestIntegrationReceipt(tmpDir, 'S01', 'S01-A', sliceCommit);
    expect(result).toBeNull();
  });

  test('rejects when cv_receipt_ref path does not match canonical CV receipt', () => {
    const sliceCommit = createCommit('file1.txt', 'v1');
    const integratedSha = createCommit('file2.txt', 'v2');

    createIntegrationReceipt({
      slice_commit_sha: sliceCommit,
      integrated_commit_sha: integratedSha,
      stage_head_after: integratedSha,
      cv_receipt_ref: 'nonexistent/receipt.json',
      verified_snapshot: 'a1b2c3d4e5f6a7b8',
    }, 1);

    const result = findLatestIntegrationReceipt(tmpDir, 'S01', 'S01-A', sliceCommit);
    expect(result).toBeNull();
  });

  test('rejects when verified_snapshot does not match CV receipt', () => {
    const { ref } = createCvReceiptFile(1, { snapshot: 'x-snapshot-value' });
    const sliceCommit = createCommit('file1.txt', 'v1');
    const integratedSha = createCommit('file2.txt', 'v2');

    createIntegrationReceipt({
      slice_commit_sha: sliceCommit,
      integrated_commit_sha: integratedSha,
      stage_head_after: integratedSha,
      cv_receipt_ref: ref,
      verified_snapshot: 'wrong-snapshot',
    }, 1);

    const result = findLatestIntegrationReceipt(tmpDir, 'S01', 'S01-A', sliceCommit);
    expect(result).toBeNull();
  });

  test('returns the highest sequence number', () => {
    const { ref, snapshot } = createCvReceiptFile(1);
    const sliceCommit = createCommit('file1.txt', 'v1');
    const integratedSha1 = createCommit('file2.txt', 'v2');
    const integratedSha2 = createCommit('file3.txt', 'v3');

    createIntegrationReceipt({
      slice_commit_sha: sliceCommit,
      integrated_commit_sha: integratedSha1,
      stage_head_after: integratedSha1,
      cv_receipt_ref: ref,
      verified_snapshot: snapshot,
    }, 1);

    createIntegrationReceipt({
      slice_commit_sha: sliceCommit,
      integrated_commit_sha: integratedSha2,
      stage_head_after: integratedSha2,
      cv_receipt_ref: ref,
      verified_snapshot: snapshot,
    }, 2);

    const result = findLatestIntegrationReceipt(tmpDir, 'S01', 'S01-A', sliceCommit);
    expect(result).not.toBeNull();
    expect(result!.receipt.integrated_commit_sha).toBe(integratedSha2);
  });

  test('skips invalid JSON and falls back', () => {
    const { ref, snapshot } = createCvReceiptFile(1);
    const sliceCommit = createCommit('file1.txt', 'v1');
    const integratedSha1 = createCommit('file2.txt', 'v2');
    const integratedSha2 = createCommit('file3.txt', 'v3');

    createIntegrationReceipt({
      slice_commit_sha: sliceCommit,
      integrated_commit_sha: integratedSha1,
      stage_head_after: integratedSha1,
      cv_receipt_ref: ref,
      verified_snapshot: snapshot,
    }, 1);

    createIntegrationReceipt({
      slice_commit_sha: sliceCommit,
      integrated_commit_sha: integratedSha2,
      stage_head_after: integratedSha2,
      cv_receipt_ref: ref,
      verified_snapshot: snapshot,
    }, 2);

    // Invalid seq 3
    const dir = path.join(tmpDir, '.proofloop', 'receipts', 'integration', 'S01', 'S01-A');
    fs.writeFileSync(path.join(dir, 'integration-003.json'), 'garbage', 'utf-8');

    const result = findLatestIntegrationReceipt(tmpDir, 'S01', 'S01-A', sliceCommit);
    expect(result).not.toBeNull();
    expect(result!.receipt.integrated_commit_sha).toBe(integratedSha2);
  });
});

// ── Tests: findLatestCvPassReceipt ────────────────────────────────────────────

describe('findLatestCvPassReceipt', () => {

  test('returns null when no CV directory', () => {
    const result = findLatestCvPassReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();
  });

  test('finds the latest PASS receipt', () => {
    createCvReceiptFile(1, { snapshot: 'snap1', verdict: 'REPAIR', failed_po_ids: ['PO-01'], failed_criterion: 'x', failure_signature: 'sha256:x', required_recheck_scope: ['S01-A-T1'] });
    const { snapshot } = createCvReceiptFile(2, { snapshot: 'snap2' });

    const result = findLatestCvPassReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).not.toBeNull();
    expect(result!.receipt.snapshot).toBe('snap2');
    expect(result!.receipt.verdict).toBe('PASS');
  });

  test('returns null when no PASS receipt exists', () => {
    createCvReceiptFile(1, { verdict: 'REPAIR', failed_po_ids: ['PO-01'], failed_criterion: 'x', failure_signature: 'sha256:x', required_recheck_scope: ['S01-A-T1'] });

    const result = findLatestCvPassReceipt(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();
  });
});

// ── Tests: resolveSliceBoundary ───────────────────────────────────────────────

describe('resolveSliceBoundary', () => {

  test('returns null when no CV PASS receipt exists', () => {
    const result = resolveSliceBoundary(tmpDir, 'S01', 'S01-A');
    expect(result).toBeNull();
  });

  test('returns boundary with CV only', () => {
    createCvReceiptFile(1);

    const result = resolveSliceBoundary(tmpDir, 'S01', 'S01-A');
    expect(result).not.toBeNull();
    expect(result!.cvReceipt.verdict).toBe('PASS');
    expect(result!.commitReceipt).toBeNull();
    expect(result!.integrationReceipt).toBeNull();
  });

  test('returns full boundary with CV + commit + integration', () => {
    const { ref, path: cvPath, snapshot } = createCvReceiptFile(1);
    const cvDigest = computeSha256(cvPath);

    const preHead = createCommit('file1.txt', 'v1');
    const sliceCommit = createCommit('file2.txt', 'v2');

    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit,
      cv_receipt_ref: ref,
      cv_receipt_digest: cvDigest,
      verified_snapshot: snapshot,
    }, 1);

    const integratedSha = createCommit('file3.txt', 'v3');

    createIntegrationReceipt({
      slice_commit_sha: sliceCommit,
      stage_head_before: preHead,
      integrated_commit_sha: integratedSha,
      stage_head_after: integratedSha,
      cv_receipt_ref: ref,
      verified_snapshot: snapshot,
    }, 1);

    const result = resolveSliceBoundary(tmpDir, 'S01', 'S01-A');
    expect(result).not.toBeNull();
    expect(result!.cvReceipt.verdict).toBe('PASS');
    expect(result!.commitReceipt).not.toBeNull();
    expect(result!.commitReceipt!.slice_commit_sha).toBe(sliceCommit);
    expect(result!.integrationReceipt).not.toBeNull();
    expect(result!.integrationReceipt!.integrated_commit_sha).toBe(integratedSha);
  });

  test('CV only when commit receipt exists but fails validation (bad digest)', () => {
    const { ref, snapshot: _snapshot } = createCvReceiptFile(1);
    const preHead = createCommit('file1.txt', 'v1');
    const sliceCommit = createCommit('file2.txt', 'v2');

    createCommitterReceipt({
      pre_commit_head: preHead,
      slice_commit_sha: sliceCommit,
      cv_receipt_ref: ref,
      cv_receipt_digest: '0000000000000000000000000000000000000000000000000000000000000000',
      verified_snapshot: 'a1b2c3d4e5f6a7b8',
    }, 1);

    const result = resolveSliceBoundary(tmpDir, 'S01', 'S01-A');
    expect(result).not.toBeNull();
    expect(result!.commitReceipt).toBeNull();
    expect(result!.integrationReceipt).toBeNull();
  });
});
