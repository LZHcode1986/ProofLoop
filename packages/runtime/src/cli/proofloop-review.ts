/**
 * proofloop-review.ts — S10-D-T01: review 域 handler。
 *
 * Closed operation set（DOMAIN_REGISTRY.review）：
 *  - `review status`：只读 Stage Review 状态/Receipt 报告。复用
 *    review-admission 的 `readVNextStageReviewStatus` seam —— 从 persisted
 *    receipts 以 closed-schema 强度重验集成前缀（Manifest/Proof digest、
 *    review 链 + stage-gate 前缀链、root-bound/no-follow/self-digest）；
 *    空链是正常可查询状态（exit 0，S10 运行证明第 7 步
 *    `review status --json --stage S10` 必须 exit 0）。零写入。
 *  - `review prepare-stage`：只读组装 ReviewInput（manifest/plan/runtime_
 *    proof/snapshot digest + gate 前缀 + ready_for_review），零写入。
 *    verdict 仍由 AI Reviewer 提供，CLI 不替代判断（Acceptance D）。
 *  - `review finalize-stage`：verdict（closed ACCEPTED|REPAIR）+ 非空
 *    summary 经 CLI→Runtime review admission（`assembleVNextStageReviewRequest`
 *    + `admitVNextStageReview`）保存 —— 成功返回 Receipt ref+digest；
 *    失败 canonical Finding + no-write（exit 2）。Receipt 写入由
 *    review-admission（Runtime seam，Persistence Runtime owner）内部完成，
 *    本 handler 不直接写 `.proofloop/*`。
 *  - 未知操作 fail closed（RUNTIME.NOT_IMPLEMENTED，exit 2）。
 *
 * `proofloop <domain> <operation>` dispatcher wiring（proofloop.ts）与
 * review 域 closed request 字段登记（proofloop-common.ts）按 S10-C-T01
 * 先例由 Runtime direct-fix 完成；本文件交付 handler + handler-direct argv
 * 直通入口（`dist/cli/proofloop-review.js`，与 stage/gate 域同构）。
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
import {
  admitVNextStageReview,
  assembleVNextStageReviewRequest,
  readVNextStageReviewStatus,
  type VNextStageReviewStatusReport,
} from '../vnext/review-admission';
import type { StageReviewAdmissionRequest } from '../admission-request';
import type { AdmitResult } from '../admit-pipeline';

// ============================================================
// Bounded operation parameters（unified request contract）
// ============================================================

export interface ReviewOperationParams {
  /** Target canonical Stage ID（`^S\d+$`）。 */
  readonly stage?: string;
  /** finalize-stage: closed Reviewer verdict（ACCEPTED | REPAIR）。 */
  readonly verdict?: string;
  /** finalize-stage: 非空 summary。 */
  readonly summary?: string;
}

/** Merge the closed request input and CLI flags into bounded review params。 */
export function collectReviewParams(
  parsed: ParsedCliArgs,
  request: StageCliRequestInput,
): ReviewOperationParams {
  return {
    stage: parsed.stage ?? request.stage,
    verdict: request.verdict,
    summary: request.summary,
  };
}

// ============================================================
// Helpers
// ============================================================

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Canonical Stage 参数（`^S\d+$`；缺省/非法 fail closed）。 */
function requireStage(
  command: CliCommand,
  stage: string | undefined,
): CliEnvelope | { readonly stage: string } {
  if (stage === undefined) {
    return errorEnvelope(
      command,
      'STAGE.STAGE_REQUIRED',
      'review operation requires a target stage (--stage <stage-id> or request field "stage")',
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

/** 投影一个 vNext admit 结果：成功 → ok + refs（ref+digest）；失败 → canonical Finding。 */
function admitResultEnvelope(
  command: CliCommand,
  stageId: string,
  result: AdmitResult<object>,
): CliEnvelope {
  if (result.accepted && result.receipt_ref !== null) {
    const ref = path.posix.join('.proofloop', 'receipts', 'review', stageId, `${result.receipt_ref}.json`);
    const source = (result.vnext_state ?? {}) as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const field of [
      'schema_version',
      'type',
      'action',
      'stage_id',
      'manifest_digest',
      'plan_digest',
      'stage_plan_receipt_digest',
      'spv_receipt_digest',
      'stage_gate_receipt_digest',
      'snapshot_digest',
      'verdict',
      'summary',
      'receipt_chain_valid',
    ]) {
      if (source[field] !== undefined) projected[field] = source[field];
    }
    return okEnvelopeWithRefs(
      command,
      {
        accepted: true,
        receipt_ref: { ref, digest: result.receipt_ref },
        new_state: projected,
        findings: [],
      },
      [{ ref, digest: result.receipt_ref }],
    );
  }
  return failureEnvelope(
    command,
    result.findings.map((finding) => ({ code: finding.code, message: finding.message })),
  );
}

// ============================================================
// status / prepare-stage（read-only projections）
// ============================================================

/** status 投影（seam 报告直接映射，零写入）。 */
function projectReviewStatusData(report: VNextStageReviewStatusReport): Record<string, unknown> {
  return {
    schema_version: report.schema_version,
    stage_id: report.stage_id,
    manifest_digest: report.manifest_digest,
    plan_digest: report.plan_digest,
    snapshot_digest: report.snapshot_digest,
    review: report.review,
    stage_gate: report.stage_gate,
    ready_for_review: report.ready_for_review,
    // P-11 task B: archived-Stage projection（存在合法 v2 STAGE_CLOSE_RESULT
    // envelope → archived:true + stage_close 事实；ready_for_review 恒 false）。
    archived: report.archived,
    stage_close: report.stage_close,
    findings: [],
  };
}

/** prepare-stage 投影：只读组装 ReviewInput（AI Reviewer 决策输入，不替代判断）。 */
function projectReviewPrepareData(report: VNextStageReviewStatusReport): Record<string, unknown> {
  return {
    schema_version: report.schema_version,
    stage_id: report.stage_id,
    manifest_digest: report.manifest_digest,
    plan_digest: report.plan_digest,
    snapshot_digest: report.snapshot_digest,
    review_input: {
      stage_id: report.stage_id,
      manifest_digest: report.manifest_digest,
      plan_digest: report.plan_digest,
      snapshot_digest: report.snapshot_digest,
      stage_gate: report.stage_gate,
      review_chain: report.review,
      ready_for_review: report.ready_for_review,
    },
    findings: [],
  };
}

function runReviewStatus(
  root: string,
  command: CliCommand,
  stage: string,
): CliEnvelope {
  try {
    return okEnvelope(command, projectReviewStatusData(readVNextStageReviewStatus(root, stage)));
  } catch (error) {
    const code = error instanceof Error && typeof (error as unknown as { code?: unknown }).code === 'string'
      ? (error as unknown as { code: string }).code
      : 'REVIEW.BLOCKED';
    return errorEnvelope(command, code, `review status blocked: ${errorMessage(error)}`);
  }
}

function runReviewPrepare(
  root: string,
  command: CliCommand,
  stage: string,
): CliEnvelope {
  try {
    return okEnvelope(command, projectReviewPrepareData(readVNextStageReviewStatus(root, stage)));
  } catch (error) {
    const code = error instanceof Error && typeof (error as unknown as { code?: unknown }).code === 'string'
      ? (error as unknown as { code: string }).code
      : 'REVIEW.BLOCKED';
    return errorEnvelope(command, code, `review prepare-stage blocked: ${errorMessage(error)}`);
  }
}

// ============================================================
// finalize-stage（CLI→Runtime review admission consumer）
// ============================================================

function runReviewFinalize(
  root: string,
  command: CliCommand,
  stage: string,
  params: ReviewOperationParams,
): CliEnvelope {
  // closed 参数合同（与 Host proofloop_review 对齐：stage_id/verdict/summary）。
  const verdict = params.verdict;
  const summary = params.summary;
  if (verdict === undefined) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'review finalize-stage requires the request field "verdict" (closed set: ACCEPTED | REPAIR)',
    );
  }
  if (verdict !== 'ACCEPTED' && verdict !== 'REPAIR') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `review finalize-stage verdict must be ACCEPTED or REPAIR, received "${verdict}"`,
    );
  }
  if (summary === undefined || summary.length === 0) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'review finalize-stage requires a non-empty request field "summary"',
    );
  }
  const request: StageReviewAdmissionRequest = {
    type: 'stage_review',
    stageId: stage,
    verdict,
    summary,
  };
  // prepare 语义：Runtime 只读组装完整 ReviewInput（manifest/snapshot/runtime
  // proof digest 全部由 seam 从 root-bound 读取派生，caller 不可注入）。
  const assembled = assembleVNextStageReviewRequest(request, root);
  if (!assembled.ok) {
    return failureEnvelope(command, assembled.result.findings);
  }
  // finalize 语义：validate + admit（每次重验 Manifest/Proof/Authority/Gate
  // 前缀与 Git boundary；成功写唯一 STAGE_REVIEW_PASS Receipt，失败零写入）。
  const result = admitVNextStageReview(assembled.request, { projectRoot: root });
  return admitResultEnvelope(command, stage, result);
}

// ============================================================
// Dispatcher
// ============================================================

/**
 * Run one review-domain operation and return its canonical envelope。
 * 所有失败均为 structured finding（exit 2, no-write）；成功 exit 0。
 */
export function runReview(
  root: string,
  _rootSource: 'explicit' | 'auto',
  command: CliCommand,
  params: ReviewOperationParams,
): CliEnvelope {
  switch (command.operation) {
    case 'status': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runReviewStatus(root, command, (stage as { stage: string }).stage);
    }
    case 'prepare-stage': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runReviewPrepare(root, command, (stage as { stage: string }).stage);
    }
    case 'finalize-stage': {
      const stage = requireStage(command, params.stage);
      if (typeof stage === 'string' || 'findings' in stage) return stage as CliEnvelope;
      return runReviewFinalize(root, command, (stage as { stage: string }).stage, params);
    }
    default:
      // The dispatcher registry is the closed authority; this branch is a
      // defensive guard for future registry extensions without a handler.
      return errorEnvelope(
        command,
        'RUNTIME.NOT_IMPLEMENTED',
        `operation "review ${String(command.operation)}" is a closed command without a handler yet`,
      );
  }
}

// ============================================================
// Handler-direct argv entry（canonical root assertion + unified request）
// ============================================================

/**
 * Handler-direct entry for the review domain: parses the closed flag set,
 * asserts the canonical trust root, resolves the unified request input and
 * dispatches `runReview`.  Success paths must be exercised through the built
 * public `proofloop <domain> <operation>` dispatcher（S10-C 教训）; this entry
 * stays the seam for failure/boundary cases（缺参、非法 verdict、非 canonical
 * stage、非 vnext route）。
 */
export function runReviewFromArgv(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): CliEnvelope {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const command: CliCommand = {
    domain: argv[0] ?? 'review',
    operation: argv[1] ?? null,
  };
  if (command.domain !== 'review') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `unknown domain "${command.domain}" (review entry)`,
    );
  }
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv.slice(2));
  } catch (error) {
    return errorEnvelope(
      command,
      'USAGE',
      `usage: proofloop review <operation> [flags] — ${errorMessage(error)}`,
    );
  }
  if (parsed.help) {
    return okEnvelope(command, { usage: 'proofloop review <status|prepare-stage|finalize-stage> [flags]' });
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
  return runReview(root, 'auto', command, collectReviewParams(parsed, requestValidation.request));
}

if (require.main === module) {
  process.exitCode = runReviewFromArgv(process.argv.slice(2)).ok ? 0 : 2;
}
