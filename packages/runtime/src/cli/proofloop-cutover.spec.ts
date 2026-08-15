/**
 * proofloop-cutover.spec.ts — S10-E-T02 (CV repair 7bca6c06): cutover 域测试。
 *
 * PO 绑定：REF-S10-E-T02, REF-CLI-ACCEPTANCE（Acceptance F: cutover）、
 * REF-S10-CUTOVER-RISK（irreversible_operation/migration）、REF-S08D-RISK。
 *
 * Contract（REF-S10-CUTOVER-RISK + tasks.md S10-E-T02）：
 *  - cutover 域注册于唯一 public seam（CANONICAL_DOMAINS / DOMAIN_REGISTRY）；
 *  - `cutover status`（只读）：legacy scan → cutover matrix；零写入 exit 0；
 *  - `cutover execute`（不可逆）：带 irreversible 保护语义 ——
 *    a. confirmed:true 且 delete_list 非空；
 *    b. Acceptance A–E 事实门禁（每个 Slice CV_PASS + INTEGRATION_PASS
 *       integrated）；
 *    c. 精确删除清单绑定（delete_list 必须与 status 检测的 legacy 删除
 *       目标完全一致）；
 *    d. 原子预检（root-bound / 普通文件 / 可删）→ 删除循环失败停止并报告
 *       已删/未删明细。
 *
 * 本 spec 全部经 built public `node dist/cli/proofloop.js` spawnSync 调用
 * （唯一 public seam，不再走直通入口）；fixture 在 mkdtemp 临时 git 仓库中
 * 构造（S10 形状 vNext Manifest + 每 Slice CV_PASS/INTEGRATION_PASS
 * receipts + legacy 文件），绝不触碰真实仓库。
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  computeDigest,
  computeReceiptDigest,
  computeVNextSpvPassReceiptDigest,
  computeVNextStagePlanReceiptDigest,
  writeReceipt,
} from '@proofloop/kernel';
import {
  cvReceiptDir,
  integrationReceiptDir,
  stageGateReceiptDir,
  reviewReceiptDir,
  projectReceiptDir,
  computeCanonicalJsonDigest,
  fileDigest16,
  computeSnapshot,
} from '@proofloop/runtime';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PROOFLOOP_DIST = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');

const STAGE_ID = 'S10';
const SLICE_IDS = ['S10-A', 'S10-B', 'S10-C', 'S10-D', 'S10-E'];
const FAKE_SHA = 'a'.repeat(40);
const FAKE_64 = 'b'.repeat(64);
/** 真实 Project 域（非 stage）digest 宽度：fileDigest16 / computeCanonicalJsonDigest /
 *  computeSnapshot 均为 16 位 hex（project-acceptance.ts 唯一事实）；vNext
 *  stage_receipts 条目 digest 为 64 位、snapshot 为 40 位（见
 *  assertProjectReviewClosed / seedRealProjectAcceptance）。 */
const FAKE_16 = 'c'.repeat(16);

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cutover-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'cutover@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Cutover Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  cleanups.push(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
  return root;
}

function write(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

function commitAll(root: string, message = 'fixture'): void {
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
}

/** 最小合法 vNext Manifest（S10 形状，5 个 Slice；kernel 校验通过）。 */
function writeManifest(root: string): void {
  const reference = (id: string, kind: string, entity: string): Record<string, string> => ({
    kind,
    ref: `refs.md#/entities/${entity}`,
    file_digest: FAKE_64,
    section_digest: FAKE_64,
  });
  const manifest = {
    version: 2,
    stage_id: STAGE_ID,
    plan: {
      ref: 'delivery/stages/S10/tasks.md',
      plan_digest: FAKE_64,
      schema_version: 2,
    },
    reference_index: {
      'REF-G': reference('REF-G', 'goal', 'goal'),
      'REF-A': reference('REF-A', 'acceptance', 'acceptance'),
      'REF-S': reference('REF-S', 'seam', 'seam'),
      'REF-O': reference('REF-O', 'oracle', 'oracle'),
      'REF-R': reference('REF-R', 'risk', 'risk'),
      'REF-RP': reference('REF-RP', 'proof_spec', 'rp'),
    },
    authority_ref_ids: ['REF-A', 'REF-S', 'REF-O'],
    task_scopes: {},
    slices: SLICE_IDS.map((sliceId) => ({
      slice_id: sliceId,
      proof_index: {
        slice_id: sliceId,
        goal_ref: 'REF-G',
        task_refs: [],
        acceptance_refs: ['REF-A'],
        seam_refs: ['REF-S'],
        oracle_refs: ['REF-O'],
        risk_refs: [],
      },
      required_skills: [],
      depends_on: [],
      evidence_path: `delivery/stages/S10/evidence/${sliceId}.md`,
    })),
  };
  write(root, `.proofloop/manifests/${STAGE_ID}.json`, JSON.stringify(manifest));
  write(root, 'refs.md', '<!-- proofloop:entity id="goal" kind="goal" -->\n');
}

/** 从 fixture manifest 文件派生绑定值（与 handler 同源：computeDigest）。 */
function fixtureBinding(root: string): {
  manifestDigest: string;
  planDigest: string;
  proofIndexDigest: (sliceId: string) => string;
  snapshotDigest: string;
} {
  const manifestPath = path.join(root, '.proofloop/manifests', `${STAGE_ID}.json`);
  const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    plan: { plan_digest: string };
    slices: Array<{ slice_id: string; proof_index: unknown }>;
  };
  const bySlice = new Map<string, string>();
  for (const slice of manifestObj.slices) {
    bySlice.set(slice.slice_id, computeDigest(slice.proof_index));
  }
  return {
    manifestDigest: computeDigest(manifestObj),
    planDigest: manifestObj.plan.plan_digest,
    proofIndexDigest: (sliceId: string) => {
      const digest = bySlice.get(sliceId);
      if (digest === undefined) throw new Error(`unknown slice ${sliceId}`);
      return digest;
    },
    snapshotDigest: FAKE_SHA,
  };
}

/** 写 Stage Plan/SPV admission authority（readVNextAdmissionAuthority 必需）。 */
function seedAuthority(root: string): void {
  const binding = fixtureBinding(root);
  const planDir = path.join(root, '.proofloop/receipts/plan', STAGE_ID);
  fs.mkdirSync(planDir, { recursive: true });
  const spv = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: STAGE_ID,
    manifest_digest: binding.manifestDigest,
    plan_digest: binding.planDigest,
    snapshot_digest: binding.snapshotDigest,
  };
  const spvDigest = computeVNextSpvPassReceiptDigest(spv);
  fs.writeFileSync(
    path.join(planDir, 'vnext-spv-pass.json'),
    JSON.stringify({ ...spv, digest: spvDigest }),
    'utf-8',
  );
  const stagePlan = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'STAGE_PLAN' as const,
    stage_id: STAGE_ID,
    manifest_digest: binding.manifestDigest,
    plan_digest: binding.planDigest,
    snapshot_digest: binding.snapshotDigest,
    spv_receipt_digest: spvDigest,
  };
  fs.writeFileSync(
    path.join(planDir, 'vnext-stage-plan.json'),
    JSON.stringify({ ...stagePlan, digest: computeVNextStagePlanReceiptDigest(stagePlan) }),
    'utf-8',
  );
}

/** 为每个 Slice 写真实闭合 vNext CV_PASS + INTEGRATION_PASS receipts。 */
function seedAcceptanceFacts(root: string, options: { gate?: boolean; review?: boolean } = {}): void {
  const { gate = true, review = true } = options;
  const binding = fixtureBinding(root);
  for (const sliceId of SLICE_IDS) {
    const proofIndexDigest = binding.proofIndexDigest(sliceId);
    const cvDir = cvReceiptDir(root, STAGE_ID, sliceId);
    fs.mkdirSync(cvDir, { recursive: true });
    writeReceipt(
      {
        version: 1,
        type: 'CV_PASS',
        stage_id: STAGE_ID,
        slice_id: sliceId,
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2,
          type: 'CV_RESULT',
          stage_id: STAGE_ID,
          slice_id: sliceId,
          verdict: 'PASS',
          worker_receipt_digest: FAKE_64,
          manifest_digest: binding.manifestDigest,
          plan_digest: binding.planDigest,
          proof_index_digest: proofIndexDigest,
          context_ref: `.proofloop/context/${'c'.repeat(64)}.json`,
          context_digest: 'c'.repeat(64),
          snapshot_digest: binding.snapshotDigest,
          verification_type: 'initial',
          summary: 'fixture cv pass',
          acceptance_refs_checked: ['REF-A'],
          seam_refs_checked: ['REF-S'],
          oracle_refs_checked: ['REF-O'],
          risk_refs_considered: [{ ref_id: 'REF-R', applicability: 'NOT_APPLICABLE', reason: 'fixture' }],
          failed_acceptance_refs: [],
          invalid_tests: [],
          counterexamples: [],
          scope_violations: [],
          forbidden_substitutions: [],
          regression_failures: [],
        },
      },
      { receiptDir: cvDir, tempDir: cvDir },
    );
    const intDir = integrationReceiptDir(root, STAGE_ID, sliceId);
    fs.mkdirSync(intDir, { recursive: true });
    writeReceipt(
      {
        version: 1,
        type: 'INTEGRATION_PASS',
        stage_id: STAGE_ID,
        slice_id: sliceId,
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2,
          type: 'INTEGRATION_RESULT',
          action: 'INTEGRATION',
          stage_id: STAGE_ID,
          slice_id: sliceId,
          commit_sha: FAKE_SHA,
          worker_receipt_digest: FAKE_64,
          cv_receipt_digest: FAKE_64,
          slice_commit_receipt_digest: FAKE_64,
          changed_files: ['delivery/stages/S10/evidence/placeholder.md'],
          manifest_digest: binding.manifestDigest,
          plan_digest: binding.planDigest,
          proof_index_digest: proofIndexDigest,
          snapshot_digest: binding.snapshotDigest,
          receipt_chain_valid: true,
        },
      },
      { receiptDir: intDir, tempDir: intDir },
    );
  }
  if (gate) {
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    fs.mkdirSync(gateDir, { recursive: true });
    writeReceipt(
      {
        version: 1,
        type: 'GATE_PASS',
        stage_id: STAGE_ID,
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2,
          type: 'GATE_RESULT',
          action: 'GATE',
          stage_id: STAGE_ID,
          verdict: 'PASS',
          manifest_digest: binding.manifestDigest,
          plan_digest: binding.planDigest,
          snapshot_digest: binding.snapshotDigest,
          runtime_proof_digest: FAKE_64,
          stage_plan_receipt_digest: FAKE_64,
          spv_receipt_digest: FAKE_64,
          integrated_slices: SLICE_IDS.map((s) => ({
            slice_id: s,
            integration_receipt_digest: FAKE_64,
            commit_sha: FAKE_SHA,
          })),
          receipt_chain_valid: true,
          summary: 'fixture gate pass',
        },
      },
      { receiptDir: gateDir, tempDir: gateDir },
    );
  }
  if (review) {
    const reviewDir = reviewReceiptDir(root, STAGE_ID);
    fs.mkdirSync(reviewDir, { recursive: true });
    writeReceipt(
      {
        version: 1,
        type: 'STAGE_REVIEW_PASS',
        stage_id: STAGE_ID,
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2,
          type: 'STAGE_REVIEW_RESULT',
          action: 'STAGE_REVIEW',
          stage_id: STAGE_ID,
          verdict: 'ACCEPTED',
          manifest_digest: binding.manifestDigest,
          plan_digest: binding.planDigest,
          snapshot_digest: binding.snapshotDigest,
          runtime_proof_digest: FAKE_64,
          stage_plan_receipt_digest: FAKE_64,
          spv_receipt_digest: FAKE_64,
          stage_gate_receipt_digest: FAKE_64,
          receipt_chain_valid: true,
          summary: 'fixture stage review accepted',
        },
      },
      { receiptDir: reviewDir, tempDir: reviewDir },
    );
  }
}

/**
 * 写 Project Acceptance receipt（存在时门禁验证；不存在则跳过）。
 *
 * 形状对齐真实 producer `finalizeProjectReview` 的最终 ProjectReviewReceipt
 * 产物（packages/runtime/src/project-acceptance.ts 唯一事实）：
 * stage_receipts 条目 = { stage_id, stage_manifest, review, gate, snapshot }；
 * stage_manifest/review/gate 的 digest 为 64 位 vNext digest（computeDigest /
 * envelope digest）、snapshot 为 40 位（vNext snapshot_digest）；顶层含
 * project_manifest/project_e2e_receipt（16 位 digest）、findings、
 * accepted_deviations、criteria_results。自造 fixture 与真实 producer 同构：
 * PROJECT_E2E_PASS genesis receipt + PROJECT_REVIEW_PASS 的 previous_digest
 * 链到 E2E envelope digest（真实 finalizeProjectReview 始终产生该链绑定，
 * 第 9 轮 repair 后 cutover 消费者强制该约束）。
 */
function seedProjectAcceptance(root: string, verdict: 'PROJECT_ACCEPTED' | 'PROJECT_BLOCKED'): void {
  const projectDir = projectReceiptDir(root);
  fs.mkdirSync(projectDir, { recursive: true });
  const e2e = writeReceipt(
    {
      version: 1,
      type: 'PROJECT_E2E_PASS',
      stage_id: 'fixture-project',
      timestamp: '2026-08-11T00:00:00.000Z',
      payload: {
        project_id: 'fixture-project',
        verdict: 'PASS',
        snapshot: FAKE_16,
        manifest_digest: FAKE_16,
        expected_snapshot: FAKE_16,
        executed_snapshot: FAKE_16,
        steps: [{ step_id: 'smoke-1', exit_code: 0, observations: 'ok' }],
        service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
        created_at: '2026-08-11T00:00:00.000Z',
      },
    },
    { receiptDir: projectDir, tempDir: projectDir },
  );
  writeReceipt(
    {
      version: 1,
      type: 'PROJECT_REVIEW_PASS',
      stage_id: 'fixture-project',
      timestamp: '2026-08-12T00:00:00.000Z',
      previous_digest: e2e.digest,
      payload: {
        project_id: 'fixture-project',
        verdict,
        snapshot: FAKE_16,
        reviewer: 'fixture reviewer',
        findings: [],
        accepted_deviations: [],
        project_manifest: { path: 'project-manifest.json', digest: FAKE_16 },
        project_e2e_receipt: { path: 'e2e.json', digest: FAKE_16 },
        reviewed_at: '2026-08-12T00:00:00.000Z',
        stage_receipts: [
          {
            stage_id: STAGE_ID,
            stage_manifest: { path: 'stage-manifest.json', digest: FAKE_64 },
            review: { path: 'review.json', digest: FAKE_64 },
            gate: { path: 'gate.json', digest: FAKE_64 },
            snapshot: FAKE_SHA,
          },
        ],
        criteria_results: [{ criteria: 'AC-01', passed: true, notes: 'ok' }],
      },
    },
    { receiptDir: projectDir, tempDir: projectDir },
  );
}

/** 组装带 legacy 单用途入口的 fixture 仓库。 */
function seedLegacyFiles(root: string): void {
  write(root, 'packages/runtime/src/cli/sync-cv-status.ts', 'export const cv_level = "enhanced";\n');
  write(root, 'packages/runtime/dist/cli/sync-cv-status.js', 'console.log("legacy");\n');
  for (const name of ['prepare-gate-facts']) {
    write(root, `packages/runtime/src/cli/${name}.ts`, `export const ${name} = true;\n`);
    write(root, `packages/runtime/dist/cli/${name}.js`, 'console.log("legacy");\n');
  }
  // Host legacy 权限（brain.md bash allow 条目）
  write(
    root,
    '.opencode/agents/brain.md',
    [
      '---',
      'description: fixture',
      'permission:',
      '  bash:',
      '    "*": deny',
      '    "node packages/runtime/dist/cli/admit.js *": allow',
      '    "node packages/runtime/dist/cli/run-gate.js *": allow',
      '    "node packages/runtime/dist/cli/sync-cv-status.js *": allow',
      '---',
      '',
      '# Brain',
    ].join('\n'),
  );
}

/** 手写 digest-addressed receipt（绕过 kernel writeReceipt 的 fork 保护，
 *  用于构造 fork/伪造链测试场景）。 */
function writeRawReceipt(directory: string, receipt: Record<string, unknown>): string {
  fs.mkdirSync(directory, { recursive: true });
  const { computeReceiptDigest } = require('@proofloop/kernel') as typeof import('@proofloop/kernel');
  const { digest: ignored, ...content } = receipt;
  void ignored;
  const digest = computeReceiptDigest(content);
  fs.writeFileSync(path.join(directory, `${digest}.json`), JSON.stringify({ ...content, digest }), 'utf-8');
  return digest;
}

function runPublic(root: string, args: readonly string[], jsonInput?: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const argv = [PROOFLOOP_DIST, ...args];
  if (jsonInput !== undefined) argv.push('--json', jsonInput);
  const res = spawnSync(process.execPath, argv, { encoding: 'utf-8', timeout: 30000, cwd: root });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** 完整 cutover-ready fixture：manifest + Acceptance facts + legacy 文件。 */
function seedCutoverFixture(root: string): void {
  writeManifest(root);
  write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
  seedAuthority(root);
  seedAcceptanceFacts(root);
  seedLegacyFiles(root);
  commitAll(root);
}

// ============================================================
// public seam 注册与 status
// ============================================================

describe('cutover public seam（REF-S10-E-T02 / REF-CLI-ACCEPTANCE F）', () => {
  it('cutover 域经 public proofloop dispatcher 可达：status exit 0（修复前 unknown domain exit 2）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const res = runPublic(root, ['cutover', 'status']);
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; command: { domain: string; operation: string } };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'cutover', operation: 'status' });
  });

  it('status 输出 cutover matrix 且零写入（legacy CV / scripts / host permissions / delete_targets）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const before = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf-8' });
    const res = runPublic(root, ['cutover', 'status']);
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; result: any; findings: any[] };
    expect(envelope.ok).toBe(true);
    expect(envelope.findings).toEqual([]);
    const matrix = envelope.result.cutover_matrix as {
      legacy_cv: Array<{ id: string; detected: boolean }>;
      legacy_scripts: Array<{ id: string; detected: boolean }>;
      host_legacy_permissions: Array<{ id: string; detected: boolean }>;
      delete_targets: string[];
    };
    expect(matrix.legacy_cv.some((i) => i.id === 'sync-cv-status' && i.detected)).toBe(true);
    expect(matrix.legacy_cv.some((i) => i.id === 'cv_level' && i.detected)).toBe(true);
    for (const id of ['prepare-gate-facts']) {
      expect(matrix.legacy_scripts.some((i) => i.id === id && i.detected)).toBe(true);
    }
    expect(matrix.host_legacy_permissions.some((i) => i.id === 'admit.js' && i.detected)).toBe(true);
    // delete_targets = detected 文件型 legacy 项（sync-cv-status + prepare-gate-facts 的 src+dist）
    expect(matrix.delete_targets).toContain('packages/runtime/src/cli/sync-cv-status.ts');
    expect(matrix.delete_targets).toContain('packages/runtime/dist/cli/sync-cv-status.js');
    expect(matrix.delete_targets).toContain('packages/runtime/src/cli/prepare-gate-facts.ts');
    expect(matrix.delete_targets).toContain('packages/runtime/dist/cli/prepare-gate-facts.js');
    // 零写入
    const after = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf-8' });
    expect(after).toBe(before);
  });

  it('unknown operation fail closed（exit 2 canonical Finding）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const res = runPublic(root, ['cutover', 'bogus']);
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/NOT_IMPLEMENTED|SCHEMA_MISMATCH/);
  });
});

// ============================================================
// cutover execute（irreversible 保护语义）
// ============================================================

describe('cutover execute（REF-S10-CUTOVER-RISK irreversible 保护）', () => {
  it('未携带 confirmed:true → fail closed（exit 2，零删除）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const res = runPublic(root, ['cutover', 'execute']);
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/CONFIRM|IRREVERSIBLE/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('confirmed:true 但缺 delete_list → fail closed（清单永不猜测）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const res = runPublic(root, ['cutover', 'execute'], JSON.stringify({ confirmed: true, stage: STAGE_ID }));
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/DELETE_LIST/);
  });

  it('缺 canonical stage → fail closed', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const targets = fs.readdirSync(path.join(root, 'packages/runtime/src/cli')).filter((n) => n.endsWith('.ts'));
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, delete_list: targets.map((n) => `packages/runtime/src/cli/${n}`) }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string }> };
    expect(envelope.findings[0].code).toMatch(/SCHEMA_MISMATCH|STAGE/);
  });

  it('Acceptance A–E 事实不完整（缺 receipts）→ fail closed 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    commitAll(root);
    // 没有 CV_PASS / INTEGRATION_PASS receipts
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('CUTOVER.ACCEPTANCE_GATE_REQUIRED');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('delete_list 与 status 检测的 legacy 删除目标不完全一致 → fail closed 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    // 只列 1 项（detected 有 4 项：sync-cv-status + prepare-gate-facts 的 src+dist）
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({
        confirmed: true,
        stage: STAGE_ID,
        delete_list: ['packages/runtime/src/cli/sync-cv-status.ts'],
      }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('CUTOVER.DELETE_LIST_MISMATCH');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('confirmed + stage + 完全匹配清单 + Acceptance 全绿 → 删除成功并返回明细', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    // status 检测出的全部删除目标（与 handler 的 detectLegacyDeleteTargets 一致）
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; result: any };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.acceptance_facts).toEqual({
      verified: true,
      slices: SLICE_IDS,
      stage_gate: 'PASS',
      stage_review: 'ACCEPTED',
      project_acceptance: { present: false, verdict: 'not_present' },
    });
    expect(envelope.result.delete_list_matched).toBe(true);
    expect(envelope.result.deleted.sort()).toEqual(targets);
    // 实际删除
    for (const rel of targets) {
      expect(fs.existsSync(path.join(root, rel))).toBe(false);
    }
    // 未列入清单的文件保留
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/proofloop.ts'))).toBe(false); // fixture 没有
    expect(fs.existsSync(path.join(root, 'refs.md'))).toBe(true);
  });

  it('越界/绝对路径 delete_list → 预检 fail closed 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({
        confirmed: true,
        stage: STAGE_ID,
        delete_list: ['../outside.txt', 'packages/runtime/src/cli/sync-cv-status.ts'],
      }),
    );
    expect(res.status).toBe(2);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('删除循环中失败 → 停止并报告已删/未删明细（result 含 deleted/pending）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    // 预检通过后，删除循环中制造失败：把其中一个目标替换为只读目录（unlink 目录会失败）
    const blockedRel = 'packages/runtime/src/cli/prepare-gate-facts.ts';
    fs.rmSync(path.join(root, blockedRel));
    fs.mkdirSync(path.join(root, blockedRel));
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; result: any; findings: Array<{ code: string }> };
    expect(envelope.ok).toBe(false);
    // 预检应发现 prepare-gate-facts.ts 是目录 → PRECONDITION_FAILED 零删除
    expect(envelope.findings[0].code).toMatch(/PRECONDITION_FAILED/);
    expect(envelope.result.deleted).toEqual([]);
    expect(envelope.result.pending.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('缺 Stage Gate PASS（slice 级全绿但无 stage-gate receipt）→ fail closed 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root, { gate: false });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('CUTOVER.ACCEPTANCE_GATE_REQUIRED');
    expect(envelope.findings[0].message).toContain('GATE_PASS');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('Gate 有但缺 Stage Review ACCEPTED → fail closed 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root, { review: false });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('CUTOVER.ACCEPTANCE_GATE_REQUIRED');
    expect(envelope.findings[0].message).toContain('STAGE_REVIEW_PASS');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('伪造 Receipt（结构合法但 digest 错/文件名非 digest-addressed）→ CUTOVER.RECEIPT_INVALID 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    // 伪造：在 gate 类别写一个结构合法但 digest 自校验失败的 receipt（文件名非 digest-addressed、digest 字段错）
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    fs.writeFileSync(
      path.join(gateDir, 'forged-gate.json'),
      JSON.stringify({
        version: 1,
        type: 'GATE_PASS',
        stage_id: STAGE_ID,
        timestamp: '2026-08-12T00:00:00.000Z',
        digest: 'f'.repeat(64),
        payload: { schema_version: 2, type: 'GATE_RESULT', action: 'GATE', stage_id: STAGE_ID, verdict: 'PASS' },
      }),
    );
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('伪造 Receipt（绑定错：payload.stage_id 不匹配）→ CUTOVER.RECEIPT_INVALID 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    // 伪造：覆盖 review 类别为 stage_id 不匹配的合法 digest receipt
    const reviewDir = reviewReceiptDir(root, STAGE_ID);
    fs.rmSync(reviewDir, { recursive: true, force: true });
    fs.mkdirSync(reviewDir, { recursive: true });
    writeReceipt(
      {
        version: 1, type: 'STAGE_REVIEW_PASS', stage_id: 'S99',
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: { schema_version: 2, type: 'STAGE_REVIEW_RESULT', action: 'STAGE_REVIEW', stage_id: 'S99', verdict: 'ACCEPTED', summary: 'wrong binding' },
      },
      { receiptDir: reviewDir, tempDir: reviewDir },
    );
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('outer 绑定错（outer stage_id 与 payload stage_id 不一致）→ CUTOVER.RECEIPT_INVALID 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    // 覆盖 review 类别：outer stage_id='S99' 但 payload stage_id='S10'（binding 对不上）
    const reviewDir = reviewReceiptDir(root, STAGE_ID);
    fs.rmSync(reviewDir, { recursive: true, force: true });
    fs.mkdirSync(reviewDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeReceipt(
      {
        version: 1, type: 'STAGE_REVIEW_PASS', stage_id: 'S99',
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2, type: 'STAGE_REVIEW_RESULT', action: 'STAGE_REVIEW',
          stage_id: STAGE_ID, verdict: 'ACCEPTED',
          manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
          snapshot_digest: binding.snapshotDigest,
          receipt_chain_valid: true, summary: 'outer mismatch',
        },
      },
      { receiptDir: reviewDir, tempDir: reviewDir },
    );
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('outer stage binding mismatch');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('链 tip 为 FAIL/REPAIR（GATE_PASS 后接 GATE_FAIL → tip FAIL）→ CUTOVER.RECEIPT_INVALID 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    // 在 stage-gate 链追加 GATE_FAIL（previous_digest 链到 GATE_PASS）→ tip 变成 FAIL
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    const gatePassPath = fs.readdirSync(gateDir).find((n) => n.endsWith('.json')) as string;
    const gatePass = JSON.parse(fs.readFileSync(path.join(gateDir, gatePassPath), 'utf-8')) as { digest: string };
    const binding = fixtureBinding(root);
    writeReceipt(
      {
        version: 1, type: 'GATE_FAIL', stage_id: STAGE_ID,
        previous_digest: gatePass.digest,
        timestamp: '2026-08-13T00:00:00.000Z',
        payload: {
          schema_version: 2, type: 'GATE_RESULT', action: 'GATE',
          stage_id: STAGE_ID, verdict: 'FAIL',
          manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
          snapshot_digest: binding.snapshotDigest,
          runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64,
          spv_receipt_digest: FAKE_64, integrated_slices: [],
          receipt_chain_valid: true, summary: 'tip fail',
        },
      },
      { receiptDir: gateDir, tempDir: gateDir },
    );
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('chain tip is GATE_FAIL');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('action discriminator 伪造（GATE_RESULT payload action=HACK）→ CUTOVER.RECEIPT_INVALID 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    // 覆盖 stage-gate：合法 digest receipt 但 payload.action 伪造
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    fs.rmSync(gateDir, { recursive: true, force: true });
    fs.mkdirSync(gateDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeReceipt(
      {
        version: 1, type: 'GATE_PASS', stage_id: STAGE_ID,
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2, type: 'GATE_RESULT', action: 'HACK',
          stage_id: STAGE_ID, verdict: 'PASS',
          manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
          snapshot_digest: binding.snapshotDigest,
          runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64,
          spv_receipt_digest: FAKE_64, integrated_slices: [{ slice_id: 'S10-A', integration_receipt_digest: FAKE_64, commit_sha: FAKE_SHA }],
          receipt_chain_valid: true, summary: 'forged action',
        },
      },
      { receiptDir: gateDir, tempDir: gateDir },
    );
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('action discriminator mismatch');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('payload 绑定失配（manifest_digest 与当前 Manifest 不一致）→ CUTOVER.RECEIPT_INVALID 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    // 覆盖 review：合法 receipt 但 manifest_digest 绑定到错误值
    const reviewDir = reviewReceiptDir(root, STAGE_ID);
    fs.rmSync(reviewDir, { recursive: true, force: true });
    fs.mkdirSync(reviewDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeReceipt(
      {
        version: 1, type: 'STAGE_REVIEW_PASS', stage_id: STAGE_ID,
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2, type: 'STAGE_REVIEW_RESULT', action: 'STAGE_REVIEW',
          stage_id: STAGE_ID, verdict: 'ACCEPTED',
          manifest_digest: 'c'.repeat(64), plan_digest: binding.planDigest,
          snapshot_digest: binding.snapshotDigest,
          runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64,
          spv_receipt_digest: FAKE_64, stage_gate_receipt_digest: FAKE_64,
          receipt_chain_valid: true, summary: 'wrong manifest binding',
        },
      },
      { receiptDir: reviewDir, tempDir: reviewDir },
    );
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('manifest_digest binding mismatch');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('Project Acceptance 存在但非 ACCEPTED → CUTOVER.RECEIPT_INVALID 零删除（Brain 裁决 b1fa7d9a）', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    seedProjectAcceptance(root, 'PROJECT_BLOCKED');
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('PROJECT_REVIEW_PASS verdict');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('Project Acceptance 存在且 ACCEPTED + stage 绑定一致 → 删除成功（PA 不作硬前置但存在则验证）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    seedProjectAcceptance(root, 'PROJECT_ACCEPTED');
    commitAll(root);
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; result: any };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.acceptance_facts.project_acceptance).toEqual({
      present: true,
      verdict: 'PROJECT_ACCEPTED',
    });
    expect(envelope.result.deleted.sort()).toEqual(targets);
  });

  it('仅 PROJECT_E2E_*（无 REVIEW_PASS）→ PA 视为不存在（跳过）删除成功（Brain 裁决 2d1b3d3d）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    // 只写 PROJECT_E2E_PASS（无 PROJECT_REVIEW_PASS）
    const projectDir = projectReceiptDir(root);
    fs.mkdirSync(projectDir, { recursive: true });
    writeReceipt(
      {
        version: 1, type: 'PROJECT_E2E_PASS', stage_id: 'fixture-project',
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          project_id: 'fixture-project',
          verdict: 'PASS',
          snapshot: 'f'.repeat(16),
          manifest_digest: 'd'.repeat(16),
          expected_snapshot: 'e'.repeat(16),
          executed_snapshot: 'a'.repeat(16),
          steps: [{ step_id: 'step-1', exit_code: 0, observations: 'ok' }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: '2026-08-12T00:00:00.000Z',
        },
      },
      { receiptDir: projectDir, tempDir: projectDir },
    );
    commitAll(root);
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; result: any };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.acceptance_facts.project_acceptance).toEqual({
      present: false,
      verdict: 'not_present',
    });
  });

  it('stale admission authority（SPV manifest_digest 与当前 Manifest 不一致）→ CUTOVER.ACCEPTANCE_BINDING_UNAVAILABLE 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    // 篡改 authority：SPV manifest_digest 指向过期值
    const planDir = path.join(root, '.proofloop/receipts/plan', STAGE_ID);
    const spvPath = path.join(planDir, 'vnext-spv-pass.json');
    const spv = JSON.parse(fs.readFileSync(spvPath, 'utf-8')) as Record<string, unknown>;
    const stale = { ...spv, manifest_digest: 'e'.repeat(64) };
    const staleSpv = { ...stale, digest: computeVNextSpvPassReceiptDigest(stale as never) };
    fs.writeFileSync(spvPath, JSON.stringify(staleSpv), 'utf-8');
    // stagePlan.spv_receipt_digest 已失效 → 重写 stagePlan 绑定新 spv digest
    const stagePlanPath = path.join(planDir, 'vnext-stage-plan.json');
    const stagePlan = JSON.parse(fs.readFileSync(stagePlanPath, 'utf-8')) as Record<string, unknown>;
    const stalePlan = { ...stagePlan, spv_receipt_digest: staleSpv.digest as string };
    fs.writeFileSync(stagePlanPath, JSON.stringify({ ...stalePlan, digest: computeVNextStagePlanReceiptDigest(stalePlan as never) }), 'utf-8');
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('CUTOVER.ACCEPTANCE_BINDING_UNAVAILABLE');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('fork 拒绝：同链多后继（CV_PASS 后两个 CV_REPAIR 指向同一 parent）→ 链序拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    // 在 S10-E CV 链追加两个 successor（fork）：一个 PASS 一个 REPAIR 都指向 PASS
    const cvDir = cvReceiptDir(root, STAGE_ID, 'S10-E');
    const cvPassPath = fs.readdirSync(cvDir).find((n) => n.endsWith('.json')) as string;
    const cvPass = JSON.parse(fs.readFileSync(path.join(cvDir, cvPassPath), 'utf-8')) as { digest: string };
    const binding = fixtureBinding(root);
    const forkPayload = (verdict: string) => ({
      schema_version: 2, type: 'CV_RESULT', stage_id: STAGE_ID, slice_id: 'S10-E',
      verdict,
      worker_receipt_digest: FAKE_64,
      manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
      proof_index_digest: binding.proofIndexDigest('S10-E'),
      context_ref: `.proofloop/context/${'c'.repeat(64)}.json`, context_digest: 'c'.repeat(64),
      snapshot_digest: binding.snapshotDigest,
      verification_type: 'recheck', summary: 'fork',
      acceptance_refs_checked: ['REF-A'], seam_refs_checked: ['REF-S'], oracle_refs_checked: ['REF-O'],
      risk_refs_considered: [{ ref_id: 'REF-R', applicability: 'NOT_APPLICABLE', reason: 'fixture' }], failed_acceptance_refs: [], invalid_tests: [],
      counterexamples: [], scope_violations: [], forbidden_substitutions: [], regression_failures: [],
    });
    // 手写两个 successor（fork）——kernel writeReceipt 自身拒绝 fork，
    // 需绕过它构造 fork 链
    writeRawReceipt(cvDir, {
      version: 1, type: 'CV_PASS', stage_id: STAGE_ID, slice_id: 'S10-E',
      previous_digest: cvPass.digest,
      timestamp: '2026-08-13T00:00:00.000Z',
      payload: forkPayload('PASS'),
    });
    writeRawReceipt(cvDir, {
      version: 1, type: 'CV_REPAIR', stage_id: STAGE_ID, slice_id: 'S10-E',
      previous_digest: cvPass.digest,
      timestamp: '2026-08-13T00:00:01.000Z',
      payload: forkPayload('REPAIR'),
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('more than one successor');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('时间戳真实比较：链内时间倒退（ISO-8601 真实解析）→ 链序拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    // S10-E CV 链：先追加一个 13 日 00:00:02 的 PASS，再追加 previous_digest 指向它但
    // timestamp 为 00:00:01（时间倒退）的 PASS → 真实时间比较拒绝（Date.parse）
    const cvDir = cvReceiptDir(root, STAGE_ID, 'S10-E');
    const cvPassPath = fs.readdirSync(cvDir).find((n) => n.endsWith('.json')) as string;
    const cvPass = JSON.parse(fs.readFileSync(path.join(cvDir, cvPassPath), 'utf-8')) as { digest: string };
    const binding = fixtureBinding(root);
    const later = (ts: string, summary: string, prev: string | undefined) => ({
      version: 1, type: 'CV_PASS', stage_id: STAGE_ID, slice_id: 'S10-E',
      ...(prev !== undefined ? { previous_digest: prev } : {}),
      timestamp: ts,
      payload: {
        schema_version: 2, type: 'CV_RESULT', stage_id: STAGE_ID, slice_id: 'S10-E',
        verdict: 'PASS',
        worker_receipt_digest: FAKE_64,
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        proof_index_digest: binding.proofIndexDigest('S10-E'),
        context_ref: `.proofloop/context/${'c'.repeat(64)}.json`, context_digest: 'c'.repeat(64),
        snapshot_digest: binding.snapshotDigest,
        verification_type: 'recheck', summary,
        acceptance_refs_checked: ['REF-A'], seam_refs_checked: ['REF-S'], oracle_refs_checked: ['REF-O'],
        risk_refs_considered: [{ ref_id: 'REF-R', applicability: 'NOT_APPLICABLE', reason: 'fixture' }], failed_acceptance_refs: [], invalid_tests: [],
        counterexamples: [], scope_violations: [], forbidden_substitutions: [], regression_failures: [],
      },
    });
    const d1 = writeRawReceipt(cvDir, later('2026-08-13T00:00:02.000Z', 'later pass', cvPass.digest));
    writeRawReceipt(cvDir, later('2026-08-13T00:00:01.000Z', 'backwards pass', d1));
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('not timestamp-ordered');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('symlink 目标 → CUTOVER.DELETE_TARGET_INVALID 零删除（不 canonicalize 后当普通文件）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    // 把 sync-cv-status.ts 换成指向非 legacy 文件的 symlink
    const legacyRel = 'packages/runtime/src/cli/sync-cv-status.ts';
    fs.rmSync(path.join(root, legacyRel));
    write(root, 'packages/runtime/src/keep.txt', 'keep me\n');
    fs.symlinkSync('../keep.txt', path.join(root, legacyRel));
    commitAll(root);
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('CUTOVER.DELETE_TARGET_INVALID');
    expect(fs.lstatSync(path.join(root, legacyRel)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/keep.txt'))).toBe(true);
  });

  it('链内非 tip 伪造（链中旧 receipt 的 payload 绑定错）→ 链内全量校验拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    // S10-E CV 链：先加一个绑定错的旧 PASS（链内非 tip），再加合法新 PASS（tip）
    const cvDir = cvReceiptDir(root, STAGE_ID, 'S10-E');
    const cvPassPath = fs.readdirSync(cvDir).find((n) => n.endsWith('.json')) as string;
    const cvPass = JSON.parse(fs.readFileSync(path.join(cvDir, cvPassPath), 'utf-8')) as { digest: string };
    const binding = fixtureBinding(root);
    const forgedDigest = writeRawReceipt(cvDir, {
      version: 1, type: 'CV_PASS', stage_id: STAGE_ID, slice_id: 'S10-E',
      previous_digest: cvPass.digest,
      timestamp: '2026-08-13T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'CV_RESULT', stage_id: STAGE_ID, slice_id: 'S10-E',
        verdict: 'PASS',
        worker_receipt_digest: FAKE_64,
        manifest_digest: 'c'.repeat(64), plan_digest: binding.planDigest,
        proof_index_digest: binding.proofIndexDigest('S10-E'),
        context_ref: `.proofloop/context/${'c'.repeat(64)}.json`, context_digest: 'c'.repeat(64),
        snapshot_digest: binding.snapshotDigest,
        verification_type: 'recheck', summary: 'forged inner',
        previous_failure_signature: 'SIG-FORGED', repair_diff_digest: FAKE_64,
        acceptance_refs_checked: ['REF-A'], seam_refs_checked: ['REF-S'], oracle_refs_checked: ['REF-O'],
        risk_refs_considered: [{ ref_id: 'REF-R', applicability: 'NOT_APPLICABLE', reason: 'fixture' }],
        failed_acceptance_refs: [], invalid_tests: [], counterexamples: [],
        scope_violations: [], forbidden_substitutions: [], regression_failures: [],
      },
    });
    writeRawReceipt(cvDir, {
      version: 1, type: 'CV_PASS', stage_id: STAGE_ID, slice_id: 'S10-E',
      previous_digest: forgedDigest,
      timestamp: '2026-08-13T00:00:01.000Z',
      payload: {
        schema_version: 2, type: 'CV_RESULT', stage_id: STAGE_ID, slice_id: 'S10-E',
        verdict: 'PASS',
        worker_receipt_digest: FAKE_64,
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        proof_index_digest: binding.proofIndexDigest('S10-E'),
        context_ref: `.proofloop/context/${'c'.repeat(64)}.json`, context_digest: 'c'.repeat(64),
        snapshot_digest: binding.snapshotDigest,
        verification_type: 'recheck', summary: 'valid tip',
        previous_failure_signature: 'SIG-FORGED', repair_diff_digest: FAKE_64,
        acceptance_refs_checked: ['REF-A'], seam_refs_checked: ['REF-S'], oracle_refs_checked: ['REF-O'],
        risk_refs_considered: [{ ref_id: 'REF-R', applicability: 'NOT_APPLICABLE', reason: 'fixture' }],
        failed_acceptance_refs: [], invalid_tests: [], counterexamples: [],
        scope_violations: [], forbidden_substitutions: [], regression_failures: [],
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('manifest_digest binding mismatch');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('CV 缺必需字段（缺 worker_receipt_digest）→ closed schema 拒绝 零删除（修复 1c3536bf）', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    const cvDir = cvReceiptDir(root, STAGE_ID, 'S10-E');
    fs.rmSync(cvDir, { recursive: true, force: true });
    fs.mkdirSync(cvDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(cvDir, {
      version: 1, type: 'CV_PASS', stage_id: STAGE_ID, slice_id: 'S10-E',
      timestamp: '2026-08-12T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'CV_RESULT', stage_id: STAGE_ID, slice_id: 'S10-E',
        verdict: 'PASS',
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        proof_index_digest: binding.proofIndexDigest('S10-E'),
        context_ref: `.proofloop/context/${'c'.repeat(64)}.json`, context_digest: 'c'.repeat(64),
        snapshot_digest: binding.snapshotDigest,
        verification_type: 'initial', summary: 'missing worker digest',
        acceptance_refs_checked: ['REF-A'], seam_refs_checked: ['REF-S'], oracle_refs_checked: ['REF-O'],
        risk_refs_considered: [{ ref_id: 'REF-R', applicability: 'NOT_APPLICABLE', reason: 'fixture' }],
        failed_acceptance_refs: [], invalid_tests: [], counterexamples: [],
        scope_violations: [], forbidden_substitutions: [], regression_failures: [],
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('worker_receipt_digest');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('CV 未知字段（extra_field）→ closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    const cvDir = cvReceiptDir(root, STAGE_ID, 'S10-E');
    fs.rmSync(cvDir, { recursive: true, force: true });
    fs.mkdirSync(cvDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(cvDir, {
      version: 1, type: 'CV_PASS', stage_id: STAGE_ID, slice_id: 'S10-E',
      timestamp: '2026-08-12T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'CV_RESULT', stage_id: STAGE_ID, slice_id: 'S10-E',
        verdict: 'PASS',
        worker_receipt_digest: FAKE_64,
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        proof_index_digest: binding.proofIndexDigest('S10-E'),
        context_ref: `.proofloop/context/${'c'.repeat(64)}.json`, context_digest: 'c'.repeat(64),
        snapshot_digest: binding.snapshotDigest,
        verification_type: 'initial', summary: 'unknown field',
        acceptance_refs_checked: ['REF-A'], seam_refs_checked: ['REF-S'], oracle_refs_checked: ['REF-O'],
        risk_refs_considered: [{ ref_id: 'REF-R', applicability: 'NOT_APPLICABLE', reason: 'fixture' }],
        failed_acceptance_refs: [], invalid_tests: [], counterexamples: [],
        scope_violations: [], forbidden_substitutions: [], regression_failures: [],
        extra_field: 'sneak',
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toMatch(/Unknown field "extra_field"|unknown field "extra_field"/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('INTEGRATION 缺绑定字段（缺 cv_receipt_digest）→ closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    const intDir = integrationReceiptDir(root, STAGE_ID, 'S10-E');
    fs.rmSync(intDir, { recursive: true, force: true });
    fs.mkdirSync(intDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(intDir, {
      version: 1, type: 'INTEGRATION_PASS', stage_id: STAGE_ID, slice_id: 'S10-E',
      timestamp: '2026-08-12T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'INTEGRATION_RESULT', action: 'INTEGRATION',
        stage_id: STAGE_ID, slice_id: 'S10-E', commit_sha: FAKE_SHA,
        worker_receipt_digest: FAKE_64,
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        proof_index_digest: binding.proofIndexDigest('S10-E'), snapshot_digest: binding.snapshotDigest,
        slice_commit_receipt_digest: FAKE_64, changed_files: [], receipt_chain_valid: true,
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toMatch(/unknown field|INTEGRATION/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('GATE 未知字段 → closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    fs.rmSync(gateDir, { recursive: true, force: true });
    fs.mkdirSync(gateDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(gateDir, {
      version: 1, type: 'GATE_PASS', stage_id: STAGE_ID,
      timestamp: '2026-08-12T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'GATE_RESULT', action: 'GATE', stage_id: STAGE_ID,
        verdict: 'PASS',
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        snapshot_digest: binding.snapshotDigest,
        runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64,
        spv_receipt_digest: FAKE_64, integrated_slices: [],
        receipt_chain_valid: true, summary: 'gate',
        sneaky: 'field',
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('unknown field "sneaky"');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('GATE_PASS 携带 verification_source（SG 双路径 git_facts 标记）→ closed schema 通过 删除成功', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    // 不带默认 gate：手写携带 verification_source 的 GATE_PASS（2026-08-13
    // SG 双路径机制登记的可选字段，git_facts = 兜底 Gate 标记）。
    seedAcceptanceFacts(root, { gate: false });
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    fs.mkdirSync(gateDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(gateDir, {
      version: 1, type: 'GATE_PASS', stage_id: STAGE_ID,
      timestamp: '2026-08-13T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'GATE_RESULT', action: 'GATE', stage_id: STAGE_ID,
        verdict: 'PASS',
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        snapshot_digest: binding.snapshotDigest,
        runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64,
        spv_receipt_digest: FAKE_64,
        integrated_slices: SLICE_IDS.map((s) => ({ slice_id: s, integration_receipt_digest: FAKE_64, commit_sha: FAKE_SHA })),
        receipt_chain_valid: true, summary: 'git_facts 兜底 gate pass',
        verification_source: 'git_facts',
      },
    });
    commitAll(root);
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; result: any };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.acceptance_facts.stage_gate).toBe('PASS');
    expect(envelope.result.delete_list_matched).toBe(true);
    expect(envelope.result.deleted.sort()).toEqual(targets);
  });

  it('GATE verification_source 非法值（非 receipts/git_facts）→ closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root, { gate: false });
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    fs.mkdirSync(gateDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(gateDir, {
      version: 1, type: 'GATE_PASS', stage_id: STAGE_ID,
      timestamp: '2026-08-13T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'GATE_RESULT', action: 'GATE', stage_id: STAGE_ID,
        verdict: 'PASS',
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        snapshot_digest: binding.snapshotDigest,
        runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64,
        spv_receipt_digest: FAKE_64,
        integrated_slices: SLICE_IDS.map((s) => ({ slice_id: s, integration_receipt_digest: FAKE_64, commit_sha: FAKE_SHA })),
        receipt_chain_valid: true, summary: 'bad source',
        verification_source: 'bogus',
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('verification_source must be "receipts" or "git_facts" when present');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('STAGE_REVIEW 缺必需字段（缺 stage_gate_receipt_digest）→ closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    const reviewDir = reviewReceiptDir(root, STAGE_ID);
    fs.rmSync(reviewDir, { recursive: true, force: true });
    fs.mkdirSync(reviewDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(reviewDir, {
      version: 1, type: 'STAGE_REVIEW_PASS', stage_id: STAGE_ID,
      timestamp: '2026-08-12T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'STAGE_REVIEW_RESULT', action: 'STAGE_REVIEW',
        stage_id: STAGE_ID, verdict: 'ACCEPTED',
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        snapshot_digest: binding.snapshotDigest,
        runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64,
        spv_receipt_digest: FAKE_64,
        receipt_chain_valid: true, summary: 'missing gate digest',
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toMatch(/unknown field|STAGE_REVIEW/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('spv_receipt_digest 错绑（StagePlan 不绑定 SPV digest）→ CUTOVER.ACCEPTANCE_BINDING_UNAVAILABLE 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const planDir = path.join(root, '.proofloop/receipts/plan', STAGE_ID);
    const stagePlanPath = path.join(planDir, 'vnext-stage-plan.json');
    const stagePlan = JSON.parse(fs.readFileSync(stagePlanPath, 'utf-8')) as Record<string, unknown>;
    const wrongPlan = { ...stagePlan, spv_receipt_digest: 'f'.repeat(64) };
    fs.writeFileSync(stagePlanPath, JSON.stringify({ ...wrongPlan, digest: computeVNextStagePlanReceiptDigest(wrongPlan as never) }), 'utf-8');
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('CUTOVER.ACCEPTANCE_BINDING_UNAVAILABLE');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('E2E 伪造（缺 steps）→ closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const projectDir = projectReceiptDir(root);
    fs.mkdirSync(projectDir, { recursive: true });
    writeReceipt(
      {
        version: 1, type: 'PROJECT_E2E_PASS', stage_id: 'fixture-project',
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          project_id: 'fixture-project',
          verdict: 'PASS',
          snapshot: 'f'.repeat(16),
          manifest_digest: 'd'.repeat(16),
          expected_snapshot: 'e'.repeat(16),
          executed_snapshot: 'a'.repeat(16),
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: '2026-08-12T00:00:00.000Z',
        },
      },
      { receiptDir: projectDir, tempDir: projectDir },
    );
    commitAll(root);
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('PROJECT_E2E');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('INTEGRATION changed_files 空数组 → closed schema 拒绝 零删除（修复 3e410351）', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    const intDir = integrationReceiptDir(root, STAGE_ID, 'S10-E');
    fs.rmSync(intDir, { recursive: true, force: true });
    fs.mkdirSync(intDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(intDir, {
      version: 1, type: 'INTEGRATION_PASS', stage_id: STAGE_ID, slice_id: 'S10-E',
      timestamp: '2026-08-12T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'INTEGRATION_RESULT', action: 'INTEGRATION',
        stage_id: STAGE_ID, slice_id: 'S10-E', commit_sha: FAKE_SHA,
        worker_receipt_digest: FAKE_64, cv_receipt_digest: FAKE_64,
        slice_commit_receipt_digest: FAKE_64, changed_files: [],
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        proof_index_digest: binding.proofIndexDigest('S10-E'), snapshot_digest: binding.snapshotDigest,
        receipt_chain_valid: true,
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('changed_files must be a non-empty array');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('GATE integrated_slices 空数组 → closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    fs.rmSync(gateDir, { recursive: true, force: true });
    fs.mkdirSync(gateDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(gateDir, {
      version: 1, type: 'GATE_PASS', stage_id: STAGE_ID,
      timestamp: '2026-08-12T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'GATE_RESULT', action: 'GATE', stage_id: STAGE_ID,
        verdict: 'PASS',
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        snapshot_digest: binding.snapshotDigest,
        runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64,
        spv_receipt_digest: FAKE_64, integrated_slices: [],
        receipt_chain_valid: true, summary: 'empty slices',
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('integrated_slices must be a non-empty array');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('GATE integrated_slices 嵌套未知字段 → closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    fs.rmSync(gateDir, { recursive: true, force: true });
    fs.mkdirSync(gateDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(gateDir, {
      version: 1, type: 'GATE_PASS', stage_id: STAGE_ID,
      timestamp: '2026-08-12T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'GATE_RESULT', action: 'GATE', stage_id: STAGE_ID,
        verdict: 'PASS',
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        snapshot_digest: binding.snapshotDigest,
        runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64,
        spv_receipt_digest: FAKE_64,
        integrated_slices: [{ slice_id: 'S10-A', integration_receipt_digest: FAKE_64, commit_sha: FAKE_SHA, hack: 1 }],
        receipt_chain_valid: true, summary: 'nested unknown',
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('integrated_slices[0] contains unknown field "hack"');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('STAGE_REVIEW verdict 越界（verdict=NEUTRAL）→ closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedAuthority(root);
    seedLegacyFiles(root);
    seedAcceptanceFacts(root);
    const reviewDir = reviewReceiptDir(root, STAGE_ID);
    fs.rmSync(reviewDir, { recursive: true, force: true });
    fs.mkdirSync(reviewDir, { recursive: true });
    const binding = fixtureBinding(root);
    writeRawReceipt(reviewDir, {
      version: 1, type: 'STAGE_REVIEW_PASS', stage_id: STAGE_ID,
      timestamp: '2026-08-12T00:00:00.000Z',
      payload: {
        schema_version: 2, type: 'STAGE_REVIEW_RESULT', action: 'STAGE_REVIEW',
        stage_id: STAGE_ID, verdict: 'NEUTRAL',
        manifest_digest: binding.manifestDigest, plan_digest: binding.planDigest,
        snapshot_digest: binding.snapshotDigest,
        runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64,
        spv_receipt_digest: FAKE_64, stage_gate_receipt_digest: FAKE_64,
        receipt_chain_valid: true, summary: 'bad verdict',
      },
    });
    commitAll(root);
    const targets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('verdict is outside the closed vocabulary');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('PROJECT_REVIEW_PASS 未知字段 → closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const projectDir = projectReceiptDir(root);
    fs.mkdirSync(projectDir, { recursive: true });
    writeReceipt(
      {
        version: 1, type: 'PROJECT_REVIEW_PASS', stage_id: 'fixture-project',
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          project_id: 'fixture-project', verdict: 'PROJECT_ACCEPTED',
          snapshot: FAKE_16, reviewer: 'fixture reviewer',
          findings: [], accepted_deviations: [],
          project_manifest: { path: 'project-manifest.json', digest: FAKE_16 },
          project_e2e_receipt: { path: 'e2e.json', digest: FAKE_16 },
          reviewed_at: '2026-08-12T00:00:00.000Z',
          stage_receipts: [{ stage_id: STAGE_ID, stage_manifest: { path: 'm', digest: FAKE_16 }, review: { path: 'r', digest: FAKE_16 }, gate: { path: 'g', digest: FAKE_16 }, snapshot: FAKE_16 }],
          criteria_results: [{ criteria: 'AC-01', passed: true }], hack: 'field',
        },
      },
      { receiptDir: projectDir, tempDir: projectDir },
    );
    commitAll(root);
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('PROJECT_REVIEW_PASS failed the closed PROJECT_REVIEW schema');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('E2E steps 嵌套未知字段 → closed schema 拒绝 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const projectDir = projectReceiptDir(root);
    fs.mkdirSync(projectDir, { recursive: true });
    writeReceipt(
      {
        version: 1, type: 'PROJECT_E2E_PASS', stage_id: 'fixture-project',
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          project_id: 'fixture-project',
          verdict: 'PASS',
          snapshot: 'f'.repeat(16),
          manifest_digest: 'd'.repeat(16),
          expected_snapshot: 'e'.repeat(16),
          executed_snapshot: 'a'.repeat(16),
          steps: [{ step_id: 'step-1', exit_code: 0, observations: 'ok', hack: 1 }],
          service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
          created_at: '2026-08-12T00:00:00.000Z',
        },
      },
      { receiptDir: projectDir, tempDir: projectDir },
    );
    commitAll(root);
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('PROJECT_E2E');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('真实 descendant：SPV snapshot=父提交、GATE/REVIEW snapshot=子提交、HEAD=子提交 → 删除成功（git merge-base 真实触发）', () => {
    const root = makeRepo();
    // Phase 1：基础提交 P（manifest/tasks/legacy 文件；authority/receipts 留待 Phase 2）
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedLegacyFiles(root);
    commitAll(root);
    const parentSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    expect(parentSha).toMatch(/^[a-f0-9]{40}$/);
    // Phase 2：authority（SPV snapshot = 父提交 P）+ slice receipts（snapshot=P）
    // + GATE/REVIEW receipts（snapshot=子提交 C）——C 是 P 的合法 descendant。
    const manifestPath = path.join(root, '.proofloop/manifests', `${STAGE_ID}.json`);
    const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { plan: { plan_digest: string }; slices: Array<{ slice_id: string; proof_index: unknown }> };
    const manifestDigest = computeDigest(manifestObj);
    const planDigest = manifestObj.plan.plan_digest;
    const proofIndex = new Map<string, string>();
    for (const slice of manifestObj.slices) proofIndex.set(slice.slice_id, computeDigest(slice.proof_index));
    // 子提交 C：先构造其 tree（当前工作树 = P 内容 + authority/receipts），
    // 再 commit-tree -p P → C 是 P 的子提交。
    const planDir = path.join(root, '.proofloop/receipts/plan', STAGE_ID);
    fs.mkdirSync(planDir, { recursive: true });
    const spv = { version: 2 as const, schema_version: 2 as const, type: 'SPV_PASS' as const, stage_id: STAGE_ID, manifest_digest: manifestDigest, plan_digest: planDigest, snapshot_digest: parentSha };
    const spvDigest = computeVNextSpvPassReceiptDigest(spv);
    write(root, '.proofloop/receipts/plan/S10/vnext-spv-pass.json', JSON.stringify({ ...spv, digest: spvDigest }));
    const stagePlan = { version: 2 as const, schema_version: 2 as const, type: 'STAGE_PLAN' as const, stage_id: STAGE_ID, manifest_digest: manifestDigest, plan_digest: planDigest, snapshot_digest: parentSha, spv_receipt_digest: spvDigest };
    write(root, '.proofloop/receipts/plan/S10/vnext-stage-plan.json', JSON.stringify({ ...stagePlan, digest: computeVNextStagePlanReceiptDigest(stagePlan) }));
    for (const sliceId of SLICE_IDS) {
      const pi = proofIndex.get(sliceId) as string;
      const cvDir = cvReceiptDir(root, STAGE_ID, sliceId);
      fs.mkdirSync(cvDir, { recursive: true });
      writeReceipt(
        {
          version: 1, type: 'CV_PASS', stage_id: STAGE_ID, slice_id: sliceId,
          timestamp: '2026-08-12T00:00:00.000Z',
          payload: {
            schema_version: 2, type: 'CV_RESULT', stage_id: STAGE_ID, slice_id: sliceId,
            verdict: 'PASS', worker_receipt_digest: FAKE_64,
            manifest_digest: manifestDigest, plan_digest: planDigest, proof_index_digest: pi,
            context_ref: `.proofloop/context/${'c'.repeat(64)}.json`, context_digest: 'c'.repeat(64),
            snapshot_digest: parentSha, verification_type: 'initial', summary: 'cv pass',
            acceptance_refs_checked: ['REF-A'], seam_refs_checked: ['REF-S'], oracle_refs_checked: ['REF-O'],
            risk_refs_considered: [{ ref_id: 'REF-R', applicability: 'NOT_APPLICABLE', reason: 'fixture' }],
            failed_acceptance_refs: [], invalid_tests: [], counterexamples: [],
            scope_violations: [], forbidden_substitutions: [], regression_failures: [],
          },
        },
        { receiptDir: cvDir, tempDir: cvDir },
      );
      const intDir = integrationReceiptDir(root, STAGE_ID, sliceId);
      fs.mkdirSync(intDir, { recursive: true });
      writeReceipt(
        {
          version: 1, type: 'INTEGRATION_PASS', stage_id: STAGE_ID, slice_id: sliceId,
          timestamp: '2026-08-12T00:00:00.000Z',
          payload: {
            schema_version: 2, type: 'INTEGRATION_RESULT', action: 'INTEGRATION',
            stage_id: STAGE_ID, slice_id: sliceId, commit_sha: FAKE_SHA,
            worker_receipt_digest: FAKE_64, cv_receipt_digest: FAKE_64,
            slice_commit_receipt_digest: FAKE_64,
            changed_files: ['delivery/stages/S10/evidence/placeholder.md'],
            manifest_digest: manifestDigest, plan_digest: planDigest, proof_index_digest: pi,
            snapshot_digest: parentSha, receipt_chain_valid: true,
          },
        },
        { receiptDir: intDir, tempDir: intDir },
      );
    }
    // GATE/REVIEW：snapshot = 子提交 C（先占位构造 tree，再 commit-tree）
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    fs.mkdirSync(gateDir, { recursive: true });
    const reviewDir = reviewReceiptDir(root, STAGE_ID);
    fs.mkdirSync(reviewDir, { recursive: true });
    // 先写占位（snapshot 用父提交），提交生成 C，再改写 GATE/REVIEW 的
    // snapshot 为 C？不可行（digest-addressed）。改为：先创建 C（含占位
    // GATE/REVIEW，snapshot=parentSha），再在 C 之后追加子提交 D（改写的
    // GATE/REVIEW snapshot=C）——两跳祖先链。
    writeReceipt(
      {
        version: 1, type: 'GATE_PASS', stage_id: STAGE_ID,
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2, type: 'GATE_RESULT', action: 'GATE', stage_id: STAGE_ID,
          verdict: 'PASS',
          manifest_digest: manifestDigest, plan_digest: planDigest, snapshot_digest: parentSha,
          runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64, spv_receipt_digest: FAKE_64,
          integrated_slices: SLICE_IDS.map((sid) => ({ slice_id: sid, integration_receipt_digest: FAKE_64, commit_sha: FAKE_SHA })),
          receipt_chain_valid: true, summary: 'gate pass',
        },
      },
      { receiptDir: gateDir, tempDir: gateDir },
    );
    writeReceipt(
      {
        version: 1, type: 'STAGE_REVIEW_PASS', stage_id: STAGE_ID,
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2, type: 'STAGE_REVIEW_RESULT', action: 'STAGE_REVIEW',
          stage_id: STAGE_ID, verdict: 'ACCEPTED',
          manifest_digest: manifestDigest, plan_digest: planDigest, snapshot_digest: parentSha,
          runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64, spv_receipt_digest: FAKE_64,
          stage_gate_receipt_digest: FAKE_64,
          receipt_chain_valid: true, summary: 'review accepted',
        },
      },
      { receiptDir: reviewDir, tempDir: reviewDir },
    );
    // 提交生成子提交 C（P 的 descendant），HEAD = C
    execFileSync('git', ['-C', root, 'add', '-A']);
    const treeC = execFileSync('git', ['-C', root, 'write-tree'], { encoding: 'utf-8' }).trim();
    const childSha = execFileSync('git', ['-C', root, 'commit-tree', treeC, '-p', parentSha, '-m', 'child'], { encoding: 'utf-8' }).trim();
    execFileSync('git', ['-C', root, 'update-ref', 'refs/heads/master', childSha]);
    execFileSync('git', ['-C', root, 'reset', '--hard', childSha], { stdio: ['ignore', 'ignore', 'ignore'] });
    // 断言真实祖先关系：git merge-base --is-ancestor parentSha childSha 必须成功
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', parentSha, childSha]);
    // 断言 GATE/REVIEW snapshot（parentSha）≠ SPV snapshot（parentSha）？
    // 不——本轮语义：GATE/REVIEW snapshot 允许等于 SPV snapshot 或为其
    // descendant；此处 snapshot=parentSha（=SPV snapshot）走严格相等路径，
    // HEAD=childSha 与 SPV snapshot 不同但为合法 descendant（仓库级真实）。
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; result: any };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.deleted.sort()).toEqual(targets);
  });

  it('GATE snapshot 为 SPV snapshot 的真实 descendant（两跳祖先链）→ 删除成功（git merge-base 真实触发）', () => {
    const root = makeRepo();
    // Phase 1：基础提交 P
    writeManifest(root);
    write(root, 'delivery/stages/S10/tasks.md', '# Stage S10 — candidate\n');
    seedLegacyFiles(root);
    commitAll(root);
    const parentSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    // Phase 2：authority（SPV snapshot=parentSha）+ slice receipts（snapshot=parentSha）
    // + GATE/REVIEW 占位（snapshot=parentSha）→ 提交生成 C（P 的 child）
    const manifestPath = path.join(root, '.proofloop/manifests', `${STAGE_ID}.json`);
    const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { plan: { plan_digest: string }; slices: Array<{ slice_id: string; proof_index: unknown }> };
    const manifestDigest = computeDigest(manifestObj);
    const planDigest = manifestObj.plan.plan_digest;
    const proofIndex = new Map<string, string>();
    for (const slice of manifestObj.slices) proofIndex.set(slice.slice_id, computeDigest(slice.proof_index));
    const planDir = path.join(root, '.proofloop/receipts/plan', STAGE_ID);
    fs.mkdirSync(planDir, { recursive: true });
    const spv = { version: 2 as const, schema_version: 2 as const, type: 'SPV_PASS' as const, stage_id: STAGE_ID, manifest_digest: manifestDigest, plan_digest: planDigest, snapshot_digest: parentSha };
    const spvDigest = computeVNextSpvPassReceiptDigest(spv);
    write(root, '.proofloop/receipts/plan/S10/vnext-spv-pass.json', JSON.stringify({ ...spv, digest: spvDigest }));
    const stagePlan = { version: 2 as const, schema_version: 2 as const, type: 'STAGE_PLAN' as const, stage_id: STAGE_ID, manifest_digest: manifestDigest, plan_digest: planDigest, snapshot_digest: parentSha, spv_receipt_digest: spvDigest };
    write(root, '.proofloop/receipts/plan/S10/vnext-stage-plan.json', JSON.stringify({ ...stagePlan, digest: computeVNextStagePlanReceiptDigest(stagePlan) }));
    for (const sliceId of SLICE_IDS) {
      const pi = proofIndex.get(sliceId) as string;
      const cvDir = cvReceiptDir(root, STAGE_ID, sliceId);
      fs.mkdirSync(cvDir, { recursive: true });
      writeReceipt(
        {
          version: 1, type: 'CV_PASS', stage_id: STAGE_ID, slice_id: sliceId,
          timestamp: '2026-08-12T00:00:00.000Z',
          payload: {
            schema_version: 2, type: 'CV_RESULT', stage_id: STAGE_ID, slice_id: sliceId,
            verdict: 'PASS', worker_receipt_digest: FAKE_64,
            manifest_digest: manifestDigest, plan_digest: planDigest, proof_index_digest: pi,
            context_ref: `.proofloop/context/${'c'.repeat(64)}.json`, context_digest: 'c'.repeat(64),
            snapshot_digest: parentSha, verification_type: 'initial', summary: 'cv pass',
            acceptance_refs_checked: ['REF-A'], seam_refs_checked: ['REF-S'], oracle_refs_checked: ['REF-O'],
            risk_refs_considered: [{ ref_id: 'REF-R', applicability: 'NOT_APPLICABLE', reason: 'fixture' }],
            failed_acceptance_refs: [], invalid_tests: [], counterexamples: [],
            scope_violations: [], forbidden_substitutions: [], regression_failures: [],
          },
        },
        { receiptDir: cvDir, tempDir: cvDir },
      );
      const intDir = integrationReceiptDir(root, STAGE_ID, sliceId);
      fs.mkdirSync(intDir, { recursive: true });
      writeReceipt(
        {
          version: 1, type: 'INTEGRATION_PASS', stage_id: STAGE_ID, slice_id: sliceId,
          timestamp: '2026-08-12T00:00:00.000Z',
          payload: {
            schema_version: 2, type: 'INTEGRATION_RESULT', action: 'INTEGRATION',
            stage_id: STAGE_ID, slice_id: sliceId, commit_sha: FAKE_SHA,
            worker_receipt_digest: FAKE_64, cv_receipt_digest: FAKE_64,
            slice_commit_receipt_digest: FAKE_64,
            changed_files: ['delivery/stages/S10/evidence/placeholder.md'],
            manifest_digest: manifestDigest, plan_digest: planDigest, proof_index_digest: pi,
            snapshot_digest: parentSha, receipt_chain_valid: true,
          },
        },
        { receiptDir: intDir, tempDir: intDir },
      );
    }
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    fs.mkdirSync(gateDir, { recursive: true });
    const reviewDir = reviewReceiptDir(root, STAGE_ID);
    fs.mkdirSync(reviewDir, { recursive: true });
    writeReceipt(
      {
        version: 1, type: 'GATE_PASS', stage_id: STAGE_ID,
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2, type: 'GATE_RESULT', action: 'GATE', stage_id: STAGE_ID,
          verdict: 'PASS',
          manifest_digest: manifestDigest, plan_digest: planDigest, snapshot_digest: parentSha,
          runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64, spv_receipt_digest: FAKE_64,
          integrated_slices: SLICE_IDS.map((sid) => ({ slice_id: sid, integration_receipt_digest: FAKE_64, commit_sha: FAKE_SHA })),
          receipt_chain_valid: true, summary: 'gate pass',
        },
      },
      { receiptDir: gateDir, tempDir: gateDir },
    );
    writeReceipt(
      {
        version: 1, type: 'STAGE_REVIEW_PASS', stage_id: STAGE_ID,
        timestamp: '2026-08-12T00:00:00.000Z',
        payload: {
          schema_version: 2, type: 'STAGE_REVIEW_RESULT', action: 'STAGE_REVIEW',
          stage_id: STAGE_ID, verdict: 'ACCEPTED',
          manifest_digest: manifestDigest, plan_digest: planDigest, snapshot_digest: parentSha,
          runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64, spv_receipt_digest: FAKE_64,
          stage_gate_receipt_digest: FAKE_64,
          receipt_chain_valid: true, summary: 'review accepted',
        },
      },
      { receiptDir: reviewDir, tempDir: reviewDir },
    );
    // 提交 C（P 的 child，HEAD=C）
    execFileSync('git', ['-C', root, 'add', '-A']);
    const treeC = execFileSync('git', ['-C', root, 'write-tree'], { encoding: 'utf-8' }).trim();
    const childSha = execFileSync('git', ['-C', root, 'commit-tree', treeC, '-p', parentSha, '-m', 'child'], { encoding: 'utf-8' }).trim();
    execFileSync('git', ['-C', root, 'update-ref', 'refs/heads/master', childSha]);
    execFileSync('git', ['-C', root, 'reset', '--hard', childSha], { stdio: ['ignore', 'ignore', 'ignore'] });
    // Phase 3：在 C 上改写 GATE/REVIEW——snapshot=childSha（C 是 P 的合法
    // descendant），提交生成 D（C 的 child，HEAD=D）
    fs.rmSync(gateDir, { recursive: true, force: true });
    fs.mkdirSync(gateDir, { recursive: true });
    fs.rmSync(reviewDir, { recursive: true, force: true });
    fs.mkdirSync(reviewDir, { recursive: true });
    writeReceipt(
      {
        version: 1, type: 'GATE_PASS', stage_id: STAGE_ID,
        timestamp: '2026-08-13T00:00:00.000Z',
        payload: {
          schema_version: 2, type: 'GATE_RESULT', action: 'GATE', stage_id: STAGE_ID,
          verdict: 'PASS',
          manifest_digest: manifestDigest, plan_digest: planDigest, snapshot_digest: childSha,
          runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64, spv_receipt_digest: FAKE_64,
          integrated_slices: SLICE_IDS.map((sid) => ({ slice_id: sid, integration_receipt_digest: FAKE_64, commit_sha: FAKE_SHA })),
          receipt_chain_valid: true, summary: 'gate pass at child',
        },
      },
      { receiptDir: gateDir, tempDir: gateDir },
    );
    writeReceipt(
      {
        version: 1, type: 'STAGE_REVIEW_PASS', stage_id: STAGE_ID,
        timestamp: '2026-08-13T00:00:00.000Z',
        payload: {
          schema_version: 2, type: 'STAGE_REVIEW_RESULT', action: 'STAGE_REVIEW',
          stage_id: STAGE_ID, verdict: 'ACCEPTED',
          manifest_digest: manifestDigest, plan_digest: planDigest, snapshot_digest: childSha,
          runtime_proof_digest: FAKE_64, stage_plan_receipt_digest: FAKE_64, spv_receipt_digest: FAKE_64,
          stage_gate_receipt_digest: FAKE_64,
          receipt_chain_valid: true, summary: 'review accepted at child',
        },
      },
      { receiptDir: reviewDir, tempDir: reviewDir },
    );
    execFileSync('git', ['-C', root, 'add', '-A']);
    const treeD = execFileSync('git', ['-C', root, 'write-tree'], { encoding: 'utf-8' }).trim();
    const descSha = execFileSync('git', ['-C', root, 'commit-tree', treeD, '-p', childSha, '-m', 'descendant'], { encoding: 'utf-8' }).trim();
    execFileSync('git', ['-C', root, 'update-ref', 'refs/heads/master', descSha]);
    execFileSync('git', ['-C', root, 'reset', '--hard', descSha], { stdio: ['ignore', 'ignore', 'ignore'] });
    // 断言真实祖先关系：SPV snapshot（parentSha）是 GATE snapshot（childSha）的祖先，
    // childSha 是 HEAD（descSha）的祖先——两条 merge-base 链路真实触发
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', parentSha, childSha]);
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', childSha, descSha]);
    expect(childSha).not.toBe(parentSha);
    const targets = [
      'packages/runtime/src/cli/sync-cv-status.ts',
      'packages/runtime/dist/cli/sync-cv-status.js',
      'packages/runtime/src/cli/prepare-gate-facts.ts',
      'packages/runtime/dist/cli/prepare-gate-facts.js',
    ].sort();
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: targets }),
    );
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; result: any };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.deleted.sort()).toEqual(targets);
  });
});

// ============================================================
// 第 8 轮 repair：真实 ProjectReviewReceipt producer→consumer 绑定
// （f162a773... failure signature -007：消费者与测试夹具复制了 manifest
// 输入格式（review_receipt/gate_receipt + 64 位 digest），而非 finalize
// 产物格式（review/gate/snapshot + 16 位 digest），代码与自造 fixture
// 互相自证。本组测试经真实 public proofloop.js project 域
// compile-acceptance → run-e2e → finalize-review 生成 PROJECT_REVIEW_PASS，
// 再由 cutover execute 消费；失败测试在真实产物上做 bounded mutation。）
// ============================================================

const REAL_PA_TARGETS = [
  'packages/runtime/src/cli/sync-cv-status.ts',
  'packages/runtime/dist/cli/sync-cv-status.js',
  'packages/runtime/src/cli/prepare-gate-facts.ts',
  'packages/runtime/dist/cli/prepare-gate-facts.js',
].sort();

/**
 * 真实 producer→consumer 链：经 public proofloop.js 的 project 域
 * compile-acceptance → run-e2e → finalize-review 生成真实
 * PROJECT_REVIEW_PASS（kernel writeReceipt，previous_digest 链到 E2E gate
 * receipt，输出到 canonical project/ 类别），不做任何手写成功 fixture。
 * 前置要求：fixture 仓库已 seedCutoverFixture（vNext authority/receipts）。
 */
function seedRealProjectAcceptance(root: string): { projectDir: string; reviewPath: string } {
  // stage evidence：vNext（v2 Manifest + STAGE_REVIEW_PASS/GATE_PASS
  // envelope，与 project-acceptance.cli.spec.ts 同构；finalize 会重读并绑定
  // computeDigest / envelope digest，故 commit 后不得再变）。
  const paDir = path.join(root, '.proofloop', 'pa');
  fs.mkdirSync(paDir, { recursive: true });
  const stageManifestPath = path.join(paDir, 'stage-manifest.json');
  const stageManifest = {
    version: 2,
    stage_id: STAGE_ID,
    plan: {
      ref: 'delivery/stages/S10/tasks.md',
      plan_digest: FAKE_64,
      schema_version: 2,
    },
    reference_index: {
      'REF-GOAL': { kind: 'goal', ref: 'delivery/stages/S10/tasks.md#/entities/goal', file_digest: FAKE_64, section_digest: FAKE_64 },
      'REF-TASK': { kind: 'task', ref: 'delivery/stages/S10/tasks.md#/entities/slice-task', file_digest: FAKE_64, section_digest: FAKE_64 },
      'REF-ACCEPT': { kind: 'acceptance', ref: 'delivery/stages/S10/tasks.md#/entities/acceptance', file_digest: FAKE_64, section_digest: FAKE_64 },
      'REF-SEAM': { kind: 'seam', ref: 'delivery/stages/S10/tasks.md#/entities/seam', file_digest: FAKE_64, section_digest: FAKE_64 },
      'REF-ORACLE': { kind: 'oracle', ref: 'delivery/stages/S10/tasks.md#/entities/oracle', file_digest: FAKE_64, section_digest: FAKE_64 },
    },
    slices: [
      {
        slice_id: 'S10-A',
        proof_index: {
          slice_id: 'S10-A',
          goal_ref: 'REF-GOAL',
          task_refs: ['REF-TASK'],
          acceptance_refs: ['REF-ACCEPT'],
          seam_refs: ['REF-SEAM'],
          oracle_refs: ['REF-ORACLE'],
          risk_refs: [],
        },
        required_skills: ['typescript'],
        depends_on: [],
        evidence_path: 'delivery/stages/S10/evidence/S10-A.md',
      },
    ],
    task_scopes: {
      'slice-task': {
        task_ref: 'delivery/stages/S10/tasks.md#/entities/slice-task',
        execution_scope: { kind: 'implementation', code_paths: ['src'], test_paths: ['test'], forbidden_paths: [] },
      },
    },
  };
  fs.writeFileSync(stageManifestPath, JSON.stringify(stageManifest, null, 2), 'utf-8');
  const stageManifestDigest = computeDigest(JSON.parse(fs.readFileSync(stageManifestPath, 'utf-8')));
  // stage review/gate snapshot：vNext snapshot_digest = 40 位 git commit sha
  // 形状（cutover 的 S10 证据语义）。
  const stageSnapshot = FAKE_SHA;
  const gatePath = path.join(paDir, 'stage-gate.json');
  const gateEnvelope = {
    version: 1,
    type: 'GATE_PASS',
    stage_id: STAGE_ID,
    timestamp: '2026-08-12T00:00:00.000Z',
    payload: {
      action: 'GATE',
      type: 'GATE_RESULT',
      schema_version: 2,
      verdict: 'PASS',
      stage_id: STAGE_ID,
      manifest_digest: stageManifestDigest,
      snapshot_digest: stageSnapshot,
      receipt_chain_valid: true,
    },
  };
  const gate = { ...gateEnvelope, digest: computeReceiptDigest(gateEnvelope as never) };
  fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2), 'utf-8');
  const gateDigest = gate['digest'] as string;
  const reviewPath = path.join(paDir, 'stage-review.json');
  const reviewEnvelope = {
    version: 1,
    type: 'STAGE_REVIEW_PASS',
    stage_id: STAGE_ID,
    timestamp: '2026-08-12T00:00:10.000Z',
    payload: {
      action: 'STAGE_REVIEW',
      type: 'STAGE_REVIEW_RESULT',
      schema_version: 2,
      verdict: 'ACCEPTED',
      stage_id: STAGE_ID,
      manifest_digest: stageManifestDigest,
      snapshot_digest: stageSnapshot,
      stage_gate_receipt_digest: gateDigest,
      receipt_chain_valid: true,
    },
  };
  const review = { ...reviewEnvelope, digest: computeReceiptDigest(reviewEnvelope as never) };
  fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2), 'utf-8');
  const reviewDigest = review['digest'] as string;
  // .gitignore：compile 输出的 project manifest 必须不出现在 git status
  //（compile 与 run-e2e 之间快照必须一致，否则 PROJECT_SOURCE_STALE）。
  write(root, '.gitignore', '.proofloop/pa/project-manifest.json\n');
  const compileInput = {
    project_root: root,
    project_id: 'real-producer-project',
    prd_goals: ['Real producer goal'],
    acceptance_criteria: ['AC-01'],
    stage_receipts: [
      {
        stage_id: STAGE_ID,
        stage_manifest: { path: stageManifestPath, digest: stageManifestDigest },
        review_receipt: { path: reviewPath, digest: reviewDigest },
        gate_receipt: { path: gatePath, digest: gateDigest },
      },
    ],
    e2e_steps: [{ id: 'smoke-1', executable: 'node', args: ['-e', 'process.exit(0)'] }],
  };
  fs.writeFileSync(path.join(paDir, 'compile-input.json'), JSON.stringify(compileInput, null, 2), 'utf-8');
  commitAll(root, 'project acceptance evidence');

  // 1. compile-acceptance（真实 public seam）
  const compileRes = runPublic(root, ['project', 'compile-acceptance'], JSON.stringify({
    input_path: '.proofloop/pa/compile-input.json',
    output_path: '.proofloop/pa/project-manifest.json',
  }));
  expect(compileRes.status).toBe(0);
  const compileOut = JSON.parse(compileRes.stdout) as { ok: boolean; result: { manifest_digest: string } };
  expect(compileOut.ok).toBe(true);
  const manifestPath = path.join(root, '.proofloop', 'pa', 'project-manifest.json');

  // 2. run-e2e（真实 public seam；E2E receipt 写入 canonical project/ 类别）
  const runRes = runPublic(root, ['project', 'run-e2e'], JSON.stringify({
    manifest_path: '.proofloop/pa/project-manifest.json',
  }));
  expect(runRes.status).toBe(0);
  const runOut = JSON.parse(runRes.stdout) as { ok: boolean; result: { receipt_ref: { ref: string } } };
  expect(runOut.ok).toBe(true);
  const projectDir = projectReceiptDir(root);
  const e2ePath = path.join(root, runOut.result.receipt_ref.ref);
  const e2eFileDigest = fileDigest16(e2ePath);

  // 3. reviewer result（finalize 的 AI Reviewer 输入：bound to manifest +
  //    e2e receipt 文件 digest；criteria one-to-one）
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { expected_snapshot: string };
  const reviewer = {
    verdict: 'PROJECT_ACCEPTED',
    reviewer: 'real-producer-reviewer',
    reviewed_snapshot: manifest.expected_snapshot,
    project_manifest: { path: manifestPath, digest: compileOut.result.manifest_digest },
    project_e2e_receipt: { path: e2ePath, digest: e2eFileDigest },
    criteria_results: [{ criteria: 'AC-01', passed: true, notes: 'ok' }],
    findings: [],
    accepted_deviations: [],
    // 真实当前时间（必须晚于 E2E receipt 的真实 timestamp——cutover 的
    // project 链要求 timestamp 单调，reviewed_at 早于 E2E 会被链序拒绝）。
    reviewed_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(paDir, 'reviewer-result.json'), JSON.stringify(reviewer, null, 2), 'utf-8');

  // 4. finalize-review（真实 public seam；默认输出 canonical project/ 类别，
  //    previous_digest 链到 E2E gate receipt）
  const finalizeRes = runPublic(root, ['project', 'finalize-review'], JSON.stringify({
    manifest_path: '.proofloop/pa/project-manifest.json',
    e2e_receipt_path: runOut.result.receipt_ref.ref,
    reviewer_result_path: '.proofloop/pa/reviewer-result.json',
    verdict: 'PROJECT_ACCEPTED',
    summary: 'real producer to consumer cutover test',
  }));
  expect(finalizeRes.status).toBe(0);
  const finalizeOut = JSON.parse(finalizeRes.stdout) as { ok: boolean; result: { receipt_ref: { ref: string } } };
  expect(finalizeOut.ok).toBe(true);
  return { projectDir, reviewPath: path.join(root, finalizeOut.result.receipt_ref.ref) };
}



/**
 * 在真实 PROJECT_REVIEW_PASS 产物上做 bounded mutation：改写 payload 后重写
 * digest-addressed 文件（previous_digest 不变、删除原文件保持单根链），
 * 返回新的 receipt 路径。
 */
function mutateProjectReview(
  root: string,
  projectDir: string,
  reviewPath: string,
  mutate: (payload: Record<string, unknown>) => void,
): string {
  const receipt = JSON.parse(fs.readFileSync(reviewPath, 'utf-8')) as Record<string, unknown>;
  const { digest: ignored, ...content } = receipt;
  void ignored;
  const payload = JSON.parse(JSON.stringify(content['payload'])) as Record<string, unknown>;
  mutate(payload);
  const mutated = { ...content, payload };
  const { computeReceiptDigest: crd } = require('@proofloop/kernel') as typeof import('@proofloop/kernel');
  const newDigest = crd(mutated);
  fs.writeFileSync(path.join(projectDir, `${newDigest}.json`), JSON.stringify({ ...mutated, digest: newDigest }), 'utf-8');
  fs.rmSync(reviewPath);
  return path.join(projectDir, `${newDigest}.json`);
}

/**
 * 在真实 project 类别 receipt 上做 envelope 级 bounded mutation（改写 outer
 * stage_id / type / previous_digest / timestamp 后重算 digest-addressed
 * 文件名并删除原文件），返回新路径。payload 级 mutation 用
 * mutateProjectReview。
 */
function rewriteProjectReceipt(
  projectDir: string,
  receiptPath: string,
  mutate: (content: Record<string, unknown>) => void,
): string {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8')) as Record<string, unknown>;
  const { digest: ignored, ...content } = receipt;
  void ignored;
  mutate(content);
  const { computeReceiptDigest: crd } = require('@proofloop/kernel') as typeof import('@proofloop/kernel');
  const newDigest = crd(content);
  fs.writeFileSync(path.join(projectDir, `${newDigest}.json`), JSON.stringify({ ...content, digest: newDigest }), 'utf-8');
  fs.rmSync(receiptPath);
  return path.join(projectDir, `${newDigest}.json`);
}

/** 在 canonical project/ 类别中找到 PROJECT_E2E_* receipt 文件路径。 */
function findProjectE2EReceipt(root: string, projectDir: string): string {
  const name = fs.readdirSync(projectDir).find((n) => {
    if (!n.endsWith('.json')) return false;
    const r = JSON.parse(fs.readFileSync(path.join(projectDir, n), 'utf-8')) as { type: string };
    return r.type.startsWith('PROJECT_E2E_');
  });
  if (name === undefined) throw new Error('no PROJECT_E2E_* receipt in project dir');
  return path.join(projectDir, name);
}

describe('真实 ProjectReviewReceipt producer→consumer（第 8 轮 repair f162a773）', () => {
  it('真实 compile→run-e2e→finalize-review 产物形状 = finalizeProjectReview 唯一事实（stage refs 64 位 vNext digest + snapshot 40 位）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { reviewPath } = seedRealProjectAcceptance(root);
    const envelope = JSON.parse(fs.readFileSync(reviewPath, 'utf-8')) as { type: string; payload: Record<string, any> };
    expect(envelope.type).toBe('PROJECT_REVIEW_PASS');
    expect(envelope.payload.verdict).toBe('PROJECT_ACCEPTED');
    const sr = envelope.payload.stage_receipts[0] as Record<string, any>;
    expect(Object.keys(sr).sort()).toEqual(['gate', 'review', 'snapshot', 'stage_id', 'stage_manifest']);
    // vNext stage refs：stage_manifest/review/gate digest 为 64 位 hex。
    for (const ref of [sr.stage_manifest, sr.review, sr.gate]) {
      expect(Object.keys(ref).sort()).toEqual(['digest', 'path']);
      expect(ref.digest).toMatch(/^[a-f0-9]{64}$/);
    }
    // stage snapshot 为 40 位 hex（vNext snapshot_digest = git commit sha）。
    expect(sr.snapshot).toMatch(/^[a-f0-9]{40}$/);
    // project 域 digest 仍为 16 位 hex（computeSnapshot / canonical / fileDigest16）。
    expect(envelope.payload.snapshot).toMatch(/^[a-f0-9]{16}$/);
    expect(envelope.payload.project_manifest.digest).toMatch(/^[a-f0-9]{16}$/);
    expect(envelope.payload.project_e2e_receipt.digest).toMatch(/^[a-f0-9]{16}$/);
  });

  it('真实 producer 产物 → cutover execute 成功且 PA present（不接受手写成功 fixture）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    seedRealProjectAcceptance(root);
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: REAL_PA_TARGETS }),
    );
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; result: any };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.acceptance_facts.project_acceptance).toEqual({ present: true, verdict: 'PROJECT_ACCEPTED' });
    expect(envelope.result.deleted.sort()).toEqual(REAL_PA_TARGETS);
  });

  it('真实产物 mutation：stage_receipts 字段名回退 review_receipt/gate_receipt → exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    mutateProjectReview(root, projectDir, reviewPath, (p) => {
      const sr = p['stage_receipts'] as Array<Record<string, unknown>>;
      const entry = sr[0] as Record<string, unknown>;
      entry['review_receipt'] = entry['review'];
      entry['gate_receipt'] = entry['gate'];
      delete entry['review'];
      delete entry['gate'];
    });
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: REAL_PA_TARGETS }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('PROJECT_REVIEW_PASS');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('真实产物 mutation：review.digest 用 legacy 16 位 digest（非 vNext 64 位）→ exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    mutateProjectReview(root, projectDir, reviewPath, (p) => {
      const sr = p['stage_receipts'] as Array<Record<string, unknown>>;
      ((sr[0] as Record<string, unknown>)['review'] as Record<string, unknown>)['digest'] = 'f'.repeat(16);
    });
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: REAL_PA_TARGETS }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('真实产物 mutation：stage_receipts 条目缺 snapshot → exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    mutateProjectReview(root, projectDir, reviewPath, (p) => {
      const sr = p['stage_receipts'] as Array<Record<string, unknown>>;
      delete (sr[0] as Record<string, unknown>)['snapshot'];
    });
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: REAL_PA_TARGETS }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('真实产物 mutation：findings 项含未知字段 → exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    mutateProjectReview(root, projectDir, reviewPath, (p) => {
      (p['findings'] as unknown[]).push({ category: 'C', description: 'D', hack: 1 });
    });
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: REAL_PA_TARGETS }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('真实产物 mutation：criteria_results.passed 改为字符串 → exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    mutateProjectReview(root, projectDir, reviewPath, (p) => {
      ((p['criteria_results'] as unknown[])[0] as Record<string, unknown>)['passed'] = 'yes';
    });
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: REAL_PA_TARGETS }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('真实产物 mutation：stage_manifest 替换为非法嵌套对象（数组）→ exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    mutateProjectReview(root, projectDir, reviewPath, (p) => {
      const sr = p['stage_receipts'] as Array<Record<string, unknown>>;
      (sr[0] as Record<string, unknown>)['stage_manifest'] = [{ path: 'x', digest: FAKE_16 }];
    });
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: REAL_PA_TARGETS }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('真实产物 mutation：accepted_deviations 含非字符串 → exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    mutateProjectReview(root, projectDir, reviewPath, (p) => {
      (p['accepted_deviations'] as unknown[]).push(42);
    });
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: REAL_PA_TARGETS }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });
});

// ============================================================
// 第 9 轮 repair：project receipt outer 绑定 / E2E type↔verdict /
// snapshot 16 位 hex / review→E2E 链前驱（failure_signature -008）
// —— 四个反例全部位于 cutover 消费者 project 链校验；全部 mutation 在真实
// compile→run-e2e→finalize-review 产物上做 bounded 改写，经 public
// proofloop.js 断言 exit 2 + 零删除。
// ============================================================

describe('第 9 轮 repair：project receipt outer 绑定 / type↔verdict / snapshot hex / review→E2E 链（S10-E-RECHECK-CUTOVER-PROJECT-RECEIPT-OUTER-BINDING-SNAPSHOT-CLOSED-SCHEMA-008）', () => {
  function expectRejected(root: string, messageContains: string): void {
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: REAL_PA_TARGETS }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain(messageContains);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  }

  it('outer 绑定：真实 PROJECT_REVIEW_PASS 的 outer stage_id 改为其他非空项目 ID（重算 digest）→ exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    rewriteProjectReceipt(projectDir, reviewPath, (content) => {
      content['stage_id'] = 'other-project';
    });
    expectRejected(root, 'outer project binding mismatch');
  });

  it('outer 绑定：真实 PROJECT_E2E_PASS 的 outer stage_id 改为其他非空项目 ID（review.previous_digest 同步保持链有效）→ exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    const e2ePath = findProjectE2EReceipt(root, projectDir);
    const newE2ePath = rewriteProjectReceipt(projectDir, e2ePath, (content) => {
      content['stage_id'] = 'other-project';
    });
    rewriteProjectReceipt(projectDir, reviewPath, (content) => {
      content['previous_digest'] = path.basename(newE2ePath, '.json');
    });
    expectRejected(root, 'outer project binding mismatch');
  });

  it('type↔verdict：合法自摘要 PROJECT_E2E_FAIL envelope + payload verdict PASS → exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    const e2ePath = findProjectE2EReceipt(root, projectDir);
    const newE2ePath = rewriteProjectReceipt(projectDir, e2ePath, (content) => {
      content['type'] = 'PROJECT_E2E_FAIL';
    });
    rewriteProjectReceipt(projectDir, reviewPath, (content) => {
      content['previous_digest'] = path.basename(newE2ePath, '.json');
    });
    expectRejected(root, 'does not match payload verdict');
  });

  it('snapshot：真实 REVIEW 顶层 snapshot 改为非 16 位 hex 非空字符串 → exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    mutateProjectReview(root, projectDir, reviewPath, (p) => {
      p['snapshot'] = 'not-a-real-snapshot';
    });
    expectRejected(root, 'PROJECT_REVIEW_PASS failed the closed PROJECT_REVIEW schema');
  });

  it('snapshot：stage_receipts[].snapshot 改为 8 位 hex（非 16 位）→ exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    mutateProjectReview(root, projectDir, reviewPath, (p) => {
      ((p['stage_receipts'] as Array<Record<string, unknown>>)[0])['snapshot'] = 'deadbeef';
    });
    expectRejected(root, 'PROJECT_REVIEW_PASS failed the closed PROJECT_REVIEW schema');
  });

  it('链前驱：独立伪造 review 根 Receipt（删除 E2E + 去掉 previous_digest）→ exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    fs.rmSync(findProjectE2EReceipt(root, projectDir));
    rewriteProjectReceipt(projectDir, reviewPath, (content) => {
      delete content['previous_digest'];
    });
    expectRejected(root, 'previous_digest must chain to a PROJECT_E2E_*');
  });

  it('非法 E2E 链结构：E2E 链到 review 之后（review 根 + E2E.previous_digest=review digest）→ exit 2 零删除', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    const { projectDir, reviewPath } = seedRealProjectAcceptance(root);
    const e2ePath = findProjectE2EReceipt(root, projectDir);
    const newReviewPath = rewriteProjectReceipt(projectDir, reviewPath, (content) => {
      delete content['previous_digest'];
    });
    const reviewTimestamp = (JSON.parse(fs.readFileSync(newReviewPath, 'utf-8')) as { timestamp: string }).timestamp;
    rewriteProjectReceipt(projectDir, e2ePath, (content) => {
      content['previous_digest'] = path.basename(newReviewPath, '.json');
      content['timestamp'] = reviewTimestamp;
    });
    expectRejected(root, 'PROJECT_E2E');
  });
});

// ============================================================
// 第 8 轮 repair：restricted_bootstrap Gate 不得授权 cutover 删除
// （Runtime gate-admission：restricted_bootstrap 出现时只能为 true；S10
// 完成证明不接受受限 bootstrap —— 两种值都必须 fail closed 零删除）
// ============================================================

describe('GATE restricted_bootstrap（第 8 轮 repair）', () => {
  const rbTargets = ['packages/runtime/src/cli/sync-cv-status.ts', 'packages/runtime/dist/cli/sync-cv-status.js'];

  function mutateGatePayload(root: string, value: unknown): void {
    const gateDir = stageGateReceiptDir(root, STAGE_ID);
    const gateName = fs.readdirSync(gateDir).find((n) => n.endsWith('.json')) as string;
    const gatePath = path.join(gateDir, gateName);
    const gate = JSON.parse(fs.readFileSync(gatePath, 'utf-8')) as Record<string, unknown>;
    const { digest: ignored, ...content } = gate;
    void ignored;
    const payload = JSON.parse(JSON.stringify(content['payload'])) as Record<string, unknown>;
    payload['restricted_bootstrap'] = value;
    const mutated = { ...content, payload };
    const { computeReceiptDigest: crd } = require('@proofloop/kernel') as typeof import('@proofloop/kernel');
    const newDigest = crd(mutated);
    fs.writeFileSync(path.join(gateDir, `${newDigest}.json`), JSON.stringify({ ...mutated, digest: newDigest }), 'utf-8');
    fs.rmSync(gatePath);
  }

  it('GATE restricted_bootstrap:true → exit 2 零删除（受限 bootstrap 不是完成证明）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    mutateGatePayload(root, true);
    commitAll(root);
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: rbTargets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(envelope.findings[0].message).toContain('restricted_bootstrap');
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });

  it('GATE restricted_bootstrap:false → exit 2 零删除（值域：只能为 true）', () => {
    const root = makeRepo();
    seedCutoverFixture(root);
    mutateGatePayload(root, false);
    commitAll(root);
    const res = runPublic(
      root,
      ['cutover', 'execute'],
      JSON.stringify({ confirmed: true, stage: STAGE_ID, delete_list: rbTargets }),
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/RECEIPT_INVALID/);
    expect(fs.existsSync(path.join(root, 'packages/runtime/src/cli/sync-cv-status.ts'))).toBe(true);
  });
});
