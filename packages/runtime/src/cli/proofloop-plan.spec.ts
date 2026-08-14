/**
 * proofloop-plan.spec.ts — S10-B-T01: plan 域操作闭集测试。
 *
 * 覆盖（PO: S10-B-T01 / REF-CLI-ACCEPTANCE / REF-CLI-SEAM）：
 *  - `plan compile` → compile-vnext-manifest seam（缺省/显式输出路径）
 *  - `plan validate` → validate-vnext-stage seam（只读）
 *  - `plan initialize-evidence` → initialize-vnext-slice-evidence seam
 *  - `plan refresh-evidence` → refresh-vnext-slice-evidence seam（pre-admission）
 *  - `plan status` → 只读 plan status（manifest digest / slices / admission）
 *  - `authority check` → 只读 authority refs / blocking Hard Part 就绪检查
 *  - 参数缺失 / 未知 stage / 未知 request 字段 / 冲突 → canonical finding + no-write
 *  - dispatcher 级 exit 合同（未知 plan 操作 exit 2）
 *  - built dist 进程 smoke（plan validate exit 0；未知 plan 操作 exit 2）
 *
 * 真实仓库状态（S10 已 admission）用于 validate/status/authority-check 的
 * happy path；compile/initialize/refresh 使用独立 temp fixture。
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { computeDigest, computeReceiptDigest, computeVNextSpvPassReceiptDigest } from '@proofloop/kernel';
import { parseEntityMarkers, normalizeEntityText, normalizePlanExecutionProjection } from '../vnext';
import { runAuthorityCheck, runPlan, type PlanOperationParams } from './proofloop-plan';
import { proofloopCli } from './proofloop';
import { CLI_EXIT, type CliCommand } from './proofloop-common';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_PROOFLOOP = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');
const S10_MANIFEST = path.join(REPO_ROOT, '.proofloop', 'manifests', 'S10.json');

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

// ============================================================
// Fixture helpers
// ============================================================

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
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

function callPlan(
  root: string,
  operation: string,
  params: PlanOperationParams,
): ReturnType<typeof runPlan> {
  const command: CliCommand = { domain: 'plan', operation };
  return runPlan(root, 'auto', command, params);
}

/** S04 fixture: compile 出合法 manifest（refs.md + tasks.md + candidate input）。 */
function makeCompileFixture(): { root: string; requestPath: string; manifestPath: string } {
  const root = tempRoot('proofloop-plan-');
  write(
    root,
    'refs.md',
    [
      '<!-- proofloop:entity id="goal" kind="goal" -->', 'goal',
      '<!-- proofloop:entity id="S04-A-T01" kind="task" -->', 'task',
      '<!-- proofloop:entity id="accept" kind="acceptance" -->', 'acceptance',
      '<!-- proofloop:entity id="seam" kind="seam" -->', 'seam',
      '<!-- proofloop:entity id="oracle" kind="oracle" -->', 'oracle',
      '<!-- proofloop:entity id="risk" kind="risk" -->', 'risk',
    ].join('\n'),
  );
  write(root, 'delivery/stages/S04/tasks.md', 'not parsed\n');
  const input = {
    root,
    stage_id: 'S04',
    plan_path: 'delivery/stages/S04/tasks.md',
    plan: {
      schema_version: 2,
      items: [
        {
          id: 'S04-A-T01',
          kind: 'task',
          goal: 'plan domain fixture',
          refs: ['T'],
          dependencies: [],
          required_skills: [],
          execution_scope: {
            kind: 'implementation',
            code_paths: ['packages/runtime/src/cli/proofloop-plan.ts'],
            test_paths: ['packages/runtime/src/cli/proofloop-plan.spec.ts'],
            forbidden_paths: ['.proofloop/receipts'],
          },
        },
      ],
    },
    refs: [
      { ref_id: 'G', kind: 'goal', ref: 'refs.md#/entities/goal' },
      { ref_id: 'T', kind: 'task', ref: 'refs.md#/entities/S04-A-T01' },
      { ref_id: 'A', kind: 'acceptance', ref: 'refs.md#/entities/accept' },
      { ref_id: 'S', kind: 'seam', ref: 'refs.md#/entities/seam' },
      { ref_id: 'O', kind: 'oracle', ref: 'refs.md#/entities/oracle' },
      { ref_id: 'R', kind: 'risk', ref: 'refs.md#/entities/risk' },
    ],
    authority_ref_ids: ['A', 'S', 'O'],
    slices: [
      {
        slice_id: 'S04-A',
        proof_index: {
          slice_id: 'S04-A',
          goal_ref: 'G',
          task_refs: ['T'],
          acceptance_refs: ['A'],
          seam_refs: ['S'],
          oracle_refs: ['O'],
          risk_refs: [
            { ref_id: 'R', applies_to_acceptance_refs: ['A'], applies_to_seam_refs: ['S'] },
          ],
        },
        required_skills: [],
        depends_on: [],
        evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
      },
    ],
  };
  const requestPath = write(root, 'request.json', JSON.stringify(input));
  fs.mkdirSync(path.join(root, '.proofloop', 'manifests'), { recursive: true });
  return { root, requestPath, manifestPath: '.proofloop/manifests/S04.json' };
}

function compiledManifestDigest(root: string, manifestPath: string): string {
  return computeDigest(JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8')) as unknown);
}

function manifestBindingDigest(root: string, evidenceRelative: string): string | null {
  const content = fs.readFileSync(path.join(root, evidenceRelative), 'utf8');
  const match = /^- Manifest Digest: ([0-9a-f]{64})$/m.exec(content);
  return match?.[1] ?? null;
}

// ============================================================
// S10 fixture self-consistency（P-11 连带）
// ============================================================

/** True for plan-projection references (tasks.md); mirrors resolver isPlanReferencePath. */
function isPlanRef(filePath: string): boolean {
  return filePath.split('/').pop() === 'tasks.md';
}

/** Bare SHA-256 hex, matching the resolver's file/section digest formula. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Recompute the kernel digests of the copied Authority files and rewrite the
 * fixture Manifest's reference_index bindings so the fixture is self-consistent
 * regardless of the real repository's Authority state.
 *
 * Mirrors the resolver exactly: file_digest = sha256(normalizeReferenceFileText),
 * section_digest = sha256(canonicalPath + canonicalEntityRef + normalizedContent),
 * both via the exported normalizers (never a local re-implementation).
 *
 * NOTE: equivalent logic lives in proofloop-context.spec.ts
 * (rebindFixtureManifestAuthorityDigests); copied here rather than imported
 * because cross-spec imports of private test helpers are forbidden.
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
    const isPlan = isPlanRef(filePath);
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
      const sectionContent = isPlan
        ? normalizePlanExecutionProjection(entity.content)
        : entity.content;
      entry.section_digest = sha256Hex(
        filePath.replace(/\\/g, '/') + ref + sectionContent,
      );
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Rewrite each fixture Evidence file's `- Manifest Digest:` binding line to the
 * fixture Manifest's recomputed digest.  Rebinding the reference_index changes
 * the Manifest content → its digest changes, so plan validate's
 * verifyEvidenceBindings (which compares against computeVNextManifestDigest)
 * would fail on the copied evidence otherwise.
 */
function rebindFixtureEvidenceManifestDigests(root: string): void {
  const manifestPath = path.join(root, '.proofloop/manifests/S10.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    slices: Array<{ evidence_path: string }>;
  };
  const digest = computeDigest(manifest);
  for (const slice of manifest.slices) {
    const evidencePath = path.join(root, slice.evidence_path);
    if (!fs.existsSync(evidencePath)) continue;
    const content = fs.readFileSync(evidencePath, 'utf8');
    const rebound = content.replace(/^(- Manifest Digest: )[0-9a-f]{64}$/m, `$1${digest}`);
    fs.writeFileSync(evidencePath, rebound, 'utf8');
  }
}

/**
 * S10 fixture：复制真实 S10 Manifest + 其引用的全部文件（tasks.md、Authority
 * 源、evidence），再按 resolver 公式重算 reference_index 的 file/section digest
 * 回写 fixture 内 Manifest（并把 evidence 的 Manifest Digest 绑定行更新为新
 * digest），使 fixture 自洽 —— 不再依赖真实仓库的 Authority digest 状态
 * （已完成/受限关闭 Stage 的 Manifest 是历史归档，其 binding 不可复现）。
 */
function makeS10BoundFixture(): { root: string } {
  const root = tempRoot('proofloop-plan-s10-');
  const manifest = JSON.parse(fs.readFileSync(S10_MANIFEST, 'utf8')) as {
    plan: { ref: string };
    reference_index: Record<string, { ref: string }>;
    slices: Array<{ evidence_path: string }>;
  };
  const files = new Set<string>(['.proofloop/manifests/S10.json', manifest.plan.ref]);
  for (const entry of Object.values(manifest.reference_index)) {
    const filePath = entry.ref.slice(0, entry.ref.indexOf('#'));
    if (filePath.length > 0) files.add(filePath);
  }
  for (const slice of manifest.slices) files.add(slice.evidence_path);
  for (const relative of files) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relative), target);
  }
  rebindFixtureManifestAuthorityDigests(root);
  rebindFixtureEvidenceManifestDigests(root);
  return { root };
}

// ============================================================
// plan validate（只读）
// ============================================================

describe('plan validate（S10-B-T01）', () => {
  it('验证已 admission 的 S10 返回 ok:true 且 valid:true（canonical envelope）', () => {
    // fixture 自洽（P-11 连带）：真实 S10 Manifest 的 reference_index 绑定的是
    // replan 时工作树的 Authority digest（已删除 transition check 域后不可复现），
    // 复制到临时 fixture 并按 resolver 公式重算 binding 后验证 canonical envelope。
    const { root } = makeS10BoundFixture();
    const envelope = callPlan(root, 'validate', { stage: 'S10' });
    expect(envelope.ok).toBe(true);
    expect(envelope.findings).toEqual([]);
    expect(envelope.result).toMatchObject({ valid: true, stage_id: 'S10' });
    expect(envelope.command).toEqual({ domain: 'plan', operation: 'validate' });
  });

  it('缺少 stage 参数 fail closed（PLAN.STAGE_REQUIRED）', () => {
    const envelope = callPlan(REPO_ROOT, 'validate', {});
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.STAGE_REQUIRED');
  });

  it('未知 stage（Manifest 不存在）fail closed（PLAN.MANIFEST_NOT_FOUND）且不写任何文件', () => {
    const root = tempRoot('proofloop-plan-unknown-');
    fs.mkdirSync(path.join(root, '.proofloop'));
    const before = fs.readdirSync(path.join(root, '.proofloop'));
    const envelope = callPlan(root, 'validate', { stage: 'S99' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_NOT_FOUND');
    expect(fs.readdirSync(path.join(root, '.proofloop'))).toEqual(before);
  });

  it('fixture manifest 可经 plan validate 通过（compile 产物 + evidence 初始化后）', () => {
    const fx = makeCompileFixture();
    const compiled = callPlan(fx.root, 'compile', { input_path: 'request.json' });
    expect(compiled.ok).toBe(true);
    const initialized = callPlan(fx.root, 'initialize-evidence', { stage: 'S04' });
    expect(initialized.ok).toBe(true);
    const envelope = callPlan(fx.root, 'validate', { stage: 'S04' });
    expect(envelope.ok).toBe(true);
    expect(envelope.result).toMatchObject({ valid: true, stage_id: 'S04' });
  });

  it('plan validate 对已归档 stage 跳过 reference binding 校验并返回 valid + archived:true（exit 0）', () => {
    const { root } = makeS10BoundFixture();
    // 破坏 reference binding（file_digest 与源文件不符）：未归档时 validate
    // 必须失败；写入 STAGE_CLOSE 标记后，已归档 Stage 的 Manifest 是历史
    // 快照 —— 跳过 reference/evidence digest 校验并返回 valid + archived。
    const manifestPath = path.join(root, '.proofloop', 'manifests', 'S10.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      reference_index: Record<string, { file_digest: string }>;
    };
    const firstRef = Object.keys(manifest.reference_index)[0];
    manifest.reference_index[firstRef].file_digest = '0'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const before = callPlan(root, 'validate', { stage: 'S10' });
    expect(before.ok).toBe(false);

    writeStageCloseReceipt(root, 'S10');
    const envelope = callPlan(root, 'validate', { stage: 'S10' });
    expect(envelope.ok).toBe(true);
    expect(envelope.findings).toEqual([]);
    expect(envelope.result).toMatchObject({ valid: true, stage_id: 'S10', archived: true, errors: [] });
    expect(envelope.command).toEqual({ domain: 'plan', operation: 'validate' });
  });
});

// ============================================================
// plan status（只读）
// ============================================================

describe('plan status（S10-B-T01）', () => {
  it('S10 返回 manifest digest / plan digest / slices / admission 状态（只读）', () => {
    const manifest = JSON.parse(fs.readFileSync(S10_MANIFEST, 'utf8')) as Record<string, unknown>;
    const envelope = callPlan(REPO_ROOT, 'status', { stage: 'S10' });
    expect(envelope.ok).toBe(true);
    const result = envelope.result as {
      stage_id: string;
      manifest_digest: string;
      plan: { ref: string; plan_digest: string };
      slices: Array<{ slice_id: string; evidence_present: boolean }>;
      admission: { spv: boolean; stage_plan: boolean };
    };
    expect(result.stage_id).toBe('S10');
    expect(result.manifest_digest).toBe(computeDigest(manifest));
    expect(result.plan.plan_digest).toBe((manifest.plan as { plan_digest: string }).plan_digest);
    expect(result.slices.length).toBeGreaterThan(0);
    expect(result.slices.every((s) => s.evidence_present)).toBe(true);
    expect(result.admission.stage_plan).toBe(true);
    expect(result.admission.spv).toBe(true);
  });

  it('缺少 stage 参数 fail closed（PLAN.STAGE_REQUIRED）', () => {
    const envelope = callPlan(REPO_ROOT, 'status', {});
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.STAGE_REQUIRED');
  });
});

// ============================================================
// authority check（只读）
// ============================================================

describe('authority check（S10-B-T01）', () => {
  it('S10 的 Authority refs 与 blocking Hard Part 全部就绪（ready:true）', () => {
    // fixture 自洽（同 validate）：真实仓库的 Authority digest 状态不可复现，
    // 复制 S10 边界工件到临时 fixture 并重算 binding 后验证就绪检查。
    const { root } = makeS10BoundFixture();
    const envelope = runAuthorityCheck(root, 'auto', { domain: 'authority', operation: 'check' }, {
      stage: 'S10',
    });
    expect(envelope.ok).toBe(true);
    const result = envelope.result as {
      ready: boolean;
      stage_id: string;
      authority_refs: Array<{ ref_id: string; resolvable: boolean }>;
      blocking_risks: Array<{ ref_id: string; resolvable: boolean }>;
    };
    expect(result.ready).toBe(true);
    expect(result.stage_id).toBe('S10');
    expect(result.authority_refs.length).toBeGreaterThan(0);
    expect(result.authority_refs.every((r) => r.resolvable)).toBe(true);
    expect(result.blocking_risks.length).toBeGreaterThan(0);
    expect(result.blocking_risks.every((r) => r.resolvable)).toBe(true);
  });

  it('未知 stage fail closed（PLAN.MANIFEST_NOT_FOUND）', () => {
    const root = tempRoot('proofloop-plan-auth-');
    fs.mkdirSync(path.join(root, '.proofloop'));
    const envelope = runAuthorityCheck(root, 'auto', { domain: 'authority', operation: 'check' }, {
      stage: 'S99',
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_NOT_FOUND');
  });
});

// ============================================================
// plan compile
// ============================================================

describe('plan compile（S10-B-T01）', () => {
  it('从 candidate input 编译 manifest（缺省输出 .proofloop/manifests/<stage>.json），refs 返回 ref+digest', () => {
    const fx = makeCompileFixture();
    const envelope = callPlan(fx.root, 'compile', { input_path: 'request.json' });
    expect(envelope.ok).toBe(true);
    expect(envelope.refs).toHaveLength(1);
    const ref = envelope.refs[0];
    expect(ref.ref).toBe('.proofloop/manifests/S04.json');
    expect(ref.digest).toBe(compiledManifestDigest(fx.root, '.proofloop/manifests/S04.json'));
    const result = envelope.result as { success: boolean; stage_id: string; manifest_path: string };
    expect(result.success).toBe(true);
    expect(result.stage_id).toBe('S04');
    expect(result.manifest_path).toBe(path.join(fx.root, '.proofloop', 'manifests', 'S04.json'));
  });

  it('支持显式 output_path', () => {
    const fx = makeCompileFixture();
    const envelope = callPlan(fx.root, 'compile', {
      input_path: 'request.json',
      output_path: 'delivery/stages/S04/manifest.json',
    });
    expect(envelope.ok).toBe(true);
    const absolute = path.join(fx.root, 'delivery', 'stages', 'S04', 'manifest.json');
    expect(fs.existsSync(absolute)).toBe(true);
    expect(envelope.refs[0].digest).toBe(computeDigest(JSON.parse(fs.readFileSync(absolute, 'utf8')) as unknown));
  });

  it('缺少 input_path fail closed', () => {
    const fx = makeCompileFixture();
    const envelope = callPlan(fx.root, 'compile', {});
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.INPUT_REQUIRED');
    expect(fs.existsSync(path.join(fx.root, '.proofloop', 'manifests', 'S04.json'))).toBe(false);
  });

  it('非法 candidate input fail closed 且不产生输出', () => {
    const fx = makeCompileFixture();
    write(fx.root, 'bad.json', JSON.stringify({ root: fx.root, stage_id: 7 }));
    const envelope = callPlan(fx.root, 'compile', { input_path: 'bad.json' });
    expect(envelope.ok).toBe(false);
    expect(fs.existsSync(path.join(fx.root, '.proofloop', 'manifests', 'S04.json'))).toBe(false);
  });
});

// ============================================================
// plan initialize-evidence
// ============================================================

describe('plan initialize-evidence（S10-B-T01）', () => {
  it('为 manifest 声明的 evidence 路径创建 pristine skeleton（Plan Binding 绑定 manifest digest）', () => {
    const fx = makeCompileFixture();
    const compiled = callPlan(fx.root, 'compile', { input_path: 'request.json' });
    expect(compiled.ok).toBe(true);
    const digest = compiledManifestDigest(fx.root, '.proofloop/manifests/S04.json');

    const envelope = callPlan(fx.root, 'initialize-evidence', { stage: 'S04' });
    expect(envelope.ok).toBe(true);
    const result = envelope.result as { initialized: string[]; skipped: string[] };
    expect(result.initialized).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(fs.existsSync(path.join(fx.root, 'delivery', 'stages', 'S04', 'evidence', 'S04-A.md'))).toBe(true);
    expect(manifestBindingDigest(fx.root, 'delivery/stages/S04/evidence/S04-A.md')).toBe(digest);
  });

  it('已存在的非空 evidence 文件被跳过而非覆盖', () => {
    const fx = makeCompileFixture();
    const compiled = callPlan(fx.root, 'compile', { input_path: 'request.json' });
    expect(compiled.ok).toBe(true);
    write(fx.root, 'delivery/stages/S04/evidence/S04-A.md', 'precious');
    const envelope = callPlan(fx.root, 'initialize-evidence', { stage: 'S04' });
    expect(envelope.ok).toBe(true);
    const result = envelope.result as { initialized: string[]; skipped: string[] };
    expect(result.initialized).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(fs.readFileSync(path.join(fx.root, 'delivery', 'stages', 'S04', 'evidence', 'S04-A.md'), 'utf8')).toBe('precious');
  });

  it('manifest 缺失 fail closed', () => {
    const root = tempRoot('proofloop-plan-init-');
    const envelope = callPlan(root, 'initialize-evidence', { stage: 'S04' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_NOT_FOUND');
  });
});

// ============================================================
// plan refresh-evidence
// ============================================================

describe('plan refresh-evidence（S10-B-T01）', () => {
  it('pre-admission pristine skeleton 从旧 manifest digest 刷新到新 digest（含 previous_manifest_digest）', () => {
    const fx = makeCompileFixture();
    const compiled = callPlan(fx.root, 'compile', { input_path: 'request.json' });
    expect(compiled.ok).toBe(true);
    const initialized = callPlan(fx.root, 'initialize-evidence', { stage: 'S04' });
    expect(initialized.ok).toBe(true);
    const previousDigest = compiledManifestDigest(fx.root, '.proofloop/manifests/S04.json');
    expect(manifestBindingDigest(fx.root, 'delivery/stages/S04/evidence/S04-A.md')).toBe(previousDigest);

    // 改变 plan_digest 使 manifest 变化（replan 模拟）
    const manifestPath = path.join(fx.root, '.proofloop', 'manifests', 'S04.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { plan: { plan_digest: string } };
    manifest.plan.plan_digest = 'b'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const nextDigest = compiledManifestDigest(fx.root, '.proofloop/manifests/S04.json');
    expect(nextDigest).not.toBe(previousDigest);

    const envelope = callPlan(fx.root, 'refresh-evidence', {
      stage: 'S04',
      previous_manifest_digest: previousDigest,
    });
    expect(envelope.ok).toBe(true);
    const result = envelope.result as { refreshed: string[]; mode: string };
    expect(result.mode).toBe('refresh');
    expect(result.refreshed).toEqual(['delivery/stages/S04/evidence/S04-A.md']);
    expect(manifestBindingDigest(fx.root, 'delivery/stages/S04/evidence/S04-A.md')).toBe(nextDigest);
  });

  it('缺少 previous_manifest_digest fail closed（PLAN.PREVIOUS_MANIFEST_DIGEST_REQUIRED）', () => {
    const fx = makeCompileFixture();
    const compiled = callPlan(fx.root, 'compile', { input_path: 'request.json' });
    expect(compiled.ok).toBe(true);
    const envelope = callPlan(fx.root, 'refresh-evidence', { stage: 'S04' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.PREVIOUS_MANIFEST_DIGEST_REQUIRED');
  });

  it('非法 previous_manifest_digest fail closed（stale binding no-write）', () => {
    const fx = makeCompileFixture();
    const compiled = callPlan(fx.root, 'compile', { input_path: 'request.json' });
    expect(compiled.ok).toBe(true);
    const initialized = callPlan(fx.root, 'initialize-evidence', { stage: 'S04' });
    expect(initialized.ok).toBe(true);
    const envelope = callPlan(fx.root, 'refresh-evidence', {
      stage: 'S04',
      previous_manifest_digest: '0'.repeat(64),
    });
    expect(envelope.ok).toBe(false);
    // skeleton 保持旧 binding（no-write）
    expect(manifestBindingDigest(fx.root, 'delivery/stages/S04/evidence/S04-A.md')).toBe(
      compiledManifestDigest(fx.root, '.proofloop/manifests/S04.json'),
    );
  });
});

// ============================================================
// dispatcher 级（unified request 合同 + exit 合同）
// ============================================================

describe('plan 域 dispatcher 合同（S10-B-T01）', () => {
  function runCli(argv: readonly string[], cwd: string): { code: number; envelope: Record<string, unknown> } {
    const saved = console.log;
    const lines: string[] = [];
    console.log = (line?: unknown) => lines.push(String(line));
    try {
      const code = proofloopCli(argv, { cwd });
      return { code, envelope: JSON.parse(lines[0]) as Record<string, unknown> };
    } finally {
      console.log = saved;
    }
  }

  it('plan status --json --stage S10 → exit 0 + canonical ok envelope', () => {
    const { root } = makeS10BoundFixture();
    const { code, envelope } = runCli(['plan', 'status', '--json', '--stage', 'S10'], root);
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'plan', operation: 'status' });
  });

  it('plan validate --json --stage S10 → exit 0', () => {
    const { root } = makeS10BoundFixture();
    const { code, envelope } = runCli(['plan', 'validate', '--json', '--stage', 'S10'], root);
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect((envelope.result as { valid: boolean }).valid).toBe(true);
  });

  it('authority check --json --stage S10 → exit 0（canonical envelope）', () => {
    const { root } = makeS10BoundFixture();
    const { code, envelope } = runCli(['authority', 'check', '--json', '--stage', 'S10'], root);
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect((envelope.result as { ready: boolean }).ready).toBe(true);
  });

  it('未知 plan 操作 → exit 2 + RUNTIME.SCHEMA_MISMATCH（closed registry fail-closed）', () => {
    const { code, envelope } = runCli(['plan', 'bogus-op', '--json'], REPO_ROOT);
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect((envelope.findings as Array<{ code: string }>)[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });

  it('--json inline request 携带 plan 参数可用（plan validate --json {"stage":"S10"}）', () => {
    const { root } = makeS10BoundFixture();
    const { code, envelope } = runCli(['plan', 'validate', '--json', '{"stage":"S10"}'], root);
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
  });

  it('--json request 未知字段 fail closed（RUNTIME.INPUT_INVALID）', () => {
    const { code, envelope } = runCli(
      ['plan', 'validate', '--json', '{"stage":"S10","bogus":1}'],
      REPO_ROOT,
    );
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect((envelope.findings as Array<{ code: string }>)[0].code).toBe('RUNTIME.INPUT_INVALID');
  });

  it('materialize --json 携带 check:true 经 dispatcher 接受（CANDIDATE_CHECKED，零写入）', () => {
    const { root, requestPath } = makeActiveCandidateFixture();
    // 先渲染写入 candidate（dispatcher 路径）
    const first = runCli(
      ['plan', 'materialize', '--json', JSON.stringify({ stage: 'S04', input_path: requestPath })],
      root,
    );
    expect(first.code).toBe(CLI_EXIT.OK);
    const before = fs.readFileSync(path.join(root, 'delivery/stages/S04/tasks.md'), 'utf8');
    // check:true 走 closed schema（A1 步骤 5 登记）→ 只复核不写
    const { code, envelope } = runCli(
      [
        'plan',
        'materialize',
        '--json',
        JSON.stringify({ stage: 'S04', input_path: requestPath, check: true }),
      ],
      root,
    );
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    const result = envelope.result as Record<string, any>;
    expect(result.result).toBe('CANDIDATE_CHECKED');
    expect(result.writes).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'delivery/stages/S04/tasks.md'), 'utf8')).toBe(before);
  });

  it('materialize --json check 非 boolean fail closed（RUNTIME.INPUT_INVALID，零写入）', () => {
    const { root, requestPath } = makeActiveCandidateFixture();
    const { code, envelope } = runCli(
      [
        'plan',
        'materialize',
        '--json',
        JSON.stringify({ stage: 'S04', input_path: requestPath, check: 'yes' }),
      ],
      root,
    );
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    const finding = (envelope.findings as Array<{ code: string; message: string }>)[0];
    expect(finding.code).toBe('RUNTIME.INPUT_INVALID');
    expect(finding.message).toContain('check');
    // fail-closed 于任何写入之前（candidate 未渲染）
    expect(fs.existsSync(path.join(root, 'delivery/stages/S04/tasks.md'))).toBe(false);
  });

  it('--stage flag 与 request stage 冲突 fail closed（RUNTIME.INPUT_INVALID）', () => {
    const { code, envelope } = runCli(
      ['plan', 'validate', '--json', '{"stage":"S99"}', '--stage', 'S10'],
      REPO_ROOT,
    );
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect((envelope.findings as Array<{ code: string }>)[0].code).toBe('RUNTIME.INPUT_INVALID');
  });

  it('authority check 不支持的操作外参数不影响 closed 合同（未知 operation 仍 exit 2）', () => {
    const { code, envelope } = runCli(['authority', 'bogus', '--json'], REPO_ROOT);
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect((envelope.findings as Array<{ code: string }>)[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });
});

// ============================================================
// built dist 进程 smoke（真实 CLI）
// ============================================================

describe('built proofloop dist process: plan 域（S10-B-T01）', () => {
  it('dist: plan validate --json --stage S10 → exit 0 + canonical envelope（ok:true, valid:true）', () => {
    expect(fs.existsSync(DIST_PROOFLOOP)).toBe(true);
    const { root } = makeS10BoundFixture();
    const res = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'plan', 'validate', '--json', '--stage', 'S10'],
      { encoding: 'utf8', cwd: root, timeout: 60000 },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    const out = JSON.parse(res.stdout.trim()) as { ok: boolean; result: { valid: boolean } };
    expect(out.ok).toBe(true);
    expect(out.result.valid).toBe(true);
  });

  it('dist: 未知 plan 操作 → exit 2 + RUNTIME.SCHEMA_MISMATCH', () => {
    const res = spawnSync(process.execPath, [DIST_PROOFLOOP, 'plan', 'bogus-op', '--json'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 60000,
    });
    expect(res.status).toBe(2);
    const out = JSON.parse(res.stdout.trim()) as { ok: boolean; findings: Array<{ code: string }> };
    expect(out.ok).toBe(false);
    expect(out.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });

  it('dist: authority check --json --stage S10 → exit 0', () => {
    const { root } = makeS10BoundFixture();
    const res = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'authority', 'check', '--json', '--stage', 'S10'],
      { encoding: 'utf8', cwd: root, timeout: 60000 },
    );
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim()) as { ok: boolean; result: { ready: boolean } };
    expect(out.ok).toBe(true);
    expect(out.result.ready).toBe(true);
  });
});

// ============================================================
// S10-B-T02 repair：plan 闭集补齐（materialize / admit-spv / admit-stage-plan）
// 与 plan status fail-closed
// ============================================================

/** git 化 fixture：compile 出 manifest、构造 admission requests 并一次性提交
 * （admission 要求 clean worktree + HEAD 绑定；request 文件必须先于 commit 落盘）。
 * 返回 root-relative request 路径。 */
function makeAdmissionFixture(): {
  root: string;
  stagePlanRequestPath: string;
  spvRequestPath: string;
  spv: Record<string, unknown>;
  stagePlanRequest: Record<string, unknown>;
  snapshot: string;
} {
  const { root, manifestPath } = makeCompileFixture();
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'plan-admit@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Plan Admit Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  // compile 生成 manifest（input_path 必须 root-relative）
  const compiled = callPlan(root, 'compile', { stage: 'S04', input_path: 'request.json' });
  if (!compiled.ok) throw new Error('fixture compile failed: ' + JSON.stringify(compiled.findings));
  // 先提交 manifest 边界，再读 HEAD 作为 admission snapshot
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'candidate boundary']);
  const snapshot = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8')) as Record<string, any>;
  const manifestDigest = computeDigest(manifest);
  const spv = {
    version: 2,
    schema_version: 2,
    type: 'SPV_PASS',
    stage_id: 'S04',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: snapshot,
  };
  const spvWithDigest = { ...spv, digest: computeVNextSpvPassReceiptDigest(spv as never) };
  const stagePlanRequest = {
    version: 2,
    schema_version: 2,
    type: 'STAGE_PLAN_ADMISSION',
    project_root: root,
    manifest_path: manifestPath,
    stage_id: 'S04',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: snapshot,
    spv: spvWithDigest,
  };
  const spvRequest = {
    version: 2,
    schema_version: 2,
    type: 'SPV_ADMISSION',
    project_root: root,
    stage_id: 'S04',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: snapshot,
    spv: spvWithDigest,
  };
  // request 文件放 gitignored 的 .proofloop/requests/（admission 要求 clean worktree）
  const stagePlanRequestPath = write(root, '.proofloop/requests/admission.json', JSON.stringify(stagePlanRequest));
  const spvRequestPath = write(root, '.proofloop/requests/spv.json', JSON.stringify(spvRequest));
  return {
    root,
    stagePlanRequestPath: '.proofloop/requests/admission.json',
    spvRequestPath: '.proofloop/requests/spv.json',
    spv: spvWithDigest,
    stagePlanRequest,
    snapshot,
  };
}

/** Active materializer candidate fixture（active candidate shape；tasks.md 由
 * materialize 渲染写入，fixture 不预建）。 */
function makeActiveCandidateFixture(): { root: string; requestPath: string } {
  const root = tempRoot('proofloop-materialize-');
  const planPath = 'delivery/stages/S04/tasks.md';
  const entity = (ref_id: string, kind: string, entityId: string) => ({
    ref_id,
    kind,
    ref: `${planPath}#/entities/${entityId}`,
  });
  const input = {
    schema_version: 2,
    mode: 'initial',
    caller: 'brain',
    owner: 'pluginv2-active-plan-materializer',
    project_root: root,
    stage_id: 'S04',
    candidate_plan_path: planPath,
    selected_work_item_refs: [`${planPath}#/entities/S04-A-goal`],
    authority_entity_refs: [`${planPath}#/entities/S04-A-acceptance`],
    existing_plan_ref: null,
    finding_refs: [],
    stage_goal: {
      entity_id: 'S04-goal',
      ref_id: 'REF-S04-GOAL',
      goal: 'materialize fixture goal',
      refs: ['REF-S04-A-GOAL'],
    },
    dependencies: [],
    constraints: ['fixture'],
    out_of_scope: ['execution'],
    reference_index: [
      entity('REF-S04-GOAL', 'goal', 'S04-goal'),
      entity('REF-S04-A-GOAL', 'goal', 'S04-A-goal'),
      entity('REF-S04-A-T01', 'task', 'S04-A-T01'),
      entity('REF-S04-A-ACCEPTANCE', 'acceptance', 'S04-A-acceptance'),
      entity('REF-S04-A-SEAM', 'seam', 'S04-A-seam'),
      entity('REF-S04-A-ORACLE', 'oracle', 'S04-A-oracle'),
      entity('REF-S04-A-RISK', 'risk', 'S04-A-risk'),
    ],
    slices: [
      {
        slice_id: 'S04-A',
        goal_entity_id: 'S04-A-goal',
        goal: 'materialize fixture slice goal',
        proof_index: {
          slice_id: 'S04-A',
          goal_ref: 'REF-S04-A-GOAL',
          task_refs: ['REF-S04-A-T01'],
          acceptance_refs: ['REF-S04-A-ACCEPTANCE'],
          seam_refs: ['REF-S04-A-SEAM'],
          oracle_refs: ['REF-S04-A-ORACLE'],
          risk_refs: [
            {
              ref_id: 'REF-S04-A-RISK',
              applies_to_acceptance_refs: ['REF-S04-A-ACCEPTANCE'],
              applies_to_seam_refs: ['REF-S04-A-SEAM'],
            },
          ],
        },
        dependencies: [],
        required_skills: [],
        evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
        tasks: [
          {
            task_id: 'S04-A-T01',
            entity_id: 'S04-A-T01',
            goal: 'materialize fixture task goal',
            refs: ['REF-S04-A-T01'],
            dependencies: [],
            required_skills: [],
            execution_scope: {
              kind: 'implementation',
              code_paths: ['packages/runtime/src/cli/proofloop-plan.ts'],
              test_paths: ['packages/runtime/src/cli/proofloop-plan.spec.ts'],
              forbidden_paths: ['.proofloop/receipts'],
            },
            checkbox: false,
            status: 'NOT_STARTED',
            cv_status: 'NOT_RUN',
          },
        ],
      },
    ],
  };
  const requestPath = write(root, 'candidate.json', JSON.stringify(input));
  // public CLI 需要 trust root marker（.proofloop）
  fs.mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  return { root, requestPath: 'candidate.json' };
}

describe('plan materialize（S10-B-T02 repair + A1 step 2 渲染写入）', () => {
  it('缺少 input_path fail closed（PLAN.INPUT_REQUIRED）', () => {
    const envelope = callPlan(REPO_ROOT, 'materialize', { stage: 'S10' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.INPUT_REQUIRED');
  });

  it('渲染并写入 candidate tasks.md（CANDIDATE_READY + ref/digest）', () => {
    const { root, requestPath } = makeActiveCandidateFixture();
    const envelope = callPlan(root, 'materialize', { stage: 'S04', input_path: requestPath });
    expect(envelope.ok).toBe(true);
    const result = envelope.result as Record<string, any>;
    expect(result.result).toBe('CANDIDATE_READY');
    expect(result.stage_id).toBe('S04');
    expect(result.candidate_plan_path).toBe('delivery/stages/S04/tasks.md');
    expect(result.owner).toBe('pluginv2-active-plan-materializer');
    expect(result.candidate_only).toBe(true);
    expect(result.writes).toEqual(['delivery/stages/S04/tasks.md']);
    expect(result.runtime_handoff?.manifest).toBe('DEFERRED_TO_RUNTIME');
    expect(envelope.refs).toHaveLength(1);
    expect(envelope.refs[0].ref).toBe('delivery/stages/S04/tasks.md');
    expect(envelope.refs[0].digest).toMatch(/^[a-f0-9]{64}$/);
    // candidate-only 文件已落盘（渲染 + 写入，不再是只读回显）
    const content = fs.readFileSync(path.join(root, 'delivery/stages/S04/tasks.md'), 'utf8');
    expect(content).toContain('# Stage S04 — candidate');
    expect(content).toContain('<!-- SLICE:S04-A:BEGIN -->');
    expect(content).toContain('- plan_state: `CANDIDATE_ONLY`');
  });

  it('check: true 只复核不写（CANDIDATE_CHECKED）', () => {
    const { root, requestPath } = makeActiveCandidateFixture();
    expect(callPlan(root, 'materialize', { stage: 'S04', input_path: requestPath }).ok).toBe(true);
    const before = fs.readFileSync(path.join(root, 'delivery/stages/S04/tasks.md'), 'utf8');
    const envelope = callPlan(root, 'materialize', { stage: 'S04', input_path: requestPath, check: true });
    expect(envelope.ok).toBe(true);
    const result = envelope.result as Record<string, any>;
    expect(result.result).toBe('CANDIDATE_CHECKED');
    expect(result.writes).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'delivery/stages/S04/tasks.md'), 'utf8')).toBe(before);
  });

  it('initial 模式不覆盖已有 candidate（CANDIDATE_EXISTS，helper 结构化错误）', () => {
    const { root, requestPath } = makeActiveCandidateFixture();
    expect(callPlan(root, 'materialize', { stage: 'S04', input_path: requestPath }).ok).toBe(true);
    const envelope = callPlan(root, 'materialize', { stage: 'S04', input_path: requestPath });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('CANDIDATE_EXISTS');
    expect(envelope.findings[0].message).toBe(
      'initial materialization will not overwrite an existing candidate; use mode: replan',
    );
  });

  it('篡改 closure 后 check fail closed（TASK_SLICE_CLOSURE_MISMATCH，no-write）', () => {
    const { root, requestPath } = makeActiveCandidateFixture();
    expect(callPlan(root, 'materialize', { stage: 'S04', input_path: requestPath }).ok).toBe(true);
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    const content = fs.readFileSync(tasksPath, 'utf8');
    fs.writeFileSync(
      tasksPath,
      content.replace('  - acceptance_refs: `REF-S04-A-ACCEPTANCE`', '  - acceptance_refs: `REF-S04-A-ACCEPTANCE` (forged)'),
      'utf8',
    );
    const envelope = callPlan(root, 'materialize', { stage: 'S04', input_path: requestPath, check: true });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('TASK_SLICE_CLOSURE_MISMATCH');
    expect(envelope.findings[0].message).toMatch(/is not canonical/);
  });

  it('非法 candidate input fail closed（PLAN.INPUT_INVALID）', () => {
    const root = tempRoot('proofloop-plan-');
    write(root, 'request.json', '{"not":"candidate"}');
    const envelope = callPlan(root, 'materialize', { stage: 'S04', input_path: 'request.json' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.INPUT_INVALID');
  });

  it('绝对路径 input_path fail closed（PLAN.ARGUMENT_INVALID）', () => {
    const envelope = callPlan(REPO_ROOT, 'materialize', { stage: 'S10', input_path: '/etc/passwd' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.ARGUMENT_INVALID');
  });
});

describe('plan admit-stage-plan（S10-B-T02 repair）', () => {
  it('缺少 input fail closed（PLAN.INPUT_REQUIRED）', () => {
    const envelope = callPlan(REPO_ROOT, 'admit-stage-plan', { stage: 'S10' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.INPUT_REQUIRED');
  });

  it('接受 STAGE_PLAN_ADMISSION 并 write-once 落盘 SPV + Stage Plan receipt（refs 返回 ref+digest）', () => {
    const { root, stagePlanRequestPath } = makeAdmissionFixture();
    const envelope = callPlan(root, 'admit-stage-plan', { stage: 'S04', input_path: stagePlanRequestPath });
    expect(envelope.ok).toBe(true);
    expect(envelope.refs).toHaveLength(2);
    const spvRef = envelope.refs.find((r: { ref: string }) => r.ref.endsWith('vnext-spv-pass.json'));
    const stagePlanRef = envelope.refs.find((r: { ref: string }) => r.ref.endsWith('vnext-stage-plan.json'));
    expect(spvRef?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(stagePlanRef?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(root, spvRef?.ref as string))).toBe(true);
    expect(fs.existsSync(path.join(root, stagePlanRef?.ref as string))).toBe(true);
  });

  it('request.project_root 与 CLI root 不一致 fail closed（no-write）', () => {
    const { root, stagePlanRequest } = makeAdmissionFixture();
    const foreign = { ...stagePlanRequest, project_root: '/tmp/foreign-root' };
    write(root, '.proofloop/requests/admission-foreign.json', JSON.stringify(foreign));
    const envelope = callPlan(root, 'admit-stage-plan', { stage: 'S04', input_path: '.proofloop/requests/admission-foreign.json' });
    // 注意：request 文件本身落盘于 worktree（测试夹具），admission 校验在写 receipt 前拒绝
    expect(fs.existsSync(path.join(root, '.proofloop', 'receipts', 'plan', 'S04'))).toBe(false);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.PATH_OUTSIDE_ROOT');
  });

  it('重复提交 fail closed（already admitted，no-write）', () => {
    const { root, stagePlanRequestPath } = makeAdmissionFixture();
    const requestPath = stagePlanRequestPath;
    const first = callPlan(root, 'admit-stage-plan', { stage: 'S04', input_path: requestPath });
    expect(first.ok).toBe(true);
    const second = callPlan(root, 'admit-stage-plan', { stage: 'S04', input_path: requestPath });
    expect(second.ok).toBe(false);
    expect(second.findings[0].message.toLowerCase()).toMatch(/already/);
  });
});

describe('plan admit-spv（S10-B-T02 repair）', () => {
  it('缺少 input fail closed（PLAN.INPUT_REQUIRED）', () => {
    const envelope = callPlan(REPO_ROOT, 'admit-spv', { stage: 'S10' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.INPUT_REQUIRED');
  });

  it('接受 SPV_ADMISSION 并 write-once 落盘 vnext-spv-pass.json', () => {
    const { root, spvRequestPath, spv } = makeAdmissionFixture();
    const envelope = callPlan(root, 'admit-spv', { stage: 'S04', input_path: spvRequestPath });
    expect(envelope.ok).toBe(true);
    expect(envelope.refs).toHaveLength(1);
    expect(envelope.refs[0].ref).toBe('.proofloop/receipts/plan/S04/vnext-spv-pass.json');
    expect(envelope.refs[0].digest).toBe(spv.digest);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, envelope.refs[0].ref), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted.digest).toBe(spv.digest);
  });

  it('snapshot 与当前 Git HEAD 不一致 fail closed（fresh SPV 要求）', () => {
    const { root, spv } = makeAdmissionFixture();
    // 自洽的 stale SPV：snapshot_digest 指向不存在的 HEAD，digest 重算（先剥离旧 digest）
    const { digest: _spvDigest, ...spvBody } = spv;
    const staleSpv = { ...spvBody, snapshot_digest: 'f'.repeat(40) };
    const request = {
      version: 2,
      schema_version: 2,
      type: 'SPV_ADMISSION',
      project_root: root,
      stage_id: 'S04',
      manifest_digest: spv.manifest_digest,
      plan_digest: spv.plan_digest,
      snapshot_digest: 'f'.repeat(40),
      spv: { ...staleSpv, digest: computeVNextSpvPassReceiptDigest(staleSpv as never) },
    };
    write(root, '.proofloop/requests/spv-stale.json', JSON.stringify(request));
    const envelope = callPlan(root, 'admit-spv', { stage: 'S04', input_path: '.proofloop/requests/spv-stale.json' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].message).toMatch(/does not match current Git HEAD/);
    expect(fs.existsSync(path.join(root, '.proofloop', 'receipts', 'plan', 'S04'))).toBe(false);
  });

  it('重复提交 fail closed（already admitted）', () => {
    const { root, spvRequestPath } = makeAdmissionFixture();
    const requestPath = spvRequestPath;
    const first = callPlan(root, 'admit-spv', { stage: 'S04', input_path: requestPath });
    expect(first.ok).toBe(true);
    const second = callPlan(root, 'admit-spv', { stage: 'S04', input_path: requestPath });
    expect(second.ok).toBe(false);
    expect(second.findings[0].message.toLowerCase()).toMatch(/already/);
  });
});

describe('plan status fail-closed（S10-B-T02 repair）', () => {
  it('v1 Manifest fail closed（PLAN.MANIFEST_INVALID）', () => {
    const root = tempRoot('proofloop-status-');
    write(
      root,
      '.proofloop/manifests/S10.json',
      JSON.stringify({ version: 1, stage_id: 'S10', source_path: 'delivery/stages/S10/tasks.md' }),
    );
    const envelope = callPlan(root, 'status', { stage: 'S10' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_INVALID');
  });

  it('未知版本 Manifest fail closed', () => {
    const root = tempRoot('proofloop-status-');
    write(root, '.proofloop/manifests/S10.json', JSON.stringify({ version: 3, stage_id: 'S10' }));
    const envelope = callPlan(root, 'status', { stage: 'S10' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_INVALID');
  });

  it('stage_id 与请求不一致 fail closed（PLAN.MANIFEST_BINDING）', () => {
    const root = tempRoot('proofloop-status-');
    write(
      root,
      '.proofloop/manifests/S10.json',
      JSON.stringify({
        version: 2,
        schema_version: 2,
        stage_id: 'S11',
        plan: { ref: 'delivery/stages/S10/tasks.md', schema_version: 2 },
        slices: [],
        reference_index: {},
      }),
    );
    const envelope = callPlan(root, 'status', { stage: 'S10' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_BINDING');
  });

  it('malformed Manifest fail closed', () => {
    const root = tempRoot('proofloop-status-');
    write(root, '.proofloop/manifests/S10.json', 'not json');
    const envelope = callPlan(root, 'status', { stage: 'S10' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_INVALID');
  });

  it('合法 v2 Manifest（reference binding + evidence binding 完整）返回 ok:true', () => {
    const { root } = makeCompileFixture();
    const compiled = callPlan(root, 'compile', { stage: 'S04', input_path: 'request.json' });
    expect(compiled.ok).toBe(true);
    // evidence skeleton 必须存在且绑定当前 manifest digest（repair round 2 fail-closed）
    const initialized = callPlan(root, 'initialize-evidence', { stage: 'S04' });
    expect(initialized.ok).toBe(true);
    const envelope = callPlan(root, 'status', { stage: 'S04' });
    expect(envelope.ok).toBe(true);
    expect((envelope.result as Record<string, any>).stage_id).toBe('S04');
  });
});

// ============================================================
// S10-B-T02 repair round 2：stage/request binding 与 stale Evidence fail-closed
// ============================================================

describe('plan admission stage/request binding（S10-B-T02 repair round 2）', () => {
  it('admit-stage-plan: CLI --stage 与 request.stage_id 不一致 fail closed（零写入）', () => {
    const { root, stagePlanRequestPath } = makeAdmissionFixture();
    const envelope = callPlan(root, 'admit-stage-plan', { stage: 'S10', input_path: stagePlanRequestPath });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toMatch(/S04/);
    expect(fs.existsSync(path.join(root, '.proofloop', 'receipts', 'plan', 'S04'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.proofloop', 'receipts', 'plan', 'S10'))).toBe(false);
  });

  it('admit-spv: CLI --stage 与 request.stage_id 不一致 fail closed（零写入）', () => {
    const { root, spvRequestPath } = makeAdmissionFixture();
    const envelope = callPlan(root, 'admit-spv', { stage: 'S10', input_path: spvRequestPath });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(fs.existsSync(path.join(root, '.proofloop', 'receipts', 'plan', 'S04'))).toBe(false);
  });

  it('admit-stage-plan: 不提供 --stage 时以 request.stage_id 为准（正常路径）', () => {
    const { root, stagePlanRequestPath } = makeAdmissionFixture();
    const envelope = callPlan(root, 'admit-stage-plan', { input_path: stagePlanRequestPath });
    expect(envelope.ok).toBe(true);
  });

  it('materialize: CLI --stage 与 candidate.stage_id 不一致 fail closed', () => {
    const { root, requestPath } = makeActiveCandidateFixture();
    const envelope = callPlan(root, 'materialize', { stage: 'S10', input_path: requestPath });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
  });
});

describe('plan status stale/missing Evidence fail closed（S10-B-T02 repair round 2）', () => {
  it('compile + initialize-evidence 后 status ok:true（evidence binding 匹配）', () => {
    const { root } = makeCompileFixture();
    const compiled = callPlan(root, 'compile', { stage: 'S04', input_path: 'request.json' });
    expect(compiled.ok).toBe(true);
    const initialized = callPlan(root, 'initialize-evidence', { stage: 'S04' });
    expect(initialized.ok).toBe(true);
    const envelope = callPlan(root, 'status', { stage: 'S04' });
    expect(envelope.ok).toBe(true);
  });

  it('missing Evidence fail closed（PLAN.EVIDENCE_BINDING）', () => {
    const { root } = makeCompileFixture();
    const compiled = callPlan(root, 'compile', { stage: 'S04', input_path: 'request.json' });
    expect(compiled.ok).toBe(true);
    // 未 initialize-evidence：evidence 文件缺失
    const envelope = callPlan(root, 'status', { stage: 'S04' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.EVIDENCE_BINDING');
  });

  it('stale Evidence binding fail closed（PLAN.EVIDENCE_BINDING）', () => {
    const { root } = makeCompileFixture();
    expect(callPlan(root, 'compile', { stage: 'S04', input_path: 'request.json' }).ok).toBe(true);
    expect(callPlan(root, 'initialize-evidence', { stage: 'S04' }).ok).toBe(true);
    // 篡改 evidence 的 Manifest Digest 绑定行（stale）
    const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
    const content = fs.readFileSync(evidencePath, 'utf8');
    fs.writeFileSync(evidencePath, content.replace(/- Manifest Digest: [0-9a-f]{64}/, '- Manifest Digest: ' + 'e'.repeat(64)), 'utf8');
    const envelope = callPlan(root, 'status', { stage: 'S04' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.EVIDENCE_BINDING');
  });
});

// ============================================================
// S10-B-T02 repair round 2：built public proofloop 进程级回归
// ============================================================

describe('built public proofloop 进程级（S10-B-T02 repair round 2）', () => {
  it('dist: admit-stage-plan --stage 与 request.stage_id 不一致 exit 2 且零写入', () => {
    const { root, stagePlanRequestPath } = makeAdmissionFixture();
    const requestJson = JSON.stringify({
      domain: 'plan',
      operation: 'admit-stage-plan',
      stage: 'S10',
      input_path: stagePlanRequestPath,
    });
    const run = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'plan', 'admit-stage-plan', '--json', requestJson],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stdout.trim().split('\n')[0]) as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(fs.existsSync(path.join(root, '.proofloop', 'receipts', 'plan', 'S04'))).toBe(false);
  });

  it('dist: materialize --stage 与 candidate.stage_id 不一致 exit 2', () => {
    const { root, requestPath } = makeActiveCandidateFixture();
    const requestJson = JSON.stringify({
      domain: 'plan',
      operation: 'materialize',
      stage: 'S10',
      input_path: requestPath,
    });
    const run = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'plan', 'materialize', '--json', requestJson],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stdout.trim().split('\n')[0]) as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
  });

  it('dist: plan status stale Evidence exit 2', () => {
    const { root } = makeCompileFixture();
    const compileRequest = JSON.stringify({ domain: 'plan', operation: 'compile', stage: 'S04', input_path: 'request.json' });
    const compiled = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'plan', 'compile', '--json', compileRequest],
      { cwd: root, encoding: 'utf8' },
    );
    expect(compiled.status).toBe(0);
    const initRequest = JSON.stringify({ domain: 'plan', operation: 'initialize-evidence', stage: 'S04' });
    const initialized = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'plan', 'initialize-evidence', '--json', initRequest],
      { cwd: root, encoding: 'utf8' },
    );
    expect(initialized.status).toBe(0);
    // 篡改 evidence binding（stale）
    const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
    const content = fs.readFileSync(evidencePath, 'utf8');
    fs.writeFileSync(evidencePath, content.replace(/- Manifest Digest: [0-9a-f]{64}/, '- Manifest Digest: ' + 'e'.repeat(64)), 'utf8');
    const statusRequest = JSON.stringify({ domain: 'plan', operation: 'status', stage: 'S04' });
    const run = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'plan', 'status', '--json', statusRequest],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stdout.trim().split('\n')[0]) as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.EVIDENCE_BINDING');
  });
});

// ============================================================
// S10-B-T02 repair round 3：所有 plan operation 的 stage/request/manifest/candidate binding
// ============================================================

/** S04 fixture：compile + initialize-evidence 产出合法 S04 manifest + evidence。 */
function makeS04BoundFixture(): { root: string } {
  const { root } = makeCompileFixture();
  const compiled = callPlan(root, 'compile', { stage: 'S04', input_path: 'request.json' });
  if (!compiled.ok) throw new Error('fixture compile failed: ' + JSON.stringify(compiled.findings));
  const initialized = callPlan(root, 'initialize-evidence', { stage: 'S04' });
  if (!initialized.ok) throw new Error('fixture initialize failed: ' + JSON.stringify(initialized.findings));
  return { root };
}

describe('plan 全操作 stage/manifest/candidate binding（S10-B-T02 repair round 3）', () => {
  it('compile: candidate.stage_id 与 --stage 不一致 fail closed 零写入', () => {
    const { root, requestPath } = makeActiveCandidateFixture();
    const outputPath = '.proofloop/manifests/S10.json';
    const envelope = callPlan(root, 'compile', { stage: 'S10', input_path: requestPath, output_path: outputPath });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(fs.existsSync(path.join(root, outputPath))).toBe(false);
  });

  it('validate: manifest.stage_id 与 --stage 不一致 fail closed', () => {
    const { root } = makeS04BoundFixture();
    const envelope = callPlan(root, 'validate', { stage: 'S10', manifest: '.proofloop/manifests/S04.json' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_BINDING');
  });

  it('initialize-evidence: manifest.stage_id 与 --stage 不一致 fail closed 零写入', () => {
    const { root } = makeCompileFixture();
    expect(callPlan(root, 'compile', { stage: 'S04', input_path: 'request.json' }).ok).toBe(true);
    const envelope = callPlan(root, 'initialize-evidence', { stage: 'S10', manifest: '.proofloop/manifests/S04.json' });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_BINDING');
    expect(fs.existsSync(path.join(root, 'delivery/stages/S04/evidence/S04-A.md'))).toBe(false);
  });

  it('refresh-evidence: manifest.stage_id 与 --stage 不一致 fail closed', () => {
    const { root } = makeS04BoundFixture();
    const envelope = callPlan(root, 'refresh-evidence', {
      stage: 'S10',
      manifest: '.proofloop/manifests/S04.json',
      previous_manifest_digest: compiledManifestDigest(root, '.proofloop/manifests/S04.json'),
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_BINDING');
  });

  it('authority check: manifest.stage_id 与 --stage 不一致 fail closed', () => {
    const { root } = makeS04BoundFixture();
    const envelope = runAuthorityCheck(root, 'auto', { domain: 'authority', operation: 'check' }, {
      stage: 'S10',
      manifest: '.proofloop/manifests/S04.json',
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_BINDING');
  });
});

describe('built public proofloop plan binding 零写入回归（S10-B-T02 repair round 3）', () => {
  it('dist: compile/validate/initialize-evidence 的 stage 不一致全部 exit 2 零写入', () => {
    const { root, requestPath } = makeActiveCandidateFixture();
    fs.mkdirSync(path.join(root, '.proofloop', 'manifests'), { recursive: true });
    // compile: candidate S04 + --stage S10
    const compileRun = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'plan', 'compile', '--json',
        JSON.stringify({ domain: 'plan', operation: 'compile', stage: 'S10', input_path: requestPath, output_path: '.proofloop/manifests/S10.json' }),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(compileRun.status).toBe(2);
    expect(fs.existsSync(path.join(root, '.proofloop/manifests/S10.json'))).toBe(false);
    // validate: S04 manifest + --stage S10
    const s04 = makeS04BoundFixture();
    const validateRun = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'plan', 'validate', '--json',
        JSON.stringify({ domain: 'plan', operation: 'validate', stage: 'S10', manifest: '.proofloop/manifests/S04.json' }),
      ],
      { cwd: s04.root, encoding: 'utf8' },
    );
    expect(validateRun.status).toBe(2);
    const initializeRun = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'plan', 'initialize-evidence', '--json',
        JSON.stringify({ domain: 'plan', operation: 'initialize-evidence', stage: 'S10', manifest: '.proofloop/manifests/S04.json' }),
      ],
      { cwd: s04.root, encoding: 'utf8' },
    );
    expect(initializeRun.status).toBe(2);
  });
});

// ============================================================
// S10-B-T02 repair round 4：public CLI stage mismatch 零写入补全
// ============================================================

describe('built public proofloop stage mismatch 补全（S10-B-T02 repair round 4）', () => {
  it('dist: refresh-evidence stage mismatch exit 2 零写入', () => {
    const { root } = makeS04BoundFixture();
    const previous = compiledManifestDigest(root, '.proofloop/manifests/S04.json');
    const requestJson = JSON.stringify({
      domain: 'plan',
      operation: 'refresh-evidence',
      stage: 'S10',
      manifest: '.proofloop/manifests/S04.json',
      previous_manifest_digest: previous,
    });
    const before = fs.readFileSync(
      path.join(root, 'delivery/stages/S04/evidence/S04-A.md'),
      'utf8',
    );
    const run = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'plan', 'refresh-evidence', '--json', requestJson],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stdout.trim().split('\n')[0]) as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_BINDING');
    // 零写入：evidence 内容不变
    expect(fs.readFileSync(path.join(root, 'delivery/stages/S04/evidence/S04-A.md'), 'utf8'))
      .toBe(before);
  });

  it('dist: authority check stage mismatch exit 2 fail closed', () => {
    const { root } = makeS04BoundFixture();
    const requestJson = JSON.stringify({
      domain: 'authority',
      operation: 'check',
      stage: 'S10',
      manifest: '.proofloop/manifests/S04.json',
    });
    const run = spawnSync(
      process.execPath,
      [DIST_PROOFLOOP, 'authority', 'check', '--json', requestJson],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stdout.trim().split('\n')[0]) as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('PLAN.MANIFEST_BINDING');
  });
});

// ============================================================
// S10-B-T02 repair round 5：public CLI stage mismatch 完整零写入（目录快照）
// ============================================================

/** 递归快照 root 下全部文件（排除 .git）的相对路径 + 内容哈希。 */
function snapshotTree(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name === '.git') continue;
      const full = path.join(dir, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, relative);
      } else {
        entries.push(`${relative}:${computeDigest(fs.readFileSync(full, 'utf8'))}`);
      }
    }
  };
  walk(root, '');
  return entries.join('\n');
}

describe('built public proofloop stage mismatch 完整零写入（S10-B-T02 repair round 5）', () => {
  it('dist: 五个 stage mismatch 场景全部 exit 2 且目录快照不变', () => {
    // compile 场景（active candidate fixture）
    const compileRoot = makeActiveCandidateFixture().root;
    fs.mkdirSync(path.join(compileRoot, '.proofloop', 'manifests'), { recursive: true });
    const beforeCompile = snapshotTree(compileRoot);
    const compileRun = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'plan', 'compile', '--json',
        JSON.stringify({ domain: 'plan', operation: 'compile', stage: 'S10', input_path: 'candidate.json', output_path: '.proofloop/manifests/S10.json' }),
      ],
      { cwd: compileRoot, encoding: 'utf8' },
    );
    expect(compileRun.status).toBe(2);
    expect(snapshotTree(compileRoot)).toBe(beforeCompile);

    // validate / initialize-evidence / refresh-evidence / authority check（S04 bound fixture）
    const { root } = makeS04BoundFixture();
    const before = snapshotTree(root);
    const validateRun = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'plan', 'validate', '--json',
        JSON.stringify({ domain: 'plan', operation: 'validate', stage: 'S10', manifest: '.proofloop/manifests/S04.json' }),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(validateRun.status).toBe(2);
    expect(snapshotTree(root)).toBe(before);
    const initializeRun = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'plan', 'initialize-evidence', '--json',
        JSON.stringify({ domain: 'plan', operation: 'initialize-evidence', stage: 'S10', manifest: '.proofloop/manifests/S04.json' }),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(initializeRun.status).toBe(2);
    expect(snapshotTree(root)).toBe(before);
    const refreshRun = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'plan', 'refresh-evidence', '--json',
        JSON.stringify({
          domain: 'plan',
          operation: 'refresh-evidence',
          stage: 'S10',
          manifest: '.proofloop/manifests/S04.json',
          previous_manifest_digest: compiledManifestDigest(root, '.proofloop/manifests/S04.json'),
        }),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(refreshRun.status).toBe(2);
    expect(snapshotTree(root)).toBe(before);
    const authorityRun = spawnSync(
      process.execPath,
      [
        DIST_PROOFLOOP, 'authority', 'check', '--json',
        JSON.stringify({ domain: 'authority', operation: 'check', stage: 'S10', manifest: '.proofloop/manifests/S04.json' }),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(authorityRun.status).toBe(2);
    expect(snapshotTree(root)).toBe(before);
  });
});
