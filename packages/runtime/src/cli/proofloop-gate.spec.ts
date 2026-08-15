/**
 * proofloop-gate.spec.ts — S10-C-T02 gate 域 CLI handler（dual-path SG）。
 *
 * 覆盖的 public seam（Acceptance A/C/E + CLI-ORACLE）：
 *   - `gate run --stage <S>`：SG 不再执行 Manifest runtime_proof 命令；经
 *     CLI→Runtime gate admission 验证各 Slice 集成证明齐全（receipts 正常
 *     路径或显式 git_facts 兜底），通过后写 GATE_PASS Receipt（Runtime
 *     seam），envelope 返回 ok/gate/steps/errors/refs（Receipt ref+digest），
 *     并持久化结果到 `.proofloop/runtime/<stage>/gate-result.json`；
 *   - 失败（admission 拒绝 / canonical 拒绝）：canonical envelope +
 *     exit 2 零写入（不写 GATE_FAIL Receipt、不写 gate-result.json）；
 *   - `gate status --stage <S>`：只读 Gate 状态/Receipt 报告（manifest 绑定 +
 *     stage-gate chain tip），零写入；
 *   - 未知操作 fail closed exit 2。
 *
 * Fixture：真实 vNext S04 planning boundary + 完整 Worker→CV→Slice Commit→
 * Integration 前缀（gate-admission.spec 同构）；resolved_steps 使用小
 * command steps（只做 canonical 校验，不再真实 spawn 执行）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  admitVNextCVResult,
  admitVNextIntegration,
  admitVNextStagePlan,
  admitVNextWorkerResult,
  computeVNextSpvPassReceiptDigest,
  defaultReceiptWriter,
  resolveVNextReference,
  VNextNextActionService,
} from '@proofloop/runtime';
import type { VNextSpvPassReceipt } from '@proofloop/runtime';
import { computeDigest, computeReceiptDigest } from '@proofloop/kernel';
import { admitVNextSliceCommit } from '../vnext/commit-admission';
import { admitVNextStageReview } from '../vnext/review-admission';
import { runGateDomain, runGateFromArgv } from './proofloop-gate';

const REPO = path.resolve(__dirname, '../../../..');
const STAGE = 'S04';
const SLICE = 'S04-A';
const TASK = 'S04-A-T01';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function copyFixture(root: string, relative: string): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(REPO, relative), destination);
}

/** built public `node dist/cli/proofloop.js` 进程级 runner（成功路径唯一 seam）。 */
function runPublicCli(args: readonly string[], cwd: string): { status: number | null; envelope: Record<string, any> } {
  const DIST_PROOFLOOP = path.join(REPO, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');
  expect(fs.existsSync(DIST_PROOFLOOP)).toBe(true);
  const res = spawnSync(process.execPath, [DIST_PROOFLOOP, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60000,
  });
  const lines = (res.stdout ?? '').split('\n').filter((line) => line.length > 0);
  expect(lines.length).toBe(1);
  return { status: res.status, envelope: JSON.parse(lines[0]) as Record<string, any> };
}

interface GateCliFixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly snapshotDigest: string;
  readonly proofIndexDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly commitSha: string;
}

/**
 * vNext planning boundary fixture：真实 S04 Manifest/Slice 文件 + canonical
 * executable proof steps + reference rebinding + clean commit。
 */
function prepareGateFixture(): GateCliFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-gate-cli-')));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'gate-cli@test.local']);
  git(root, ['config', 'user.name', 'gate CLI test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  for (const relative of [
    `delivery/stages/${STAGE}/tasks.md`,
    `.proofloop/manifests/${STAGE}.json`,
    `delivery/stages/${STAGE}/evidence/${SLICE}.md`,
    'delivery/stages/S0-A/tasks.md',
  ]) {
    copyFixture(root, relative);
  }
  const tasksPath = path.join(root, `delivery/stages/${STAGE}/tasks.md`);
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- Worker Status: `NOT_STARTED`', '- Worker Status: `planned`'),
    'utf8',
  );
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/worker-test.ts'), 'export const fixture = true;\n', 'utf8');

  const manifestPath = path.join(root, `.proofloop/manifests/${STAGE}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  manifest.task_scopes = {
    [TASK]: {
      task_ref: `delivery/stages/${STAGE}/tasks.md#/entities/${TASK}`,
      execution_scope: {
        kind: 'implementation',
        code_paths: [`delivery/stages/${STAGE}/tasks.md`],
        test_paths: ['packages/worker-test.ts'],
        forbidden_paths: ['.proofloop/receipts', '.git'],
      },
    },
  };
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'vNext gate CLI planning boundary']);

  const snapshotDigest = git(root, ['rev-parse', 'HEAD']);
  const manifestDigest = computeDigest(manifest);
  const planDigest = manifest.plan.plan_digest as string;

  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: STAGE,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
  };
  const spv: VNextSpvPassReceipt = { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) };
  const admitted = admitVNextStagePlan({
    version: 2,
    schema_version: 2,
    type: 'STAGE_PLAN_ADMISSION',
    project_root: root,
    manifest_path: `.proofloop/manifests/${STAGE}.json`,
    stage_id: STAGE,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
    spv,
  });
  expect(admitted.accepted).toBe(true);

  const next = new VNextNextActionService().nextAction({
    projectRoot: root,
    stageId: STAGE,
    snapshotDigest,
    persistContext: true,
  });
  // 非 canonical proof steps 的 fixture 会让 nextAction 返回 VALIDATE（无
  // Context）；只有合法 fixture 会真正使用这些绑定（integrateSlice）。
  const contextRef = next.context_ref as string | undefined;
  const contextDigest = contextRef === undefined
    ? ''
    : (JSON.parse(fs.readFileSync(path.join(root, contextRef), 'utf8')) as { context_digest: string }).context_digest;
  return {
    root,
    manifestPath,
    manifestDigest,
    planDigest,
    snapshotDigest,
    proofIndexDigest: (next.proof_index_digest as string | undefined) ?? '',
    contextRef: contextRef ?? '',
    contextDigest,
    commitSha: snapshotDigest,
  };
}

/** 在 planning boundary 上补全 Worker→CV→Slice Commit→Integration 前缀并提交。 */
function integrateSlice(fixture: GateCliFixture): void {
  const root = fixture.root;
  const tasksPath = path.join(root, `delivery/stages/${STAGE}/tasks.md`);
  const evidencePath = path.join(root, `delivery/stages/${STAGE}/evidence/${SLICE}.md`);
  fs.appendFileSync(path.join(root, 'packages/worker-test.ts'), 'export const workerChanged = true;\n');
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8')
      .replace(`- [ ] ${TASK}`, `- [x] ${TASK}`)
      .replace('- Worker Status: `planned`', '- Worker Status: `executing`'),
    'utf8',
  );
  const fixtureTaskEvidence = [
    '## Task Evidence',
    '',
    `### ${TASK}`,
    '',
    '- Task Goal: gate cli fixture',
    '- Relevant PO IDs: PO-FIXTURE',
    '- Source Snapshot: fixture-source',
    '- Current Snapshot: fixture-current',
    '- Changed Files:',
    `  - delivery/stages/${STAGE}/evidence/${SLICE}.md`,
    `  - delivery/stages/${STAGE}/tasks.md`,
    '  - packages/worker-test.ts',
    '- RED Receipt:',
    '  - Test ID: gate-cli-red',
    '  - Command: gate-cli-red-command',
    '  - Failure Output: gate-cli-red-output',
    '  - Expected Failure: gate-cli-red-expected',
    '  - Snapshot: gate-cli-red-snapshot',
    '- GREEN Receipt:',
    '  - Test ID: gate-cli-green',
    '  - Command: gate-cli-green-command',
    '  - Pass Output: gate-cli-green-output',
    '  - Snapshot: gate-cli-green-snapshot',
    '- Status: COMPLETE',
  ].join('\n');
  fs.writeFileSync(
    evidencePath,
    fs.readFileSync(evidencePath, 'utf8').replace('## Task Evidence\n\n*Not yet captured.*', fixtureTaskEvidence),
    'utf8',
  );

  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8')) as Record<string, any>;
  const proofIndex = (manifest.slices as Array<Record<string, any>>)[0].proof_index as Record<string, any>;
  const worker = admitVNextWorkerResult({
    schemaVersion: 2,
    actionToken: 'gate-cli-worker-1',
    stageId: STAGE,
    sliceId: SLICE,
    taskId: TASK,
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE}/evidence/${SLICE}.md`,
    changedFiles: [
      `delivery/stages/${STAGE}/evidence/${SLICE}.md`,
      `delivery/stages/${STAGE}/tasks.md`,
      'packages/worker-test.ts',
    ],
    verificationRuns: [],
    summary: 'gate CLI Worker completed',
    manifestDigest: fixture.manifestDigest,
    planDigest: fixture.planDigest,
    proofIndexDigest: fixture.proofIndexDigest,
    snapshotDigest: fixture.snapshotDigest,
    contextRef: fixture.contextRef,
    contextDigest: fixture.contextDigest,
  }, { projectRoot: root, writer: defaultReceiptWriter });
  expect(worker.accepted).toBe(true);

  const cv = admitVNextCVResult({
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: STAGE,
    slice_id: SLICE,
    worker_receipt_digest: worker.receipt_ref as string,
    manifest_digest: fixture.manifestDigest,
    plan_digest: fixture.planDigest,
    proof_index_digest: fixture.proofIndexDigest,
    context_ref: fixture.contextRef,
    context_digest: fixture.contextDigest,
    snapshot_digest: fixture.snapshotDigest,
    verification_type: 'initial',
    verdict: 'PASS',
    summary: 'gate CLI fixture CV pass',
    acceptance_refs_checked: [...(proofIndex.acceptance_refs as string[])],
    seam_refs_checked: [...(proofIndex.seam_refs as string[])],
    oracle_refs_checked: [...(proofIndex.oracle_refs as string[])],
    risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'gate cli fixture binding',
    })),
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
  }, { projectRoot: root, writer: defaultReceiptWriter });
  expect(cv.accepted).toBe(true);

  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', `slice-output: ${STAGE}-${SLICE}`]);
  const commitSha = git(root, ['rev-parse', 'HEAD']);

  const commit = admitVNextSliceCommit({
    type: 'slice_commit',
    stageId: STAGE,
    sliceId: SLICE,
    commitSha,
    cvReceiptDigest: cv.receipt_ref as string,
  }, { projectRoot: root, writer: defaultReceiptWriter });
  expect(commit.accepted).toBe(true);

  const integration = admitVNextIntegration({
    type: 'integration',
    stageId: STAGE,
    sliceId: SLICE,
    commitSha,
  }, { projectRoot: root, writer: defaultReceiptWriter });
  expect(integration.accepted).toBe(true);
}

function gateDir(root: string): string {
  return path.join(root, '.proofloop/receipts/stage-gate', STAGE);
}

function gateRuntimeResultPath(root: string): string {
  return path.join(root, '.proofloop/runtime', STAGE, 'gate-result.json');
}

/** 递归文件树内容快照（排除 .git；用于 full-tree no-write 断言）。 */
function fullTreeSnapshot(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const full = path.join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, rel);
      } else {
        entries.push(`${rel}:${fs.readFileSync(full, 'utf8')}`);
      }
    }
  };
  walk(root, '');
  return entries.join('\n');
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

describe('gate run — canonical envelope / exit / zero-write contract', () => {
  it('refuses a missing stage parameter (STAGE.STAGE_REQUIRED, no-write)', async () => {
    const fixture = prepareGateFixture();
    const envelope = await runGateFromArgv(['gate', 'run', '--json'], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('STAGE.STAGE_REQUIRED');
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
    expect(fs.existsSync(gateRuntimeResultPath(fixture.root))).toBe(false);
  });

  it('refuses a non-canonical stage id (RUNTIME.INPUT_INVALID, no-write)', async () => {
    const fixture = prepareGateFixture();
    const envelope = await runGateFromArgv(['gate', 'run', '--json', '--stage', 'S08B0'], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.INPUT_INVALID');
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
  });

  it('FAILs without the integrated prefix — canonical envelope, exit 2 semantics, zero writes', async () => {
    const fixture = prepareGateFixture();
    const envelope = await runGateFromArgv(['gate', 'run', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    // admission 拒绝（authority/integration 缺失）→ canonical Finding，no-write
    expect(envelope.findings.length).toBeGreaterThan(0);
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
    expect(fs.existsSync(gateRuntimeResultPath(fixture.root))).toBe(false);
  });

  it('admits GATE_PASS on the integrated prefix without executing runtime_proof commands and returns ref+digest（built public CLI, dual-path SG）', async () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    // SG 不再执行 runtime_proof 命令：fixture 的 command step 会写出的
    // marker 文件必须保持不存在。
    const marker = path.join(fixture.root, '.proofloop', 'gate-executed.txt');
    expect(fs.existsSync(marker)).toBe(false);

    const { status, envelope } = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    const result = envelope.result as Record<string, any>;
    expect(result.gate).toBe('PASS');
    expect(result.stage_id).toBe(STAGE);
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(fs.existsSync(marker)).toBe(false);
    // refs：GATE_PASS receipt ref+digest
    expect(envelope.refs).toHaveLength(1);
    const gateRef = envelope.refs[0];
    expect(gateRef.ref).toBe(`.proofloop/receipts/stage-gate/${STAGE}/${gateRef.digest}.json`);
    expect(gateRef.digest).toMatch(/^[a-f0-9]{64}$/);
    // Receipt 由 Runtime seam 写入（正常路径标记 verification_source: receipts）
    const receipts = fs.readdirSync(gateDir(fixture.root)).filter((name) => name.endsWith('.json'));
    expect(receipts).toEqual([`${gateRef.digest}.json`]);
    const receipt = JSON.parse(fs.readFileSync(path.join(gateDir(fixture.root), receipts[0]), 'utf8')) as Record<string, any>;
    expect(receipt.type).toBe('GATE_PASS');
    expect(receipt.payload).toMatchObject({
      schema_version: 2,
      type: 'GATE_RESULT',
      action: 'GATE',
      stage_id: STAGE,
      manifest_digest: fixture.manifestDigest,
      verdict: 'PASS',
      verification_source: 'receipts',
    });
    // 结果持久化到 .proofloop/runtime/<stage>/gate-result.json（无逐步步骤）
    expect(fs.existsSync(gateRuntimeResultPath(fixture.root))).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(gateRuntimeResultPath(fixture.root), 'utf8')) as Record<string, any>;
    expect(persisted.gate).toBe('PASS');
    expect(persisted.steps).toHaveLength(0);
  });

  it('refuses gate run on an archived stage（STAGE_CLOSE → STAGE.GATE.ARCHIVED, exit 2, full-tree zero writes）', async () => {
    // 完整集成前缀（本来可以 PASS）上写入 STAGE_CLOSE 标记 ⇒ 拒绝执行：
    // 不跑 proof、不写 Receipt、不写 gate-result.json。
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    const closeDigest = writeStageCloseReceipt(fixture.root, STAGE);
    const marker = path.join(fixture.root, '.proofloop', 'gate-executed.txt');
    const treeBefore = fullTreeSnapshot(fixture.root);

    const envelope = await runGateFromArgv(['gate', 'run', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('STAGE.GATE.ARCHIVED');
    expect(String(envelope.findings[0]?.message)).toContain(closeDigest);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
    expect(fs.existsSync(gateRuntimeResultPath(fixture.root))).toBe(false);
    // full-tree 零写入（.git 除外）：拒绝路径不改动任何文件。
    expect(fullTreeSnapshot(fixture.root)).toBe(treeBefore);
  });

  it('ignores failing runtime_proof steps on the integrated prefix (SG no longer executes commands, dual-path SG)', async () => {
    // 旧语义：步骤失败 → GATE FAIL 零写入。新语义：SG 不执行 runtime_proof
    // 命令（构建+测试由 SR 评审承担），步骤内容不参与 Gate 判定 —— 集成
    // 证明齐全即 PASS。runtime_proof 字段已删除，Manifest 不再携带任何步骤。
    const fixture = prepareGateFixture();
    integrateSlice(fixture);

    const envelope = await runGateFromArgv(['gate', 'run', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(true);
    expect((envelope.result as Record<string, any>).gate).toBe('PASS');
    const receipts = fs.existsSync(gateDir(fixture.root)) ? fs.readdirSync(gateDir(fixture.root)) : [];
    expect(receipts).toHaveLength(1);
  });

  // ---- S10-C repair: gate-result 写入先于 admission（失败 no-write 原子性）----

  it('writes zero Receipts when step-result persistence fails (auxiliary write precedes admission)', async () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    // 把 .proofloop/runtime/<stage> 占用为普通文件 → mkdirSync/writeFileSync 失败
    const runtimeDir = path.join(fixture.root, '.proofloop', 'runtime', STAGE);
    fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });
    fs.writeFileSync(runtimeDir, 'occupied', 'utf8');

    const envelope = await runGateFromArgv(['gate', 'run', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    // 零 Receipt：持久化失败不得留下 GATE_PASS Receipt
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
  });

  it('leaves the existing gate-result.json untouched when admission refuses (repeat run no-write)', () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    const first = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(first.status).toBe(0);
    expect(first.envelope.ok).toBe(true);
    const resultPath = gateRuntimeResultPath(fixture.root);
    expect(fs.existsSync(resultPath)).toBe(true);
    const contentAfterFirst = fs.readFileSync(resultPath, 'utf8');

    // 第二次 run：admission 拒绝（GATE_PASS tip 已存在）→ exit 2 但持久状态
    // 零变化：既有 gate-result.json 内容完全一致、Receipt 数不变、无 pending 残留
    const second = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(second.status).toBe(2);
    expect(second.envelope.ok).toBe(false);
    expect(fs.readFileSync(resultPath, 'utf8')).toBe(contentAfterFirst);
    expect(fs.existsSync(`${resultPath}.pending`)).toBe(false);
    const receipts = fs.readdirSync(gateDir(fixture.root)).filter((name) => name.endsWith('.json'));
    expect(receipts).toHaveLength(1);
  });

  // ---- S10-C repair round 6: 只读 duplicate preflight（零副作用）----

  it('refuses a duplicate gate run via read-only preflight without executing any proof step（full-tree no-write）', () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    const first = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(first.status).toBe(0);
    expect(first.envelope.ok).toBe(true);

    const treeBefore = fullTreeSnapshot(fixture.root);
    const second = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(second.status).toBe(2);
    expect(second.envelope.ok).toBe(false);
    expect(second.envelope.findings[0]?.code).toBe('STAGE.GATE.ALREADY_PASSED');
    // 零副作用：完整文件树（含 .proofloop）一致（无执行、无写入）
    expect(fullTreeSnapshot(fixture.root)).toBe(treeBefore);
  });

  it('preserves a pre-existing pending gate-result when a duplicate run is refused（recovery state kept）', () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    const first = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(first.status).toBe(0);
    // 模拟前次 final persistence failure 留下的 pending（恢复状态）
    const pendingPath = `${gateRuntimeResultPath(fixture.root)}.pending`;
    fs.writeFileSync(pendingPath, '{"recovery":"state"}', 'utf8');

    const treeBefore = fullTreeSnapshot(fixture.root);
    const second = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(second.status).toBe(2);
    expect(second.envelope.ok).toBe(false);
    // pending 保留原样（不删不覆盖）+ Receipt 数不变 + 全树一致
    expect(fs.readFileSync(pendingPath, 'utf8')).toBe('{"recovery":"state"}');
    expect(fullTreeSnapshot(fixture.root)).toBe(treeBefore);
    const receipts = fs.readdirSync(gateDir(fixture.root)).filter((name) => name.endsWith('.json'));
    expect(receipts).toHaveLength(1);
  });

  it('preserves an orphan pending gate-result without a final file（interrupted run recovery）', () => {
    const fixture = prepareGateFixture();
    // 前次中断：pending 存在但无最终 gate-result.json（也无 GATE_PASS tip）
    const pendingPath = `${gateRuntimeResultPath(fixture.root)}.pending`;
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, '{"recovery":"interrupted"}', 'utf8');

    const treeBefore = fullTreeSnapshot(fixture.root);
    const run = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(run.status).toBe(2);
    expect(run.envelope.ok).toBe(false);
    // blocked + pending 原样保留（恢复状态不被破坏）
    expect(fs.readFileSync(pendingPath, 'utf8')).toBe('{"recovery":"interrupted"}');
    expect(fullTreeSnapshot(fixture.root)).toBe(treeBefore);
  });
});

describe('dual-path SG — public CLI verification_source seam (S10-SR-001 repair)', () => {
  it('accepts verification_source in the gate closed request schema via the public CLI（S10 字面请求，字段不再 unknown）', async () => {
    const fixture = prepareGateFixture();
    const envelope = await runGateFromArgv(
      ['gate', 'run', '--json', '{"stage":"S10","verification_source":"git_facts"}'],
      { cwd: fixture.root },
    );
    // closed schema 接受字段：不再 RUNTIME.INPUT_INVALID unknown field；继续
    // 走到 preflight（fixture 仓库无 S10 Manifest）→ STAGE.GATE.BLOCKED。
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('STAGE.GATE.BLOCKED');
    expect(envelope.findings[0]?.message).not.toMatch(/unknown field/);
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
  });

  it('passes verification_source: git_facts end-to-end through the public built CLI（Receipt marks git_facts）', () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    // S10-SR-001-GIT-FACTS-FAIL-OPEN-001：git_facts 兜底是 absence-gated ——
    // 仅当全部 Slice 的 INTEGRATION_PASS receipts 缺失时合法。集成提交保留
    // （git 事实齐备），删除执行链 receipts 使兜底路径可达。
    for (const category of ['tasks', 'cv', 'committer', 'integration']) {
      fs.rmSync(path.join(fixture.root, '.proofloop/receipts', category, STAGE, SLICE), {
        recursive: true,
        force: true,
      });
    }
    const { status, envelope } = runPublicCli(
      ['gate', 'run', '--json', `{"stage":"${STAGE}","verification_source":"git_facts"}`],
      fixture.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    const result = envelope.result as Record<string, any>;
    expect(result.gate).toBe('PASS');
    expect(result.verification_source).toBe('git_facts');
    expect(envelope.refs).toHaveLength(1);
    const gateRef = envelope.refs[0];
    const receipt = JSON.parse(fs.readFileSync(path.join(gateDir(fixture.root), `${gateRef.digest}.json`), 'utf8')) as Record<string, any>;
    expect(receipt.type).toBe('GATE_PASS');
    expect((receipt.payload as Record<string, any>).verification_source).toBe('git_facts');
  });

  it('accepts an explicit verification_source: receipts declaration through the public CLI（default path unchanged）', () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    const { status, envelope } = runPublicCli(
      ['gate', 'run', '--json', `{"stage":"${STAGE}","verification_source":"receipts"}`],
      fixture.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect((envelope.result as Record<string, any>).verification_source).toBe('receipts');
  });

  it('fails closed when the gate request verification_source is not receipts | git_facts（RUNTIME.INPUT_INVALID, no-write）', async () => {
    const fixture = prepareGateFixture();
    const envelope = await runGateFromArgv(
      ['gate', 'run', '--json', `{"stage":"${STAGE}","verification_source":"bogus"}`],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0]?.message).toMatch(/verification_source/);
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
    expect(fs.existsSync(gateRuntimeResultPath(fixture.root))).toBe(false);
  });
});

describe('gate status — read-only Gate state / Receipt report', () => {
  it('reports manifest bindings and an empty gate chain before any run（built public CLI, zero writes）', () => {
    const fixture = prepareGateFixture();
    const before = fs.existsSync(gateDir(fixture.root))
      ? fs.readdirSync(gateDir(fixture.root)).sort()
      : [];
    const { status, envelope } = runPublicCli(['gate', 'status', '--json', '--stage', STAGE], fixture.root);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    const result = envelope.result as Record<string, any>;
    expect(result.stage_id).toBe(STAGE);
    expect(result.manifest_digest).toBe(fixture.manifestDigest);
    expect(result.plan_digest).toBe(fixture.planDigest);
    expect(result.gate).toMatchObject({ receipt_count: 0, latest: null });
    const after = fs.existsSync(gateDir(fixture.root))
      ? fs.readdirSync(gateDir(fixture.root)).sort()
      : [];
    expect(after).toEqual(before);
  });

  it('reports the GATE_PASS chain tip after a successful gate run（built public CLI）', () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    const run = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(run.status).toBe(0);
    expect(run.envelope.ok).toBe(true);

    const { status, envelope } = runPublicCli(['gate', 'status', '--json', '--stage', STAGE], fixture.root);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    const result = envelope.result as Record<string, any>;
    expect(result.gate.receipt_count).toBe(1);
    expect(result.gate.latest).toMatchObject({
      receipt_type: 'GATE_PASS',
      verdict: 'PASS',
    });
    expect(result.gate.latest.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.gate.latest.ref).toBe(`.proofloop/receipts/stage-gate/${STAGE}/${result.gate.latest.digest}.json`);
  });

  it('refuses a non-vnext manifest route (RUNTIME.SCHEMA_MISMATCH, zero writes)', async () => {
    const fixture = prepareGateFixture();
    fs.writeFileSync(fixture.manifestPath, JSON.stringify({ version: 1 }), 'utf8');
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });

  // ---- S10-C repair: readGateChain 绑定加固（类型 / stage / payload schema /
  //      Manifest+Proof digest 绑定，错位或伪造 Receipt fail closed）----

  it('fails closed when the stage-gate chain contains a wrong-type Receipt (TASK_COMPLETE misplaced)', async () => {
    const fixture = prepareGateFixture();
    // 错位：把 TASK_COMPLETE Receipt（合法 digest-addressed + self-digest）放入 stage-gate 目录
    const content = {
      version: 1,
      type: 'TASK_COMPLETE',
      stage_id: STAGE,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { schema_version: 2, task_id: TASK, outcome: 'completed' },
    };
    const digest = computeReceiptDigest(content);
    fs.mkdirSync(gateDir(fixture.root), { recursive: true });
    fs.writeFileSync(path.join(gateDir(fixture.root), `${digest}.json`), JSON.stringify({ ...content, digest }, null, 2), 'utf8');

    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when a gate Receipt payload does not carry the GATE_RESULT/GATE discriminator', async () => {
    const fixture = prepareGateFixture();
    const content = {
      version: 1,
      type: 'GATE_PASS',
      stage_id: STAGE,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { verdict: 'PASS' }, // 伪造：无 GATE_RESULT/action GATE discriminator
    };
    const digest = computeReceiptDigest(content);
    fs.mkdirSync(gateDir(fixture.root), { recursive: true });
    fs.writeFileSync(path.join(gateDir(fixture.root), `${digest}.json`), JSON.stringify({ ...content, digest }, null, 2), 'utf8');

    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when the gate Receipt payload does not bind the active Manifest/Proof tuple (stale/forged)', async () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    const run = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(run.status).toBe(0);
    expect(run.envelope.ok).toBe(true);

    // 篡改 Receipt payload 的 manifest_digest（自 digest 重算，文件重命名）——
    // 链拓扑合法但绑定失效，status 必须 fail closed
    const receiptName = fs.readdirSync(gateDir(fixture.root)).find((name) => name.endsWith('.json')) as string;
    const receipt = JSON.parse(fs.readFileSync(path.join(gateDir(fixture.root), receiptName), 'utf8')) as Record<string, any>;
    const tamperedPayload = { ...(receipt.payload as Record<string, unknown>), manifest_digest: 'f'.repeat(64) };
    const tamperedContent: Record<string, unknown> = { ...receipt, payload: tamperedPayload };
    delete tamperedContent.digest;
    const tamperedDigest = computeReceiptDigest(tamperedContent);
    fs.rmSync(path.join(gateDir(fixture.root), receiptName));
    fs.writeFileSync(path.join(gateDir(fixture.root), `${tamperedDigest}.json`), JSON.stringify({ ...tamperedContent, digest: tamperedDigest }, null, 2), 'utf8');

    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when the gate Receipt binds the wrong stage', async () => {
    const fixture = prepareGateFixture();
    const content = {
      version: 1,
      type: 'GATE_PASS',
      stage_id: 'S99', // 错位 stage
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { schema_version: 2, type: 'GATE_RESULT', action: 'GATE', stage_id: 'S99', verdict: 'PASS' },
    };
    const digest = computeReceiptDigest(content);
    fs.mkdirSync(gateDir(fixture.root), { recursive: true });
    fs.writeFileSync(path.join(gateDir(fixture.root), `${digest}.json`), JSON.stringify({ ...content, digest }, null, 2), 'utf8');

    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  // ---- S10-C repair round 2: GATE_RESULT closed-schema 与一致性 ----

  /** 构造一个能通过 digest/self-digest/类型/绑定校验的 GATE_PASS 伪造 Receipt。 */
  function writeGateReceipt(
    fixture: GateCliFixture,
    outerStage: string,
    payload: Record<string, unknown>,
    type = 'GATE_PASS',
  ): void {
    const content = {
      version: 1,
      type,
      stage_id: outerStage,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload,
    };
    const digest = computeReceiptDigest(content);
    fs.mkdirSync(gateDir(fixture.root), { recursive: true });
    fs.writeFileSync(path.join(gateDir(fixture.root), `${digest}.json`), JSON.stringify({ ...content, digest }, null, 2), 'utf8');
  }

  /** 用 fixture 真实绑定构造 closed GATE_RESULT payload（仅目标字段被 overrides 偏离）。 */
  function closedGatePayload(fixture: GateCliFixture, overrides: Record<string, unknown> = {}, stageId = STAGE): Record<string, unknown> {
    // authority digest（Stage Plan / SPV receipt 的真实 digest）
    const planDir = path.join(fixture.root, '.proofloop', 'receipts', 'plan', STAGE);
    const stagePlan = JSON.parse(fs.readFileSync(path.join(planDir, 'vnext-stage-plan.json'), 'utf8')) as { digest: string };
    const spv = JSON.parse(fs.readFileSync(path.join(planDir, 'vnext-spv-pass.json'), 'utf8')) as { digest: string };
    return {
      schema_version: 2,
      type: 'GATE_RESULT',
      action: 'GATE',
      stage_id: stageId,
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      stage_plan_receipt_digest: stagePlan.digest,
      spv_receipt_digest: spv.digest,
      snapshot_digest: fixture.snapshotDigest,
      verdict: 'PASS',
      integrated_slices: [],
      summary: 'forged gate payload',
      receipt_chain_valid: true,
      ...overrides,
    };
  }

  it('fails closed when the GATE_RESULT payload is incomplete (missing required fields)', async () => {
    const fixture = prepareGateFixture();
    // 显式删除字段（不用 undefined 覆盖——undefined key 会使 canonical digest
    // 与落盘 JSON 不一致而触发 self-digest 校验，无法单独验证 closed-schema）
    const incomplete = closedGatePayload(fixture) as Record<string, unknown>;
    delete incomplete.summary;
    delete incomplete.integrated_slices;
    writeGateReceipt(fixture, STAGE, incomplete);
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when the GATE_RESULT payload carries an unknown field (closed schema)', async () => {
    const fixture = prepareGateFixture();
    writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, { bogus_field: 'nope' }));
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when the outer Receipt stage_id does not match the requested stage', async () => {
    const fixture = prepareGateFixture();
    // payload 绑定正确（STAGE），但外层 Receipt.stage_id 错位
    writeGateReceipt(fixture, 'S99', closedGatePayload(fixture));
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when Receipt.type and payload.verdict disagree (GATE_PASS with FAIL)', async () => {
    const fixture = prepareGateFixture();
    writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, { verdict: 'FAIL' }), 'GATE_PASS');
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when receipt_chain_valid is not true in the GATE_RESULT payload', async () => {
    const fixture = prepareGateFixture();
    writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, { receipt_chain_valid: false }));
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  // ---- S10-C repair round 3: integrated_slices / summary 强度对齐
  //      canonical validateVNextGateRecord（非空、closed 三字段、格式、唯一性）----

  function sliceBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      slice_id: 'S04-A',
      commit_sha: 'c'.repeat(40),
      integration_receipt_digest: 'd'.repeat(64),
      ...overrides,
    };
  }

  it('fails closed when integrated_slices is empty（canonical 强度：非空数组）', async () => {
    const fixture = prepareGateFixture();
    writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, { integrated_slices: [] }));
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when summary is empty（canonical 强度：非空字符串）', async () => {
    const fixture = prepareGateFixture();
    writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, { summary: '' }));
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when an integrated_slices binding carries an unknown nested field', async () => {
    const fixture = prepareGateFixture();
    writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, { integrated_slices: [sliceBinding({ bogus: 1 })] }));
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when an integrated_slices binding has a non-40-hex commit_sha', async () => {
    const fixture = prepareGateFixture();
    writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, { integrated_slices: [sliceBinding({ commit_sha: 'short' })] }));
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when an integrated_slices binding has a non-64-hex integration receipt digest', async () => {
    const fixture = prepareGateFixture();
    writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, { integrated_slices: [sliceBinding({ integration_receipt_digest: 'zz' })] }));
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('fails closed when integrated_slices contains a duplicated slice_id（唯一性）', async () => {
    const fixture = prepareGateFixture();
    writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, {
      integrated_slices: [
        sliceBinding({ slice_id: 'S04-A' }),
        sliceBinding({ slice_id: 'S04-A', commit_sha: 'e'.repeat(40), integration_receipt_digest: 'f'.repeat(64) }),
      ],
    }));
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  // ---- dual-path SG: verification_source 可选字段（receipts | git_facts）----

  it('accepts a GATE_RESULT payload carrying the optional verification_source field (receipts | git_facts)', async () => {
    for (const value of ['receipts', 'git_facts'] as const) {
      const fixture = prepareGateFixture();
      writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, {
        verification_source: value,
        integrated_slices: [sliceBinding()],
      }));
      const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
      expect(envelope.ok).toBe(true);
      expect((envelope.result as Record<string, any>).gate.receipt_count).toBe(1);
    }
  });

  it('fails closed when verification_source is not "receipts" | "git_facts"', async () => {
    const fixture = prepareGateFixture();
    writeGateReceipt(fixture, STAGE, closedGatePayload(fixture, {
      verification_source: 'bogus',
      integrated_slices: [sliceBinding()],
    }));
    const envelope = await runGateFromArgv(['gate', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });
});

describe('gate domain closed operation set', () => {
  it('fails closed on an unknown operation (exit 2 semantics, no-write)', async () => {
    const fixture = prepareGateFixture();
    const envelope = await runGateFromArgv(['gate', 'bogus', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.NOT_IMPLEMENTED');
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
  });

  it('refuses a wrong domain at the gate entry', async () => {
    const fixture = prepareGateFixture();
    const envelope = await runGateFromArgv(['stage', 'status', '--json', '--stage', STAGE], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });
});

describe('gate run via runGateDomain (handler-direct seam)', () => {
  it('returns the same envelope contract as the argv entry', async () => {
    const fixture = prepareGateFixture();
    const envelope = await runGateDomain(fixture.root, 'auto', { domain: 'gate', operation: 'run' }, { stage: STAGE });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings.length).toBeGreaterThan(0);
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
  });
});

describe('P-09 — gate run explicit re-gate pass-through (REPAIR-driven re-run)', () => {
  it('re-gates through the public built CLI after a REPAIR review: new PASS tip appended, old PASS kept', () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);
    const first = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(first.status).toBe(0);
    expect(first.envelope.ok).toBe(true);
    const firstDigest = first.envelope.refs[0].digest as string;

    // REPAIR review round at the current integrated HEAD (the slice-output
    // commit — fixture.commitSha predates integrateSlice).
    const currentHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const review = admitVNextStageReview({
      type: 'stage_review',
      stageId: STAGE,
      verdict: 'REPAIR',
      manifestDigest: fixture.manifestDigest,
      snapshotDigest: currentHead,
      summary: 'gate CLI REPAIR round',
    }, { projectRoot: fixture.root });
    expect(review.accepted).toBe(true);

    // The repair fix advances HEAD.
    fs.appendFileSync(path.join(fixture.root, 'packages/worker-test.ts'), 'export const repaired = true;\n');
    git(fixture.root, ['add', '-A']);
    git(fixture.root, ['commit', '-q', '-m', 'repair fix after review REPAIR']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);

    // Without re_gate the duplicate run is still refused (ALREADY_PASSED).
    const refused = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(refused.status).toBe(2);
    expect(refused.envelope.ok).toBe(false);
    expect(refused.envelope.findings[0]?.code).toBe('STAGE.GATE.ALREADY_PASSED');

    // Explicit re-gate: appended as the new chain tip at the advanced HEAD.
    const second = runPublicCli(['gate', 'run', '--json', `{"stage":"${STAGE}","re_gate":true}`], fixture.root);
    expect(second.status).toBe(0);
    expect(second.envelope.ok).toBe(true);
    expect(second.envelope.refs).toHaveLength(1);
    const newDigest = second.envelope.refs[0].digest as string;
    expect(newDigest).not.toBe(firstDigest);
    const receipts = fs.readdirSync(gateDir(fixture.root)).filter((name) => name.endsWith('.json'));
    expect(receipts).toHaveLength(2);
    const chain = receipts.map((name) =>
      JSON.parse(fs.readFileSync(path.join(gateDir(fixture.root), name), 'utf8')) as Record<string, any>,
    );
    const tip = chain.find((r) => r.digest === newDigest) as Record<string, any> | undefined;
    expect(tip).toBeDefined();
    expect((tip?.payload as Record<string, unknown>)?.snapshot_digest).toBe(head);
    expect(tip?.previous_digest).toBe(firstDigest);
    expect(chain.some((r) => r.digest === firstDigest)).toBe(true);
  });

  it('fails closed when the gate request re_gate is not a boolean (RUNTIME.INPUT_INVALID, no-write)', async () => {
    const fixture = prepareGateFixture();
    const envelope = await runGateFromArgv(
      ['gate', 'run', '--json', `{"stage":"${STAGE}","re_gate":"yes"}`],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0]?.code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0]?.message).toMatch(/re_gate/);
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
    expect(fs.existsSync(gateRuntimeResultPath(fixture.root))).toBe(false);
  });
});

describe('built public proofloop.js smoke (S10-C repair: public CLI success path)', () => {
  it('gate status exits 0 with a canonical envelope on the public built process (fixture)', () => {
    const fixture = prepareGateFixture();
    const { status, envelope } = runPublicCli(['gate', 'status', '--json', '--stage', STAGE], fixture.root);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'gate', operation: 'status' });
    expect(envelope.result.stage_id).toBe(STAGE);
    expect(envelope.result.gate.receipt_count).toBe(0);
  });

  it('gate run without the integrated prefix exits 2 with zero writes on the public built process', () => {
    const fixture = prepareGateFixture();
    const { status, envelope } = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(gateDir(fixture.root))).toBe(false);
    expect(fs.existsSync(gateRuntimeResultPath(fixture.root))).toBe(false);
  });

  it('gate run success path admits GATE_PASS and gate status reports the tip through the public built process', () => {
    const fixture = prepareGateFixture();
    integrateSlice(fixture);

    const run = runPublicCli(['gate', 'run', '--json', '--stage', STAGE], fixture.root);
    expect(run.status).toBe(0);
    expect(run.envelope.ok).toBe(true);
    expect((run.envelope.result as Record<string, any>).gate).toBe('PASS');
    expect(run.envelope.refs).toHaveLength(1);
    expect(fs.existsSync(gateRuntimeResultPath(fixture.root))).toBe(true);

    const status = runPublicCli(['gate', 'status', '--json', '--stage', STAGE], fixture.root);
    expect(status.status).toBe(0);
    expect(status.envelope.ok).toBe(true);
    expect((status.envelope.result as Record<string, any>).gate).toMatchObject({
      receipt_count: 1,
      latest: { receipt_type: 'GATE_PASS', verdict: 'PASS' },
    });
  });
});
