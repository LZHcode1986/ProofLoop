/**
 * proofloop-stage.spec.ts — S10-C-T01: stage 域 CLI handler tests.
 *
 * PO binding（REF-S10-C-T01 / REF-CLI-ACCEPTANCE Acceptance A+C / REF-CLI-SEAM
 * §Preflight/Persistence/Failure）：
 *  - `stage status` / `stage next` 是 read-only 投影（unified request
 *    contract + canonical envelope；零写入；复用 Runtime reconcileStage /
 *    VNextNextActionService seam）；
 *  - `stage admit-worker|admit-cv|admit-slice-commit|admit-integration` 是
 *    structured result 的 CLI→Runtime vNext admission consumer：每次重验
 *    Context/scope/snapshot/changed files/前序 Receipt（由 vnext admission
 *    函数内部完成），成功返回 Receipt ref+digest；
 *  - 非法/stale/cross-version/root escape/duplicate/broken chain 均 canonical
 *    Finding + no-write（exit 2）；
 *  - built dist 进程 smoke：`stage status --json --stage S10` exit 0；未知
 *    stage 操作 exit 2 零写入。
 *
 * 真实仓库只用于只读断言与失败路径（零写入验证）；admit 成功路径全部在
 * mkdtemp fixture git 仓库中完成，绝不污染真实 .proofloop。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { runStageFromArgv } from './proofloop-stage';
import {
  admitVNextStagePlan,
  computeVNextSpvPassReceiptDigest,
  resolveVNextReference,
  VNextNextActionService,
} from '../vnext';
import type { VNextSpvPassReceipt } from '../vnext';
import { computeDigest, computeReceiptDigest } from '@proofloop/kernel';

const REPO = path.resolve(__dirname, '../../../..');
const cleanups: string[] = [];

afterEach(() => {
  for (const root of cleanups.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// CLI runner（source seam：handler 直通入口 runStageFromArgv ——
// S10-B 先例：public dispatcher wiring 由 Runtime direct-fix 提交）
// ============================================================

interface CliRun {
  readonly code: number;
  readonly envelope: Record<string, any>;
  readonly stdout: string;
}

function runCli(
  argv: readonly string[],
  opts: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): CliRun {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
    logs.push(String(message));
  });
  let envelope: ReturnType<typeof runStageFromArgv>;
  try {
    envelope = runStageFromArgv(argv, opts);
  } finally {
    spy.mockRestore();
  }
  const code = envelope.ok ? 0 : 2;
  return { code, envelope: envelope as unknown as Record<string, any>, stdout: logs.join('\n') };
}

/** built public `node dist/cli/proofloop.js` 进程级 runner（成功路径唯一 seam）。 */
function runPublicCli(args: readonly string[], cwd: string): { status: number | null; envelope: Record<string, any> } {
  const DIST_PROOFLOOP = path.join(REPO, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');
  expect(fs.existsSync(DIST_PROOFLOOP)).toBe(true);
  const res = spawnSync(process.execPath, [DIST_PROOFLOOP, ...args], {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env },
    timeout: 60000,
  });
  const lines = (res.stdout ?? '').split('\n').filter((line) => line.length > 0);
  expect(lines.length).toBe(1);
  return { status: res.status, envelope: JSON.parse(lines[0]) as Record<string, any> };
}

/** Recursive sorted listing under a root-relative directory（零写入快照）。 */
function listing(root: string, relative: string): string[] {
  const base = path.join(root, relative);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const entry = path.join(dir, name);
      const stat = fs.statSync(entry);
      const relativeEntry = path.relative(base, entry).split(path.sep).join('/');
      if (stat.isDirectory()) {
        out.push(`${relativeEntry}/`);
        walk(entry);
      } else {
        out.push(relativeEntry);
      }
    }
  };
  walk(base);
  return out;
}

function receiptsListing(root: string): string[] {
  return listing(root, '.proofloop/receipts');
}

function contextListing(root: string): string[] {
  return listing(root, '.proofloop/context');
}

/** 只检查 .proofloop 范围的 Git 状态（测试自身文件是未跟踪的，不属于零写入断言）。 */
function gitStatus(root: string): string {
  return execFileSync('git', ['-C', root, 'status', '--porcelain', '--', '.proofloop'], { encoding: 'utf8' }).trim();
}

// ============================================================
// Fixture helpers（S04 vNext fixture —— 参考 commit-admission.spec.ts）
// ============================================================

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function copyFixture(root: string, relative: string): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(REPO, relative), destination);
}

/** 构造 admitted S04 fixture（manifest + SPV/StagePlan authority + worker
 *  dispatch context 已持久化，worktree clean）。 */
function prepareAdmittedFixture(): {
  readonly root: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly snapshotDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-stage-cli-')));
  cleanups.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'stage-cli@test.local']);
  git(root, ['config', 'user.name', 'Stage Cli Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');

  copyFixture(root, 'delivery/stages/S04/tasks.md');
  copyFixture(root, '.proofloop/manifests/S04.json');
  copyFixture(root, 'delivery/stages/S04/evidence/S04-A.md');
  copyFixture(root, 'delivery/stages/S0-A/tasks.md');

  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  fs.writeFileSync(
    tasksPath,
    fs
      .readFileSync(tasksPath, 'utf8')
      .replace('- Worker Status: `NOT_STARTED`', '- Worker Status: `planned`'),
    'utf8',
  );

  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  manifest.task_scopes = {
    'S04-A-T01': {
      task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['delivery/stages/S04/tasks.md'],
        test_paths: ['packages/worker-test.ts'],
        forbidden_paths: ['.proofloop/receipts'],
      },
    },
  };
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/worker-test.ts'), 'export const fixture = true;\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'candidate boundary']);

  const snapshotDigest = git(root, ['rev-parse', 'HEAD']);
  const manifestDigest = computeDigest(manifest);
  const planDigest = manifest.plan.plan_digest as string;
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: 'S04',
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
  };
  const spv: VNextSpvPassReceipt = { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) };
  const admitted = admitVNextStagePlan({
    version: 2 as const,
    schema_version: 2 as const,
    type: 'STAGE_PLAN_ADMISSION' as const,
    project_root: root,
    manifest_path: '.proofloop/manifests/S04.json',
    stage_id: 'S04',
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
    spv,
  });
  if (!admitted.accepted) throw new Error(`fixture admission failed: ${JSON.stringify(admitted)}`);

  const next = new VNextNextActionService().nextAction({
    projectRoot: root,
    stageId: 'S04',
    snapshotDigest,
    persistContext: true,
  });
  if (next.action !== 'DISPATCH_WORKER') {
    throw new Error(`fixture dispatch failed: action=${String(next.action)} detail=${next.action_detail}`);
  }
  const context = JSON.parse(
    fs.readFileSync(path.join(root, next.context_ref as string), 'utf8'),
  ) as { context_digest: string };

  // Worker 产出预置（SPV/dispatch 之后，保持 worktree dirty 与 declared
  // changed files 精确一致）：Task Evidence subsection（admission 前置）+
  // checkbox 投影 + changed file。
  const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
  fs.writeFileSync(
    evidencePath,
    fs.readFileSync(evidencePath, 'utf8').replace(
      '## Task Evidence\n\n*Not yet captured.*',
      [
        '## Task Evidence',
        '',
        '### S04-A-T01',
        '',
        '- Task Goal: fixture task',
        '- Relevant PO IDs: PO-FIXTURE',
        '- Source Snapshot: fixture-source',
        '- Current Snapshot: fixture-current',
        '- Changed Files:',
        '  - delivery/stages/S04/evidence/S04-A.md',
        '  - delivery/stages/S04/tasks.md',
        '  - packages/worker-test.ts',
        '- RED Receipt:',
        '  - Test ID: fixture-red',
        '  - Command: fixture-red-command',
        '  - Failure Output: fixture-red-output',
        '  - Expected Failure: fixture-red-expected',
        '  - Snapshot: fixture-red-snapshot',
        '- GREEN Receipt:',
        '  - Test ID: fixture-green',
        '  - Command: fixture-green-command',
        '  - Pass Output: fixture-green-output',
        '  - Snapshot: fixture-green-snapshot',
        '- Status: COMPLETE',
      ].join('\n'),
    ),
    'utf8',
  );
  const projectionTasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  fs.writeFileSync(
    projectionTasksPath,
    fs
      .readFileSync(projectionTasksPath, 'utf8')
      .replace('- [ ] S04-A-T01', '- [x] S04-A-T01')
      .replace('- Worker Status: `planned`', '- Worker Status: `executing`'),
    'utf8',
  );
  fs.appendFileSync(path.join(root, 'packages/worker-test.ts'), 'export const workerChanged = true;\n');

  return {
    root,
    manifestDigest,
    planDigest,
    proofIndexDigest: next.proof_index_digest as string,
    snapshotDigest,
    contextRef: next.context_ref as string,
    contextDigest: context.context_digest,
  };
}

function workerEnvelopeInput(
  fixture: ReturnType<typeof prepareAdmittedFixture>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    actionToken: 'stage-cli-worker-1',
    stageId: 'S04',
    sliceId: 'S04-A',
    taskId: 'S04-A-T01',
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: 'delivery/stages/S04/evidence/S04-A.md',
    changedFiles: [
      'delivery/stages/S04/evidence/S04-A.md',
      'delivery/stages/S04/tasks.md',
      'packages/worker-test.ts',
    ],
    verificationRuns: [],
    summary: 'worker completed the admitted task via CLI',
    manifestDigest: fixture.manifestDigest,
    planDigest: fixture.planDigest,
    proofIndexDigest: fixture.proofIndexDigest,
    snapshotDigest: fixture.snapshotDigest,
    contextRef: fixture.contextRef,
    contextDigest: fixture.contextDigest,
    ...overrides,
  };
}

/** 准备 worker + CV + slice-commit + integration 全链（CLI 作为唯一入口）。 */
function prepareFullChainViaCli(): {
  readonly root: string;
  readonly workerDigest: string;
  readonly cvDigest: string;
  readonly commitSha: string;
} {
  const fixture = prepareAdmittedFixture();
  const root = fixture.root;

  // Worker（经 public CLI）
  const worker = runPublicCli(
    ['stage', 'admit-worker', '--json', JSON.stringify({ stage: 'S04', slice: 'S04-A', envelope: workerEnvelopeInput(fixture) })],
    root,
  );
  if (worker.status !== 0 || worker.envelope.ok !== true) {
    throw new Error(`CLI admit-worker failed: ${JSON.stringify(worker)}`);
  }
  const workerDigest = worker.envelope.refs[0].digest as string;
  expect(workerDigest).toMatch(/^[a-f0-9]{64}$/);

  // Worker 工作树投影（checkbox 已在 fixture 预置；此处只保留 changed file）
  fs.appendFileSync(path.join(root, 'packages/worker-test.ts'), 'export const workerChanged = true;\n');

  // CV（经 CLI，vnext CV_RESULT envelope）
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.proofloop/manifests/S04.json'), 'utf8')) as Record<string, any>;
  const slice = (manifest.slices as Array<Record<string, any>>)[0];
  const proofIndex = slice.proof_index as Record<string, any>;
  const cvEnvelope: Record<string, unknown> = {
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: 'S04',
    slice_id: 'S04-A',
    worker_receipt_digest: workerDigest,
    manifest_digest: fixture.manifestDigest,
    plan_digest: fixture.planDigest,
    proof_index_digest: fixture.proofIndexDigest,
    context_ref: fixture.contextRef,
    context_digest: fixture.contextDigest,
    snapshot_digest: fixture.snapshotDigest,
    verification_type: 'initial',
    verdict: 'PASS',
    summary: 'fixture passed via CLI',
    acceptance_refs_checked: [...proofIndex.acceptance_refs],
    seam_refs_checked: [...proofIndex.seam_refs],
    oracle_refs_checked: [...proofIndex.oracle_refs],
    risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'fixture binding',
    })),
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
  };
  const cv = runPublicCli(
    ['stage', 'admit-cv', '--json', JSON.stringify({ stage: 'S04', slice: 'S04-A', envelope: cvEnvelope })],
    root,
  );
  if (cv.status !== 0 || cv.envelope.ok !== true) {
    throw new Error(`CLI admit-cv failed: ${JSON.stringify(cv)}`);
  }
  const cvDigest = cv.envelope.refs[0].digest as string;
  expect(cvDigest).toMatch(/^[a-f0-9]{64}$/);

  // Slice commit（git commit 后经 CLI）
  git(root, ['add', 'delivery/stages/S04/tasks.md', 'delivery/stages/S04/evidence/S04-A.md', 'packages/worker-test.ts']);
  git(root, ['commit', '-q', '-m', 'slice-output: S04-S04-A']);
  const commitSha = git(root, ['rev-parse', 'HEAD']);

  const commit = runPublicCli(
    [
      'stage', 'admit-slice-commit', '--json',
      JSON.stringify({ stage: 'S04', slice: 'S04-A', commit_sha: commitSha, cv_receipt_digest: cvDigest }),
    ],
    root,
  );
  if (commit.status !== 0 || commit.envelope.ok !== true) {
    throw new Error(`CLI admit-slice-commit failed: ${JSON.stringify(commit)}`);
  }

  const integration = runPublicCli(
    ['stage', 'admit-integration', '--json', JSON.stringify({ stage: 'S04', slice: 'S04-A', commit_sha: commitSha })],
    root,
  );
  if (integration.status !== 0 || integration.envelope.ok !== true) {
    throw new Error(`CLI admit-integration failed: ${JSON.stringify(integration)}`);
  }

  return { root, workerDigest, cvDigest, commitSha };
}

/**
 * P-11 task B fixture seam：手工写入合法 v2 STAGE_CLOSE_RESULT envelope
 * （任务 A 的 admit seam 未就绪前，测试直接构造自 digest 一致的 envelope
 * 文件到 stage-close 目录）。
 */
function writeStageCloseReceipt(root: string, stageId: string, closeType = 'COMPLETED'): string {
  const content = {
    version: 1,
    type: 'STAGE_CLOSE_PASS',
    stage_id: stageId,
    timestamp: '2026-08-20T10:00:00.000Z',
    payload: {
      schema_version: 2,
      type: 'STAGE_CLOSE_RESULT',
      action: 'STAGE_CLOSE',
      stage_id: stageId,
      close_type: closeType,
      reason: 'stage closed (fixture)',
      manifest_digest: 'a'.repeat(64),
    },
  };
  const digest = computeReceiptDigest(content);
  const directory = path.join(root, '.proofloop', 'receipts', 'stage-close', stageId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${digest}.json`), JSON.stringify({ ...content, digest }, null, 2), 'utf8');
  return digest;
}

// ============================================================
// stage status（只读投影）
// ============================================================

describe('stage status（S10-C-T01 read-only projection）', () => {
  it('projects status for the admitted fixture stage（built public CLI, exit 0, zero write）', () => {
    const fixture = prepareAdmittedFixture();
    const before = receiptsListing(fixture.root);
    const { status, envelope } = runPublicCli(['stage', 'status', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(0);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'stage', operation: 'status' });
    expect(envelope.result.stage_id).toBe('S04');
    expect(envelope.findings).toEqual([]);
    // 零写入：receipts 目录字节级不变
    expect(receiptsListing(fixture.root)).toEqual(before);
  });

  it('refuses status without a stage（canonical finding, no write）', () => {
    const before = receiptsListing(REPO);
    const run = runCli(['stage', 'status', '--json'], { cwd: REPO });
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(run.envelope.findings.length).toBeGreaterThan(0);
    expect(run.envelope.result).toBeNull();
    expect(receiptsListing(REPO)).toEqual(before);
  });

  it('refuses a non-canonical stage id（fail closed pre-read）', () => {
    const run = runCli(['stage', 'status', '--json', '--stage', '../../S10'], { cwd: REPO });
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(String(run.envelope.findings[0].code)).toMatch(/^RUNTIME\./);
  });

  it('refuses an unknown stage with a structured finding（exit 2）', () => {
    const run = runCli(['stage', 'status', '--json', '--stage', 'S99'], { cwd: REPO });
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(run.envelope.findings.length).toBeGreaterThan(0);
  });

  it('fails closed in a bare fixture root without any Manifest（no crash）', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-status-empty-')));
    cleanups.push(root);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'stage@test.local']);
    git(root, ['config', 'user.name', 'Stage Test']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(root, 'README.md'), 'empty\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'empty']);
    const run = runCli(['stage', 'status', '--json', '--stage', 'S10'], { cwd: root });
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
  });
});

// ============================================================
// stage next（只读投影）
// ============================================================

describe('stage next（S10-C-T01 read-only projection）', () => {
  it('projects the next action for the admitted fixture stage（built public CLI, exit 0, zero write）', () => {
    const fixture = prepareAdmittedFixture();
    const beforeContext = contextListing(fixture.root);
    const beforeReceipts = receiptsListing(fixture.root);
    const { status, envelope } = runPublicCli(['stage', 'next', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'stage', operation: 'next' });
    expect(typeof envelope.result.action).toBe('string');
    expect(typeof envelope.result.action_detail).toBe('string');
    expect(typeof envelope.result.receipt_chain_valid).toBe('boolean');
    expect(envelope.result.stage_id).toBe('S04');
    // 零写入：context / receipts 均不变
    expect(contextListing(fixture.root)).toEqual(beforeContext);
    expect(receiptsListing(fixture.root)).toEqual(beforeReceipts);
  });

  it('refuses next without a stage', () => {
    const run = runCli(['stage', 'next', '--json'], { cwd: REPO });
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
  });

  it('refuses next for an archived stage（STAGE_CLOSE → VALIDATE/STAGE.VALIDATE_REQUIRED with an archived finding, zero write）', () => {
    const fixture = prepareAdmittedFixture();
    writeStageCloseReceipt(fixture.root, 'S04');
    const beforeContext = contextListing(fixture.root);
    const beforeReceipts = receiptsListing(fixture.root);
    const { status, envelope } = runPublicCli(['stage', 'next', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('STAGE.VALIDATE_REQUIRED');
    expect(String(envelope.findings[0].message)).toMatch(/archived/i);
    // 零写入：context / receipts 均不变。
    expect(contextListing(fixture.root)).toEqual(beforeContext);
    expect(receiptsListing(fixture.root)).toEqual(beforeReceipts);
  });
});

// ============================================================
// stage admit —— 参数合同与失败路径（canonical Finding + no-write）
// ============================================================

describe('stage admit-worker（S10-C-T01 CLI→Runtime admission）', () => {
  it('refuses admit-worker without an envelope（exit 2, no write）', () => {
    const before = receiptsListing(REPO);
    const run = runCli(['stage', 'admit-worker', '--json', JSON.stringify({ stage: 'S10', slice: 'S10-C' })], { cwd: REPO });
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(run.envelope.findings.length).toBeGreaterThan(0);
    expect(receiptsListing(REPO)).toEqual(before);
  });

  it('refuses a legacy v1 worker envelope（cross-version fail closed）', () => {
    const run = runCli(
      ['stage', 'admit-worker', '--json', JSON.stringify({
        stage: 'S10',
        slice: 'S10-C',
        envelope: { schemaVersion: 1, stageId: 'S10', sliceId: 'S10-C' },
      })],
      { cwd: REPO },
    );
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(run.envelope.findings[0].code).toMatch(/RUNTIME\./);
  });

  it('refuses outer/inner stage binding mismatch before admission', () => {
    const run = runCli(
      ['stage', 'admit-worker', '--json', JSON.stringify({
        stage: 'S10',
        slice: 'S10-C',
        envelope: { schemaVersion: 2, stageId: 'S09', sliceId: 'S10-C' },
      })],
      { cwd: REPO },
    );
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(run.envelope.findings[0].code).toMatch(/RUNTIME\./);
  });

  it('refuses unknown request fields（closed schema）', () => {
    const run = runCli(
      ['stage', 'admit-worker', '--json', JSON.stringify({ stage: 'S10', slice: 'S10-C', envelope: {}, bogus: 1 })],
      { cwd: REPO },
    );
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(run.envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
  });
});

describe('stage admit-cv（S10-C-T01）', () => {
  it('refuses legacy scalar CV input（cross-version/legacy fail closed）', () => {
    const before = receiptsListing(REPO);
    const run = runCli(
      ['stage', 'admit-cv', '--json', JSON.stringify({
        stage: 'S10', slice: 'S10-C', verdict: 'PASS', snapshot_digest: 'x'.repeat(40), summary: 's',
      })],
      { cwd: REPO },
    );
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(receiptsListing(REPO)).toEqual(before);
  });

  it('rejects a malformed vNext CV_RESULT envelope（schema finding, no write）', () => {
    const before = receiptsListing(REPO);
    const run = runCli(
      ['stage', 'admit-cv', '--json', JSON.stringify({
        stage: 'S10',
        slice: 'S10-C',
        envelope: { schema_version: 2, type: 'CV_RESULT', stage_id: 'S10', slice_id: 'S10-C' },
      })],
      { cwd: REPO },
    );
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(run.envelope.findings.length).toBeGreaterThan(0);
    expect(receiptsListing(REPO)).toEqual(before);
  });
});

describe('stage admit-slice-commit / admit-integration（S10-C-T01）', () => {
  it('refuses admit-slice-commit without commit_sha', () => {
    const before = receiptsListing(REPO);
    const run = runCli(
      ['stage', 'admit-slice-commit', '--json', JSON.stringify({ stage: 'S10', slice: 'S10-C' })],
      { cwd: REPO },
    );
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(receiptsListing(REPO)).toEqual(before);
  });

  it('refuses admit-slice-commit on a broken chain（no cv receipt → blocked, no write）', () => {
    const before = receiptsListing(REPO);
    const run = runCli(
      ['stage', 'admit-slice-commit', '--json', JSON.stringify({
        stage: 'S10', slice: 'S10-C', commit_sha: 'a'.repeat(40), cv_receipt_digest: 'b'.repeat(64),
      })],
      { cwd: REPO },
    );
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(run.envelope.findings.length).toBeGreaterThan(0);
    expect(receiptsListing(REPO)).toEqual(before);
  });

  it('refuses admit-integration without commit_sha', () => {
    const before = receiptsListing(REPO);
    const run = runCli(
      ['stage', 'admit-integration', '--json', JSON.stringify({ stage: 'S10', slice: 'S10-C' })],
      { cwd: REPO },
    );
    expect(run.code).toBe(2);
    expect(run.envelope.ok).toBe(false);
    expect(receiptsListing(REPO)).toEqual(before);
  });
});

// ============================================================
// stage admit —— 成功路径（fixture repo，CLI 是唯一入口）
// ============================================================

describe('stage admit success chain（S10-C-T01 fixture）', () => {
  it('admits worker → cv → slice-commit → integration through the CLI with ref+digest', () => {
    const { root, workerDigest, cvDigest, commitSha } = prepareFullChainViaCli();

    // Receipt 文件真实落盘（digest-addressed，root-relative ref 一致）
    expect(fs.existsSync(path.join(root, '.proofloop/receipts/tasks/S04/S04-A', `${workerDigest}.json`))).toBe(true);
    expect(fs.existsSync(path.join(root, '.proofloop/receipts/cv/S04/S04-A', `${cvDigest}.json`))).toBe(true);
    expect(fs.existsSync(path.join(root, '.proofloop/receipts/committer/S04/S04-A', `${commitSha}.json`))).toBe(false);
    // SLICE_COMMIT receipt 是 digest-addressed（digest ≠ commitSha）
    const committerDir = path.join(root, '.proofloop/receipts/committer/S04/S04-A');
    const commitReceipts = fs.readdirSync(committerDir).filter((name) => name.endsWith('.json'));
    expect(commitReceipts.length).toBe(1);
    expect(commitReceipts[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    const integrationDir = path.join(root, '.proofloop/receipts/integration/S04/S04-A');
    const integrationReceipts = fs.readdirSync(integrationDir).filter((name) => name.endsWith('.json'));
    expect(integrationReceipts.length).toBe(1);
    expect(integrationReceipts[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });

  it('refuses a duplicate worker admit（same actionToken → no second receipt）', () => {
    const fixture = prepareAdmittedFixture();
    const requestJson = JSON.stringify({ stage: 'S04', slice: 'S04-A', envelope: workerEnvelopeInput(fixture) });
    const first = runPublicCli(['stage', 'admit-worker', '--json', requestJson], fixture.root);
    if (first.status !== 0 || first.envelope.ok !== true) {
      throw new Error(`CLI admit-worker unexpected failure: ${JSON.stringify(first.envelope)}`);
    }
    expect(first.status).toBe(0);
    expect(first.envelope.ok).toBe(true);
    const tasksDir = path.join(fixture.root, '.proofloop/receipts/tasks/S04/S04-A');
    const afterFirst = fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json')).length;

    const second = runPublicCli(['stage', 'admit-worker', '--json', requestJson], fixture.root);
    expect(second.status).toBe(2);
    expect(second.envelope.ok).toBe(false);
    expect(second.envelope.findings.length).toBeGreaterThan(0);
    expect(fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json')).length).toBe(afterFirst);
  });
});

// ============================================================
// built dist process smoke（S10-C-T01 / REF-S10-C-T01 运行证明第 5 步）
// ============================================================

describe('built public proofloop.js smoke（S10-C repair：public CLI 成功路径）', () => {
  // public dispatcher（dist/cli/proofloop.js）进程级：成功路径全部在临时
  // fixture 上（真实仓库只保留失败路径与零写入断言）。

  it('`stage status --json --stage S04` exits 0 on the admitted fixture（public built process）', () => {
    const fixture = prepareAdmittedFixture();
    const { status, envelope } = runPublicCli(['stage', 'status', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(0);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'stage', operation: 'status' });
    expect(envelope.result.stage_id).toBe('S04');
  });

  it('`stage next --json --stage S04` exits 0 on the admitted fixture（public built process, zero write）', () => {
    const fixture = prepareAdmittedFixture();
    const beforeContext = contextListing(fixture.root);
    const beforeReceipts = receiptsListing(fixture.root);
    const { status, envelope } = runPublicCli(['stage', 'next', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'stage', operation: 'next' });
    expect(typeof (envelope.result as Record<string, any>).action).toBe('string');
    expect(contextListing(fixture.root)).toEqual(beforeContext);
    expect(receiptsListing(fixture.root)).toEqual(beforeReceipts);
  });

  it('unknown stage operation fails closed with a single envelope and no write（real repo）', () => {
    const before = receiptsListing(REPO);
    const { status, envelope } = runPublicCli(['stage', 'bogus-op', '--json', '--stage', 'S10'], path.join(REPO, 'packages', 'runtime'));
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.SCHEMA_MISMATCH', 'RUNTIME.NOT_IMPLEMENTED']).toContain(envelope.findings[0].code);
    expect(receiptsListing(REPO)).toEqual(before);
    expect(gitStatus(REPO)).toBe('');
  });

  it('`stage run-gate` stays a closed command without a handler (S10-C-T02 boundary)', () => {
    const { status, envelope } = runPublicCli(['stage', 'run-gate', '--json', '--stage', 'S10'], path.join(REPO, 'packages', 'runtime'));
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.NOT_IMPLEMENTED']).toContain(envelope.findings[0].code);
  });
});
