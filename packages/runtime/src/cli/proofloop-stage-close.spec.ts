/**
 * proofloop-stage-close.spec.ts — P-11: stage close public CLI 测试。
 *
 * `stage close` 是 vNext Stage Close admission（`admitVNextStageClose`）的
 * public CLI 入口：closed 参数合同（stage / close_type / reason /
 * manifest_digest / snapshot_digest；plan_digest 与 stage_plan_receipt_digest
 * / spv_receipt_digest 由 seam 从 root-bound authority 重读派生，caller 不可
 * 注入）→ CLI→Runtime admission consumer → write-once STAGE_CLOSE_PASS
 * receipt（stage-close/<stage>/<digest>.json）。
 *
 * 对齐 S10-C/D 先例：成功路径一律 built public `node dist/cli/proofloop.js`
 * spawnSync + 临时 fixture git 仓库（绝不污染真实 .proofloop）；失败路径
 * 全部断言 canonical envelope + exit 2 + 零写入。
 *
 * 覆盖：
 *  - full close 成功（receipt 落盘 + 读回 envelope/payload 字段）；
 *  - restricted close 成功；
 *  - 非法 close_type / 缺失必填字段（reason、manifest_digest）/ 未知 stage id
 *    / 已有 close receipt（write-once 拒绝）/ stale snapshot / dirty worktree
 *    → fail-closed 零写入（exit 2）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  admitVNextStagePlan,
  computeVNextSpvPassReceiptDigest,
  resolveVNextReference,
} from '../vnext';
import type { VNextSpvPassReceipt } from '../vnext';
import { computeDigest } from '@proofloop/kernel';

const REPO = path.resolve(__dirname, '../../../..');
const cleanups: string[] = [];

afterEach(() => {
  for (const root of cleanups.splice(0)) {
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

/**
 * 轻量 close fixture：planning boundary + Stage Plan/SPV authority 已持久化
 * （worktree clean，HEAD 稳定）。Stage Close 只重验 Manifest + Stage Plan/SPV
 * authority tuple + snapshot，无需 worker/cv/integration/gate 前缀。
 */
function prepareCloseFixture(): {
  readonly root: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly snapshotDigest: string;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-stage-close-cli-')));
  cleanups.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'stage-close@test.local']);
  git(root, ['config', 'user.name', 'Stage Close Cli Test']);
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

  return { root, manifestDigest, planDigest, snapshotDigest };
}

/** closed stage close request（`undefined` 字段被 JSON.stringify 省略 → 缺失）。 */
function closeRequest(
  fixture: ReturnType<typeof prepareCloseFixture>,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    stage: 'S04',
    close_type: 'full',
    reason: 'stage close CLI fixture',
    manifest_digest: fixture.manifestDigest,
    snapshot_digest: fixture.snapshotDigest,
    ...overrides,
  });
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

/** stage-close receipt 目录下的 digest-addressed 文件（零写入断言）。 */
function stageCloseReceipts(root: string): string[] {
  const directory = path.join(root, '.proofloop', 'receipts', 'stage-close', 'S04');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
}

function gitStatus(root: string): string {
  return git(root, ['status', '--porcelain']);
}

// ============================================================
// 成功路径（built public CLI + 临时 fixture）
// ============================================================

describe('stage close 成功（P-11 built public CLI）', () => {
  it('`stage close --json` admits a full close: receipt on disk + envelope readback', () => {
    const fixture = prepareCloseFixture();
    const { status, envelope } = runPublicCli(
      ['stage', 'close', '--json', closeRequest(fixture)],
      fixture.root,
    );
    expect(status).toBe(0);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'stage', operation: 'close' });
    expect(envelope.result.accepted).toBe(true);
    expect(envelope.result.receipt_ref.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.result.receipt_ref.ref).toBe(
      `.proofloop/receipts/stage-close/S04/${envelope.result.receipt_ref.digest}.json`,
    );
    expect(envelope.result.new_state).toMatchObject({
      schema_version: 2,
      type: 'STAGE_CLOSE_RESULT',
      action: 'STAGE_CLOSE',
      stage_id: 'S04',
      close_type: 'full',
      reason: 'stage close CLI fixture',
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      snapshot_digest: fixture.snapshotDigest,
      receipt_chain_valid: true,
    });
    // plan_digest / stage_plan_receipt_digest / spv_receipt_digest 由 seam
    // 从 root-bound authority 重读派生（caller 不可注入）。
    expect(typeof envelope.result.new_state.stage_plan_receipt_digest).toBe('string');
    expect(envelope.result.new_state.stage_plan_receipt_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof envelope.result.new_state.spv_receipt_digest).toBe('string');
    expect(envelope.result.new_state.spv_receipt_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.result.findings).toEqual([]);
    expect(envelope.refs).toEqual([
      { ref: envelope.result.receipt_ref.ref, digest: envelope.result.receipt_ref.digest },
    ]);

    // receipt 落盘 + 可读回（STAGE_CLOSE_PASS envelope + closed v2 payload）。
    const receiptPath = path.join(
      fixture.root,
      '.proofloop/receipts/stage-close/S04',
      `${envelope.result.receipt_ref.digest}.json`,
    );
    expect(fs.existsSync(receiptPath)).toBe(true);
    expect(stageCloseReceipts(fixture.root)).toEqual([`${envelope.result.receipt_ref.digest}.json`]);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, any>;
    expect(receipt.version).toBe(1);
    expect(receipt.type).toBe('STAGE_CLOSE_PASS');
    expect(receipt.stage_id).toBe('S04');
    expect(receipt.digest).toBe(envelope.result.receipt_ref.digest);
    expect(receipt.payload).toMatchObject({
      schema_version: 2,
      type: 'STAGE_CLOSE_RESULT',
      action: 'STAGE_CLOSE',
      stage_id: 'S04',
      close_type: 'full',
      reason: 'stage close CLI fixture',
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      snapshot_digest: fixture.snapshotDigest,
      receipt_chain_valid: true,
    });
    // 收尾后 worktree 仍 clean（receipt 在 gitignored .proofloop 下）。
    expect(gitStatus(fixture.root)).toBe('');
  });

  it('`stage close --json` admits a restricted close（close_type restricted）', () => {
    const fixture = prepareCloseFixture();
    const { status, envelope } = runPublicCli(
      ['stage', 'close', '--json', closeRequest(fixture, { close_type: 'restricted', reason: 'user-adjudicated restricted close (fixture)' })],
      fixture.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.new_state.close_type).toBe('restricted');
    expect(envelope.result.new_state.reason).toBe('user-adjudicated restricted close (fixture)');
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(fixture.root, '.proofloop/receipts/stage-close/S04', `${envelope.result.receipt_ref.digest}.json`),
        'utf8',
      ),
    ) as Record<string, any>;
    expect(receipt.type).toBe('STAGE_CLOSE_PASS');
    expect(receipt.payload.close_type).toBe('restricted');
  });
});

// ============================================================
// 失败/边界（fail-closed 零写入）
// ============================================================

describe('stage close 失败/边界（P-11 fail-closed 零写入）', () => {
  it('refuses an illegal close_type（closed set full|restricted, exit 2, no write）', () => {
    const fixture = prepareCloseFixture();
    const { status, envelope } = runPublicCli(
      ['stage', 'close', '--json', closeRequest(fixture, { close_type: 'COMPLETED' })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.result).toBeNull();
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(String(envelope.findings[0].message)).toMatch(/close_type/);
    expect(stageCloseReceipts(fixture.root)).toEqual([]);
    expect(gitStatus(fixture.root)).toBe('');
  });

  it('refuses a missing reason（exit 2, no write）', () => {
    const fixture = prepareCloseFixture();
    const { status, envelope } = runPublicCli(
      ['stage', 'close', '--json', closeRequest(fixture, { reason: undefined })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(String(envelope.findings[0].message)).toMatch(/reason/);
    expect(stageCloseReceipts(fixture.root)).toEqual([]);
  });

  it('refuses a missing manifest_digest（exit 2, no write）', () => {
    const fixture = prepareCloseFixture();
    const { status, envelope } = runPublicCli(
      ['stage', 'close', '--json', closeRequest(fixture, { manifest_digest: undefined })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(String(envelope.findings[0].message)).toMatch(/manifest_digest/);
    expect(stageCloseReceipts(fixture.root)).toEqual([]);
  });

  it('refuses an unknown stage id（exit 2, no write）', () => {
    const fixture = prepareCloseFixture();
    const { status, envelope } = runPublicCli(
      ['stage', 'close', '--json', closeRequest(fixture, { stage: 'S99' })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(stageCloseReceipts(fixture.root)).toEqual([]);
  });

  it('refuses a second close after a close receipt exists（write-once, exit 2, no second write）', () => {
    const fixture = prepareCloseFixture();
    const first = runPublicCli(['stage', 'close', '--json', closeRequest(fixture)], fixture.root);
    expect(first.status).toBe(0);
    expect(first.envelope.ok).toBe(true);
    expect(stageCloseReceipts(fixture.root)).toHaveLength(1);

    const second = runPublicCli(
      ['stage', 'close', '--json', closeRequest(fixture, { reason: 'second close attempt' })],
      fixture.root,
    );
    expect(second.status).toBe(2);
    expect(second.envelope.ok).toBe(false);
    expect(second.envelope.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(String(second.envelope.findings[0].message)).toMatch(/already closed/);
    expect(stageCloseReceipts(fixture.root)).toHaveLength(1);
  });

  it('refuses a stale snapshot_digest（does not match Git HEAD, exit 2, no write）', () => {
    const fixture = prepareCloseFixture();
    const { status, envelope } = runPublicCli(
      ['stage', 'close', '--json', closeRequest(fixture, { snapshot_digest: 'a'.repeat(40) })],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(String(envelope.findings[0].message)).toMatch(/refused/);
    expect(stageCloseReceipts(fixture.root)).toEqual([]);
  });

  it('refuses a dirty working tree（exit 2, no write）', () => {
    const fixture = prepareCloseFixture();
    fs.appendFileSync(path.join(fixture.root, 'packages/worker-test.ts'), 'export const dirty = true;\n');
    const { status, envelope } = runPublicCli(
      ['stage', 'close', '--json', closeRequest(fixture)],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(String(envelope.findings[0].message)).toMatch(/working tree is not clean/);
    expect(stageCloseReceipts(fixture.root)).toEqual([]);
  });
});
