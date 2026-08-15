/**
 * proofloop-recovery.spec.ts — S10-D-T03: recovery 域 handler + doctor/recovery
 * 完整性。
 *
 * PO binding（REF-S10-D-T03 / REF-CLI-ACCEPTANCE Acceptance D+E / REF-CLI-SEAM
 * §0.3/§5.2 / REF-CLI-ORACLE / REF-S08E-RISK）：
 *  - recovery 域从同一 public CLI 调用（`proofloop recovery <operation>`），
 *    closed 操作集 `check`（只读恢复状态报告）/ `preflight`（恢复前只读预检）/
 *    `restart`（复用 vNext restart/recovery seam —— 只从 Git/Manifest/Receipts
 *    等本地持久事实重新投影派发状态，不重放 Worker 实现）/ `doctor`（复用
 *    doctor 域能力转发，S10 运行证明第 8 步 `recovery doctor --json --stage S10`
 *    必须 exit 0）；
 *  - 重启恢复语义：只读持久事实（receipts/context/manifest）恢复状态，失败
 *    canonical Finding + no-write；`restart` 成功时 Context 由 Runtime next
 *    seam（persistVNextWorkerContext）落盘，handler 不直接写 `.proofloop/*`；
 *  - doctor 域补 run/status 闭集完整语义：`doctor status` 只读状态报告（Git/
 *    capabilities/receipts 类别摘要 + state.operations 含 run/status），非 git
 *    仓库降级报告 exit 0；
 *  - refresh journal（evidence-refresh 恢复语义）：`recovery check` 报告 evidence
 *    目录中是否存在未恢复的 REFRESH_JOURNAL_FILE（只读探测，不解析/不写）。
 *
 * 覆盖：handler-direct 失败/边界用例（缺 --stage、非 canonical stage、未知
 * 操作、Manifest 缺失）；built public CLI 成功路径（探针接线期，spawnSync +
 * 真实仓库/临时 fixture）；probe hygiene（PROBE-S10D 残留 0）。restart 的完整
 * restart fixture（S08 重启恢复）在 restart-recovery-vnext.spec.ts 中覆盖。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeDigest } from '@proofloop/kernel';
import { runRecoveryFromArgv } from './proofloop-recovery';
import { runDoctorStatus } from './proofloop-doctor';
import { compileVNextManifestCli } from './compile-vnext-manifest';
import { initializeVNextSliceEvidence } from './initialize-vnext-slice-evidence';
import { REFRESH_JOURNAL_FILE } from '../vnext/evidence-refresh';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_PROOFLOOP = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');
/** 真实仓库工作目录（与 S10 运行证明步骤 cwd 一致）。 */
const RUNTIME_CWD = path.join(REPO_ROOT, 'packages', 'runtime');

const cleanups: string[] = [];
afterEach(() => {
  for (const root of cleanups.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// ============================================================
// Fixture helpers
// ============================================================

function tempRoot(prefix = 'proofloop-recovery-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(root);
  return root;
}

function gitRoot(prefix = 'proofloop-recovery-git-'): string {
  const root = tempRoot(prefix);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'recovery@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Recovery Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  return root;
}

function commitAll(root: string, message = 'fixture'): void {
  fs.writeFileSync(path.join(root, 'README.md'), 'recovery fixture\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
}

/** built public proofloop.js 进程级 runner（成功路径唯一 seam）。 */
function runPublicCli(args: readonly string[], cwd: string): { status: number; envelope: any } {
  const res = spawnSync(process.execPath, [DIST_PROOFLOOP, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
  });
  let envelope: any = null;
  try {
    envelope = JSON.parse(res.stdout);
  } catch {
    envelope = { parseError: res.stdout, stderr: res.stderr };
  }
  return { status: res.status ?? -1, envelope };
}

/** 编译一个最小 vNext Manifest（S04 fixture，与 restart-recovery-vnext.spec.ts 同构）。 */
function buildMinimalManifestFixture(): {
  root: string;
  manifestRef: string;
  evidenceDir: string;
  evidencePath: string;
} {
  const root = tempRoot('proofloop-recovery-manifest-');
  fs.writeFileSync(path.join(root, 'refs.md'), [
    '<!-- proofloop:entity id="goal" kind="goal" -->',
    'goal',
    '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
    'task A',
    '<!-- proofloop:entity id="accept" kind="acceptance" -->',
    'acceptance',
    '<!-- proofloop:entity id="seam" kind="seam" -->',
    'seam',
    '<!-- proofloop:entity id="oracle" kind="oracle" -->',
    'oracle',
    '<!-- proofloop:entity id="risk" kind="risk" -->',
    'risk',
  ].join('\n'), 'utf8');
  const tasksPath = path.join(root, 'delivery', 'stages', 'S04', 'tasks.md');
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, 'not parsed\n', 'utf8');
  const requestPath = path.join(root, 'request.json');
  fs.writeFileSync(
    requestPath,
    JSON.stringify({
      root,
      stage_id: 'S04',
      plan_path: 'delivery/stages/S04/tasks.md',
      plan: {
        schema_version: 2,
        items: [
          {
            id: 'S04-A-T01',
            kind: 'task',
            goal: 'slice A goal',
            refs: ['REF-T'],
            dependencies: [],
            required_skills: [],
            execution_scope: {
              kind: 'implementation',
              code_paths: ['packages/runtime/src/cli/proofloop-recovery.ts'],
              test_paths: ['packages/runtime/src/cli/proofloop-recovery.spec.ts'],
              forbidden_paths: ['.proofloop/receipts'],
            },
          },
        ],
      },
      refs: [
        { ref_id: 'REF-G', kind: 'goal', ref: 'refs.md#/entities/goal' },
        { ref_id: 'REF-T', kind: 'task', ref: 'refs.md#/entities/S04-A-T01' },
        { ref_id: 'REF-A', kind: 'acceptance', ref: 'refs.md#/entities/accept' },
        { ref_id: 'REF-S', kind: 'seam', ref: 'refs.md#/entities/seam' },
        { ref_id: 'REF-O', kind: 'oracle', ref: 'refs.md#/entities/oracle' },
        { ref_id: 'REF-R', kind: 'risk', ref: 'refs.md#/entities/risk' },
      ],
      authority_ref_ids: ['REF-A', 'REF-S', 'REF-O'],
      slices: [
        {
          slice_id: 'S04-A',
          proof_index: {
            slice_id: 'S04-A',
            goal_ref: 'REF-G',
            task_refs: ['REF-T'],
            acceptance_refs: ['REF-A'],
            seam_refs: ['REF-S'],
            oracle_refs: ['REF-O'],
            risk_refs: [
              {
                ref_id: 'REF-R',
                applies_to_acceptance_refs: ['REF-A'],
                applies_to_seam_refs: ['REF-S'],
              },
            ],
          },
          required_skills: [],
          depends_on: [],
          evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
        },
      ],
    }),
    'utf8',
  );
  const manifestRef = '.proofloop/manifests/S04.json';
  expect(compileVNextManifestCli([requestPath, manifestRef, root])).toBe(0);
  const evidenceDir = path.join(root, 'delivery', 'stages', 'S04', 'evidence');
  expect(initializeVNextSliceEvidence(manifestRef, evidenceDir, root).success).toBe(true);
  return {
    root,
    manifestRef,
    evidenceDir,
    evidencePath: 'delivery/stages/S04/evidence/S04-A.md',
  };
}

// ============================================================
// handler-direct：失败 / 边界用例（recovery 域）
// ============================================================

describe('proofloop recovery handler-direct 失败/边界用例（S10-D-T03）', () => {
  it('`recovery check` without --stage fails closed（missing required parameter）', async () => {
    const root = gitRoot();
    commitAll(root);
    const envelope: any = await runRecoveryFromArgv(['recovery', 'check', '--json'], { cwd: root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.findings[0].message).toContain('stage');
  });

  it('`recovery preflight` without --stage fails closed', async () => {
    const root = gitRoot();
    commitAll(root);
    const envelope: any = await runRecoveryFromArgv(['recovery', 'preflight', '--json'], { cwd: root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });

  it('`recovery restart` without --stage fails closed', async () => {
    const root = gitRoot();
    commitAll(root);
    const envelope: any = await runRecoveryFromArgv(['recovery', 'restart', '--json'], { cwd: root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });

  it('a non-canonical stage id（S08B0 legacy parked label）fails closed before any read', async () => {
    const root = gitRoot();
    commitAll(root);
    const envelope: any = await runRecoveryFromArgv(['recovery', 'check', '--json', '--stage', 'S08B0'], { cwd: root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].message).toContain('stage');
  });

  it('an unknown recovery operation fails closed（closed set: check|preflight|restart|doctor）', async () => {
    const root = gitRoot();
    commitAll(root);
    const envelope: any = await runRecoveryFromArgv(['recovery', 'revive', '--json', '--stage', 'S10'], { cwd: root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.NOT_IMPLEMENTED');
  });

  it('`recovery check` fails closed when the stage has no Manifest', async () => {
    const root = gitRoot();
    commitAll(root);
    const envelope: any = await runRecoveryFromArgv(['recovery', 'check', '--json', '--stage', 'S10'], { cwd: root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RECOVERY.MANIFEST_UNAVAILABLE');
  });

  it('`recovery restart` fails closed with zero Context writes when the Manifest is missing', async () => {
    const root = gitRoot();
    commitAll(root);
    const contextDir = path.join(root, '.proofloop', 'context');
    const envelope: any = await runRecoveryFromArgv(['recovery', 'restart', '--json', '--stage', 'S10'], { cwd: root });
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(contextDir)).toBe(false);
  });

  it('a request file whose stage conflicts with --stage fails closed', async () => {
    const root = gitRoot();
    commitAll(root);
    fs.writeFileSync(
      path.join(root, 'request.json'),
      JSON.stringify({ domain: 'recovery', operation: 'check', stage: 'S09' }),
    );
    const envelope: any = await runRecoveryFromArgv(
      ['recovery', 'check', '--request', 'request.json', '--stage', 'S10'],
      { cwd: root },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
  });
});

// ============================================================
// doctor status（S10-D-T03：doctor 域补 run/status 闭集完整语义）
// ============================================================

describe('doctor status（S10-D-T03 doctor 域补闭集）', () => {
  it('doctor status handler-direct exits 0 with read-only structured diagnostics（含 receipts 类别摘要）', () => {
    const root = gitRoot();
    commitAll(root);
    // 预置一个 receipt 类别目录，验证 receipts 摘要只读报告。
    fs.mkdirSync(path.join(root, '.proofloop', 'receipts', 'tasks', 'S10', 'S10-A'), { recursive: true });
    const command = { domain: 'doctor', operation: 'status' } as const;
    const envelope = runDoctorStatus(root, 'auto', command) as any;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual(command);
    expect(envelope.result.project_root).toBe(fs.realpathSync(root));
    expect(envelope.result.git.available).toBe(true);
    expect(envelope.result.state.read_only).toBe(true);
    expect(envelope.result.state.operations).toEqual(['run', 'status']);
    expect(typeof envelope.result.receipts).toBe('object');
    expect(envelope.result.receipts.tasks).toBeDefined();
  });

  it('built public `doctor status --json` exits 0 with the canonical envelope（探针接线期）', () => {
    const root = gitRoot();
    commitAll(root);
    const { status, envelope } = runPublicCli(['doctor', 'status', '--json'], root);
    expect(status).toBe(0);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'doctor', operation: 'status' });
    expect(envelope.result.state.operations).toContain('status');
    expect(envelope.result.git.head).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ============================================================
// built public CLI 成功路径（探针接线期，spawnSync）
// ============================================================

describe('built public proofloop.js recovery smoke（S10-D-T03 成功路径）', () => {
  it('`recovery doctor --json --stage S10` exits 0 on the real repo（S10 runtime proof step 8, forwards doctor run）', () => {
    const { status, envelope } = runPublicCli(['recovery', 'doctor', '--json', '--stage', 'S10'], RUNTIME_CWD);
    expect(status).toBe(0);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'recovery', operation: 'doctor' });
    expect(envelope.findings).toEqual([]);
    expect(envelope.result.project_root).toBe(fs.realpathSync(REPO_ROOT));
    expect(envelope.result.git.head).toMatch(/^[0-9a-f]{40}$/);
    expect(envelope.result.state.read_only).toBe(true);
  });

  it('`recovery bogus` exits 2 with RUNTIME.SCHEMA_MISMATCH（dispatcher closed registry 拦截，零写入）', () => {
    const root = gitRoot();
    commitAll(root);
    const before = receiptsSnapshot(root);
    const { status, envelope } = runPublicCli(['recovery', 'bogus'], root);
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toEqual({ domain: 'recovery', operation: 'bogus' });
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.findings[0].message).toContain('unknown operation');
    // 零写入：.proofloop 目录保持不存在/原状。
    expect(fs.existsSync(path.join(root, '.proofloop'))).toBe(false);
    expect(receiptsSnapshot(root)).toBe(before);
  });

  it('`recovery check --json --stage S10` exits 0 and reports the persisted state bindings（read-only）', () => {
    const before = receiptsSnapshot(REPO_ROOT);
    const { status, envelope } = runPublicCli(['recovery', 'check', '--json', '--stage', 'S10'], RUNTIME_CWD);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'recovery', operation: 'check' });
    expect(envelope.result.stage_id).toBe('S10');
    expect(envelope.result.manifest.readable).toBe(true);
    // 自洽化（同 dispatch.spec.ts rebindS08ReferenceDigests / next-action-vnext.spec.ts
    // computeDigest 模式）：S10 Manifest 已归档为历史快照，digest 随真实仓库状态演进，
    // 不再硬编码 —— 用编译器同一 resolver 从持久化 Manifest 文件动态重算期望值，断言
    // 意图保持：check 忠实报告持久化 binding。
    const s10Manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, '.proofloop', 'manifests', 'S10.json'), 'utf8'),
    ) as { plan: { plan_digest: string } };
    expect(envelope.result.manifest.manifest_digest).toBe(computeDigest(s10Manifest));
    expect(envelope.result.manifest.plan_digest).toBe(s10Manifest.plan.plan_digest);
    expect(envelope.result.refresh_journal.present).toBe(false);
    expect(envelope.result.next_projection.ok).toBe(true);
    expect(typeof envelope.result.recoverable).toBe('boolean');
    expect(envelope.findings).toEqual([]);
    // check 是只读恢复状态报告：真实仓库 receipts/context 零变化。
    expect(receiptsSnapshot(REPO_ROOT)).toBe(before);
    // 说明：真实仓库当前处于执行期 scope-bound dirty 边界（本 Slice 的
    // 交付文件未提交 + 探针文件），next 投影按 fail-closed 语义报告
    // VALIDATE/blocked 属正确行为；DISPATCH_WORKER 语义在 S08 restart
    // fixture（restart-recovery-vnext.spec.ts）中验证。
  });

  it('`recovery check` reports an unrecovered refresh journal in the evidence directory（只读探测）', () => {
    const fx = buildMinimalManifestFixture();
    // 手工落一个 refresh journal 文件（内容不解析 —— check 只做存在性探测）。
    fs.writeFileSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE), '{"version":1}\n', 'utf8');
    const { status, envelope } = runPublicCli(
      ['recovery', 'check', '--json', '--stage', 'S04', '--project-root', fx.root],
      fx.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.refresh_journal.present).toBe(true);
    expect(envelope.result.refresh_journal.evidence_paths).toEqual([fx.evidencePath]);
    // 只读：journal 文件未被删除或修改。
    expect(fs.readFileSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE), 'utf8')).toBe('{"version":1}\n');
  });
});

// ============================================================
// probe hygiene（S10-D-T03）
// ============================================================

describe('probe hygiene（S10-D-T03）', () => {
  it('proofloop.ts and proofloop-common.ts carry no PROBE-S10D residue', () => {
    for (const file of [
      path.join(REPO_ROOT, 'packages', 'runtime', 'src', 'cli', 'proofloop.ts'),
      path.join(REPO_ROOT, 'packages', 'runtime', 'src', 'cli', 'proofloop-common.ts'),
    ]) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toContain('PROBE-S10D');
    }
  });
});

// ============================================================
// Helpers
// ============================================================

/** 递归列出 .proofloop 下 receipts/context 的相对路径（只读快照对比）。 */
function receiptsSnapshot(root: string): string {
  const lines: string[] = [];
  const base = path.join(root, '.proofloop');
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(base, full);
        const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        lines.push(`${rel} ${digest}`);
      }
    }
  };
  walk(base);
  return lines.join('\n');
}
