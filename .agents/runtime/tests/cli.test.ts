import { spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSnapshot, writeGateReceipt, writeStageReviewReceipt, writeProjectE2EReceipt } from '../src/receipt-writer.js';
import { computeCanonicalJsonDigest } from '../src/canonical-digest.js';
import { runStageFromManifest } from '../src/run-stage.js';
import { Manifest as ManifestSchema, ProjectAcceptanceManifestSchema } from '../src/schemas.js';

// ── Test helpers ──────────────────────────────────────────────────────────────────

function computeFileDigest(filePath: string): string {
  return crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16);
}

// ── Paths ───────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIST_DIR = join(__dirname, '..', 'dist');
const RUN_PROJECT_ACCEPTANCE = join(DIST_DIR, 'run-project-acceptance.js');
const COMPILE_PROJECT_ACCEPTANCE = join(DIST_DIR, 'compile-project-acceptance.js');
const COMPILE_MANIFEST = join(DIST_DIR, 'compile-manifest.js');
const VALIDATE_STAGE = join(DIST_DIR, 'validate-stage.js');
const RUN_STAGE = join(DIST_DIR, 'run-stage.js');
const RECEIPT_WRITER = join(DIST_DIR, 'receipt-writer.js');
const FINALIZE_PROJECT_REVIEW = join(DIST_DIR, 'finalize-project-review.js');
const DERIVE_NEXT_ACTION = join(DIST_DIR, 'derive-next-action.js');
const UPDATE_CV_STATUS = join(DIST_DIR, 'update-current-cv-status.js');
const EXECUTOR_NEXT_ACTION = join(DIST_DIR, 'executor-next-action.js');

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

// ── Minimal valid Manifest (stage manifest) helper ──────────────────────────────

function makeStageManifest(stageId = 'S01', extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    stage_id: stageId,
    source_path: 'tasks.md',
    source_digest: 'abc123',
    stage_goal: 'Test stage goal',
    outcomes: ['Outcome 1'],
    slices: [{
      slice_id: stageId + '-A',
      goal: 'Goal',
      observable_outcome: 'Outcome',
      public_seam: 'Seam',
      dependencies: [],
      proof_obligations: [],
      tasks: [],
      risk_facts: ['none'],
      evidence_path: 'delivery/stages/S01/evidence/S01-A.md',
      cv_minimum_level: 'lite',
    }],
    dependencies: [],
    risk_facts: ['none'],
    runtime_proof: [
      { id: 'build', executable: 'node', args: ['-e', 'console.log("ok")'] },
    ],
    ...extra,
  };
}

// ── Minimal valid tasks.md for compile-manifest ────────────────────────────────
// Note: Stage Runtime Proof must come AFTER all slices

const TASKS_MD_CONTENT = `# Stage S01

## Stage Goal

Test stage for round-trip verification

## Observable Outcomes

- Stage runs successfully

## Dependencies

- None

## Stage Risk Facts

- none

<!-- SLICE:S01-A:BEGIN -->

### Goal

Test slice

### Observable Outcome

Slice outcome

### Public Seam

Direct call

### Dependencies

- None

### Risk Facts

- none

### Tasks

- [ ] S01-A-T1

### Proof Obligations

None

<!-- SLICE:S01-A:END -->

## Stage Runtime Proof

\`\`\`yaml
steps:
  - id: build
    executable: node
    args: ['-e', 'console.log("ok")']
\`\`\`
`;

// ── Valid base manifest (project acceptance) ────────────────────────────────────

const BASE_MANIFEST = {
  project_id: 'test-project',
  source_digest: 'abc123',
  expected_snapshot: computeSnapshot(process.cwd()).slice(0, 16),
  prd_goals: ['Implement core feature X'],
  acceptance_criteria: ['AC-01: Feature X works'],
  stage_receipts: [{
    stage_id: 'S01',
    stage_manifest: { path: 'stage-manifest-S01.json', digest: 'a1b2c3d4e5f6a7b8' },
    review_receipt: { path: 'stage-review-S01.json', digest: 'a1b2c3d4e5f6a7b8' },
    gate_receipt: { path: 'stage-gate-S01.json', digest: 'a1b2c3d4e5f6a7b8' },
  }],
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
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: 'm1.json', digest: 'a1b2c3d4e5f6a7b8' },
            review_receipt: { path: 'r1.json', digest: 'a1b2c3d4e5f6a7b8' },
            gate_receipt: { path: 'g1.json', digest: 'a1b2c3d4e5f6a7b8' },
          }],
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
        expect(stderr).toMatch(/too_small|e2e_steps|E2E.*zero/i);
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
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: 'receipts/S01-manifest.json', digest: 'a1b2c3d4e5f6a7b8' },
            review_receipt: { path: 'receipts/S01-review.json', digest: 'a1b2c3d4e5f6a7b8' },
            gate_receipt: { path: 'receipts/S01-gate.json', digest: 'a1b2c3d4e5f6a7b8' },
          }],
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
        expect(manifest.stage_receipts).toHaveLength(1);
        expect(manifest.stage_receipts[0].stage_id).toBe('S01');
        expect(manifest.e2e_steps).toHaveLength(1);
        expect(stdout).toContain('Project Acceptance Manifest written');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('compile-project-acceptance rejects empty stage_receipts', () => {
      const dir = tmpDir();
      try {
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'project-acceptance.json');
        writeJSON(inputPath, {
          project_id: 'test',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_receipts: [],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });

        const { stderr, status } = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/stage_receipts|Schema validation/i);
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
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: 'm.json', digest: 'a1b2c3d4e5f6a7b8' },
            review_receipt: { path: 'r.json', digest: 'a1b2c3d4e5f6a7b8' },
            gate_receipt: { path: 'g.json', digest: 'a1b2c3d4e5f6a7b8' },
          }],
          e2e_steps: [],
        });

        const { stderr, status } = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/not found/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    // E3: 重复 stage_id
    test('compile: 重复 stage_id → Schema 拒绝', () => {
      const dir = tmpDir();
      try {
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'project-acceptance.json');
        writeJSON(inputPath, {
          project_id: 'test',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_receipts: [
            {
              stage_id: 'S01',
              stage_manifest: { path: 'm1.json', digest: 'a1b2c3d4e5f6a7b8' },
              review_receipt: { path: 'r1.json', digest: 'a1b2c3d4e5f6a7b8' },
              gate_receipt: { path: 'g1.json', digest: 'a1b2c3d4e5f6a7b8' },
            },
            {
              stage_id: 'S01', // duplicate
              stage_manifest: { path: 'm2.json', digest: 'ffffffffffffffff' },
              review_receipt: { path: 'r2.json', digest: 'ffffffffffffffff' },
              gate_receipt: { path: 'g2.json', digest: 'ffffffffffffffff' },
            },
          ],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });

        const { stderr, status } = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/Duplicate stage_id/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    // E4: 重复 criteria (compile)
    test('compile: 重复 acceptance_criteria → Schema 拒绝', () => {
      const dir = tmpDir();
      try {
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'project-acceptance.json');
        writeJSON(inputPath, {
          project_id: 'test',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1', 'Criterion 1'], // duplicate
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: 'm.json', digest: 'a1b2c3d4e5f6a7b8' },
            review_receipt: { path: 'r.json', digest: 'a1b2c3d4e5f6a7b8' },
            gate_receipt: { path: 'g.json', digest: 'a1b2c3d4e5f6a7b8' },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });

        const { stderr, status } = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/Duplicate acceptance criteria/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    // RC-16: 空白规范化 — 首尾空格应视为重复
    test('compile: acceptance_criteria 首尾空格重复 → Schema 拒绝', () => {
      const dir = tmpDir();
      try {
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'project-acceptance.json');
        writeJSON(inputPath, {
          project_id: 'test',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1', ' Criterion 1 '],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: 'm.json', digest: 'a1b2c3d4e5f6a7b8' },
            review_receipt: { path: 'r.json', digest: 'a1b2c3d4e5f6a7b8' },
            gate_receipt: { path: 'g.json', digest: 'a1b2c3d4e5f6a7b8' },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const { stderr, status } = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/Duplicate acceptance criteria/i);
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
            snapshot: 'a1b2c3d4e5f6a7b8',
            manifest_digest: 'a1b2c3d4e5f6a7b8',
            stage_gate_receipt: { path: 'stage-gate-S01.json', digest: 'a1b2c3d4e5f6a7b8' },
            findings: [{ category: 'test', description: 'test finding' }],
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

    test('project-review CLI 模式不存在 → exit 非0', () => {
      const dir = tmpDir();
      try {
        const input = JSON.stringify({
          outputDir: dir,
          data: { project_id: 'test', verdict: 'PROJECT_ACCEPTED' },
        });
        const { status, stderr } = cliRun(RECEIPT_WRITER, 'project-review', input);
        expect(status).not.toBe(0);
        expect(stderr).toMatch(/Usage/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });

  describe('finalize-project-review.js', () => {

    // ── 完整往返: 使用真实生产链路 ─────────────────────────────────────────────

    test('完整往返: compile Stage → run Stage → review → E2E → finalize → PROJECT_ACCEPTED', async () => {
      const dir = tmpDir();
      try {
        // ── 0. Initialize a git repo in dir (required by stage gate validation) ──
        execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
        writeFileSync(join(dir, '.gitkeep'), '');
        execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'base'], { cwd: dir, stdio: 'pipe' });

        // ── 1. Create tasks.md input for compile-manifest ──
        const tasksMdPath = join(dir, 'tasks.md');
        writeFileSync(tasksMdPath, TASKS_MD_CONTENT, 'utf-8');

        // ── 2. Compile Stage Manifest via CLI ──
        const stageManifestPath = join(dir, 'stage-manifest-S01.json');
        const r0 = cliRun(COMPILE_MANIFEST, tasksMdPath, stageManifestPath);
        expect(r0.status).toBe(0);

        // Compute canonical digest of the stage manifest
        const stageManifestRaw = JSON.parse(readFileSync(stageManifestPath, 'utf-8'));
        const stageManifestCanonicalDigest = computeCanonicalJsonDigest(ManifestSchema, stageManifestRaw);

        // ── 2b. Create a slice commit so we have preCommitHead !== sliceCommitSha ──
        writeFileSync(join(dir, 'output.txt'), 'slice output');
        execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'slice output'], { cwd: dir, stdio: 'pipe' });
        const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        const preCommitHead = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir, encoding: 'utf8' }).trim();
        const snapshot = 'a'.repeat(16);

        // Canonical CV receipt
        const cvDir = join(dir, '.proofloop', 'receipts', 'cv', 'S01', 'S01-A');
        mkdirSync(cvDir, { recursive: true });
        const cvReceiptPath = join(cvDir, 'initial-001.json');
        writeJSON(cvReceiptPath, {
          stage_id: 'S01', slice_id: 'S01-A', snapshot, cv_level: 'standard',
          verification_type: 'initial', verdict: 'PASS', failed_po_ids: [],
        });
        const cvDigest = crypto.createHash('sha256').update(readFileSync(cvReceiptPath)).digest('hex');

        // Canonical Committer receipt
        const committerDir = join(dir, '.proofloop', 'receipts', 'committer', 'S01', 'S01-A');
        mkdirSync(committerDir, { recursive: true });
        writeJSON(join(committerDir, 'slice-output-001.json'), {
          stage_id: 'S01', slice_id: 'S01-A', status: 'committed',
          pre_commit_head: preCommitHead,
          slice_commit_sha: commitSha,
          manifest_digest: stageManifestCanonicalDigest,
          cv_receipt_ref: cvReceiptPath,
          cv_receipt_digest: cvDigest,
          verified_snapshot: snapshot,
          tasks_path: 'tasks.json', evidence_path: 'evidence.json',
          changed_files: ['output.txt'],
          created_at: new Date().toISOString(),
        });

        // Canonical Integration receipt
        const intDir = join(dir, '.proofloop', 'receipts', 'integration', 'S01', 'S01-A');
        mkdirSync(intDir, { recursive: true });
        const integrationPath = join(intDir, 'integration-001.json');
        writeJSON(integrationPath, {
          stage_id: 'S01', slice_id: 'S01-A', status: 'integrated',
          slice_commit_sha: commitSha,
          stage_head_before: preCommitHead,
          integrated_commit_sha: commitSha,
          stage_head_after: commitSha,
          cv_receipt_ref: cvReceiptPath,
          verified_snapshot: snapshot,
          post_merge_snapshot: 'b'.repeat(16),
          post_merge_checks: [],
          created_at: new Date().toISOString(),
        });

        const r1 = await runStageFromManifest({
          manifestPath: stageManifestPath,
          outputDir: dir,
          projectRoot: dir,
          sliceCompleteFacts: [{
            slice_id: 'S01-A',
            cv: { verdict: 'PASS', receipt_ref: cvReceiptPath },
            commit: { commit_sha: commitSha, receipt_ref: 'committer/slice-output-001.json' },
            integration: { integration_ref: integrationPath },
          }],
        });
        expect(r1.success).toBe(true);

        // ── 4. Read the Gate receipt ──
        const gateFiles = readdirSync(dir).filter((f: string) => f.startsWith('stage-gate-'));
        expect(gateFiles.length).toBeGreaterThan(0);
        const gatePath = join(dir, gateFiles[0]);
        const gateContent = JSON.parse(readFileSync(gatePath, 'utf-8'));
        const gateDigest = computeFileDigest(gatePath);

        // ── 5. Write Stage Review via CLI ──
        const reviewInput = JSON.stringify({
          outputDir: dir,
          data: {
            stage_id: 'S01',
            verdict: 'ACCEPTED',
            snapshot: gateContent.snapshot,
            manifest_digest: gateContent.manifest_digest,
            stage_gate_receipt: { path: gatePath, digest: gateDigest },
            findings: [{ category: 'review', description: 'all good' }],
            reviewer: 'test-reviewer',
            reviewed_at: new Date().toISOString(),
          },
        });
        const r2 = cliRun(RECEIPT_WRITER, 'stage-review', reviewInput);
        expect(r2.status).toBe(0);
        const reviewPath = JSON.parse(r2.stdout);
        expect(existsSync(reviewPath)).toBe(true);
        const reviewDigest = computeFileDigest(reviewPath);

        // ── 6. Compile project acceptance manifest ──
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'e2e-test',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageManifestCanonicalDigest },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          // Additional E2E step for the full acceptance run
          e2e_steps: [
            { id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] },
            ...BASE_MANIFEST.e2e_steps,
          ],
        });
        const r3 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r3.status).toBe(0);

        // ── 7. Read compiled manifest ──
        const compiledManifestRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifestRaw.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifestRaw,
        );

        // ── 8. Run E2E ──
        const r4 = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir, process.cwd());
        expect(r4.status).toBe(0);

        // ── 9. Find E2E receipt ──
        const e2eFiles = readdirSync(dir).filter((f: string) => f.startsWith('project-e2e-'));
        expect(e2eFiles.length).toBeGreaterThan(0);
        const e2eReceiptPath = join(dir, e2eFiles[0]);
        const e2eDigest = computeFileDigest(e2eReceiptPath);

        // ── 10. Create reviewer result ──
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED',
          reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2eReceiptPath, digest: e2eDigest },
          criteria_results: [{ criteria: 'Criterion 1', passed: true }],
          findings: [{ category: 'final-review', description: 'accepted' }],
          accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        // ── 11. Finalize ──
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath, e2eReceiptPath, reviewerResultPath, outputDir: dir,
        });
        const r5 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r5.status).toBe(0);

        // ── 12. Verify receipt ──
        const receiptContent = readFileSync(join(dir, 'project-review.json'), 'utf-8');
        const receipt = JSON.parse(receiptContent);
        expect(receipt.verdict).toBe('PROJECT_ACCEPTED');
        expect(receipt.project_manifest.digest).toBeTruthy();
        expect(receipt.project_e2e_receipt.digest).toBeTruthy();
        expect(receipt.criteria_results).toHaveLength(1);
        expect(receipt.criteria_results[0].passed).toBe(true);

        // Verify stage_manifest{path,digest} present
        expect(receipt.stage_receipts).toHaveLength(1);
        expect(receipt.stage_receipts[0].stage_manifest).toBeDefined();
        expect(receipt.stage_receipts[0].stage_manifest.path).toBeTruthy();
        expect(receipt.stage_receipts[0].stage_manifest.digest).toBe(stageManifestCanonicalDigest);

        // Verify reviewed_at inherited
        expect(receipt.reviewed_at).toBeDefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60000);

    // ── Basic negative tests ─────────────────────────────────────────────────────

    test('finalize 拒绝伪造的 stage review 路径', () => {
      const dir = tmpDir();
      try {
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath: '/nonexistent/manifest.json',
          e2eReceiptPath: '/nonexistent/e2e.json',
          reviewerResultPath: '/nonexistent/reviewer.json',
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
        writeJSON(e2ePath, {
          project_id: 'x', verdict: 'FAIL',
          snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          expected_snapshot: 'a1b2c3d4e5f6a7b8',
          executed_snapshot: 'a1b2c3d4e5f6a7b8',
          steps: [{ step_id: 's1', exit_code: 1, observations: 'failed', skipped: false }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath: 'nonexistent',
          e2eReceiptPath: e2ePath,
          reviewerResultPath: 'nonexistent-reviewer.json',
          outputDir: dir,
        });
        const r = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/not found|FAIL/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('finalize 拒绝缺失 criteria 覆盖', () => {
      const dir = tmpDir();
      try {
        // ── Set up valid stage evidence ──
        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          platform: 'test', steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [{ category: 'review', description: 'ok' }],
          reviewer: 'test-reviewer',
          reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Valid stage manifest
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageManifestCanonicalDigest = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 't', project_root: process.cwd(),
          prd_goals: ['G1'],
          acceptance_criteria: ['需要覆盖的Criterion', '另一个Criterion'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageManifestCanonicalDigest },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        const compiledManifestRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifestRaw.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifestRaw,
        );

        const r2 = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir, process.cwd());
        expect(r2.status).toBe(0);
        const files = readdirSync(dir).filter((f: string) => f.startsWith('project-e2e-'));
        const e2ePath = join(dir, files[0]);
        const e2eDigest = computeFileDigest(e2ePath);

        // Reviewer result with only 1 of 2 criteria
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED',
          reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2ePath, digest: e2eDigest },
          criteria_results: [{ criteria: '需要覆盖的Criterion', passed: true }],
          findings: [],
          accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin.json');
        writeJSON(finPath, {
          manifestPath, e2eReceiptPath: e2ePath,
          reviewerResultPath,
          outputDir: dir,
        });
        const r3 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r3.status).toBe(1);
        expect(r3.stderr).toMatch(/Missing criteria/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    // ── E2: Stage Manifest digest mismatch tests ────────────────────────────

    test('finalize: Stage Manifest digest 与 canonical 不匹配 → 拒绝', () => {
      const dir = tmpDir();
      try {
        // Valid stage manifest
        const stageManifestPath = join(dir, 'stage-manifest-S01.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));

        // Gate receipt via Writer
        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          platform: 'test', steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        // Review receipt via Writer
        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [{ category: 'review', description: 'ok' }],
          reviewer: 'test-reviewer',
          reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Compute correct canonical digest
        const stageManifestRaw = JSON.parse(readFileSync(stageManifestPath, 'utf-8'));
        const actualCanonical = computeCanonicalJsonDigest(ManifestSchema, stageManifestRaw);

        // Compile project acceptance manifest with WRONG stage_manifest.digest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'e2e-test', project_root: process.cwd(),
          prd_goals: ['Goal 1'], acceptance_criteria: ['Criterion 1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: 'ffffffffffffffff' }, // WRONG digest
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Read compiled manifest for expected values
        const compiledManifestRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifestRaw.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifestRaw,
        );

        // Write valid E2E receipt via Writer
        const e2eReceiptPath = writeProjectE2EReceipt(dir, {
          project_id: 'e2e-test', verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonicalDigest,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 'smoke', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2eReceiptPath);

        // Valid reviewer result
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2eReceiptPath, digest: e2eDigest },
          criteria_results: [{ criteria: 'Criterion 1', passed: true }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        // Finalize → FAIL (stage manifest digest mismatch)
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath, reviewerResultPath, outputDir: dir });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
        expect(r2.stderr).toMatch(/Stage manifest/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('finalize: Gate manifest_digest 与 canonical 不匹配 → 拒绝', () => {
      const dir = tmpDir();
      try {
        // Valid stage manifest
        const stageManifestPath = join(dir, 'stage-manifest-S01.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));

        // Gate receipt with WRONG manifest_digest
        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'ffffffffffffffff', // WRONG - not the canonical
          platform: 'test', steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        // Valid review
        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [{ category: 'review', description: 'ok' }],
          reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        const stageManifestRaw = JSON.parse(readFileSync(stageManifestPath, 'utf-8'));
        const actualCanonical = computeCanonicalJsonDigest(ManifestSchema, stageManifestRaw);

        // Compile manifest with correct stage_manifest.digest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'e2e-test', project_root: process.cwd(),
          prd_goals: ['Goal 1'], acceptance_criteria: ['Criterion 1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: actualCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        const compiledManifestRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifestRaw.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifestRaw,
        );

        const e2eReceiptPath = writeProjectE2EReceipt(dir, {
          project_id: 'e2e-test', verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonicalDigest,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 'smoke', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2eReceiptPath);

        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2eReceiptPath, digest: e2eDigest },
          criteria_results: [{ criteria: 'Criterion 1', passed: true }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath, reviewerResultPath, outputDir: dir });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
        expect(r2.stderr).toMatch(/Gate manifest_digest/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('finalize: Review manifest_digest 与 canonical 不匹配 → 拒绝', () => {
      const dir = tmpDir();
      try {
        const stageManifestPath = join(dir, 'stage-manifest-S01.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          platform: 'test', steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        // Review receipt with WRONG manifest_digest
        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'ffffffffffffffff', // WRONG
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [{ category: 'review', description: 'ok' }],
          reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        const stageManifestRaw = JSON.parse(readFileSync(stageManifestPath, 'utf-8'));
        const actualCanonical = computeCanonicalJsonDigest(ManifestSchema, stageManifestRaw);

        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'e2e-test', project_root: process.cwd(),
          prd_goals: ['Goal 1'], acceptance_criteria: ['Criterion 1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: actualCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        const compiledManifestRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifestRaw.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifestRaw,
        );

        const e2eReceiptPath = writeProjectE2EReceipt(dir, {
          project_id: 'e2e-test', verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonicalDigest,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 'smoke', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2eReceiptPath);

        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2eReceiptPath, digest: e2eDigest },
          criteria_results: [{ criteria: 'Criterion 1', passed: true }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath, reviewerResultPath, outputDir: dir });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
        expect(r2.stderr).toMatch(/Review manifest_digest/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    // ── E4: 重复 criteria (finalize) ────────────────────────────────────────

    test('finalize: 重复 reviewer criteria → Schema 拒绝', () => {
      const dir = tmpDir();
      try {
        // ── Set up valid infrastructure ──
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8', platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Compile project acceptance manifest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'test', project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['C1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Valid E2E receipt
        const compiledRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledRaw.expected_snapshot;
        const manifestCanonical = computeCanonicalJsonDigest(ProjectAcceptanceManifestSchema, compiledRaw);

        const e2ePath = writeProjectE2EReceipt(dir, {
          project_id: 'test', verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonical,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 's', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2ePath);

        // Reviewer result with DUPLICATE criteria
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonical },
          project_e2e_receipt: { path: e2ePath, digest: e2eDigest },
          criteria_results: [
            { criteria: 'C1', passed: true },
            { criteria: 'C1', passed: true }, // duplicate
          ],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Duplicate.*criteria/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    // RC-16: 空白规范化 — 首尾空格应视为重复
    test('finalize: reviewer criteria 首尾空格重复 → Schema 拒绝', () => {
      const dir = tmpDir();
      try {
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );
        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: stageCanonical,
          manifest_digest: stageCanonical, platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);
        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: stageCanonical,
          manifest_digest: stageCanonical,
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(join(dir, 'input.json'), {
          project_id: 'test', project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['C1'],
          stage_receipts: [{ stage_id: 'S01', stage_manifest: { path: stageManifestPath, digest: stageCanonical }, review_receipt: { path: reviewPath, digest: reviewDigest }, gate_receipt: { path: gatePath, digest: gateDigest } }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        cliRun(COMPILE_PROJECT_ACCEPTANCE, join(dir, 'input.json'), manifestPath);
        const compiledRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledRaw.expected_snapshot;
        const manifestCanonical = computeCanonicalJsonDigest(ProjectAcceptanceManifestSchema, compiledRaw);
        const e2ePath = writeProjectE2EReceipt(dir, {
          project_id: 'test', verdict: 'PASS', snapshot: expectedSnapshot,
          manifest_digest: manifestCanonical, expected_snapshot: expectedSnapshot, executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 's', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain', reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonical },
          project_e2e_receipt: { path: e2ePath, digest: computeFileDigest(e2ePath) },
          criteria_results: [{ criteria: 'C1', passed: true }, { criteria: ' C1 ', passed: true }],
          findings: [], accepted_deviations: [], reviewed_at: new Date().toISOString(),
        });
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Duplicate.*criteria/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    // ── E5: Reviewer Result 不一致 ──────────────────────────────────────────

    test('finalize: reviewed_snapshot 不匹配 → 拒绝', () => {
      const dir = tmpDir();
      try {
        // Set up valid evidence
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8', platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Compile manifest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'test', project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['C1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        const compiledRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const manifestCanonical = computeCanonicalJsonDigest(ProjectAcceptanceManifestSchema, compiledRaw);
        const expectedSnapshot = compiledRaw.expected_snapshot;

        const e2ePath = writeProjectE2EReceipt(dir, {
          project_id: 'test', verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonical,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 's', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2ePath);

        // Reviewer with WRONG reviewed_snapshot
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: 'ffffffffffffffff', // does NOT match expectedSnapshot
          project_manifest: { path: manifestPath, digest: manifestCanonical },
          project_e2e_receipt: { path: e2ePath, digest: e2eDigest },
          criteria_results: [{ criteria: 'C1', passed: true }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
        expect(r2.stderr).toMatch(/reviewed_snapshot/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('finalize: reviewer verdict 不是 PROJECT_ACCEPTED → 拒绝', () => {
      const dir = tmpDir();
      try {
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8', platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'test', project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['C1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        const compiledRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledRaw.expected_snapshot;
        const manifestCanonical = computeCanonicalJsonDigest(ProjectAcceptanceManifestSchema, compiledRaw);

        const e2ePath = writeProjectE2EReceipt(dir, {
          project_id: 'test', verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonical,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 's', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2ePath);

        // Reviewer verdict is PROJECT_REJECTED instead of PROJECT_ACCEPTED
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_REJECTED', reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonical },
          project_e2e_receipt: { path: e2ePath, digest: e2eDigest },
          criteria_results: [{ criteria: 'C1', passed: true, notes: 'still ok but rejected' }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
        expect(r2.stderr).toMatch(/PROJECT_ACCEPTED/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('finalize: 额外 criteria → 拒绝', () => {
      const dir = tmpDir();
      try {
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8', platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'test', project_root: process.cwd(),
          prd_goals: ['G1'],
          acceptance_criteria: ['C1'], // only 1 criterion in manifest
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        const compiledRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledRaw.expected_snapshot;
        const manifestCanonical = computeCanonicalJsonDigest(ProjectAcceptanceManifestSchema, compiledRaw);

        const e2ePath = writeProjectE2EReceipt(dir, {
          project_id: 'test', verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonical,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 's', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2ePath);

        // Reviewer has EXTRA criteria not in manifest
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonical },
          project_e2e_receipt: { path: e2ePath, digest: e2eDigest },
          criteria_results: [
            { criteria: 'C1', passed: true },
            { criteria: 'Extra Criterion', passed: true }, // extra, not in manifest
          ],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
        expect(r2.stderr).toMatch(/Extra criteria/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('finalize: criteria 未通过 → 拒绝', () => {
      const dir = tmpDir();
      try {
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8', platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'test', project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['C1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        const compiledRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledRaw.expected_snapshot;
        const manifestCanonical = computeCanonicalJsonDigest(ProjectAcceptanceManifestSchema, compiledRaw);

        const e2ePath = writeProjectE2EReceipt(dir, {
          project_id: 'test', verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonical,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 's', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2ePath);

        // Reviewer criteria with passed: false
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonical },
          project_e2e_receipt: { path: e2ePath, digest: e2eDigest },
          criteria_results: [{ criteria: 'C1', passed: false, notes: 'failed' }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
        expect(r2.stderr).toMatch(/criteria.*passed|passed/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    // ── E6: E2E Receipt 矛盾 ────────────────────────────────────────────────

    test('finalize: E2E PASS 但存在非零 exit_code → 拒绝', () => {
      const dir = tmpDir();
      try {
        // ── Set up valid infrastructure ──
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8', platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Compile project acceptance manifest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'test', project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['C1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Write invalid E2E receipt directly (PASS + non-zero exit_code → Schema.superRefine)
        const e2ePath = join(dir, 'project-e2e-bad.json');
        writeJSON(e2ePath, {
          project_id: 'test', verdict: 'PASS',
          snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          expected_snapshot: 'a1b2c3d4e5f6a7b8',
          executed_snapshot: 'a1b2c3d4e5f6a7b8',
          steps: [{ step_id: 's1', exit_code: 1, skipped: false }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });

        // Valid reviewer result (won't be reached due to E2E failure)
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: 'a1b2c3d4e5f6a7b8',
          project_manifest: { path: manifestPath, digest: 'a1b2c3d4e5f6a7b8' },
          project_e2e_receipt: { path: e2ePath, digest: 'a1b2c3d4e5f6a7b8' },
          criteria_results: [{ criteria: 'C1', passed: true }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Invalid E2E Receipt/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('finalize: E2E PASS 但所有步骤 skipped → 拒绝', () => {
      const dir = tmpDir();
      try {
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8', platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'test', project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['C1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Write invalid E2E receipt (PASS + all steps skipped)
        const e2ePath = join(dir, 'project-e2e-all-skipped.json');
        writeJSON(e2ePath, {
          project_id: 'test', verdict: 'PASS',
          snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          expected_snapshot: 'a1b2c3d4e5f6a7b8',
          executed_snapshot: 'a1b2c3d4e5f6a7b8',
          steps: [{ step_id: 's1', exit_code: 0, skipped: true }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });

        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: 'a1b2c3d4e5f6a7b8',
          project_manifest: { path: manifestPath, digest: 'a1b2c3d4e5f6a7b8' },
          project_e2e_receipt: { path: e2ePath, digest: 'a1b2c3d4e5f6a7b8' },
          criteria_results: [{ criteria: 'C1', passed: true }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Invalid E2E Receipt/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('finalize: E2E PASS 但 cleanup failed → 拒绝', () => {
      const dir = tmpDir();
      try {
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8', platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'test', project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['C1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Write invalid E2E receipt (PASS + cleanup failed)
        const e2ePath = join(dir, 'project-e2e-cleanup-fail.json');
        writeJSON(e2ePath, {
          project_id: 'test', verdict: 'PASS',
          snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          expected_snapshot: 'a1b2c3d4e5f6a7b8',
          executed_snapshot: 'a1b2c3d4e5f6a7b8',
          steps: [{ step_id: 's1', exit_code: 0, skipped: false }],
          service_cleanup: {
            cleaned: [],
            failed: [{ service: 'bad-service', pid: 123, reason: 'test failure' }],
            remainingPids: [],
          },
          created_at: new Date().toISOString(),
        });

        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: 'a1b2c3d4e5f6a7b8',
          project_manifest: { path: manifestPath, digest: 'a1b2c3d4e5f6a7b8' },
          project_e2e_receipt: { path: e2ePath, digest: 'a1b2c3d4e5f6a7b8' },
          criteria_results: [{ criteria: 'C1', passed: true }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Invalid E2E Receipt/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('finalize: project_id 不匹配 → 拒绝', () => {
      const dir = tmpDir();
      try {
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8', platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'test-project', // manifest project_id
          project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['C1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        const compiledRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledRaw.expected_snapshot;
        const manifestCanonical = computeCanonicalJsonDigest(ProjectAcceptanceManifestSchema, compiledRaw);

        // Write E2E receipt with WRONG project_id (but passing Schema.parse)
        const e2ePath = writeProjectE2EReceipt(dir, {
          project_id: 'wrong-project', // does NOT match manifest project_id
          verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonical,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 's', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2ePath);

        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonical },
          project_e2e_receipt: { path: e2ePath, digest: e2eDigest },
          criteria_results: [{ criteria: 'C1', passed: true }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
        expect(r2.stderr).toMatch(/project_id/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('finalize: snapshot 不匹配 → 拒绝', () => {
      const dir = tmpDir();
      try {
        const stageManifestPath = join(dir, 'sm.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));

        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8', platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        });
        const gateDigest = computeFileDigest(gatePath);

        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [], reviewer: 'test-reviewer', reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        const stageCanonical = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'test', project_root: process.cwd(),
          prd_goals: ['G1'], acceptance_criteria: ['C1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageCanonical },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 's', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        const compiledRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledRaw.expected_snapshot;
        const manifestCanonical = computeCanonicalJsonDigest(ProjectAcceptanceManifestSchema, compiledRaw);

        // Write E2E receipt with WRONG executed_snapshot (different valid hex)
        const e2ePath = writeProjectE2EReceipt(dir, {
          project_id: 'test', verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonical,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: 'ffffffffffffffff', // does NOT match expectedSnapshot
          steps: [{ step_id: 's', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2ePath);

        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED', reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonical },
          project_e2e_receipt: { path: e2ePath, digest: e2eDigest },
          criteria_results: [{ criteria: 'C1', passed: true }],
          findings: [], accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        const finPath = join(dir, 'fin.json');
        writeJSON(finPath, { manifestPath, e2eReceiptPath: e2ePath, reviewerResultPath, outputDir: dir });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
        expect(r2.stderr).toMatch(/snapshot/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });

  describe('篡改防线 (RC-24)', () => {

    test('摘要篡改：manifest 被修改后 digest 不匹配', () => {
      const dir = tmpDir();
      try {
        // Create valid stage manifest FIRST so we can compute its canonical digest
        const stageManifestPath = join(dir, 'stage-manifest-S01.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const canonicalStageManifestDigest = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        // Write gate receipt via Writer — use actual canonical digest
        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: canonicalStageManifestDigest,
          platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: {
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
        });
        const gateDigest = computeFileDigest(gatePath);

        // Write review receipt via Writer — use actual canonical digest
        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: canonicalStageManifestDigest,
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [{ category: 'review', description: 'all good' }],
          reviewer: 'test-reviewer',
          reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Compile manifest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'rc24-t1',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: canonicalStageManifestDigest },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Read compiled manifest
        const compiledManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifest.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifest,
        );

        // Run E2E
        const r2 = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir, process.cwd());
        expect(r2.status).toBe(0);

        // Find E2E receipt
        const files = readdirSync(dir).filter((f: string) => f.startsWith('project-e2e-'));
        const e2eReceiptPath = join(dir, files[0]);
        const e2eDigest = computeFileDigest(e2eReceiptPath);

        // Write reviewer result
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED',
          reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2eReceiptPath, digest: e2eDigest },
          criteria_results: [{ criteria: 'Criterion 1', passed: true }],
          findings: [{ category: 'final-review', description: 'accepted' }],
          accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        // First finalize → should PASS
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath, e2eReceiptPath, reviewerResultPath, outputDir: dir,
        });
        const r3 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r3.status).toBe(0);

        // Tamper: change manifest content (modify a field value)
        const manifestObj = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        manifestObj.project_id = 'rc24-t1-tampered';
        writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2), 'utf-8');

        // Second finalize → should FAIL (digest mismatch)
        const r4 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r4.status).toBe(1);
        expect(r4.stderr).toMatch(/digest/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('摘要篡改：E2E receipt 被修改后 digest 不匹配', () => {
      const dir = tmpDir();
      try {
        // Create valid stage manifest FIRST
        const stageManifestPath = join(dir, 'stage-manifest-S01.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const canonicalStageManifestDigest = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        // Write gate receipt via Writer — use actual canonical digest
        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: canonicalStageManifestDigest,
          platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: {
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
        });
        const gateDigest = computeFileDigest(gatePath);

        // Write review receipt via Writer — use actual canonical digest
        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: canonicalStageManifestDigest,
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [{ category: 'review', description: 'all good' }],
          reviewer: 'test-reviewer',
          reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Compile manifest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'rc24-t2',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: canonicalStageManifestDigest },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Read compiled manifest
        const compiledManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifest.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifest,
        );

        // Run E2E
        const r2 = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir, process.cwd());
        expect(r2.status).toBe(0);

        // Find E2E receipt
        const files = readdirSync(dir).filter((f: string) => f.startsWith('project-e2e-'));
        const e2eReceiptPath = join(dir, files[0]);
        const e2eDigest = computeFileDigest(e2eReceiptPath);

        // Write reviewer result
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED',
          reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2eReceiptPath, digest: e2eDigest },
          criteria_results: [{ criteria: 'Criterion 1', passed: true }],
          findings: [{ category: 'final-review', description: 'accepted' }],
          accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        // First finalize → should PASS
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath, e2eReceiptPath, reviewerResultPath, outputDir: dir,
        });
        const r3 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r3.status).toBe(0);

        // Tamper: modify E2E receipt content (add trailing space)
        const e2eContent = readFileSync(e2eReceiptPath, 'utf-8');
        writeFileSync(e2eReceiptPath, e2eContent + ' ', 'utf-8');

        // Second finalize → should FAIL (E2E receipt digest mismatch)
        const r4 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r4.status).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('摘要篡改：stage review receipt 被修改后 digest 不匹配', () => {
      const dir = tmpDir();
      try {
        // Write gate receipt via Writer
        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: {
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
        });
        const gateDigest = computeFileDigest(gatePath);

        // Write review receipt via Writer
        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [{ category: 'review', description: 'all good' }],
          reviewer: 'test-reviewer',
          reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Create valid stage manifest
        const stageManifestPath = join(dir, 'stage-manifest-S01.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageManifestCanonicalDigest = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        // Compile manifest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'rc24-t3',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageManifestCanonicalDigest },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Read compiled manifest
        const compiledManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifest.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifest,
        );

        // Run E2E
        const r2 = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir, process.cwd());
        expect(r2.status).toBe(0);

        // Find E2E receipt
        const files = readdirSync(dir).filter((f: string) => f.startsWith('project-e2e-'));
        const e2eReceiptPath = join(dir, files[0]);
        const e2eDigest = computeFileDigest(e2eReceiptPath);

        // Tamper: modify review receipt content BEFORE writing reviewer result
        const reviewContent = readFileSync(reviewPath, 'utf-8');
        writeFileSync(reviewPath, reviewContent + ' ', 'utf-8');

        // Write reviewer result (E2E references are still valid)
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED',
          reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2eReceiptPath, digest: e2eDigest },
          criteria_results: [{ criteria: 'Criterion 1', passed: true }],
          findings: [{ category: 'final-review', description: 'accepted' }],
          accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        // Finalize → FAIL (review receipt digest mismatch)
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath, e2eReceiptPath, reviewerResultPath, outputDir: dir,
        });
        const r3 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r3.status).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('Snapshot 篡改：review snapshot != gate snapshot', () => {
      const dir = tmpDir();
      try {
        // Write gate receipt with snapshot 'a1b2c3d4e5f6a7b8'
        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: {
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
        });
        const gateDigest = computeFileDigest(gatePath);

        // Write review receipt with DIFFERENT snapshot 'ffffffffffffffff'
        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'ffffffffffffffff',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [{ category: 'review', description: 'all good' }],
          reviewer: 'test-reviewer',
          reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Create valid stage manifest
        const stageManifestPath = join(dir, 'stage-manifest-S01.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageManifestCanonicalDigest = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        // Compile manifest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'rc24-t4',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageManifestCanonicalDigest },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Read compiled manifest
        const compiledManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifest.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifest,
        );

        // Write E2E receipt via Writer (no need to actually run E2E)
        const e2eReceiptPath = writeProjectE2EReceipt(dir, {
          project_id: 'rc24-t4',
          verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonicalDigest,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 'smoke', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2eReceiptPath);

        // Write reviewer result
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED',
          reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2eReceiptPath, digest: e2eDigest },
          criteria_results: [{ criteria: 'Criterion 1', passed: true }],
          findings: [{ category: 'final-review', description: 'accepted' }],
          accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        // Finalize → FAIL (snapshot mismatch between review and gate)
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath, e2eReceiptPath, reviewerResultPath, outputDir: dir,
        });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
        expect(r2.stderr).toMatch(/snapshot/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('Verdict 篡改：E2E verdict 改为 FAIL', () => {
      const dir = tmpDir();
      try {
        // Write gate receipt via Writer
        const gatePath = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: {
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
        });
        const gateDigest = computeFileDigest(gatePath);

        // Write review receipt via Writer
        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePath, digest: gateDigest },
          findings: [{ category: 'review', description: 'all good' }],
          reviewer: 'test-reviewer',
          reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Create valid stage manifest
        const stageManifestPath = join(dir, 'stage-manifest-S01.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageManifestCanonicalDigest = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        // Compile manifest
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'rc24-t5',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageManifestCanonicalDigest },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePath, digest: gateDigest },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Read compiled manifest
        const compiledManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifest.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifest,
        );

        // Run E2E → PASS
        const r2 = cliRun(RUN_PROJECT_ACCEPTANCE, manifestPath, dir, process.cwd());
        expect(r2.status).toBe(0);

        // Find E2E receipt
        const files = readdirSync(dir).filter((f: string) => f.startsWith('project-e2e-'));
        const e2eReceiptPath = join(dir, files[0]);

        // Tamper: modify E2E receipt verdict to FAIL
        const e2eReceipt = JSON.parse(readFileSync(e2eReceiptPath, 'utf-8'));
        e2eReceipt.verdict = 'FAIL';
        writeFileSync(e2eReceiptPath, JSON.stringify(e2eReceipt, null, 2), 'utf-8');
        const e2eDigest = computeFileDigest(e2eReceiptPath);

        // Write reviewer result (pointing to modified E2E receipt with updated digest)
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED',
          reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2eReceiptPath, digest: e2eDigest },
          criteria_results: [{ criteria: 'Criterion 1', passed: true }],
          findings: [{ category: 'final-review', description: 'accepted' }],
          accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        // Finalize → FAIL (E2E verdict is FAIL)
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath, e2eReceiptPath, reviewerResultPath, outputDir: dir,
        });
        const r3 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r3.status).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);

    test('Stage 路径替换：manifest 声明 path A，实际文件是 path B 的内容', () => {
      const dir = tmpDir();
      try {
        // Write gate receipt A to main dir (via Writer)
        const gatePathA = writeGateReceipt(dir, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: {
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
        });

        // Write DIFFERENT gate receipt B to subdirectory (via Writer)
        const dirB = join(dir, 'alt');
        const gatePathB = writeGateReceipt(dirB, {
          stage_id: 'S01', verdict: 'PASS', snapshot: 'ffffffffffffffff',
          manifest_digest: 'ffffffffffffffff',
          platform: 'test',
          steps: [{ id: 'build', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          timestamps: {
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
        });
        const digestB = computeFileDigest(gatePathB);

        // Write review receipt pointing to gatePathA
        const reviewPath = writeStageReviewReceipt(dir, {
          stage_id: 'S01', verdict: 'ACCEPTED', snapshot: 'a1b2c3d4e5f6a7b8',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          stage_gate_receipt: { path: gatePathA, digest: computeFileDigest(gatePathA) },
          findings: [{ category: 'review', description: 'all good' }],
          reviewer: 'test-reviewer',
          reviewed_at: new Date().toISOString(),
        });
        const reviewDigest = computeFileDigest(reviewPath);

        // Create valid stage manifest
        const stageManifestPath = join(dir, 'stage-manifest-S01.json');
        writeJSON(stageManifestPath, makeStageManifest('S01'));
        const stageManifestCanonicalDigest = computeCanonicalJsonDigest(
          ManifestSchema, JSON.parse(readFileSync(stageManifestPath, 'utf-8')),
        );

        // Compile manifest: gate_receipt.path = gatePathA, gate_receipt.digest = digestB
        const inputPath = join(dir, 'input.json');
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(inputPath, {
          project_id: 'rc24-t6',
          project_root: process.cwd(),
          prd_goals: ['Goal 1'],
          acceptance_criteria: ['Criterion 1'],
          stage_receipts: [{
            stage_id: 'S01',
            stage_manifest: { path: stageManifestPath, digest: stageManifestCanonicalDigest },
            review_receipt: { path: reviewPath, digest: reviewDigest },
            gate_receipt: { path: gatePathA, digest: digestB },
          }],
          e2e_steps: [{ id: 'smoke', executable: 'node', args: ['-e', 'console.log("ok")'] }],
        });
        const r1 = cliRun(COMPILE_PROJECT_ACCEPTANCE, inputPath, manifestPath);
        expect(r1.status).toBe(0);

        // Read compiled manifest
        const compiledManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const expectedSnapshot = compiledManifest.expected_snapshot;
        const manifestCanonicalDigest = computeCanonicalJsonDigest(
          ProjectAcceptanceManifestSchema, compiledManifest,
        );

        // Write E2E receipt via Writer
        const e2eReceiptPath = writeProjectE2EReceipt(dir, {
          project_id: 'rc24-t6',
          verdict: 'PASS',
          snapshot: expectedSnapshot,
          manifest_digest: manifestCanonicalDigest,
          expected_snapshot: expectedSnapshot,
          executed_snapshot: expectedSnapshot,
          steps: [{ step_id: 'smoke', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: new Date().toISOString(),
        });
        const e2eDigest = computeFileDigest(e2eReceiptPath);

        // Write reviewer result
        const reviewerResultPath = join(dir, 'reviewer-result.json');
        writeJSON(reviewerResultPath, {
          verdict: 'PROJECT_ACCEPTED',
          reviewer: 'brain',
          reviewed_snapshot: expectedSnapshot,
          project_manifest: { path: manifestPath, digest: manifestCanonicalDigest },
          project_e2e_receipt: { path: e2eReceiptPath, digest: e2eDigest },
          criteria_results: [{ criteria: 'Criterion 1', passed: true }],
          findings: [{ category: 'final-review', description: 'accepted' }],
          accepted_deviations: [],
          reviewed_at: new Date().toISOString(),
        });

        // Finalize → FAIL (gate file at path A doesn't match declared digest from path B)
        const finPath = join(dir, 'fin-input.json');
        writeJSON(finPath, {
          manifestPath, e2eReceiptPath, reviewerResultPath, outputDir: dir,
        });
        const r2 = cliRun(FINALIZE_PROJECT_REVIEW, finPath);
        expect(r2.status).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });

  describe('validate-stage.js', () => {

    const VALID_TASKS_MD = `# Stage S01 — Test Stage

## Stage Goal

This is a test stage.

## Observable Outcomes

- OUT-01 First outcome

## Dependencies

---

## Slice S01-A — First Slice
<!-- SLICE:S01-A:BEGIN -->

### Goal

First slice goal

### Observable Outcome

OUT-01 realized

### Public Seam

Test seam

### Risk Facts

- persistent_state

### Dependencies

### Proof Obligations

- PO-S01-A-01
  - Behavior: verified
  - Public Seam: Test seam
  - Oracle Source: integration test
  - Success / Failure: exit 0
  - Required Observation: N/A
  - Applicable Risk Facts:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S01-A-01 | unit | Test seam | verify behavior |

### Tasks

- [ ] S01-A-T01 Do the task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S01-A:END -->

---

## Slice → Stage Closure
`;

    function makeValidManifest(stageId = 'S01'): Record<string, unknown> {
      return {
        stage_id: stageId,
        source_path: 'tasks.md',
        source_digest: '0000000000000000000000000000000000000000000000000000000000000000',
        stage_goal: 'Test stage goal',
        outcomes: ['Outcome 1'],
        slices: [{
          slice_id: stageId + '-A',
          goal: 'Goal',
          observable_outcome: 'Outcome',
          public_seam: 'Seam',
          dependencies: [],
          proof_obligations: [],
          tasks: [],
          risk_facts: ['persistent_state'],
          evidence_path: 'delivery/stages/S01/evidence/S01-A.md',
          cv_minimum_level: 'standard',
        }],
        dependencies: [],
        risk_facts: [],
        runtime_proof: [],
        compiled_at: new Date().toISOString(),
        compiled_by: 'test',
      };
    }

    test('exit 0 with valid tasks and manifest', () => {
      const dir = tmpDir();
      try {
        const tasksPath = join(dir, 'tasks.md');
        writeFileSync(tasksPath, VALID_TASKS_MD, 'utf-8');

        // Compile manifest from the same tasks file so source_path/digest match
        const r0 = cliRun(COMPILE_MANIFEST, tasksPath, join(dir, 'manifest.json'));
        expect(r0.status).toBe(0);
        const manifestPath = join(dir, 'manifest.json');

        const r = cliRun(VALIDATE_STAGE, tasksPath, manifestPath);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/passed/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('exit 1 when tasks file does not exist', () => {
      const dir = tmpDir();
      try {
        const manifestPath = join(dir, 'manifest.json');
        writeJSON(manifestPath, makeValidManifest());

        const r = cliRun(VALIDATE_STAGE, '/nonexistent/tasks.md', manifestPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/not found/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('exit 1 when manifest file does not exist', () => {
      const dir = tmpDir();
      try {
        const tasksPath = join(dir, 'tasks.md');
        writeFileSync(tasksPath, VALID_TASKS_MD, 'utf-8');

        const r = cliRun(VALIDATE_STAGE, tasksPath, '/nonexistent/manifest.json');
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/not found/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('exit 1 when manifest has invalid schema', () => {
      const dir = tmpDir();
      try {
        const tasksPath = join(dir, 'tasks.md');
        writeFileSync(tasksPath, VALID_TASKS_MD, 'utf-8');
        const manifestPath = join(dir, 'manifest.json');
        // Write manifest missing required fields (no slices)
        writeJSON(manifestPath, { stage_id: 'S01', source_path: 'tasks.md' });

        const r = cliRun(VALIDATE_STAGE, tasksPath, manifestPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/schema validation failed/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('exit 1 when manifest source_digest does not match', () => {
      const dir = tmpDir();
      try {
        const tasksPath = join(dir, 'tasks.md');
        writeFileSync(tasksPath, VALID_TASKS_MD, 'utf-8');
        const manifestPath = join(dir, 'manifest.json');
        const manifest = makeValidManifest();
        manifest.source_digest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'; // wrong digest
        writeJSON(manifestPath, manifest);

        const r = cliRun(VALIDATE_STAGE, tasksPath, manifestPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/MANIFEST_SOURCE_DIGEST_MISMATCH/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('exit 1 when manifest has duplicate slice_id', () => {
      const dir = tmpDir();
      try {
        const tasksPath = join(dir, 'tasks.md');
        writeFileSync(tasksPath, VALID_TASKS_MD, 'utf-8');
        const manifestPath = join(dir, 'manifest.json');
        const manifest = makeValidManifest();
        // Add a duplicate slice with same slice_id
        manifest.slices = [
          ...manifest.slices,
          { ...manifest.slices[0] }, // duplicate
        ];
        writeJSON(manifestPath, manifest);

        const r = cliRun(VALIDATE_STAGE, tasksPath, manifestPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/DUPLICATE_MANIFEST_SLICE_ID/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('exit 1 when manifest has duplicate evidence_path', () => {
      const dir = tmpDir();
      try {
        const tasksPath = join(dir, 'tasks.md');
        writeFileSync(tasksPath, VALID_TASKS_MD, 'utf-8');
        const manifestPath = join(dir, 'manifest.json');
        const manifest = makeValidManifest();
        // Add another slice with same evidence_path
        manifest.slices = [
          ...manifest.slices,
          {
            slice_id: 'S01-B',
            goal: 'Another slice',
            observable_outcome: 'Outcome',
            public_seam: 'Seam',
            dependencies: [],
            proof_obligations: [],
            tasks: [],
            risk_facts: ['none'],
            evidence_path: 'delivery/stages/S01/evidence/S01-A.md', // same as S01-A
            cv_minimum_level: 'lite',
          },
        ];
        writeJSON(manifestPath, manifest);

        const r = cliRun(VALIDATE_STAGE, tasksPath, manifestPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/DUPLICATE_MANIFEST_EVIDENCE_PATH/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('exit 1 when manifest stage_id does not match tasks stage ID', () => {
      const dir = tmpDir();
      try {
        const tasksPath = join(dir, 'tasks.md');
        writeFileSync(tasksPath, VALID_TASKS_MD, 'utf-8');
        const manifestPath = join(dir, 'manifest.json');
        const manifest = makeValidManifest('S99'); // manifest says S99, but tasks says S01
        writeJSON(manifestPath, manifest);

        const r = cliRun(VALIDATE_STAGE, tasksPath, manifestPath);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/STAGE_ID_MISMATCH/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('exit 1 with evidence-dir missing evidence files', () => {
      const dir = tmpDir();
      try {
        const tasksPath = join(dir, 'tasks.md');
        writeFileSync(tasksPath, VALID_TASKS_MD, 'utf-8');

        // Compile manifest
        const r0 = cliRun(COMPILE_MANIFEST, tasksPath, join(dir, 'manifest.json'));
        expect(r0.status).toBe(0);
        const manifestPath = join(dir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        // Create canonical evidence dir (empty — missing evidence files)
        const evidenceDir = join(dir, 'delivery', 'stages', manifest.stage_id, 'evidence');
        mkdirSync(evidenceDir, { recursive: true });

        const r = cliRun(VALIDATE_STAGE, tasksPath, manifestPath, evidenceDir);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/MISSING_EVIDENCE_FILE/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);

    test('exit 0 with evidence-dir and all evidence files present', () => {
      const dir = tmpDir();
      try {
        const tasksPath = join(dir, 'tasks.md');
        writeFileSync(tasksPath, VALID_TASKS_MD, 'utf-8');

        // Compile manifest
        const r0 = cliRun(COMPILE_MANIFEST, tasksPath, join(dir, 'manifest.json'));
        expect(r0.status).toBe(0);
        const manifestPath = join(dir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        // Create evidence files matching manifest evidence_path
        const evidenceDir = join(dir, 'delivery', 'stages', 'S01', 'evidence');
        mkdirSync(evidenceDir, { recursive: true });
        for (const slice of manifest.slices) {
          const fileName = basename(slice.evidence_path);
          writeFileSync(join(evidenceDir, fileName), `# ${slice.slice_id} Evidence`, 'utf-8');
        }

        const r = cliRun(VALIDATE_STAGE, tasksPath, manifestPath, evidenceDir);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/passed/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);
  });

  // ────────────────────────────────────────────────────────────────────────────
  //  Batch 5: derive-next-action.js CLI
  // ────────────────────────────────────────────────────────────────────────────

  describe('derive-next-action.js', () => {

    test('valid state.json → outputs JSON action, exit 0', () => {
      const dir = tmpDir();
      try {
        const statePath = join(dir, 'state.json');
        writeJSON(statePath, {
          stage_gate: { gate_run: false, gate_passed: false },
          slices: [{
            slice_id: 'S01-A',
            dependencies: [],
            tasks: [{ task_id: 'S01-A-T1', checked: false, evidence_written: false }],
            slice_evidence_finalized: false,
            cv_status: 'NOT_RUN',
            repair_attempt: 0,
            scope_check_passed: false,
            committed: false,
            integrated: false,
            complete: false,
          }],
          stage_committed: false,
          stage_integrated: false,
        });

        const { stdout, stderr, status } = cliRun(DERIVE_NEXT_ACTION, statePath);

        expect(status).toBe(0);
        expect(stderr).toBe('');

        const action = JSON.parse(stdout);
        expect(action.action_type).toBe('implement');
        expect(action.slice_id).toBe('S01-A');
        expect(action.task_id).toBe('S01-A-T1');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('missing state.json path → stderr usage, exit 1', () => {
      const { stdout, stderr, status } = cliRun(DERIVE_NEXT_ACTION);
      expect(status).toBe(1);
      expect(stderr).toMatch(/Usage/);
      expect(stdout).toBe('');
    });

    test('nonexistent state file → stderr error, exit 1', () => {
      const { stderr, status } = cliRun(DERIVE_NEXT_ACTION, '/nonexistent/state.json');
      expect(status).toBe(1);
      expect(stderr).toMatch(/Cannot read state file/);
    });

    test('invalid JSON → stderr error, exit 1', () => {
      const dir = tmpDir();
      try {
        const statePath = join(dir, 'bad.json');
        writeFileSync(statePath, 'not valid json', 'utf-8');

        const { stderr, status } = cliRun(DERIVE_NEXT_ACTION, statePath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/Invalid JSON/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('missing stage_gate → Validation Error, exit 1', () => {
      const dir = tmpDir();
      try {
        const statePath = join(dir, 'bad.json');
        writeJSON(statePath, {
          slices: [],
          stage_committed: false,
          stage_integrated: false,
        });

        const { stderr, status } = cliRun(DERIVE_NEXT_ACTION, statePath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/stage_gate/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('non-array slices → Validation Error, exit 1', () => {
      const dir = tmpDir();
      try {
        const statePath = join(dir, 'bad.json');
        writeJSON(statePath, {
          stage_gate: { gate_run: false, gate_passed: false },
          slices: 'not array',
          stage_committed: false,
          stage_integrated: false,
        });

        const { stderr, status } = cliRun(DERIVE_NEXT_ACTION, statePath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/slices.*must be an array/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('invalid cv_status → Validation Error, exit 1', () => {
      const dir = tmpDir();
      try {
        const statePath = join(dir, 'bad.json');
        writeJSON(statePath, {
          stage_gate: { gate_run: false, gate_passed: false },
          slices: [{
            slice_id: 'S01-A',
            dependencies: [],
            tasks: [],
            slice_evidence_finalized: false,
            cv_status: 'INVALID',
            repair_attempt: 0,
            committed: false,
            integrated: false,
            complete: false,
          }],
          stage_committed: false,
          stage_integrated: false,
        });

        const { stderr, status } = cliRun(DERIVE_NEXT_ACTION, statePath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/cv_status/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('negative repair_attempt → Validation Error, exit 1', () => {
      const dir = tmpDir();
      try {
        const statePath = join(dir, 'bad.json');
        writeJSON(statePath, {
          stage_gate: { gate_run: false, gate_passed: false },
          slices: [{
            slice_id: 'S01-A',
            dependencies: [],
            tasks: [],
            slice_evidence_finalized: false,
            cv_status: 'NOT_RUN',
            repair_attempt: -1,
            committed: false,
            integrated: false,
            complete: false,
          }],
          stage_committed: false,
          stage_integrated: false,
        });

        const { stderr, status } = cliRun(DERIVE_NEXT_ACTION, statePath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/repair_attempt/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  //  Batch 5: update-current-cv-status.js CLI
  // ────────────────────────────────────────────────────────────────────────────

  describe('update-current-cv-status.js', () => {

    test('valid options.json → outputs JSON result, exit 0', () => {
      const dir = tmpDir();
      try {
        // Create canonical evidence directory
        const evidenceDir = join(dir, 'delivery', 'stages', 'S01', 'evidence');
        mkdirSync(evidenceDir, { recursive: true });

        // Write a valid evidence file at canonical path
        const evidencePath = join(evidenceDir, 'S01-A.md');
        writeFileSync(evidencePath, `# Slice S01-A Evidence

## Current CV Status

- Status: NOT_RUN
- Level: *Not yet determined*
- Latest CV Receipt: *None*
- Open Finding: *None*

## Other
`, 'utf-8');

        // Write options with required canonical fields
        const optsPath = join(dir, 'opts.json');
        writeJSON(optsPath, {
          evidencePath,
          status: 'READY_FOR_CV',
          stageId: 'S01',
          sliceId: 'S01-A',
          deliveryRoot: dir,
        });

        const { stdout, stderr, status } = cliRun(UPDATE_CV_STATUS, optsPath);

        expect(status).toBe(0);
        expect(stderr).toBe('');

        const result = JSON.parse(stdout);
        expect(result.success).toBe(true);
        expect(result.modified).toBe(true);

        // Verify the file was actually updated
        const content = readFileSync(evidencePath, 'utf-8');
        expect(content).toContain('- Status: READY_FOR_CV');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('missing options path → stderr usage, exit 1', () => {
      const { stdout, stderr, status } = cliRun(UPDATE_CV_STATUS);
      expect(status).toBe(1);
      expect(stderr).toMatch(/Usage/);
      expect(stdout).toBe('');
    });

    test('nonexistent options file → stderr error, exit 1', () => {
      const { stderr, status } = cliRun(UPDATE_CV_STATUS, '/nonexistent/opts.json');
      expect(status).toBe(1);
      expect(stderr).toMatch(/ENOENT|no such file|Cannot read/);
    });

    test('invalid JSON → stderr error, exit 1', () => {
      const dir = tmpDir();
      try {
        const optsPath = join(dir, 'bad.json');
        writeFileSync(optsPath, 'not json', 'utf-8');

        const { stderr, status } = cliRun(UPDATE_CV_STATUS, optsPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/Invalid JSON/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('missing evidencePath → Validation Error, exit 1', () => {
      const dir = tmpDir();
      try {
        const optsPath = join(dir, 'bad.json');
        writeJSON(optsPath, { status: 'READY_FOR_CV', stageId: 'S01', sliceId: 'S01-A', deliveryRoot: dir });

        const { stderr, status } = cliRun(UPDATE_CV_STATUS, optsPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/evidencePath/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('empty status string → Validation Error, exit 1', () => {
      const dir = tmpDir();
      try {
        const optsPath = join(dir, 'bad.json');
        writeJSON(optsPath, { evidencePath: '/some/path.md', status: '' });

        const { stderr, status } = cliRun(UPDATE_CV_STATUS, optsPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/status/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('non-string cvLevel → Validation Error, exit 1', () => {
      const dir = tmpDir();
      try {
        const optsPath = join(dir, 'bad.json');
        writeJSON(optsPath, { evidencePath: "/some/path.md", status: "READY_FOR_CV", cvLevel: 42, stageId: "S01", sliceId: "S01-A", deliveryRoot: dir });

        const { stderr, status } = cliRun(UPDATE_CV_STATUS, optsPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/cvLevel/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('evidence missing section → library fail, exit 1', () => {
      const dir = tmpDir();
      try {
                // Create canonical evidence directory
        const evidenceDir = join(dir, 'delivery', 'stages', 'S01', 'evidence');
        mkdirSync(evidenceDir, { recursive: true });

        // Evidence file without ## Current CV Status section
        const evidencePath = join(evidenceDir, 'S01-A.md');
        writeFileSync(evidencePath, '# Slice\n\n## Task Evidence\n\nNo CV status here.\n', 'utf-8');

        const optsPath = join(dir, 'opts.json');
        writeJSON(optsPath, { evidencePath, status: 'READY_FOR_CV', stageId: 'S01', sliceId: 'S01-A', deliveryRoot: dir });

        const { stdout, stderr, status } = cliRun(UPDATE_CV_STATUS, optsPath);
        expect(status).toBe(1);
        expect(stdout).toMatch(/missing/);
        expect(stdout).toMatch(/Current CV Status/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('evidence missing - Status: line → library fail, exit 1', () => {
      const dir = tmpDir();
      try {
        const evidenceDir = join(dir, 'delivery', 'stages', 'S01', 'evidence');
        mkdirSync(evidenceDir, { recursive: true });

        const evidencePath = join(evidenceDir, 'S01-A.md');
        writeFileSync(evidencePath, `# Slice

## Current CV Status

- Level: standard
- Latest CV Receipt: *None*

## Other
`, 'utf-8');

        const optsPath = join(dir, 'opts.json');
        writeJSON(optsPath, { evidencePath, status: 'READY_FOR_CV', stageId: 'S01', sliceId: 'S01-A', deliveryRoot: dir });

        const { stdout, status } = cliRun(UPDATE_CV_STATUS, optsPath);
        expect(status).toBe(1);
        expect(stdout).toMatch(/- Status:/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  //  Batch 6: executor-next-action.js CLI
  // ────────────────────────────────────────────────────────────────────────────

  describe('executor-next-action.js', () => {

    test('missing input path → stderr usage, exit 1', () => {
      const { stdout, stderr, status } = cliRun(EXECUTOR_NEXT_ACTION);
      expect(status).toBe(1);
      expect(stderr).toMatch(/Usage/);
      expect(stdout).toBe('');
    });

    test('nonexistent input file → stderr error, exit 1', () => {
      const { stderr, status } = cliRun(EXECUTOR_NEXT_ACTION, '/nonexistent/input.json');
      expect(status).toBe(1);
      expect(stderr).toMatch(/ENOENT|no such file|Cannot read/);
    });

    test('invalid JSON file → stderr error, exit 1', () => {
      const dir = tmpDir();
      try {
        const inputPath = join(dir, 'bad.json');
        writeFileSync(inputPath, 'not valid json', 'utf-8');

        const { stderr, status } = cliRun(EXECUTOR_NEXT_ACTION, inputPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/Invalid JSON|Error reading input/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('missing required fields → stderr error, exit 1', () => {
      const dir = tmpDir();
      try {
        const inputPath = join(dir, 'bad.json');
        writeJSON(inputPath, { stage_id: 'S01' });

        const { stderr, status } = cliRun(EXECUTOR_NEXT_ACTION, inputPath);
        expect(status).toBe(1);
        expect(stderr).toMatch(/manifest_path|tasks_path|project_root/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('valid path input with compiled manifest → exit 0, outputs JSON with action', () => {
      const dir = tmpDir();
      try {
        // ── 1. Create project structure ──
        const projectRoot = dir;
        const tasksDir = join(dir, 'delivery', 'stages', 'S01');
        const evidenceDir = join(tasksDir, 'evidence');
        mkdirSync(evidenceDir, { recursive: true });

        // ── 2. Write tasks.md ──
        const tasksPath = join(tasksDir, 'tasks.md');
        writeFileSync(tasksPath, TASKS_MD_CONTENT, 'utf-8');

        // ── 3. Compile manifest ──
        const manifestPath = join(dir, '.proofloop', 'manifests', 'S01.json');
        mkdirSync(join(dir, '.proofloop', 'manifests'), { recursive: true });
        const r0 = cliRun(COMPILE_MANIFEST, tasksPath, manifestPath);
        expect(r0.status).toBe(0);

        // ── 4. Create reconcile input JSON ──
        const inputPath = join(dir, 'reconcile-input.json');
        writeJSON(inputPath, {
          stage_id: 'S01',
          project_root: projectRoot,
          manifest_path: manifestPath,
          tasks_path: tasksPath,
        });

        // ── 5. Run executor-next-action ──
        const { stdout, stderr, status } = cliRun(EXECUTOR_NEXT_ACTION, inputPath);
        expect(status).toBe(0);
        expect(stderr).toBe('');

        // ── 6. Verify output ──
        const result = JSON.parse(stdout);
        expect(result).toHaveProperty('stage_id', 'S01');
        expect(result).toHaveProperty('manifest_digest');
        expect(typeof result.manifest_digest).toBe('string');
        expect(result.manifest_digest!.length).toBeGreaterThan(0);
        expect(result).toHaveProperty('action');
        expect(result.action).toHaveProperty('action_type');
        expect(result.action).toHaveProperty('action', result.action.action_type);
        expect(typeof result.action.action_type).toBe('string');
        expect(result.action).toHaveProperty('reason');
        expect(typeof result.action.reason).toBe('string');
        expect(result.action.reason.length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });
});
