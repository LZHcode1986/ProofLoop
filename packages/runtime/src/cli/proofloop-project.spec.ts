/**
 * proofloop-project.spec.ts — S10-D-T02: project 域 handler 测试。
 *
 * PO binding: REF-S10-D-T02, REF-CLI-ACCEPTANCE（Acceptance D：Project
 * Acceptance compile/run-e2e/prepare/finalize/status 均可从同一 public CLI
 * 调用，Project verdict 仍由 AI Project Reviewer 提供，CLI 不替代判断）,
 * REF-CLI-SEAM（§Preflight/Persistence/Failure）, REF-CLI-ORACLE,
 * REF-S08E-RISK。
 *
 * 覆盖（对齐 S10-C 教训：成功路径全部 built public `node dist/cli/proofloop.js`
 * spawnSync + 临时 fixture；handler-direct 仅失败/边界用例）：
 *  - `project status`：只读 Project Acceptance 状态/Receipt 报告（project/
 *    类别 Receipt 的 kernel envelope + digest-addressed + self-digest +
 *    closed type 集校验，PROJECT_REVIEW_PASS.previous_digest 必须指向类别内
 *    存在的 E2E receipt；空类别为正常可查询状态，exit 0 —— S10 运行证明第 8 步
 *    `project status --json` 必须 exit 0，无 --stage，project 域全局）；
 *  - `project compile-acceptance`：复用 compile-project-acceptance seam
 *    生成 ProjectAcceptanceManifest（input_path/output_path root-relative，
 *    input project_root 必须等于 canonical trust root），返回 ref+digest；
 *  - `project run-e2e`：复用 run-project-acceptance seam 执行 E2E steps 并
 *    写 Project E2E Gate Receipt（PASS → Receipt ref+digest exit 0；步骤失败
 *    → canonical Finding exit 2，E2E FAIL Receipt 按 seam 既有语义留档；
 *    stale snapshot / 非法 manifest → BLOCKED 零写入）；
 *  - `project prepare-review`：只读组装 Project Review Input（manifest
 *    ref+digest + 最新 PROJECT_E2E_PASS + review 链 + ready_for_review），
 *    零写入；
 *  - `project finalize-review`：复用 finalize-project-review seam ——
 *    request verdict（closed PROJECT_ACCEPTED|PROJECT_REJECTED|
 *    PROJECT_BLOCKED）+ summary 非空校验，且与 reviewer result 文件 verdict
 *    一致（CLI 只机械验证，不替代 AI Project Reviewer 判断）；成功
 *    PROJECT_REVIEW_PASS Receipt ref+digest；失败 canonical Finding + no-write；
 *  - 未知操作 fail closed（RUNTIME.SCHEMA_MISMATCH，exit 2）；
 *  - 伪造/错位 project Receipt → status fail closed（RUNTIME.RECEIPT_CHAIN_BROKEN）。
 *
 * 注意：`proofloop <domain> <operation>` dispatcher wiring（proofloop.ts）
 * 与 project 域 closed request 字段登记（proofloop-common.ts）按 S10-C/S10-D-T01
 * 先例由 Runtime direct-fix 完成（二者均不在本任务 execution_scope 内）；
 * 本任务交付 handler（proofloop-project.ts）+ 本 spec + Evidence。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { computeReceiptDigest, computeDigest, validateReceipt, writeReceipt } from '@proofloop/kernel';
import { computeCanonicalJsonDigest, fileDigest16 } from '../project-acceptance';
// handler-direct 直通入口：仅失败/边界用例（成功路径一律 built public CLI）。
import { runProjectFromArgv } from './proofloop-project';

const repo = path.resolve(__dirname, '../../../..');
const DIST_PROOFLOOP = path.join(repo, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

const SNAPSHOT_HEX16 = 'a1b2c3d4e5f6a7b8';

interface ProjectCliFixture {
  readonly root: string;
  /** 编译输入（root-relative，含 project_root=fixture root）。 */
  readonly compileInputPath: string;
  /** 默认 manifest 输出路径（root-relative）。 */
  readonly manifestPath: string;
  readonly stage: {
    stageManifestPath: string;
    stageManifestDigest: string;
    reviewPath: string;
    reviewDigest: string;
    gatePath: string;
    gateDigest: string;
  };
}

/** 完整 project 链 fixture：git 仓库 + stage 证据 + 编译输入（基线 commit）。 */
function prepareFixture(e2eSteps: readonly Record<string, unknown>[] = PASSING_STEPS): ProjectCliFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-cli-')));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'project-cli@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Project CLI Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\nartifacts/\n', 'utf8');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed', 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'project CLI fixture baseline']);

  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(artifacts, { recursive: true });

  // stage 证据（vNext：v2 manifest + STAGE_REVIEW_PASS/GATE_PASS envelope，
  // triple-binding 一致，finalize 校验链所需）。
  const HEX64_FILL = (seed: string): string => seed.repeat(64).slice(0, 64);
  const SNAPSHOT_HEX40 = '15d873a0d06831be3f11fccd8042b536fd4f04d0';
  const stageManifest = {
    version: 2,
    stage_id: 'S01',
    plan: {
      ref: 'delivery/stages/S01/tasks.md',
      plan_digest: HEX64_FILL('a'),
      schema_version: 2,
    },
    reference_index: {
      'REF-GOAL': { kind: 'goal', ref: 'delivery/stages/S01/tasks.md#/entities/goal', file_digest: HEX64_FILL('b'), section_digest: HEX64_FILL('c') },
      'REF-TASK': { kind: 'task', ref: 'delivery/stages/S01/tasks.md#/entities/slice-task', file_digest: HEX64_FILL('d'), section_digest: HEX64_FILL('e') },
      'REF-ACCEPT': { kind: 'acceptance', ref: 'delivery/stages/S01/tasks.md#/entities/acceptance', file_digest: HEX64_FILL('f'), section_digest: HEX64_FILL('a') },
      'REF-SEAM': { kind: 'seam', ref: 'delivery/stages/S01/tasks.md#/entities/seam', file_digest: HEX64_FILL('b'), section_digest: HEX64_FILL('c') },
      'REF-ORACLE': { kind: 'oracle', ref: 'delivery/stages/S01/tasks.md#/entities/oracle', file_digest: HEX64_FILL('d'), section_digest: HEX64_FILL('e') },
    },
    slices: [
      {
        slice_id: 'S01-A',
        proof_index: {
          slice_id: 'S01-A',
          goal_ref: 'REF-GOAL',
          task_refs: ['REF-TASK'],
          acceptance_refs: ['REF-ACCEPT'],
          seam_refs: ['REF-SEAM'],
          oracle_refs: ['REF-ORACLE'],
          risk_refs: [],
        },
        required_skills: ['typescript'],
        depends_on: [],
        evidence_path: 'delivery/stages/S01/evidence/S01-A.md',
      },
    ],
    task_scopes: {
      'slice-task': {
        task_ref: 'delivery/stages/S01/tasks.md#/entities/slice-task',
        execution_scope: { kind: 'implementation', code_paths: ['src'], test_paths: ['test'], forbidden_paths: [] },
      },
    },
  };
  const stageManifestPath = path.join(artifacts, 'stage-manifest-S01.json');
  fs.writeFileSync(stageManifestPath, JSON.stringify(stageManifest, null, 2), 'utf-8');
  const stageManifestDigest = computeDigest(JSON.parse(fs.readFileSync(stageManifestPath, 'utf-8')));
  const gateEnvelope = {
    version: 1,
    type: 'GATE_PASS',
    stage_id: 'S01',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: {
      action: 'GATE',
      type: 'GATE_RESULT',
      schema_version: 2,
      verdict: 'PASS',
      stage_id: 'S01',
      manifest_digest: stageManifestDigest,
      snapshot_digest: SNAPSHOT_HEX40,
      receipt_chain_valid: true,
    },
  };
  const gate = { ...gateEnvelope, digest: computeReceiptDigest(gateEnvelope as never) };
  const gatePath = path.join(artifacts, 'stage-gate-S01.json');
  fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2), 'utf-8');
  const gateDigest = gate['digest'] as string;
  const reviewEnvelope = {
    version: 1,
    type: 'STAGE_REVIEW_PASS',
    stage_id: 'S01',
    timestamp: '2025-01-01T00:00:10.000Z',
    payload: {
      action: 'STAGE_REVIEW',
      type: 'STAGE_REVIEW_RESULT',
      schema_version: 2,
      verdict: 'ACCEPTED',
      stage_id: 'S01',
      manifest_digest: stageManifestDigest,
      snapshot_digest: SNAPSHOT_HEX40,
      stage_gate_receipt_digest: gateDigest,
      receipt_chain_valid: true,
    },
  };
  const review = { ...reviewEnvelope, digest: computeReceiptDigest(reviewEnvelope as never) };
  const reviewPath = path.join(artifacts, 'stage-review-S01.json');
  fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2), 'utf-8');
  const reviewDigest = review['digest'] as string;

  const compileInputPath = 'artifacts/compile-input.json';
  fs.writeFileSync(
    path.join(root, compileInputPath),
    JSON.stringify({
      project_root: root,
      project_id: 'P1',
      prd_goals: ['Goal A'],
      acceptance_criteria: ['AC-01', 'AC-02'],
      stage_receipts: [
        {
          stage_id: 'S01',
          stage_manifest: { path: stageManifestPath, digest: stageManifestDigest },
          review_receipt: { path: reviewPath, digest: reviewDigest },
          gate_receipt: { path: gatePath, digest: gateDigest },
        },
      ],
      e2e_steps: e2eSteps,
    }, null, 2),
    'utf-8',
  );

  return {
    root,
    compileInputPath,
    manifestPath: '.proofloop/manifests/project-acceptance.json',
    stage: { stageManifestPath, stageManifestDigest, reviewPath, reviewDigest, gatePath, gateDigest },
  };
}

const PASSING_STEPS: readonly Record<string, unknown>[] = [
  { id: 'smoke-1', executable: 'node', args: ['-e', 'console.log("e2e ok")'], expected: { output_contains: 'e2e ok' } },
  { id: 'smoke-2', executable: 'node', args: ['-e', 'process.exit(0)'] },
];

function projectRequest(overrides: Record<string, unknown>): string {
  return JSON.stringify({ domain: 'project', operation: 'status', ...overrides });
}

/** built public `node dist/cli/proofloop.js` 进程级 runner（成功路径唯一 seam）。 */
function runPublicCli(args: readonly string[], cwd: string): { status: number; envelope: any } {
  const res = spawnSync(process.execPath, [DIST_PROOFLOOP, ...args], {
    cwd,
    encoding: 'utf8',
  });
  let envelope: any = null;
  try {
    envelope = JSON.parse(res.stdout);
  } catch {
    envelope = { parseError: res.stdout, stderr: res.stderr };
  }
  return { status: res.status ?? -1, envelope };
}

/** project/ 类别 receipt 文件清单（root-relative）。 */
function projectReceipts(root: string): string[] {
  const directory = path.join(root, '.proofloop', 'receipts', 'project');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
}

function receiptsListing(root: string): string[] {
  const directory = path.join(root, '.proofloop', 'receipts');
  if (!fs.existsSync(directory)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(directory, full));
    }
  };
  walk(directory);
  return out.sort();
}

function gitStatus(root: string): string {
  return execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
}

/** 通过 public CLI 完成 compile → run-e2e，返回 e2e receipt ref（root-relative）。 */
function compileAndRun(fixture: ProjectCliFixture): { compile: any; run: any; e2eRef: string } {
  const compile = runPublicCli(
    [
      'project',
      'compile-acceptance',
      '--json',
      projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
    ],
    fixture.root,
  );
  expect(compile.status).toBe(0);
  const run = runPublicCli(
    ['project', 'run-e2e', '--json', projectRequest({ operation: 'run-e2e', manifest_path: fixture.manifestPath })],
    fixture.root,
  );
  expect(run.status).toBe(0);
  const e2eRef = run.envelope.result.receipt_ref.ref as string;
  return { compile, run, e2eRef };
}

/**
 * 运行一次 compile → run-e2e，并写出与 manifest + e2e receipt 绑定的
 * AI Project Reviewer result 文件（root-relative）。返回 reviewer 文件路径、
 * run envelope 与 e2e receipt ref —— 调用方必须复用本次 e2eRef（重新 compile
 * 会产生新的 compiled_at digest，导致绑定失配）。
 */
function writeReviewerResult(
  fixture: ProjectCliFixture,
  overrides: Record<string, unknown> = {},
): { reviewerPath: string; run: any; e2eRef: string } {
  const { run } = compileAndRun(fixture);
  const manifestRaw = JSON.parse(
    fs.readFileSync(path.join(fixture.root, fixture.manifestPath), 'utf8'),
  ) as Record<string, any>;
  const manifestDigest = computeCanonicalJsonDigest(manifestRaw);
  const e2eRef = run.envelope.result.receipt_ref.ref as string;
  const e2ePath = path.join(fixture.root, e2eRef);
  const reviewer = {
    verdict: 'PROJECT_ACCEPTED',
    reviewer: 'cli-project-reviewer',
    reviewed_snapshot: manifestRaw.expected_snapshot,
    project_manifest: { path: path.resolve(fixture.root, fixture.manifestPath), digest: manifestDigest },
    project_e2e_receipt: { path: e2ePath, digest: fileDigest16(e2ePath) },
    criteria_results: [
      { criteria: 'AC-01', passed: true, notes: 'ok' },
      { criteria: 'AC-02', passed: true, notes: 'ok' },
    ],
    findings: [],
    accepted_deviations: [],
    reviewed_at: '2025-01-01T01:00:00.000Z',
    ...overrides,
  };
  const reviewerPath = 'artifacts/reviewer-result.json';
  fs.writeFileSync(path.join(fixture.root, reviewerPath), JSON.stringify(reviewer, null, 2), 'utf-8');
  return { reviewerPath, run, e2eRef };
}

// ============================================================
// built public proofloop.js 成功路径（临时 fixture，spawnSync）
// ============================================================

describe('built public proofloop.js project smoke（S10-D-T02 成功路径）', () => {
  it('`project status --json` exits 0 before any project receipt（empty project category is a queryable state）', async () => {
    const fixture = prepareFixture();
    const { status, envelope } = runPublicCli(['project', 'status', '--json'], fixture.root);
    expect(status).toBe(0);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'project', operation: 'status' });
    expect(envelope.result.project_id).toBeNull();
    expect(envelope.result.receipt_count).toBe(0);
    expect(envelope.result.e2e).toEqual({ receipt_count: 0, latest: null });
    expect(envelope.result.review).toEqual({ receipt_count: 0, latest: null });
    expect(envelope.result.chain_valid).toBe(true);
    expect(envelope.findings).toEqual([]);
  });

  it('`project status --json` exits 0 on the real repo（S10 runtime proof step 8, read-only, global）', async () => {
    const before = receiptsListing(repo);
    const { status, envelope } = runPublicCli(
      ['project', 'status', '--json'],
      path.join(repo, 'packages', 'runtime'),
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'project', operation: 'status' });
    expect(typeof envelope.result.receipt_count).toBe('number');
    expect(envelope.result.chain_valid).toBe(true);
    expect(receiptsListing(repo)).toEqual(before);
  });

  it('`project compile-acceptance --json` compiles the ProjectAcceptanceManifest and returns ref+digest', async () => {
    const fixture = prepareFixture();
    const { status, envelope } = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.success).toBe(true);
    expect(envelope.result.project_id).toBe('P1');
    expect(envelope.result.manifest_digest).toMatch(/^[a-f0-9]{16}$/);
    expect(envelope.result.output_path).toBe(fixture.manifestPath);
    expect(envelope.refs).toEqual([
      { ref: fixture.manifestPath, digest: envelope.result.manifest_digest },
    ]);
    expect(fs.existsSync(path.join(fixture.root, fixture.manifestPath))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.root, fixture.manifestPath), 'utf8'));
    expect(manifest.project_id).toBe('P1');
    expect(manifest.expected_snapshot).toMatch(/^[a-f0-9]{16}$/);
    expect(manifest.acceptance_criteria).toEqual(['AC-01', 'AC-02']);
    expect(gitStatus(fixture.root)).toBe('');
  });

  it('`project run-e2e --json` executes the E2E steps and returns the Project E2E Gate Receipt ref+digest', async () => {
    const fixture = prepareFixture();
    const { status, envelope } = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(status).toBe(0);

    const run = runPublicCli(
      ['project', 'run-e2e', '--json', projectRequest({ operation: 'run-e2e', manifest_path: fixture.manifestPath })],
      fixture.root,
    );
    expect(run.status).toBe(0);
    expect(run.envelope.ok).toBe(true);
    expect(run.envelope.result.verdict).toBe('PASS');
    expect(run.envelope.result.receipt_ref.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(run.envelope.result.receipt_ref.ref).toBe(
      `.proofloop/receipts/project/${run.envelope.result.receipt_ref.digest}.json`,
    );
    expect(run.envelope.refs).toEqual([run.envelope.result.receipt_ref]);
    const receiptPath = path.join(fixture.root, run.envelope.result.receipt_ref.ref);
    expect(fs.existsSync(receiptPath)).toBe(true);
    const receiptFile = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(receiptFile.type).toBe('PROJECT_E2E_PASS');
    expect(receiptFile.payload.verdict).toBe('PASS');
    expect(receiptFile.payload.project_id).toBe('P1');
    expect(gitStatus(fixture.root)).toBe('');
  });

  it('`project prepare-review --json` assembles the read-only Project Review Input（zero write）', async () => {
    const fixture = prepareFixture();
    const { run } = compileAndRun(fixture);
    const before = receiptsListing(fixture.root);
    const { status, envelope } = runPublicCli(
      ['project', 'prepare-review', '--json', projectRequest({ operation: 'prepare-review', manifest_path: fixture.manifestPath })],
      fixture.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result).toMatchObject({
      schema_version: 2,
      project_id: 'P1',
      ready_for_review: true,
    });
    expect(envelope.result.manifest.ref).toBe(fixture.manifestPath);
    expect(envelope.result.manifest.digest).toMatch(/^[a-f0-9]{16}$/);
    expect(envelope.result.manifest.acceptance_criteria).toEqual(['AC-01', 'AC-02']);
    expect(envelope.result.e2e.verdict).toBe('PASS');
    expect(envelope.result.e2e.digest).toBe(run.envelope.result.receipt_ref.digest);
    expect(envelope.result.review_chain.receipt_count).toBe(0);
    expect(receiptsListing(fixture.root)).toEqual(before);
  });

  it('`project finalize-review --json` accepts a consistent chain and returns the PROJECT_REVIEW_PASS ref+digest', async () => {
    const fixture = prepareFixture();
    const { reviewerPath, run, e2eRef } = writeReviewerResult(fixture);
    const before = projectReceipts(fixture.root).length;

    const { status, envelope } = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'CLI project finalize accepts the project',
        }),
      ],
      fixture.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.success).toBe(true);
    expect(envelope.result.verdict).toBe('PROJECT_ACCEPTED');
    expect(envelope.result.receipt_ref.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.result.receipt_ref.ref).toBe(
      `.proofloop/receipts/project/${envelope.result.receipt_ref.digest}.json`,
    );
    expect(envelope.refs).toEqual([envelope.result.receipt_ref]);
    expect(projectReceipts(fixture.root)).toHaveLength(before + 1);

    const receipt = JSON.parse(
      fs.readFileSync(path.join(fixture.root, envelope.result.receipt_ref.ref), 'utf8'),
    );
    expect(receipt.type).toBe('PROJECT_REVIEW_PASS');
    expect(receipt.previous_digest).toBe(run.envelope.result.receipt_ref.digest);
    expect(receipt.payload.verdict).toBe('PROJECT_ACCEPTED');
    expect(receipt.payload.project_id).toBe('P1');
  });

  it('`project status` reports the review tip after finalize', async () => {
    const fixture = prepareFixture();
    const { reviewerPath, run, e2eRef } = writeReviewerResult(fixture);
    const e2eDigest = run.envelope.result.receipt_ref.digest as string;
    const finalized = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'CLI project finalize accepts the project',
        }),
      ],
      fixture.root,
    );
    expect(finalized.status).toBe(0);
    const receiptDigest = finalized.envelope.result.receipt_ref.digest as string;

    const { status, envelope } = runPublicCli(['project', 'status', '--json'], fixture.root);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.project_id).toBe('P1');
    expect(envelope.result.receipt_count).toBe(2);
    expect(envelope.result.e2e.latest).toMatchObject({ verdict: 'PASS', digest: e2eDigest });
    expect(envelope.result.e2e.latest.digest).not.toBe(receiptDigest);
    expect(envelope.result.review.latest).toMatchObject({
      receipt_type: 'PROJECT_REVIEW_PASS',
      verdict: 'PROJECT_ACCEPTED',
      digest: receiptDigest,
    });
    expect(envelope.result.chain_valid).toBe(true);
  });

  it('`project run-e2e` with a failing step exits 2 with a canonical Finding（FAIL receipt kept as evidence by the seam）', async () => {
    const fixture = prepareFixture([
      { id: 'fail-step', executable: 'node', args: ['-e', 'process.exit(1)'] },
    ]);
    const compiled = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(compiled.status).toBe(0);

    const { status, envelope } = runPublicCli(
      ['project', 'run-e2e', '--json', projectRequest({ operation: 'run-e2e', manifest_path: fixture.manifestPath })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.result.verdict).toBe('FAIL');
    expect(envelope.findings[0].code).toBe('PROJECT.E2E_FAILED');
    // seam 既有语义：FAIL 也写 E2E Gate Receipt 留档（PASS/FAIL alike）。
    expect(typeof envelope.result.receipt_ref.ref).toBe('string');
    const receiptPath = path.join(fixture.root, envelope.result.receipt_ref.ref);
    expect(fs.existsSync(receiptPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).type).toBe('PROJECT_E2E_FAIL');
  });

  it('`project run-e2e` refuses a stale snapshot with zero writes（PROJECT_SOURCE_STALE, BLOCKED）', async () => {
    const fixture = prepareFixture();
    const compiled = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(compiled.status).toBe(0);
    fs.writeFileSync(path.join(fixture.root, 'seed.txt'), 'changed', 'utf8');

    const { status, envelope } = runPublicCli(
      ['project', 'run-e2e', '--json', projectRequest({ operation: 'run-e2e', manifest_path: fixture.manifestPath })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings.map((f: any) => f.message).join(' ')).toContain('PROJECT_SOURCE_STALE');
    expect(projectReceipts(fixture.root)).toHaveLength(0);
  });

  it('`project finalize-review` refuses a PROJECT_REJECTED reviewer result（no write）', async () => {
    const fixture = prepareFixture();
    const { reviewerPath, e2eRef } = writeReviewerResult(fixture, { verdict: 'PROJECT_REJECTED' });
    const before = projectReceipts(fixture.root).length;

    const { status, envelope } = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_REJECTED',
          summary: 'CLI project finalize rejects the project',
        }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings.length).toBeGreaterThan(0);
    expect(projectReceipts(fixture.root)).toHaveLength(before);
  });

  it('`project finalize-review` refuses when the request verdict contradicts the reviewer result file（no write）', async () => {
    const fixture = prepareFixture();
    const { reviewerPath, e2eRef } = writeReviewerResult(fixture, { verdict: 'PROJECT_BLOCKED' });
    const before = projectReceipts(fixture.root).length;

    const { status, envelope } = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'CLI project finalize accepts the project',
        }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PROJECT.REVIEWER_VERDICT_MISMATCH');
    expect(projectReceipts(fixture.root)).toHaveLength(before);
  });

  it('`project status` fails closed on a forged receipt in the project category（RUNTIME.RECEIPT_CHAIN_BROKEN）', async () => {
    const fixture = prepareFixture();
    const { reviewerPath, e2eRef } = writeReviewerResult(fixture);
    const finalized = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'CLI project finalize accepts the project',
        }),
      ],
      fixture.root,
    );
    expect(finalized.status).toBe(0);
    const projectDir = path.join(fixture.root, '.proofloop/receipts/project');
    const legitPath = path.join(projectDir, `${finalized.envelope.result.receipt_ref.digest}.json`);
    const legit = JSON.parse(fs.readFileSync(legitPath, 'utf8')) as Record<string, unknown>;
    const forged = JSON.parse(JSON.stringify(legit)) as Record<string, unknown>;
    forged.type = 'TASK_COMPLETE';
    forged.timestamp = String(legit.timestamp).slice(0, 10) + 'T00:00:00.000Z';
    const { digest: _oldDigest, ...content } = forged;
    void _oldDigest;
    forged.digest = computeReceiptDigest(content as never);
    fs.writeFileSync(path.join(projectDir, `${forged.digest}.json`), JSON.stringify(forged), 'utf8');

    const { status, envelope } = runPublicCli(['project', 'status', '--json'], fixture.root);
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('unknown project operation fails closed with a single envelope and no write（fixture, clean tree）', async () => {
    const fixture = prepareFixture();
    const before = projectReceipts(fixture.root).length;
    const { status, envelope } = runPublicCli(['project', 'bogus-op', '--json'], fixture.root);
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(projectReceipts(fixture.root)).toHaveLength(before);
    expect(gitStatus(fixture.root)).toBe('');
  });

  it('`project finalize-review` verifies the reviewer e2e receipt file-digest triple binding（tampered digest, no write）', async () => {
    const fixture = prepareFixture();
    const first = writeReviewerResult(fixture);
    const reviewerPath = 'artifacts/reviewer-result-tampered.json';
    const manifestRaw = JSON.parse(
      fs.readFileSync(path.join(fixture.root, fixture.manifestPath), 'utf8'),
    ) as Record<string, any>;
    const tampered = {
      verdict: 'PROJECT_ACCEPTED',
      reviewer: 'cli-project-reviewer',
      reviewed_snapshot: manifestRaw.expected_snapshot,
      project_manifest: {
        path: path.resolve(fixture.root, fixture.manifestPath),
        digest: computeCanonicalJsonDigest(manifestRaw),
      },
      project_e2e_receipt: { path: path.join(fixture.root, first.e2eRef), digest: 'd'.repeat(16) },
      criteria_results: [
        { criteria: 'AC-01', passed: true, notes: 'ok' },
        { criteria: 'AC-02', passed: true, notes: 'ok' },
      ],
      findings: [],
      accepted_deviations: [],
      reviewed_at: '2025-01-01T01:00:00.000Z',
    };
    fs.writeFileSync(path.join(fixture.root, reviewerPath), JSON.stringify(tampered, null, 2), 'utf-8');
    const before = projectReceipts(fixture.root).length;

    const { status, envelope } = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: first.e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'CLI project finalize accepts the project',
        }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(projectReceipts(fixture.root)).toHaveLength(before);
  });
});

// ============================================================
// handler-direct 失败/边界用例（成功路径一律 built public CLI）
// ============================================================

describe('project handler-direct boundary（runProjectFromArgv）', () => {
  it('`compile-acceptance` without input_path/output_path fails closed', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(['project', 'compile-acceptance'], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    // wiring direct-fix 前由 closed schema 拒绝（INPUT_INVALID）；登记后由
    // handler 缺参检查拒绝（SCHEMA_MISMATCH）。两种状态都必须零写入。
    expect(['RUNTIME.SCHEMA_MISMATCH', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
    expect(projectReceipts(fixture.root)).toHaveLength(0);
  });

  it('`run-e2e` without manifest_path fails closed', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(['project', 'run-e2e'], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.SCHEMA_MISMATCH', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
    expect(projectReceipts(fixture.root)).toHaveLength(0);
  });

  it('`prepare-review` without manifest_path fails closed', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(['project', 'prepare-review'], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.SCHEMA_MISMATCH', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
  });

  it('`finalize-review` without a verdict fails closed', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(
      ['project', 'finalize-review', '--json', projectRequest({ operation: 'finalize-review', summary: 'x' })],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.SCHEMA_MISMATCH', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
    expect(projectReceipts(fixture.root)).toHaveLength(0);
  });

  it('`finalize-review` with an empty summary fails closed', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(
      ['project', 'finalize-review', '--json', projectRequest({ operation: 'finalize-review', verdict: 'PROJECT_ACCEPTED', summary: '' })],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.SCHEMA_MISMATCH', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
    expect(projectReceipts(fixture.root)).toHaveLength(0);
  });

  it('`finalize-review` with an illegal verdict fails closed（closed set PROJECT_ACCEPTED|PROJECT_REJECTED|PROJECT_BLOCKED）', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(
      ['project', 'finalize-review', '--json', projectRequest({ operation: 'finalize-review', verdict: 'PROJECT_APPROVED', summary: 'x' })],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.SCHEMA_MISMATCH', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
    expect(projectReceipts(fixture.root)).toHaveLength(0);
  });

  it('`finalize-review` with a missing reviewer result file fails closed（no write）', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: '.proofloop/receipts/project/0000.json',
          reviewer_result_path: 'artifacts/missing-reviewer.json',
          verdict: 'PROJECT_ACCEPTED',
          summary: 'x',
        }),
      ],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.INPUT_INVALID', 'RUNTIME.SCHEMA_MISMATCH']).toContain(envelope.findings[0].code);
    expect(projectReceipts(fixture.root)).toHaveLength(0);
  });

  it('`prepare-review` refuses an absolute manifest path（PATH_OUTSIDE_ROOT）', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(
      [
        'project',
        'prepare-review',
        '--json',
        projectRequest({ operation: 'prepare-review', manifest_path: path.join(fixture.root, 'x.json') }),
      ],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.PATH_OUTSIDE_ROOT', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
  });

  it('`compile-acceptance` refuses a compile input whose project_root is not the trust root', async () => {
    const fixture = prepareFixture();
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-other-')));
    roots.push(other);
    fs.writeFileSync(path.join(fixture.root, 'artifacts', 'foreign-input.json'), JSON.stringify({
      project_root: other,
      project_id: 'P2',
      stage_receipts: [],
    }), 'utf8');
    const envelope = await runProjectFromArgv(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: 'artifacts/foreign-input.json', output_path: 'artifacts/out.json' }),
      ],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.PROJECT_ROOT_MISMATCH', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
    expect(fs.existsSync(path.join(fixture.root, 'artifacts', 'out.json'))).toBe(false);
  });

  it('status requires no parameters and reports an empty category（handler-direct parity）', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(['project', 'status', '--json'], { cwd: fixture.root });
    expect(envelope.ok).toBe(true);
    expect((envelope.result as any).receipt_count).toBe(0);
    expect((envelope.result as any).chain_valid).toBe(true);
  });

  it('non-project domain through the project entry fails closed（RUNTIME.SCHEMA_MISMATCH）', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(['stage', 'status', '--stage', 'S10'], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });

  it('`finalize-review` refuses when the e2e receipt path escapes the root', async () => {
    const fixture = prepareFixture();
    const envelope = await runProjectFromArgv(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: path.join(fixture.root, 'e2e.json'),
          reviewer_result_path: 'artifacts/r.json',
          verdict: 'PROJECT_ACCEPTED',
          summary: 'x',
        }),
      ],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.PATH_OUTSIDE_ROOT', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
    expect(projectReceipts(fixture.root)).toHaveLength(0);
  });
});

// ============================================================
// S10-D CV repair — 目录副作用 / 显式 E2E Receipt 完整校验 / latest 选择
// ============================================================

/**
 * 手工写一个 PROJECT_E2E_PASS receipt 到 canonical project/ 类别
 * （kernel writeReceipt，digest-addressed + self-digest 自洽）。
 */
function writeProjectE2EReceipt(
  root: string,
  timestamp: string,
): { ref: string; digest: string } {
  const receiptDir = path.join(root, '.proofloop', 'receipts', 'project');
  fs.mkdirSync(receiptDir, { recursive: true });
  const written = writeReceipt(
    {
      version: 1,
      type: 'PROJECT_E2E_PASS',
      stage_id: 'P1',
      slice_id: 'P1',
      timestamp,
      payload: {
        type: 'PROJECT_E2E_RESULT',
        verdict: 'PASS',
        project_id: 'P1',
        manifest_digest: 'a1b2c3d4e5f6a7b8',
        expected_snapshot: SNAPSHOT_HEX16,
        executed_snapshot: SNAPSHOT_HEX16,
        snapshot: SNAPSHOT_HEX16,
        steps: [{ step_id: 'smoke-1', exit_code: 0 }],
        service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
        created_at: timestamp,
      },
    },
    { receiptDir, tempDir: receiptDir },
  );
  return {
    ref: path.posix.join('.proofloop', 'receipts', 'project', path.basename(written.path)),
    digest: written.digest,
  };
}

describe('project fail-closed directory hygiene（S10-D CV repair）', () => {
  it('compile-acceptance with an invalid input does not create the manifest output directory', () => {
    const fixture = prepareFixture();
    // project_root 匹配但结构非法（stage_receipts 空数组）→ compile 拒绝；
    // 输出父目录（.proofloop/manifests）不得在校验前被创建。
    const badInput = 'artifacts/bad-compile-input.json';
    fs.writeFileSync(
      path.join(fixture.root, badInput),
      JSON.stringify({
        project_root: fixture.root,
        project_id: 'P1',
        prd_goals: ['Goal A'],
        acceptance_criteria: ['AC-01'],
        stage_receipts: [],
        e2e_steps: [],
      }),
      'utf-8',
    );
    const outDir = path.join(fixture.root, '.proofloop', 'manifests');
    const { status, envelope } = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: badInput, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('run-e2e with an invalid manifest does not create the project receipt directory', () => {
    const fixture = prepareFixture();
    const badManifest = 'artifacts/bad-manifest.json';
    fs.writeFileSync(path.join(fixture.root, badManifest), JSON.stringify({ project_id: 'P1' }), 'utf-8');
    const receiptDir = path.join(fixture.root, '.proofloop', 'receipts', 'project');
    const { status, envelope } = runPublicCli(
      ['project', 'run-e2e', '--json', projectRequest({ operation: 'run-e2e', manifest_path: badManifest })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(receiptDir)).toBe(false);
  });

  it('finalize-review with a tampered e2e receipt does not create the requested output directory', () => {
    const fixture = prepareFixture();
    const { reviewerPath, e2eRef } = writeReviewerResult(fixture);
    // 篡改 e2e receipt 内容（破坏 self-digest）→ finalize 拒绝；显式
    // output_dir 是全新目录，不得在最终校验前被创建。
    const e2eAbs = path.join(fixture.root, e2eRef);
    const raw = JSON.parse(fs.readFileSync(e2eAbs, 'utf8')) as Record<string, unknown>;
    raw['summary'] = 'tampered';
    fs.writeFileSync(e2eAbs, JSON.stringify(raw), 'utf-8');
    const outDir = 'artifacts/review-out';
    const { status, envelope } = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'finalize',
          output_dir: outDir,
        }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, outDir))).toBe(false);
  });
});

describe('prepare-review explicit e2e_receipt_path full validation（S10-D CV repair）', () => {
  it('a tampered explicit e2e receipt（broken self-digest）fails closed', () => {
    const fixture = prepareFixture();
    const { e2eRef } = compileAndRun(fixture);
    const e2eAbs = path.join(fixture.root, e2eRef);
    const raw = JSON.parse(fs.readFileSync(e2eAbs, 'utf8')) as Record<string, unknown>;
    raw['summary'] = 'tampered';
    fs.writeFileSync(e2eAbs, JSON.stringify(raw), 'utf-8');
    const { status, envelope } = runPublicCli(
      [
        'project',
        'prepare-review',
        '--json',
        projectRequest({ operation: 'prepare-review', manifest_path: fixture.manifestPath, e2e_receipt_path: e2eRef }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('a misplaced explicit e2e receipt（non-canonical project category path / wrong type）fails closed', () => {
    const fixture = prepareFixture();
    // prepare-review 需要可读 manifest —— 先 compile。
    const compile = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(compile.status).toBe(0);
    // 在 canonical project/ 类别外构造一个 self-digest 自洽、类型合法
    // （PROJECT_E2E_PASS）的 Receipt —— 显式路径必须拒绝类别外归属与
    // 非 digest-addressed 文件名（完整校验，与类别扫描同一强度）。
    // （writeReceipt 的 chain 校验要求 receiptDir 只含 receipt 文件，故用
    // 独立空目录，不放入 artifacts/。）
    const outDirAbs = path.join(fixture.root, 'artifacts', 'misplaced-receipts');
    fs.mkdirSync(outDirAbs, { recursive: true });
    const written = writeReceipt(
      {
        version: 1,
        type: 'PROJECT_E2E_PASS',
        stage_id: 'P1',
        slice_id: 'P1',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: {
          type: 'PROJECT_E2E_RESULT',
          verdict: 'PASS',
          project_id: 'P1',
          manifest_digest: 'a1b2c3d4e5f6a7b8',
          expected_snapshot: SNAPSHOT_HEX16,
          executed_snapshot: SNAPSHOT_HEX16,
          snapshot: SNAPSHOT_HEX16,
          steps: [{ step_id: 'smoke-1', exit_code: 0 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: '2025-01-01T00:00:00.000Z',
        },
      },
      { receiptDir: outDirAbs, tempDir: outDirAbs },
    );
    const misplacedRef = path.posix.join('artifacts', 'misplaced-receipts', path.basename(written.path));
    // 同时准备一个非 digest-addressed 文件名的副本（内容合法）。
    fs.copyFileSync(
      path.join(fixture.root, misplacedRef),
      path.join(fixture.root, 'artifacts', 'misplaced-receipts', 'renamed-e2e.json'),
    );
    const { status, envelope } = runPublicCli(
      [
        'project',
        'prepare-review',
        '--json',
        projectRequest({ operation: 'prepare-review', manifest_path: fixture.manifestPath, e2e_receipt_path: misplacedRef }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');

    // 非 digest-addressed 文件名同样拒绝。
    const renamed = runPublicCli(
      [
        'project',
        'prepare-review',
        '--json',
        projectRequest({
          operation: 'prepare-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: 'artifacts/misplaced-receipts/renamed-e2e.json',
        }),
      ],
      fixture.root,
    );
    expect(renamed.status).toBe(2);
    expect(renamed.envelope.ok).toBe(false);
  });
});

describe('project latest e2e receipt selection（S10-D CV repair）', () => {
  it('prepare-review selects the latest e2e receipt by timestamp, not by digest lexicographic order', () => {
    const fixture = prepareFixture();
    // compile manifest（prepare-review 需要）。
    const compile = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(compile.status).toBe(0);

    // 较早 receipt：T1。较晚 receipt：T2 —— 从基准时间起微调 timestamp 直到
    // digest(T2) 字典序 < digest(T1)（sha256 均匀分布，期望 2 次尝试；循环
    // 有界保证确定性），使旧实现（字典序选 latest）必然选错。
    const t1 = writeProjectE2EReceipt(fixture.root, '2025-01-01T00:00:00.000Z');
    let t2 = writeProjectE2EReceipt(fixture.root, '2025-01-02T00:00:00.000Z');
    let probe = 0;
    while (t2.digest >= t1.digest && probe < 10000) {
      probe += 1;
      t2 = writeProjectE2EReceipt(fixture.root, `2025-01-02T00:00:${String(probe).padStart(2, '0')}.000Z`);
    }
    expect(t2.digest < t1.digest).toBe(true);

    const { status, envelope } = runPublicCli(
      [
        'project',
        'prepare-review',
        '--json',
        projectRequest({ operation: 'prepare-review', manifest_path: fixture.manifestPath }),
      ],
      fixture.root,
    );

    expect(envelope.ok).toBe(true);
    if (envelope.result.e2e === null || envelope.result.e2e === undefined) {
      throw new Error(
        'DBG latest: e2e null; dir: ' +
          JSON.stringify(
            fs.readdirSync(path.join(fixture.root, '.proofloop', 'receipts', 'project')),
          ).slice(0, 400) +
          '; env: ' +
          JSON.stringify(envelope).slice(0, 300),
      );
    }
    // latest = 时间戳最大的 T2（即使其 digest 字典序最小）。
    expect(envelope.result.e2e.ref).toBe(t2.ref);
    expect(envelope.result.e2e.digest).toBe(t2.digest);
  });
});

// ============================================================
// S10-D CV repair Round 2 — 完整校验前置到 mkdirSync 之前
//（PROJECT-NOWRITE：非法/stale/绑定失败输入不得留下输出目录）
// ============================================================

describe('project full-validation-before-mkdir（S10-D CV repair Round 2）', () => {
  it('run-e2e with a stale manifest does not create the project receipt directory', () => {
    const fixture = prepareFixture();
    // compile manifest（expected_snapshot = compile 时 HEAD）。
    const compile = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(compile.status).toBe(0);
    // 之后 Git HEAD 推进 → manifest 的 expected_snapshot 过期（stale）。
    fs.writeFileSync(path.join(fixture.root, 'seed.txt'), 'changed', 'utf8');
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'post-compile change']);

    const receiptDir = path.join(fixture.root, '.proofloop', 'receipts', 'project');
    const { status, envelope } = runPublicCli(
      ['project', 'run-e2e', '--json', projectRequest({ operation: 'run-e2e', manifest_path: fixture.manifestPath })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].message).toContain('PROJECT_SOURCE_STALE');
    expect(fs.existsSync(receiptDir)).toBe(false);
  });

  it('compile-acceptance with a nested invalid stage_receipts entry does not create the manifest output directory', () => {
    const fixture = prepareFixture();
    // stage_receipts 非空但元素缺字段（嵌套 schema 非法）——浅校验会通过，
    // 完整 schema 校验必须前置并在创建输出目录前 fail closed。
    const badInput = 'artifacts/bad-compile-input-nested.json';
    fs.writeFileSync(
      path.join(fixture.root, badInput),
      JSON.stringify({
        project_root: fixture.root,
        project_id: 'P1',
        prd_goals: ['Goal A'],
        acceptance_criteria: ['AC-01'],
        stage_receipts: [{}],
        e2e_steps: [],
      }),
      'utf-8',
    );
    const outDir = path.join(fixture.root, '.proofloop', 'manifests');
    const { status, envelope } = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: badInput, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('finalize-review with a reviewer snapshot binding mismatch does not create the output directory', () => {
    const fixture = prepareFixture();
    // reviewer reviewed_snapshot 与 manifest expected_snapshot 不匹配 →
    // triple-binding 语义校验失败；输出目录不得在绑定校验前被创建。
    const { reviewerPath, e2eRef } = writeReviewerResult(fixture, { reviewed_snapshot: 'f'.repeat(16) });
    const outDir = 'artifacts/review-out-binding';
    const { status, envelope } = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'finalize',
          output_dir: outDir,
        }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, outDir))).toBe(false);
  });
});

// ============================================================
// S10-D CV repair Round 3 — 剩余语义校验前置到 mkdirSync 之前
//（topology / all-skipped / stage triple-binding / criteria one-to-one）
// ============================================================

describe('project topology-and-stage-validation-before-mkdir（S10-D CV repair Round 3）', () => {
  it('run-e2e with all-skipped steps does not create the project receipt directory', () => {
    const fixture = prepareFixture([
      {
        id: 'smoke-1',
        executable: 'node',
        args: ['-e', 'process.exit(0)'],
        not_applicable: { reason: 'fixture n/a' },
      },
    ]);
    const compile = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(compile.status).toBe(0);
    const receiptDir = path.join(fixture.root, '.proofloop', 'receipts', 'project');
    const { status, envelope } = runPublicCli(
      ['project', 'run-e2e', '--json', projectRequest({ operation: 'run-e2e', manifest_path: fixture.manifestPath })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].message).toContain('PROJECT_E2E_ALL_SKIPPED');
    expect(fs.existsSync(receiptDir)).toBe(false);
  });

  it('run-e2e with duplicate e2e step ids does not create the project receipt directory', () => {
    const fixture = prepareFixture();
    // compile 合法后手工改写入带 duplicate id 的 manifest（schema-valid）。
    const compile = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(compile.status).toBe(0);
    const manifestPathAbs = path.join(fixture.root, fixture.manifestPath);
    const manifestRaw = JSON.parse(fs.readFileSync(manifestPathAbs, 'utf8')) as Record<string, any>;
    manifestRaw.e2e_steps = [
      { id: 'dup-1', executable: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'dup-1', executable: 'node', args: ['-e', 'process.exit(0)'] },
    ];
    fs.writeFileSync(manifestPathAbs, JSON.stringify(manifestRaw, null, 2), 'utf-8');
    const receiptDir = path.join(fixture.root, '.proofloop', 'receipts', 'project');
    const { status, envelope } = runPublicCli(
      ['project', 'run-e2e', '--json', projectRequest({ operation: 'run-e2e', manifest_path: fixture.manifestPath })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(receiptDir)).toBe(false);
  });

  it('compile-acceptance with duplicate e2e step topology does not create the manifest output directory', () => {
    const fixture = prepareFixture();
    const inputPathAbs = path.join(fixture.root, fixture.compileInputPath);
    const inputRaw = JSON.parse(fs.readFileSync(inputPathAbs, 'utf8')) as Record<string, any>;
    inputRaw.e2e_steps = [
      { id: 'dup-1', executable: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'dup-1', executable: 'node', args: ['-e', 'process.exit(0)'] },
    ];
    fs.writeFileSync(inputPathAbs, JSON.stringify(inputRaw, null, 2), 'utf-8');
    const outDir = path.join(fixture.root, '.proofloop', 'manifests');
    const { status, envelope } = runPublicCli(
      [
        'project',
        'compile-acceptance',
        '--json',
        projectRequest({ operation: 'compile-acceptance', input_path: fixture.compileInputPath, output_path: fixture.manifestPath }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('finalize-review with a missing stage receipt does not create the output directory', () => {
    const fixture = prepareFixture();
    // 改写 compile input：stage_receipts 指向不存在的文件（compile 只做 schema
    // 校验会成功，finalize 的 stage triple-binding 前置必须拒绝）。
    const inputPathAbs = path.join(fixture.root, fixture.compileInputPath);
    const inputRaw = JSON.parse(fs.readFileSync(inputPathAbs, 'utf8')) as Record<string, any>;
    inputRaw.stage_receipts = [
      {
        stage_id: 'S01',
        stage_manifest: { path: 'artifacts/missing-stage-manifest.json', digest: 'a'.repeat(64) },
        review_receipt: { path: 'artifacts/missing-stage-review.json', digest: 'b'.repeat(64) },
        gate_receipt: { path: 'artifacts/missing-stage-gate.json', digest: 'c'.repeat(64) },
      },
    ];
    fs.writeFileSync(inputPathAbs, JSON.stringify(inputRaw, null, 2), 'utf-8');
    const { reviewerPath, e2eRef } = writeReviewerResult(fixture);
    const outDir = 'artifacts/review-out-missing-stage';
    const { status, envelope } = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'finalize',
          output_dir: outDir,
        }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, outDir))).toBe(false);
  });

  it('finalize-review with empty criteria_results does not create the output directory', () => {
    const fixture = prepareFixture();
    const { reviewerPath, e2eRef } = writeReviewerResult(fixture, { criteria_results: [] });
    const outDir = 'artifacts/review-out-empty-criteria';
    const { status, envelope } = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'finalize',
          output_dir: outDir,
        }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, outDir))).toBe(false);
  });
});

// ============================================================
// S10-D CV repair Round 4 — criteria 集合级完全一致 + reviewer manifest
// path 文件 digest 绑定前置（no-write 最后缺口）
// ============================================================

describe('project criteria-set-and-manifest-path-before-mkdir（S10-D CV repair Round 4）', () => {
  function finalizeWithReviewer(fixture: any, overrides: Record<string, unknown>, outDir: string): { status: number; envelope: any } {
    const { reviewerPath, e2eRef } = writeReviewerResult(fixture, overrides);
    return runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'finalize',
          output_dir: outDir,
        }),
      ],
      fixture.root,
    );
  }

  it('finalize-review with same-length but duplicated criteria results（missing a criterion）does not create the output directory', () => {
    const fixture = prepareFixture();
    const outDir = 'artifacts/review-out-dup-criteria';
    const { status, envelope } = finalizeWithReviewer(
      fixture,
      { criteria_results: [
        { criteria: 'AC-01', passed: true, notes: 'ok' },
        { criteria: 'AC-01', passed: true, notes: 'ok' },
      ] },
      outDir,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, outDir))).toBe(false);
  });

  it('finalize-review with same-length but an extra criterion not in the manifest does not create the output directory', () => {
    const fixture = prepareFixture();
    const outDir = 'artifacts/review-out-extra-criteria';
    const { status, envelope } = finalizeWithReviewer(
      fixture,
      { criteria_results: [
        { criteria: 'AC-01', passed: true, notes: 'ok' },
        { criteria: 'AC-03', passed: true, notes: 'ok' },
      ] },
      outDir,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, outDir))).toBe(false);
  });

  it('finalize-review with a non-passed criteria result does not create the output directory', () => {
    const fixture = prepareFixture();
    const outDir = 'artifacts/review-out-not-passed';
    const { status, envelope } = finalizeWithReviewer(
      fixture,
      { criteria_results: [
        { criteria: 'AC-01', passed: true, notes: 'ok' },
        { criteria: 'AC-02', passed: false, notes: 'not ok' },
      ] },
      outDir,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, outDir))).toBe(false);
  });

  it('finalize-review with a reviewer manifest path whose file digest mismatches does not create the output directory', () => {
    const fixture = prepareFixture();
    const { run } = compileAndRun(fixture);
    const manifestRaw = JSON.parse(
      fs.readFileSync(path.join(fixture.root, fixture.manifestPath), 'utf8'),
    ) as Record<string, any>;
    const manifestDigest = computeCanonicalJsonDigest(manifestRaw);
    const e2eRef = run.envelope.result.receipt_ref.ref as string;
    const e2ePath = path.join(fixture.root, e2eRef);
    // 声明的 manifest path 指向另一个文件（stage manifest），digest 值保持
    // canonical 一致以通过值级检查——文件级 digest 绑定必须拒绝。
    const reviewer = {
      verdict: 'PROJECT_ACCEPTED',
      reviewer: 'cli-project-reviewer',
      reviewed_snapshot: manifestRaw.expected_snapshot,
      project_manifest: { path: fixture.stage.stageManifestPath, digest: manifestDigest },
      project_e2e_receipt: { path: e2ePath, digest: fileDigest16(e2ePath) },
      criteria_results: [
        { criteria: 'AC-01', passed: true, notes: 'ok' },
        { criteria: 'AC-02', passed: true, notes: 'ok' },
      ],
      findings: [],
      accepted_deviations: [],
      reviewed_at: '2025-01-01T01:00:00.000Z',
    };
    const reviewerPath = 'artifacts/reviewer-result-r4.json';
    fs.writeFileSync(path.join(fixture.root, reviewerPath), JSON.stringify(reviewer, null, 2), 'utf-8');
    const outDir = 'artifacts/review-out-bad-manifest-path';
    const { status, envelope } = runPublicCli(
      [
        'project',
        'finalize-review',
        '--json',
        projectRequest({
          operation: 'finalize-review',
          manifest_path: fixture.manifestPath,
          e2e_receipt_path: e2eRef,
          reviewer_result_path: reviewerPath,
          verdict: 'PROJECT_ACCEPTED',
          summary: 'finalize',
          output_dir: outDir,
        }),
      ],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, outDir))).toBe(false);
  });
});

// 探针卫生：proofloop.ts / proofloop-common.ts 不允许残留本任务探针修改。
describe('probe hygiene（S10-D-T02）', () => {
  it('proofloop.ts and proofloop-common.ts carry no PROBE-S10D residue', async () => {
    for (const relative of ['packages/runtime/src/cli/proofloop.ts', 'packages/runtime/src/cli/proofloop-common.ts']) {
      const content = fs.readFileSync(path.join(repo, relative), 'utf8');
      expect(content).not.toContain('PROBE-S10D');
    }
  });
});
