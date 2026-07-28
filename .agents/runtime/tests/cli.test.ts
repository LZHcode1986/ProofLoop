import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSnapshot } from '../src/receipt-writer.js';

// ── Paths ───────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIST_DIR = join(__dirname, '..', 'dist');
const RUN_PROJECT_ACCEPTANCE = join(DIST_DIR, 'run-project-acceptance.js');
const COMPILE_PROJECT_ACCEPTANCE = join(DIST_DIR, 'compile-project-acceptance.js');
const RECEIPT_WRITER = join(DIST_DIR, 'receipt-writer.js');
const FINALIZE_PROJECT_REVIEW = join(DIST_DIR, 'finalize-project-review.js');

// ── Helpers ─────────────────────────────────────────────────────────────────────

function cliRun(script: string, ...args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [script, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
  });
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status ?? 1,
  };
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cli-test-'));
}

function writeJSON(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Valid base manifest ─────────────────────────────────────────────────────────

const BASE_MANIFEST = {
  project_id: 'test-project',
  source_digest: 'abc123',
  expected_snapshot: computeSnapshot(process.cwd()).slice(0, 16),
  prd_goals: ['Implement core feature X'],
  acceptance_criteria: ['AC-01: Feature X works'],
  stage_review_receipts: ['stage-review-S01.json'],
  e2e_steps: [
    {
      id: 'smoke-1',
      executable: 'node',
      args: ['-e', 'console.log(42)'],
    },
  ],
};

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('CLI Integration Tests', () => {

  describe('run-project-acceptance.js', () => {

    test('合法 Manifest → exit 0', () => {
      const dir = tmpDir();
      try {
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(manifestPath, BASE_MANIFEST);

        const { stdout, stderr, status } = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir);

        expect(status).toBe(0);
        expect(stderr).toBe('');
        const receipt = JSON.parse(stdout);
        expect(receipt.project_id).toBe('test-project');
        expect(receipt.verdict).toBe('PASS');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('非法 Schema（缺少必填字段 expected_snapshot）→ exit 1', () => {
      const dir = tmpDir();
      try {
        const manifestPath = join(dir, 'manifest.json');
        // Missing expected_snapshot field
        writeJSON(manifestPath, {
          project_id: 'test-project',
          source_digest: 'abc123',
          prd_goals: ['Implement X'],
          acceptance_criteria: ['AC-01'],
          stage_review_receipts: ['r1.json'],
          e2e_steps: [],
        });

        const { stderr, status } = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir);

        expect(status).toBe(1);
        expect(stderr).toMatch(/schema validation failed/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('空步骤（e2e_steps 为空数组）→ exit 1', () => {
      const dir = tmpDir();
      try {
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(manifestPath, {
          ...BASE_MANIFEST,
          e2e_steps: [],
        });

        const { stderr, status } = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir);

        expect(status).toBe(1);
        expect(stderr).toContain('PROJECT_E2E_ZERO_STEPS');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('Receipt 文件真实生成到输出目录', () => {
      const dir = tmpDir();
      try {
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(manifestPath, BASE_MANIFEST);

        const { stdout, status } = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir);

        expect(status).toBe(0);

        // Parse receipt from stdout
        const receipt = JSON.parse(stdout);
        expect(receipt.project_id).toBe('test-project');
        expect(receipt.verdict).toBe('PASS');
        expect(Array.isArray(receipt.steps)).toBe(true);
        expect(receipt.steps.length).toBe(1);
        expect(receipt.steps[0].step_id).toBe('smoke-1');
        expect(receipt.steps[0].exit_code).toBe(0);

        // Verify the receipt was also written to disk
        expect(receipt.created_at).toBeDefined();

        // Read the receipt from disk and verify snapshot fields
        const diskFiles = readdirSync(dir);
        const receiptFile = diskFiles.find((f: string) => f.startsWith('project-e2e-'));
        expect(receiptFile).toBeDefined();
        const receiptContent = readFileSync(join(dir, receiptFile!), 'utf-8');
        const diskReceipt = JSON.parse(receiptContent);
        expect(diskReceipt.expected_snapshot).toBeDefined();
        expect(diskReceipt.executed_snapshot).toBeDefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });

  describe('compile-project-acceptance.js', () => {

    test('compile-project-acceptance generates a valid manifest', () => {
      const dir = tmpDir();
      try {
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'project-acceptance.json');
        const input = {
          project_id: 'test-project',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_review_receipts: ['receipts/S01-review.json'],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        };
        writeJSON(inputPath, input);

        const { stdout, stderr, status } = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);

        expect(status).toBe(0);
        expect(stderr).toBe('');

        const content = readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(content);
        expect(manifest.project_id).toBe('test-project');
        expect(manifest.expected_snapshot).toMatch(/^[a-f0-9]{16}$/);
        expect(manifest.prd_goals).toEqual(['Goal 1']);
        expect(manifest.acceptance_criteria).toEqual(['Criterion 1']);
        expect(manifest.stage_review_receipts).toEqual(['receipts/S01-review.json']);
        expect(manifest.e2e_steps).toHaveLength(1);
        expect(stdout).toContain('Project Acceptance Manifest written');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('compile-project-acceptance rejects empty stage_review_receipts', () => {
      const dir = tmpDir();
      try {
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'project-acceptance.json');
        writeJSON(inputPath, {
          project_id: 'test',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_review_receipts: [],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });

        const { stderr, status } = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/Schema validation/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('compile-project-acceptance rejects invalid project root', () => {
      const dir = tmpDir();
      try {
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'project-acceptance.json');
        writeJSON(inputPath, {
          project_id: 'test',
          project_root: '/nonexistent/path',
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_review_receipts: ['r.json'],
          e2e_steps: [],
        });

        const { stderr, status } = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/not found/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });

  describe('receipt-writer.js', () => {

    test('stage-review 合法输入 → 写文件', () => {
      const dir = tmpDir();
      try {
        const input = JSON.stringify({
          outputDir: dir,
          data: {
            stage_id: 'S01',
            verdict: 'ACCEPTED',
            reviewed_at: new Date().toISOString(),
            reviewer: 'stage-reviewer',
          },
        });

        const { stdout, stderr, status } = cliRun(RECEIPT_WRITER, 'stage-review', input);

        expect(status).toBe(0);
        expect(stderr).toBe('');

        // stdout is a JSON string containing the receipt path
        const receiptPath = JSON.parse(stdout);
        expect(typeof receiptPath).toBe('string');
        expect(existsSync(receiptPath)).toBe(true);

        // Verify content
        const content = JSON.parse(readFileSync(receiptPath, 'utf-8'));
        expect(content.stage_id).toBe('S01');
        expect(content.verdict).toBe('ACCEPTED');
        expect(content.reviewer).toBe('stage-reviewer');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('project-review 合法输入(含审计字段) → 写文件', () => {
      const dir = tmpDir();
      try {
        const input = JSON.stringify({
          outputDir: dir,
          data: {
            project_id: 'test-project',
            verdict: 'PROJECT_ACCEPTED',
            snapshot: 'a1b2c3d4e5f6a7b8',
            reviewed_at: new Date().toISOString(),
            reviewer: 'brain',
            project_manifest: { path: 'manifest.json', digest: 'abc123' },
            project_e2e_receipt: { path: 'e2e-receipt.json', digest: 'def456' },
            stage_review_receipts: ['stage-S01-review.json'],
            stage_gate_receipts: ['stage-S01-gate.json'],
            criteria_results: [
              { criteria: 'All P0 fixed', passed: true },
              { criteria: 'CI passes', passed: true },
            ],
          },
        });

        const { stdout, stderr, status } = cliRun(RECEIPT_WRITER, 'project-review', input);

        expect(status).toBe(0);
        expect(stderr).toBe('');

        const receiptPath = JSON.parse(stdout);
        expect(typeof receiptPath).toBe('string');
        expect(existsSync(receiptPath)).toBe(true);

        const content = JSON.parse(readFileSync(receiptPath, 'utf-8'));
        expect(content.project_id).toBe('test-project');
        expect(content.verdict).toBe('PROJECT_ACCEPTED');
        expect(content.snapshot).toBe('a1b2c3d4e5f6a7b8');
        expect(content.reviewer).toBe('brain');
        expect(content.project_manifest.digest).toBe('abc123');
        expect(content.project_e2e_receipt.digest).toBe('def456');
        expect(content.stage_review_receipts).toHaveLength(1);
        expect(content.stage_gate_receipts).toHaveLength(1);
        expect(content.criteria_results).toHaveLength(2);
        expect(content.criteria_results.every((c: any) => c.passed)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('project-review 缺审计字段 → PROJECT_ACCEPTED 被拒绝', () => {
      const dir = tmpDir();
      try {
        const input = JSON.stringify({
          outputDir: dir,
          data: {
            project_id: 'test-project',
            verdict: 'PROJECT_ACCEPTED',
            snapshot: 'a1b2c3d4e5f6a7b8',
            reviewed_at: new Date().toISOString(),
            reviewer: 'brain',
          },
        });

        const { stderr, status } = cliRun(RECEIPT_WRITER, 'project-review', input);
        expect(status).toBe(1);
        expect(stderr).toMatch(/project_manifest|project_e2e_receipt|Required when verdict/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });

  describe('finalize-project-review.js', () => {

    test('完整往返: compile → E2E → finalize → PROJECT_ACCEPTED', () => {
      const dir = tmpDir();
      try {
        // Create fake stage review/gate receipts
        const reviewPath = join(dir, 'stage-review-S01.json');
        writeJSON(reviewPath, { stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8' });
        const gatePath = join(dir, 'stage-gate-S01.json');
        writeJSON(gatePath, { stage_id: 'S01', verdict: 'PASS' });

        // Compile manifest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'e2e-test',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_review_receipts: [reviewPath],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Run E2E
        const r2 = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir, process.cwd());
        expect(r2.status).toBe(0);

        // Find the E2E receipt (filename has timestamp)
        const files = readdirSync(dir).filter(f => f.startsWith('project-e2e-'));
        expect(files.length).toBeGreaterThan(0);
        const e2eReceiptPath = join(dir, files[0]);

        // Finalize
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath,
          e2eReceiptPath,
          stageReviewReceiptPaths: [reviewPath],
          stageGateReceiptPaths: [gatePath],
          criteriaResults: [{ criteria: 'Criterion 1', passed: true }],
          outputDir: dir,
        });
        const r3 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r3.status).toBe(0);

        // Verify receipt
        const receiptContent = readFileSync(join(dir, 'project-review.json'), 'utf-8');
        const receipt = JSON.parse(receiptContent);
        expect(receipt.verdict).toBe('PROJECT_ACCEPTED');
        expect(receipt.project_manifest.digest).toBeTruthy();
        expect(receipt.project_e2e_receipt.digest).toBeTruthy();
        expect(receipt.criteria_results).toHaveLength(1);
        expect(receipt.criteria_results[0].passed).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('finalize 拒绝伪造的 stage review 路径', () => {
      const dir = tmpDir();
      try {
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath: '/nonexistent/manifest.json',
          e2eReceiptPath: '/nonexistent/e2e.json',
          stageReviewReceiptPaths: ['/nonexistent/review.json'],
          stageGateReceiptPaths: ['/nonexistent/gate.json'],
          criteriaResults: [{ criteria: 'X', passed: true }],
          outputDir: dir,
        });
        const r = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/not found/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('finalize 拒绝非 PASS 的 E2E Receipt', () => {
      const dir = tmpDir();
      try {
        const e2ePath = join(dir, 'project-e2e-fail.json');
        writeJSON(e2ePath, { project_id: 'x', verdict: 'FAIL', snapshot: 'a1b2c3d4e5f6a7b8' });
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath: 'nonexistent',
          e2eReceiptPath: e2ePath,
          stageReviewReceiptPaths: [],
          stageGateReceiptPaths: [],
          criteriaResults: [],
          outputDir: dir,
        });
        const r = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r.status).toBe(1);
        // Should fail because manifest doesn't exist AND e2e verdict is wrong
        expect(r.stderr).toMatch(/not found|FAIL/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('finalize 拒绝缺失 criteria 覆盖', () => {
      const dir = tmpDir();
      try {
        const reviewPath = join(dir, 'sr.json');
        writeJSON(reviewPath, { stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8' });
        const gatePath = join(dir, 'sg.json');
        writeJSON(gatePath, { stage_id: 'S01', verdict: 'PASS' });

        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 't', project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['需要覆盖的Criterion', '另一个Criterion'],
          stage_review_receipts: [reviewPath],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        const r2 = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir, process.cwd());
        expect(r2.status).toBe(0);
        const files = readdirSync(dir).filter(f => f.startsWith('project-e2e-'));
        const e2ePath = join(dir, files[0]);

        // Only submit 1 of 2 criteria
        const finPath = join(dir, 'fin.json');
        writeJSON(finPath, {
          manifestPath, e2eReceiptPath: e2ePath,
          stageReviewReceiptPaths: [reviewPath], stageGateReceiptPaths: [gatePath],
          criteriaResults: [{ criteria: '需要覆盖的Criterion', passed: true }],
          outputDir: dir,
        });
        const r3 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r3.status).toBe(1);
        expect(r3.stderr).toMatch(/Missing criteria/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });
});
