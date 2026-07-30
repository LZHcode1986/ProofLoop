import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import { runStageFromManifest, runStageCli } from '../src/run-stage.js';
import { cleanupServices } from '../src/process-manager.js';

// ── Helpers ─────────────────────────────────────────────────────────────────────

let tmpDir: string;

function writeManifest(name: string, content: object): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8');
  return filePath;
}

/** Read a JSON receipt from disk and return the parsed object. */
function readReceipt(receiptPath: string): Record<string, unknown> {
  if (!existsSync(receiptPath)) {
    throw new Error(`Receipt file not found: ${receiptPath}`);
  }
  return JSON.parse(readFileSync(receiptPath, 'utf-8'));
}

const BASE_MANIFEST = {
  source_path: 'test',
  source_digest: 'test',
  stage_goal: 'Integration test',
  outcomes: ['OUT-01'],
  slices: [],
};

// ── Slice Boundary Helper ─────────────────────────────────────────────────────

/**
 * Initialize a minimal git repo with at least two commits so that
 * pre_commit_head !== slice_commit_ha (required by SliceCommitReceipt superRefine).
 * Returns the slice commit SHA and the parent commit SHA.
 */
function initRepoWithSlice(baseDir: string): { sliceCommitSha: string; preCommitHead: string } {
  execFileSync('git', ['init'], { cwd: baseDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: baseDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: baseDir, stdio: 'pipe' });
  writeFileSync(join(baseDir, 'base.txt'), 'base');
  execFileSync('git', ['add', '.'], { cwd: baseDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: baseDir, stdio: 'pipe' });
  const preCommitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseDir, encoding: 'utf8' }).trim();
  writeFileSync(join(baseDir, 'output.txt'), 'content');
  execFileSync('git', ['add', '.'], { cwd: baseDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'slice output'], { cwd: baseDir, stdio: 'pipe' });
  const sliceCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseDir, encoding: 'utf8' }).trim();
  return { sliceCommitSha, preCommitHead };
}

/**
 * Create a complete slice boundary (CV PASS + Committer Receipt + Integration Receipt)
 * in canonical locations under baseDir. Requires a git repo with at least two commits.
 */
function createSliceBoundary(
  baseDir: string,
  stageId: string,
  sliceId: string,
  options?: {
    commitSha?: string;
    preCommitHead?: string;
    snapshot?: string;
    /** If true, creates receipts in a tmp subdir (not canonical) to test failure paths. */
    nonCanonical?: boolean;
  },
): {
  cvPath: string;
  commitReceiptPath: string;
  integrationReceiptPath: string;
  commitSha: string;
} {
  const snapshot = options?.snapshot ?? 'a'.repeat(16);
  const commitSha = options?.commitSha ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseDir, encoding: 'utf8' }).trim();
  const preCommitHead = options?.preCommitHead ?? (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: baseDir, encoding: 'utf8' }).trim();
    } catch {
      return commitSha;
    }
  })();
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseDir, encoding: 'utf8' }).trim();

  // If nonCanonical, create receipts in baseDir directly (not under .proofloop)
  if (options?.nonCanonical) {
    const cvPath = join(baseDir, 'cv-pass.json');
    writeFileSync(cvPath, JSON.stringify({
      stage_id: stageId, slice_id: sliceId, snapshot,
      cv_level: 'standard', verification_type: 'initial',
      verdict: 'PASS', failed_po_ids: [],
    }));
    const integrationPath = join(baseDir, 'integration.json');
    writeFileSync(integrationPath, JSON.stringify({
      stage_id: stageId, slice_id: sliceId, commit_sha: commitSha, status: 'integrated',
    }));
    return { cvPath, commitReceiptPath: join(baseDir, 'slice-output-001.json'), integrationReceiptPath: integrationPath, commitSha };
  }

  // CV receipt in canonical location
  const cvDir = join(baseDir, '.proofloop', 'receipts', 'cv', stageId, sliceId);
  mkdirSync(cvDir, { recursive: true });
  const cvPath = join(cvDir, 'initial-001.json');
  const cvData = {
    stage_id: stageId, slice_id: sliceId, snapshot,
    cv_level: 'standard', verification_type: 'initial',
    verdict: 'PASS', failed_po_ids: [],
  };
  writeFileSync(cvPath, JSON.stringify(cvData));
  const cvDigest = crypto.createHash('sha256').update(readFileSync(cvPath)).digest('hex');

  // Committer receipt in canonical location
  const committerDir = join(baseDir, '.proofloop', 'receipts', 'committer', stageId, sliceId);
  mkdirSync(committerDir, { recursive: true });
  const commitReceiptPath = join(committerDir, 'slice-output-001.json');
  writeFileSync(commitReceiptPath, JSON.stringify({
    stage_id: stageId, slice_id: sliceId, status: 'committed',
    pre_commit_head: preCommitHead,
    slice_commit_sha: commitSha,
    manifest_digest: 'a'.repeat(16),
    cv_receipt_ref: cvPath,
    cv_receipt_digest: cvDigest,
    verified_snapshot: snapshot,
    tasks_path: 'tasks.json',
    evidence_path: 'evidence.json',
    changed_files: ['output.txt'],
    created_at: new Date().toISOString(),
  }));

  // Integration receipt in canonical location
  const integrationDir = join(baseDir, '.proofloop', 'receipts', 'integration', stageId, sliceId);
  mkdirSync(integrationDir, { recursive: true });
  const integrationReceiptPath = join(integrationDir, 'integration-001.json');
  writeFileSync(integrationReceiptPath, JSON.stringify({
    stage_id: stageId, slice_id: sliceId, status: 'integrated',
    slice_commit_sha: commitSha,
    stage_head_before: preCommitHead,
    integrated_commit_sha: headSha,
    stage_head_after: headSha,
    cv_receipt_ref: cvPath,
    verified_snapshot: snapshot,
    post_merge_snapshot: 'b'.repeat(16),
    post_merge_checks: [],
    created_at: new Date().toISOString(),
  }));

  return { cvPath, commitReceiptPath, integrationReceiptPath, commitSha };
}

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'run-stage-test-')));
});

afterEach(async () => {
  // Clean up any globally-registered services between tests
  await cleanupServices();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('runStageFromManifest', () => {

  describe('正向路径 — 完整编排', () => {
    test('service_start → probe → service_stop 按序执行, verdict PASS', async () => {
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: 'S99-TEST',
        runtime_proof: [
          {
            id: 'app-start',
            type: 'service_start',
            executable: 'node',
            args: [
              '-e',
              // Use function syntax (no arrow functions) and comma operator (no semicolons)
              // to avoid triggering shell operator detection
              'setTimeout(function() { console.log("ready"), setInterval(function() {}, 60000) }, 200)',
            ],
            readiness_signal: 'ready',
            timeout_ms: 5000,
          },
          {
            id: 'smoke',
            type: 'probe',
            executable: 'node',
            args: ['-e', 'console.log("smoke ok")'],
            expected: { output_contains: 'smoke ok' },
          },
          {
            id: 'app-stop',
            type: 'service_stop',
            executable: 'node',
            args: [],
            service_ref: 'app-start',
          },
        ],
      };

      const manifestPath = writeManifest('happy-path.json', manifest);
      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
      });

      // Step 执行结果
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.stepCount).toBe(3);
      expect(result.receiptPath).toBeDefined();

      // 验证 Receipt 内容
      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('PASS');
      expect(receipt.stage_id).toBe('S99-TEST');
      expect((receipt.steps as Array<{ id: string; exit_code: number }>)).toHaveLength(3);

      // 验证每个步骤存在且 exit_code 为 0
      const steps = receipt.steps as Array<{ id: string; exit_code: number }>;
      expect(steps[0].id).toBe('app-start');
      expect(steps[0].exit_code).toBe(0);
      expect(steps[1].id).toBe('smoke');
      expect(steps[1].exit_code).toBe(0);
      expect(steps[2].id).toBe('app-stop');
      expect(steps[2].exit_code).toBe(0);

      // 验证 service_cleanup: 服务被显式 stop 而非依赖 cleanup 兜底
      expect(receipt.service_cleanup).toBeDefined();
      const serviceCleanup = receipt.service_cleanup as {
        cleaned: string[];
        failed: Array<{ service: string; pid: number; reason: string }>;
        remainingPids: number[];
      };
      expect(serviceCleanup.cleaned).toHaveLength(0);
      expect(serviceCleanup.failed).toHaveLength(0);
      expect(serviceCleanup.remainingPids).toHaveLength(0);
    }, 20000);
  });

  describe('Slice COMPLETE facts gate PASS', () => {
    test('successful runtime proof cannot PASS when slice commit/integration facts are absent', async () => {
      const manifestPath = writeManifest('missing-slice-facts.json', {
        ...BASE_MANIFEST, stage_id: 'S99-FACTS', slices: [{ slice_id: 'S99-A', goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
        runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
      });
      const result = await runStageFromManifest({ manifestPath, outputDir: tmpDir });
      expect(result.success).toBe(false);
      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('FAIL');
      expect(result.errors.join(' ')).toMatch(/Slice COMPLETE facts/i);
    });

    test('successful runtime proof cannot PASS from placeholder or nonexistent evidence refs', async () => {
      const manifestPath = writeManifest('placeholder-facts.json', {
        ...BASE_MANIFEST, stage_id: 'S99-FACTS2', slices: [{ slice_id: 'S99-A', goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
        runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
      });
      const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const result = await runStageFromManifest({
        manifestPath, outputDir: tmpDir,
        sliceCompleteFacts: [{ slice_id: 'S99-A', cv: { verdict: 'PASS', receipt_ref: 'missing-cv.json' }, commit: { commit_sha: commitSha, receipt_ref: 'committer/missing.json' }, integration: { integration_ref: 'missing-integration.json' } }],
      });
      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toMatch(/CV receipt.*not found or is outside trust root/i);
      expect(readReceipt(result.receiptPath!).verdict).toBe('FAIL');
    });

    test('integration evidence must be a persisted identity-bound record, not a label or unrelated artifact', async () => {
      const stageId = 'S99-INTEGRATION';
      const sliceId = 'S99-A';
      const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'run-stage-int-repo-')));
      try {
        const { sliceCommitSha } = initRepoWithSlice(repoDir);
        const manifestPath = writeManifest('unbound-integration.json', {
          ...BASE_MANIFEST, stage_id: stageId, slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
          runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        // Place CV receipt inside repoDir so it resolves, but no committer receipt exists
        const cvPath = join(repoDir, 'cv-pass-unbound.json');
        const integrationPath = join(tmpDir, 'integration-unbound.json');
        writeFileSync(cvPath, JSON.stringify({
          stage_id: stageId, slice_id: sliceId, snapshot: 'a'.repeat(16), cv_level: 'standard',
          verification_type: 'initial', verdict: 'PASS', failed_po_ids: [],
        }));
        writeFileSync(integrationPath, 'integration complete');

        // Missing committer receipt — gate fails before checking integration
        const result = await runStageFromManifest({
          manifestPath, outputDir: tmpDir, projectRoot: repoDir,
          sliceCompleteFacts: [{ slice_id: sliceId, cv: { verdict: 'PASS', receipt_ref: cvPath }, commit: { commit_sha: sliceCommitSha, receipt_ref: 'committer/slice-output-001.json' }, integration: { integration_ref: integrationPath } }],
        });
        expect(result.success).toBe(false);
        expect(result.errors.join(' ')).toMatch(/invalid Committer Receipt at/i);

        // Set up canonical receipts, but overwrite the integration receipt with a wrong
        // slice_commit_sha so findLatestIntegrationReceipt refuses it.
        const boundary = createSliceBoundary(repoDir, stageId, sliceId, { commitSha: sliceCommitSha });
        const intDir = join(repoDir, '.proofloop', 'receipts', 'integration', stageId, sliceId);
        // Write integration with a DIFFERENT slice_commit_sha → findLatestIntegrationReceipt won't match
        const otherSha = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repoDir, encoding: 'utf8' }).trim();
        writeFileSync(join(intDir, 'integration-002.json'), JSON.stringify({
          stage_id: stageId, slice_id: sliceId, status: 'integrated',
          slice_commit_sha: otherSha,  // wrong! doesn't match sliceCommitSha
          stage_head_before: otherSha,
          integrated_commit_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim(),
          stage_head_after: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim(),
          cv_receipt_ref: boundary.cvPath,
          verified_snapshot: 'a'.repeat(16),
          post_merge_snapshot: 'b'.repeat(16),
          post_merge_checks: [],
          created_at: new Date().toISOString(),
        }));
        // Now the canonical integration-002.json has wrong slice_commit_sha so it's skipped.
        // But integration-001.json (from createSliceBoundary) has the right SHA, so it IS found.
        // So we need to remove integration-001.json to force the failure.
        rmSync(join(intDir, 'integration-001.json'));
        const mismatched = await runStageFromManifest({
          manifestPath, outputDir: tmpDir, projectRoot: repoDir,
          sliceCompleteFacts: [{ slice_id: sliceId, cv: { verdict: 'PASS', receipt_ref: boundary.cvPath }, commit: { commit_sha: sliceCommitSha, receipt_ref: boundary.commitReceiptPath }, integration: { integration_ref: join(intDir, 'integration-002.json') } }],
        });
        expect(mismatched.success).toBe(false);
        expect(mismatched.errors.join(' ')).toMatch(/no valid Integration Receipt found/i);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    test('successful runtime proof PASS requires real persisted CV, commit, and integration artifacts', async () => {
      const stageId = 'S99-FACTS3';
      const sliceId = 'S99-A';
      const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'run-stage-pass-repo-')));
      try {
        const { sliceCommitSha } = initRepoWithSlice(repoDir);
        const manifestPath = writeManifest('with-slice-facts.json', {
          ...BASE_MANIFEST, stage_id: stageId, slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
          runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const boundary = createSliceBoundary(repoDir, stageId, sliceId, { commitSha: sliceCommitSha });

        const result = await runStageFromManifest({
          manifestPath, outputDir: tmpDir, projectRoot: repoDir,
          sliceCompleteFacts: [{ slice_id: sliceId, cv: { verdict: 'PASS', receipt_ref: boundary.cvPath }, commit: { commit_sha: sliceCommitSha, receipt_ref: boundary.commitReceiptPath }, integration: { integration_ref: boundary.integrationReceiptPath } }],
        });
        expect(result.success).toBe(true);
        const receipt = readReceipt(result.receiptPath!);
        expect(receipt.verdict).toBe('PASS');
        expect(receipt.slice_complete_facts).toEqual(expect.arrayContaining([
          expect.objectContaining({ slice_id: sliceId }),
        ]));
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('负向路径 1 — readiness 前进程退出', () => {
    test('进程立即退出无法输出 readiness_signal, verdict FAIL', async () => {
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: 'S99-FAIL1',
        runtime_proof: [
          {
            id: 'fail-start',
            type: 'service_start',
            executable: 'node',
            args: ['-e', 'process.exit(1)'],
            readiness_signal: 'ready',
            timeout_ms: 3000,
          },
          {
            id: 'fail-stop',
            type: 'service_stop',
            executable: 'node',
            args: [],
            service_ref: 'fail-start',
          },
        ],
      };

      const manifestPath = writeManifest('fail-readiness.json', manifest);
      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(
        result.errors.some((e) => e.includes('process exited') || e.includes('readiness')),
      ).toBe(true);
      expect(result.stepCount).toBe(2);
      expect(result.receiptPath).toBeDefined();

      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('FAIL');
    }, 15000);
  });

  describe('负向路径 2 — service_ref 不存在', () => {
    test('service_stop 引用不存在的 service id, 拓扑校验拦截, verdict FAIL', async () => {
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: 'S99-FAIL2',
        runtime_proof: [
          {
            id: 'stop-nonexistent',
            type: 'service_stop',
            executable: 'node',
            args: [],
            service_ref: 'no-such-service',
          },
        ],
      };

      const manifestPath = writeManifest('fail-ref.json', manifest);
      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('STOP_REF_MISSING'))).toBe(true);
      expect(result.stepCount).toBe(0);
    }, 15000);
  });

  describe('负向路径 3 — probe 失败', () => {
    test('probe exit_code != 0, verdict FAIL', async () => {
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: 'S99-FAIL3',
        runtime_proof: [
          {
            id: 'fail-probe',
            type: 'probe',
            executable: 'node',
            args: ['-e', 'process.exit(1)'],
          },
        ],
      };

      const manifestPath = writeManifest('fail-probe.json', manifest);
      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('exited with code 1'))).toBe(true);
      expect(result.stepCount).toBe(1);

      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('FAIL');
    }, 15000);
  });

  describe('负向路径 4 — service_start 缺少 service_stop', () => {
    test('service_start 没有匹配的 service_stop, 拓扑校验拦截, verdict FAIL', async () => {
      // 设计约束：每个 service_start 必须有匹配的 service_stop。
      // 缺少 service_stop 时，入口处的拓扑校验直接返回 FAIL，
      // 不会启动任何进程。
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: 'S99-CLEANUP',
        runtime_proof: [
          {
            id: 'linger-service',
            type: 'service_start',
            executable: 'node',
            args: [
              '-e',
              'setTimeout(function() { console.log("ready"), setInterval(function() {}, 60000) }, 100)',
            ],
            readiness_signal: 'ready',
            timeout_ms: 5000,
          },
        ],
      };

      const manifestPath = writeManifest('cleanup.json', manifest);
      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
      });

      // 拓扑校验失败，不会执行步骤
      expect(result.success).toBe(false);
      expect(result.stepCount).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('SERVICE_START_WITHOUT_STOP'))).toBe(true);
    }, 15000);
  });

  describe('负向路径 5 — 全部标记 not_applicable', () => {
    test('所有步骤都是 not_applicable, verdict FAIL', async () => {
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: 'S99-ALLNA',
        runtime_proof: [
          {
            id: 'step-1',
            type: 'probe',
            executable: 'node',
            args: ['-e', 'console.log("hello")'],
            not_applicable: { reason: 'Environment does not support this check' },
          },
          {
            id: 'step-2',
            type: 'probe',
            executable: 'node',
            args: ['-e', 'console.log("world")'],
            not_applicable: { reason: 'Feature not enabled in this configuration' },
          },
        ],
      };

      const manifestPath = writeManifest('all-na.json', manifest);
      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('ALL_STEPS_SKIPPED'))).toBe(true);
      expect(result.stepCount).toBe(2);
      expect(result.receiptPath).toBeDefined();

      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('FAIL');
    }, 15000);
  });

describe('CLI — runStageCli facts file validation', () => {
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    test('missing facts path argument → exit 1 with usage error', async () => {
      const code = await runStageCli(['manifest.json']);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage/));
    });

    test('facts file not found → exit 1 with clear error', async () => {
      const code = await runStageCli(['manifest.json', join(tmpDir, 'nonexistent-facts.json'), tmpDir]);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/not found/));
    });

    test('malformed JSON in facts file → exit 1 with clear error', async () => {
      const factsPath = join(tmpDir, 'bad-facts.json');
      writeFileSync(factsPath, 'not json', 'utf-8');
      const code = await runStageCli(['manifest.json', factsPath, tmpDir]);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Failed to parse/));
    });

    test('non-array facts file → exit 1 with clear error', async () => {
      const factsPath = join(tmpDir, 'scalar-facts.json');
      writeFileSync(factsPath, '"just a string"', 'utf-8');
      const code = await runStageCli(['manifest.json', factsPath, tmpDir]);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/must contain a JSON array/));
    });

    test('object instead of array → exit 1 with clear error', async () => {
      const factsPath = join(tmpDir, 'object-facts.json');
      writeFileSync(factsPath, JSON.stringify({ slice_id: 'x' }), 'utf-8');
      const code = await runStageCli(['manifest.json', factsPath, tmpDir]);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/must contain a JSON array/));
    });
  });

  describe('CLI — runStageCli one-slice PASS with persisted evidence', () => {
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    const stageId = 'S99-CLIPASS';
    const sliceId = 'S99-A';

    beforeEach(() => {
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    test('one-slice PASS via CLI — exit 0 with receipt on disk', async () => {
      const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'run-stage-cli-pass-repo-')));
      try {
        const { sliceCommitSha } = initRepoWithSlice(repoDir);
        // ── Write manifest ──
        const manifest = {
          ...BASE_MANIFEST,
          stage_id: stageId,
          slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
          runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        };
        const manifestPath = writeManifest('cli-pass-manifest.json', manifest);

        // ── Create canonical receipts ──
        const boundary = createSliceBoundary(repoDir, stageId, sliceId, { commitSha: sliceCommitSha });

        // ── Write facts file ──
        const factsPath = join(tmpDir, 'cli-pass-facts.json');
        writeFileSync(factsPath, JSON.stringify([{
          slice_id: sliceId,
          cv: { verdict: 'PASS', receipt_ref: boundary.cvPath },
          commit: { commit_sha: sliceCommitSha, receipt_ref: boundary.commitReceiptPath },
          integration: { integration_ref: boundary.integrationReceiptPath },
        }]));

        // ── Run CLI handler ──
        const code = await runStageCli([manifestPath, factsPath, tmpDir, repoDir]);
        expect(code).toBe(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Stage Gate PASSED/));

        // ── Verify receipt on disk with correct verdict and persisted fact paths ──
        const dirFiles = readdirSync(tmpDir);
        const receiptFile = dirFiles.find((f: string) => f.startsWith('stage-gate-'));
        expect(receiptFile).toBeDefined();
        const receipt = JSON.parse(readFileSync(join(tmpDir, receiptFile!), 'utf-8'));
        expect(receipt.verdict).toBe('PASS');
        expect(receipt.stage_id).toBe(stageId);
        expect(receipt.slice_complete_facts).toHaveLength(1);
        expect(receipt.slice_complete_facts[0].slice_id).toBe(sliceId);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }, 30000);

    test('missing facts entries for manifest slice → exit 1 with FAIL verdict', async () => {
      // One-slice manifest but empty facts array
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: 'S99-CLIFAIL1',
        slices: [{ slice_id: 'S99-A', goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
        runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
      };
      const manifestPath = writeManifest('cli-fail-empty-facts-manifest.json', manifest);
      const factsPath = join(tmpDir, 'cli-fail-empty-facts.json');
      writeFileSync(factsPath, JSON.stringify([]));

      const code = await runStageCli([manifestPath, factsPath, tmpDir]);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Stage Gate FAILED/));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Slice COMPLETE facts must contain exactly one fact/));
    }, 30000);

    test('invalid SliceCompleteFacts entry in file → exit 1 with FAIL', async () => {
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: 'S99-CLIFAIL2',
        slices: [{ slice_id: 'S99-A', goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
        runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
      };
      const manifestPath = writeManifest('cli-fail-bad-fact-manifest.json', manifest);
      // Facts array with an entry that has wrong shape (missing commit field)
      const factsPath = join(tmpDir, 'cli-fail-bad-fact.json');
      writeFileSync(factsPath, JSON.stringify([{
        slice_id: 'S99-A',
        cv: { verdict: 'PASS', receipt_ref: 'some-path' },
        // Missing commit and integration
      }]));

      const code = await runStageCli([manifestPath, factsPath, tmpDir]);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Stage Gate FAILED/));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/invalid/));
    }, 30000);
  });

  describe('Commit MUST be HEAD validation', () => {
    test('Gate FAIL when commit_sha is a valid historical commit but not HEAD', async () => {
      const stageId = 'S99-HEADCHECK';
      const sliceId = 'S99-A';
      const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'run-stage-headcheck-repo-')));
      try {
        // Create a proper repo with base commit and slice commit.
        const { sliceCommitSha } = initRepoWithSlice(repoDir);

        // Create a non-HEAD commit using commit-tree.
        const treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoDir, encoding: 'utf8' }).trim();
        const nonHeadSha = execFileSync('git', ['commit-tree', treeSha, '-m', 'temp non-HEAD commit for test'], {
          cwd: repoDir, encoding: 'utf8',
          env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
        }).trim();
        expect(nonHeadSha).not.toBe(sliceCommitSha);

        // Create a proper receipt chain for sliceCommitSha (HEAD)
        const boundary = createSliceBoundary(repoDir, stageId, sliceId, { commitSha: sliceCommitSha });

        const manifestPath = writeManifest('historical-commit-fail.json', {
          ...BASE_MANIFEST,
          stage_id: stageId,
          slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
          runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });

        // Facts reference nonHeadSha, but committer receipt has sliceCommitSha.
        const result = await runStageFromManifest({
          manifestPath, outputDir: tmpDir, projectRoot: repoDir,
          sliceCompleteFacts: [{
            slice_id: sliceId,
            cv: { verdict: 'PASS', receipt_ref: boundary.cvPath },
            commit: { commit_sha: nonHeadSha, receipt_ref: boundary.commitReceiptPath },
            integration: { integration_ref: boundary.integrationReceiptPath },
          }],
        });

        expect(result.success).toBe(false);
        // validateFactCommitReceipt checks slice_commit_sha mismatch and returns null
        expect(result.errors.join(' ')).toMatch(/invalid Committer Receipt at/i);
        const receipt = readReceipt(result.receiptPath!);
        expect(receipt.verdict).toBe('FAIL');
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('Patch 7 — 三方绑定验证', () => {

    test('从项目外运行 — process.cwd() != projectRoot, 验证 Git / Snapshot / cwd 均使用 projectRoot', async () => {
      const stageId = 'S99-OUTSIDE';
      const sliceId = 'S99-A';
      // Create a git repo in a separate directory (not tmpDir).
      const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'run-stage-outside-repo-')));
      try {
        const { sliceCommitSha } = initRepoWithSlice(repoDir);

        // Manifest goes to tmpDir (where process.cwd() is).
        const manifestPath = writeManifest('outside-manifest.json', {
          ...BASE_MANIFEST,
          stage_id: stageId,
          slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
          runtime_proof: [
            { id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] },
          ],
        });

        // Create canonical receipts inside repoDir.
        const boundary = createSliceBoundary(repoDir, stageId, sliceId, { commitSha: sliceCommitSha });

        // Run with projectRoot = repoDir, while process.cwd() != repoDir.
        const result = await runStageFromManifest({
          manifestPath,
          outputDir: tmpDir,
          projectRoot: repoDir,
          sliceCompleteFacts: [{
            slice_id: sliceId,
            cv: { verdict: 'PASS', receipt_ref: boundary.cvPath },
            commit: { commit_sha: sliceCommitSha, receipt_ref: boundary.commitReceiptPath },
            integration: { integration_ref: boundary.integrationReceiptPath },
          }],
        });

        expect(result.success).toBe(true);
        expect(result.errors).toHaveLength(0);
        const receipt = readReceipt(result.receiptPath!);
        expect(receipt.verdict).toBe('PASS');
        // Verify snapshot is computed from projectRoot, not process.cwd()
        expect(receipt.snapshot).toBeDefined();
        expect(typeof receipt.snapshot).toBe('string');
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }, 30000);

    test('Snapshot 错配 — CV Receipt.snapshot !== Committer Receipt.verified_snapshot, 必须 FAIL', async () => {
      const stageId = 'S99-SNAPFAIL';
      const sliceId = 'S99-A';
      const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'run-stage-snap-repo-')));
      try {
        const { sliceCommitSha } = initRepoWithSlice(repoDir);
        const manifestPath = writeManifest('snap-mismatch.json', {
          ...BASE_MANIFEST,
          stage_id: stageId,
          slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
          runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });

        // Create CV receipt with snapshot 'aaaaaaaaaaaaaaaa'
        const cvDir = join(repoDir, '.proofloop', 'receipts', 'cv', stageId, sliceId);
        mkdirSync(cvDir, { recursive: true });
        const cvPath = join(cvDir, 'initial-001.json');
        writeFileSync(cvPath, JSON.stringify({
          stage_id: stageId, slice_id: sliceId, snapshot: 'aaaaaaaaaaaaaaaa',
          cv_level: 'standard', verification_type: 'initial',
          verdict: 'PASS', failed_po_ids: [],
        }));
        const cvDigest = crypto.createHash('sha256').update(readFileSync(cvPath)).digest('hex');

        // Create committer receipt with DIFFERENT snapshot (verified_snapshot: 'bbbbbbbbbbbbbbbb')
        const committerDir = join(repoDir, '.proofloop', 'receipts', 'committer', stageId, sliceId);
        mkdirSync(committerDir, { recursive: true });
        const commitReceiptPath = join(committerDir, 'slice-output-001.json');
        writeFileSync(commitReceiptPath, JSON.stringify({
          stage_id: stageId, slice_id: sliceId, status: 'committed',
          pre_commit_head: execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repoDir, encoding: 'utf8' }).trim(),
          slice_commit_sha: sliceCommitSha,
          manifest_digest: 'a'.repeat(16),
          cv_receipt_ref: cvPath,
          cv_receipt_digest: cvDigest,  // correct digest of CV receipt
          verified_snapshot: 'bbbbbbbbbbbbbbbb',  // WRONG — doesn't match CV snapshot
          tasks_path: 'tasks.json', evidence_path: 'evidence.json',
          changed_files: ['output.txt'],
          created_at: new Date().toISOString(),
        }));

        // Create integration receipt (also with wrong snapshot)
        const intDir = join(repoDir, '.proofloop', 'receipts', 'integration', stageId, sliceId);
        mkdirSync(intDir, { recursive: true });
        writeFileSync(join(intDir, 'integration-001.json'), JSON.stringify({
          stage_id: stageId, slice_id: sliceId, status: 'integrated',
          slice_commit_sha: sliceCommitSha,
          stage_head_before: execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repoDir, encoding: 'utf8' }).trim(),
          integrated_commit_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim(),
          stage_head_after: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim(),
          cv_receipt_ref: cvPath,
          verified_snapshot: 'bbbbbbbbbbbbbbbb',  // WRONG
          post_merge_snapshot: 'c'.repeat(16),
          post_merge_checks: [],
          created_at: new Date().toISOString(),
        }));

        const result = await runStageFromManifest({
          manifestPath, outputDir: tmpDir, projectRoot: repoDir,
          sliceCompleteFacts: [{
            slice_id: sliceId,
            cv: { verdict: 'PASS', receipt_ref: cvPath },
            commit: { commit_sha: sliceCommitSha, receipt_ref: commitReceiptPath },
            integration: { integration_ref: join(intDir, 'integration-001.json') },
          }],
        });

        expect(result.success).toBe(false);
        // validateFactCommitReceipt does not check snapshot; it accepts the receipt.
        // findLatestIntegrationReceipt validates snapshot and rejects the integration.
        expect(result.errors.join(' ')).toMatch(/no valid Integration Receipt found/i);
        const receipt = readReceipt(result.receiptPath!);
        expect(receipt.verdict).toBe('FAIL');
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }, 30000);

    test('Commit 错配 — fact.commit.commit_sha !== Committer Receipt.slice_commit_sha, 必须 FAIL', async () => {
      const stageId = 'S99-COMMITFAIL';
      const sliceId = 'S99-A';
      const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'run-stage-commit-repo-')));
      try {
        const { sliceCommitSha } = initRepoWithSlice(repoDir);
        // Create a proper receipt chain for sliceCommitSha.
        const boundary = createSliceBoundary(repoDir, stageId, sliceId, { commitSha: sliceCommitSha });

        // In the facts, use a DIFFERENT (non-existent) commit SHA
        const wrongSha = '0000000000000000000000000000000000000000';

        const manifestPath = writeManifest('commit-mismatch.json', {
          ...BASE_MANIFEST,
          stage_id: stageId,
          slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
          runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });

        const result = await runStageFromManifest({
          manifestPath, outputDir: tmpDir, projectRoot: repoDir,
          sliceCompleteFacts: [{
            slice_id: sliceId,
            cv: { verdict: 'PASS', receipt_ref: boundary.cvPath },
            commit: { commit_sha: wrongSha, receipt_ref: boundary.commitReceiptPath },
            integration: { integration_ref: boundary.integrationReceiptPath },
          }],
        });

        expect(result.success).toBe(false);
        // validateFactCommitReceipt checks slice_commit_sha mismatch and returns null
        expect(result.errors.join(' ')).toMatch(/invalid Committer Receipt at/i);
        const receipt = readReceipt(result.receiptPath!);
        expect(receipt.verdict).toBe('FAIL');
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }, 30000);

    test('Integration 错配 — Integration Receipt.slice_commit_sha !== fact.commit.commit_sha, 必须 FAIL', async () => {
      const stageId = 'S99-INTFAIL';
      const sliceId = 'S99-A';
      const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'run-stage-int-repo-')));
      try {
        const { sliceCommitSha } = initRepoWithSlice(repoDir);
        // Create a proper receipt chain.
        const boundary = createSliceBoundary(repoDir, stageId, sliceId, { commitSha: sliceCommitSha });

        // Overwrite integration receipt with a wrong slice_commit_sha
        const intDir = join(repoDir, '.proofloop', 'receipts', 'integration', stageId, sliceId);
        rmSync(join(intDir, 'integration-001.json'));
        const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
        const preHead = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repoDir, encoding: 'utf8' }).trim();
        writeFileSync(join(intDir, 'integration-002.json'), JSON.stringify({
          stage_id: stageId, slice_id: sliceId, status: 'integrated',
          slice_commit_sha: '0000000000000000000000000000000000000000',  // wrong
          stage_head_before: preHead,
          integrated_commit_sha: headSha,
          stage_head_after: headSha,
          cv_receipt_ref: boundary.cvPath,
          verified_snapshot: 'a'.repeat(16),
          post_merge_snapshot: 'b'.repeat(16),
          post_merge_checks: [],
          created_at: new Date().toISOString(),
        }));

        const manifestPath = writeManifest('int-mismatch.json', {
          ...BASE_MANIFEST,
          stage_id: stageId,
          slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
          runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });

        const result = await runStageFromManifest({
          manifestPath, outputDir: tmpDir, projectRoot: repoDir,
          sliceCompleteFacts: [{
            slice_id: sliceId,
            cv: { verdict: 'PASS', receipt_ref: boundary.cvPath },
            commit: { commit_sha: sliceCommitSha, receipt_ref: boundary.commitReceiptPath },
            integration: { integration_ref: join(intDir, 'integration-002.json') },
          }],
        });

        expect(result.success).toBe(false);
        // findLatestIntegrationReceipt won't match because slice_commit_sha is wrong
        expect(result.errors.join(' ')).toMatch(/no valid Integration Receipt found/i);
        const receipt = readReceipt(result.receiptPath!);
        expect(receipt.verdict).toBe('FAIL');
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }, 30000);
  });

  describe('边界情况', () => {
    test('空 runtime_proof 数组导致 FAIL 和错误消息', async () => {
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: 'S99-EMPTY',
        runtime_proof: [],
      };

      const manifestPath = writeManifest('empty.json', manifest);
      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('zero steps'))).toBe(true);
      expect(result.stepCount).toBe(0);
      expect(result.receiptPath).toBeDefined();

      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('FAIL');
    }, 15000);

    test('manifest 文件不存在时返回错误', async () => {
      const result = await runStageFromManifest({
        manifestPath: join(tmpDir, 'nonexistent.json'),
        outputDir: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('Manifest not found'))).toBe(true);
      expect(result.stepCount).toBe(0);
    }, 15000);

    test('manifest JSON 无效时返回错误', async () => {
      writeFileSync(join(tmpDir, 'bad.json'), 'not valid json', 'utf-8');
      const result = await runStageFromManifest({
        manifestPath: join(tmpDir, 'bad.json'),
        outputDir: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('Failed to parse manifest'))).toBe(true);
      expect(result.stepCount).toBe(0);
    }, 15000);

    test('probe 的 expected.output_contains 验证失败时 FAIL', async () => {
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: 'S99-OUTPUT',
        runtime_proof: [
          {
            id: 'check-output',
            type: 'probe',
            executable: 'node',
            args: ['-e', 'console.log("actual output")'],
            expected: { output_contains: 'never appears in stdout' },
          },
        ],
      };

      const manifestPath = writeManifest('output-fail.json', manifest);
      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('does not contain expected text'))).toBe(true);

      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('FAIL');
    }, 15000);
  });

  describe('stage gate with real git commits', () => {
    let repoDir: string;
    let originalCwd: string;

    beforeAll(() => {
      originalCwd = process.cwd();
      repoDir = mkdtempSync(join(tmpdir(), 'stage-gate-repo-'));
      process.chdir(repoDir);
      execFileSync('git', ['init'], { stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test'], { stdio: 'pipe' });
      writeFileSync(join(repoDir, 'base.txt'), 'base');
      execFileSync('git', ['add', '.'], { stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'base'], { stdio: 'pipe' });
      // Normalise branch name to 'main' regardless of git version default
      const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
      if (currentBranch !== 'main') {
        execFileSync('git', ['branch', '-m', currentBranch, 'main'], { stdio: 'pipe' });
      }
    });

    afterAll(() => {
      process.chdir(originalCwd);
      if (repoDir) {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    /**
     * Create a feature branch, add files, commit, switch back to main,
     * and merge with --no-ff.  Returns the original slice commit SHA
     * (the branch tip before merge, which should be an ancestor of the
     * eventual merge commit HEAD).
     */
    function createSliceCommit(branchName: string, files: Record<string, string>): string {
      execFileSync('git', ['checkout', '-b', branchName], { stdio: 'pipe' });
      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = join(repoDir, filePath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
      }
      execFileSync('git', ['add', '.'], { stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', `slice: ${branchName}`], { stdio: 'pipe' });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      execFileSync('git', ['checkout', 'main'], { stdio: 'pipe' });
      execFileSync('git', ['merge', '--no-ff', '--no-edit', branchName], { stdio: 'pipe' });
      return sha;
    }

    /**
     * Build canonical receipts (CV + Committer + Integration) for a slice
     * in the proper locations under repoDir.
     */
    function buildSliceReceipts(
      baseDir: string,
      stageId: string,
      sliceId: string,
      commitSha: string,
      preCommitHead: string,
    ): { cvPath: string; commitReceiptPath: string; integrationReceiptPath: string } {
      const snapshot = 'a'.repeat(16);
      // CV receipt
      const cvDir = join(baseDir, '.proofloop', 'receipts', 'cv', stageId, sliceId);
      mkdirSync(cvDir, { recursive: true });
      const cvPath = join(cvDir, 'initial-001.json');
      const cvData = {
        stage_id: stageId, slice_id: sliceId, snapshot,
        cv_level: 'standard', verification_type: 'initial',
        verdict: 'PASS', failed_po_ids: [],
      };
      writeFileSync(cvPath, JSON.stringify(cvData));
      const cvDigest = crypto.createHash('sha256').update(readFileSync(cvPath)).digest('hex');

      // Committer receipt
      const committerDir = join(baseDir, '.proofloop', 'receipts', 'committer', stageId, sliceId);
      mkdirSync(committerDir, { recursive: true });
      const commitReceiptPath = join(committerDir, 'slice-output-001.json');
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseDir, encoding: 'utf8' }).trim();
      writeFileSync(commitReceiptPath, JSON.stringify({
        stage_id: stageId, slice_id: sliceId, status: 'committed',
        pre_commit_head: preCommitHead,
        slice_commit_sha: commitSha,
        manifest_digest: 'a'.repeat(16),
        cv_receipt_ref: cvPath,
        cv_receipt_digest: cvDigest,
        verified_snapshot: snapshot,
        tasks_path: 'tasks.json', evidence_path: 'evidence.json',
        changed_files: ['output.txt'],
        created_at: new Date().toISOString(),
      }));

      // Integration receipt
      const integrationDir = join(baseDir, '.proofloop', 'receipts', 'integration', stageId, sliceId);
      mkdirSync(integrationDir, { recursive: true });
      const integrationReceiptPath = join(integrationDir, 'integration-001.json');
      writeFileSync(integrationReceiptPath, JSON.stringify({
        stage_id: stageId, slice_id: sliceId, status: 'integrated',
        slice_commit_sha: commitSha,
        stage_head_before: preCommitHead,
        integrated_commit_sha: headSha,
        stage_head_after: headSha,
        cv_receipt_ref: cvPath,
        verified_snapshot: snapshot,
        post_merge_snapshot: 'b'.repeat(16),
        post_merge_checks: [],
        created_at: new Date().toISOString(),
      }));

      return { cvPath, commitReceiptPath, integrationReceiptPath };
    }

    /**
     * Build a stage manifest + facts referencing canonical receipts.
     */
    function buildCanonicalManifestAndFacts(
      baseDir: string,
      stageId: string,
      sliceIds: string[],
      commitShas: string[],
      preCommitHeads: string[],
    ): { manifestPath: string; facts: Array<{
      slice_id: string;
      cv: { verdict: string; receipt_ref: string };
      commit: { commit_sha: string; receipt_ref: string };
      integration: { integration_ref: string };
    }> } {
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: stageId,
        slices: sliceIds.map((sliceId) => ({
          slice_id: sliceId,
          goal: 'x',
          observable_outcome: 'x',
          public_seam: 'x',
          evidence_path: 'x',
        })),
        runtime_proof: [
          { id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] },
        ],
      };
      const manifestPath = writeManifest(`real-git-${stageId}.json`, manifest);

      const facts: Array<{
        slice_id: string;
        cv: { verdict: string; receipt_ref: string };
        commit: { commit_sha: string; receipt_ref: string };
        integration: { integration_ref: string };
      }> = [];

      for (let i = 0; i < sliceIds.length; i++) {
        const sliceId = sliceIds[i];
        const commitSha = commitShas[i];
        const preCommitHead = preCommitHeads[i];
        const { cvPath, commitReceiptPath, integrationReceiptPath } = buildSliceReceipts(baseDir, stageId, sliceId, commitSha, preCommitHead);

        facts.push({
          slice_id: sliceId,
          cv: { verdict: 'PASS', receipt_ref: cvPath },
          commit: { commit_sha: commitSha, receipt_ref: commitReceiptPath },
          integration: { integration_ref: integrationReceiptPath },
        });
      }

      return { manifestPath, facts };
    }

    // ── Scenario A: Single slice + merge --no-ff ────────────────────────────
    test('单 Slice + merge --no-ff: ancestor check 通过', async () => {
      const sliceSha = createSliceCommit('slice-A', { 'output/file.txt': 'slice A output' });
      const preCommitHead = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repoDir, encoding: 'utf8' }).trim();
      const { manifestPath, facts } = buildCanonicalManifestAndFacts(repoDir, 'S99-GITA', ['S99-A'], [sliceSha], [preCommitHead]);

      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
        projectRoot: repoDir,
        sliceCompleteFacts: facts,
      });

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('PASS');
    }, 30000);

    // ── Scenario B: Two slices + merge --no-ff ───────────────────────────────
    test('两个独立 Slice + merge --no-ff: 多 Slice 都通过', async () => {
      const sliceASha = createSliceCommit('slice-B1', { 'output/b1.txt': 'slice B1 output' });
      const preA = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repoDir, encoding: 'utf8' }).trim();
      const sliceBSha = createSliceCommit('slice-B2', { 'output/b2.txt': 'slice B2 output' });
      const preB = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repoDir, encoding: 'utf8' }).trim();
      const { manifestPath, facts } = buildCanonicalManifestAndFacts(
        repoDir, 'S99-GITB', ['S99-B', 'S99-C'], [sliceASha, sliceBSha], [preA, preB],
      );

      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
        projectRoot: repoDir,
        sliceCompleteFacts: facts,
      });

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('PASS');
      expect(receipt.slice_complete_facts).toHaveLength(2);
    }, 30000);

    // ── Scenario C: Non-ancestor commit should be rejected ───────────────────
    test('非祖先 commit（属于未合并分支）被拒绝', async () => {
      // Create a commit on a branch that is never merged to main.
      // Its commit is NOT an ancestor of HEAD.
      execFileSync('git', ['checkout', '-b', 'unrelated'], { stdio: 'pipe' });
      writeFileSync(join(repoDir, 'unrelated.txt'), 'unrelated');
      execFileSync('git', ['add', '.'], { stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'unrelated commit'], { stdio: 'pipe' });
      const unrelatedSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      const unrelatedParent = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repoDir, encoding: 'utf8' }).trim();

      // Switch back to main — unrelated branch is never merged
      execFileSync('git', ['checkout', 'main'], { stdio: 'pipe' });

      // Create receipts for the unrelated commit. validateFactCommitReceipt will
      // reject it because it's not an ancestor of HEAD, so the gate fails.
      const { manifestPath, facts } = buildCanonicalManifestAndFacts(repoDir, 'S99-GITC', ['S99-D'], [unrelatedSha], [unrelatedParent]);

      const result = await runStageFromManifest({
        manifestPath,
        outputDir: tmpDir,
        projectRoot: repoDir,
        sliceCompleteFacts: facts,
      });

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toMatch(/invalid Committer Receipt at/i);
      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('FAIL');
    }, 30000);
  });
});
