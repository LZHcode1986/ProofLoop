import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'run-stage-test-'));
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
        sliceCompleteFacts: [{ slice_id: 'S99-A', cv: { verdict: 'PASS', receipt_ref: 'missing-cv.json' }, commit: { commit_sha: commitSha }, integration: { integration_ref: 'missing-integration.json' } }],
      });
      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toMatch(/persisted CV PASS, commit, and integration evidence/i);
      expect(readReceipt(result.receiptPath!).verdict).toBe('FAIL');
    });

    test('integration evidence must be a persisted identity-bound record, not a label or unrelated artifact', async () => {
      const stageId = 'S99-INTEGRATION';
      const sliceId = 'S99-A';
      const manifestPath = writeManifest('unbound-integration.json', {
        ...BASE_MANIFEST, stage_id: stageId, slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
        runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
      });
      const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const cvPath = join(tmpDir, 'cv-pass-unbound.json');
      const integrationPath = join(tmpDir, 'integration-unbound.json');
      writeFileSync(cvPath, JSON.stringify({
        stage_id: stageId, slice_id: sliceId, snapshot: 'a'.repeat(16), cv_level: 'standard',
        verification_type: 'initial', verdict: 'PASS', failed_po_ids: [],
      }));
      writeFileSync(integrationPath, 'integration complete');

      const result = await runStageFromManifest({
        manifestPath, outputDir: tmpDir,
        sliceCompleteFacts: [{ slice_id: sliceId, cv: { verdict: 'PASS', receipt_ref: cvPath }, commit: { commit_sha: commitSha }, integration: { integration_ref: integrationPath } }],
      });
      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toMatch(/persisted CV PASS, commit, and integration evidence/i);

      writeFileSync(integrationPath, JSON.stringify({
        stage_id: stageId, slice_id: 'S99-B', commit_sha: commitSha, status: 'integrated',
      }));
      const mismatched = await runStageFromManifest({
        manifestPath, outputDir: tmpDir,
        sliceCompleteFacts: [{ slice_id: sliceId, cv: { verdict: 'PASS', receipt_ref: cvPath }, commit: { commit_sha: commitSha }, integration: { integration_ref: integrationPath } }],
      });
      expect(mismatched.success).toBe(false);
    });

    test('successful runtime proof PASS requires real persisted CV, commit, and integration artifacts', async () => {
      const stageId = 'S99-FACTS3';
      const sliceId = 'S99-A';
      const manifestPath = writeManifest('with-slice-facts.json', {
        ...BASE_MANIFEST, stage_id: stageId, slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
        runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
      });
      const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const cvPath = join(tmpDir, 'cv-pass.json');
      const integrationPath = join(tmpDir, 'integration.json');
      writeFileSync(cvPath, JSON.stringify({
        stage_id: stageId, slice_id: sliceId, snapshot: 'a'.repeat(16), cv_level: 'standard',
        verification_type: 'initial', verdict: 'PASS', failed_po_ids: [],
      }));
      writeFileSync(integrationPath, JSON.stringify({ stage_id: stageId, slice_id: sliceId, commit_sha: commitSha, status: 'integrated' }));

      const result = await runStageFromManifest({
        manifestPath, outputDir: tmpDir,
        sliceCompleteFacts: [{ slice_id: sliceId, cv: { verdict: 'PASS', receipt_ref: cvPath }, commit: { commit_sha: commitSha }, integration: { integration_ref: integrationPath } }],
      });
      expect(result.success).toBe(true);
      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('PASS');
      expect(receipt.slice_complete_facts).toEqual(expect.arrayContaining([
        expect.objectContaining({ slice_id: sliceId, cv: expect.objectContaining({ receipt_ref: cvPath }), integration: expect.objectContaining({ integration_ref: integrationPath }) }),
      ]));
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
      // ── Write manifest ──
      const manifest = {
        ...BASE_MANIFEST,
        stage_id: stageId,
        slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
        runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
      };
      const manifestPath = writeManifest('cli-pass-manifest.json', manifest);

      // ── Write persisted evidence artifacts ──
      const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const cvPath = join(tmpDir, 'cli-cv-pass.json');
      const integrationPath = join(tmpDir, 'cli-integration.json');
      writeFileSync(cvPath, JSON.stringify({
        stage_id: stageId, slice_id: sliceId, snapshot: 'a'.repeat(16), cv_level: 'standard',
        verification_type: 'initial', verdict: 'PASS', failed_po_ids: [],
      }));
      writeFileSync(integrationPath, JSON.stringify({ stage_id: stageId, slice_id: sliceId, commit_sha: commitSha, status: 'integrated' }));

      // ── Write facts file ──
      const factsPath = join(tmpDir, 'cli-pass-facts.json');
      writeFileSync(factsPath, JSON.stringify([{
        slice_id: sliceId,
        cv: { verdict: 'PASS', receipt_ref: cvPath },
        commit: { commit_sha: commitSha },
        integration: { integration_ref: integrationPath },
      }]));

      // ── Run CLI handler ──
      const code = await runStageCli([manifestPath, factsPath, tmpDir]);
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

      // Obtain a valid historical commit that is guaranteed different from HEAD.
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const historicalSha = execFileSync('git', ['rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
      expect(historicalSha).not.toBe(headSha);

      const manifestPath = writeManifest('historical-commit-fail.json', {
        ...BASE_MANIFEST,
        stage_id: stageId,
        slices: [{ slice_id: sliceId, goal: 'x', observable_outcome: 'x', public_seam: 'x', evidence_path: 'x' }],
        runtime_proof: [{ id: 'proof', type: 'probe', executable: 'node', args: ['-e', 'console.log("ok")'] }],
      });

      // Valid CV receipt (all fields match).
      const cvPath = join(tmpDir, 'cv-historical.json');
      writeFileSync(cvPath, JSON.stringify({
        stage_id: stageId, slice_id: sliceId, snapshot: 'a'.repeat(16), cv_level: 'standard',
        verification_type: 'initial', verdict: 'PASS', failed_po_ids: [],
      }));

      // Integration artifact identity-bound to the historical commit.
      const integrationPath = join(tmpDir, 'integration-historical.json');
      writeFileSync(integrationPath, JSON.stringify({
        stage_id: stageId, slice_id: sliceId, commit_sha: historicalSha, status: 'integrated',
      }));

      const result = await runStageFromManifest({
        manifestPath, outputDir: tmpDir,
        sliceCompleteFacts: [{
          slice_id: sliceId,
          cv: { verdict: 'PASS', receipt_ref: cvPath },
          commit: { commit_sha: historicalSha },
          integration: { integration_ref: integrationPath },
        }],
      });

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toMatch(/not the current HEAD/i);
      const receipt = readReceipt(result.receiptPath!);
      expect(receipt.verdict).toBe('FAIL');
    });
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
});
