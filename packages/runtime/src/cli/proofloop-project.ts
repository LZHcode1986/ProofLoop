/**
 * proofloop-project.ts — S10-D-T02: project 域 handler。
 *
 * Closed operation set（DOMAIN_REGISTRY.project）：
 *  - `project status`：只读 Project Acceptance 状态/Receipt 报告（project/
 *    类别 Receipt 的 kernel envelope + digest-addressed + self-digest +
 *    closed type 集校验，PROJECT_REVIEW_PASS.previous_digest 必须指向类别内
 *    存在的 PROJECT_E2E_* receipt；空类别为正常可查询状态，exit 0 ——
 *    S10 运行证明第 8 步 `project status --json` 必须 exit 0，无 --stage，
 *    project 域是全局的）。零写入。
 *  - `project compile-acceptance`：复用 compile-project-acceptance seam
 *    （`compileProjectAcceptance`）—— `input_path`（root-relative legacy
 *    compile input JSON）与 `output_path`（root-relative manifest 输出路径）
 *    均为 request 字段；input 的 `project_root` 必须等于 canonical trust
 *    root（root 一致性断言，与 `--project-root` 同一语义）。成功返回
 *    manifest ref+digest（canonical 16-hex digest）；失败 canonical Finding
 *    + no-write。Manifest 文件写入由 seam 完成。
 *  - `project run-e2e`：复用 run-project-acceptance seam
 *    （`runProjectAcceptanceE2E`）—— `manifest_path`（root-relative）执行
 *    E2E steps 并写 Project E2E Gate Receipt（kernel writeReceipt，PASS 和
 *    FAIL 都留档 —— seam 既有语义），成功返回 Receipt ref+digest（exit 0）；
 *    步骤失败 → canonical Finding + exit 2（FAIL receipt 作为证据由 seam
 *    留档）；BLOCKED（非法 manifest / stale snapshot）→ canonical Finding +
 *    零写入。
 *  - `project prepare-review`：只读组装 Project Review Input（manifest
 *    ref+digest + 最新 PROJECT_E2E_PASS（缺省从 project/ 类别派生，或显式
 *    `e2e_receipt_path`）+ review 链 + ready_for_review），零写入。verdict
 *    仍由 AI Project Reviewer 提供，CLI 不替代判断（Acceptance D）。
 *  - `project finalize-review`：复用 finalize-project-review seam
 *    （`finalizeProjectReview`）—— request `verdict`（closed
 *    PROJECT_ACCEPTED|PROJECT_REJECTED|PROJECT_BLOCKED）+ 非空 `summary`
 *    校验；reviewer result 文件（`reviewer_result_path`，root-relative）由
 *    AI Project Reviewer 写出，handler 只读 + parse + 机械断言其 verdict 与
 *    request verdict 一致（CLI 不替代判断）。成功写 PROJECT_REVIEW_PASS
 *    Receipt（seam）并返回 ref+digest；失败 canonical Finding + no-write。
 *  - 未知操作 fail closed（RUNTIME.NOT_IMPLEMENTED，exit 2）。
 *
 * 本 handler 不直接写 `.proofloop/*`；Manifest/Receipt 写入全部由 Runtime
 * seam（compile-project-acceptance / run-project-acceptance /
 * finalize-project-review）内部完成。`proofloop <domain> <operation>`
 * dispatcher wiring（proofloop.ts）与 project 域 closed request 字段登记
 * （proofloop-common.ts）按 S10-C / S10-D-T01 先例由 Runtime direct-fix
 * 完成；本文件交付 handler + handler-direct argv 直通入口
 * （`dist/cli/proofloop-project.js`，与 review 域同构）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeReceiptDigest, computeDigest, validateVNextManifest, validateReceipt } from '@proofloop/kernel';
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
  compileProjectAcceptance,
  computeCanonicalJsonDigest,
  computeSnapshot,
  fileDigest16,
  finalizeProjectReview,
  parseProjectAcceptanceManifest,
  parseProjectE2EReceipt,
  parseProjectReviewResult,
  readVNextStageEnvelope,
  extractVNextStagePayloadField,
  HEX64,
  runProjectAcceptanceE2E,
  validateE2ETopology,
  PROJECT_E2E_TYPE_BY_VERDICT,
  type ProjectAcceptanceManifest,
  type ProjectE2EReceipt,
  type ProjectReviewResult,
  type RunProjectAcceptanceE2EResult,
  type RuntimeProofStep,
} from '../project-acceptance';
import { projectReceiptDir } from '../receipt-layout';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { readRootBoundFile } from '../vnext';

// ============================================================
// Bounded operation parameters（unified request contract）
// ============================================================

export interface ProjectOperationParams {
  /** compile-acceptance: root-relative legacy compile input JSON path。 */
  readonly input_path?: string;
  /** compile-acceptance: root-relative ProjectAcceptanceManifest 输出路径。 */
  readonly output_path?: string;
  /** run-e2e / prepare-review / finalize-review: root-relative manifest 路径。 */
  readonly manifest_path?: string;
  /** prepare-review / finalize-review: root-relative Project E2E Gate Receipt 路径。 */
  readonly e2e_receipt_path?: string;
  /** finalize-review: root-relative AI Project Reviewer result 文件路径。 */
  readonly reviewer_result_path?: string;
  /** run-e2e / finalize-review: 可选 Receipt 输出目录（root-relative；缺省
   *  用 canonical `project/` 类别）。 */
  readonly output_dir?: string;
  /** finalize-review: closed verdict（PROJECT_ACCEPTED|PROJECT_REJECTED|PROJECT_BLOCKED）。 */
  readonly verdict?: string;
  /** finalize-review: 非空 summary。 */
  readonly summary?: string;
}

/**
 * Merge the closed request input into bounded project params。project 域新增
 * 的 path 字段（manifest_path / e2e_receipt_path / reviewer_result_path /
 * output_dir）由 Runtime direct-fix 在 proofloop-common.ts 登记并提取；
 * direct-fix 落地前按 undefined 处理（handler 缺参 fail closed 仍然成立）。
 */
export function collectProjectParams(
  parsed: ParsedCliArgs,
  request: StageCliRequestInput,
): ProjectOperationParams {
  const projectFields = request as unknown as Record<string, string | undefined>;
  return {
    input_path: request.input_path,
    output_path: request.output_path,
    manifest_path: projectFields['manifest_path'],
    e2e_receipt_path: projectFields['e2e_receipt_path'],
    reviewer_result_path: projectFields['reviewer_result_path'],
    output_dir: projectFields['output_dir'],
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

/** root-relative 路径参数解析（绝对路径/root escape fail closed）。 */
function requireRootRelative(
  root: string,
  command: CliCommand,
  label: string,
  value: string | undefined,
): CliEnvelope | { readonly rel: string; readonly abs: string } {
  if (value === undefined) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `project operation requires the request field "${label}" (root-relative path)`,
    );
  }
  if (path.isAbsolute(value)) {
    return errorEnvelope(
      command,
      'RUNTIME.PATH_OUTSIDE_ROOT',
      `request field "${label}" must be root-relative (absolute path refused): "${value}"`,
    );
  }
  const canonical = canonicalPathWithinRoot(root, value);
  if (canonical === null) {
    return errorEnvelope(
      command,
      'RUNTIME.PATH_OUTSIDE_ROOT',
      `request field "${label}" escapes the project root: "${value}"`,
    );
  }
  return { rel: value, abs: canonical };
}

function isEnvelope(value: unknown): value is CliEnvelope {
  return typeof value === 'object' && value !== null && 'findings' in value;
}

/** root-bound/no-follow 读取 root-relative JSON 文件。 */
function readRootBoundJson(
  root: string,
  command: CliCommand,
  label: string,
  rel: string,
): CliEnvelope | { readonly json: unknown } {
  let raw: string;
  try {
    raw = readRootBoundFile(root, rel).content;
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      `request field "${label}" file is not readable: "${rel}" (${errorMessage(error)})`,
    );
  }
  try {
    return { json: JSON.parse(raw) as unknown };
  } catch {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      `request field "${label}" file is not valid JSON: "${rel}"`,
    );
  }
}

/** Receipt 绝对路径 → root-relative posix ref。 */
function rootRelativeRef(root: string, absolutePath: string): string {
  return path.posix.join(...path.relative(root, absolutePath).split(path.sep));
}

/** 失败 envelope 但保留结构化 result（verdict/receipt_ref/errors 事实）。 */
function projectFailEnvelope(
  command: CliCommand,
  findings: readonly CliFinding[],
  result: Record<string, unknown>,
): CliEnvelope {
  return { ...failureEnvelope(command, findings), result };
}

// ============================================================
// project/ 类别 Receipt 只读扫描（status / prepare-review 共用）
// ============================================================

const PROJECT_CATEGORY_TYPES = new Set([
  'PROJECT_E2E_PASS',
  'PROJECT_E2E_FAIL',
  'PROJECT_E2E_BLOCKED',
  'PROJECT_REVIEW_PASS',
]);

interface ProjectCategoryReceipt {
  readonly type: string;
  readonly verdict: string;
  readonly digest: string;
  readonly ref: string;
  readonly project_id: string | null;
  /** kernel Receipt 顶层 timestamp（ISO-8601；latest 选择的时间权威）。 */
  readonly timestamp: string;
  /** PROJECT_REVIEW_PASS 链前驱（e2e receipt kernel digest）。 */
  readonly previous_digest?: string;
}

interface ProjectCategoryReport {
  readonly receipt_count: number;
  readonly receipts: readonly ProjectCategoryReceipt[];
  readonly chain_valid: boolean;
  readonly error?: string;
}

/**
 * 只读扫描 canonical project/ 类别：每个 Receipt kernel-valid（validateReceipt）、
 * digest-addressed、self-digest 校验、closed type 集（错位类型拒绝）、
 * PROJECT_E2E_* payload closed-schema（parseProjectE2EReceipt）+ type↔verdict
 * 一致性、PROJECT_REVIEW_PASS payload 的 verdict/project_id 绑定；链语义：
 * 仅 PROJECT_REVIEW_PASS 可携带 previous_digest，且必须指向类别内存在的
 * PROJECT_E2E_* receipt。任一破坏 → chain_valid:false（status/prepare fail
 * closed，RUNTIME.RECEIPT_CHAIN_BROKEN）。空类别是可查询状态（chain_valid:true）。
 */
function readProjectReceiptCategory(root: string): ProjectCategoryReport {
  const directory = projectReceiptDir(root);
  if (canonicalPathWithinRoot(root, directory) === null) {
    return { receipt_count: 0, receipts: [], chain_valid: false, error: 'project receipt category is not root-bound' };
  }
  let names: string[];
  try {
    if (!fs.statSync(directory).isDirectory()) {
      return { receipt_count: 0, receipts: [], chain_valid: true };
    }
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { receipt_count: 0, receipts: [], chain_valid: true };
    }
    return { receipt_count: 0, receipts: [], chain_valid: false, error: `project category could not be read: ${errorMessage(error)}` };
  }

  const byDigest = new Map<string, ProjectCategoryReceipt>();
  try {
    for (const name of names) {
      const file = path.join(directory, name);
      const opened = openNoFollowRead(root, file);
      if (!opened.ok || opened.filePath !== file) {
        throw new Error(`unreadable or redirected Receipt: ${name}`);
      }
      let rawContent: string;
      let receipt: { digest: string; type: string; payload: unknown };
      try {
        rawContent = fs.readFileSync(opened.fd, 'utf8');
        const validated = validateReceipt(JSON.parse(rawContent));
        receipt = { digest: validated.digest, type: validated.type, payload: validated.payload };
      } finally {
        fs.closeSync(opened.fd);
      }
      if (!/^[a-f0-9]{64}$/.test(receipt.digest) || name !== `${receipt.digest}.json`) {
        throw new Error(`Receipt ${name} is not digest-addressed`);
      }
      const content = JSON.parse(rawContent) as Record<string, unknown>;
      const { digest: ignoredDigest, ...rest } = content;
      void ignoredDigest;
      if (computeReceiptDigest(rest as never) !== receipt.digest) {
        throw new Error(`Receipt ${name} has an invalid self-digest`);
      }
      if (!PROJECT_CATEGORY_TYPES.has(receipt.type)) {
        throw new Error(
          `Receipt ${name} has type ${receipt.type}; project category accepts only PROJECT_E2E_*/PROJECT_REVIEW_PASS`,
        );
      }
      const payload = (receipt.payload ?? {}) as Record<string, unknown>;
      let verdict: string;
      let projectId: string | null;
      if (receipt.type.startsWith('PROJECT_E2E_')) {
        const e2e = parseProjectE2EReceipt(payload);
        if (PROJECT_E2E_TYPE_BY_VERDICT[e2e.verdict] !== receipt.type) {
          throw new Error(`Receipt ${name} type ${receipt.type} does not match payload verdict ${e2e.verdict}`);
        }
        verdict = e2e.verdict;
        projectId = e2e.project_id;
      } else {
        if (payload['verdict'] !== 'PROJECT_ACCEPTED') {
          throw new Error(`Receipt ${name} PROJECT_REVIEW_PASS payload verdict must be PROJECT_ACCEPTED`);
        }
        if (typeof payload['project_id'] !== 'string' || payload['project_id'].length === 0) {
          throw new Error(`Receipt ${name} PROJECT_REVIEW_PASS payload.project_id must be a non-empty string`);
        }
        verdict = 'PROJECT_ACCEPTED';
        projectId = payload['project_id'] as string;
      }
      const previousDigest = content['previous_digest'];
      if (previousDigest !== undefined && typeof previousDigest !== 'string') {
        throw new Error(`Receipt ${name} previous_digest must be a string when present`);
      }
      // kernel validateReceipt 保证顶层 timestamp 为非空字符串（ISO-8601）；
      // 它是 latest 选择的时间权威（S10-D CV repair：不再按 digest 字典序）。
      const timestamp = content['timestamp'];
      if (typeof timestamp !== 'string' || timestamp.length === 0) {
        throw new Error(`Receipt ${name} timestamp must be a non-empty string`);
      }
      byDigest.set(receipt.digest, {
        type: receipt.type,
        verdict,
        digest: receipt.digest,
        ref: rootRelativeRef(root, file),
        project_id: projectId,
        timestamp,
        ...(previousDigest !== undefined ? { previous_digest: previousDigest as string } : {}),
      });
    }
  } catch (error) {
    return {
      receipt_count: names.length,
      receipts: [],
      chain_valid: false,
      error: `project category chain is broken: ${errorMessage(error)}`,
    };
  }

  // 链语义：仅 PROJECT_REVIEW_PASS 可携带 previous_digest，且必须指向类别内
  // 存在的 PROJECT_E2E_* receipt（e2e receipt 自身无 previous_digest）。
  for (const entry of byDigest.values()) {
    if (entry.type === 'PROJECT_REVIEW_PASS') {
      const previous = entry.previous_digest;
      if (previous !== undefined) {
        if (!byDigest.has(previous)) {
          return {
            receipt_count: byDigest.size,
            receipts: [],
            chain_valid: false,
            error: `Receipt ${entry.digest}.json previous_digest "${previous}" does not reference a receipt in the project category`,
          };
        }
        const target = byDigest.get(previous);
        if (target === undefined || !target.type.startsWith('PROJECT_E2E_')) {
          return {
            receipt_count: byDigest.size,
            receipts: [],
            chain_valid: false,
            error: `Receipt ${entry.digest}.json previous_digest must reference a PROJECT_E2E_* receipt`,
          };
        }
      }
    } else if (entry.type.startsWith('PROJECT_E2E_') && entry.previous_digest !== undefined) {
      return {
        receipt_count: byDigest.size,
        receipts: [],
        chain_valid: false,
        error: `Receipt ${entry.digest}.json PROJECT_E2E_* must not carry a previous_digest`,
      };
    }
  }

  return {
    receipt_count: byDigest.size,
    receipts: [...byDigest.values()].sort(
      (a, b) => a.timestamp.localeCompare(b.timestamp) || a.digest.localeCompare(b.digest),
    ),
    chain_valid: true,
  };
}

/**
 * 该类别的“最新”Receipt：按 kernel Receipt 顶层 timestamp 选最大者
 * （S10-D CV repair —— 不再按 digest 路径字典序，多 Receipt 时保证选到
 * 真正的最新事实）。timestamp 相同（罕见）时保留先读到的（确定性）。
 */
function latestOf(receipts: readonly ProjectCategoryReceipt[], typePrefix: string): ProjectCategoryReceipt | null {
  const matches = receipts.filter((r) => r.type.startsWith(typePrefix));
  if (matches.length === 0) return null;
  return matches.reduce((best, current) => (current.timestamp > best.timestamp ? current : best));
}

const PROJECT_E2E_TYPE_SET = new Set(['PROJECT_E2E_PASS', 'PROJECT_E2E_FAIL', 'PROJECT_E2E_BLOCKED']);

type ExplicitProjectE2EResult =
  | {
      readonly ok: true;
      readonly e2e: {
        readonly ref: string;
        readonly digest: string;
        readonly verdict: string;
        readonly project_id: string;
        readonly manifest_digest: string;
        readonly expected_snapshot: string;
        readonly executed_snapshot: string;
      };
    }
  | { readonly ok: false; readonly message: string };

/**
 * 显式 `e2e_receipt_path` 的完整校验（S10-D CV repair —— 与类别扫描
 * `readProjectReceiptCategory` 同一强度，prepare-review 与 finalize-review
 * 共用）：
 *  - canonical project 类别归属：路径必须在 projectReceiptDir(root) 内；
 *  - root-bound/no-follow 读取 + kernel validateReceipt；
 *  - digest-addressed 文件名（`<digest>.json`）+ self-digest 校验；
 *  - 类型闭集 PROJECT_E2E_* + payload verdict 枚举 + type↔verdict 绑定。
 * 任一破坏 → ok:false（canonical Finding + no-write，绝不接受伪造/错位
 * receipt 作为 E2E Gate 证据）。
 */
/**
 * finalize 前置校验（S10-D CV repair Round 3）：stage_receipts 完整性
 *（每个声明 slice 的 manifest/review/gate 证据存在、vNext-only：stage
 * manifest 必须 version 2 + kernel-valid、review 必须 STAGE_REVIEW_PASS
 * envelope（verdict ACCEPTED）、gate 必须 GATE_PASS envelope（verdict PASS、
 * digest-addressed）、review↔gate 快照绑定、review.stage_gate_receipt_digest
 * ↔ gate envelope digest triple-binding）与 criteria one-to-one（每个
 * acceptance criterion 恰好一个 result）。与 finalizeProjectReview 的 4/5
 * 段同一语义；失败在 mkdir 前 fail closed。
 */
function verifyFinalizeStageReceiptBindings(
  root: string,
  manifest: ProjectAcceptanceManifest,
  reviewerResult: ProjectReviewResult,
  manifestAbsPath: string,
): string[] {
  const errors: string[] = [];
  if (manifest.stage_receipts.length === 0) {
    errors.push('Manifest has zero stage_receipts entries');
  }
  for (const ms of manifest.stage_receipts) {
    const sid = ms.stage_id;
    let canonicalStageManifestDigest = '';
    // a. Stage manifest: root-bound + exists + vNext (version 2) +
    //    kernel-validated + canonical 64-hex digest bound.
    const stageManifestTarget = canonicalPathWithinRoot(root, ms.stage_manifest.path);
    if (stageManifestTarget === null) {
      errors.push(`Stage manifest path for ${sid} escapes the project root: ${ms.stage_manifest.path}`);
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(stageManifestTarget, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || (parsed as Record<string, unknown>)['version'] !== 2) {
        errors.push(
          `Stage manifest for ${sid} is not a vNext manifest (version 2 required): ${ms.stage_manifest.path}. ` +
            'Version 1 legacy stages are archived and not part of acceptance',
        );
      } else {
        validateVNextManifest(parsed);
        canonicalStageManifestDigest = computeDigest(parsed);
        if (ms.stage_manifest.digest !== canonicalStageManifestDigest) {
          errors.push(`Stage manifest for ${sid}: declared digest "${ms.stage_manifest.digest}" != vNext canonical "${canonicalStageManifestDigest}"`);
        }
      }
    } catch (error) {
      errors.push(`Stage manifest for ${sid}: ${errorMessage(error)}`);
    }
    // b/c. Stage review + gate receipts (vNext STAGE_REVIEW_PASS / GATE_PASS
    // envelopes with payload verdict / manifest_digest / snapshot_digest /
    // stage_id / stage_gate_receipt_digest).
    const reviewTarget = canonicalPathWithinRoot(root, ms.review_receipt.path);
    if (reviewTarget === null) {
      errors.push(`Review receipt path for ${sid} escapes the project root: ${ms.review_receipt.path}`);
      continue;
    }
    const reviewEnvelope = readVNextStageEnvelope(reviewTarget, sid, 'STAGE_REVIEW_PASS', errors);
    if (reviewEnvelope === null) continue;
    const reviewPayload = reviewEnvelope.payload;
    const reviewStageId = extractVNextStagePayloadField(reviewPayload, 'stage_id', sid, 'review', errors);
    const reviewVerdict = extractVNextStagePayloadField(reviewPayload, 'verdict', sid, 'review', errors);
    const reviewManifestDigest = extractVNextStagePayloadField(reviewPayload, 'manifest_digest', sid, 'review', errors, { regex: HEX64 });
    const reviewSnapshot = extractVNextStagePayloadField(reviewPayload, 'snapshot_digest', sid, 'review', errors);
    const reviewGateDigest = extractVNextStagePayloadField(reviewPayload, 'stage_gate_receipt_digest', sid, 'review', errors, { regex: HEX64 });
    if (reviewStageId === null || reviewVerdict === null || reviewManifestDigest === null || reviewSnapshot === null || reviewGateDigest === null) continue;
    if (reviewStageId !== sid) errors.push(`Review stage_id "${reviewStageId}" != manifest entry "${sid}"`);
    if (reviewVerdict !== 'ACCEPTED') errors.push(`Review for ${sid} verdict is "${reviewVerdict}", expected "ACCEPTED"`);
    if (canonicalStageManifestDigest && reviewManifestDigest !== canonicalStageManifestDigest) {
      errors.push(`Review manifest_digest for ${sid}: "${reviewManifestDigest}" != canonical "${canonicalStageManifestDigest}"`);
    }
    const reviewFileDigest = reviewEnvelope.digest;
    if (reviewFileDigest !== ms.review_receipt.digest) {
      errors.push(`Review file for ${sid}: envelope digest "${reviewFileDigest}" != declared "${ms.review_receipt.digest}"`);
    }
    const gateTarget = canonicalPathWithinRoot(root, ms.gate_receipt.path);
    if (gateTarget === null) {
      errors.push(`Gate receipt path for ${sid} escapes the project root: ${ms.gate_receipt.path}`);
    } else {
      const gateEnvelope = readVNextStageEnvelope(gateTarget, sid, 'GATE_PASS', errors);
      if (gateEnvelope !== null) {
        if (gateEnvelope.digest !== ms.gate_receipt.digest) {
          errors.push(`Gate file for ${sid}: envelope digest "${gateEnvelope.digest}" != declared "${ms.gate_receipt.digest}" (digest-addressed)`);
        }
        const gatePayload = gateEnvelope.payload;
        const gateStageId = extractVNextStagePayloadField(gatePayload, 'stage_id', sid, 'gate', errors);
        const gateVerdict = extractVNextStagePayloadField(gatePayload, 'verdict', sid, 'gate', errors);
        const gateManifestDigest = extractVNextStagePayloadField(gatePayload, 'manifest_digest', sid, 'gate', errors, { regex: HEX64 });
        const gateSnapshot = extractVNextStagePayloadField(gatePayload, 'snapshot_digest', sid, 'gate', errors);
        if (gateStageId !== null && gateVerdict !== null && gateManifestDigest !== null && gateSnapshot !== null) {
          if (gateStageId !== sid) errors.push(`Gate stage_id "${gateStageId}" != manifest entry "${sid}"`);
          if (gateVerdict !== 'PASS') errors.push(`Gate for ${sid} verdict is "${gateVerdict}", expected "PASS"`);
          if (canonicalStageManifestDigest && gateManifestDigest !== canonicalStageManifestDigest) {
            errors.push(`Gate manifest_digest for ${sid}: "${gateManifestDigest}" != canonical "${canonicalStageManifestDigest}"`);
          }
          if (reviewSnapshot !== gateSnapshot) {
            errors.push(`Review snapshot "${reviewSnapshot}" != Gate snapshot "${gateSnapshot}" for ${sid}`);
          }
          // f. Triple-binding: review.stage_gate_receipt_digest === gate envelope digest.
          if (reviewGateDigest !== gateEnvelope.digest) {
            errors.push(`Review for ${sid}: stage_gate_receipt_digest "${reviewGateDigest}" != gate envelope digest "${gateEnvelope.digest}" (triple binding)`);
          }
        }
      }
    }
  }
  // 5. Criteria one-to-one coverage（S10-D CV repair Round 4：集合级完全一致，
  //    与 finalizeProjectReview 的 5 段同一语义——不只比长度）。
  if (manifest.acceptance_criteria.length !== reviewerResult.criteria_results.length) {
    errors.push(
      `Criteria count mismatch: Manifest has ${manifest.acceptance_criteria.length}, Reviewer has ${reviewerResult.criteria_results.length}`,
    );
  }
  const manifestCriteriaSet = new Set(manifest.acceptance_criteria.map((c) => c.trim()));
  const resultCriteriaSet = new Set(reviewerResult.criteria_results.map((c) => c.criteria.trim()));
  for (const mc of manifestCriteriaSet) {
    if (!resultCriteriaSet.has(mc)) errors.push(`Missing criteria result for: "${mc}"`);
  }
  for (const rc of resultCriteriaSet) {
    if (!manifestCriteriaSet.has(rc)) errors.push(`Extra criteria result not in Manifest: "${rc}"`);
  }
  if (!reviewerResult.criteria_results.every((c) => c.passed)) {
    errors.push('Not all criteria results are passed');
  }
  // 6. Reviewer-referenced manifest path file digest（与 finalizeProjectReview
  //    的 6 段同一语义）——声明的 manifest 路径必须是 root-bound 且文件 digest
  //    与输入 manifest 实际文件一致。
  const reviewerManifestTarget = canonicalPathWithinRoot(root, reviewerResult.project_manifest.path);
  if (reviewerManifestTarget === null) {
    errors.push(`Reviewer manifest path escapes the project root: ${reviewerResult.project_manifest.path}`);
  } else {
    try {
      const reviewerManifestFileDigest = fileDigest16(reviewerManifestTarget);
      const actualManifestFileDigest = fileDigest16(manifestAbsPath);
      if (reviewerManifestFileDigest !== actualManifestFileDigest) {
        errors.push(`Reviewer manifest path file digest "${reviewerManifestFileDigest}" != actual manifest digest "${actualManifestFileDigest}"`);
      }
    } catch (error) {
      errors.push(`Reviewer manifest path not found: ${errorMessage(error)}`);
    }
  }
  return errors;
}

function verifyExplicitProjectE2EReceipt(root: string, rel: string): ExplicitProjectE2EResult {
  // 1. canonical 类别归属（与类别扫描同一目录边界）。
  const categoryDir = canonicalPathWithinRoot(root, projectReceiptDir(root));
  const target = canonicalPathWithinRoot(root, rel);
  if (target === null) {
    return { ok: false, message: `e2e receipt path escapes the project root: "${rel}"` };
  }
  if (categoryDir === null || !(target === categoryDir || target.startsWith(`${categoryDir}/`))) {
    return {
      ok: false,
      message: `e2e receipt must live in the canonical project receipt category (${projectReceiptDir(root)}): "${rel}"`,
    };
  }

  // 2. root-bound/no-follow 读取 + kernel 校验。
  let rawContent: string;
  let validated: { digest: string; type: string; payload: unknown };
  try {
    const opened = openNoFollowRead(root, rel);
    if (!opened.ok) {
      return { ok: false, message: `e2e receipt is unreadable or not root-bound: "${rel}"` };
    }
    try {
      rawContent = fs.readFileSync(opened.fd, 'utf8');
      validated = validateReceipt(JSON.parse(rawContent));
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch (error) {
    return {
      ok: false,
      message: `e2e receipt is not a valid kernel Receipt: ${errorMessage(error)}`,
    };
  }

  // 3. digest-addressed 文件名 + self-digest。
  const fileName = path.basename(rel);
  if (!/^[a-f0-9]{64}\.json$/.test(fileName) || fileName !== `${validated.digest}.json`) {
    return { ok: false, message: `e2e receipt is not digest-addressed: "${rel}"` };
  }
  const content = JSON.parse(rawContent) as Record<string, unknown>;
  const { digest: ignoredDigest, ...rest } = content;
  void ignoredDigest;
  if (computeReceiptDigest(rest as never) !== validated.digest) {
    return { ok: false, message: `e2e receipt has an invalid self-digest: "${rel}"` };
  }

  // 4. 类型闭集 + verdict 枚举 + type↔verdict 绑定。
  if (!PROJECT_E2E_TYPE_SET.has(validated.type)) {
    return {
      ok: false,
      message: `e2e receipt type "${validated.type}" is not a PROJECT_E2E_* gate receipt`,
    };
  }
  let payload: ProjectE2EReceipt;
  try {
    payload = parseProjectE2EReceipt(validated.payload);
  } catch (error) {
    return {
      ok: false,
      message: `Project E2E Gate Receipt is not valid: ${errorMessage(error)}`,
    };
  }
  if (PROJECT_E2E_TYPE_BY_VERDICT[payload.verdict] !== validated.type) {
    return {
      ok: false,
      message: `e2e receipt type ${validated.type} does not match payload verdict ${payload.verdict}`,
    };
  }

  return {
    ok: true,
    e2e: {
      ref: rel,
      digest: validated.digest,
      verdict: payload.verdict,
      project_id: payload.project_id,
      manifest_digest: payload.manifest_digest,
      expected_snapshot: payload.expected_snapshot,
      executed_snapshot: payload.executed_snapshot,
    },
  };
}

// ============================================================
// status（只读 Project Acceptance 状态/Receipt 报告）
// ============================================================

function runProjectStatus(root: string, command: CliCommand): CliEnvelope {
  const report = readProjectReceiptCategory(root);
  if (!report.chain_valid) {
    return failureEnvelope(command, [
      { code: 'RUNTIME.RECEIPT_CHAIN_BROKEN', message: report.error ?? 'project category chain is broken' },
    ]);
  }
  const e2eLatest = latestOf(report.receipts, 'PROJECT_E2E_');
  const reviewLatest = latestOf(report.receipts, 'PROJECT_REVIEW_PASS');
  const projectId = e2eLatest !== null ? e2eLatest.project_id : (reviewLatest !== null ? reviewLatest.project_id : null);
  const project = (receipt: ProjectCategoryReceipt | null) => receipt === null ? null : {
    receipt_type: receipt.type,
    verdict: receipt.verdict,
    digest: receipt.digest,
    ref: receipt.ref,
  };
  return okEnvelope(command, {
    schema_version: 2,
    project_id: projectId,
    receipt_count: report.receipt_count,
    e2e: {
      receipt_count: report.receipts.filter((r) => r.type.startsWith('PROJECT_E2E_')).length,
      latest: project(e2eLatest),
    },
    review: {
      receipt_count: report.receipts.filter((r) => r.type.startsWith('PROJECT_REVIEW_PASS')).length,
      latest: project(reviewLatest),
    },
    chain_valid: true,
    findings: [],
  });
}

// ============================================================
// compile-acceptance（复用 compileProjectAcceptance seam）
// ============================================================

async function runCompileAcceptance(
  root: string,
  command: CliCommand,
  params: ProjectOperationParams,
): Promise<CliEnvelope> {
  const input = requireRootRelative(root, command, 'input_path', params.input_path);
  if (isEnvelope(input)) return input;
  const output = requireRootRelative(root, command, 'output_path', params.output_path);
  if (isEnvelope(output)) return output;

  const inputJson = readRootBoundJson(root, command, 'input_path', input.rel);
  if (isEnvelope(inputJson)) return inputJson;

  // root 一致性断言：compile input 的 project_root 必须等于 canonical trust
  // root（与 `--project-root` 同一语义，杜绝跨 root 快照/写入）。
  const claimed =
    typeof inputJson.json === 'object' && inputJson.json !== null && !Array.isArray(inputJson.json)
      ? (inputJson.json as Record<string, unknown>)['project_root']
      : undefined;
  if (typeof claimed !== 'string' || path.resolve(claimed) !== root) {
    return errorEnvelope(
      command,
      'RUNTIME.PROJECT_ROOT_MISMATCH',
      `compile input project_root "${String(claimed)}" does not match the canonical trust root "${root}"`,
    );
  }

  // S10-D CV repair：在创建输出目录前完成 compile 的前置结构校验（与
  // compileProjectAcceptance 的前置检查同一语义）——非法输入在任何目录
  // 副作用发生前 fail closed（no-write）。
  const inputRecord =
    typeof inputJson.json === 'object' && inputJson.json !== null && !Array.isArray(inputJson.json)
      ? (inputJson.json as Record<string, unknown>)
      : {};
  if (
    !Array.isArray(inputRecord['stage_receipts']) ||
    (inputRecord['stage_receipts'] as unknown[]).length === 0
  ) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'compile input must contain a "stage_receipts" array with at least one entry',
    );
  }
  if (typeof inputRecord['project_id'] !== 'string' || inputRecord['project_id'].length === 0) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'compile input must contain a non-empty "project_id" field',
    );
  }

  // S10-D CV repair Round 2：完整 schema/topology 校验前置到 mkdir 之前——
  // 与 compileProjectAcceptance 的“组装 manifest → parseProjectAcceptanceManifest”
  // 同一语义，嵌套非法（如 stage_receipts 元素缺字段）在任何目录副作用发生
  // 前 fail closed（no-write）。
  try {
    const assembledManifest = {
      project_id: inputRecord['project_id'] as string,
      expected_snapshot: computeSnapshot(root),
      prd_goals: Array.isArray(inputRecord['prd_goals']) ? (inputRecord['prd_goals'] as string[]) : [],
      acceptance_criteria: Array.isArray(inputRecord['acceptance_criteria'])
        ? (inputRecord['acceptance_criteria'] as string[])
        : [],
      stage_receipts: inputRecord['stage_receipts'] as unknown,
      e2e_steps: Array.isArray(inputRecord['e2e_steps']) ? (inputRecord['e2e_steps'] as unknown) : [],
      compiled_at: new Date().toISOString(),
    };
    parseProjectAcceptanceManifest(assembledManifest as unknown);
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `compile input failed full schema validation: ${errorMessage(error)}`,
    );
  }

  // S10-D CV repair Round 3：E2E step topology 校验前置到 mkdir 之前（与
  // validateE2ETopology 同一语义）——duplicate id / service start-stop
  // 配对非法的输入不得创建 Manifest 输出目录（no-write）。
  const compileE2ESteps = Array.isArray(inputRecord['e2e_steps'])
    ? (inputRecord['e2e_steps'] as unknown as RuntimeProofStep[])
    : [];
  const topologyErrorsForCompile = validateE2ETopology(compileE2ESteps);
  if (topologyErrorsForCompile.length > 0) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `compile input E2E step topology is not valid: ${topologyErrorsForCompile.map((e) => `[${e.type}] ${e.message}`).join('; ')}`,
    );
  }

  // Manifest 写入由 seam 完成；此处仅确保输出父目录存在（orchestration）。
  // 目录创建已后置于全部输入校验之后（S10-D CV repair / Round 2）。
  try {
    fs.mkdirSync(path.dirname(output.abs), { recursive: true });
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.BLOCKED',
      `cannot create the manifest output directory: ${errorMessage(error)}`,
    );
  }
  const result = compileProjectAcceptance(inputJson.json, output.abs);
  if (!result.success || result.manifest === undefined || result.manifestDigest === undefined) {
    return failureEnvelope(
      command,
      result.errors.map((message) => ({ code: 'RUNTIME.SCHEMA_MISMATCH', message })),
    );
  }
  return okEnvelopeWithRefs(
    command,
    {
      success: true,
      project_id: result.manifest.project_id,
      expected_snapshot: result.manifest.expected_snapshot,
      manifest_digest: result.manifestDigest,
      output_path: output.rel,
      manifest: {
        project_id: result.manifest.project_id,
        expected_snapshot: result.manifest.expected_snapshot,
        prd_goals: result.manifest.prd_goals,
        acceptance_criteria: result.manifest.acceptance_criteria,
        stage_receipts: result.manifest.stage_receipts.map((s) => s.stage_id),
        e2e_steps: result.manifest.e2e_steps.map((s) => s.id),
      },
      findings: [],
    },
    [{ ref: output.rel, digest: result.manifestDigest }],
  );
}

// ============================================================
// run-e2e（复用 runProjectAcceptanceE2E seam）
// ============================================================

async function runE2E(
  root: string,
  command: CliCommand,
  params: ProjectOperationParams,
): Promise<CliEnvelope> {
  const manifest = requireRootRelative(root, command, 'manifest_path', params.manifest_path);
  if (isEnvelope(manifest)) return manifest;

  let outputDir: string | undefined;
  if (params.output_dir !== undefined) {
    const resolved = requireRootRelative(root, command, 'output_dir', params.output_dir);
    if (isEnvelope(resolved)) return resolved;
    outputDir = resolved.abs;
  }

  const manifestJson = readRootBoundJson(root, command, 'manifest_path', manifest.rel);
  if (isEnvelope(manifestJson)) return manifestJson;

  // S10-D CV repair：在创建 Receipt 目录前预校验 Manifest 结构 —— 非法/
  // stale manifest 在任何目录副作用发生前 fail closed（no-write）。
  let parsedManifestForE2E: ProjectAcceptanceManifest;
  try {
    parsedManifestForE2E = parseProjectAcceptanceManifest(manifestJson.json);
  } catch (error) {
    return failureEnvelope(command, [
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        message: `Project Acceptance Manifest is not valid: ${errorMessage(error)}`,
      },
    ]);
  }

  // S10-D CV repair Round 3：zero/all-skipped/topology 校验前置到 mkdir 之前
  //（与 runProjectAcceptanceE2E 的 0-1 段同一语义）——all-skipped 或
  // duplicate/service-pairing 非法的输入不得创建 Receipt 目录（no-write）。
  if (parsedManifestForE2E.e2e_steps.length === 0) {
    return failureEnvelope(command, [
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        message: 'PROJECT_E2E_ZERO_STEPS: Project Acceptance requires at least one E2E step',
      },
    ]);
  }
  if (parsedManifestForE2E.e2e_steps.every((s) => s.not_applicable?.reason)) {
    return failureEnvelope(command, [
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        message: 'PROJECT_E2E_ALL_SKIPPED: All E2E steps are not_applicable; a proof with no evidence is not valid',
      },
    ]);
  }
  const topologyErrorsForE2E = validateE2ETopology(parsedManifestForE2E.e2e_steps);
  if (topologyErrorsForE2E.length > 0) {
    return failureEnvelope(command, [
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        message: `E2E step topology is not valid: ${topologyErrorsForE2E.map((e) => `[${e.type}] ${e.message}`).join('; ')}`,
      },
    ]);
  }

  // S10-D CV repair Round 2：snapshot/stale 校验前置到 mkdir 之前 ——
  // schema-valid 但 expected_snapshot 已过期的 Manifest（PROJECT_SOURCE_STALE）
  // 不得创建 Receipt 目录（与 runProjectAcceptanceE2E 的 1b 校验同一语义）。
  let executedSnapshotForE2E: string;
  try {
    executedSnapshotForE2E = computeSnapshot(root);
  } catch (error) {
    return failureEnvelope(command, [
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        message: `cannot compute the project snapshot: ${errorMessage(error)}`,
      },
    ]);
  }
  if (parsedManifestForE2E.expected_snapshot !== executedSnapshotForE2E) {
    return failureEnvelope(command, [
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        message: `PROJECT_SOURCE_STALE: expected snapshot "${parsedManifestForE2E.expected_snapshot}" does not match executed "${executedSnapshotForE2E}"`,
      },
    ]);
  }

  // Receipt 写入由 seam（kernel writeReceipt）完成；此处仅确保 Receipt 目录
  // 存在（orchestration，与 gate 域 handler 同一先例）。目录创建已后置于
  // 全部输入校验之后（S10-D CV repair / Round 2）。
  const receiptDir = outputDir ?? projectReceiptDir(root);
  try {
    fs.mkdirSync(receiptDir, { recursive: true });
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.BLOCKED',
      `cannot create the Project E2E Receipt directory: ${errorMessage(error)}`,
    );
  }

  const result: RunProjectAcceptanceE2EResult = await runProjectAcceptanceE2E(manifestJson.json, {
    projectRoot: root,
    receiptDir: outputDir,
  });

  if (result.success && result.receiptPath !== undefined && result.receiptDigest !== undefined) {
    const ref = rootRelativeRef(root, result.receiptPath);
    return okEnvelopeWithRefs(
      command,
      {
        verdict: 'PASS',
        project_id: result.receipt?.project_id,
        manifest_digest: result.receipt?.manifest_digest,
        executed_snapshot: result.receipt?.executed_snapshot,
        steps: result.receipt?.steps ?? [],
        receipt_ref: { ref, digest: result.receiptDigest },
        findings: [],
      },
      [{ ref, digest: result.receiptDigest }],
    );
  }

  if (result.verdict === 'FAIL') {
    // seam 既有语义：FAIL 也写 E2E Gate Receipt 留档（证据）；CLI 报
    // canonical Finding + exit 2，绝不把 FAIL 伪装为 PASS。
    const receiptRef =
      result.receiptPath !== undefined && result.receiptDigest !== undefined
        ? { ref: rootRelativeRef(root, result.receiptPath), digest: result.receiptDigest }
        : null;
    const findings: CliFinding[] =
      result.errors.length > 0
        ? result.errors.map((message) => ({ code: 'PROJECT.E2E_FAILED', message }))
        : [{ code: 'PROJECT.E2E_FAILED', message: `project E2E run FAILed for project "${result.receipt?.project_id ?? 'unknown'}"` }];
    return projectFailEnvelope(command, findings, {
      verdict: 'FAIL',
      project_id: result.receipt?.project_id ?? null,
      receipt_ref: receiptRef,
      errors: result.errors,
    });
  }

  // BLOCKED（非法 manifest / topology / stale snapshot）或 Receipt 写入失败：
  // 零写入 canonical Finding。
  return failureEnvelope(
    command,
    result.errors.map((message) => ({ code: 'RUNTIME.SCHEMA_MISMATCH', message })),
  );
}

// ============================================================
// prepare-review（只读组装 Project Review Input）
// ============================================================

async function runPrepareReview(
  root: string,
  command: CliCommand,
  params: ProjectOperationParams,
): Promise<CliEnvelope> {
  const manifest = requireRootRelative(root, command, 'manifest_path', params.manifest_path);
  if (isEnvelope(manifest)) return manifest;

  const manifestJson = readRootBoundJson(root, command, 'manifest_path', manifest.rel);
  if (isEnvelope(manifestJson)) return manifestJson;
  let parsedManifest: ProjectAcceptanceManifest;
  try {
    parsedManifest = parseProjectAcceptanceManifest(manifestJson.json);
  } catch (error) {
    return failureEnvelope(command, [
      { code: 'RUNTIME.SCHEMA_MISMATCH', message: `Project Acceptance Manifest is not valid: ${errorMessage(error)}` },
    ]);
  }
  const manifestDigest = computeCanonicalJsonDigest(parsedManifest);

  // 类别链（review 链 + e2e 派生）：链破坏 fail closed。
  const category = readProjectReceiptCategory(root);
  if (!category.chain_valid) {
    return failureEnvelope(command, [
      { code: 'RUNTIME.RECEIPT_CHAIN_BROKEN', message: category.error ?? 'project category chain is broken' },
    ]);
  }

  // e2e receipt：显式 `e2e_receipt_path` 优先，否则取类别内最新 PROJECT_E2E_*。
  let e2e: { ref: string; digest: string; verdict: string; project_id: string | null; manifest_digest: string; executed_snapshot: string } | null = null;
  if (params.e2e_receipt_path !== undefined) {
    const e2ePath = requireRootRelative(root, command, 'e2e_receipt_path', params.e2e_receipt_path);
    if (isEnvelope(e2ePath)) return e2ePath;
    // S10-D CV repair：显式路径与类别扫描同一强度完整校验（self-digest、
    // digest-addressed 文件名、PROJECT_E2E_* 类型、verdict 枚举、type↔verdict
    // 绑定、canonical project 类别归属）——伪造/错位/类别外 receipt 不再被接受。
    const verified = verifyExplicitProjectE2EReceipt(root, e2ePath.rel);
    if (!verified.ok) {
      return failureEnvelope(command, [
        { code: 'RUNTIME.RECEIPT_CHAIN_BROKEN', message: verified.message },
      ]);
    }
    e2e = verified.e2e;
  } else {
    const latest = latestOf(category.receipts, 'PROJECT_E2E_');
    if (latest !== null) {
      const e2eJson = readRootBoundJson(root, command, 'e2e_receipt_path', latest.ref);
      if (isEnvelope(e2eJson)) return e2eJson;
      try {
        const payload = parseProjectE2EReceipt((validateReceipt(e2eJson.json)).payload);
        e2e = {
          ref: latest.ref,
          digest: latest.digest,
          verdict: payload.verdict,
          project_id: payload.project_id,
          manifest_digest: payload.manifest_digest,
          executed_snapshot: payload.executed_snapshot,
        };
      } catch {
        // 类别扫描已校验过 payload；此处再失败视为内部不一致 → fail closed。
        return failureEnvelope(command, [
          { code: 'RUNTIME.RECEIPT_CHAIN_BROKEN', message: 'latest PROJECT_E2E_* receipt payload could not be re-validated' },
        ]);
      }
    }
  }

  const reviewLatest = latestOf(category.receipts, 'PROJECT_REVIEW_PASS');
  const readyForReview =
    e2e !== null &&
    e2e.verdict === 'PASS' &&
    e2e.manifest_digest === manifestDigest &&
    e2e.executed_snapshot === parsedManifest.expected_snapshot;

  return okEnvelope(command, {
    schema_version: 2,
    project_id: parsedManifest.project_id,
    manifest: {
      ref: manifest.rel,
      digest: manifestDigest,
      expected_snapshot: parsedManifest.expected_snapshot,
      prd_goals: parsedManifest.prd_goals,
      acceptance_criteria: parsedManifest.acceptance_criteria,
      stage_receipts: parsedManifest.stage_receipts.map((s) => ({
        stage_id: s.stage_id,
        stage_manifest: s.stage_manifest,
        review_receipt: s.review_receipt,
        gate_receipt: s.gate_receipt,
      })),
    },
    e2e,
    review_chain: {
      receipt_count: category.receipts.filter((r) => r.type.startsWith('PROJECT_REVIEW_PASS')).length,
      latest: reviewLatest === null ? null : {
        receipt_type: reviewLatest.type,
        verdict: reviewLatest.verdict,
        digest: reviewLatest.digest,
        ref: reviewLatest.ref,
      },
    },
    ready_for_review: readyForReview,
    findings: [],
  });
}

// ============================================================
// finalize-review（复用 finalizeProjectReview seam）
// ============================================================

async function runFinalizeReview(
  root: string,
  command: CliCommand,
  params: ProjectOperationParams,
): Promise<CliEnvelope> {
  // closed 参数合同（与 review finalize-stage 同构）：verdict 枚举 + summary 非空。
  const verdict = params.verdict;
  if (verdict === undefined) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'project finalize-review requires the request field "verdict" (closed set: PROJECT_ACCEPTED | PROJECT_REJECTED | PROJECT_BLOCKED)',
    );
  }
  if (verdict !== 'PROJECT_ACCEPTED' && verdict !== 'PROJECT_REJECTED' && verdict !== 'PROJECT_BLOCKED') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `project finalize-review verdict must be PROJECT_ACCEPTED, PROJECT_REJECTED or PROJECT_BLOCKED, received "${verdict}"`,
    );
  }
  const summary = params.summary;
  if (summary === undefined || summary.length === 0) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'project finalize-review requires a non-empty request field "summary"',
    );
  }

  const manifest = requireRootRelative(root, command, 'manifest_path', params.manifest_path);
  if (isEnvelope(manifest)) return manifest;
  const e2e = requireRootRelative(root, command, 'e2e_receipt_path', params.e2e_receipt_path);
  if (isEnvelope(e2e)) return e2e;
  const reviewer = requireRootRelative(root, command, 'reviewer_result_path', params.reviewer_result_path);
  if (isEnvelope(reviewer)) return reviewer;

  let outputDir = projectReceiptDir(root);
  if (params.output_dir !== undefined) {
    const resolved = requireRootRelative(root, command, 'output_dir', params.output_dir);
    if (isEnvelope(resolved)) return resolved;
    outputDir = resolved.abs;
  }

  // reviewer result：AI Project Reviewer 的产物 —— 只读 + parse + 机械断言。
  const reviewerJson = readRootBoundJson(root, command, 'reviewer_result_path', reviewer.rel);
  if (isEnvelope(reviewerJson)) return reviewerJson;
  let reviewerResult: ProjectReviewResult;
  try {
    reviewerResult = parseProjectReviewResult(reviewerJson.json);
  } catch (error) {
    return failureEnvelope(command, [
      { code: 'RUNTIME.SCHEMA_MISMATCH', message: `Project Reviewer result is not valid: ${errorMessage(error)}` },
    ]);
  }
  if (reviewerResult.verdict !== verdict) {
    return errorEnvelope(
      command,
      'PROJECT.REVIEWER_VERDICT_MISMATCH',
      `request verdict "${verdict}" contradicts the reviewer result file verdict "${reviewerResult.verdict}"`,
    );
  }

  // S10-D CV repair：finalize 前对显式 e2e receipt 做完整校验（与类别扫描
  // 同一强度：self-digest/digest-addressed/类型/verdict/类别归属）——伪造、
  // 错位、类别外的 E2E Gate 证据在创建输出目录前 fail closed（no-write）。
  const verified = verifyExplicitProjectE2EReceipt(root, e2e.rel);
  if (!verified.ok) {
    return failureEnvelope(command, [
      { code: 'RUNTIME.RECEIPT_CHAIN_BROKEN', message: verified.message },
    ]);
  }

  // S10-D CV repair Round 2：Manifest/E2E/reviewer triple-binding 全部前置到
  // mkdir 之前（与 finalizeProjectReview 的绑定校验同一语义）——语义绑定
  // 失败（快照/digest/verdict/文件 digest 链）不得创建输出目录（no-write）。
  const manifestJsonForFinalize = readRootBoundJson(root, command, 'manifest_path', manifest.rel);
  if (isEnvelope(manifestJsonForFinalize)) return manifestJsonForFinalize;
  let parsedManifestForFinalize: ProjectAcceptanceManifest;
  try {
    parsedManifestForFinalize = parseProjectAcceptanceManifest(manifestJsonForFinalize.json);
  } catch (error) {
    return failureEnvelope(command, [
      { code: 'RUNTIME.SCHEMA_MISMATCH', message: `Project Acceptance Manifest is not valid: ${errorMessage(error)}` },
    ]);
  }
  const manifestDigestForFinalize = computeCanonicalJsonDigest(parsedManifestForFinalize);

  const bindingChecks: ReadonlyArray<readonly [string, string, string]> = [
    ['E2E verdict must be "PASS"', verified.e2e.verdict, 'PASS'],
    ['E2E project_id', verified.e2e.project_id, parsedManifestForFinalize.project_id],
    ['E2E manifest_digest', verified.e2e.manifest_digest, manifestDigestForFinalize],
    ['E2E expected_snapshot', verified.e2e.expected_snapshot, parsedManifestForFinalize.expected_snapshot],
    ['E2E executed_snapshot', verified.e2e.executed_snapshot, parsedManifestForFinalize.expected_snapshot],
    ['Reviewer verdict must be "PROJECT_ACCEPTED"', reviewerResult.verdict, 'PROJECT_ACCEPTED'],
    ['Reviewer reviewed_snapshot', reviewerResult.reviewed_snapshot, parsedManifestForFinalize.expected_snapshot],
    ['Reviewer project_manifest.digest', reviewerResult.project_manifest.digest, manifestDigestForFinalize],
  ];
  for (const [label, actual, expected] of bindingChecks) {
    if (actual !== expected) {
      return errorEnvelope(
        command,
        'PROJECT.FINALIZE_REJECTED',
        `${label}: expected "${expected}", got "${actual}"`,
      );
    }
  }
  // Reviewer 声明的 E2E receipt 文件 digest 必须与实际 E2E 文件一致。
  let reviewerE2EFileDigest = '';
  try {
    reviewerE2EFileDigest = fileDigest16(e2e.abs);
  } catch {
    reviewerE2EFileDigest = '';
  }
  if (reviewerResult.project_e2e_receipt.digest !== reviewerE2EFileDigest) {
    return errorEnvelope(
      command,
      'PROJECT.FINALIZE_REJECTED',
      `Reviewer e2e receipt digest "${reviewerResult.project_e2e_receipt.digest}" != actual E2E file digest "${reviewerE2EFileDigest}"`,
    );
  }

  // S10-D CV repair Round 3：stage_receipts 完整性（manifest/review/gate
  // 证据存在且绑定、review ACCEPTED / gate PASS、快照与文件 digest 链）与
  // criteria one-to-one 校验前置到 mkdir 之前（与 finalizeProjectReview 的
  // 4/5 段同一语义）——缺失 stage receipt / 空 criteria_results 不得创建
  // 输出目录（no-write）。
  const stageBindingErrors = verifyFinalizeStageReceiptBindings(root, parsedManifestForFinalize, reviewerResult, manifest.abs);
  if (stageBindingErrors.length > 0) {
    return failureEnvelope(
      command,
      stageBindingErrors.map((message) => ({ code: 'PROJECT.FINALIZE_REJECTED', message })),
    );
  }

  // finalize 语义：seam 交叉验证 Manifest + E2E Receipt + Reviewer Result 的
  // 全部绑定（快照/digest/triple-binding/criteria 覆盖）；成功写唯一
  // PROJECT_REVIEW_PASS Receipt（previous_digest 链到 e2e receipt），失败零写入。
  // 目录创建已后置于全部输入校验之后（S10-D CV repair / Round 2）。
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.BLOCKED',
      `cannot create the Project Review Receipt directory: ${errorMessage(error)}`,
    );
  }
  const result = finalizeProjectReview({
    manifestPath: manifest.abs,
    e2eReceiptPath: e2e.abs,
    reviewerResultPath: reviewer.abs,
    outputDir,
  });
  if (!result.success || result.receiptPath === undefined || result.receiptDigest === undefined) {
    return failureEnvelope(
      command,
      result.errors.map((message) => ({ code: 'PROJECT.FINALIZE_REJECTED', message })),
    );
  }
  const ref = rootRelativeRef(root, result.receiptPath);
  return okEnvelopeWithRefs(
    command,
    {
      success: true,
      verdict: reviewerResult.verdict,
      reviewer: reviewerResult.reviewer,
      receipt_ref: { ref, digest: result.receiptDigest },
      findings: [],
    },
    [{ ref, digest: result.receiptDigest }],
  );
}

// ============================================================
// Dispatcher
// ============================================================

/**
 * Run one project-domain operation and return its canonical envelope。
 * 所有失败均为 structured finding（exit 2, no-write）；成功 exit 0。
 * run-e2e 是异步操作（真实 E2E step 执行 + seam 写 Receipt）。
 */
export async function runProjectDomain(
  root: string,
  _rootSource: 'explicit' | 'auto',
  command: CliCommand,
  params: ProjectOperationParams,
): Promise<CliEnvelope> {
  switch (command.operation) {
    case 'status':
      return runProjectStatus(root, command);
    case 'compile-acceptance':
      return runCompileAcceptance(root, command, params);
    case 'run-e2e':
      return runE2E(root, command, params);
    case 'prepare-review':
      return runPrepareReview(root, command, params);
    case 'finalize-review':
      return runFinalizeReview(root, command, params);
    default:
      // The dispatcher registry is the closed authority; this branch is a
      // defensive guard for future registry extensions without a handler.
      return errorEnvelope(
        command,
        'RUNTIME.NOT_IMPLEMENTED',
        `operation "project ${String(command.operation)}" is a closed command without a handler yet`,
      );
  }
}

// ============================================================
// Handler-direct argv entry（canonical root assertion + unified request）
// ============================================================

/**
 * Handler-direct entry for the project domain: parses the closed flag set,
 * asserts the canonical trust root, resolves the unified request input and
 * dispatches `runProjectDomain`.  Success paths must be exercised through the
 * built public `proofloop <domain> <operation>` dispatcher（S10-C 教训）; this
 * entry stays the seam for failure/boundary cases（缺参、非法 verdict、root
 * escape、非 project route）。
 */
export async function runProjectFromArgv(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<CliEnvelope> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const command: CliCommand = {
    domain: argv[0] ?? 'project',
    operation: argv[1] ?? null,
  };
  if (command.domain !== 'project') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `unknown domain "${command.domain}" (project entry)`,
    );
  }
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv.slice(2));
  } catch (error) {
    return errorEnvelope(
      command,
      'USAGE',
      `usage: proofloop project <operation> [flags] — ${errorMessage(error)}`,
    );
  }
  if (parsed.help) {
    return okEnvelope(command, { usage: 'proofloop project <status|compile-acceptance|run-e2e|prepare-review|finalize-review> [flags]' });
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
  return runProjectDomain(root, 'auto', command, collectProjectParams(parsed, requestValidation.request));
}

if (require.main === module) {
  runProjectFromArgv(process.argv.slice(2)).then((envelope) => {
    process.exitCode = envelope.ok ? 0 : 2;
  });
}
