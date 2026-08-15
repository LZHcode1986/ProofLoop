/**
 * proofloop-review.spec.ts — S10-D-T01: review 域 handler 测试。
 *
 * 覆盖（对齐 S10-C 教训：成功路径全部 built public `node dist/cli/proofloop.js`
 * spawnSync + 临时 fixture；handler-direct 仅失败/边界用例；真实仓库只保留
 * 只读/失败路径与零写入断言）：
 *  - `review status`：只读 Stage Review 状态/Receipt 报告（Manifest/Proof
 *    digest 绑定 + review 链 + stage-gate 前缀链，root-bound/no-follow/
 *    self-digest/closed-schema 校验；空链为正常可查询状态，exit 0）；
 *  - `review prepare-stage`：只读组装 ReviewInput（manifest/plan/runtime_
 *    proof/snapshot digest + gate tip + ready_for_review），零写入；
 *  - `review finalize-stage`：verdict（ACCEPTED|REPAIR）+ summary 经
 *    CLI→Runtime review admission 保存 —— 成功返回 Receipt ref+digest，
 *    失败 canonical Finding + no-write（exit 2）；ACCEPTED tip 后拒绝再
 *    review；缺参/非法 verdict fail closed；
 *  - 未知操作 fail closed（RUNTIME.SCHEMA_MISMATCH，exit 2）；
 *  - 伪造/错位/closed-schema 破坏的 review 链 → status fail closed
 *    （RUNTIME.RECEIPT_CHAIN_BROKEN）。
 *
 * 注意：`proofloop <domain> <operation>` dispatcher wiring（proofloop.ts）
 * 与 review 域 closed request 字段登记（proofloop-common.ts）按 S10-C 先例
 * 由 Runtime direct-fix 完成（二者均不在本任务 execution_scope 内）。
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
import type { ReceiptWriterPort, VNextSpvPassReceipt } from '@proofloop/runtime';
import { computeDigest, computeReceiptDigest } from '@proofloop/kernel';
import { admitVNextSliceCommit } from '../vnext/commit-admission';
import { admitVNextGateResult } from '../vnext/gate-admission';
// handler-direct 直通入口：仅失败/边界用例（成功路径一律 built public CLI）。
import { runReviewFromArgv } from './proofloop-review';

const repo = path.resolve(__dirname, '../../../..');
const DIST_PROOFLOOP = path.join(repo, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function copyFixture(root: string, relative: string): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), destination);
}

interface ReviewCliFixture {
  readonly root: string;
  readonly snapshotDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly gateReceiptDigest: string;
  readonly commitSha: string;
}

/** 完整 vNext 前缀（Stage Plan + Worker→CV→Slice Commit→Integration→Gate）。 */
function prepareFixture(options: { gateVerdict?: 'PASS' | 'FAIL' } = {}): ReviewCliFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-cli-')));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'review-cli@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Review CLI Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');

  for (const relative of [
    'delivery/stages/S04/tasks.md',
    '.proofloop/manifests/S04.json',
    'delivery/stages/S04/evidence/S04-A.md',
    'delivery/stages/S0-A/tasks.md',
  ]) copyFixture(root, relative);

  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace(
      '- Worker Status: `NOT_STARTED`',
      '- Worker Status: `planned`',
    ),
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
        forbidden_paths: ['.proofloop/receipts', '.git'],
      },
    },
  };
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'review CLI planning boundary']);

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
  const spv: VNextSpvPassReceipt = {
    ...spvContent,
    digest: computeVNextSpvPassReceiptDigest(spvContent),
  };
  expect(admitVNextStagePlan({
    version: 2,
    schema_version: 2,
    type: 'STAGE_PLAN_ADMISSION',
    project_root: root,
    manifest_path: '.proofloop/manifests/S04.json',
    stage_id: 'S04',
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
    spv,
  }).accepted).toBe(true);

  const next = new VNextNextActionService().nextAction({
    projectRoot: root,
    stageId: 'S04',
    snapshotDigest,
    persistContext: true,
  });
  const context = JSON.parse(fs.readFileSync(path.join(root, next.context_ref as string), 'utf8')) as {
    context_digest: string;
  };

  const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
  fs.writeFileSync(path.join(root, 'packages/worker-test.ts'), 'export const fixture = true;\n', 'utf8');
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8')
      .replace('- [ ] S04-A-T01', '- [x] S04-A-T01')
      .replace('- Worker Status: `planned`', '- Worker Status: `executing`'),
    'utf8',
  );
  fs.writeFileSync(
    evidencePath,
    fs.readFileSync(evidencePath, 'utf8').replace(
      '## Task Evidence\n\n*Not yet captured.*',
      [
        '## Task Evidence',
        '',
        '### S04-A-T01',
        '',
        '- Task Goal: review cli fixture',
        '- Relevant PO IDs: PO-FIXTURE',
        '- Source Snapshot: fixture-source',
        '- Current Snapshot: fixture-current',
        '- Changed Files:',
        '  - delivery/stages/S04/evidence/S04-A.md',
        '  - delivery/stages/S04/tasks.md',
        '  - packages/worker-test.ts',
        '- RED Receipt:',
        '  - Test ID: review-cli-red',
        '  - Command: review-cli-red-command',
        '  - Failure Output: review-cli-red-output',
        '  - Expected Failure: review-cli-red-expected',
        '  - Snapshot: review-cli-red-snapshot',
        '- GREEN Receipt:',
        '  - Test ID: review-cli-green',
        '  - Command: review-cli-green-command',
        '  - Pass Output: review-cli-green-output',
        '  - Snapshot: review-cli-green-snapshot',
        '- Status: COMPLETE',
      ].join('\n'),
    ),
    'utf8',
  );

  const proofIndex = (manifest.slices as Array<Record<string, any>>)[0].proof_index as Record<string, any>;
  const worker = admitVNextWorkerResult({
    schemaVersion: 2,
    actionToken: 'review-cli-worker-1',
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
    summary: 'review CLI Worker completed',
    manifestDigest: manifestDigest,
    planDigest,
    proofIndexDigest: next.proof_index_digest,
    snapshotDigest,
    contextRef: next.context_ref,
    contextDigest: context.context_digest,
  }, { projectRoot: root });
  if (!worker.accepted) {
    throw new Error('worker not accepted: ' + JSON.stringify(worker.findings));
  }

  const cv = admitVNextCVResult({
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: 'S04',
    slice_id: 'S04-A',
    worker_receipt_digest: worker.receipt_ref,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    proof_index_digest: next.proof_index_digest,
    context_ref: next.context_ref,
    context_digest: context.context_digest,
    snapshot_digest: snapshotDigest,
    verification_type: 'initial',
    verdict: 'PASS',
    summary: 'review CLI CV passed',
    acceptance_refs_checked: [...proofIndex.acceptance_refs],
    seam_refs_checked: [...proofIndex.seam_refs],
    oracle_refs_checked: [...proofIndex.oracle_refs],
    risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'review CLI fixture binding',
    })),
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
  }, { projectRoot: root });
  expect(cv.accepted).toBe(true);

  execFileSync('git', [
    '-C', root,
    'add',
    'delivery/stages/S04/tasks.md',
    'delivery/stages/S04/evidence/S04-A.md',
    'packages/worker-test.ts',
  ]);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'slice-output: S04-S04-A']);
  const commitSha = git(root, ['rev-parse', 'HEAD']);
  const sliceCommit = admitVNextSliceCommit({
    type: 'slice_commit',
    stageId: 'S04',
    sliceId: 'S04-A',
    commitSha,
    cvReceiptDigest: cv.receipt_ref as string,
  }, { projectRoot: root });
  expect(sliceCommit.accepted).toBe(true);

  const integration = admitVNextIntegration({
    type: 'integration',
    stageId: 'S04',
    sliceId: 'S04-A',
    commitSha,
  }, { projectRoot: root });
  expect(integration.accepted).toBe(true);

  const gate = admitVNextGateResult({
    type: 'gate_result',
    stageId: 'S04',
    verdict: options.gateVerdict ?? 'PASS',
    manifestDigest,
    snapshotDigest: commitSha,
    summary: 'review CLI fixture gate',
  }, { projectRoot: root });
  if (!gate.accepted) {
    throw new Error('gate not accepted: ' + JSON.stringify(gate.findings));
  }

  return {
    root,
    snapshotDigest,
    manifestDigest,
    planDigest,
    proofIndexDigest: next.proof_index_digest as string,
    contextRef: next.context_ref as string,
    contextDigest: context.context_digest,
    gateReceiptDigest: gate.receipt_ref as string,
    commitSha,
  };
}

function reviewFiles(fixture: ReviewCliFixture): string[] {
  const directory = path.join(fixture.root, '.proofloop/receipts/review/S04');
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')) : [];
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
      reason: 'stage review accepted; stage closed (fixture)',
      manifest_digest: 'a'.repeat(64),
    },
  };
  const digest = computeReceiptDigest(content);
  const directory = path.join(root, '.proofloop', 'receipts', 'stage-close', stageId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${digest}.json`), JSON.stringify({ ...content, digest }, null, 2), 'utf8');
  return digest;
}

function finalizeRequest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    stage: 'S04',
    verdict: 'ACCEPTED',
    summary: 'review CLI ACCEPTED',
    ...overrides,
  });
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

// ============================================================
// built public proofloop.js 成功路径（临时 fixture，spawnSync）
// ============================================================

describe('built public proofloop.js review smoke（S10-D-T01 成功路径）', () => {
  it('`review status --json --stage S04` exits 0 before any review（empty review chain is a queryable state）', () => {
    const fixture = prepareFixture();
    const { status, envelope } = runPublicCli(['review', 'status', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(0);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'review', operation: 'status' });
    expect(envelope.result.stage_id).toBe('S04');
    expect(envelope.result.manifest_digest).toBe(fixture.manifestDigest);
    expect(envelope.result.plan_digest).toBe(fixture.planDigest);
    expect(envelope.result.snapshot_digest).toBe(fixture.commitSha);
    expect(envelope.result.review.receipt_count).toBe(0);
    expect(envelope.result.review.latest).toBeNull();
    expect(envelope.result.stage_gate.latest.verdict).toBe('PASS');
    expect(envelope.result.stage_gate.latest.digest).toBe(fixture.gateReceiptDigest);
    expect(envelope.result.ready_for_review).toBe(true);
    expect(envelope.findings).toEqual([]);
  });

  it('`review prepare-stage --json --stage S04` assembles the read-only ReviewInput（zero write）', () => {
    const fixture = prepareFixture();
    const before = receiptsListing(fixture.root);
    const { status, envelope } = runPublicCli(['review', 'prepare-stage', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result).toMatchObject({
      schema_version: 2,
      stage_id: 'S04',
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      snapshot_digest: fixture.commitSha,
    });
    expect(envelope.result.review_input.stage_gate.latest.verdict).toBe('PASS');
    expect(envelope.result.review_input.ready_for_review).toBe(true);
    expect(receiptsListing(fixture.root)).toEqual(before);
  });

  it('`review finalize-stage --json` admits ACCEPTED and returns Receipt ref+digest', () => {
    const fixture = prepareFixture();
    const { status, envelope } = runPublicCli(
      ['review', 'finalize-stage', '--json', finalizeRequest()],
      fixture.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.accepted).toBe(true);
    expect(envelope.result.receipt_ref.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.result.receipt_ref.ref).toBe(
      `.proofloop/receipts/review/S04/${envelope.result.receipt_ref.digest}.json`,
    );
    expect(envelope.result.new_state).toMatchObject({
      schema_version: 2,
      type: 'STAGE_REVIEW_RESULT',
      action: 'STAGE_REVIEW',
      stage_id: 'S04',
      verdict: 'ACCEPTED',
      snapshot_digest: fixture.commitSha,
      receipt_chain_valid: true,
    });
    expect(envelope.refs).toEqual([
      { ref: envelope.result.receipt_ref.ref, digest: envelope.result.receipt_ref.digest },
    ]);
    expect(reviewFiles(fixture)).toHaveLength(1);
    expect(reviewFiles(fixture)[0]).toBe(`${envelope.result.receipt_ref.digest}.json`);
    expect(gitStatus(fixture.root)).toBe('');
  });

  it('admits REPAIR then ACCEPTED rounds, then refuses re-review after an ACCEPTED tip', () => {
    const fixture = prepareFixture();
    const first = runPublicCli(
      ['review', 'finalize-stage', '--json', finalizeRequest({ verdict: 'REPAIR', summary: 'round one repairs' })],
      fixture.root,
    );
    expect(first.status).toBe(0);
    expect(first.envelope.result.new_state.verdict).toBe('REPAIR');
    expect(reviewFiles(fixture)).toHaveLength(1);

    const second = runPublicCli(
      ['review', 'finalize-stage', '--json', finalizeRequest({ summary: 'round two accepts' })],
      fixture.root,
    );
    expect(second.status).toBe(0);
    expect(second.envelope.result.new_state.verdict).toBe('ACCEPTED');
    expect(reviewFiles(fixture)).toHaveLength(2);

    const third = runPublicCli(
      ['review', 'finalize-stage', '--json', finalizeRequest({ verdict: 'REPAIR', summary: 're-review after ACCEPTED' })],
      fixture.root,
    );
    expect(third.status).toBe(2);
    expect(third.envelope.ok).toBe(false);
    expect(third.envelope.findings.length).toBeGreaterThan(0);
    expect(reviewFiles(fixture)).toHaveLength(2);
  });

  it('`review status` reports the ACCEPTED tip after finalize', () => {
    const fixture = prepareFixture();
    const finalized = runPublicCli(
      ['review', 'finalize-stage', '--json', finalizeRequest()],
      fixture.root,
    );
    expect(finalized.status).toBe(0);
    const receiptDigest = finalized.envelope.result.receipt_ref.digest as string;

    const { status, envelope } = runPublicCli(['review', 'status', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.review.receipt_count).toBe(1);
    expect(envelope.result.review.latest).toMatchObject({
      receipt_type: 'STAGE_REVIEW_PASS',
      verdict: 'ACCEPTED',
      digest: receiptDigest,
    });
    expect(envelope.result.ready_for_review).toBe(false);
  });

  it('`review status` reports an archived stage（STAGE_CLOSE → archived:true + stage_close facts, ready_for_review:false despite the Gate PASS tip）', () => {
    const fixture = prepareFixture();
    const digest = writeStageCloseReceipt(fixture.root, 'S04');
    const { status, envelope } = runPublicCli(['review', 'status', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.archived).toBe(true);
    expect(envelope.result.stage_close).toEqual({
      receipt_count: 1,
      latest: { digest, receipt_type: 'STAGE_CLOSE_PASS', close_type: 'COMPLETED' },
    });
    // Gate PASS tip 存在也不得让已归档 Stage ready（不再因 gate tip 而 ready）。
    expect(envelope.result.stage_gate.latest.verdict).toBe('PASS');
    expect(envelope.result.ready_for_review).toBe(false);
  });

  it('`review status --json --stage S10` exits 0 on the real repo（S10 runtime proof step 7, read-only）', () => {
    // 只读断言：receipts 目录零写入（真实仓库工作树含本任务未提交授权
    // 修改，git status 不做 clean 基线；receiptsListing 对比即可证明 CLI
    // 未产生任何 Receipt 副作用）。
    const before = receiptsListing(repo);
    const { status, envelope } = runPublicCli(
      ['review', 'status', '--json', '--stage', 'S10'],
      path.join(repo, 'packages', 'runtime'),
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'review', operation: 'status' });
    expect(envelope.result.stage_id).toBe('S10');
    expect(typeof envelope.result.manifest_digest).toBe('string');
    expect(envelope.result.review.receipt_count).toBe(0);
    expect(receiptsListing(repo)).toEqual(before);
  });

  it('`review finalize-stage` refuses without a Stage Gate PASS prefix（no write）', () => {
    const fixture = prepareFixture();
    fs.rmSync(path.join(fixture.root, '.proofloop/receipts/stage-gate/S04'), {
      recursive: true,
      force: true,
    });
    const { status, envelope } = runPublicCli(
      ['review', 'finalize-stage', '--json', finalizeRequest()],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings.length).toBeGreaterThan(0);
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('`review finalize-stage` refuses when the stage-gate tip is FAIL（no write）', () => {
    const fixture = prepareFixture({ gateVerdict: 'FAIL' });
    const { status, envelope } = runPublicCli(
      ['review', 'finalize-stage', '--json', finalizeRequest()],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('`review status` fails closed on a forged/misplaced review Receipt（RUNTIME.RECEIPT_CHAIN_BROKEN）', () => {
    const fixture = prepareFixture();
    const finalized = runPublicCli(
      ['review', 'finalize-stage', '--json', finalizeRequest()],
      fixture.root,
    );
    expect(finalized.status).toBe(0);
    const reviewDir = path.join(fixture.root, '.proofloop/receipts/review/S04');
    const legitPath = path.join(reviewDir, `${finalized.envelope.result.receipt_ref.digest}.json`);
    const legit = JSON.parse(fs.readFileSync(legitPath, 'utf8')) as Record<string, unknown>;
    const forged = JSON.parse(JSON.stringify(legit)) as Record<string, unknown>;
    forged.type = 'TASK_COMPLETE';
    forged.timestamp = String(legit.timestamp).slice(0, 10) + 'T00:00:00.000Z';
    const { digest: _oldDigest, ...content } = forged;
    void _oldDigest;
    forged.digest = computeReceiptDigest(content as never);
    fs.writeFileSync(path.join(reviewDir, `${forged.digest}.json`), JSON.stringify(forged), 'utf8');

    const { status, envelope } = runPublicCli(['review', 'status', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('`review status` fails closed on a tampered review payload（unknown field）', () => {
    const fixture = prepareFixture();
    const finalized = runPublicCli(
      ['review', 'finalize-stage', '--json', finalizeRequest()],
      fixture.root,
    );
    expect(finalized.status).toBe(0);
    const reviewDir = path.join(fixture.root, '.proofloop/receipts/review/S04');
    const legitPath = path.join(reviewDir, `${finalized.envelope.result.receipt_ref.digest}.json`);
    const legit = JSON.parse(fs.readFileSync(legitPath, 'utf8')) as Record<string, unknown>;
    const forged = JSON.parse(JSON.stringify(legit)) as Record<string, unknown>;
    (forged.payload as Record<string, unknown>).forged_extra_field = 'x';
    forged.timestamp = String(legit.timestamp).slice(0, 10) + 'T00:00:00.000Z';
    const { digest: _oldDigest, ...content } = forged;
    void _oldDigest;
    forged.digest = computeReceiptDigest(content as never);
    fs.writeFileSync(path.join(reviewDir, `${forged.digest}.json`), JSON.stringify(forged), 'utf8');

    const { status, envelope } = runPublicCli(['review', 'status', '--json', '--stage', 'S04'], fixture.root);
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
  });

  it('unknown review operation fails closed with a single envelope and no write（fixture, clean tree）', () => {
    // 在临时 fixture 上断言零写入（fixture 为干净 git 仓库，git status
    // 可验证；真实仓库工作树含本任务未提交授权修改，无法作为 clean 基线）。
    const fixture = prepareFixture();
    const before = receiptsListing(fixture.root);
    const { status, envelope } = runPublicCli(
      ['review', 'bogus-op', '--json', '--stage', 'S04'],
      fixture.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(receiptsListing(fixture.root)).toEqual(before);
    expect(gitStatus(fixture.root)).toBe('');
  });
});

// ============================================================
// handler-direct 失败/边界用例（成功路径一律 built public CLI）
// ============================================================

describe('review handler-direct boundary（runReviewFromArgv）', () => {
  it('`finalize-stage` without a verdict fails closed（STAGE_REVIEW schema）', () => {
    const fixture = prepareFixture();
    const envelope = runReviewFromArgv(['review', 'finalize-stage', '--stage', 'S04'], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('`finalize-stage` with an empty summary fails closed', () => {
    const fixture = prepareFixture();
    const envelope = runReviewFromArgv(
      ['review', 'finalize-stage', '--stage', 'S04', '--json', JSON.stringify({ verdict: 'ACCEPTED', summary: '' })],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    // 未登记 review 域 request 字段时（wiring direct-fix 前）由 closed schema
    // 拒绝（RUNTIME.INPUT_INVALID）；登记后由 handler 的 summary 检查拒绝
    // （RUNTIME.SCHEMA_MISMATCH）。两种状态都必须零写入。
    expect(['RUNTIME.SCHEMA_MISMATCH', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('`finalize-stage` with an illegal verdict fails closed（closed set ACCEPTED|REPAIR）', () => {
    const fixture = prepareFixture();
    const envelope = runReviewFromArgv(
      ['review', 'finalize-stage', '--stage', 'S04', '--json', JSON.stringify({ verdict: 'APPROVED', summary: 'x' })],
      { cwd: fixture.root },
    );
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.SCHEMA_MISMATCH', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('status requires a canonical Stage ID（legacy S08B0 fails closed）', () => {
    const fixture = prepareFixture();
    const envelope = runReviewFromArgv(['review', 'status', '--stage', 'S08B0'], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
  });

  it('status fails closed when the Manifest is not a vNext route', () => {
    const fixture = prepareFixture();
    fs.writeFileSync(
      path.join(fixture.root, '.proofloop/manifests/S04.json'),
      JSON.stringify({ version: 1 }),
      'utf8',
    );
    const envelope = runReviewFromArgv(['review', 'status', '--stage', 'S04'], { cwd: fixture.root });
    expect(envelope.ok).toBe(false);
    expect(['RUNTIME.SCHEMA_MISMATCH', 'RUNTIME.INPUT_INVALID']).toContain(envelope.findings[0].code);
  });
});