/**
 * proofloop-stage.ts — S10-C-T01: stage 域 handler。
 *
 * Closed operation set（DOMAIN_REGISTRY.stage）：
 *  - `stage status` / `stage next`：read-only 投影。复用 Runtime 的
 *    `reconcileStage`（v1 route）与 `VNextNextActionService.nextAction`
 *    （vnext route）服务 seam；输出 canonical envelope；零写入
 *    （vnext next 用 persistContext:false —— Context 持久化只属于
 *    `context prepare` 域）。
 *  - `stage admit-worker` / `admit-cv` / `admit-slice-commit` /
 *    `admit-integration`：structured result 经 CLI→Runtime vNext admission
 *    consumer 保存。CLI 只做 closed 参数合同与 outer/inner binding 检查，
 *    不重复实现 admission 逻辑 —— 复用 vnext admission 的 validate + admit
 *    函数（每次重验 Context/scope/snapshot/changed files/前序 Receipt 由
 *    admission 函数内部完成）。成功返回 Receipt ref+digest；失败 canonical
 *    Finding + no-write（exit 2）。
 *  - `stage run-gate`：S10-C-T02 交付（此处 NOT_IMPLEMENTED fail closed）。
 *  - `stage close`（P-11）：vNext Stage Close admission 的 public CLI 入口 ——
 *    closed 参数合同（stage/close_type/reason/manifest_digest/snapshot_digest，
 *    plan_digest 与 stage_plan/spv receipt digest 由 seam 重读派生）经
 *    `admitVNextStageClose` 落盘 write-once STAGE_CLOSE_PASS receipt
 *    （stage-close/<stage>/<digest>.json）；成功返回 receipt ref+digest，
 *    失败 canonical Finding + no-write（exit 2）。
 *
 * 本 handler 不直接写 `.proofloop/*`；Receipt 写入由 vnext admission 函数
 * 内部完成（Runtime seam，Persistence Runtime owner）。
 */

import * as path from 'node:path';
import {
  errorEnvelope,
  failureEnvelope,
  okEnvelope,
  okEnvelopeWithRefs,
  parseCliArgs,
  resolveRequestInput,
  resolveTrustRoot,
  type CliCommand,
  type CliEnvelope,
  type CliFinding,
  type ParsedCliArgs,
  type StageCliRequestInput,
} from './proofloop-common';
import { reconcileStage } from '../reconcile';
import type { ReconcileStageResult } from '../reconcile';
import { detectPlanManifestRoute } from '../plan-services';
import { defaultManifestPath } from '../manifest-source';
import { VNextNextActionService } from '../vnext/next';
import type { VNextNextActionOutput } from '../vnext/next';
import { NextActionService } from '../next-action-service';
import type { NextActionOutput } from '../next-action-service';
import { validateVNextWorkerResultEnvelope } from '../relay-contract';
import { admitVNextWorkerResult } from '../vnext/worker-admission';
import { validateVNextCVResultEnvelope, admitVNextCVResult } from '../vnext/cv-admission';
import { validateVNextSliceCommitRequest, admitVNextSliceCommit } from '../vnext/commit-admission';
import { validateVNextIntegrationRequest, admitVNextIntegration } from '../vnext/integration-admission';
import { admitVNextStageClose } from '../vnext/stage-close-admission';
import type { VNextStageCloseAdmissionRequest } from '../vnext/stage-close-admission';
import type { AdmitResult } from '../admit-pipeline';

// ============================================================
// Bounded operation parameters（unified request contract）
// ============================================================

export interface StageOperationParams {
  /** Target canonical Stage ID（`^S\d+$`）。 */
  readonly stage?: string;
  /** Slice binding（Manifest-declared；admit 操作必需）。 */
  readonly slice?: string;
  /** admit-worker / admit-cv: closed vNext structured-result envelope。 */
  readonly envelope?: unknown;
  /** admit-cv legacy scalars —— vNext CLI 拒绝（cross-version fail closed）。 */
  readonly verdict?: string;
  readonly snapshotDigest?: string;
  readonly summary?: string;
  /** admit-slice-commit / admit-integration: 绑定 commit SHA。 */
  readonly commitSha?: string;
  /** admit-slice-commit: 绑定前序 CV_PASS receipt digest。 */
  readonly cvReceiptDigest?: string;
  /** P-11 stage close: closed close_type（full | restricted）。 */
  readonly closeType?: string;
  /** P-11 stage close: 非空 close reason（fail-closed）。 */
  readonly reason?: string;
  /** P-11 stage close: Manifest digest（sha256；seam 重验）。 */
  readonly manifestDigest?: string;
}

/** Merge the closed request input and CLI flags into bounded stage params。 */
export function collectStageParams(
  parsed: ParsedCliArgs,
  request: StageCliRequestInput,
): StageOperationParams {
  return {
    stage: parsed.stage ?? request.stage,
    slice: parsed.slice ?? request.slice,
    envelope: request.envelope,
    verdict: request.verdict,
    snapshotDigest: request.snapshot_digest,
    summary: request.summary,
    commitSha: request.commit_sha,
    cvReceiptDigest: request.cv_receipt_digest,
    closeType: request.close_type,
    reason: request.reason,
    manifestDigest: request.manifest_digest,
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
      'stage operation requires a target stage (--stage <stage-id> or request field "stage")',
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

/** 显式 vNext Worker envelope 路由；非 v2 不进入 admission。 */
type WorkerEnvelopeRoute = 'vnext' | 'v1' | 'unknown';

function detectWorkerEnvelopeRoute(value: unknown): WorkerEnvelopeRoute {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'unknown';
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] === 2) return 'vnext';
  if (record['schemaVersion'] === 1) return 'v1';
  return 'unknown';
}

/** 显式 vNext CV_RESULT envelope 路由（与 Host 同一判别规则）。 */
type CvEnvelopeRoute = 'vnext' | 'legacy' | 'unknown';

function detectCvEnvelopeRoute(value: unknown): CvEnvelopeRoute {
  if (value === undefined) return 'legacy';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'unknown';
  const record = value as Record<string, unknown>;
  return record['schema_version'] === 2 && record['type'] === 'CV_RESULT' ? 'vnext' : 'unknown';
}

/** vNext admit 状态的有界投影（永不泄漏完整 Receipt payload）。 */
function projectVNextAdmitState(state: object | undefined): Record<string, unknown> | null {
  if (state === undefined) return null;
  const source = state as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of [
    'schema_version',
    'type',
    'action',
    'stage_id',
    'slice_id',
    'task_id',
    'mode',
    'outcome',
    'verdict',
    'verification_type',
    'manifest_digest',
    'plan_digest',
    'proof_index_digest',
    'snapshot_digest',
    'commit_sha',
    'slice_commit_receipt_digest',
    'cv_receipt_digest',
    'context_ref',
    'context_digest',
    'worker_receipt_digest',
    'changed_files',
    'receipt_chain_valid',
  ]) {
    const value = source[field];
    if (value !== undefined) {
      projected[field] = Array.isArray(value) ? [...value] : value;
    }
  }
  return projected;
}

const ADMIT_RECEIPT_CATEGORY: Record<string, string> = {
  'admit-worker': 'tasks',
  'admit-cv': 'cv',
  'admit-slice-commit': 'committer',
  'admit-integration': 'integration',
} as const;

/** Root-relative digest-addressed Receipt ref（与 Runtime receipt layout 一致）。 */
function admitReceiptRef(operation: string, stageId: string, sliceId: string, digest: string): string {
  return path.posix.join(
    '.proofloop',
    'receipts',
    ADMIT_RECEIPT_CATEGORY[operation],
    stageId,
    sliceId,
    `${digest}.json`,
  );
}

function findingOf(findings: readonly { readonly code: string; readonly message: string }[]): CliFinding[] {
  return findings.map((finding) => ({ code: finding.code, message: finding.message }));
}

/** 投影一个 vNext admit 结果：成功 → ok + refs（ref+digest）；失败 → canonical Finding。 */
function admitResultEnvelope(
  command: CliCommand,
  operation: string,
  stageId: string,
  sliceId: string,
  result: AdmitResult<object>,
): CliEnvelope {
  if (result.accepted && result.receipt_ref !== null) {
    const ref = admitReceiptRef(operation, stageId, sliceId, result.receipt_ref);
    return okEnvelopeWithRefs(
      command,
      {
        accepted: true,
        receipt_ref: { ref, digest: result.receipt_ref },
        new_state: projectVNextAdmitState(result.vnext_state),
        findings: [],
      },
      [{ ref, digest: result.receipt_ref }],
    );
  }
  return failureEnvelope(command, findingOf(result.findings));
}

// ============================================================
// status / next（read-only projections）
// ============================================================

/** vNext status 投影（与 Host projectVNextStageStatusData 同语义）。 */
function projectVNextStageStatusData(output: VNextNextActionOutput): Record<string, unknown> {
  return {
    schema_version: 2,
    action: output.action,
    action_detail: output.action_detail,
    responsible_role: output.responsible_role,
    stage_id: output.stage_id,
    ...(output.slice_id !== undefined ? { slice_id: output.slice_id } : {}),
    ...(output.task_id !== undefined ? { task_id: output.task_id } : {}),
    ...(output.mode !== undefined ? { mode: output.mode } : {}),
    ...(output.context_ref !== undefined ? { context_ref: output.context_ref } : {}),
    ...(output.manifest_digest !== undefined ? { manifest_digest: output.manifest_digest } : {}),
    ...(output.plan_digest !== undefined ? { plan_digest: output.plan_digest } : {}),
    ...(output.proof_index_digest !== undefined
      ? { proof_index_digest: output.proof_index_digest }
      : {}),
    ...(output.snapshot_digest !== undefined ? { snapshot_digest: output.snapshot_digest } : {}),
    receipt_chain_valid: output.receipt_chain_valid,
    findings: output.findings,
  };
}

/** vNext next 投影。 */
function projectVNextStageNextData(output: VNextNextActionOutput): Record<string, unknown> {
  return projectVNextStageStatusData(output);
}

/** v1 status 投影（reconcileStage 有界事实；永不泄漏 Receipt payload）。 */
function projectStageStatusData(reconciled: ReconcileStageResult): Record<string, unknown> {
  return {
    stage_id: reconciled.stage_id,
    stage_state: reconciled.stage_state,
    project_state: reconciled.project_state,
    receipt_chain_valid: reconciled.receipt_chain_valid,
    slices: reconciled.slices.map((s) => ({
      slice_id: s.slice_id,
      slice_state: s.slice_state,
      cv_status: s.cv_status,
      tasks_checked: s.tasks.filter((t) => t.checked).length,
      tasks_total: s.tasks.length,
      slice_evidence_finalized: s.slice_evidence_finalized,
      repair_attempt: s.repair_attempt,
      complete: s.complete,
      integrated: s.integrated,
      committed: s.committed,
    })),
  };
}

/** v1 next 投影（canonical NextActionOutput 5-key payload）。 */
function projectStageNextData(output: NextActionOutput): Record<string, unknown> {
  return {
    action: output.action,
    action_detail: output.action_detail,
    responsible_role: output.responsible_role,
    receipt_chain_valid: output.receipt_chain_valid,
    findings: output.findings,
  };
}

const vNextNextActionService = new VNextNextActionService();
const nextActionService = new NextActionService();

function runStageStatus(
  root: string,
  command: CliCommand,
  stage: string,
): CliEnvelope {
  const manifestPath = defaultManifestPath(root, stage);
  const route = detectPlanManifestRoute(root, manifestPath);
  if (route === 'vnext') {
    try {
      const output = vNextNextActionService.nextAction({
        projectRoot: root,
        stageId: stage,
        manifestPath,
        persistContext: false,
      });
      if (output.action === 'VALIDATE') {
        return errorEnvelope(
          command,
          'STAGE.VALIDATE_REQUIRED',
          `stage "${stage}" is not admitted for execution: ${output.action_detail}`,
        );
      }
      return okEnvelope(command, projectVNextStageStatusData(output));
    } catch (error) {
      return errorEnvelope(command, 'STAGE.BLOCKED', errorMessage(error));
    }
  }
  if (route === 'unknown') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `manifest at "${manifestPath}" has an unknown or unsupported version discriminator; refusing v1 fallback`,
    );
  }
  try {
    const reconciled = reconcileStage({ projectRoot: root, stageId: stage });
    const errorFindings = reconciled.findings.filter((finding) => finding.severity === 'error');
    if (errorFindings.length > 0) {
      return failureEnvelope(command, findingOf(errorFindings));
    }
    return okEnvelope(command, projectStageStatusData(reconciled));
  } catch (error) {
    return errorEnvelope(command, 'STAGE.STAGE_NOT_FOUND', errorMessage(error));
  }
}

function runStageNext(
  root: string,
  command: CliCommand,
  stage: string,
): CliEnvelope {
  const manifestPath = defaultManifestPath(root, stage);
  const route = detectPlanManifestRoute(root, manifestPath);
  if (route === 'vnext') {
    try {
      const output = vNextNextActionService.nextAction({
        projectRoot: root,
        stageId: stage,
        manifestPath,
        // S10-C-T01: stage next 是只读投影 —— Context 持久化只属于
        // `context prepare` 域（persistContext:false，零写入）。
        persistContext: false,
      });
      if (output.action === 'VALIDATE') {
        return errorEnvelope(
          command,
          'STAGE.VALIDATE_REQUIRED',
          `stage "${stage}" is not admitted for execution: ${output.action_detail}`,
        );
      }
      return okEnvelope(command, projectVNextStageNextData(output));
    } catch (error) {
      return errorEnvelope(command, 'STAGE.BLOCKED', errorMessage(error));
    }
  }
  if (route === 'unknown') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `manifest at "${manifestPath}" has an unknown or unsupported version discriminator; refusing v1 fallback`,
    );
  }
  try {
    const output = nextActionService.nextAction({
      projectRoot: root,
      stageId: stage,
      manifestPath,
    });
    return okEnvelope(command, projectStageNextData(output));
  } catch (error) {
    return errorEnvelope(command, 'STAGE.STAGE_NOT_FOUND', errorMessage(error));
  }
}

// ============================================================
// admit operations（CLI→Runtime vNext admission consumer）
// ============================================================

function runAdmitWorker(
  root: string,
  command: CliCommand,
  stage: string,
  params: StageOperationParams,
): CliEnvelope {
  if (params.envelope === undefined) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage admit-worker requires the request field "envelope" (closed v2 WorkerResultEnvelope)',
    );
  }
  const route = detectWorkerEnvelopeRoute(params.envelope);
  if (route === 'v1') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage admit-worker accepts only the explicit v2 Worker envelope; legacy v1 Worker results fail closed (cross-version)',
    );
  }
  if (route !== 'vnext') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage admit-worker envelope must carry the explicit schemaVersion 2 discriminator; unknown versions never fall back',
    );
  }
  let envelope: ReturnType<typeof validateVNextWorkerResultEnvelope>;
  try {
    envelope = validateVNextWorkerResultEnvelope(params.envelope);
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `stage admit-worker envelope failed the runtime v2 WorkerResultEnvelope schema: ${errorMessage(error)}`,
    );
  }
  // outer/inner binding（与 Host 同一规则）：外层 stage/slice 必须匹配 envelope。
  if (envelope.stageId !== stage || envelope.sliceId !== params.slice) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `stage admit-worker envelope binding mismatch — outer stage/slice (${stage}/${String(params.slice)}) do not match envelope.stageId/sliceId (${envelope.stageId}/${envelope.sliceId})`,
    );
  }
  const result = admitVNextWorkerResult(envelope, { projectRoot: root });
  return admitResultEnvelope(command, 'admit-worker', stage, envelope.sliceId, result);
}

function runAdmitCv(
  root: string,
  command: CliCommand,
  stage: string,
  params: StageOperationParams,
): CliEnvelope {
  const route = detectCvEnvelopeRoute(params.envelope);
  if (route === 'legacy') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage admit-cv accepts only the closed vNext CV_RESULT envelope; legacy scalar CV results fail closed (cross-version)',
    );
  }
  if (route !== 'vnext') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage admit-cv envelope must be an explicit vNext CV_RESULT object (schema_version 2, type CV_RESULT)',
    );
  }
  let envelope: ReturnType<typeof validateVNextCVResultEnvelope>;
  try {
    envelope = validateVNextCVResultEnvelope(params.envelope);
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `stage admit-cv envelope failed the runtime vNext CV_RESULT schema: ${errorMessage(error)}`,
    );
  }
  if (envelope.stage_id !== stage || envelope.slice_id !== params.slice) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `stage admit-cv envelope binding mismatch — outer stage/slice (${stage}/${String(params.slice)}) do not match envelope.stage_id/slice_id (${envelope.stage_id}/${envelope.slice_id})`,
    );
  }
  const result = admitVNextCVResult(envelope, { projectRoot: root });
  return admitResultEnvelope(command, 'admit-cv', stage, envelope.slice_id, result);
}

function runAdmitSliceCommit(
  root: string,
  command: CliCommand,
  stage: string,
  params: StageOperationParams,
): CliEnvelope {
  const slice = params.slice;
  const commitSha = params.commitSha;
  const cvReceiptDigest = params.cvReceiptDigest;
  if (slice === undefined || commitSha === undefined || cvReceiptDigest === undefined) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage admit-slice-commit requires request fields "slice", "commit_sha" and "cv_receipt_digest"',
    );
  }
  let request: ReturnType<typeof validateVNextSliceCommitRequest>;
  try {
    request = validateVNextSliceCommitRequest({
      type: 'slice_commit',
      stageId: stage,
      sliceId: slice,
      commitSha,
      cvReceiptDigest,
    });
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `stage admit-slice-commit request failed the runtime vNext Slice Commit schema: ${errorMessage(error)}`,
    );
  }
  const result = admitVNextSliceCommit(request, { projectRoot: root });
  return admitResultEnvelope(command, 'admit-slice-commit', stage, slice, result);
}

function runAdmitIntegration(
  root: string,
  command: CliCommand,
  stage: string,
  params: StageOperationParams,
): CliEnvelope {
  const slice = params.slice;
  const commitSha = params.commitSha;
  if (slice === undefined || commitSha === undefined) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage admit-integration requires request fields "slice" and "commit_sha"',
    );
  }
  let request: ReturnType<typeof validateVNextIntegrationRequest>;
  try {
    request = validateVNextIntegrationRequest({
      type: 'integration',
      stageId: stage,
      sliceId: slice,
      commitSha,
    });
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `stage admit-integration request failed the runtime vNext Integration schema: ${errorMessage(error)}`,
    );
  }
  const result = admitVNextIntegration(request, { projectRoot: root });
  return admitResultEnvelope(command, 'admit-integration', stage, slice, result);
}

// ============================================================
// stage close（P-11 CLI→Runtime vNext Stage Close admission consumer）
// ============================================================

/** stage-close 成功投影（有界字段集，与 review finalize-stage 同构）。 */
function projectStageCloseState(state: object | undefined): Record<string, unknown> | null {
  if (state === undefined) return null;
  const source = state as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of [
    'schema_version',
    'type',
    'action',
    'stage_id',
    'close_type',
    'reason',
    'manifest_digest',
    'plan_digest',
    'snapshot_digest',
    'stage_plan_receipt_digest',
    'spv_receipt_digest',
    'receipt_chain_valid',
  ]) {
    const value = source[field];
    if (value !== undefined) projected[field] = value;
  }
  return projected;
}

/** stage close 成功 envelope（receipt ref 指向 stage-close/<stage>/<digest>.json）。 */
function admitStageCloseEnvelope(
  command: CliCommand,
  stageId: string,
  result: AdmitResult<object>,
): CliEnvelope {
  if (result.accepted && result.receipt_ref !== null) {
    const ref = path.posix.join('.proofloop', 'receipts', 'stage-close', stageId, `${result.receipt_ref}.json`);
    return okEnvelopeWithRefs(
      command,
      {
        accepted: true,
        receipt_ref: { ref, digest: result.receipt_ref },
        new_state: projectStageCloseState(result.vnext_state),
        findings: [],
      },
      [{ ref, digest: result.receipt_ref }],
    );
  }
  return failureEnvelope(command, findingOf(result.findings));
}

function runStageClose(
  root: string,
  command: CliCommand,
  stage: string,
  params: StageOperationParams,
): CliEnvelope {
  // closed 参数合同（与 admitVNextStageClose 实际 schema 对齐：stageId /
  // closeType / reason / manifestDigest / snapshotDigest）。plan_digest 与
  // stage_plan_receipt_digest / spv_receipt_digest 由 seam 从 root-bound
  // Stage Plan/SPV authority 重读派生，caller 不可注入（未登记字段在
  // closed request schema 层 fail closed）。
  const closeType = params.closeType;
  const reason = params.reason;
  const manifestDigest = params.manifestDigest;
  const snapshotDigest = params.snapshotDigest;
  if (closeType === undefined) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage close requires the request field "close_type" (closed set: full | restricted)',
    );
  }
  if (closeType !== 'full' && closeType !== 'restricted') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `stage close close_type must be "full" or "restricted", received "${closeType}"`,
    );
  }
  if (reason === undefined || reason.length === 0) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage close requires a non-empty request field "reason"',
    );
  }
  if (manifestDigest === undefined) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage close requires the request field "manifest_digest" (lowercase SHA-256)',
    );
  }
  if (snapshotDigest === undefined) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'stage close requires the request field "snapshot_digest" (Git snapshot digest)',
    );
  }
  const request: VNextStageCloseAdmissionRequest = {
    type: 'stage_close',
    stageId: stage,
    closeType,
    reason,
    manifestDigest,
    snapshotDigest,
  };
  const result = admitVNextStageClose(request, { projectRoot: root });
  return admitStageCloseEnvelope(command, stage, result);
}

// ============================================================
// Dispatcher
// ============================================================

/**
 * Run one stage-domain operation and return its canonical envelope。
 * 所有失败均为 structured finding（exit 2, no-write）；成功 exit 0。
 */
export function runStage(
  root: string,
  _rootSource: 'explicit' | 'auto',
  command: CliCommand,
  params: StageOperationParams,
): CliEnvelope {
  switch (command.operation) {
    case 'status': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runStageStatus(root, command, (stage as { stage: string }).stage);
    }
    case 'next': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runStageNext(root, command, (stage as { stage: string }).stage);
    }
    case 'admit-worker': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runAdmitWorker(root, command, (stage as { stage: string }).stage, params);
    }
    case 'admit-cv': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runAdmitCv(root, command, (stage as { stage: string }).stage, params);
    }
    case 'admit-slice-commit': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runAdmitSliceCommit(root, command, (stage as { stage: string }).stage, params);
    }
    case 'admit-integration': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runAdmitIntegration(root, command, (stage as { stage: string }).stage, params);
    }
    case 'close': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runStageClose(root, command, (stage as { stage: string }).stage, params);
    }
    case 'run-gate':
      return errorEnvelope(
        command,
        'RUNTIME.NOT_IMPLEMENTED',
        'operation "stage run-gate" is a closed command delivered by S10-C-T02; it has no handler in S10-C-T01',
      );
    default:
      // The dispatcher registry is the closed authority; this branch is a
      // defensive guard for future registry extensions without a handler.
      return errorEnvelope(
        command,
        'RUNTIME.NOT_IMPLEMENTED',
        `operation "stage ${String(command.operation)}" is a closed command without a handler yet`,
      );
  }
}

// ============================================================
// Handler-direct argv entry（canonical root assertion + unified request）
// ============================================================

/**
 * Handler-direct entry for the stage domain: parses the closed flag set,
 * asserts the canonical trust root, resolves the unified request input and
 * dispatches `runStage`.  This is the seam the built dist smoke exercises
 * with a real process; the public `proofloop <domain> <operation>` dispatcher
 * wiring follows the S10-B-T01 precedent (Runtime direct-fix).
 */
export function runStageFromArgv(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): CliEnvelope {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const command: CliCommand = {
    domain: argv[0] ?? 'stage',
    operation: argv[1] ?? null,
  };
  if (command.domain !== 'stage') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `unknown domain "${command.domain}" (stage entry)`,
    );
  }
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv.slice(2));
  } catch (error) {
    return errorEnvelope(
      command,
      'USAGE',
      `usage: proofloop stage <operation> [flags] — ${errorMessage(error)}`,
    );
  }
  if (parsed.help) {
    return okEnvelope(command, { usage: 'proofloop stage <status|next|admit-worker|admit-cv|admit-slice-commit|admit-integration|run-gate|close> [flags]' });
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
  return runStage(root, 'auto', command, collectStageParams(parsed, requestValidation.request));
}

if (require.main === module) {
  process.exitCode = runStageFromArgv(process.argv.slice(2)).ok ? 0 : 2;
}
