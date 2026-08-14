/**
 * proofloop-context.spec.ts — S10-B-T02: context 域 handler 测试。
 *
 * PO binding（REF-S10-B-T02 / REF-CLI-ACCEPTANCE Acceptance B、REF-CLI-SEAM
 * Role transfer、REF-S08E-RISK）：
 *  - 按 Planning/SPV/Worker/CV/Committer/Stage Reviewer/Project Reviewer
 *    分别投影 digest-bound Context（ref/digest/snapshot 绑定）；
 *  - context prepare/show 与 context admit-refutation-observation；
 *  - initial CV 的 Evidence read gate 保持有效（cv Context 声明
 *    evidence_read_gate，observation 记录绑定 stage/slice/task/evidence/
 *    snapshot 后才满足）；
 *  - 拒绝跨角色复用同一 Context（role 是 Context digest 的一部分，
 *    show 的 role 必须与 Context 的 role 一致）；
 *  - unknown role / 缺 stage / 无效 ref 在任何写入前 fail closed；
 *  - canonical envelope 与 built dist smoke（source/dist 同构、
 *    harness-neutral、fail-closed 零写入）。
 *
 * 测试通过 handler 直通入口（runContext / runContextFromArgv）与真实
 * built dist 进程验证；dispatcher 接线（proofloop.ts）按 S10-B-T01 先例由
 * Runtime direct-fix 接纳，spec 对 proofloop.js 只断言 fail-closed 合同
 * （exit 2 + canonical envelope + 零写入），接线前后稳定。
 */

import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ENOENT readdir 竞态固定（S11-A-T01 repair round 2）：node:fs 的 ESM 命名空间
// 不可配置，不能用 vi.spyOn 注入 readdirSync；改用文件级 vi.mock + hoisted
// 开关——仅在目标 cv 目录的 readdir 结果中追加一个磁盘上不存在的幻影
// 64-hex 名字，其余调用原样委托真实实现（对其它测试透明）。
const cvReaddirRace = vi.hoisted(() => ({
  active: false,
  cvDir: '',
  phantomName: '',
}));
// 非 ENOENT lstat 失败注入（S11-A-T01 repair round 3）：同一 vi.mock 机制，
// 仅对目标路径的 lstatSync 抛指定 errno（如 EACCES），其余调用委托真实实现
// ——用于证明“lstat 非 ENOENT 异常不得当作 ENOENT 竞态跳过”。
const cvLstatFail = vi.hoisted(() => ({
  active: false,
  targetPath: '',
  code: '',
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readdirSync: ((target: unknown, ...rest: unknown[]) => {
      const names = (actual.readdirSync as Function).apply(actual, [target, ...rest]);
      if (cvReaddirRace.active && typeof target === 'string' && target === cvReaddirRace.cvDir) {
        return [...(names as string[]), cvReaddirRace.phantomName];
      }
      return names;
    }) as typeof fs.readdirSync,
    lstatSync: ((target: unknown, ...rest: unknown[]) => {
      if (cvLstatFail.active && typeof target === 'string' && target === cvLstatFail.targetPath) {
        const error = new Error(`lstat failed with ${cvLstatFail.code}`) as NodeJS.ErrnoException;
        error.code = cvLstatFail.code;
        throw error;
      }
      return (actual.lstatSync as Function).apply(actual, [target, ...rest]);
    }) as typeof fs.lstatSync,
  } as typeof fs;
});
import { computeDigest, computeReceiptDigest, computeVNextSpvPassReceiptDigest, computeVNextStagePlanReceiptDigest } from '@proofloop/kernel';
import { admitVNextStagePlan, parseEntityMarkers, normalizeEntityText, normalizePlanExecutionProjection } from '../vnext';
import { runContext, runContextFromArgv, collectContextParams } from './proofloop-context';
import { parseCliArgs } from './proofloop-common';
import { nextActionFromInput } from './next-action';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_HANDLER = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'proofloop-context.js');
const DIST_PROOFLOOP = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');

const cleanups: string[] = [];
afterEach(() => {
  for (const root of cleanups.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// ============================================================
// Fixture: real S10 candidate boundary + admission authority
// ============================================================

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-context-'));
  cleanups.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'context@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Context Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  for (const pair of [
    ['delivery/stages/S10/tasks.md', 'delivery/stages/S10/tasks.md'],
    ['.proofloop/manifests/S10.json', '.proofloop/manifests/S10.json'],
    ['delivery/stages/S10/evidence/S10-B.md', 'delivery/stages/S10/evidence/S10-B.md'],
    ['tech-spec/task-acceptance-matrix.md', 'tech-spec/task-acceptance-matrix.md'],
    ['tech-spec/contract-state-matrix.md', 'tech-spec/contract-state-matrix.md'],
    ['tech-spec/ai-coding-architecture.md', 'tech-spec/ai-coding-architecture.md'],
    ['tech-spec/hard-parts-register.md', 'tech-spec/hard-parts-register.md'],
  ] as const) {
    const target = path.join(root, pair[1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, pair[0]), target);
  }
  // Fixture self-consistency（P-11 连带）：S10 Manifest 的 reference_index 绑定的是
  // replan 时工作树的 Authority digest（不可复现）；复制当前 Authority 文件后必须
  // 重算 file/section digest 并回写 fixture 内 Manifest，使 fixture 自洽，不再依赖
  // 真实仓库的 digest 状态（已完成/受限关闭 Stage 的 Manifest 是历史归档）。
  rebindFixtureManifestAuthorityDigests(root);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'S10 candidate boundary']);
  return root;
}

/**
 * Recompute the kernel digests of the copied Authority files and rewrite the
 * fixture Manifest's reference_index bindings so the fixture is self-consistent
 * regardless of the real repository's Authority state.
 *
 * Mirrors the resolver exactly: file_digest = sha256(normalizeReferenceFileText),
 * section_digest = sha256(canonicalPath + canonicalEntityRef + normalizedContent),
 * both via the exported normalizers (never a local re-implementation).
 */
function rebindFixtureManifestAuthorityDigests(root: string): void {
  const manifestPath = path.join(root, '.proofloop/manifests/S10.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    reference_index: Record<string, { ref: string; file_digest: string; section_digest?: string }>;
  };
  for (const entry of Object.values(manifest.reference_index)) {
    const ref = entry.ref;
    const hashIndex = ref.indexOf('#');
    if (hashIndex === -1) continue;
    const filePath = ref.slice(0, hashIndex);
    const absolute = path.join(root, filePath);
    if (!fs.existsSync(absolute)) continue;
    const content = fs.readFileSync(absolute, 'utf8');
    const isPlan = filePath.endsWith('tasks.md');
    const normalizedFile = isPlan ? normalizePlanExecutionProjection(content) : normalizeEntityText(content);
    entry.file_digest = sha256Hex(normalizedFile);
    const entityId = ref.slice(hashIndex + 1).replace(/^\/entities\//, '');
    // Section digest per §7.6: sha256(canonicalPath + canonicalEntityRef +
    // normalizeReferenceSectionText).  parseEntityMarkers always normalizes with
    // normalizeEntityText (L219) and does NOT apply the plan projection
    // normalizer, so for tasks.md we must recompute the section digest here
    // with the plan normalizer — mirroring the resolver exactly.
    const markers = parseEntityMarkers(content);
    const entity = markers.find((e) => e.id === entityId);
    if (entity !== undefined) {
      const sectionContent = isPlanRef(filePath)
        ? normalizePlanExecutionProjection(entity.content)
        : entity.content;
      entry.section_digest = sha256Hex(
        filePath.replace(/\\/g, '/') + ref + sectionContent,
      );
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/** True for plan-projection references (tasks.md); mirrors resolver isPlanReferencePath. */
function isPlanRef(filePath: string): boolean {
  return filePath.split('/').pop() === 'tasks.md';
}

/** Bare SHA-256 hex, matching the resolver's file/section digest formula. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

function admit(root: string): string {
  const snapshotDigest = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const manifestPath = path.join(root, '.proofloop/manifests/S10.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    plan: { plan_digest: string };
  };
  const manifestDigest = computeDigest(manifest);
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: 'S10',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
  };
  const request = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'STAGE_PLAN_ADMISSION' as const,
    project_root: root,
    manifest_path: '.proofloop/manifests/S10.json',
    stage_id: 'S10',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
    spv: { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) },
  };
  const result = admitVNextStagePlan(request);
  if (!result.accepted) throw new Error(result.findings[0].message);
  return snapshotDigest;
}

interface CliRun {
  readonly code: number;
  readonly envelope: Record<string, any>;
}

function runHandler(
  operation: string,
  params: Record<string, string | undefined>,
  root: string,
): CliRun {
  const envelope = runContext(root, 'auto', { domain: 'context', operation }, params);
  return { code: envelope.ok ? 0 : 2, envelope: envelope as unknown as Record<string, any> };
}

// ============================================================
// context prepare
// ============================================================

describe('context prepare（S10-B-T02）', () => {
  it('fails closed on an unknown role before any write', () => {
    const root = fixture();
    admit(root);
    const before = fs.readdirSync(path.join(root, '.proofloop'));
    const { code, envelope } = runHandler('prepare', { stage: 'S10', role: 'bogus-role' }, root);
    expect(code).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('unknown role');
    expect(envelope.refs).toEqual([]);
    expect(fs.readdirSync(path.join(root, '.proofloop'))).toEqual(before);
    expect(fs.existsSync(path.join(root, '.proofloop/context'))).toBe(false);
  });

  it('fails closed when stage is missing', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler('prepare', { role: 'worker' }, root);
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.STAGE_REQUIRED');
    expect(fs.existsSync(path.join(root, '.proofloop/context'))).toBe(false);
  });

  it('fails closed when the admission authority is missing', () => {
    const root = fixture();
    const { code, envelope } = runHandler('prepare', { stage: 'S10', role: 'worker' }, root);
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ADMISSION_AUTHORITY_MISSING');
    expect(fs.existsSync(path.join(root, '.proofloop/context'))).toBe(false);
  });

  it('fails closed when the Manifest is missing', () => {
    const root = fixture();
    admit(root);
    fs.rmSync(path.join(root, '.proofloop/manifests/S10.json'));
    const { code, envelope } = runHandler('prepare', { stage: 'S10', role: 'cv' }, root);
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.MANIFEST_NOT_FOUND');
  });

  it('projects the worker role through the dispatch seam identically to next', () => {
    const root = fixture();
    admit(root);
    const snapshot = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const prepared = runHandler('prepare', { stage: 'S10', role: 'worker' }, root);
    expect(prepared.envelope.ok).toBe(true);
    const result = prepared.envelope.result as { context_ref: string; context_digest: string };
    expect(result.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    expect(result.context_digest).toMatch(/^[a-f0-9]{64}$/);
    // prepare 通过 Runtime seam 落盘（digest-addressed，与 next persist 相同）
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, result.context_ref), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted.context_digest).toBe(result.context_digest);
    const withoutDigest = { ...persisted };
    delete withoutDigest.context_digest;
    expect(computeDigest(withoutDigest)).toBe(result.context_digest);
    expect(persisted.stage_id).toBe('S10');
    expect(persisted.slice_id).toBe('S10-A');
    expect(persisted.task_id).toBe('S10-A-T01');
    // fixture 复制的 tasks.md 中 S10-A-T01 checkbox 已勾（无 admitted receipt）：
    // CLI 与 next 用同一 checkbox 事实派生 recover-task（一致性更强，含 recover binding）
    expect(persisted.mode).toBe('recover-task');
    // 与 next 派发的 Context 一致可校验（同一投影规则；next 输出携带 context_ref）
    const next = nextActionFromInput({
      project_root: root,
      stage_id: 'S10',
      manifest_path: '.proofloop/manifests/S10.json',
      snapshot_digest: snapshot,
    }) as { context_ref?: string };
    expect(next.context_ref).toBe(result.context_ref);
    // ref digest 即 Context digest：next 派发的 ref 指向同一 digest-addressed Context
    expect(next.context_ref?.replace(/^\.proofloop\/context\//, '').replace(/\.json$/, ''))
      .toBe(result.context_digest);
  });

  it('projects a role-specific digest-bound Context for cv with the Evidence read gate', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    const result = envelope.result as {
      context_ref: string;
      context_digest: string;
      context: Record<string, any>;
    };
    expect(result.context.role).toBe('cv');
    expect(result.context.schema_version).toBe(2);
    expect(result.context.stage_id).toBe('S10');
    expect(result.context.slice_id).toBe('S10-B');
    expect(result.context.task_id).toBe('S10-B-T02');
    expect(result.context.manifest_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.context.plan_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.context.proof_index_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.context.snapshot_digest).toMatch(/^[a-f0-9]{40}$/);
    expect(result.context.evidence_path).toBe('delivery/stages/S10/evidence/S10-B.md');
    expect(result.context.plan_projection_path).toBe('delivery/stages/S10/tasks.md');
    // initial CV Evidence read gate 声明：必须 refutation-observation 且初始不满足
    expect(result.context.evidence_read_gate).toEqual({
      required: 'refutation-observation',
      satisfied: false,
    });
    // digest-bound：content digest 自洽且绑定 ref basename
    const withoutDigest = { ...result.context };
    delete withoutDigest.context_digest;
    expect(computeDigest(withoutDigest)).toBe(result.context_digest);
    expect(result.context_ref).toBe(`.proofloop/context/${result.context_digest}.json`);
    // S10-B-T02 repair: 全部角色经 Runtime seam write-once 落盘
    expect(fs.existsSync(path.join(root, result.context_ref))).toBe(true);
  });

  it('projects distinct digests for every closed role on the same tuple', () => {
    const root = fixture();
    admit(root);
    // worker 角色走 dispatch 投影（无 execution facts 时选首个 dependency-ready
    // slice S10-A-T01）；其余角色在同一 stage/slice/task tuple 上投影。
    const worker = runHandler('show', { stage: 'S10', role: 'worker' }, root);
    expect(worker.code).toBe(0);
    const roles = [
      'planning',
      'spv',
      'cv',
      'committer',
      'stage-reviewer',
      'project-reviewer',
    ];
    const digests = new Set<string>([
      (worker.envelope.result as { context_digest: string }).context_digest,
    ]);
    for (const role of roles) {
      const { code, envelope } = runHandler(
        'prepare',
        { stage: 'S10', role, slice: 'S10-B', task: 'S10-B-T02' },
        root,
      );
      expect(code, `role ${role} must project`).toBe(0);
      digests.add((envelope.result as { context_digest: string }).context_digest);
    }
    // 角色是 Context digest 的一部分：同一 stage/slice/task 下 7 个角色 digest 互不相同
    expect(digests.size).toBe(7);
  });

  it('fails closed on a non-canonical stage id', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler('prepare', { stage: 'S08B0', role: 'cv' }, root);
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
  });
});

// ============================================================
// context show
// ============================================================

describe('context show（S10-B-T02）', () => {
  it('fails closed on an unknown role', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler('show', { stage: 'S10', role: 'bogus' }, root);
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('unknown role');
  });

  it('fails closed when the referenced Context does not exist', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'show',
      { stage: 'S10', role: 'worker', ref: `.proofloop/context/${'a'.repeat(64)}.json` },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.NOT_FOUND');
  });

  it('shows a persisted worker Context when the role matches', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler('prepare', { stage: 'S10', role: 'worker' }, root);
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    const { code, envelope } = runHandler('show', { stage: 'S10', role: 'worker', ref }, root);
    expect(code).toBe(0);
    expect((envelope.result as { context: Record<string, unknown> }).context.context_digest)
      .toBe((prepared.envelope.result as { context_digest: string }).context_digest);
  });

  it('rejects cross-role reuse of the same Context (worker Context under cv role)', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler('prepare', { stage: 'S10', role: 'worker' }, root);
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    const { code, envelope } = runHandler('show', { stage: 'S10', role: 'cv', ref }, root);
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ROLE_MISMATCH');
  });

  it('projects (read-only) the cv Context and reports the gate unsatisfied without an observation', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'show',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    const result = envelope.result as { context: Record<string, any>; gate: Record<string, unknown> };
    expect(result.context.role).toBe('cv');
    expect(result.gate).toEqual({ required: 'refutation-observation', satisfied: false });
    // show 是只读：不落盘
    expect(fs.existsSync(path.join(root, '.proofloop/context'))).toBe(false);
  });

  it('satisfies the CV Evidence read gate when a bound refutation observation is supplied', () => {
    const root = fixture();
    admit(root);
    // CV Context 必须先 prepare（repair round 3 前置条件）
    const cvPrep = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(cvPrep.code).toBe(0);
    const admitted = runHandler(
      'admit-refutation-observation',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observation: 'initial CV counterexample: acceptance A envelope mismatch observed',
      },
      root,
    );
    expect(admitted.envelope.ok).toBe(true);
    const ref = (admitted.envelope.result as { ref: string }).ref;
    // 持久化记录存在（Runtime seam write-once）
    expect(fs.existsSync(path.join(root, ref))).toBe(true);
    const { code, envelope } = runHandler(
      'show',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observationRef: ref,
      },
      root,
    );
    expect(code).toBe(0);
    expect((envelope.result as { gate: Record<string, unknown> }).gate).toEqual({
      required: 'refutation-observation',
      satisfied: true,
    });
  });

  it('fails closed when the observation record does not bind the projected Context', () => {
    const root = fixture();
    admit(root);
    // CV Context 必须先 prepare（repair round 3 前置条件）
    const cvPrep = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(cvPrep.code).toBe(0);
    const admitted = runHandler(
      'admit-refutation-observation',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observation: 'observation bound to the same tuple',
      },
      root,
    );
    const record = (admitted.envelope.result as { observation: Record<string, unknown> }).observation;
    // 绑定错 task：观察记录绑定 S10-B-T02，Context 投影 S10-B-T01
    const ref = (admitted.envelope.result as { ref: string }).ref;
    const mismatched = runHandler(
      'show',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T01',
        observationRef: ref,
      },
      root,
    );
    expect(mismatched.code).toBe(2);
    expect(mismatched.envelope.findings[0].code).toBe('CONTEXT.OBSERVATION_INVALID');
    expect(mismatched.envelope.findings[0].message).toContain('task_id');
  });
});

// ============================================================
// context admit-refutation-observation
// ============================================================

describe('context admit-refutation-observation（S10-B-T02）', () => {
  it('fails closed when observation is missing', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'admit-refutation-observation',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.OBSERVATION_REQUIRED');
    expect(envelope.refs).toEqual([]);
  });

  it('fails closed on an unknown slice or task', () => {
    const root = fixture();
    admit(root);
    const missingSlice = runHandler(
      'admit-refutation-observation',
      { stage: 'S10', role: 'cv', slice: 'S10-Z', task: 'S10-B-T02', observation: 'x' },
      root,
    );
    expect(missingSlice.code).toBe(2);
    expect(missingSlice.envelope.findings[0].code).toBe('CONTEXT.SLICE_NOT_FOUND');
    const missingTask = runHandler(
      'admit-refutation-observation',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T99', observation: 'x' },
      root,
    );
    expect(missingTask.code).toBe(2);
    expect(missingTask.envelope.findings[0].code).toBe('CONTEXT.TASK_NOT_FOUND');
  });

  it('admits a digest-bound refutation observation bound to the CV Evidence gate', () => {
    const root = fixture();
    admit(root);
    // CV Context 必须先 prepare（repair round 3 前置条件）
    const cvPrep = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(cvPrep.code).toBe(0);
    const { code, envelope } = runHandler(
      'admit-refutation-observation',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observation: 'initial CV: Evidence read gate observation recorded before reading Evidence',
      },
      root,
    );
    expect(code).toBe(0);
    const result = envelope.result as {
      ref: string;
      digest: string;
      observation: Record<string, any>;
    };
    expect(result.ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.ref).toBe(`.proofloop/context/${result.digest}.json`);
    expect(result.observation.type).toBe('REFUTATION_OBSERVATION');
    expect(result.observation.role).toBe('cv');
    expect(result.observation.stage_id).toBe('S10');
    expect(result.observation.slice_id).toBe('S10-B');
    expect(result.observation.task_id).toBe('S10-B-T02');
    expect(result.observation.evidence_path).toBe('delivery/stages/S10/evidence/S10-B.md');
    expect(result.observation.snapshot_digest).toMatch(/^[a-f0-9]{40}$/);
    const withoutDigest = { ...result.observation };
    delete withoutDigest.context_digest;
    expect(computeDigest(withoutDigest)).toBe(result.digest);
    // 记录经 Runtime seam write-once 落盘（round 2：gate 只接受持久化记录）
    expect(fs.existsSync(path.join(root, result.ref))).toBe(true);
  });
});

// ============================================================
// argv 直通入口（flag 解析 + handler 分发）
// ============================================================

describe('context argv entry（S10-B-T02）', () => {
  it('parses closed flags and routes to the handler with a canonical envelope', () => {
    const root = fixture();
    admit(root);
    const parsed = parseCliArgs([
      'context',
      'prepare',
      '--json',
      '--role',
      'cv',
      '--stage',
      'S10',
      '--slice',
      'S10-B',
      '--task',
      'S10-B-T02',
    ]);
    expect(parsed.role).toBe('cv');
    expect(parsed.stage).toBe('S10');
    const params = collectContextParams(parsed, {
      domain: undefined,
      operation: undefined,
      stage: undefined,
      manifest: undefined,
      previous_manifest_digest: undefined,
      evidence_dir: undefined,
      mode: undefined,
      input_path: undefined,
      output_path: undefined,
      role: undefined,
      slice: undefined,
      task: undefined,
      observation: undefined,
      observation_ref: undefined,
      ref: undefined,
    });
    expect(params.role).toBe('cv');
    const envelope = runContextFromArgv(
      ['context', 'prepare', '--json', '--role', 'bogus', '--stage', 'S10'],
      { cwd: root },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].message).toContain('unknown role');
  });

  it('rejects an unknown flag with a USAGE envelope', () => {
    const root = fixture();
    admit(root);
    const envelope = runContextFromArgv(['context', 'prepare', '--bogus-flag', 'x'], { cwd: root });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('USAGE');
  });
});

// ============================================================
// built dist smoke（真实进程）
// ============================================================

describe('context built dist smoke（S10-B-T02）', () => {
  it('fails closed on the real built proofloop CLI for context commands (canonical envelope, zero write)', () => {
    const root = fixture();
    admit(root);
    const before = fs.readdirSync(path.join(root, '.proofloop'));
    const run = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'context', 'prepare', '--json', '--role', 'bogus', '--stage', 'S10'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stdout.trim().split('\n')[0]) as Record<string, any>;
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toEqual({ domain: 'context', operation: 'prepare' });
    expect(envelope.findings).toHaveLength(1);
    expect(Array.isArray(envelope.refs)).toBe(true);
    expect(run.stderr).toBe('');
    // 零写入：.proofloop 内容不变（dispatcher 未接线时 NOT_IMPLEMENTED；
    // 接线后 role 校验 finding——两种状态都满足 fail-closed 合同）
    expect(fs.readdirSync(path.join(root, '.proofloop'))).toEqual(before);
    expect(fs.existsSync(path.join(root, '.proofloop/context'))).toBe(false);
  });

  it('runs the built dist context handler with full role/gate semantics (source/dist parity)', () => {
    const root = fixture();
    admit(root);
    const script = [
      `const { runContextFromArgv } = require(process.argv[1]);`,
      `process.stdout.write(JSON.stringify(runContextFromArgv(process.argv.slice(2), { cwd: process.cwd() })));`,
    ].join('\n');
    // 未知角色 fail closed
    const unknownRole = spawnSync(
      process.execPath,
      ['-e', script, DIST_HANDLER, 'context', 'prepare', '--json', '--role', 'bogus', '--stage', 'S10'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(unknownRole.status).toBe(0); // handler 直通入口总是输出 envelope
    const rejected = JSON.parse(unknownRole.stdout) as Record<string, any>;
    expect(rejected.ok).toBe(false);
    expect(rejected.findings[0].message).toContain('unknown role');
    // cv 角色 prepare：role + Evidence read gate 声明
    const cvPrepare = spawnSync(
      process.execPath,
      [
        '-e',
        script,
        DIST_HANDLER,
        'context',
        'prepare',
        '--json',
        '--role',
        'cv',
        '--stage',
        'S10',
        '--slice',
        'S10-B',
        '--task',
        'S10-B-T02',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const projected = JSON.parse(cvPrepare.stdout) as Record<string, any>;
    expect(projected.ok).toBe(true);
    expect((projected.result.context as Record<string, any>).role).toBe('cv');
    expect((projected.result.context as Record<string, any>).evidence_read_gate).toEqual({
      required: 'refutation-observation',
      satisfied: false,
    });
    // admit-refutation-observation 语义：digest-bound observation
    const observation = spawnSync(
      process.execPath,
      [
        '-e',
        script,
        DIST_HANDLER,
        'context',
        'admit-refutation-observation',
        '--json',
        '--role',
        'cv',
        '--stage',
        'S10',
        '--slice',
        'S10-B',
        '--task',
        'S10-B-T02',
        '--observation',
        'dist smoke: initial CV observation recorded before Evidence read',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const admitted = JSON.parse(observation.stdout) as Record<string, any>;
    expect(admitted.ok).toBe(true);
    expect((admitted.result.observation as Record<string, any>).type).toBe('REFUTATION_OBSERVATION');
    expect((admitted.result.observation as Record<string, any>).role).toBe('cv');
    expect((admitted.result.digest as string)).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ============================================================
// S10-B-T02 repair：全角色持久化 / 角色语义字段 / show 重验证 / CV gate 强化
// ============================================================

describe('context prepare 全角色 Runtime write-once 持久化（S10-B-T02 repair）', () => {
  it('非 worker 角色 prepare 经 Runtime seam 落盘（digest-addressed）', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    const result = envelope.result as { context_ref: string; context_digest: string };
    const persistedPath = path.join(root, result.context_ref);
    expect(fs.existsSync(persistedPath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as Record<string, unknown>;
    expect(persisted.context_digest).toBe(result.context_digest);
    const withoutDigest = { ...persisted };
    delete withoutDigest.context_digest;
    expect(computeDigest(withoutDigest)).toBe(result.context_digest);
  });

  it('重复 prepare 同一角色幂等（已有文件不覆盖且内容一致）', () => {
    const root = fixture();
    admit(root);
    const first = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(first.code).toBe(0);
    const ref = (first.envelope.result as { context_ref: string }).context_ref;
    const second = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(second.code).toBe(0);
    expect((second.envelope.result as { context_ref: string }).context_ref).toBe(ref);
  });
});

describe('角色最低语义字段（S10-B-T02 repair，contract 0.5）', () => {
  it('planning: authority refs / selected work item refs', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler('prepare', { stage: 'S10', role: 'planning' }, root);
    expect(code).toBe(0);
    const roleFields = (envelope.result as { context: Record<string, any> }).context.role_fields;
    expect(Array.isArray(roleFields.authority_refs)).toBe(true);
    expect(roleFields.authority_refs.length).toBeGreaterThan(0);
  });

  it('spv: stage goal refs + authority digests binding', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler('prepare', { stage: 'S10', role: 'spv' }, root);
    expect(code).toBe(0);
    const context = (envelope.result as { context: Record<string, any> }).context;
    expect(context.role_fields.stage_goal_refs.length).toBeGreaterThan(0);
    expect(context.role_fields.authority_refs.length).toBeGreaterThan(0);
    expect(context.manifest_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(context.plan_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('cv: verification type + evidence_read:false（Initial CV 语义）', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    const context = (envelope.result as { context: Record<string, any> }).context;
    expect(context.role_fields.verification).toBe('initial');
    expect(context.role_fields.evidence_read).toBe(false);
    expect(context.evidence_read_gate).toEqual({
      required: 'refutation-observation',
      satisfied: false,
    });
  });

  it('committer: boundary 类型 + expected HEAD', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    const context = (envelope.result as { context: Record<string, any> }).context;
    expect(context.role_fields.boundary).toBe('slice-commit');
    expect(context.role_fields.expected_head).toMatch(/^[a-f0-9]{40}$/);
  });

  it('stage-reviewer / project-reviewer: review scope', () => {
    const root = fixture();
    admit(root);
    const stageReviewer = runHandler('prepare', { stage: 'S10', role: 'stage-reviewer' }, root);
    expect(stageReviewer.code).toBe(0);
    expect(
      (stageReviewer.envelope.result as { context: Record<string, any> }).context.role_fields.review_scope,
    ).toBe('stage');
    const projectReviewer = runHandler('prepare', { stage: 'S10', role: 'project-reviewer' }, root);
    expect(projectReviewer.code).toBe(0);
    expect(
      (projectReviewer.envelope.result as { context: Record<string, any> }).context.role_fields.review_scope,
    ).toBe('project');
  });
});

describe('context show --ref 重验证（S10-B-T02 repair）', () => {
  it('root_path 与当前 root 不一致 fail closed（跨项目 Context）', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    const persistedPath = path.join(root, ref);
    const context = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as Record<string, unknown>;
    // 构造自洽的 foreign-root Context（重算 digest，写入新 digest ref）
    const foreign = { ...context, root_path: '/tmp/foreign-root' } as Record<string, unknown>;
    delete foreign.context_digest;
    const foreignDigest = computeDigest(foreign);
    const foreignRef = `.proofloop/context/${foreignDigest}.json`;
    fs.writeFileSync(
      path.join(root, foreignRef),
      JSON.stringify({ ...foreign, context_digest: foreignDigest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler('show', { stage: 'S10', role: 'committer', ref: foreignRef }, root);
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ROOT_MISMATCH');
  });

  it('Manifest 已演进（stale Context）fail closed', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    // 篡改 manifest（stale）：合法字段内容变化 → manifest digest 变化
    const manifestPath = path.join(root, '.proofloop/manifests/S10.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const referenceIndex = manifest.reference_index as Record<string, Record<string, unknown>>;
    referenceIndex['REF-S10-B-T02'] = {
      ...referenceIndex['REF-S10-B-T02'],
      section_digest: 'c'.repeat(64),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const { code, envelope } = runHandler('show', { stage: 'S10', role: 'committer', ref }, root);
    expect(code).toBe(2);
    // manifest digest 变化后 authority 重验证先触发（repair round 3）
    expect(['CONTEXT.MANIFEST_BINDING', 'CONTEXT.ADMISSION_AUTHORITY_STALE']).toContain(envelope.findings[0].code);
  });
});

describe('CV Evidence read gate 强化（S10-B-T02 repair）', () => {
  it('admit-refutation-observation 缺少 role fail closed', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'admit-refutation-observation',
      { stage: 'S10', slice: 'S10-B', task: 'S10-B-T02', observation: 'x' },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ROLE_REQUIRED');
  });

  it('非 cv 角色被拒绝（CV-only 授权）', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'admit-refutation-observation',
      { stage: 'S10', role: 'worker', slice: 'S10-B', task: 'S10-B-T02', observation: 'x' },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.CV_ONLY');
  });

  it('observation 记录声明 evidence_read:false（提交先于 Evidence 读取）', () => {
    const root = fixture();
    admit(root);
    // CV Context 必须先 prepare（repair round 3 前置条件）
    const cvPrep = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(cvPrep.code).toBe(0);
    const { code, envelope } = runHandler(
      'admit-refutation-observation',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observation: 'initial CV observation before Evidence read',
      },
      root,
    );
    expect(code).toBe(0);
    const observation = (envelope.result as { observation: Record<string, any> }).observation;
    expect(observation.evidence_read).toBe(false);
    expect(observation.role).toBe('cv');
    expect(observation.task_id).toBe('S10-B-T02');
  });

  it('声称已读 Evidence 的 observation 不可满足 gate（fail closed）', () => {
    const root = fixture();
    admit(root);
    // CV Context 必须先 prepare（repair round 3 前置条件）
    const cvPrep = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(cvPrep.code).toBe(0);
    const admitted = runHandler(
      'admit-refutation-observation',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observation: 'observation submitted after Evidence was read',
      },
      root,
    );
    const ref = (admitted.envelope.result as { ref: string }).ref;
    // 伪造：调用者在盘上放置 evidence_read:true 的记录（绕过 admission 顺序）
    const record = (admitted.envelope.result as { observation: Record<string, unknown> }).observation;
    const forged = { ...record, evidence_read: true } as Record<string, unknown>;
    delete forged.context_digest;
    const forgedDigest = computeDigest(forged);
    const forgedRef = `.proofloop/context/${forgedDigest}.json`;
    fs.writeFileSync(
      path.join(root, forgedRef),
      JSON.stringify({ ...forged, context_digest: forgedDigest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'show',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observationRef: forgedRef,
      },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.OBSERVATION_INVALID');
    expect(envelope.findings[0].message).toMatch(/read/);
  });

  it('拒绝未持久化的伪造 observation（gate 只接受 Runtime 落盘记录）', () => {
    const root = fixture();
    admit(root);
    // 伪造：调用者自声明 record（从未经 admit 落盘），show 传其 ref → NOT_FOUND
    const { code, envelope } = runHandler(
      'show',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observationRef: `.proofloop/context/${'b'.repeat(64)}.json`,
      },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.OBSERVATION_NOT_FOUND');
  });
});

// ============================================================
// S10-B-T02 repair round 2：0.5 完整 role_fields / reference stale / 伪造拒绝
// ============================================================

describe('0.5 完整角色语义字段（S10-B-T02 repair round 2）', () => {
  it('cv: proof refs（goal/task/acceptance/seam/oracle/risk）', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    const rf = (envelope.result as { context: Record<string, any> }).context.role_fields;
    expect(rf.verification).toBe('initial');
    expect(rf.evidence_read).toBe(false);
    expect(rf.goal_refs).toEqual(['REF-S10-B-GOAL']);
    expect(rf.task_refs).toContain('REF-S10-B-T01');
    expect(rf.task_refs).toContain('REF-S10-B-T02');
    expect(rf.acceptance_refs).toContain('REF-CLI-ACCEPTANCE');
    expect(rf.seam_refs).toContain('REF-CLI-SEAM');
    expect(rf.oracle_refs).toContain('REF-CLI-ORACLE');
    expect(rf.risk_refs).toContain('REF-S08E-RISK');
  });

  it('committer: receipt refs + changed files（持久化事实）', () => {
    const root = fixture();
    admit(root);
    // fixture 无 worker receipts → 空数组仍必须存在
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    const context = (envelope.result as { context: Record<string, any> }).context;
    expect(context.role_fields.boundary).toBe('slice-commit');
    expect(context.role_fields.expected_head).toMatch(/^[a-f0-9]{40}$/);
    expect(Array.isArray(context.role_fields.receipt_refs)).toBe(true);
    expect(Array.isArray(context.role_fields.changed_files)).toBe(true);
  });

  it('stage-reviewer / project-reviewer: 完整 review refs', () => {
    const root = fixture();
    admit(root);
    const stageReviewer = runHandler('prepare', { stage: 'S10', role: 'stage-reviewer' }, root);
    expect(stageReviewer.code).toBe(0);
    const sr = (stageReviewer.envelope.result as { context: Record<string, any> }).context.role_fields;
    expect(sr.review_scope).toBe('stage');
    expect(sr.integrated_snapshot).toMatch(/^[a-f0-9]{40}$/);
    expect(sr.acceptance_refs).toContain('REF-CLI-ACCEPTANCE');
    expect(sr.seam_refs).toContain('REF-CLI-SEAM');
    expect(sr.oracle_refs).toContain('REF-CLI-ORACLE');
    expect(sr.risk_refs.length).toBeGreaterThan(0);
    const projectReviewer = runHandler('prepare', { stage: 'S10', role: 'project-reviewer' }, root);
    expect(projectReviewer.code).toBe(0);
    const pr = (projectReviewer.envelope.result as { context: Record<string, any> }).context.role_fields;
    expect(pr.review_scope).toBe('project');
    expect(pr.acceptance_refs).toContain('REF-CLI-ACCEPTANCE');
  });

  it('show --ref 读回时逐字段校验 role_fields（缺字段 fail closed）', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler(
      'prepare',
      { stage: 'S10', role: 'stage-reviewer' },
      root,
    );
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    // 篡改落盘 Context：删除 role_fields 的 risk_refs（digest 自洽重算）
    const persistedPath = path.join(root, ref);
    const context = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as Record<string, any>;
    delete context.role_fields.risk_refs;
    delete context.context_digest;
    const tamperedDigest = computeDigest(context);
    const tamperedRef = `.proofloop/context/${tamperedDigest}.json`;
    fs.writeFileSync(
      path.join(root, tamperedRef),
      JSON.stringify({ ...context, context_digest: tamperedDigest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'show',
      { stage: 'S10', role: 'stage-reviewer', ref: tamperedRef },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ROLE_FIELDS_INVALID');
  });
});

describe('context show --ref reference binding（S10-B-T02 repair round 2）', () => {
  it('引用源 stale（reference 文件内容变化、Manifest digest 不变）fail closed', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    const manifestBefore = fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8');
    // 修改引用源文件（fixture 的 tasks.md 副本）——Manifest 文件本身不变
    const tasksPath = path.join(root, 'delivery/stages/S10/tasks.md');
    fs.appendFileSync(tasksPath, '\n<!-- repair round 2 stale source -->\n');
    const manifestAfter = fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8');
    expect(manifestAfter).toBe(manifestBefore); // Manifest digest 确实不变
    const { code, envelope } = runHandler('show', { stage: 'S10', role: 'committer', ref }, root);
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.REFERENCE_MISMATCH');
  });
});

// ============================================================
// S10-B-T02 repair round 2：built public proofloop 进程级回归
// ============================================================

describe('built public proofloop context 进程级（S10-B-T02 repair round 2）', () => {
  const DIST_PROOFLOOP = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');

  it('dist: 7 角色 context prepare 全部 exit 0（digest-bound + 落盘）', () => {
    const root = fixture();
    admit(root);
    const roles = [
      'planning', 'spv', 'worker', 'cv', 'committer', 'stage-reviewer', 'project-reviewer',
    ];
    for (const role of roles) {
      const args = ['context', 'prepare', '--json', '--role', role, '--stage', 'S10'];
      if (role === 'cv' || role === 'committer') args.push('--slice', 'S10-B', '--task', 'S10-B-T02');
      const run = spawnSync(process.execPath, [DIST_PROOFLOOP, ...args], { cwd: root, encoding: 'utf8' });
      expect(run.status, `role ${role} must exit 0: ${run.stdout.slice(0, 200)}`).toBe(0);
      const envelope = JSON.parse(run.stdout.trim().split('\n')[0]) as Record<string, any>;
      expect(envelope.ok).toBe(true);
      expect((envelope.result as { context_ref: string }).context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
      // 全角色经 Runtime seam 落盘
      expect(fs.existsSync(path.join(root, (envelope.result as { context_ref: string }).context_ref))).toBe(true);
    }
  });

  it('dist: context show --ref stale（引用源变化）exit 2', () => {
    const root = fixture();
    admit(root);
    const prep = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'context', 'prepare', '--json', '--role', 'committer', '--stage', 'S10', '--slice', 'S10-B', '--task', 'S10-B-T02'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(prep.status).toBe(0);
    const ref = (JSON.parse(prep.stdout.trim().split('\n')[0]) as Record<string, any>).result.context_ref;
    // 引用源变化（tasks.md append），Manifest 文件不变
    fs.appendFileSync(path.join(root, 'delivery/stages/S10/tasks.md'), '\n<!-- stale source -->\n');
    const show = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'context', 'show', '--json', '--role', 'committer', '--stage', 'S10', '--ref', ref],
      { cwd: root, encoding: 'utf8' },
    );
    expect(show.status).toBe(2);
    const envelope = JSON.parse(show.stdout.trim().split('\n')[0]) as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('CONTEXT.REFERENCE_MISMATCH');
  });

  it('dist: CV gate 只接受持久化 observation（伪造拒绝 + 顺序绑定）', () => {
    const root = fixture();
    admit(root);
    // CV Context 必须先 prepare（repair round 3 前置条件）
    const cvPrep = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'context', 'prepare', '--json', '--role', 'cv', '--stage', 'S10', '--slice', 'S10-B', '--task', 'S10-B-T02'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(cvPrep.status).toBe(0);
    const admitRun = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'context', 'admit-refutation-observation', '--json',
        '--role', 'cv', '--stage', 'S10', '--slice', 'S10-B', '--task', 'S10-B-T02',
        '--observation', 'dist smoke: initial CV observation before Evidence read',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(admitRun.status).toBe(0);
    const admitEnvelope = JSON.parse(admitRun.stdout.trim().split('\n')[0]) as Record<string, any>;
    const ref = (admitEnvelope.result as { ref: string }).ref;
    expect(fs.existsSync(path.join(root, ref))).toBe(true);
    // gate satisfied via persisted ref
    const showOk = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'context', 'show', '--json',
        '--role', 'cv', '--stage', 'S10', '--slice', 'S10-B', '--task', 'S10-B-T02',
        '--observation-ref', ref,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(showOk.status).toBe(0);
    expect((JSON.parse(showOk.stdout.trim().split('\n')[0]) as Record<string, any>).result.gate).toEqual({
      required: 'refutation-observation',
      satisfied: true,
    });
    // 伪造：未持久化的 ref → exit 2（OBSERVATION_NOT_FOUND）
    const forged = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'context', 'show', '--json',
        '--role', 'cv', '--stage', 'S10', '--slice', 'S10-B', '--task', 'S10-B-T02',
        '--observation-ref', `.proofloop/context/${'b'.repeat(64)}.json`,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(forged.status).toBe(2);
    expect((JSON.parse(forged.stdout.trim().split('\n')[0]) as Record<string, any>).findings[0].code)
      .toBe('CONTEXT.OBSERVATION_NOT_FOUND');
  });
});

// ============================================================
// S10-B-T02 repair round 3：逐值校验 / tuple / CV Context 前置 / provenance
// ============================================================

describe('cv recheck verification 类型（S10-B-T02 repair round 3）', () => {
  it('存在 CV_REPAIR receipt 时 verification=recheck 且携带 previous_failure_signature', () => {
    const root = fixture();
    const snapshot = admit(root);
    // 合法 CV_REPAIR 链 fixture（S11-A-T01 链语义）：genesis 必须是
    // verification_type=initial 的 CV_REPAIR（无 previous_digest）；后继 recheck
    // 的 previous_digest 指向前者、previous_failure_signature 精确匹配前者
    // failure_signature、repair_diff_digest 合法。链 tip 投影 recheck 事实。
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'FIXTURE-SIG-000',
        failedCriterion: 'fixture criterion (genesis)',
        counterexamples: ['fixture counterexample (genesis)'],
        requiredRecheckScope: ['fixture recheck scope (genesis)'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'FIXTURE-SIG-001',
        previousFailureSignature: 'FIXTURE-SIG-000',
        repairDiffDigest: 'a1'.repeat(32),
        failedCriterion: 'fixture criterion',
        counterexamples: ['fixture counterexample'],
        requiredRecheckScope: ['fixture recheck scope'],
      },
    ]);
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    const rf = (envelope.result as { context: Record<string, any> }).context.role_fields;
    expect(rf.verification).toBe('recheck');
    expect(rf.previous_failure_signature).toBe('FIXTURE-SIG-001');
  });
});

describe('role_fields 逐值读回校验（S10-B-T02 repair round 3）', () => {
  it('修改 role_fields 值并重算 digest 后 show 必须拒绝（引用不在 manifest）', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler('prepare', { stage: 'S10', role: 'stage-reviewer' }, root);
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    const persistedPath = path.join(root, ref);
    const context = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as Record<string, any>;
    context.role_fields.acceptance_refs = ['REF-BOGUS-ACCEPTANCE'];
    delete context.context_digest;
    const tamperedDigest = computeDigest(context);
    const tamperedRef = `.proofloop/context/${tamperedDigest}.json`;
    fs.writeFileSync(
      path.join(root, tamperedRef),
      JSON.stringify({ ...context, context_digest: tamperedDigest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler('show', { stage: 'S10', role: 'stage-reviewer', ref: tamperedRef }, root);
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ROLE_FIELDS_INVALID');
    expect(envelope.findings[0].message).toMatch(/REF-BOGUS-ACCEPTANCE/);
  });

  it('修改 role_fields 值（expected_head 与当前 snapshot 不一致）show 必须拒绝', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    const persistedPath = path.join(root, ref);
    const context = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as Record<string, any>;
    context.role_fields.expected_head = 'f'.repeat(40);
    delete context.context_digest;
    const tamperedDigest = computeDigest(context);
    const tamperedRef = `.proofloop/context/${tamperedDigest}.json`;
    fs.writeFileSync(
      path.join(root, tamperedRef),
      JSON.stringify({ ...context, context_digest: tamperedDigest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'show',
      { stage: 'S10', role: 'committer', ref: tamperedRef },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ROLE_FIELDS_INVALID');
  });
});

describe('show/prepare 请求 tuple 校验（S10-B-T02 repair round 3）', () => {
  it('show --ref 请求 slice 与 Context 不一致拒绝（CONTEXT.TUPLE_MISMATCH）', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    const { code, envelope } = runHandler(
      'show',
      { stage: 'S10', role: 'committer', slice: 'S10-A', task: 'S10-A-T01', ref },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.TUPLE_MISMATCH');
  });

  it('show --ref 请求 task 与 Context 不一致拒绝（CONTEXT.TUPLE_MISMATCH）', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    const { code, envelope } = runHandler(
      'show',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T01', ref },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.TUPLE_MISMATCH');
  });

  it('prepare worker 指定请求 task 与 dispatch 选中的 task 不一致拒绝', () => {
    const root = fixture();
    admit(root);
    // fixture 无 task receipts：dispatch 选 S10-A-T01（checkbox 已勾 → recover-task）
    // 请求 task S10-B-T02 与 dispatch task 不一致 → 拒绝
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'worker', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.TUPLE_MISMATCH');
  });
});

describe('CV Context 前置与 provenance（S10-B-T02 repair round 3）', () => {
  it('admit-refutation-observation 在无 CV Context 时 fail closed（CONTEXT.CV_CONTEXT_REQUIRED）', () => {
    const root = fixture();
    admit(root);
    const { code, envelope } = runHandler(
      'admit-refutation-observation',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observation: 'no CV context yet',
      },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.CV_CONTEXT_REQUIRED');
  });

  it('admit 记录携带 provenance（cv_context_ref/digest + recorded_at）', () => {
    const root = fixture();
    admit(root);
    const cvPrep = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(cvPrep.code).toBe(0);
    const cvRef = (cvPrep.envelope.result as { context_ref: string }).context_ref;
    const cvDigest = (cvPrep.envelope.result as { context_digest: string }).context_digest;
    const admitted = runHandler(
      'admit-refutation-observation',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observation: 'provenance observation',
      },
      root,
    );
    expect(admitted.code).toBe(0);
    const observation = (admitted.envelope.result as { observation: Record<string, any> }).observation;
    expect(observation.cv_context_ref).toBe(cvRef);
    expect(observation.cv_context_digest).toBe(cvDigest);
    expect(typeof observation.recorded_at).toBe('string');
    expect(observation.recorded_at.length).toBeGreaterThan(0);
  });

  it('伪造 observation（cv_context 指向不存在 Context）gate 拒绝', () => {
    const root = fixture();
    admit(root);
    const cvPrep = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    const cvRef = (cvPrep.envelope.result as { context_ref: string }).context_ref;
    const admitted = runHandler(
      'admit-refutation-observation',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observation: 'forged provenance test',
      },
      root,
    );
    const record = (admitted.envelope.result as { observation: Record<string, any> }).observation;
    // 伪造：cv_context_digest 改为指向不存在的 Context（digest 自洽重算）
    const forged = { ...record, cv_context_ref: `.proofloop/context/${'d'.repeat(64)}.json`, cv_context_digest: 'd'.repeat(64) } as Record<string, any>;
    delete forged.context_digest;
    const forgedDigest = computeDigest(forged);
    const forgedRef = `.proofloop/context/${forgedDigest}.json`;
    fs.writeFileSync(
      path.join(root, forgedRef),
      JSON.stringify({ ...forged, context_digest: forgedDigest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'show',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observationRef: forgedRef,
      },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.OBSERVATION_INVALID');
    expect(envelope.findings[0].message).toMatch(/provenance/);
  });
});

describe('resolveManifestAuthority 重验证（S10-B-T02 repair round 3）', () => {
  it('stale authority（manifest_digest 不匹配当前 Manifest）prepare fail closed', () => {
    const root = fixture();
    admit(root);
    // 篡改 SPV authority：manifest_digest 改变但 receipt 保持自洽（digest 重算）
    const spvPath = path.join(root, '.proofloop/receipts/plan/S10/vnext-spv-pass.json');
    const spv = JSON.parse(fs.readFileSync(spvPath, 'utf8')) as Record<string, any>;
    const { digest: _spvDigest, ...spvBody } = spv;
    const tamperedSpv = { ...spvBody, manifest_digest: 'c'.repeat(64) };
    fs.writeFileSync(
      spvPath,
      JSON.stringify({ ...tamperedSpv, digest: computeVNextSpvPassReceiptDigest(tamperedSpv as never) }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ADMISSION_AUTHORITY_STALE');
  });
});

// ============================================================
// S10-B-T02 repair round 3：public CLI CV Context 前置回归
// ============================================================

describe('built public proofloop CV Context 前置（S10-B-T02 repair round 3）', () => {
  const DIST_PROOFLOOP = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');

  it('dist: 无 CV Context 时 admit-refutation-observation exit 2（CONTEXT.CV_CONTEXT_REQUIRED）', () => {
    const root = fixture();
    admit(root);
    const run = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'context', 'admit-refutation-observation', '--json',
        '--role', 'cv', '--stage', 'S10', '--slice', 'S10-B', '--task', 'S10-B-T02',
        '--observation', 'no cv context',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stdout.trim().split('\n')[0]) as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('CONTEXT.CV_CONTEXT_REQUIRED');
    // 零写入：.proofloop/context 无 observation 记录
    const ctxDir = path.join(root, '.proofloop', 'context');
    const names = fs.existsSync(ctxDir) ? fs.readdirSync(ctxDir) : [];
    expect(names.every((name) => !name.includes('observations'))).toBe(true);
  });
});

// ============================================================
// S10-B-T02 repair round 4（diagnose 模式）：先复现再修
// ============================================================

describe('round 4 复现：CV Context 类型与 provenance（S10-B-CLI-RECHECK-ROLE-RECEIPT-PROVENANCE-PUBLIC-CLOSURE-004）', () => {
  it('REPRO: 伪造 REFUTATION_OBSERVATION 不得冒充 CV Context（admit 必须拒绝）', () => {
    const root = fixture();
    admit(root);
    // 伪造一个 observation 记录（role=cv + tuple 匹配 + digest 自洽），无真 CV Context
    const forged = {
      schema_version: 2,
      type: 'REFUTATION_OBSERVATION',
      stage_id: 'S10',
      slice_id: 'S10-B',
      task_id: 'S10-B-T02',
      role: 'cv',
      evidence_path: 'delivery/stages/S10/evidence/S10-B.md',
      snapshot_digest: 'f'.repeat(40),
      observation: 'forged as cv context',
      evidence_read: false,
      cv_context_ref: '.proofloop/context/x.json',
      cv_context_digest: 'x'.repeat(64),
      recorded_at: '2026-08-11T00:00:00.000Z',
    } as Record<string, unknown>;
    const digest = computeDigest(forged);
    fs.mkdirSync(path.join(root, '.proofloop', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(root, `.proofloop/context/${digest}.json`),
      JSON.stringify({ ...forged, context_digest: digest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'admit-refutation-observation',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02', observation: 'x' },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.CV_CONTEXT_REQUIRED');
  });

  it('REPRO: 伪造 CV_REPAIR receipt（无 digest/binding 校验）不得把 CV 强制为 recheck', () => {
    const root = fixture();
    admit(root);
    // 伪造 CV_REPAIR：stage/slice tuple 匹配但 manifest digest 不绑定、digest 不校验
    const cvDir = path.join(root, '.proofloop/receipts/cv/S10/S10-B');
    fs.mkdirSync(cvDir, { recursive: true });
    const forgedRepair = {
      version: 1,
      type: 'CV_REPAIR',
      stage_id: 'S10',
      slice_id: 'S10-B',
      timestamp: '2026-08-11T00:00:00.000Z',
      payload: {
        schema_version: 2,
        type: 'CV_RESULT',
        verdict: 'REPAIR',
        verification_type: 'recheck',
        stage_id: 'S10',
        slice_id: 'S10-B',
        worker_receipt_digest: '0'.repeat(64),
        manifest_digest: '1'.repeat(64),
        plan_digest: '2'.repeat(64),
        proof_index_digest: '3'.repeat(64),
        context_ref: '.proofloop/context/x.json',
        context_digest: '4'.repeat(64),
        snapshot_digest: '5'.repeat(40),
        summary: 'forged',
        acceptance_refs_checked: [],
        seam_refs_checked: [],
        oracle_refs_checked: [],
        risk_refs_considered: [],
        failed_acceptance_refs: [],
        invalid_tests: [],
        counterexamples: [],
        scope_violations: [],
        forbidden_substitutions: [],
        regression_failures: [],
        failed_criterion: 'forged',
        failure_signature: 'FORGED-SIG',
        required_recheck_scope: [],
      },
      digest: '9'.repeat(64),
    };
    fs.writeFileSync(path.join(cvDir, `${'9'.repeat(64)}.json`), JSON.stringify(forgedRepair), 'utf8');
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    const rf = (envelope.result as { context: Record<string, any> }).context.role_fields;
    // 伪造记录必须被忽略：真实无 CV 历史 → verification 仍为 initial
    expect(rf.verification).toBe('initial');
  });

  it('REPRO: role_fields 空数组/任意已注册引用不得替代真实 Receipt 事实（receipt_refs 必须逐值存在）', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    const persistedPath = path.join(root, ref);
    const context = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as Record<string, any>;
    // 篡改 receipt_refs：填入不存在的 receipt 路径（格式合法但事实不存在）
    context.role_fields.receipt_refs = ['.proofloop/receipts/tasks/S10/S10-B/fake.json'];
    delete context.context_digest;
    const tamperedDigest = computeDigest(context);
    const tamperedRef = `.proofloop/context/${tamperedDigest}.json`;
    fs.writeFileSync(
      path.join(root, tamperedRef),
      JSON.stringify({ ...context, context_digest: tamperedDigest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'show',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02', ref: tamperedRef },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ROLE_FIELDS_INVALID');
  });

  it('REPRO: worker Context show 不得跳过 read-back 校验（篡改 proof_index 后必须拒绝）', () => {
    const root = fixture();
    admit(root);
    const prepared = runHandler('prepare', { stage: 'S10', role: 'worker' }, root);
    const ref = (prepared.envelope.result as { context_ref: string }).context_ref;
    const persistedPath = path.join(root, ref);
    const context = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as Record<string, any>;
    // 篡改 proof_index（task_refs 增加伪造 ref）并重算 digest
    context.proof_index.task_refs = [...context.proof_index.task_refs, 'REF-FORGED-TASK'];
    delete context.context_digest;
    const tamperedDigest = computeDigest(context);
    const tamperedRef = `.proofloop/context/${tamperedDigest}.json`;
    fs.writeFileSync(
      path.join(root, tamperedRef),
      JSON.stringify({ ...context, context_digest: tamperedDigest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler('show', { stage: 'S10', role: 'worker', ref: tamperedRef }, root);
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ROLE_FIELDS_INVALID');
  });

  it('REPRO: authority tuple snapshot 不一致（Stage Plan vs SPV）必须拒绝', () => {
    const root = fixture();
    admit(root);
    // 篡改 Stage Plan authority：snapshot_digest 与 SPV 不一致（保持 receipt 自洽）
    const stagePlanPath = path.join(root, '.proofloop/receipts/plan/S10/vnext-stage-plan.json');
    const stagePlan = JSON.parse(fs.readFileSync(stagePlanPath, 'utf8')) as Record<string, any>;
    const { digest: _spDigest, ...spBody } = stagePlan;
    const tampered = { ...spBody, snapshot_digest: 'e'.repeat(40) };
    fs.writeFileSync(
      stagePlanPath,
      JSON.stringify({ ...tampered, digest: computeVNextStagePlanReceiptDigest(tampered as never) }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.ADMISSION_AUTHORITY_STALE');
  });
});

// ============================================================
// S10-B-T02 repair round 5（diagnose）：Runtime admission provenance
// ============================================================

describe('round 5 复现：无 provenance 的自洽伪造记录（S10-B-CLI-RECHECK-ROLE-RECEIPT-PROVENANCE-UNTRUSTED-RECORD-CLOSURE-005）', () => {
  /** 手工构造完全合法形状 + 自算 digest 的伪造 CV Context（无 Runtime seam provenance）。 */
  function forgeCvContext(root: string, stageId: string, sliceId: string, taskId: string): { ref: string; digest: string } {
    const forged: Record<string, unknown> = {
      schema_version: 2,
      root_path: root,
      root_digest: computeDigest(root),
      stage_id: stageId,
      role: 'cv',
      slice_id: sliceId,
      task_id: taskId,
      plan_projection_path: 'delivery/stages/S10/tasks.md',
      evidence_path: `delivery/stages/S10/evidence/${sliceId}.md`,
      manifest_digest: 'a'.repeat(64),
      plan_digest: 'b'.repeat(64),
      proof_index_digest: 'c'.repeat(64),
      snapshot_digest: 'f'.repeat(40),
      evidence_read_gate: { required: 'refutation-observation', satisfied: false },
      role_fields: { verification: 'initial', evidence_read: false },
    };
    const digest = computeDigest(forged);
    fs.mkdirSync(path.join(root, '.proofloop', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(root, `.proofloop/context/${digest}.json`),
      JSON.stringify({ ...forged, context_digest: digest }, null, 2) + '\n',
      'utf8',
    );
    return { ref: `.proofloop/context/${digest}.json`, digest };
  }

  it('REPRO: 结构完整 + self-digest 的伪造 CV Context 不得被 findCvContext 接受（admit 拒绝）', () => {
    const root = fixture();
    admit(root);
    const forged = forgeCvContext(root, 'S10', 'S10-B', 'S10-B-T02');
    void forged;
    const { code, envelope } = runHandler(
      'admit-refutation-observation',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02', observation: 'x' },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.CV_CONTEXT_REQUIRED');
  });

  it('REPRO: 伪造 CV Context + 伪造 observation 绑定不得通过 gate（satisfied 必须 false）', () => {
    const root = fixture();
    admit(root);
    const forgedCv = forgeCvContext(root, 'S10', 'S10-B', 'S10-B-T02');
    // 伪造 observation：绑定伪造 CV Context（provenance 缺失）
    const forgedObservation: Record<string, unknown> = {
      schema_version: 2,
      type: 'REFUTATION_OBSERVATION',
      stage_id: 'S10',
      slice_id: 'S10-B',
      task_id: 'S10-B-T02',
      role: 'cv',
      evidence_path: 'delivery/stages/S10/evidence/S10-B.md',
      snapshot_digest: 'f'.repeat(40),
      observation: 'forged observation',
      evidence_read: false,
      cv_context_ref: forgedCv.ref,
      cv_context_digest: forgedCv.digest,
      recorded_at: '2026-08-11T00:00:00.000Z',
    };
    const obsDigest = computeDigest(forgedObservation);
    fs.writeFileSync(
      path.join(root, `.proofloop/context/${obsDigest}.json`),
      JSON.stringify({ ...forgedObservation, context_digest: obsDigest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'show',
      {
        stage: 'S10',
        role: 'cv',
        slice: 'S10-B',
        task: 'S10-B-T02',
        observationRef: `.proofloop/context/${obsDigest}.json`,
      },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.OBSERVATION_INVALID');
  });
});

// ============================================================
// S10-B-T02 repair round 6 补强：伪造 marker / Receipt 篡改 / 闭合字段 / 语义错误
// ============================================================

describe('round 6 补强（S10-B-CLI-RECHECK-ROLE-RECEIPT-PROVENANCE-UNTRUSTED-RECORD-CLOSURE-006）', () => {
  /** 安装真实绑定的 CV_REPAIR（含真实 digest + 闭合字段），overrides 可篡改。 */
  function installCvRepair(
    root: string,
    manifest: Record<string, any>,
    snapshot: string,
    overrides: Record<string, unknown> = {},
  ): { workerReceiptDigest: string; cvRepairDigest: string } {
    const slice = manifest.slices.find((c: Record<string, any>) => c.slice_id === 'S10-B');
    const proofIndex = slice.proof_index as Record<string, any>;
    const proofIndexDigest = computeDigest(proofIndex);
    const cvContextDigest = 'e'.repeat(64);
    const taskDir = path.join(root, '.proofloop/receipts/tasks/S10/S10-B');
    fs.mkdirSync(taskDir, { recursive: true });
    const workerPayload = {
      schema_version: 2,
      action_token: 'r6-worker-token',
      mode: 'implement-task',
      outcome: 'completed',
      task_id: 'S10-B-T02',
      evidence_ref: 'delivery/stages/S10/evidence/S10-B.md',
      changed_files: ['delivery/stages/S10/evidence/S10-B.md', 'delivery/stages/S10/tasks.md'],
      verification_runs: [],
      summary: 'fixture worker',
      manifest_digest: computeDigest(manifest),
      plan_digest: manifest.plan.plan_digest,
      proof_index_digest: proofIndexDigest,
      snapshot_digest: snapshot,
      context_ref: `.proofloop/context/${cvContextDigest}.json`,
      context_digest: cvContextDigest,
    };
    const workerReceiptWithoutDigest = {
      version: 1,
      type: 'TASK_COMPLETE',
      stage_id: 'S10',
      slice_id: 'S10-B',
      timestamp: '2026-08-11T00:00:00.000Z',
      payload: workerPayload,
    };
    const workerReceiptDigest = computeReceiptDigest(workerReceiptWithoutDigest);
    fs.writeFileSync(
      path.join(taskDir, `${workerReceiptDigest}.json`),
      JSON.stringify({ ...workerReceiptWithoutDigest, digest: workerReceiptDigest }, null, 2) + '\n',
      'utf8',
    );
    const cvPayload = {
      schema_version: 2,
      type: 'CV_RESULT',
      verdict: 'REPAIR',
      verification_type: 'recheck',
      stage_id: 'S10',
      slice_id: 'S10-B',
      worker_receipt_digest: workerReceiptDigest,
      manifest_digest: computeDigest(manifest),
      plan_digest: manifest.plan.plan_digest,
      proof_index_digest: proofIndexDigest,
      context_ref: `.proofloop/context/${cvContextDigest}.json`,
      context_digest: cvContextDigest,
      snapshot_digest: snapshot,
      summary: 'fixture repair',
      acceptance_refs_checked: [...proofIndex.acceptance_refs],
      seam_refs_checked: [...proofIndex.seam_refs],
      oracle_refs_checked: [...proofIndex.oracle_refs],
      risk_refs_considered: proofIndex.risk_refs.map((r: Record<string, any>) => ({
        ref_id: r.ref_id,
        applicability: 'NOT_APPLICABLE',
        reason: 'fixture',
      })),
      failed_acceptance_refs: [],
      invalid_tests: [],
      counterexamples: ['fixture counterexample'],
      scope_violations: [],
      forbidden_substitutions: [],
      regression_failures: [],
      failed_criterion: 'fixture criterion',
      failure_signature: 'FIXTURE-SIG-001',
      required_recheck_scope: ['fixture recheck scope'],
      previous_failure_signature: 'PREVIOUS-SIG-000',
      repair_diff_digest: 'a1'.repeat(32),
      ...overrides,
    };
    const cvRepairWithoutDigest = {
      version: 1,
      type: 'CV_REPAIR',
      stage_id: 'S10',
      slice_id: 'S10-B',
      timestamp: '2026-08-11T00:00:00.000Z',
      payload: cvPayload,
    };
    const cvRepairDigest = computeReceiptDigest(cvRepairWithoutDigest);
    const cvDir = path.join(root, '.proofloop/receipts/cv/S10/S10-B');
    fs.mkdirSync(cvDir, { recursive: true });
    fs.writeFileSync(
      path.join(cvDir, `${cvRepairDigest}.json`),
      JSON.stringify({ ...cvRepairWithoutDigest, digest: cvRepairDigest }, null, 2) + '\n',
      'utf8',
    );
    return { workerReceiptDigest, cvRepairDigest };
  }

  it('带 created_by marker + 自算 digest 但 digest tuple 不绑定的伪造 CV Context 拒绝（findCvContext）', () => {
    const root = fixture();
    admit(root);
    // 伪造：created_by 正确 + 完整形状 + 自算 digest，但 manifest/plan/snapshot 用假值
    const forged: Record<string, unknown> = {
      schema_version: 2,
      root_path: root,
      root_digest: computeDigest(root),
      stage_id: 'S10',
      role: 'cv',
      slice_id: 'S10-B',
      task_id: 'S10-B-T02',
      plan_projection_path: 'delivery/stages/S10/tasks.md',
      evidence_path: 'delivery/stages/S10/evidence/S10-B.md',
      manifest_digest: 'a'.repeat(64),
      plan_digest: 'b'.repeat(64),
      proof_index_digest: 'c'.repeat(64),
      snapshot_digest: 'f'.repeat(40),
      evidence_read_gate: { required: 'refutation-observation', satisfied: false },
      role_fields: { verification: 'initial', evidence_read: false },
      created_by: 'vnext-runtime-seam',
    };
    const digest = computeDigest(forged);
    fs.mkdirSync(path.join(root, '.proofloop', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(root, `.proofloop/context/${digest}.json`),
      JSON.stringify({ ...forged, context_digest: digest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'admit-refutation-observation',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02', observation: 'x' },
      root,
    );
    expect(code).toBe(2);
    expect(envelope.findings[0].code).toBe('CONTEXT.CV_CONTEXT_REQUIRED');
  });

  it('篡改 payload 的 CV_REPAIR（digest 不重算）不驱动 recheck', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    const { cvRepairDigest } = installCvRepair(root, manifest, snapshot);
    // 篡改 payload（不重算 digest）→ verifyReceiptDigest 失败 → 忽略
    const cvPath = path.join(root, '.proofloop/receipts/cv/S10/S10-B', `${cvRepairDigest}.json`);
    const parsed = JSON.parse(fs.readFileSync(cvPath, 'utf8')) as Record<string, any>;
    parsed.payload.failure_signature = 'TAMPERED-SIG';
    fs.writeFileSync(cvPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    expect((envelope.result as { context: Record<string, any> }).context.role_fields.verification)
      .toBe('initial');
  });

  it('闭合字段缺失的 CV_REPAIR（缺 repair_diff_digest）不投影 recheck', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    // 缺 repair_diff_digest 的"合法"CV_REPAIR（digest 重算）→ cv-validation 闭合字段规则拒绝
    const overrides = { repair_diff_digest: undefined };
    const payload = {
      schema_version: 2,
      type: 'CV_RESULT',
      verdict: 'REPAIR',
      verification_type: 'recheck',
      stage_id: 'S10',
      slice_id: 'S10-B',
      worker_receipt_digest: 'x'.repeat(64),
      manifest_digest: computeDigest(manifest),
      plan_digest: manifest.plan.plan_digest,
      proof_index_digest: 'c'.repeat(64),
      context_ref: `.proofloop/context/${'e'.repeat(64)}.json`,
      context_digest: 'e'.repeat(64),
      snapshot_digest: snapshot,
      summary: 'fixture repair',
      acceptance_refs_checked: ['REF-CLI-ACCEPTANCE'],
      seam_refs_checked: ['REF-CLI-SEAM'],
      oracle_refs_checked: ['REF-CLI-ORACLE'],
      risk_refs_considered: [{ ref_id: 'REF-S08D-RISK', applicability: 'NOT_APPLICABLE', reason: 'x' }],
      failed_acceptance_refs: [],
      invalid_tests: [],
      counterexamples: ['x'],
      scope_violations: [],
      forbidden_substitutions: [],
      regression_failures: [],
      failed_criterion: 'fixture criterion',
      failure_signature: 'FIXTURE-SIG-001',
      required_recheck_scope: ['fixture recheck scope'],
      previous_failure_signature: 'PREVIOUS-SIG-000',
      ...overrides,
    };
    void payload;
    installCvRepair(root, manifest, snapshot, { repair_diff_digest: undefined as unknown as string });
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    // 记录被闭合字段规则过滤 → 降级 initial 语义
    expect((envelope.result as { context: Record<string, any> }).context.role_fields.verification)
      .toBe('initial');
  });

  it('Committer facts 忽略语义错误 Receipt（类型与目录不匹配 / tuple 错误）', () => {
    const root = fixture();
    admit(root);
    // committer 目录放一个 binding 错误的 SLICE_COMMIT（manifest_digest 假，digest 自洽）
    const commitDir = path.join(root, '.proofloop/receipts/committer/S10/S10-B');
    fs.mkdirSync(commitDir, { recursive: true });
    const commitPayload = {
      schema_version: 2,
      type: 'SLICE_COMMIT_RESULT',
      action: 'SLICE_COMMIT',
      stage_id: 'S10',
      slice_id: 'S10-B',
      manifest_digest: 'c'.repeat(64),
      plan_digest: 'd'.repeat(64),
      proof_index_digest: 'e'.repeat(64),
      snapshot_digest: 'f'.repeat(40),
      commit_sha: 'a'.repeat(40),
      cv_receipt_digest: 'b'.repeat(64),
      changed_files: [],
      receipt_chain_valid: true,
    };
    const commitWithoutDigest = {
      version: 2,
      type: 'SLICE_COMMIT',
      stage_id: 'S10',
      slice_id: 'S10-B',
      timestamp: '2026-08-11T00:00:00.000Z',
      payload: commitPayload,
    };
    const commitDigest = computeReceiptDigest(commitWithoutDigest);
    fs.writeFileSync(
      path.join(commitDir, `${commitDigest}.json`),
      JSON.stringify({ ...commitWithoutDigest, digest: commitDigest }, null, 2) + '\n',
      'utf8',
    );
    const { code, envelope } = runHandler(
      'prepare',
      { stage: 'S10', role: 'committer', slice: 'S10-B', task: 'S10-B-T02' },
      root,
    );
    expect(code).toBe(0);
    const receiptRefs = (envelope.result as { context: Record<string, any> }).context.role_fields.receipt_refs;
    // 语义错误（manifest_digest 不绑定当前）的 Receipt 不得进入 role_fields
    expect(receiptRefs.every((ref: string) => !ref.includes(`${commitDigest}`))).toBe(true);
  });
});

// ============================================================
// S11-A-T01：readCvRepairHistory 单链拓扑与链 tip 投影（S10-E 回归）
// ============================================================

/**
 * S11-A-T01：一个 CV 链成员 spec。
 *
 * PO binding：REF-S11-A-T01 / REF-CLI-ACCEPTANCE（Acceptance B：initial CV 与
 * CV recheck 生成各自 digest-bound Context）/ REF-CLI-SEAM（Role transfer：
 * context prepare 输出受 ref/digest/snapshot 绑定）/ REF-CLI-ORACLE /
 * REF-HP014（唯一可恢复的 CV_PASS/CV_REPAIR vNext state/consumer path）。
 */
interface CvChainMemberSpec {
  readonly verdict: 'REPAIR' | 'PASS';
  readonly verificationType: 'initial' | 'recheck';
  /** REPAIR only：failure_signature（链 tip 投影字段之一）。 */
  readonly failureSignature?: string;
  /** recheck only：previous_failure_signature（必须等于前序 REPAIR 的 failure_signature）。 */
  readonly previousFailureSignature?: string;
  /** recheck only：repair_diff_digest（sha256）。 */
  readonly repairDiffDigest?: string;
  /** REPAIR only：failed_criterion。 */
  readonly failedCriterion?: string;
  /** REPAIR only：counterexamples（非空）。 */
  readonly counterexamples?: readonly string[];
  /** REPAIR only：required_recheck_scope（非空）。 */
  readonly requiredRecheckScope?: readonly string[];
  /** 非法成员测试：worker tip 覆盖（缺省 = 本 helper 安装的 worker receipt）。 */
  readonly workerReceiptDigestOverride?: string;
  /** 断链测试：previous_digest 覆盖（缺省 = 前序成员 digest；`__GENESIS__` = 链首成员 digest；`__NONE__` = 无 previous_digest）。 */
  readonly previousDigestOverride?: string;
}

/**
 * 安装真实绑定的 CV receipt 链：一个 TASK_COMPLETE worker receipt + 按顺序
 * previous_digest 链接的 CV_PASS/CV_REPAIR receipts（真实 content digest）。
 * 返回链成员的 digest 列表（genesis → tip）。每次调用会清空并重建 cv 目录。
 */
function installCvChain(
  root: string,
  manifest: Record<string, any>,
  snapshot: string,
  members: readonly CvChainMemberSpec[],
  memberBaseTimestamp = '2026-08-11T00:00:00.000Z',
): readonly string[] {
  const slice = manifest.slices.find((c: Record<string, any>) => c.slice_id === 'S10-B');
  const proofIndex = slice.proof_index as Record<string, any>;
  const proofIndexDigest = computeDigest(proofIndex);
  const cvContextDigest = 'e'.repeat(64);
  const taskDir = path.join(root, '.proofloop/receipts/tasks/S10/S10-B');
  fs.mkdirSync(taskDir, { recursive: true });
  const workerPayload = {
    schema_version: 2,
    action_token: 's11-worker-token',
    mode: 'implement-task',
    outcome: 'completed',
    task_id: 'S10-B-T02',
    evidence_ref: 'delivery/stages/S10/evidence/S10-B.md',
    changed_files: ['delivery/stages/S10/evidence/S10-B.md', 'delivery/stages/S10/tasks.md'],
    verification_runs: [],
    summary: 'fixture worker',
    manifest_digest: computeDigest(manifest),
    plan_digest: manifest.plan.plan_digest,
    proof_index_digest: proofIndexDigest,
    snapshot_digest: snapshot,
    context_ref: `.proofloop/context/${cvContextDigest}.json`,
    context_digest: cvContextDigest,
  };
  const workerReceiptWithoutDigest = {
    version: 1,
    type: 'TASK_COMPLETE',
    stage_id: 'S10',
    slice_id: 'S10-B',
    timestamp: '2026-08-11T00:00:00.000Z',
    payload: workerPayload,
  };
  const workerReceiptDigest = computeReceiptDigest(workerReceiptWithoutDigest);
  fs.writeFileSync(
    path.join(taskDir, `${workerReceiptDigest}.json`),
    JSON.stringify({ ...workerReceiptWithoutDigest, digest: workerReceiptDigest }, null, 2) + '\n',
    'utf8',
  );
  const cvDir = path.join(root, '.proofloop/receipts/cv/S10/S10-B');
  fs.rmSync(cvDir, { recursive: true, force: true });
  fs.mkdirSync(cvDir, { recursive: true });
  const digests: string[] = [];
  let previousDigest: string | undefined;
  members.forEach((member, index) => {
    const linkTarget =
      member.previousDigestOverride === '__NONE__'
        ? undefined
        : member.previousDigestOverride === '__GENESIS__'
          ? digests[0]
          : (member.previousDigestOverride ?? previousDigest);
    const payloadBase = {
      schema_version: 2,
      type: 'CV_RESULT',
      verdict: member.verdict,
      verification_type: member.verificationType,
      stage_id: 'S10',
      slice_id: 'S10-B',
      worker_receipt_digest: member.workerReceiptDigestOverride ?? workerReceiptDigest,
      manifest_digest: computeDigest(manifest),
      plan_digest: manifest.plan.plan_digest,
      proof_index_digest: proofIndexDigest,
      context_ref: `.proofloop/context/${cvContextDigest}.json`,
      context_digest: cvContextDigest,
      snapshot_digest: snapshot,
      summary: `fixture ${member.verdict} ${index}`,
      acceptance_refs_checked: [...proofIndex.acceptance_refs],
      seam_refs_checked: [...proofIndex.seam_refs],
      oracle_refs_checked: [...proofIndex.oracle_refs],
      risk_refs_considered: proofIndex.risk_refs.map((r: Record<string, any>) => ({
        ref_id: r.ref_id,
        applicability: 'NOT_APPLICABLE',
        reason: 'fixture',
      })),
      failed_acceptance_refs: [],
      invalid_tests: [],
      counterexamples: member.verdict === 'PASS' ? [] : [...(member.counterexamples ?? [`CE-${index}`])],
      scope_violations: [],
      forbidden_substitutions: [],
      regression_failures: [],
    };
    const payload = {
      ...payloadBase,
      ...(member.verdict === 'REPAIR'
        ? {
            failed_criterion: member.failedCriterion ?? `CRITERION-${index}`,
            failure_signature: member.failureSignature ?? `SIG-${index}`,
            required_recheck_scope: [...(member.requiredRecheckScope ?? [`SCOPE-${index}`])],
          }
        : {}),
      ...(member.verificationType === 'recheck'
        ? {
            previous_failure_signature: member.previousFailureSignature ?? `PREV-SIG-${index}`,
            repair_diff_digest: member.repairDiffDigest ?? `a${String(index).padStart(2, '0')}`.repeat(32),
          }
        : {}),
    };
    const receiptWithoutDigest = {
      version: 1,
      type: member.verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
      stage_id: 'S10',
      slice_id: 'S10-B',
      timestamp: new Date(new Date(memberBaseTimestamp).getTime() + index * 1000).toISOString(),
      ...(linkTarget !== undefined ? { previous_digest: linkTarget } : {}),
      payload,
    };
    const digest = computeReceiptDigest(receiptWithoutDigest);
    fs.writeFileSync(
      path.join(cvDir, `${digest}.json`),
      JSON.stringify({ ...receiptWithoutDigest, digest }, null, 2) + '\n',
      'utf8',
    );
    digests.push(digest);
    previousDigest = digest;
  });
  return digests;
}

/**
 * 安装链并重试 member 时间戳，直到链 tip 的 digest 在文件名排序中排最后
 * （S10-E 回归场景：旧 REPAIR 排序在前，实现不得用文件名排序选事实）。
 */
function installChainWithTipSortedLast(
  root: string,
  manifest: Record<string, any>,
  snapshot: string,
  members: readonly CvChainMemberSpec[],
): void {
  for (let attempt = 0; attempt < 200; attempt++) {
    const base = `2026-08-11T00:00:${String(attempt).padStart(2, '0')}.000Z`;
    const digests = installCvChain(root, manifest, snapshot, members, base);
    const tipDigest = digests[digests.length - 1];
    if (digests.every((digest) => digest <= tipDigest)) return;
  }
  throw new Error('could not arrange tip-last filename order in 200 attempts');
}

function cvRoleFields(root: string): Record<string, any> {
  const { code, envelope } = runHandler(
    'prepare',
    { stage: 'S10', role: 'cv', slice: 'S10-B', task: 'S10-B-T02' },
    root,
  );
  expect(code).toBe(0);
  return (envelope.result as { context: Record<string, any> }).context.role_fields;
}

describe('readCvRepairHistory 单链拓扑与链 tip 投影（S11-A-T01，S10-E 回归）', () => {
  it('S10-E 回归：旧 REPAIR 文件名排序在前时仍投影链 tip（不得按文件名排序选事实）', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    // 真实链：REPAIR(SIG-GENESIS) → REPAIR(SIG-TIP)，tip 为 MISMATCH-007 语义
    installChainWithTipSortedLast(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-GENESIS',
        failedCriterion: 'CRITERION-GENESIS',
        counterexamples: ['CE-GENESIS'],
        requiredRecheckScope: ['SCOPE-GENESIS'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-TIP',
        previousFailureSignature: 'SIG-GENESIS',
        repairDiffDigest: 'b1'.repeat(32),
        failedCriterion: 'CRITERION-TIP',
        counterexamples: ['CE-TIP'],
        requiredRecheckScope: ['SCOPE-TIP'],
      },
    ]);
    const rf = cvRoleFields(root);
    expect(rf.verification).toBe('recheck');
    // 链 tip 的最新签名，而不是文件名排序更前的旧 REPAIR 签名
    expect(rf.previous_failure_signature).toBe('SIG-TIP');
    expect(rf.repair_diff_digest).toBe('b1'.repeat(32));
    expect(rf.failed_criterion).toBe('CRITERION-TIP');
    expect(rf.counterexamples).toEqual(['CE-TIP']);
    expect(rf.required_recheck_scope).toEqual(['SCOPE-TIP']);
  });

  it('多轮 REPAIR 取最新签名（3 轮链，tip 的 failure_signature 全字段投影）', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installChainWithTipSortedLast(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-ROUND-1',
        failedCriterion: 'CRITERION-1',
        counterexamples: ['CE-1'],
        requiredRecheckScope: ['SCOPE-1'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-ROUND-2',
        previousFailureSignature: 'SIG-ROUND-1',
        repairDiffDigest: 'c2'.repeat(32),
        failedCriterion: 'CRITERION-2',
        counterexamples: ['CE-2'],
        requiredRecheckScope: ['SCOPE-2'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-ROUND-3',
        previousFailureSignature: 'SIG-ROUND-2',
        repairDiffDigest: 'd3'.repeat(32),
        failedCriterion: 'CRITERION-3',
        counterexamples: ['CE-3'],
        requiredRecheckScope: ['SCOPE-3'],
      },
    ]);
    const rf = cvRoleFields(root);
    expect(rf.verification).toBe('recheck');
    expect(rf.previous_failure_signature).toBe('SIG-ROUND-3');
    expect(rf.repair_diff_digest).toBe('d3'.repeat(32));
    expect(rf.failed_criterion).toBe('CRITERION-3');
    expect(rf.counterexamples).toEqual(['CE-3']);
    expect(rf.required_recheck_scope).toEqual(['SCOPE-3']);
  });

  it('PASS 终止不回退：REPAIR → PASS 链 tip 为 CV_PASS 时不得继续投影 recheck', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-REPAIR',
        failedCriterion: 'CRITERION-REPAIR',
        counterexamples: ['CE-REPAIR'],
        requiredRecheckScope: ['SCOPE-REPAIR'],
      },
      {
        verdict: 'PASS',
        verificationType: 'recheck',
        previousFailureSignature: 'SIG-REPAIR',
        repairDiffDigest: 'e4'.repeat(32),
      },
    ]);
    const rf = cvRoleFields(root);
    // PASS 终止：不回退到旧 REPAIR，不投影 recheck
    expect(rf.verification).toBe('initial');
    expect(rf.previous_failure_signature).toBeNull();
    expect(rf.repair_diff_digest).toBeNull();
  });

  it('单 CV_PASS genesis 链（initial PASS）→ initial，无 recheck 投影', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installCvChain(root, manifest, snapshot, [
      { verdict: 'PASS', verificationType: 'initial' },
    ]);
    const rf = cvRoleFields(root);
    expect(rf.verification).toBe('initial');
    expect(rf.previous_failure_signature).toBeNull();
  });

  it('fork no-success：同一前序 digest 存在两个子成员 → fail closed（initial）', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-GENESIS',
        failedCriterion: 'CRITERION-GENESIS',
        counterexamples: ['CE-GENESIS'],
        requiredRecheckScope: ['SCOPE-GENESIS'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-FORK-1',
        previousFailureSignature: 'SIG-GENESIS',
        repairDiffDigest: 'f5'.repeat(32),
        failedCriterion: 'CRITERION-FORK-1',
        counterexamples: ['CE-FORK-1'],
        requiredRecheckScope: ['SCOPE-FORK-1'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-FORK-2',
        previousFailureSignature: 'SIG-GENESIS',
        repairDiffDigest: 'f6'.repeat(32),
        failedCriterion: 'CRITERION-FORK-2',
        counterexamples: ['CE-FORK-2'],
        requiredRecheckScope: ['SCOPE-FORK-2'],
        previousDigestOverride: '__GENESIS__',
      },
    ]);
    const rf = cvRoleFields(root);
    expect(rf.verification).toBe('initial');
  });

  it('多 genesis no-success：两个无 previous_digest 的 REPAIR → fail closed（initial）', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-GENESIS-1',
        failedCriterion: 'CRITERION-G1',
        counterexamples: ['CE-G1'],
        requiredRecheckScope: ['SCOPE-G1'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-GENESIS-2',
        failedCriterion: 'CRITERION-G2',
        counterexamples: ['CE-G2'],
        requiredRecheckScope: ['SCOPE-G2'],
        previousDigestOverride: '__NONE__',
      },
    ]);
    const rf = cvRoleFields(root);
    expect(rf.verification).toBe('initial');
  });

  it('断链 no-success：previous_digest 悬空（指向不存在的成员）→ fail closed（initial）', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-DANGLING',
        previousFailureSignature: 'SIG-MISSING',
        repairDiffDigest: 'f7'.repeat(32),
        failedCriterion: 'CRITERION-DANGLING',
        counterexamples: ['CE-DANGLING'],
        requiredRecheckScope: ['SCOPE-DANGLING'],
        previousDigestOverride: '0'.repeat(64),
      },
    ]);
    const rf = cvRoleFields(root);
    expect(rf.verification).toBe('initial');
  });

  it('cycle 等价 no-success：无 genesis 组件（唯一成员 previous_digest 指向非 CV 类别成员）→ fail closed（initial）', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    // 自洽 digest 的环（A.previous=B / B.previous=A）在 SHA-256 下不可构造；
    // 可构造的等价形态是“无 genesis 组件”：成员 previous_digest 指向一个
    // digest 自洽但非 CV 类别（TASK_COMPLETE）的成员——非 CV 类别不是链成员，
    // 链接悬空 → 无 genesis → fail closed。
    const nonCvWithoutDigest = {
      version: 1,
      type: 'TASK_COMPLETE',
      stage_id: 'S10',
      slice_id: 'S10-B',
      timestamp: '2026-08-11T00:00:00.000Z',
      payload: { task_id: 'S10-B-T02', summary: 'non-CV receipt inside the cv dir' },
    };
    const nonCvDigest = computeReceiptDigest(nonCvWithoutDigest);
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-LINK-TO-NONCV',
        previousFailureSignature: 'SIG-MISSING',
        repairDiffDigest: 'f8'.repeat(32),
        failedCriterion: 'CRITERION-LINK',
        counterexamples: ['CE-LINK'],
        requiredRecheckScope: ['SCOPE-LINK'],
        previousDigestOverride: nonCvDigest,
      },
    ]);
    const cvDir = path.join(root, '.proofloop/receipts/cv/S10/S10-B');
    fs.writeFileSync(
      path.join(cvDir, `${nonCvDigest}.json`),
      JSON.stringify({ ...nonCvWithoutDigest, digest: nonCvDigest }, null, 2) + '\n',
      'utf8',
    );
    const rf = cvRoleFields(root);
    expect(rf.verification).toBe('initial');
  });

  it('非法 sequence no-success：PASS 非终止（PASS 后仍有 REPAIR）→ fail closed（initial）', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-A',
        failedCriterion: 'CRITERION-A',
        counterexamples: ['CE-A'],
        requiredRecheckScope: ['SCOPE-A'],
      },
      {
        verdict: 'PASS',
        verificationType: 'recheck',
        previousFailureSignature: 'SIG-A',
        repairDiffDigest: 'fa'.repeat(32),
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-C',
        previousFailureSignature: 'SIG-A',
        repairDiffDigest: 'fb'.repeat(32),
        failedCriterion: 'CRITERION-C',
        counterexamples: ['CE-C'],
        requiredRecheckScope: ['SCOPE-C'],
      },
    ]);
    const rf = cvRoleFields(root);
    expect(rf.verification).toBe('initial');
  });

  it('任意链成员无效 no-success：binding 破损的子 REPAIR 不得被静默跳过并回退旧 REPAIR', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-VALID',
        failedCriterion: 'CRITERION-VALID',
        counterexamples: ['CE-VALID'],
        requiredRecheckScope: ['SCOPE-VALID'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-BROKEN-BINDING',
        previousFailureSignature: 'SIG-VALID',
        repairDiffDigest: 'fc'.repeat(32),
        failedCriterion: 'CRITERION-BROKEN',
        counterexamples: ['CE-BROKEN'],
        requiredRecheckScope: ['SCOPE-BROKEN'],
        // digest 自洽但 worker binding 破损：不指向任何持久化 TASK_COMPLETE
        workerReceiptDigestOverride: 'f'.repeat(64),
      },
    ]);
    const rf = cvRoleFields(root);
    // 不能跳过破损子成员后回退投影旧 REPAIR（SIG-VALID）
    expect(rf.verification).toBe('initial');
  });

  it('CV 反例 1：genesis 为 verification_type=recheck 的合法闭合 REPAIR → fail closed，不得投影 recheck', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    // genesis 位置：闭合字段完整（recheck 分支的 previous_failure_signature +
    // repair_diff_digest 均合法），但 verification_type 是 recheck 而不是 initial。
    // 共享 assertVNextCvChainSequence 明确要求 genesis 必须为 initial。
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-GENESIS-RECHECK',
        previousFailureSignature: 'SIG-SOME-PREVIOUS',
        repairDiffDigest: 'aa'.repeat(32),
        failedCriterion: 'CRITERION-GENESIS-RECHECK',
        counterexamples: ['CE-GENESIS-RECHECK'],
        requiredRecheckScope: ['SCOPE-GENESIS-RECHECK'],
      },
    ]);
    const rf = cvRoleFields(root);
    // 非 initial genesis 必须 fail closed：不投影 recheck
    expect(rf.verification).toBe('initial');
  });

  it('CV 反例 2：初始 REPAIR 后接 previous_failure_signature 错误的 CV_PASS recheck → fail closed', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    // 初始 REPAIR（SIG-INITIAL）后接 CV_PASS recheck，其 previous_failure_signature
    // 与 SIG-INITIAL 不一致。共享 assertVNextCvChainSequence 要求所有后继（含
    // CV_PASS recheck）的 previous_failure_signature 精确匹配前序 REPAIR 的
    // failure_signature；不得只在双方都是 CV_REPAIR 时才比较。
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-INITIAL',
        failedCriterion: 'CRITERION-INITIAL',
        counterexamples: ['CE-INITIAL'],
        requiredRecheckScope: ['SCOPE-INITIAL'],
      },
      {
        verdict: 'PASS',
        verificationType: 'recheck',
        previousFailureSignature: 'WRONG-SIG-NOT-INITIAL',
        repairDiffDigest: 'bb'.repeat(32),
      },
    ]);
    const rf = cvRoleFields(root);
    // 签名失配的链必须 fail closed（不得当作合法 PASS 闭合接受）
    expect(rf.verification).toBe('initial');
  });

  it('CV 反例 2 补充：REPAIR recheck 后继 previous_failure_signature 错误 → fail closed（比较适用于所有后继，不限于 CV_PASS）', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    // 初始 REPAIR（SIG-INITIAL）后接 REPAIR recheck，其 previous_failure_signature
    // 与 SIG-INITIAL 不一致。共享 assertVNextCvChainSequence 对 REPAIR 后继同样
    // 要求 previous_failure_signature 精确匹配前序 REPAIR 的 failure_signature。
    installCvChain(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-INITIAL',
        failedCriterion: 'CRITERION-INITIAL',
        counterexamples: ['CE-INITIAL'],
        requiredRecheckScope: ['SCOPE-INITIAL'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-WRONG-SUCCESSOR',
        previousFailureSignature: 'WRONG-SIG-NOT-INITIAL',
        repairDiffDigest: 'bc'.repeat(32),
        failedCriterion: 'CRITERION-SUCCESSOR',
        counterexamples: ['CE-SUCCESSOR'],
        requiredRecheckScope: ['SCOPE-SUCCESSOR'],
      },
    ]);
    const rf = cvRoleFields(root);
    // REPAIR 后继签名失配同样必须 fail closed，不得投影 recheck
    expect(rf.verification).toBe('initial');
  });

  it('CV 反例 3：合法 REPAIR 链后加入 self-digest 损坏的 64-hex 候选文件 → fail closed，不得投影旧 tip', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installChainWithTipSortedLast(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-GENESIS',
        failedCriterion: 'CRITERION-GENESIS',
        counterexamples: ['CE-GENESIS'],
        requiredRecheckScope: ['SCOPE-GENESIS'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-TIP',
        previousFailureSignature: 'SIG-GENESIS',
        repairDiffDigest: 'cc'.repeat(32),
        failedCriterion: 'CRITERION-TIP',
        counterexamples: ['CE-TIP'],
        requiredRecheckScope: ['SCOPE-TIP'],
      },
    ]);
    // 64-hex 命名的候选 CV Receipt 文件，self-digest 损坏：digest 字段与文件名不符。
    // 实现必须 fail closed（不得跳过损坏候选并回退投影旧合法 tip）。
    const cvDir = path.join(root, '.proofloop/receipts/cv/S10/S10-B');
    const corruptedName = 'deadbeef'.repeat(8);
    fs.writeFileSync(
      path.join(cvDir, `${corruptedName}.json`),
      JSON.stringify({ digest: 'f'.repeat(64), type: 'CV_REPAIR', payload: {} }, null, 2) + '\n',
      'utf8',
    );
    const rf = cvRoleFields(root);
    // 不得静默跳过损坏候选成员并回退投影旧 tip（SIG-TIP）
    expect(rf.verification).toBe('initial');
  });

  it('CV 反例 4：合法 REPAIR 链后加入指向 root 外的 symlink 64-hex 候选 → fail closed，不得投影旧 tip', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installChainWithTipSortedLast(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-GENESIS',
        failedCriterion: 'CRITERION-GENESIS',
        counterexamples: ['CE-GENESIS'],
        requiredRecheckScope: ['SCOPE-GENESIS'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-TIP',
        previousFailureSignature: 'SIG-GENESIS',
        repairDiffDigest: 'dd'.repeat(32),
        failedCriterion: 'CRITERION-TIP',
        counterexamples: ['CE-TIP'],
        requiredRecheckScope: ['SCOPE-TIP'],
      },
    ]);
    // 64-hex 命名的 symlink 候选指向 trust root 之外：canonical 解析必须判为
    // 路径逃逸并 fail closed（不得 continue 跳过——否则合法旧链 tip 与外部
    // symlink 并存时仍会投影旧 recheck）。
    const cvDir = path.join(root, '.proofloop/receipts/cv/S10/S10-B');
    const outsideTarget = path.join(os.tmpdir(), `proofloop-context-outside-${process.pid}.json`);
    fs.writeFileSync(outsideTarget, '{}', 'utf8');
    try {
      fs.symlinkSync(outsideTarget, path.join(cvDir, `${'feedface'.repeat(8)}.json`));
      const rf = cvRoleFields(root);
      // 路径逃逸候选必须整体 fail closed，不得回退投影旧 tip（SIG-TIP）
      expect(rf.verification).toBe('initial');
      expect(rf.previous_failure_signature).toBeNull();
    } finally {
      fs.rmSync(outsideTarget, { force: true });
    }
  });

  it('CV 反例 5：合法 REPAIR 链后加入目录形式的 64-hex 候选 → fail closed，不得投影旧 tip', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installChainWithTipSortedLast(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-GENESIS',
        failedCriterion: 'CRITERION-GENESIS',
        counterexamples: ['CE-GENESIS'],
        requiredRecheckScope: ['SCOPE-GENESIS'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-TIP',
        previousFailureSignature: 'SIG-GENESIS',
        repairDiffDigest: 'ee'.repeat(32),
        failedCriterion: 'CRITERION-TIP',
        counterexamples: ['CE-TIP'],
        requiredRecheckScope: ['SCOPE-TIP'],
      },
    ]);
    // 64-hex 命名的候选是一个目录（非 regular 文件）：打开后的 isFile 校验
    // 必须 fail closed（不得 continue 跳过——否则合法旧链 tip 与同名目录
    // 候选并存时仍会投影旧 recheck）。
    const cvDir = path.join(root, '.proofloop/receipts/cv/S10/S10-B');
    fs.mkdirSync(path.join(cvDir, `${'deadbeef'.repeat(8)}.json`));
    const rf = cvRoleFields(root);
    // 非 regular 候选必须整体 fail closed，不得回退投影旧 tip（SIG-TIP）
    expect(rf.verification).toBe('initial');
    expect(rf.previous_failure_signature).toBeNull();
  });

  it('CV 反例 6：合法 REPAIR 链后加入不可读的 64-hex 候选文件 → fail closed，不得投影旧 tip', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installChainWithTipSortedLast(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-GENESIS',
        failedCriterion: 'CRITERION-GENESIS',
        counterexamples: ['CE-GENESIS'],
        requiredRecheckScope: ['SCOPE-GENESIS'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-TIP',
        previousFailureSignature: 'SIG-GENESIS',
        repairDiffDigest: 'ff'.repeat(32),
        failedCriterion: 'CRITERION-TIP',
        counterexamples: ['CE-TIP'],
        requiredRecheckScope: ['SCOPE-TIP'],
      },
    ]);
    // 64-hex 命名的候选文件存在但不可读（mode 0000 → open EACCES）：打开失败
    // 必须 fail closed（不得 continue 跳过——否则合法旧链 tip 与不可读候选
    // 并存时仍会投影旧 recheck）。
    const cvDir = path.join(root, '.proofloop/receipts/cv/S10/S10-B');
    const unreadablePath = path.join(cvDir, `${'cafebabe'.repeat(8)}.json`);
    fs.writeFileSync(unreadablePath, '{}', 'utf8');
    fs.chmodSync(unreadablePath, 0o000);
    const rf = cvRoleFields(root);
    // 不可读候选必须整体 fail closed，不得回退投影旧 tip（SIG-TIP）
    expect(rf.verification).toBe('initial');
    expect(rf.previous_failure_signature).toBeNull();
  });

  it('ENOENT readdir 竞态固定：64-hex 名字在 readdir 列出后消失 → 合法缺失跳过，合法链仍投影 tip', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installChainWithTipSortedLast(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-GENESIS',
        failedCriterion: 'CRITERION-GENESIS',
        counterexamples: ['CE-GENESIS'],
        requiredRecheckScope: ['SCOPE-GENESIS'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-TIP',
        previousFailureSignature: 'SIG-GENESIS',
        repairDiffDigest: 'ab'.repeat(32),
        failedCriterion: 'CRITERION-TIP',
        counterexamples: ['CE-TIP'],
        requiredRecheckScope: ['SCOPE-TIP'],
      },
    ]);
    // 固定 ENOENT 竞态语义：readdir 列出的 64-hex 名字在打开前已从磁盘消失
    // （ENOENT 合法缺失，例如并发清理）。这是“损坏候选 fail closed”的唯一
    // 例外——按目录扫描语义跳过该名字，不得把竞态误判为损坏候选而 flaky
    // fail closed；条目仍存在时的打开失败（不可读/非 regular/逃逸）才 fail
    // closed。通过给 readdir 注入一个磁盘上不存在的幻影 64-hex 名字确定性
    // 复现该竞态。
    const cvDir = path.join(root, '.proofloop/receipts/cv/S10/S10-B');
    cvReaddirRace.active = true;
    cvReaddirRace.cvDir = cvDir;
    cvReaddirRace.phantomName = `${'abcdef01'.repeat(8)}.json`;
    try {
      const rf = cvRoleFields(root);
      // 合法缺失跳过：合法链仍投影链 tip，不得 fail closed
      expect(rf.verification).toBe('recheck');
      expect(rf.previous_failure_signature).toBe('SIG-TIP');
    } finally {
      cvReaddirRace.active = false;
    }
  });

  it('CV 反例 7：合法 REPAIR 链后 readdir 列出、打开失败且 lstat 抛非 ENOENT（EACCES）的 64-hex 候选 → fail closed，不得投影旧 tip', () => {
    const root = fixture();
    const snapshot = admit(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S10.json'), 'utf8'),
    ) as Record<string, any>;
    installChainWithTipSortedLast(root, manifest, snapshot, [
      {
        verdict: 'REPAIR',
        verificationType: 'initial',
        failureSignature: 'SIG-GENESIS',
        repairDiffDigest: 'aa'.repeat(32),
        failedCriterion: 'CRITERION-GENESIS',
        counterexamples: ['CE-GENESIS'],
        requiredRecheckScope: ['SCOPE-GENESIS'],
      },
      {
        verdict: 'REPAIR',
        verificationType: 'recheck',
        failureSignature: 'SIG-TIP',
        previousFailureSignature: 'SIG-GENESIS',
        repairDiffDigest: 'ab'.repeat(32),
        failedCriterion: 'CRITERION-TIP',
        counterexamples: ['CE-TIP'],
        requiredRecheckScope: ['SCOPE-TIP'],
      },
    ]);
    // 固定非 ENOENT lstat 失败语义：readdir 列出 64-hex 名字后，openNoFollowRead
    // 因条目无法读取而失败（unreadable），随后 lstatSync 抛出的是非 ENOENT
    // 异常（EACCES，例如父目录不可搜索）。只有 ENOENT 才证明“条目确实从磁盘
    // 消失”的合法竞态；EACCES/EIO 等非 ENOENT 异常无法确认合法缺失，必须
    // fail closed——否则不可读损坏候选可被静默跳过并回退投影旧链 tip。
    const cvDir = path.join(root, '.proofloop/receipts/cv/S10/S10-B');
    const phantomName = `${'1234abcd'.repeat(8)}.json`;
    const phantomPath = path.join(cvDir, phantomName);
    cvReaddirRace.active = true;
    cvReaddirRace.cvDir = cvDir;
    cvReaddirRace.phantomName = phantomName;
    cvLstatFail.active = true;
    cvLstatFail.targetPath = phantomPath;
    cvLstatFail.code = 'EACCES';
    try {
      const rf = cvRoleFields(root);
      // 非 ENOENT 的 lstat 失败是损坏候选：必须整体 fail closed，不得回退投影
      // 旧 tip（SIG-TIP）
      expect(rf.verification).toBe('initial');
      expect(rf.previous_failure_signature).toBeNull();
    } finally {
      cvReaddirRace.active = false;
      cvLstatFail.active = false;
    }
  });
});
