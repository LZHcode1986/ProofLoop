/**
 * stage-close-facts.ts — P-11 task B: read-only STAGE_CLOSE archived-facts
 * probe.
 *
 * Task A（并行）正在新增 vNext STAGE_CLOSE receipts（
 * `.proofloop/receipts/stage-close/<stage>/`，payload 判别
 * STAGE_CLOSE_RESULT / STAGE_CLOSE，含 close_type / reason / manifest_digest
 * 等）。在任务 A 的 admit seam 落地前，CLI 工具通过本轻量探测识别"Stage 已
 * 关闭"标记：目录存在且至少含一个合法 v2 STAGE_CLOSE_RESULT envelope ⇒ 该
 * Stage 已归档（archived）。
 *
 * Root-bound 且 fail-closed：
 *  - 所有读取经 `canonicalPathWithinRoot` + `openNoFollowRead`
 *    （no-follow / TOCTOU 检查），stageId 必须是 canonical Stage ID
 *    （`^S\d+$`；legacy 标签 fail closed）；
 *  - 目录不可读、或目录内任一 `.json` 文件不是合法 v2 STAGE_CLOSE_RESULT
 *    envelope（外层 STAGE_CLOSE_PASS + 自 digest + payload 判别）时抛错 ——
 *    绝不静默降级（破损的归档标记必须被报告，而不是被当作"未归档"）；
 *  - 目录不存在是正常的"未归档"状态（返回 `{ archived: false }`）。
 *
 * 与任务 A 的对齐点（见报告）：envelope 的 closed 字段集、chain linkage
 * （previous_digest）、以及 `manifest_digest` 绑定由任务 A 的 admit seam
 * 最终定义；本探测只校验判别所必需的最小 closed 面（外层 type/stage_id/
 * self-digest + payload schema_version/type/action/close_type）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeReceiptDigest } from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
// S09-C-T03: shared canonical Stage ID guard（`^S\d+$`；legacy labels 在
// 任何 Runtime 读取前 fail closed）。
import { CANONICAL_STAGE_ID_RE } from './stage-id';

/** Canonical stage-close Receipt category directory（`.proofloop/receipts/stage-close/<stage>/`）。 */
export function stageCloseReceiptDir(projectRoot: string, stageId: string): string {
  return path.join(projectRoot, '.proofloop', 'receipts', 'stage-close', stageId);
}

/** Latest legal v2 STAGE_CLOSE_RESULT envelope projection（不泄漏完整 payload）。 */
export interface StageCloseLatest {
  readonly digest: string;
  /** Outer Receipt type（v2 STAGE_CLOSE_PASS envelope，与写入方 admitVNextStageClose 一致）。 */
  readonly receipt_type: 'STAGE_CLOSE_PASS';
  /** Payload close_type（如 COMPLETED / RESTRICTED —— 闭集由任务 A 定义）。 */
  readonly close_type: string;
}

/**
 * Read-only archived facts of one Stage。
 *
 * 未归档：`{ archived: false }`。
 * 已归档：`{ archived: true, receipt_count, latest, close_type, reason,
 * receipt_digest }`（`latest`/`close_type`/`reason`/`receipt_digest` 取
 * timestamp 最新的合法 envelope）。
 */
export interface StageCloseFacts {
  readonly archived: boolean;
  /** 合法 v2 STAGE_CLOSE_RESULT envelope 数量（archived 时 present）。 */
  readonly receipt_count?: number;
  /** 最新合法 envelope 投影（archived 时 present）。 */
  readonly latest?: StageCloseLatest | null;
  /** 最新 envelope payload.close_type（archived 时 present）。 */
  readonly close_type?: string;
  /** 最新 envelope payload.reason（archived 时 present）。 */
  readonly reason?: string;
  /** 最新 envelope 自 digest（archived 时 present）。 */
  readonly receipt_digest?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`stage-close facts are unreadable: ${message}`);
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

interface LegalStageCloseEnvelope {
  readonly digest: string;
  readonly timestamp: string;
  readonly close_type: string;
  readonly reason?: string;
}

/**
 * 校验一个 stage-close 目录中的 `.json` 文件是合法 v2 STAGE_CLOSE_RESULT
 * envelope：外层 kernel Receipt 形状（version 1、type STAGE_CLOSE_PASS、
 * stage_id 绑定、ISO timestamp、64-hex 自 digest）＋ payload closed 判别
 * （schema_version 2 / type STAGE_CLOSE_RESULT / action STAGE_CLOSE /
 * 非空 close_type）。任一不符 → fail closed（抛错，绝不静默忽略）。
 */
function readLegalStageCloseEnvelope(
  root: string,
  file: string,
  stageId: string,
): LegalStageCloseEnvelope {
  const opened = openNoFollowRead(root, file);
  if (!opened.ok || opened.filePath !== file) {
    fail(`Receipt ${path.basename(file)} is unreadable or not root-bound`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
  } catch (error) {
    fail(`Receipt ${path.basename(file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    fs.closeSync(opened.fd);
  }
  if (!isRecord(parsed)) {
    fail(`Receipt ${path.basename(file)} must be a JSON object`);
  }
  if (parsed.version !== 1) {
    fail(`Receipt ${path.basename(file)} outer version must be 1`);
  }
  if (parsed.type !== 'STAGE_CLOSE_PASS') {
    fail(`Receipt ${path.basename(file)} outer type must be STAGE_CLOSE_PASS`);
  }
  if (parsed.stage_id !== stageId) {
    fail(`Receipt ${path.basename(file)} outer stage_id "${String(parsed.stage_id)}" does not match "${stageId}"`);
  }
  if (typeof parsed.timestamp !== 'string' || !ISO_TIMESTAMP_RE.test(parsed.timestamp)) {
    fail(`Receipt ${path.basename(file)} timestamp must be an ISO-8601 timestamp`);
  }
  if (typeof parsed.digest !== 'string' || !SHA256_RE.test(parsed.digest)) {
    fail(`Receipt ${path.basename(file)} digest must be a lowercase SHA-256 digest`);
  }
  const { digest: ignoredDigest, ...content } = parsed;
  void ignoredDigest;
  if (computeReceiptDigest(content as never) !== parsed.digest) {
    fail(`Receipt ${path.basename(file)} has an invalid self-digest`);
  }
  const payload = parsed.payload;
  if (!isRecord(payload)) {
    fail(`Receipt ${path.basename(file)} payload must be an object`);
  }
  if (payload.schema_version !== 2) {
    fail(`Receipt ${path.basename(file)} payload schema_version must be 2`);
  }
  if (payload.type !== 'STAGE_CLOSE_RESULT') {
    fail(`Receipt ${path.basename(file)} payload type must be STAGE_CLOSE_RESULT`);
  }
  if (payload.action !== 'STAGE_CLOSE') {
    fail(`Receipt ${path.basename(file)} payload action must be STAGE_CLOSE`);
  }
  if (typeof payload.close_type !== 'string' || payload.close_type.length === 0) {
    fail(`Receipt ${path.basename(file)} payload close_type must be a non-empty string`);
  }
  if (payload.reason !== undefined && typeof payload.reason !== 'string') {
    fail(`Receipt ${path.basename(file)} payload reason must be a string when present`);
  }
  return {
    digest: parsed.digest,
    timestamp: parsed.timestamp,
    close_type: payload.close_type,
    reason: typeof payload.reason === 'string' && payload.reason.length > 0
      ? payload.reason
      : undefined,
  };
}

/**
 * 读 `.proofloop/receipts/stage-close/<stage>/`，判定 Stage 是否已归档。
 *
 * - stageId 非 canonical（`^S\d+$`）→ 抛错（fail closed；所有生产调用方在
 *   调用前已应用共享 canonical Stage ID guard）；
 * - 目录不存在 → `{ archived: false }`（正常未归档状态）；
 * - 目录不可读 / 目录内任一 `.json` 文件非法 → 抛错（fail closed，绝不降级）；
 * - 至少一个合法 v2 STAGE_CLOSE_RESULT envelope → `{ archived: true, ... }`
 *   （`latest` = timestamp 最新者；timestamp 相同取 digest 最大者，确定性）。
 */
export function readStageCloseFacts(root: string, stageId: string): StageCloseFacts {
  if (!CANONICAL_STAGE_ID_RE.test(stageId)) {
    fail(`stageId must be a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected`);
  }
  const directory = stageCloseReceiptDir(root, stageId);
  if (canonicalPathWithinRoot(root, directory) === null) {
    fail('stage-close receipt directory escapes the project root');
  }
  let names: string[];
  try {
    if (!fs.statSync(directory).isDirectory()) {
      return { archived: false };
    }
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { archived: false };
    }
    fail(`stage-close receipt directory could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (names.length === 0) {
    return { archived: false };
  }

  const envelopes: LegalStageCloseEnvelope[] = [];
  for (const name of names) {
    envelopes.push(readLegalStageCloseEnvelope(root, path.join(directory, name), stageId));
  }
  envelopes.sort((left, right) => {
    if (left.timestamp < right.timestamp) return -1;
    if (left.timestamp > right.timestamp) return 1;
    if (left.digest < right.digest) return -1;
    if (left.digest > right.digest) return 1;
    return 0;
  });
  const latest = envelopes[envelopes.length - 1];
  if (latest === undefined) {
    return { archived: false };
  }
  return {
    archived: true,
    receipt_count: envelopes.length,
    latest: {
      digest: latest.digest,
      receipt_type: 'STAGE_CLOSE_PASS',
      close_type: latest.close_type,
    },
    close_type: latest.close_type,
    reason: latest.reason,
    receipt_digest: latest.digest,
  };
}
