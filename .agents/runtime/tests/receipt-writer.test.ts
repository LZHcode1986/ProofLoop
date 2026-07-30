import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  writeSliceCommitReceipt,
  writeSliceIntegrationReceipt,
  validateAndWriteSliceCommitReceipt,
  validateAndWriteSliceIntegrationReceipt,
  getDefaultCommitterReceiptRoot,
  getDefaultIntegrationReceiptRoot,
} from '../src/receipt-writer.js';
import { CvReceipt } from '../src/schemas.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-writer-test-')));
  // Initialize a git repository
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

/** Get current HEAD SHA. */
function getHeadSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: tmpDir,
    encoding: 'utf-8',
  }).trim();
}

/** Create a commit and return its SHA. */
function createCommit(fileName: string, content: string): string {
  fs.writeFileSync(path.join(tmpDir, fileName), content, 'utf-8');
  execFileSync('git', ['add', fileName], { cwd: tmpDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `commit ${fileName}`], { cwd: tmpDir, stdio: 'ignore' });
  return getHeadSha();
}

/** Create a CV PASS receipt file at the canonical location and return its ref and digest. */
function createCvReceiptFile(
  stageId = 'S01',
  sliceId = 'S01-A',
): { ref: string; digest: string; absPath: string } {
  const cvDir = path.join(tmpDir, '.proofloop', 'receipts', 'cv', stageId, sliceId);
  fs.mkdirSync(cvDir, { recursive: true });

  const data = {
    slice_id: sliceId,
    stage_id: stageId,
    snapshot: 'a1b2c3d4e5f6a7b8',
    cv_level: 'standard' as const,
    verification_type: 'initial' as const,
    verdict: 'PASS' as const,
    failed_po_ids: [],
    affected_task_ids: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    required_recheck_scope: [],
    timestamp: new Date().toISOString(),
  };

  const absPath = path.join(cvDir, 'initial-001.json');
  fs.writeFileSync(absPath, JSON.stringify(data, null, 2), 'utf-8');

  const digest = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  const ref = path.relative(tmpDir, absPath).replace(/\\/g, '/');

  return { ref, digest, absPath };
}

/** Build a minimal SliceCommitReceipt data object.
 *
 * Automatically creates a new commit for slice_commit_sha and uses
 * the previous HEAD as pre_commit_head, so the data is valid per the
 * schema's superRefine (slice_commit_sha !== pre_commit_head).
 *
 * Callers can override either value to test invalid scenarios.
 */
function makeCommitData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Capture HEAD before any new commit
  const headBefore = getHeadSha();

  // Create a new commit to use as slice_commit_sha (unless overridden)
  let sliceCommitSha: string;
  if (overrides.slice_commit_sha !== undefined) {
    sliceCommitSha = overrides.slice_commit_sha as string;
  } else {
    sliceCommitSha = createCommit('slice-file.txt', `content-${Date.now()}`);
  }

  // Use the original HEAD as pre_commit_head (unless overridden)
  const preCommitHead = overrides.pre_commit_head as string ?? headBefore;
  const cv = createCvReceiptFile();

  return {
    stage_id: 'S01',
    slice_id: 'S01-A',
    status: 'committed',
    pre_commit_head: preCommitHead,
    slice_commit_sha: sliceCommitSha,
    manifest_digest: 'abc123',
    cv_receipt_ref: cv.ref,
    cv_receipt_digest: cv.digest,
    verified_snapshot: 'a1b2c3d4e5f6a7b8',
    tasks_path: 'delivery/stages/S01/tasks.md',
    evidence_path: 'delivery/stages/S01/evidence/S01-A.md',
    changed_files: ['src/test.ts'],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a minimal SliceIntegrationReceipt data object.
 *
 * Creates a new commit to use as slice_commit_sha so the value
 * is a valid Git commit that exists in the repo.
 */
function makeIntegrationData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Capture HEAD before any new commit
  const headBefore = getHeadSha();

  // Create a new commit to use as slice_commit_sha (unless overridden)
  let sliceCommitSha: string;
  if (overrides.slice_commit_sha !== undefined) {
    sliceCommitSha = overrides.slice_commit_sha as string;
  } else {
    sliceCommitSha = createCommit('int-slice-file.txt', `int-content-${Date.now()}`);
  }

  const cv = createCvReceiptFile();

  return {
    stage_id: 'S01',
    slice_id: 'S01-A',
    status: 'integrated',
    slice_commit_sha: sliceCommitSha,
    stage_head_before: headBefore,
    integrated_commit_sha: headBefore,
    stage_head_after: headBefore,
    cv_receipt_ref: cv.ref,
    verified_snapshot: 'a1b2c3d4e5f6a7b8',
    post_merge_snapshot: 'b2c3d4e5f6a7b8c9',
    post_merge_checks: [{ id: 'check-1', exit_code: 0 }],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('writeSliceCommitReceipt — sequence numbering (P0-2 fix)', () => {

  test('writes first receipt as slice-output-001.json', () => {
    const receiptRoot = path.join(tmpDir, 'receipts', 'committer');
    const data = makeCommitData();

    const result = writeSliceCommitReceipt(data as any, receiptRoot);

    expect(result).toContain('slice-output-001.json');
    expect(fs.existsSync(result)).toBe(true);

    // Verify content
    const parsed = JSON.parse(fs.readFileSync(result, 'utf-8'));
    expect(parsed.stage_id).toBe('S01');
    expect(parsed.slice_id).toBe('S01-A');
    expect(parsed.status).toBe('committed');
  });

  test('second consecutive call produces slice-output-002.json', () => {
    const receiptRoot = path.join(tmpDir, 'receipts', 'committer');

    // makeCommitData handles commit creation internally, ensuring
    // slice_commit_sha != pre_commit_head automatically.
    const r1 = writeSliceCommitReceipt(makeCommitData() as any, receiptRoot);
    expect(r1).toContain('slice-output-001.json');

    const r2 = writeSliceCommitReceipt(makeCommitData() as any, receiptRoot);
    expect(r2).toContain('slice-output-002.json');
    expect(fs.existsSync(r2)).toBe(true);
  });

  test('third call still produces slice-output-003.json', () => {
    const receiptRoot = path.join(tmpDir, 'receipts', 'committer');

    writeSliceCommitReceipt(makeCommitData() as any, receiptRoot);
    writeSliceCommitReceipt(makeCommitData() as any, receiptRoot);

    const r3 = writeSliceCommitReceipt(makeCommitData() as any, receiptRoot);
    expect(r3).toContain('slice-output-003.json');
  });

  test('prefix-specific regex matches slice-output correctly (hyphen in prefix)', () => {
    // This test validates the P0-2 fix: SEQUENCE_FILE_RE with \w+ would NOT
    // match 'slice-output-001.json' because \w+ doesn't include hyphens.
    // The new prefix-specific regex correctly matches it.
    const receiptRoot = path.join(tmpDir, 'receipts', 'committer');

    // Write a receipt — this uses the prefix 'slice-output' internally
    const r1 = writeSliceCommitReceipt(makeCommitData() as any, receiptRoot);
    expect(path.basename(r1)).toBe('slice-output-001.json');

    // Manually verify the file is actually on disk with correct name
    const dir = path.dirname(r1);
    const files = fs.readdirSync(dir);
    expect(files).toContain('slice-output-001.json');
    expect(files).not.toContain('slice-output-000.json');
  });
});

describe('writeSliceIntegrationReceipt — sequence numbering', () => {

  test('writes first receipt as integration-001.json', () => {
    const receiptRoot = path.join(tmpDir, 'receipts', 'integration');
    const data = makeIntegrationData();

    const result = writeSliceIntegrationReceipt(data as any, receiptRoot);
    expect(result).toContain('integration-001.json');
    expect(fs.existsSync(result)).toBe(true);
  });

  test('second consecutive call produces integration-002.json', () => {
    const receiptRoot = path.join(tmpDir, 'receipts', 'integration');

    const r1 = writeSliceIntegrationReceipt(makeIntegrationData() as any, receiptRoot);
    expect(r1).toContain('integration-001.json');

    const r2 = writeSliceIntegrationReceipt(makeIntegrationData() as any, receiptRoot);
    expect(r2).toContain('integration-002.json');
  });
});

describe('validateAndWriteSliceCommitReceipt (P1-3)', () => {

  test('rejects non-existent commit SHA', () => {
    const badSha = '0000000000000000000000000000000000000000';
    const data = makeCommitData({ slice_commit_sha: badSha });

    expect(() => {
      validateAndWriteSliceCommitReceipt(data as any, tmpDir);
    }).toThrow(/not a valid Git commit/);
  });

  test('rejects commit SHA that is pre_commit_head (identical)', () => {
    // The schema's superRefine catches pre_commit_head === slice_commit_sha.
    // Provide a bad SHA (won't exist) and set both params to the same value.
    const badSha = '0000000000000000000000000000000000000000';
    const data = makeCommitData({ slice_commit_sha: badSha, pre_commit_head: badSha });

    expect(() => {
      validateAndWriteSliceCommitReceipt(data as any, tmpDir);
    }).toThrow();
  });

  test('rejects when CV receipt does not exist at referenced path', () => {
    // Let makeCommitData create its own commit internally; override
    // cv_receipt_ref to a non-existent path.
    const data = makeCommitData({
      cv_receipt_ref: 'nonexistent/path/initial-001.json',
      cv_receipt_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });

    expect(() => {
      validateAndWriteSliceCommitReceipt(data as any, tmpDir);
    }).toThrow(/CV receipt not found/);
  });

  test('rejects when CV receipt digest does not match', () => {
    // Let makeCommitData create its own commit and CV receipt internally;
    // override cv_receipt_digest to a wrong value.
    const data = makeCommitData({
      cv_receipt_digest: '0000000000000000000000000000000000000000000000000000000000000000',
    });

    expect(() => {
      validateAndWriteSliceCommitReceipt(data as any, tmpDir);
    }).toThrow(/digest mismatch/);
  });

  test('succeeds with valid data and writes receipt', () => {
    const receiptRoot = path.join(tmpDir, 'receipts', 'committer');
    // makeCommitData handles all state internally
    const data = makeCommitData();

    const result = validateAndWriteSliceCommitReceipt(data as any, tmpDir, receiptRoot);
    expect(result).toContain('slice-output-001.json');
    expect(fs.existsSync(result)).toBe(true);

    // Verify content
    const parsed = JSON.parse(fs.readFileSync(result, 'utf-8'));
    expect(parsed.status).toBe('committed');
  });
});

describe('validateAndWriteSliceIntegrationReceipt (P1-3)', () => {

  test('rejects non-existent commit SHA', () => {
    const badSha = '0000000000000000000000000000000000000000';
    const data = makeIntegrationData({ slice_commit_sha: badSha });

    expect(() => {
      validateAndWriteSliceIntegrationReceipt(data as any, tmpDir);
    }).toThrow(/not a valid Git commit/);
  });

  test('rejects when CV receipt does not exist', () => {
    const commitSha = createCommit('test-int-cv.txt', 'int-cv-test');
    const data = makeIntegrationData({
      slice_commit_sha: commitSha,
      cv_receipt_ref: 'missing/cv/receipt.json',
    });

    expect(() => {
      validateAndWriteSliceIntegrationReceipt(data as any, tmpDir);
    }).toThrow(/CV receipt not found/);
  });

  test('succeeds with valid data and writes receipt', () => {
    const commitSha = createCommit('test-int-valid.txt', 'int-valid-test');
    const receiptRoot = path.join(tmpDir, 'receipts', 'integration');
    const data = makeIntegrationData({ slice_commit_sha: commitSha });

    const result = validateAndWriteSliceIntegrationReceipt(data as any, tmpDir, receiptRoot);
    expect(result).toContain('integration-001.json');
    expect(fs.existsSync(result)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(result, 'utf-8'));
    expect(parsed.slice_commit_sha).toBe(commitSha);
    expect(parsed.status).toBe('integrated');
  });
});
