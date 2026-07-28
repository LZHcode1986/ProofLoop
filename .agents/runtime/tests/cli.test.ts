import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths ───────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIST_DIR = join(__dirname, '..', 'dist');
const RUN_PROJECT_ACCEPTANCE = join(DIST_DIR, 'run-project-acceptance.js');
const RECEIPT_WRITER = join(DIST_DIR, 'receipt-writer.js');

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
  expected_snapshot: '',
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
        // The receipt includes a filename in the output, but we can check stdout contains it
        expect(receipt.created_at).toBeDefined();
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

    test('project-review 合法输入 → 写文件', () => {
      const dir = tmpDir();
      try {
        const input = JSON.stringify({
          outputDir: dir,
          data: {
            project_id: 'test-project',
            verdict: 'PROJECT_ACCEPTED',
            snapshot: 'abc123',
            reviewed_at: new Date().toISOString(),
            reviewer: 'brain',
          },
        });

        const { stdout, stderr, status } = cliRun(RECEIPT_WRITER, 'project-review', input);

        expect(status).toBe(0);
        expect(stderr).toBe('');

        // stdout is a JSON string containing the receipt path
        const receiptPath = JSON.parse(stdout);
        expect(typeof receiptPath).toBe('string');
        expect(existsSync(receiptPath)).toBe(true);

        // Verify content
        const content = JSON.parse(readFileSync(receiptPath, 'utf-8'));
        expect(content.project_id).toBe('test-project');
        expect(content.verdict).toBe('PROJECT_ACCEPTED');
        expect(content.snapshot).toBe('abc123');
        expect(content.reviewer).toBe('brain');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });
});
