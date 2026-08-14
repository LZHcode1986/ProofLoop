/**
 * proofloop-gate.ts — S10-C-T02: gate 域 handler（dual-path SG, 2026-08-13）。
 *
 * Closed operation set（gate 域）：
 *  - `gate run`：SG 职责缩减为验证“各 Slice 集成证明齐全”——经 CLI→Runtime
 *    gate admission（`gate-admission.ts`）走正常路径（默认 receipts：每 Slice
 *    的 INTEGRATION_PASS receipt 链存在+绑定）或显式声明的兜底路径
 *    （`git_facts`：Git 历史事实）。**不再执行 Manifest runtime_proof 命令**
 *    （构建+测试由 SR 评审承担；runtime_proof 字段已删除，Receipt 不再绑定
 *    runtime_proof_digest）。全部通过 → GATE_PASS Receipt（Runtime seam，
 *    Persistence Runtime owner），envelope 返回 ok/gate/steps/errors/refs
 *    （Receipt ref+digest），并把结果持久化到
 *    `.proofloop/runtime/<stage>/gate-result.json`（Runtime 执行产物目录，
 *    S09 run-gate 先例）。
 *    失败（admission 拒绝 / canonical 拒绝）→ canonical envelope + exit 2
 *    零写入（不写 GATE_FAIL Receipt、不写 gate-result.json）。
 *  - `gate status`：只读 Gate 状态/Receipt 报告（Manifest 绑定 + stage-gate
 *    chain tip 投影），零写入。
 *  - 未知操作 fail closed（RUNTIME.NOT_IMPLEMENTED，exit 2）。
 *
 * 本 handler 不直接写 `.proofloop/receipts/*`；Receipt 写入由 gate admission
 * （Runtime seam）内部完成。`proofloop <domain> <operation>` dispatcher 与
 * `proofloop-common.ts` registry 的 gate 域接线按 S10-C-T01 先例由 Runtime
 * direct-fix 完成；本文件交付 handler + handler-direct argv 直通入口
 * （`dist/cli/proofloop-gate.js`，与 stage 域同构）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest, computeReceiptDigest, validateReceipt } from '@proofloop/kernel';
import type { Receipt } from '@proofloop/kernel';
import {
  errorEnvelope,
  failureEnvelope,
  emitEnvelope,
  okEnvelope,
  okEnvelopeWithRefs,
  parseCliArgs,
  resolveRequestInput,
  resolveTrustRoot,
  type CliCommand,
  type CliEnvelope,
  type ParsedCliArgs,
  type StageCliRequestInput,
} from './proofloop-common';
import { admitVNextGateResult } from '../vnext/gate-admission';
import { readVNextAdmissionAuthority } from '../vnext/next';
import type { VNextAdmissionAuthority } from '../vnext/types';
import { readVNextManifest } from '../vnext/dispatch';
import { detectPlanManifestRoute } from '../plan-services';
import { defaultManifestPath } from '../manifest-source';
import { stageGateReceiptDir } from '../receipt-layout';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { readGitHead, resolveGitRoot } from '../git-source';
// P-11 task B: read-only STAGE_CLOSE archived-facts probe.  `gate run` on an
// archived Stage is refused with zero writes (the Stage is a historical
// snapshot and is never re-gated).
import { readStageCloseFacts } from '../vnext/stage-close-facts';

// ============================================================
// Bounded operation parameters（unified request contract）
// ============================================================

export interface GateOperationParams {
  /** Target canonical Stage ID（`^S\d+$`）。 */
  readonly stage?: string;
  /**
   * Dual-path SG: explicit Gate verification path — `receipts`（默认，每
   * Slice 的 INTEGRATION_PASS receipt 链）或显式 `git_facts` 兜底（Git 历史
   * 事实；缺声明即正常路径，admission fail-closed，绝不静默兜底）。
   */
  readonly verificationSource?: 'receipts' | 'git_facts';
  /**
   * P-09: explicit REPAIR-driven re-run declaration — when `true` and the
   * stage-gate chain already has a PASS tip, `gate run` is allowed to append
   * a NEW GATE Receipt (the old PASS stays as write-once history) provided
   * the stage review chain tip is a REPAIR verdict (enforced by gate
   * admission).  Absent/false keeps the ALREADY_PASSED fail-closed rule.
   */
  readonly reGate?: boolean;
}

/** Merge the closed request input and CLI flags into bounded gate params。 */
export function collectGateParams(
  parsed: ParsedCliArgs,
  request: StageCliRequestInput,
): GateOperationParams {
  // S10-SR-001 repair: the gate-domain `verification_source` (closed enum,
  // validated in parseClosedRequestObject) reaches the handler through the
  // superset cast — the same precedent as the cutover confirmed/delete_list
  // fields.  A value outside the closed enum is refused by the schema, so
  // only `receipts` | `git_facts` | undefined can appear here; anything else
  // stays undefined (default receipts path).
  const extended = request as unknown as Record<string, unknown>;
  const declared = extended['verification_source'];
  const declaredReGate = extended['re_gate'];
  return {
    stage: parsed.stage ?? request.stage,
    verificationSource:
      declared === 'receipts' || declared === 'git_facts' ? declared : undefined,
    // P-09: `re_gate` (closed boolean, validated in parseClosedRequestObject)
    // reaches the handler through the same superset cast precedent.  A
    // non-boolean value is refused by the schema; only `true` enables the
    // REPAIR-driven re-run path.
    reGate: typeof declaredReGate === 'boolean' ? declaredReGate : undefined,
  };
}

// ============================================================
// Helpers
// ============================================================

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Canonical Stage 参数（`^S\d+$`；缺省/非法 fail closed）。 */
function requireStage(command: CliCommand, stage: string | undefined): CliEnvelope | { readonly stage: string } {
  if (stage === undefined) {
    return errorEnvelope(
      command,
      'STAGE.STAGE_REQUIRED',
      'gate operation requires a target stage (--stage <stage-id> or request field "stage")',
    );
  }
  if (!/^S\d+$/.test(stage)) {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      `stage must be a canonical Stage ID (^S\\d+$), received "${stage}"`,
    );
  }
  return { stage };
}

/** Canonical GATE Receipt root-relative ref（与 Runtime receipt layout 一致）。 */
function gateReceiptRef(stageId: string, digest: string): string {
  return path.posix.join('.proofloop', 'receipts', 'stage-gate', stageId, `${digest}.json`);
}

/** 当前 Git HEAD（集成 snapshot；不可解析 → null）。 */
function readProjectHead(projectRoot: string): string | null {
  try {
    const gitRoot = resolveGitRoot(projectRoot);
    return readGitHead(gitRoot);
  } catch {
    return null;
  }
}

// ============================================================
// gate run — 真实执行 + CLI→Runtime admission
// ============================================================

async function runGateRun(
  root: string,
  command: CliCommand,
  stage: string,
  params: GateOperationParams,
): Promise<CliEnvelope> {
  const manifestPath = defaultManifestPath(root, stage);
  const outputDir = path.join(root, '.proofloop', 'runtime', stage);
  const outputPath = path.join(outputDir, 'gate-result.json');
  const pendingPath = `${outputPath}.pending`;

  // ---- P-11 task B: archived-Stage guard（拒绝路径零副作用）----
  // 存在合法 v2 STAGE_CLOSE_RESULT envelope ⇒ Stage 已归档（历史快照）：
  // 拒绝执行（STAGE.GATE.ARCHIVED，exit 2），不跑 proof、不写 Receipt、不写
  // gate-result。探测 root-bound 且 fail-closed —— 目录不可读时同样拒绝。
  let closeFacts: ReturnType<typeof readStageCloseFacts>;
  try {
    closeFacts = readStageCloseFacts(root, stage);
  } catch (error) {
    return errorEnvelope(
      command,
      'STAGE.GATE.BLOCKED',
      `gate run refused: stage-close facts are unavailable (nothing executed, nothing written): ${errorMessage(error)}`,
    );
  }
  if (closeFacts.archived) {
    const closeType = closeFacts.close_type !== undefined ? `, close_type=${closeFacts.close_type}` : '';
    const digest = closeFacts.receipt_digest !== undefined ? ` (receipt ${closeFacts.receipt_digest})` : '';
    return errorEnvelope(
      command,
      'STAGE.GATE.ARCHIVED',
      `gate run refused: stage "${stage}" is archived (STAGE_CLOSE${closeType}${digest}); archived stages are historical snapshots and are never re-gated (nothing executed, nothing written)`,
    );
  }


  // ---- 只读 preflight（拒绝路径零副作用）----
  // 在调用 admission 之前完成全部只读检查，保证重复 run / 恢复状态下的
  // 拒绝路径零副作用：
  //  1. 构建链绑定上下文（Manifest + Runtime Proof + Authority，只读）；
  //  2. pending 恢复语义：既有 pending（前次中断或最终写失败的恢复状态）
  //     → 保留原样并 blocked，不删除/覆盖 pending；
  //  3. duplicate PASS tip：已有 GATE_PASS tip → canonical 拒绝
  //     （STAGE.GATE.ALREADY_PASSED），不执行任何写入；P-09：仅当请求显式
  //     声明 re_gate: true（REPAIR 驱动重跑）时放行 —— REPAIR 语义约束由
  //     gate admission 内部强制执行（review 链 tip 必须为 REPAIR）；
  //  4. 链损坏/伪造 → canonical fail closed。
  let binding: GateChainBinding;
  try {
    const manifest = readVNextManifest(root, manifestPath);
    const authority = readVNextAdmissionAuthority(root, stage);
    binding = {
      manifestDigest: computeDigest(manifest),
      planDigest: manifest.plan.plan_digest,
      stagePlanReceiptDigest: authority.stagePlan.digest,
      spvReceiptDigest: authority.spv.digest,
    };
  } catch (error) {
    return errorEnvelope(
      command,
      'STAGE.GATE.BLOCKED',
      `gate run preflight binding failed (nothing executed, nothing written): ${errorMessage(error)}`,
    );
  }

  let pendingPreExists = false;
  try {
    pendingPreExists = fs.statSync(pendingPath).isFile();
  } catch {
    pendingPreExists = false;
  }
  if (pendingPreExists) {
    // 恢复语义：pending 是前次中断/最终写失败的恢复状态 —— 保留原样，
    // blocked，不删除/覆盖 pending。
    return errorEnvelope(
      command,
      'STAGE.GATE.BLOCKED',
      'gate run refused: a pending gate-result from a previous run exists; recovery state preserved (pending untouched)',
    );
  }

  const chain = readGateChain(root, stage, binding);
  if (!chain.chain_valid) {
    return failureEnvelope(command, [
      { code: 'RUNTIME.RECEIPT_CHAIN_BROKEN', message: chain.error ?? 'stage-gate chain is broken' },
    ]);
  }
  if (chain.latest !== null && chain.latest.verdict === 'PASS' && params.reGate !== true) {
    return errorEnvelope(
      command,
      'STAGE.GATE.ALREADY_PASSED',
      `stage "${stage}" already has a Gate PASS tip (${chain.latest.digest}); re-gate refused (pass re_gate: true after a REPAIR review to re-gate)`,
    );
  }

  // 只读 preflight 通过 → 直接经 CLI→Runtime gate admission 写 GATE_PASS
  // Receipt（Runtime seam；集成齐全验证 + clean-tree/HEAD 绑定 + 兜底路径
  // 全部由 admission 内部完成）。**不再执行 Manifest runtime_proof 命令**
  // （dual-path SG：构建+测试由 SR 评审承担）。snapshot = 当前集成 HEAD。
  const snapshotDigest = readProjectHead(root);
  if (snapshotDigest === null) {
    return failureEnvelope(command, [
      {
        code: 'STAGE.GATE.FAILED',
        message: `gate run failed for stage "${stage}": cannot resolve the current Git HEAD as the integrated snapshot`,
      },
    ]);
  }

  // S10-C repair（CV REPAIR 2d5536ad / 3f052d04）：持久化顺序 —— 本次 run
  // 的辅助输出先写 pending 文件（先于 admission；写入失败 → 不调用 admission，
  // 零 Receipt，且**不触碰既有 gate-result.json**）；admission 拒绝 → 只删除
  // 本次新建的 pending（既有 gate-result.json 原内容保持不变）；admission
  // 成功 → 写最终 gate-result.json（含 receipt_ref）并删除 pending。
  const persistedBase = {
    success: true,
    gate: 'PASS',
    stage_id: stage,
    steps: [] as readonly unknown[],
    errors: [] as readonly string[],
    vnext: {
      manifest_digest: binding.manifestDigest,
      snapshot_digest: snapshotDigest,
      verification_source: params.verificationSource ?? 'receipts',
    },
  };
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(pendingPath, JSON.stringify(persistedBase, null, 2), 'utf-8');
  } catch (error) {
    return errorEnvelope(
      command,
      'STAGE.GATE.BLOCKED',
      `gate run step-result persistence failed before admission (zero Receipt): ${errorMessage(error)}`,
    );
  }

  // 集成证明齐全（receipts 或显式 git_facts）→ 经 CLI→Runtime gate admission
  // 写 GATE_PASS Receipt（Runtime seam；每次重验 Context/scope/snapshot/前序
  // Receipt 由 admission 内部完成）。admission 拒绝 → 零 Receipt、零
  // gate-result.json（不写伪造 PASS）。
  const admission = admitVNextGateResult({
    type: 'gate_result',
    stageId: stage,
    verdict: 'PASS',
    manifestDigest: binding.manifestDigest,
    snapshotDigest,
    summary: `proofloop gate run: slice integration proof(s) verified via ${params.verificationSource ?? 'receipts'}`,
    ...(params.verificationSource === undefined ? {} : { verification_source: params.verificationSource }),
    // P-09: REPAIR-driven re-run — the explicit re-gate declaration passes
    // through to gate admission (which enforces the REPAIR review tip).
    ...(params.reGate === true ? { re_gate: true } : {}),
  }, { projectRoot: root });
  if (!admission.accepted || admission.receipt_ref === null) {
    // admission 拒绝 → 仅清理本次 run 的 pending 辅助输出；既有
    // gate-result.json 保持原内容不变（CV REPAIR 3f052d04：exit 2 但
    // 持久状态零变化）。
    try {
      fs.rmSync(pendingPath, { force: true });
    } catch {
      // 删除失败不掩盖 admission 拒绝结论（finder 已含 canonical Finding）
    }
    return failureEnvelope(
      command,
      admission.findings.map((finding) => ({ code: finding.code, message: finding.message })),
    );
  }
  const ref = gateReceiptRef(stage, admission.receipt_ref);

  // admission 成功：写最终 gate-result.json（含 receipt_ref）并清理 pending。
  // 此步失败时 Receipt 已由 Runtime seam 落盘，报告 blocked 且不删除 Receipt；
  // 既有 gate-result.json 内容保持不被破坏（pending 保留以便重试）。
  try {
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          ...persistedBase,
          vnext: { ...persistedBase.vnext, receipt_ref: admission.receipt_ref },
        },
        null,
        2,
      ),
      'utf-8',
    );
    fs.rmSync(pendingPath, { force: true });
  } catch (error) {
    return errorEnvelope(
      command,
      'STAGE.GATE.BLOCKED',
      `gate run passed and was admitted, but the step-result receipt binding refresh failed: ${errorMessage(error)}`,
    );
  }

  return okEnvelopeWithRefs(
    command,
    {
      gate: 'PASS',
      stage_id: stage,
      steps: [],
      errors: [],
      manifest_digest: binding.manifestDigest,
      snapshot_digest: snapshotDigest,
      verification_source: params.verificationSource ?? 'receipts',
      receipt_ref: { ref, digest: admission.receipt_ref },
    },
    [{ ref, digest: admission.receipt_ref }],
  );
}

// ============================================================
// gate status — 只读 Gate 状态 / Receipt 报告
// ============================================================

interface GateChainTipReport {
  readonly receipt_type: string;
  readonly verdict: string;
  readonly digest: string;
  readonly ref: string;
}

interface GateChainReport {
  readonly receipt_count: number;
  readonly latest: GateChainTipReport | null;
  readonly chain_valid: boolean;
  readonly error?: string;
}

/**
 * S10-C repair（CV REPAIR 2d5536ad）：gate status 的链绑定上下文 ——
 * 与 gate-admission.ts 的链语义一致：每个 Receipt 必须绑定当前
 * Manifest/Proof/Authority tuple。
 */
interface GateChainBinding {
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly stagePlanReceiptDigest: string;
  readonly spvReceiptDigest: string;
}

const GATE_CHAIN_SNAPSHOT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GATE_CHAIN_DIGEST_RE = /^[a-f0-9]{64}$/;
const GATE_CHAIN_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const GATE_CHAIN_SLICE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** vNext GATE_RESULT payload 的 exact closed field set（未知字段拒绝）。
 *  `runtime_proof_digest` 是 legacy 字段：仅旧归档 Gate Receipt 携带
 *  （其绑定的 Runtime Proof 已删除），新 Receipt 不再包含。 */
const GATE_RESULT_PAYLOAD_FIELDS: readonly string[] = [
  'schema_version',
  'type',
  'action',
  'stage_id',
  'manifest_digest',
  'plan_digest',
  'runtime_proof_digest',
  'stage_plan_receipt_digest',
  'spv_receipt_digest',
  'snapshot_digest',
  'verdict',
  'integrated_slices',
  'summary',
  // Dual-path SG: explicit verification path marker（可选；receipts |
  // git_facts，旧 Receipt 不带该字段仍合法）。
  'verification_source',
  'receipt_chain_valid',
];

/** integrated_slices 元素的 exact closed 三字段（对齐 canonical
 *  validateVNextGateRecord：嵌套未知字段拒绝 + 格式 + 唯一性）。 */
const GATE_SLICE_BINDING_FIELDS: readonly string[] = [
  'slice_id',
  'integration_receipt_digest',
  'commit_sha',
];

/**
 * S10-C repair round 2/3：GATE_RESULT payload 完整 closed-schema 校验——
 * exact 字段闭集（incomplete / 未知字段拒绝）+ 类型 + 绑定 + 枚举 +
 * integrated_slices（非空数组、closed 三字段、格式、唯一性）+ summary
 * 非空字符串，与 gate-admission.ts 的 gateState 构造及 canonical
 * validateVNextGateRecord 强度一致。
 */
function assertGateResultPayloadSchema(
  receiptName: string,
  payload: Record<string, unknown>,
  stageId: string,
  binding: GateChainBinding,
): void {
  for (const key of Object.keys(payload)) {
    if (!GATE_RESULT_PAYLOAD_FIELDS.includes(key) && key !== 'restricted_bootstrap') {
      throw new Error(`Receipt ${receiptName} payload carries an unknown field "${key}" (closed GATE_RESULT schema)`);
    }
  }
  for (const key of GATE_RESULT_PAYLOAD_FIELDS) {
    // `runtime_proof_digest` is a legacy field: present only on archived
    // pre-decision Gate Receipts (the Runtime Proof it bound was deleted).
    if (key === 'runtime_proof_digest') continue;
    if (!(key in payload)) {
      throw new Error(`Receipt ${receiptName} payload is incomplete: missing required field "${key}"`);
    }
  }
  const { schema_version, type, action, stage_id: payloadStage, manifest_digest, plan_digest, runtime_proof_digest, stage_plan_receipt_digest, spv_receipt_digest, snapshot_digest, verdict, integrated_slices, summary, receipt_chain_valid, restricted_bootstrap, verification_source } = payload;
  if (schema_version !== 2) {
    throw new Error(`Receipt ${receiptName} payload schema_version is not 2`);
  }
  if (type !== 'GATE_RESULT' || action !== 'GATE') {
    throw new Error(`Receipt ${receiptName} payload is not a vNext GATE_RESULT/GATE fact`);
  }
  if (payloadStage !== stageId) {
    throw new Error(`Receipt ${receiptName} binds stage "${String(payloadStage)}", expected "${stageId}"`);
  }
  for (const [label, value] of [
    ['manifest_digest', manifest_digest],
    ['plan_digest', plan_digest],
    ['stage_plan_receipt_digest', stage_plan_receipt_digest],
    ['spv_receipt_digest', spv_receipt_digest],
  ] as const) {
    if (typeof value !== 'string' || !GATE_CHAIN_DIGEST_RE.test(value)) {
      throw new Error(`Receipt ${receiptName} payload.${label} is not a SHA-256 digest`);
    }
  }
  if (
    runtime_proof_digest !== undefined &&
    (typeof runtime_proof_digest !== 'string' || !GATE_CHAIN_DIGEST_RE.test(runtime_proof_digest))
  ) {
    throw new Error(`Receipt ${receiptName} payload.runtime_proof_digest is not a SHA-256 digest (legacy field)`);
  }
  if (
    manifest_digest !== binding.manifestDigest ||
    plan_digest !== binding.planDigest ||
    stage_plan_receipt_digest !== binding.stagePlanReceiptDigest ||
    spv_receipt_digest !== binding.spvReceiptDigest
  ) {
    throw new Error(`Receipt ${receiptName} does not bind the active Manifest/Authority tuple`);
  }
  if (typeof snapshot_digest !== 'string' || !GATE_CHAIN_SNAPSHOT_RE.test(snapshot_digest)) {
    throw new Error(`Receipt ${receiptName} has an invalid snapshot binding`);
  }
  if (verdict !== 'PASS' && verdict !== 'FAIL') {
    throw new Error(`Receipt ${receiptName} has an invalid verdict`);
  }
  // S10-C repair round 3：summary 必须非空字符串（canonical 强度）
  if (typeof summary !== 'string' || summary.length === 0) {
    throw new Error(`Receipt ${receiptName} payload.summary must be a non-empty string`);
  }
  // S10-C repair round 3：integrated_slices 非空数组 + 每元素 exact closed
  // 三字段（slice_id / commit_sha / integration_receipt_digest）+ 格式 +
  // 唯一性（对齐 canonical validateVNextGateRecord）
  if (!Array.isArray(integrated_slices) || integrated_slices.length === 0) {
    throw new Error(`Receipt ${receiptName} payload.integrated_slices must be a non-empty array of slice bindings`);
  }
  const seenSlices = new Set<string>();
  integrated_slices.forEach((entry, index) => {
    const entryLabel = `Receipt ${receiptName} payload.integrated_slices[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${entryLabel} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!GATE_SLICE_BINDING_FIELDS.includes(key)) {
        throw new Error(`${entryLabel} carries an unknown field "${key}" (closed slice binding)`);
      }
    }
    for (const key of GATE_SLICE_BINDING_FIELDS) {
      if (!(key in record)) {
        throw new Error(`${entryLabel} is incomplete: missing required field "${key}"`);
      }
    }
    if (typeof record['slice_id'] !== 'string' || !GATE_CHAIN_SLICE_ID_RE.test(record['slice_id'])) {
      throw new Error(`${entryLabel}.slice_id must be a canonical identifier`);
    }
    if (seenSlices.has(record['slice_id'])) {
      throw new Error(`${entryLabel}.slice_id is duplicated`);
    }
    seenSlices.add(record['slice_id']);
    if (typeof record['integration_receipt_digest'] !== 'string' || !GATE_CHAIN_DIGEST_RE.test(record['integration_receipt_digest'])) {
      throw new Error(`${entryLabel}.integration_receipt_digest must be a lowercase SHA-256 digest`);
    }
    if (typeof record['commit_sha'] !== 'string' || !GATE_CHAIN_GIT_SHA_RE.test(record['commit_sha'])) {
      throw new Error(`${entryLabel}.commit_sha must be a full lowercase Git commit SHA`);
    }
  });
  if (receipt_chain_valid !== true) {
    throw new Error(`Receipt ${receiptName} payload.receipt_chain_valid must be true`);
  }
  if (restricted_bootstrap !== undefined && restricted_bootstrap !== true) {
    throw new Error(`Receipt ${receiptName} payload.restricted_bootstrap must be true when present`);
  }
  // Dual-path SG: verification_source 是可选枚举（receipts | git_facts）；
  // 非法值 fail closed，缺省（旧 Receipt）合法。
  if (verification_source !== undefined && verification_source !== 'receipts' && verification_source !== 'git_facts') {
    throw new Error(`Receipt ${receiptName} payload.verification_source must be "receipts" or "git_facts" when present`);
  }
}

/**
 * 只读 stage-gate chain tip 投影：digest-addressed + self-digest 校验 +
 * previous_digest 链遍历（与 gate admission 同一读取规则；root-bound /
 * no-follow）。校验（任一失败 → chain_valid:false，status fail closed）：
 *  - 外层 Receipt.type ∈ {GATE_PASS, GATE_FAIL}（错位 Receipt 拒绝）；
 *  - 外层 Receipt.stage_id === 请求 stage；
 *  - payload 完整 closed-schema（字段闭集 / 未知字段 / incomplete 拒绝）；
 *  - payload.stage_id / tuple 绑定（manifest/plan/runtime_proof/stage_plan/
 *    spv digest）、snapshot 格式、verdict 枚举；
 *  - Receipt.type ↔ payload.verdict 一致性（GATE_PASS↔PASS、GATE_FAIL↔FAIL）。
 */
function readGateChain(root: string, stageId: string, binding: GateChainBinding): GateChainReport {
  const directory = stageGateReceiptDir(root, stageId);
  if (canonicalPathWithinRoot(root, directory) === null) {
    return { receipt_count: 0, latest: null, chain_valid: false, error: 'stage-gate chain directory is not root-bound' };
  }
  let names: string[];
  try {
    if (!fs.statSync(directory).isDirectory()) {
      return { receipt_count: 0, latest: null, chain_valid: true };
    }
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { receipt_count: 0, latest: null, chain_valid: true };
    }
    return { receipt_count: 0, latest: null, chain_valid: false, error: `stage-gate chain could not be read: ${errorMessage(error)}` };
  }

  const byDigest = new Map<string, Receipt>();
  try {
    for (const name of names) {
      const file = path.join(directory, name);
      const opened = openNoFollowRead(root, file);
      if (!opened.ok || opened.filePath !== file) {
        throw new Error(`unreadable or redirected Receipt: ${name}`);
      }
      let receipt: Receipt;
      try {
        receipt = validateReceipt(JSON.parse(fs.readFileSync(opened.fd, 'utf8')));
      } finally {
        fs.closeSync(opened.fd);
      }
      if (!/^[a-f0-9]{64}$/.test(receipt.digest) || name !== `${receipt.digest}.json`) {
        throw new Error(`Receipt ${name} is not digest-addressed`);
      }
      const { digest: ignoredDigest, ...content } = receipt;
      void ignoredDigest;
      if (computeReceiptDigest(content as never) !== receipt.digest) {
        throw new Error(`Receipt ${name} has an invalid self-digest`);
      }
      // S10-C repair：链语义（与 gate-admission 一致）
      if (receipt.type !== 'GATE_PASS' && receipt.type !== 'GATE_FAIL') {
        throw new Error(
          `Receipt ${name} has type ${receipt.type}; stage-gate chain accepts only GATE_PASS/GATE_FAIL`,
        );
      }
      if (receipt.stage_id !== stageId) {
        throw new Error(
          `Receipt ${name} outer stage_id is "${receipt.stage_id}", expected "${stageId}"`,
        );
      }
      const payload = (receipt.payload ?? {}) as Record<string, unknown>;
      // S10-C repair round 2：完整 closed-schema（字段闭集 / incomplete /
      // 未知字段 / 类型 / 绑定 / 枚举）
      assertGateResultPayloadSchema(name, payload, stageId, binding);
      // Receipt.type ↔ payload.verdict 一致性
      const expectedType = payload['verdict'] === 'PASS' ? 'GATE_PASS' : 'GATE_FAIL';
      if (receipt.type !== expectedType) {
        throw new Error(
          `Receipt ${name} type ${receipt.type} does not match payload.verdict ${String(payload['verdict'])}`,
        );
      }
      byDigest.set(receipt.digest, receipt);
    }
  } catch (error) {
    return {
      receipt_count: names.length,
      latest: null,
      chain_valid: false,
      error: `stage-gate chain is broken: ${errorMessage(error)}`,
    };
  }

  if (byDigest.size === 0) {
    return { receipt_count: 0, latest: null, chain_valid: true };
  }

  const roots = [...byDigest.values()].filter((receipt) => receipt['previous_digest'] === undefined);
  if (roots.length !== 1) {
    return { receipt_count: byDigest.size, latest: null, chain_valid: false, error: `stage-gate chain must have exactly one root Receipt (found ${roots.length})` };
  }
  const ordered: Receipt[] = [];
  const visited = new Set<string>();
  let current: Receipt | undefined = roots[0];
  while (current !== undefined) {
    if (visited.has(current.digest)) {
      return { receipt_count: byDigest.size, latest: null, chain_valid: false, error: 'stage-gate chain contains a cycle' };
    }
    visited.add(current.digest);
    ordered.push(current);
    const successors = [...byDigest.values()].filter((receipt) => receipt['previous_digest'] === current?.digest);
    if (successors.length > 1) {
      return { receipt_count: byDigest.size, latest: null, chain_valid: false, error: `Receipt ${current.digest} has more than one successor` };
    }
    current = successors[0];
  }
  if (visited.size !== byDigest.size) {
    return { receipt_count: byDigest.size, latest: null, chain_valid: false, error: 'stage-gate chain contains dangling or forked Receipts' };
  }
  const tip = ordered[ordered.length - 1];
  const payload = (tip.payload ?? {}) as Record<string, unknown>;
  const verdict = typeof payload['verdict'] === 'string' ? payload['verdict'] : 'unknown';
  return {
    receipt_count: byDigest.size,
    latest: {
      receipt_type: tip.type,
      verdict,
      digest: tip.digest,
      ref: gateReceiptRef(stageId, tip.digest),
    },
    chain_valid: true,
  };
}

function runGateStatus(root: string, command: CliCommand, stage: string): CliEnvelope {
  const manifestPath = defaultManifestPath(root, stage);
  const route = detectPlanManifestRoute(root, manifestPath);
  if (route !== 'vnext') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `gate status requires a vNext Manifest route, got "${route}"`,
    );
  }
  let manifest: ReturnType<typeof readVNextManifest>;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `gate status cannot read the vNext Manifest: ${errorMessage(error)}`,
    );
  }
  // S10-C repair：链绑定上下文 —— Stage Plan / SPV authority（链中每个
  // Receipt 的 stage_plan_receipt_digest / spv_receipt_digest 必须与当前
  // authority 一致；authority 缺失即 fail closed）。
  let authority: VNextAdmissionAuthority;
  try {
    authority = readVNextAdmissionAuthority(root, stage);
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `gate status cannot bind the Stage Plan/SPV authority: ${errorMessage(error)}`,
    );
  }
  const chain = readGateChain(root, stage, {
    manifestDigest: computeDigest(manifest),
    planDigest: manifest.plan.plan_digest,
    stagePlanReceiptDigest: authority.stagePlan.digest,
    spvReceiptDigest: authority.spv.digest,
  });
  if (!chain.chain_valid) {
    return failureEnvelope(command, [
      { code: 'RUNTIME.RECEIPT_CHAIN_BROKEN', message: chain.error ?? 'stage-gate chain is broken' },
    ]);
  }
  return okEnvelope(command, {
    schema_version: 2,
    stage_id: stage,
    manifest_digest: computeDigest(manifest),
    plan_digest: manifest.plan.plan_digest,
    gate: {
      receipt_count: chain.receipt_count,
      latest: chain.latest,
    },
    findings: [],
  });
}

// ============================================================
// Dispatcher
// ============================================================

/**
 * Run one gate-domain operation and return its canonical envelope。
 * 所有失败均为 structured finding（exit 2, no-write）；成功 exit 0。
 */
export async function runGateDomain(
  root: string,
  _rootSource: 'explicit' | 'auto',
  command: CliCommand,
  params: GateOperationParams,
): Promise<CliEnvelope> {
  switch (command.operation) {
    case 'run': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runGateRun(root, command, (stage as { stage: string }).stage, params);
    }
    case 'status': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runGateStatus(root, command, (stage as { stage: string }).stage);
    }
    default:
      // The dispatcher registry is the closed authority; this branch is a
      // defensive guard for registry extensions without a handler.
      return errorEnvelope(
        command,
        'RUNTIME.NOT_IMPLEMENTED',
        `operation "gate ${String(command.operation)}" is a closed command without a handler yet`,
      );
  }
}

// ============================================================
// Handler-direct argv entry（canonical root assertion + unified request）
// ============================================================

/**
 * Handler-direct entry for the gate domain: parses the closed flag set,
 * asserts the canonical trust root, resolves the unified request input and
 * dispatches `runGateDomain`.  This is the seam the built dist smoke exercises
 * with a real process; the public `proofloop <domain> <operation>` dispatcher
 * wiring follows the S10-C-T01 precedent (Runtime direct-fix).
 */
export async function runGateFromArgv(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<CliEnvelope> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const command: CliCommand = {
    domain: argv[0] ?? 'gate',
    operation: argv[1] ?? null,
  };
  if (command.domain !== 'gate') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `unknown domain "${command.domain}" (gate entry)`,
    );
  }
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv.slice(2));
  } catch (error) {
    return errorEnvelope(
      command,
      'USAGE',
      `usage: proofloop gate <operation> [flags] — ${errorMessage(error)}`,
    );
  }
  if (parsed.help) {
    return okEnvelope(command, { usage: 'proofloop gate <run|status> [flags]' });
  }
  let root: string;
  try {
    root = resolveTrustRoot({ explicitRoot: parsed.projectRoot ?? env.PROOFLOOP_ROOT, cwd }).root;
  } catch (error) {
    return errorEnvelope(command, 'RUNTIME.BLOCKED', errorMessage(error));
  }
  const requestValidation = resolveRequestInput(root, command, parsed);
  if (!requestValidation.ok) {
    return errorEnvelope(command, requestValidation.code, requestValidation.message);
  }
  return runGateDomain(root, 'auto', command, collectGateParams(parsed, requestValidation.request));
}

if (require.main === module) {
  runGateFromArgv(process.argv.slice(2)).then((envelope) => {
    emitEnvelope(envelope);
    process.exitCode = envelope.ok ? 0 : 2;
  });
}
