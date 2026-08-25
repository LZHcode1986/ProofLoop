/**
 * vNext Stage Review preparation facts（D2 / P0-2）。
 *
 * `prepare-stage` 从只读投影升级为**持久化 prepared fact**：digest-addressed
 * 的非 Receipt 持久化事实（不入 Receipt chain），存储于
 * `.proofloop/review/<stage_id>/preparations/<digest>.json`。
 *
 * - digest = `computeDigest` over the fact's stable fields（除 `prepared_at`
 *   外的全部字段，canonical JSON 序列化）——文件名即 digest；
 * - 写入遵循 Runtime 既有 root-bound + O_NOFOLLOW + no-replace（O_EXCL）
 *   write-once 模式（与 `persistVNextWorkerContext` 同构）：已存在同 digest
 *   文件时按稳定字段相等判定幂等成功（prepared_at 不参与 digest）；
 * - 读侧 API `readVNextStageReviewPreparedFacts` 是主线 Row-12 分裂的集成点：
 *   扫描 preparations 目录（目录不存在 → null），逐文件 O_NOFOLLOW 读 +
 *   closed-schema 校验（坏文件跳过），按 binding 四元组全等过滤，返回文件名
 *   排序最新者；无匹配 → null；路径逃逸 fail-closed 抛错。
 *
 * 全部字段由 Runtime seam 派生（caller 不可注入）；本模块不派生任何绑定——
 * Manifest/plan/snapshot/Gate-PASS digest 由 CLI 接线从
 * `assembleVNextStageReviewRequest` + `readVNextStageReviewStatus`
 * （review-admission 既有导出）取得后构造 fact。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest } from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { CANONICAL_STAGE_ID_RE, VNextStageIdError } from './stage-id';
import { VNextHandoffError } from './errors';

// ============================================================
// Frozen fact contract（D2 冻结契约）
// ============================================================

/** prepared fact 的 closed schema version。 */
export const VNEXT_STAGE_REVIEW_PREPARATION_SCHEMA_VERSION = 2;

/**
 * 持久化 Stage Review preparation fact。
 *
 * `manifest_digest` / `plan_digest` / `gate_receipt_digest` 为 lowercase
 * 64-hex SHA-256；`snapshot_digest` 为 lowercase 40-hex Git SHA；
 * `prepared_at` 为 ISO8601 时间戳（不参与 digest 计算）。
 */
export interface VNextStageReviewPreparation {
  readonly schema_version: typeof VNEXT_STAGE_REVIEW_PREPARATION_SCHEMA_VERSION;
  readonly stage_id: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly gate_receipt_digest: string;
  readonly snapshot_digest: string;
  readonly review_input_refs: readonly string[];
  readonly prepared_at: string;
}

/** 读侧 binding 四元组（全部全等才算命中）。 */
export interface VNextStageReviewPreparedBinding {
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly gateReceiptDigest: string;
  readonly snapshotDigest: string;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
/** D2 冻结契约：preparation fact 的 snapshot 绑定是 40-hex Git SHA。 */
const GIT_SHA_HEX_RE = /^[a-f0-9]{40}$/;

/** preparations 目录内的合法条目名：`<64hex>.json`（其余一律跳过）。 */
const PREPARATION_FILE_RE = /^([a-f0-9]{64})\.json$/;

const PREPARATION_FIELDS = new Set([
  'schema_version',
  'stage_id',
  'manifest_digest',
  'plan_digest',
  'gate_receipt_digest',
  'snapshot_digest',
  'review_input_refs',
  'prepared_at',
]);

/** Root-relative preparations 目录（`.proofloop/review/<stage>/preparations`）。 */
function preparationsRelativeDir(stageId: string): string {
  return path.posix.join('.proofloop', 'review', stageId, 'preparations');
}

/** 除 `prepared_at` 外的稳定字段（digest 计算与自校验的唯一输入）。 */
function stablePreparationFields(
  fact: VNextStageReviewPreparation,
): Record<string, unknown> {
  const { prepared_at: _preparedAt, ...stable } = fact;
  return stable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type CheckedPreparation =
  | { ok: true; fact: VNextStageReviewPreparation }
  | { ok: false; error: string };

/**
 * Closed-schema validation of one persisted preparation fact. Returns a
 * structured error message instead of throwing so the read side can SKIP bad
 * files while the write side can fail closed on the same check.
 */
function checkPreparedFact(value: unknown, label: string): CheckedPreparation {
  if (!isRecord(value)) {
    return { ok: false, error: `${label} is not a JSON object` };
  }
  const unknown = Reflect.ownKeys(value).filter(
    (key) => typeof key !== 'string' || !PREPARATION_FIELDS.has(key),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `${label} contains unknown field(s): ${unknown.map(String).join(', ')}`,
    };
  }
  const missing = [...PREPARATION_FIELDS].filter((field) => !(field in value));
  if (missing.length > 0) {
    return { ok: false, error: `${label} is missing field(s): ${missing.join(', ')}` };
  }
  if (value.schema_version !== VNEXT_STAGE_REVIEW_PREPARATION_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `${label} schema_version must be ${VNEXT_STAGE_REVIEW_PREPARATION_SCHEMA_VERSION}`,
    };
  }
  if (
    typeof value.stage_id !== 'string' ||
    !CANONICAL_STAGE_ID_RE.test(value.stage_id)
  ) {
    return {
      ok: false,
      error: `${label} stage_id is not a canonical Stage ID (^S\\d+$)`,
    };
  }
  for (const field of ['manifest_digest', 'plan_digest', 'gate_receipt_digest'] as const) {
    const digest = value[field];
    if (typeof digest !== 'string' || !SHA256_HEX_RE.test(digest)) {
      return {
        ok: false,
        error: `${label} ${field} is not a lowercase 64-hex SHA-256 digest`,
      };
    }
  }
  if (typeof value.snapshot_digest !== 'string' || !GIT_SHA_HEX_RE.test(value.snapshot_digest)) {
    return {
      ok: false,
      error: `${label} snapshot_digest is not a lowercase 40-hex Git SHA`,
    };
  }
  if (!Array.isArray(value.review_input_refs)) {
    return { ok: false, error: `${label} review_input_refs must be an array` };
  }
  for (const ref of value.review_input_refs) {
    if (typeof ref !== 'string' || ref.length === 0) {
      return {
        ok: false,
        error: `${label} review_input_refs must contain only non-empty strings`,
      };
    }
  }
  if (typeof value.prepared_at !== 'string' || !Number.isFinite(Date.parse(value.prepared_at))) {
    return { ok: false, error: `${label} prepared_at is not an ISO8601 timestamp` };
  }
  return {
    ok: true,
    fact: {
      schema_version: VNEXT_STAGE_REVIEW_PREPARATION_SCHEMA_VERSION,
      stage_id: value.stage_id as string,
      manifest_digest: value.manifest_digest as string,
      plan_digest: value.plan_digest as string,
      gate_receipt_digest: value.gate_receipt_digest as string,
      snapshot_digest: value.snapshot_digest as string,
      review_input_refs: [...(value.review_input_refs as string[])],
      prepared_at: value.prepared_at as string,
    },
  };
}

// ============================================================
// Write side — root-bound O_NOFOLLOW no-replace persistence
// ============================================================

/**
 * 已存在同 digest 文件的幂等判定。
 *
 * `prepared_at` 不参与 digest（冻结契约）：同一绑定四元组重跑 prepare 必然
 * 命中同一路径但携带新时间戳，因此幂等成功按「已存文件通过 closed-schema
 * 校验且其稳定字段重算 digest 等于目标 digest」判定；损坏/伪造内容（JSON
 * 不可解析、schema 违例或 digest 自校验失败）一律 fail-closed。
 */
function verifyExistingPreparation(
  root: string,
  canonical: string,
  digest: string,
): void {
  const opened = openNoFollowRead(root, canonical);
  if (!opened.ok) {
    throw new VNextHandoffError(
      'manifest-binding',
      'existing review preparation is not a regular root-bound file',
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(opened.fd, 'utf8');
  } finally {
    fs.closeSync(opened.fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VNextHandoffError(
      'manifest-binding',
      'existing review preparation content does not match its digest',
    );
  }
  const checked = checkPreparedFact(parsed, 'existing review preparation');
  if (!checked.ok || computeDigest(stablePreparationFields(checked.fact)) !== digest) {
    throw new VNextHandoffError(
      'manifest-binding',
      'existing review preparation content does not match its digest',
    );
  }
}

/**
 * Persist one prepared fact at its digest-addressed path（write-once，
 * 已存在同 digest 文件时幂等成功（稳定字段相等判定，见 helper 注释），不一致 fail-closed）。
 *
 * 写入路径遵循 Runtime 既有模式（参考 `persistVNextWorkerContext`）：
 * canonical-path 边界检查 → 父目录 recursive mkdir →
 * `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`(0o600) 原子 write-once → fsync；
 * EEXIST race 时通过 `openNoFollowRead` 复核内容后幂等返回。
 *
 * @throws {VNextHandoffError} code=`manifest-invalid`（fact 不满足冻结 schema）、
 *         `path-escape`（ref 逃逸 trust root）、`manifest-binding`（写入/
 *         复核失败或同 digest 内容冲突）。
 */
export function persistVNextStageReviewPreparation(
  root: string,
  fact: VNextStageReviewPreparation,
): { ref: string; digest: string } {
  if (typeof root !== 'string' || root.length === 0) {
    throw new VNextHandoffError('manifest-binding', 'review preparation requires a project root');
  }
  const checked = checkPreparedFact(fact, 'review preparation fact');
  if (!checked.ok) {
    throw new VNextHandoffError('manifest-invalid', checked.error);
  }
  // Freeze a defensive copy so caller-side mutation after this point can
  // never desynchronize the computed digest from the persisted payload.
  const prepared: VNextStageReviewPreparation = { ...checked.fact };
  const digest = computeDigest(stablePreparationFields(prepared));
  const ref = path.posix.join(preparationsRelativeDir(prepared.stage_id), `${digest}.json`);
  const payload = JSON.stringify(prepared, null, 2) + '\n';
  const target = path.join(root, ref);
  const canonical = canonicalPathWithinRoot(root, target);
  if (canonical === null) {
    throw new VNextHandoffError(
      'path-escape',
      `review preparation ref escapes the project root trust boundary: ${ref}`,
    );
  }
  // Existing same-digest file → 幂等成功按稳定字段相等判定（见 helper 注释）。
  try {
    fs.lstatSync(canonical);
    verifyExistingPreparation(root, canonical, digest);
    return { ref, digest };
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new VNextHandoffError('manifest-binding', 'review preparation cannot be inspected');
    }
  }
  const parent = canonicalPathWithinRoot(root, path.dirname(canonical));
  if (parent === null) {
    throw new VNextHandoffError(
      'path-escape',
      `review preparation parent escapes the project root trust boundary: ${ref}`,
    );
  }
  fs.mkdirSync(parent, { recursive: true });
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      canonical,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Concurrent writer installed the same digest first — stable-field idempotency.
      verifyExistingPreparation(root, canonical, digest);
      return { ref, digest };
    }
    throw new VNextHandoffError(
      'manifest-binding',
      'review preparation could not be persisted write-once: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  // 成功的新建写入路径：digest-addressed ref + digest。
  return { ref, digest };
}

// ============================================================
// Read side — mainline Row-12 integration point
// ============================================================

function checkBinding(value: VNextStageReviewPreparedBinding): string | null {
  if (!isRecord(value)) return 'binding must be an object';
  for (const key of ['manifestDigest', 'planDigest', 'gateReceiptDigest'] as const) {
    const digest = value[key];
    if (typeof digest !== 'string' || !SHA256_HEX_RE.test(digest)) {
      return `${key} must be a lowercase 64-hex SHA-256 digest`;
    }
  }
  if (typeof value.snapshotDigest !== 'string' || !GIT_SHA_HEX_RE.test(value.snapshotDigest)) {
    return 'snapshotDigest must be a lowercase 40-hex Git SHA';
  }
  return null;
}

/**
 * Read the newest prepared fact matching the exact binding quadruple
 * （主线 FINALIZE/PREPARE 分裂消费点）。
 *
 * - preparations 目录不存在 → `null`（尚未 prepare，正常状态）；
 * - 逐文件 O_NOFOLLOW 读 + closed-schema 校验 + digest 自校验，坏文件跳过；
 * - 仅返回 `stage_id` 与 binding 四元组（Manifest/plan/Gate-PASS/snapshot）
 *   全等的最新事实（文件名排序最大者）；无匹配 → `null`（stale binding 绝
 *   不阻塞）；
 * - 路径逃逸 fail-closed 抛错（`VNextHandoffError` code=`path-escape`）；
 *   非法 stageId/binding 格式同样 fail-closed 抛错。
 *
 * @throws {VNextStageIdError} 非 canonical Stage ID。
 * @throws {VNextHandoffError} binding 格式非法（code=`manifest-binding`）、
 *         路径逃逸（code=`path-escape`）。
 */
export function readVNextStageReviewPreparedFacts(
  root: string,
  stageId: string,
  binding: VNextStageReviewPreparedBinding,
): VNextStageReviewPreparation | null {
  if (typeof root !== 'string' || root.length === 0) {
    throw new VNextHandoffError('manifest-binding', 'review preparation read requires a project root');
  }
  if (typeof stageId !== 'string' || !CANONICAL_STAGE_ID_RE.test(stageId)) {
    throw new VNextStageIdError('stageId', String(stageId));
  }
  const bindingError = checkBinding(binding);
  if (bindingError !== null) {
    throw new VNextHandoffError('manifest-binding', `invalid review preparation binding: ${bindingError}`);
  }
  const relativeDir = preparationsRelativeDir(stageId);
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(root, relativeDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let newest: { name: string; fact: VNextStageReviewPreparation } | null = null;
  for (const name of entries.slice().sort()) {
    const fileMatch = PREPARATION_FILE_RE.exec(name);
    if (fileMatch === null) continue; // 非法条目名 → 跳过
    const fileDigest = fileMatch[1] as string;
    const relativeRef = path.posix.join(relativeDir, name);
    const canonical = canonicalPathWithinRoot(root, path.join(root, relativeRef));
    if (canonical === null) {
      // 目录/条目符号链接逃逸 trust root —— fail-closed，绝不降级为跳过。
      throw new VNextHandoffError(
        'path-escape',
        `review preparation ref escapes the project root trust boundary: ${relativeRef}`,
      );
    }
    const opened = openNoFollowRead(root, canonical);
    if (!opened.ok) {
      if (opened.reason === 'escape') {
        throw new VNextHandoffError(
          'path-escape',
          `review preparation final component escape at open: ${relativeRef}`,
        );
      }
      continue; // unreadable / not-regular / inode-mismatch → 坏文件跳过
    }
    let raw: string;
    try {
      raw = fs.readFileSync(opened.fd, 'utf8');
    } finally {
      fs.closeSync(opened.fd);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // 损坏 JSON → 坏文件跳过
    }
    const checked = checkPreparedFact(parsed, `review preparation ${relativeRef}`);
    if (!checked.ok) continue; // closed-schema 违例 → 坏文件跳过
    const fact = checked.fact;
    // Digest-addressing self-check：文件名必须等于稳定字段重算 digest。
    if (computeDigest(stablePreparationFields(fact)) !== fileDigest) continue;
    if (fact.stage_id !== stageId) continue;
    if (
      fact.manifest_digest !== binding.manifestDigest ||
      fact.plan_digest !== binding.planDigest ||
      fact.gate_receipt_digest !== binding.gateReceiptDigest ||
      fact.snapshot_digest !== binding.snapshotDigest
    ) {
      continue; // stale binding → 不匹配，绝不阻塞
    }
    newest = { name, fact };
  }
  return newest === null ? null : newest.fact;
}
