/**
 * proofloop-cutover.ts — S10-E-T02 (CV repair 7bca6c06): cutover 域 handler。
 *
 * Contract（REF-S10-CUTOVER-RISK + tasks.md S10-E-T02，Acceptance F：
 * cutover；Seam §0.1/§0.2；REF-S08D-RISK public_api_change/migration）：
 *  - closed operation set：`cutover status` | `cutover execute`（注册于
 *    CANONICAL_DOMAINS / DOMAIN_REGISTRY —— 唯一 public seam，与 S10-C/D
 *    各域同构）；
 *  - `status`（只读）：legacy scan —— 检测 legacy CV 残留
 *    （sync-cv-status/cv_level）、旧单用途 scripts 的 v1 路径
 *    （prepare-gate-facts 的 src+dist 入口；compile-manifest/
 *    validate-stage/initialize-slice-evidence 已随插件退役删除）、Host
 *    legacy 权限
 *    （.opencode/agents/brain.md 中 `node packages/runtime/dist/cli/*.js`
 *    allow 条目）→ cutover matrix；零写入 exit 0；
 *  - `execute`（不可逆）：带 irreversible 保护语义 ——
 *    a. request 必须携带显式确认 `confirmed: true` 且 `delete_list` 非空
 *       string[]，否则 fail closed（exit 2，零删除）；
 *    b. Acceptance A–E 事实门禁：目标 stage 的每个 Slice 必须已有
 *       CV_PASS receipt 且已集成（INTEGRATION_PASS status integrated），
 *       任一缺失 → fail closed（exit 2，零删除）—— 删除只在 A–E 全绿后
 *       执行（REF-S10-CUTOVER-RISK irreversible_operation）；
 *    c. 精确删除清单绑定：delete_list 必须与 `cutover status` 检测出的
 *       legacy 删除目标完全一致（不允许任意 root-bound 文件），不一致 →
 *       fail closed（exit 2，零删除）；
 *    d. 原子预检：先全量校验（root-bound、普通文件、可删、清单匹配）
 *       通过后才执行删除；删除循环中失败 → 停止并报告已删/未删明细。
 *  - 未知操作 fail closed（RUNTIME.NOT_IMPLEMENTED，exit 2）。
 *
 * 本 handler 不直接写 `.proofloop/*`；execute 只删除调用方显式列入
 * `delete_list` 且与 status 检测一致的 legacy 文件（删除清单在 cutover
 * 前由 Review 确认）。dispatcher wiring（proofloop.ts 分支）已在本任务
 * 接入；`runCutoverFromArgv` 直通入口保留为 handler-direct seam（与
 * recovery/review/project 域同构）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeDigest, computeReceiptDigest, validateReceipt, verifyReceiptChain } from '@proofloop/kernel';
import type { VNextManifest } from '@proofloop/kernel';
import {
  emitEnvelope,
  errorEnvelope,
  okEnvelope,
  parseCliArgs,
  resolveRequestInput,
  resolveTrustRoot,
  type CliCommand,
  type CliEnvelope,
  type CliFinding,
  type ParsedCliArgs,
  type StageCliRequestInput,
} from './proofloop-common';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { resolveGitRoot } from '../git-source';
import { readVNextManifest, readVNextAdmissionAuthority, validateVNextCvResultEnvelope } from '../vnext';
import { parseProjectE2EReceipt, PROJECT_E2E_TYPES, PROJECT_E2E_TYPE_BY_VERDICT, type ProjectE2EReceipt } from '../project-acceptance';
import { defaultManifestPath } from '../manifest-source';
import { cvReceiptDir, integrationReceiptDir, stageGateReceiptDir, reviewReceiptDir, projectReceiptDir } from '../receipt-layout';
import { assertCanonicalStageId } from '../vnext/stage-id';

// ============================================================
// Legacy artifact inventory（cutover matrix 的权威清单）
// ============================================================

/** 旧单用途 scripts 的 v1 路径（src + dist 入口）。
 * compile-manifest / validate-stage / initialize-slice-evidence 已随
 * OpenCode 插件退役（2026-08-14 裁决）删除，不再检测；prepare-gate-facts
 * 仅剩 dist 残留，仍由 cutover 检测/删除。 */
const LEGACY_SCRIPT_IDS = [
  'prepare-gate-facts',
] as const;

/** 可能出现在 brain.md bash 权限中的 legacy dist CLI 条目。
 * compile-manifest.js / validate-stage.js / initialize-slice-evidence.js 的
 * 对应 CLI 已随插件退役删除，allow 条目无从指向现存可执行文件，不再检测；
 * 其余条目对应的 CLI 仍存在（admit/run-gate/next-action 的 src 入口，
 * sync-cv-status/prepare-gate-facts 的 dist 残留）。 */
const LEGACY_HOST_SCRIPT_IDS = [
  'admit.js',
  'run-gate.js',
  'sync-cv-status.js',
  'prepare-gate-facts.js',
  'next-action.js',
] as const;

// ============================================================
// Helpers
// ============================================================

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 目标是否已 root-bound（root 内相对路径）。 */
function isRootBoundRelative(root: string, value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\u0000') || value.includes('\\') || path.isAbsolute(value)) {
    return false;
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    return false;
  }
  return canonicalPathWithinRoot(root, value) !== null;
}

// ============================================================
// Legacy delete targets（status 检测 ↔ execute 精确绑定的权威集合）
// ============================================================

/**
 * Status 检测出的 legacy 文件删除目标（root-relative；仅文件型 legacy 项，
 * Host 权限为 brain.md 行级条目、cv_level 为字段残留，不在此列）。
 * execute 的 delete_list 必须与本次检测结果完全一致。
 */
function detectLegacyDeleteTargets(root: string): string[] {
  const targets: string[] = [];
  // legacy CV 残留：sync-cv-status 的 src + dist 入口。
  for (const rel of [
    'packages/runtime/src/cli/sync-cv-status.ts',
    'packages/runtime/dist/cli/sync-cv-status.js',
  ]) {
    if (fs.existsSync(path.join(root, rel))) targets.push(rel);
  }
  // 旧单用途 scripts 的 v1 路径：src + dist 入口。
  for (const id of LEGACY_SCRIPT_IDS) {
    for (const rel of [
      `packages/runtime/src/cli/${id}.ts`,
      `packages/runtime/dist/cli/${id}.js`,
    ]) {
      if (fs.existsSync(path.join(root, rel))) targets.push(rel);
    }
  }
  return targets.sort();
}

// ============================================================
// status（只读 legacy scan → cutover matrix）
// ============================================================

/** 检测 legacy CV 残留（sync-cv-status / cv_level）。 */
function scanLegacyCv(root: string): Array<{ id: string; detected: boolean; detail: string }> {
  const srcSyncCv = path.join(root, 'packages', 'runtime', 'src', 'cli', 'sync-cv-status.ts');
  const distSyncCv = path.join(root, 'packages', 'runtime', 'dist', 'cli', 'sync-cv-status.js');
  const syncCvPresent = fs.existsSync(srcSyncCv) || fs.existsSync(distSyncCv);
  // cv_level 残留：src 中的字段/输出引用（vNext CV 已删除 CV Level/Profile）。
  let cvLevelResidual = '';
  try {
    if (fs.existsSync(srcSyncCv)) {
      const src = fs.readFileSync(srcSyncCv, 'utf-8');
      if (src.includes('cv_level')) cvLevelResidual = 'packages/runtime/src/cli/sync-cv-status.ts';
    }
  } catch {
    // 不可读 → 视为未检测（不猜测）。
  }
  return [
    { id: 'sync-cv-status', detected: syncCvPresent, detail: syncCvPresent ? 'src/dist entry present' : 'removed' },
    { id: 'cv_level', detected: cvLevelResidual.length > 0, detail: cvLevelResidual.length > 0 ? cvLevelResidual : 'no cv_level residual' },
  ];
}

/** 检测旧单用途 scripts 的 v1 路径（src + dist 任一存在即 detected）。 */
function scanLegacyScripts(root: string): Array<{ id: string; detected: boolean; detail: string }> {
  const items: Array<{ id: string; detected: boolean; detail: string }> = [];
  for (const id of LEGACY_SCRIPT_IDS) {
    const src = path.join(root, 'packages', 'runtime', 'src', 'cli', `${id}.ts`);
    const dist = path.join(root, 'packages', 'runtime', 'dist', 'cli', `${id}.js`);
    const present: string[] = [];
    if (fs.existsSync(src)) present.push(`src/${id}.ts`);
    if (fs.existsSync(dist)) present.push(`dist/${id}.js`);
    items.push({ id, detected: present.length > 0, detail: present.length > 0 ? present.join(', ') : 'removed' });
  }
  return items;
}

/** 检测 Host legacy 权限（brain.md bash allow 条目中的 legacy dist CLI）。 */
function scanHostLegacyPermissions(root: string): Array<{ id: string; detected: boolean; detail: string }> {
  const brainPath = path.join(root, '.opencode', 'agents', 'brain.md');
  let content = '';
  try {
    content = fs.readFileSync(brainPath, 'utf-8');
  } catch {
    return LEGACY_HOST_SCRIPT_IDS.map((id) => ({ id, detected: false, detail: 'brain.md absent' }));
  }
  const items: Array<{ id: string; detected: boolean; detail: string }> = [];
  for (const id of LEGACY_HOST_SCRIPT_IDS) {
    const needle = `node packages/runtime/dist/cli/${id} `;
    const detected = content.includes(needle) || content.includes(`"node packages/runtime/dist/cli/${id} *"`);
    items.push({ id, detected, detail: detected ? `brain.md allow ${id}` : 'no allow entry' });
  }
  return items;
}

function runCutoverStatus(root: string, command: CliCommand): CliEnvelope {
  return okEnvelope(command, {
    schema_version: 2,
    cutover_matrix: {
      legacy_cv: scanLegacyCv(root),
      legacy_scripts: scanLegacyScripts(root),
      host_legacy_permissions: scanHostLegacyPermissions(root),
      // execute 的 delete_list 必须与此完全一致（精确清单绑定）。
      delete_targets: detectLegacyDeleteTargets(root),
    },
    // 只读检测：永远不在此操作中写文件。
    note: 'read-only legacy scan; deletions require `cutover execute` with confirmed:true, matching delete_list and Acceptance A-E facts',
    findings: [],
  });
}

// ============================================================
// execute（不可逆，带 irreversible 保护语义）
// ============================================================

interface CutoverExecuteRequest {
  readonly confirmed?: unknown;
  readonly delete_list?: unknown;
  readonly stage?: string;
}

/** 提取并校验 execute request（缺确认/缺清单 → 结构化 Finding）。 */
function validateExecuteRequest(
  command: CliCommand,
  request: StageCliRequestInput,
): { ok: true; deleteList: readonly string[] } | { ok: false; envelope: CliEnvelope } {
  const raw = request as unknown as CutoverExecuteRequest;
  if (raw.confirmed !== true) {
    return {
      ok: false,
      envelope: errorEnvelope(
        command,
        'CUTOVER.CONFIRMATION_REQUIRED',
        'cutover execute is an IRREVERSIBLE operation (REF-S10-CUTOVER-RISK); the request must carry "confirmed": true and an explicit delete_list',
      ),
    };
  }
  if (!Array.isArray(raw.delete_list) || raw.delete_list.length === 0) {
    return {
      ok: false,
      envelope: errorEnvelope(
        command,
        'CUTOVER.DELETE_LIST_REQUIRED',
        'cutover execute requires a non-empty explicit delete_list (root-relative paths); the deletion manifest is never guessed',
      ),
    };
  }
  if (raw.delete_list.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return {
      ok: false,
      envelope: errorEnvelope(
        command,
        'CUTOVER.DELETE_LIST_REQUIRED',
        'cutover execute delete_list entries must be non-empty root-relative paths',
      ),
    };
  }
  return { ok: true, deleteList: raw.delete_list as readonly string[] };
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
/** project 域（非 stage）path+digest 引用宽度：fileDigest16 /
 *  computeCanonicalJsonDigest / computeSnapshot 均为 16 位 hex
 *  （project-acceptance.ts 唯一事实；第 8 轮 f162a773 修复：此前误用 64 位
 *  SHA256_RE 导致真实 PROJECT_REVIEW_PASS 被拒）。stage_receipts 条目已切
 *  vNext 语义（stage refs 64 位 hex、snapshot 40 位 hex），见
 *  assertProjectReviewClosed。 */
const HEX16_RE = /^[a-f0-9]{16}$/i;

/** 已验证的 receipt 条目（含 outer 绑定字段与链序 tip 标记）。 */
interface VerifiedReceipt {
  readonly type: string;
  readonly digest: string;
  readonly payload: Record<string, unknown>;
  /** outer receipt 字段（kernel validateReceipt 保留顶层字段）。 */
  readonly outerStageId: string | undefined;
  readonly outerSliceId: string | undefined;
  readonly previousDigest: string | undefined;
  /** receipt 顶层 timestamp（ISO-8601；latest tip 选择权威）。 */
  readonly timestamp: string;
}

/**
 * 读取并验证一个 receipt 类别目录（真实性绑定，强度对齐 Runtime 既有
 * gate-admission readReceiptChain 语义）：
 *  - 目录必须 root-bound（canonical === lexical）；
 *  - 每个 .json 文件必须 digest-addressed（文件名 === `<digest>.json`）且
 *    self-digest 自校验（computeReceiptDigest(content) === digest）；
 *  - schema 合法（validateReceipt）；
 *  - 严格链序：单根（恰一个 genesis）、无环、单后继（fork → 拒绝）、
 *    timestamp 按 ISO-8601 真实时间解析（Date.parse）单调非降、无 dangling；
 *  - 返回按链序排列的条目，tip = 链尾（最新事实）；
 *  - 伪造/失配 → 结构化错误（调用方 fail closed 零删除）。
 */
function readVerifiedReceipts(
  root: string,
  directory: string,
  label: string,
): { ok: true; receipts: VerifiedReceipt[]; tip: VerifiedReceipt | null } | { ok: false; error: string } {
  const lexical = path.resolve(directory);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    return { ok: false, error: `${label} is not a canonical directory under the project root` };
  }
  let names: string[];
  try {
    const stat = fs.statSync(lexical);
    if (!stat.isDirectory()) {
      return { ok: false, error: `${label} is not a directory` };
    }
    names = fs.readdirSync(lexical).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // 类别目录不存在 = 该类事实缺失（调用方按 missing 处理）。
      return { ok: true, receipts: [], tip: null };
    }
    return { ok: false, error: `${label} could not be read: ${errorMessage(error)}` };
  }

  const byFile = new Map<string, VerifiedReceipt>();
  for (const name of names) {
    const file = path.join(lexical, name);
    const opened = openNoFollowRead(root, file);
    if (!opened.ok || opened.filePath !== file) {
      return { ok: false, error: `${label} contains an unreadable or redirected Receipt: ${name}` };
    }
    let receipt: ReturnType<typeof validateReceipt>;
    try {
      receipt = validateReceipt(JSON.parse(fs.readFileSync(opened.fd, 'utf8')));
    } catch (error) {
      return { ok: false, error: `${label} Receipt ${name} failed schema validation: ${errorMessage(error)}` };
    } finally {
      fs.closeSync(opened.fd);
    }
    if (!SHA256_RE.test(receipt.digest) || name !== `${receipt.digest}.json`) {
      return { ok: false, error: `${label} Receipt ${name} is not digest-addressed` };
    }
    const { digest: ignored, ...content } = receipt;
    void ignored;
    if (computeReceiptDigest(content) !== receipt.digest) {
      return { ok: false, error: `${label} Receipt ${name} has an invalid self-digest` };
    }
    const payload = (receipt.payload ?? {}) as Record<string, unknown>;
    byFile.set(file, {
      type: receipt.type,
      digest: receipt.digest,
      payload,
      outerStageId: typeof receipt.stage_id === 'string' ? receipt.stage_id : undefined,
      outerSliceId: typeof receipt.slice_id === 'string' ? receipt.slice_id : undefined,
      previousDigest: typeof receipt.previous_digest === 'string' ? receipt.previous_digest : undefined,
      timestamp: typeof receipt.timestamp === 'string' ? receipt.timestamp : '',
    });
  }

  if (byFile.size === 0) return { ok: true, receipts: [], tip: null };

  // 严格链序（对齐 gate-admission readReceiptChain）：单根、无环、单后继、
  // timestamp 真实时间单调、无 dangling/orphan——fork/分叉一律拒绝。
  const byDigest = new Map<string, VerifiedReceipt>();
  for (const entry of byFile.values()) byDigest.set(entry.digest, entry);
  const roots = [...byDigest.values()].filter((entry) => entry.previousDigest === undefined);
  if (roots.length !== 1) {
    return { ok: false, error: `${label} must have exactly one root Receipt (found ${roots.length})` };
  }
  const ordered: VerifiedReceipt[] = [];
  const visited = new Set<string>();
  let current: VerifiedReceipt | undefined = roots[0];
  let previousTime = Number.NEGATIVE_INFINITY;
  while (current !== undefined) {
    if (visited.has(current.digest)) {
      return { ok: false, error: `${label} Receipt chain contains a cycle at ${current.digest}` };
    }
    const time = parseIsoTimestamp(current.timestamp);
    if (time === null || time < previousTime) {
      return { ok: false, error: `${label} Receipt ${current.digest} is not timestamp-ordered` };
    }
    visited.add(current.digest);
    ordered.push(current);
    const successors = [...byDigest.values()].filter(
      (entry) => entry.previousDigest === current?.digest,
    );
    if (successors.length > 1) {
      return { ok: false, error: `${label} Receipt ${current.digest} has more than one successor (fork)` };
    }
    previousTime = time;
    current = successors[0];
  }
  if (visited.size !== byDigest.size) {
    return { ok: false, error: `${label} Receipt chain contains dangling or forked Receipts` };
  }
  return { ok: true, receipts: ordered, tip: ordered[ordered.length - 1] };
}

/** ISO-8601 时间戳真实时间解析（Date.parse）；非法 → null。 */
function parseIsoTimestamp(value: string): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * 是否处于已接纳 execution snapshot 链上：等于 admitted snapshot 或为其
 * Git descendant（`git merge-base --is-ancestor <admitted> <candidate>`，
 * 对齐 cv-admission snapshotOnAdmittedChain 语义）。无关/回退 snapshot
 * 不是 execution fact；Git boundary 不可用 → fail closed。
 */
function snapshotOnAdmittedChain(root: string, candidate: unknown, admittedSnapshot: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (candidate === admittedSnapshot) return true;
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
  } catch {
    return false;
  }
  try {
    execFileSync('git', ['-C', gitRoot, 'merge-base', '--is-ancestor', admittedSnapshot, candidate], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}



/** vNext receipt payload 判别式（按仓库真实 vNext 形状）。 */
function payloadDiscriminator(
  payload: Record<string, unknown>,
  type: string,
  verdict: string,
  verdictField: 'verdict' | 'commit_sha' = 'verdict',
): boolean {
  if (payload['schema_version'] !== 2 || payload['type'] !== type) return false;
  const value = payload[verdictField];
  if (verdictField === 'commit_sha') {
    return typeof value === 'string' && GIT_SHA_RE.test(value as string);
  }
  return value === verdict;
}

/** PROJECT_E2E receipt payload 顶层字段闭集（对齐 ProjectE2EReceipt）。 */
const PROJECT_E2E_TOP_FIELDS = new Set([
  'project_id', 'verdict', 'snapshot', 'manifest_digest', 'expected_snapshot',
  'executed_snapshot', 'steps', 'service_cleanup', 'created_at',
]);
/** E2E step 字段闭集（对齐 E2EStepResult）。 */
const E2E_STEP_FIELDS = new Set(['step_id', 'exit_code', 'observations', 'skipped']);
/** PROJECT_REVIEW_PASS payload 字段闭集（对齐 reviewReceipt 形状）。 */
const PROJECT_REVIEW_FIELDS = new Set([
  'project_id', 'verdict', 'snapshot', 'reviewer', 'findings',
  'accepted_deviations', 'project_manifest', 'project_e2e_receipt',
  'reviewed_at', 'stage_receipts', 'criteria_results',
]);

/** E2E 顶层/嵌套字段闭集检查（未知字段拒绝，含 steps 每项字段闭集）。 */
function assertE2EClosedFields(payload: Record<string, unknown>): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  for (const key of Object.keys(payload)) {
    if (!PROJECT_E2E_TOP_FIELDS.has(key)) return false;
  }
  const steps = payload['steps'];
  if (!Array.isArray(steps)) return false;
  for (const item of steps) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    for (const key of Object.keys(item as Record<string, unknown>)) {
      if (!E2E_STEP_FIELDS.has(key)) return false;
    }
  }
  // service_cleanup 嵌套闭集（修复 06bfcc55：顶层/嵌套未知字段拒绝）。
  const cleanup = payload['service_cleanup'];
  if (typeof cleanup !== 'object' || cleanup === null || Array.isArray(cleanup)) return false;
  const cleanupKeys = new Set(['cleaned', 'failed', 'remainingPids']);
  for (const key of Object.keys(cleanup as Record<string, unknown>)) {
    if (!cleanupKeys.has(key)) return false;
  }
  const cleaned = (cleanup as Record<string, unknown>)['cleaned'];
  if (!Array.isArray(cleaned) || cleaned.some((v) => typeof v !== 'string')) return false;
  const failed = (cleanup as Record<string, unknown>)['failed'];
  if (!Array.isArray(failed)) return false;
  for (const item of failed as Array<Record<string, unknown>>) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    for (const key of Object.keys(item)) {
      if (!new Set(['service', 'pid', 'reason']).has(key)) return false;
    }
    if (typeof item['service'] !== 'string' || item['service'].length === 0) return false;
    if (typeof item['pid'] !== 'number') return false;
    if (typeof item['reason'] !== 'string' || item['reason'].length === 0) return false;
  }
  const remaining = (cleanup as Record<string, unknown>)['remainingPids'];
  if (!Array.isArray(remaining) || remaining.some((v) => typeof v !== 'number')) return false;
  return true;
}

/** path+digest 引用闭集：{path: 非空 string, digest: 16 位 hex}，未知字段拒绝。 */
function assertPathDigestRefClosed(value: unknown, digestRegex: RegExp = HEX16_RE): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'path' && key !== 'digest') return false;
  }
  if (typeof obj['path'] !== 'string' || obj['path'].length === 0) return false;
  if (typeof obj['digest'] !== 'string' || !digestRegex.test(obj['digest'] as string)) return false;
  return true;
}

/** findings 数组闭集：每项 {category, description} 均为非空 string，未知字段拒绝。 */
function assertFindingsClosed(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const obj = item as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== 'category' && key !== 'description') return false;
    }
    if (typeof obj['category'] !== 'string' || obj['category'].length === 0) return false;
    if (typeof obj['description'] !== 'string' || obj['description'].length === 0) return false;
  }
  return true;
}

/** criteria_results 数组闭集：每项 {criteria: 非空 string, passed: boolean,
 *  notes?: string}；criteria 唯一（对齐 producer parseProjectReviewResult
 *  duplicate-criteria 拒绝）。未知字段拒绝。 */
function assertCriteriaResultsClosed(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const obj = item as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== 'criteria' && key !== 'passed' && key !== 'notes') return false;
    }
    if (typeof obj['criteria'] !== 'string' || obj['criteria'].length === 0) return false;
    if (typeof obj['passed'] !== 'boolean') return false;
    if (obj['notes'] !== undefined && typeof obj['notes'] !== 'string') return false;
    if (seen.has(obj['criteria'] as string)) return false;
    seen.add(obj['criteria'] as string);
  }
  return true;
}

/**
 * PROJECT_REVIEW_PASS 完整 closed schema（第 8 轮 f162a773 修复）。
 *
 * 唯一事实 = packages/runtime/src/project-acceptance.ts 的最终
 * ProjectReviewReceipt 接口与 finalizeProjectReview 实际产物：
 *  - 顶层必填 11 字段（findings/accepted_deviations 由 producer 以 `?? []`
 *    落盘、project_manifest/project_e2e_receipt 必填、criteria_results 必填）；
 *  - stage_receipts 条目 = { stage_id, stage_manifest, review, gate, snapshot }
 *    （注意：不是 manifest 输入格式的 review_receipt/gate_receipt —— 那是
 *    StageReceiptEntry，consumer 必须消费 finalize 产物）；
 *  - project 域 path+digest 引用为 16 位 hex（fileDigest16 / canonical
 *    digest）；stage_receipts 条目为 vNext 语义：stage_manifest/review/gate
 *    digest 是 64 位 hex（computeDigest / envelope digest），snapshot 是
 *    40 位 hex（vNext snapshot_digest = git commit sha）；
 *  - 嵌套类型/必填/未知字段全部拒绝（findings / accepted_deviations /
 *    criteria_results / project_manifest / project_e2e_receipt / stage_receipts
 *    条目内部）。
 *
 * 约束不高于 producer：stage_receipts 非空与 stage_id 唯一是 producer 写入
 * 前置（manifest.stage_receipts.length===0 与 duplicate stage_id 均使
 * finalize 失败，真实产物必满足）；criteria 唯一同 producer。
 */
function assertProjectReviewClosed(p: Record<string, unknown>): boolean {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return false;
  for (const key of Object.keys(p)) {
    if (!PROJECT_REVIEW_FIELDS.has(key)) return false;
  }
  const required: Array<[string, (v: unknown) => boolean]> = [
    ['project_id', (v) => typeof v === 'string' && v.length > 0],
    ['verdict', (v) => typeof v === 'string' && v.length > 0],
    // snapshot 为真实 computeSnapshot 形状：16 位 hex（project-acceptance.ts
    // 唯一事实；第 9 轮 repair：此前仅要求非空字符串，非法快照可过 closed
    // schema）。
    ['snapshot', (v) => typeof v === 'string' && HEX16_RE.test(v)],
    ['reviewer', (v) => typeof v === 'string' && v.length > 0],
    ['reviewed_at', (v) => typeof v === 'string' && v.length > 0],
    ['findings', assertFindingsClosed],
    ['accepted_deviations', (v) => Array.isArray(v) && (v as unknown[]).every((x) => typeof x === 'string')],
    ['project_manifest', assertPathDigestRefClosed],
    ['project_e2e_receipt', assertPathDigestRefClosed],
    ['stage_receipts', (v) => Array.isArray(v)],
    ['criteria_results', assertCriteriaResultsClosed],
  ];
  for (const [field, check] of required) {
    if (!check(p[field])) return false;
  }
  const stageReceipts = p['stage_receipts'] as Array<Record<string, unknown>>;
  if (stageReceipts.length === 0) return false;
  const stageIds = new Set<string>();
  for (const entry of stageReceipts) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    for (const key of Object.keys(entry)) {
      if (!new Set(['stage_id', 'stage_manifest', 'review', 'gate', 'snapshot']).has(key)) return false;
    }
    if (typeof entry['stage_id'] !== 'string' || entry['stage_id'].length === 0) return false;
    if (stageIds.has(entry['stage_id'])) return false;
    stageIds.add(entry['stage_id']);
    for (const nestedField of ['stage_manifest', 'review', 'gate']) {
      // vNext stage refs: 64-hex digests (computeDigest / envelope digest).
      if (!assertPathDigestRefClosed(entry[nestedField], SHA256_RE)) return false;
    }
    // vNext stage snapshot: 40-hex (snapshot_digest = git commit sha).
    if (typeof entry['snapshot'] !== 'string' || !GIT_SHA_RE.test(entry['snapshot'])) return false;
  }
  return true;
}

/**
 * Acceptance 门禁的绑定值（handler 从当前仓库状态派生；receipt payload 的
 * manifest/plan/proof_index/snapshot digest 必须与这些值一致）。
 */
interface AcceptanceBinding {
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly snapshotDigest: string;
  /** 每 slice 的 proof_index digest（computeDigest(slice.proof_index)）。 */
  readonly proofIndexDigest: (sliceId: string) => string;
}

/**
 * Acceptance A–E 完整门禁链（REF-S10-CUTOVER-RISK：删除仅在 A–E 全绿与
 * 明确切换 Gate 后执行；Brain 裁决 b1fa7d9a：切换 Gate = Stage Gate PASS +
 * Stage Review ACCEPTED；Project Acceptance 不作硬前置，PA receipt 已存在
 * 则验证其 stage 绑定 + verdict ACCEPTED，不存在则跳过）：
 *  - 每个 Slice：CV 链 tip 必须 CV_PASS、INTEGRATION 链 tip 必须
 *    INTEGRATION_PASS（链内存在 REPAIR/FAIL → tip 非 PASS → 拒绝）；
 *  - Stage Gate：stage-gate 链 tip 必须 GATE_PASS（存在 GATE_FAIL → tip
 *    FAIL → 拒绝）；
 *  - Stage Review：review 链 tip 必须 STAGE_REVIEW_PASS（verdict ACCEPTED；
 *    存在 REPAIR → tip 非 ACCEPTED → 拒绝）；
 *  - Receipt 真实性：digest-addressed + self-digest + 类别链 valid +
 *    outer 绑定（outer stage_id/slice_id 与 payload 声明一致）+
 *    action discriminator（INTEGRATION/GATE/STAGE_REVIEW 的 action 字段）+
 *    完整 payload 绑定（manifest/plan/proof_index/snapshot digest 与当前
 *    绑定值一致）；伪造/失配 → invalid（调用方 RECEIPT_INVALID 零删除）。
 */
function verifyAcceptanceFacts(
  root: string,
  stage: string,
  binding: AcceptanceBinding,
): {
  ok: true;
  slices: string[];
  stage_gate: 'PASS';
  stage_review: 'ACCEPTED';
  project_acceptance: { present: boolean; verdict: string };
} | { ok: false; missing: string[]; invalid: string[] } {
  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, defaultManifestPath(root, stage));
  } catch (error) {
    return { ok: false, missing: [`Manifest ${stage}: ${errorMessage(error)}`], invalid: [] };
  }
  const missing: string[] = [];
  const invalid: string[] = [];

  const bound = (payload: Record<string, unknown>, label: string, options?: { snapshotDescendantOk?: boolean }): boolean => {
    const checks: Array<[string, string]> = [
      ['manifest_digest', binding.manifestDigest],
      ['plan_digest', binding.planDigest],
    ];
    for (const [field, expected] of checks) {
      if (payload[field] !== expected) {
        invalid.push(`${label} ${field} binding mismatch`);
        return false;
      }
    }
    // snapshot 绑定（修复 3e410351）：CV/INTEGRATION 是 admission 时快照，
    // 必须严格等于 SPV snapshot；GATE/REVIEW 的 snapshot_digest 是执行时
    // Git HEAD——等于 SPV snapshot 或其合法 execution descendant（对齐
    // cv-admission snapshotOnAdmittedChain：git merge-base --is-ancestor）。
    const snapshot = payload['snapshot_digest'];
    if (snapshot !== binding.snapshotDigest) {
      if (options?.snapshotDescendantOk !== true || !snapshotOnAdmittedChain(root, snapshot, binding.snapshotDigest)) {
        invalid.push(`${label} snapshot_digest binding mismatch`);
        return false;
      }
    }
    return true;
  };

  /** 各类别 vNext closed payload 字段闭集（对齐 Runtime 各类别校验器：
   *  CV → validateVNextCvResultEnvelope；INTEGRATION/GATE/STAGE_REVIEW →
   *  vnext admission state 全字段；E2E → parseProjectE2EReceipt；
   *  PROJECT_REVIEW → project reviewReceipt 字段集）。未知字段一律拒绝。 */
  const CLOSED_FIELDS: Record<string, ReadonlySet<string>> = {
    CV_RESULT: new Set([
      'schema_version', 'type', 'stage_id', 'slice_id', 'worker_receipt_digest',
      'manifest_digest', 'plan_digest', 'proof_index_digest', 'context_ref',
      'context_digest', 'snapshot_digest', 'verification_type', 'verdict',
      'summary', 'acceptance_refs_checked', 'seam_refs_checked',
      'oracle_refs_checked', 'risk_refs_considered', 'failed_acceptance_refs',
      'invalid_tests', 'counterexamples', 'scope_violations',
      'forbidden_substitutions', 'regression_failures',
      'failed_criterion', 'failure_signature', 'required_recheck_scope',
      'previous_failure_signature', 'repair_diff_digest',
    ]),
    INTEGRATION_RESULT: new Set([
      'schema_version', 'type', 'action', 'stage_id', 'slice_id',
      'manifest_digest', 'plan_digest', 'proof_index_digest', 'snapshot_digest',
      'commit_sha', 'worker_receipt_digest', 'cv_receipt_digest',
      'slice_commit_receipt_digest', 'changed_files', 'receipt_chain_valid',
    ]),
    GATE_RESULT: new Set([
      'schema_version', 'type', 'action', 'stage_id', 'manifest_digest',
      'plan_digest', 'runtime_proof_digest', 'stage_plan_receipt_digest',
      'spv_receipt_digest', 'snapshot_digest', 'verdict', 'integrated_slices',
      'summary', 'receipt_chain_valid', 'restricted_bootstrap',
      // SG 双路径机制（2026-08-13 登记）：显式验证路径标记（可选；
      // `receipts` | `git_facts`，pre-decision Receipt 上缺失）——对齐
      // admit-pipeline VNEXT_GATE_FIELDS / review-admission
      // VNEXT_GATE_RECORD_FIELDS 的 closed 字段登记。
      'verification_source',
    ]),
    STAGE_REVIEW_RESULT: new Set([
      'schema_version', 'type', 'action', 'stage_id', 'manifest_digest',
      'plan_digest', 'runtime_proof_digest', 'stage_plan_receipt_digest',
      'spv_receipt_digest', 'stage_gate_receipt_digest', 'snapshot_digest',
      'verdict', 'summary', 'receipt_chain_valid',
    ]),
  };

  /** 各类别必填字段（vNext closed schema；schema_version/type 单独校验）。 */
  const REQUIRED_FIELDS: Record<string, readonly string[]> = {
    CV_RESULT: [
      'stage_id', 'slice_id', 'worker_receipt_digest', 'manifest_digest',
      'plan_digest', 'proof_index_digest', 'context_ref', 'context_digest',
      'snapshot_digest', 'verification_type', 'verdict', 'summary',
      'acceptance_refs_checked', 'seam_refs_checked', 'oracle_refs_checked',
      'risk_refs_considered',
    ],
    INTEGRATION_RESULT: [
      'action', 'stage_id', 'slice_id', 'manifest_digest', 'plan_digest',
      'proof_index_digest', 'snapshot_digest', 'commit_sha',
      'worker_receipt_digest', 'cv_receipt_digest', 'slice_commit_receipt_digest',
      'changed_files', 'receipt_chain_valid',
    ],
    GATE_RESULT: [
      'action', 'stage_id', 'manifest_digest', 'plan_digest',
      'stage_plan_receipt_digest', 'spv_receipt_digest',
      'snapshot_digest', 'verdict', 'integrated_slices', 'summary',
      'receipt_chain_valid',
    ],
    STAGE_REVIEW_RESULT: [
      'action', 'stage_id', 'manifest_digest', 'plan_digest',
      'stage_plan_receipt_digest', 'spv_receipt_digest',
      'stage_gate_receipt_digest', 'snapshot_digest', 'verdict', 'summary',
      'receipt_chain_valid',
    ],
  };

  /** 未知字段拒绝 + 全字段闭集校验（修复 1c3536bf：closed schema 真正生效）。 */
  const assertClosedPayload = (entry: VerifiedReceipt, label: string, expected: {
    type: string;
    action?: string;
    verdict?: string;
    commitSha?: boolean;
    requireStageSlice?: boolean;
    requireProofIndex?: boolean;
    sliceId?: string;
    snapshotDescendantOk?: boolean;
  }): boolean => {
    const p = entry.payload;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      invalid.push(`${label} payload is not an object`);
      return false;
    }
    if (p['schema_version'] !== 2) {
      invalid.push(`${label} schema_version must be 2`);
      return false;
    }
    if (p['type'] !== expected.type) {
      invalid.push(`${label} type discriminator mismatch`);
      return false;
    }
    // 未知字段拒绝：payload 键必须落在类别闭集内（修复 1c3536bf）。
    // CV_RESULT 已先经 Runtime validateVNextCvResultEnvelope（其 KNOWN
    // 字段集是唯一权威），本地闭集仅用于 required 检查，避免双源漂移。
    const closed = expected.type === 'CV_RESULT' ? undefined : CLOSED_FIELDS[expected.type];
    if (closed !== undefined) {
      for (const key of Object.keys(p)) {
        if (!closed.has(key)) {
          invalid.push(`${label} contains unknown field "${key}"`);
          return false;
        }
      }
      // 必需字段：类别闭集中必填项（schema_version/type 已校验；其余按
      // 类别 vNext closed schema 的必填集）。缺失 → 拒绝。
      const required = REQUIRED_FIELDS[expected.type];
      if (required !== undefined) {
        for (const field of required) {
          if (p[field] === undefined || p[field] === null || p[field] === '') {
            invalid.push(`${label} is missing required field "${field}"`);
            return false;
          }
        }
      }
    }
    // 类别嵌套/类型校验（修复 3e410351：必填/嵌套/未知字段缺口闭合）。
    if (expected.type === 'INTEGRATION_RESULT') {
      const changed = p['changed_files'];
      if (!Array.isArray(changed) || changed.length === 0 || changed.some((f) => typeof f !== 'string' || f.length === 0)) {
        invalid.push(`${label} changed_files must be a non-empty array of strings`);
        return false;
      }
      if (p['receipt_chain_valid'] !== true) {
        invalid.push(`${label} receipt_chain_valid must be true`);
        return false;
      }
    }
    if (expected.type === 'GATE_RESULT') {
      const slices = p['integrated_slices'];
      if (!Array.isArray(slices) || slices.length === 0) {
        invalid.push(`${label} integrated_slices must be a non-empty array`);
        return false;
      }
      for (let i = 0; i < slices.length; i++) {
        const item = slices[i] as Record<string, unknown>;
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          invalid.push(`${label} integrated_slices[${i}] must be an object`);
          return false;
        }
        const allowed = new Set(['slice_id', 'integration_receipt_digest', 'commit_sha']);
        for (const key of Object.keys(item)) {
          if (!allowed.has(key)) {
            invalid.push(`${label} integrated_slices[${i}] contains unknown field "${key}"`);
            return false;
          }
        }
        if (typeof item['slice_id'] !== 'string' || item['slice_id'].length === 0) {
          invalid.push(`${label} integrated_slices[${i}].slice_id is required`);
          return false;
        }
        if (typeof item['integration_receipt_digest'] !== 'string' || !SHA256_RE.test(item['integration_receipt_digest'] as string)) {
          invalid.push(`${label} integrated_slices[${i}].integration_receipt_digest is required`);
          return false;
        }
        if (typeof item['commit_sha'] !== 'string' || !GIT_SHA_RE.test(item['commit_sha'] as string)) {
          invalid.push(`${label} integrated_slices[${i}].commit_sha is required`);
          return false;
        }
      }
      for (const digestField of ['stage_plan_receipt_digest', 'spv_receipt_digest']) {
        const value = p[digestField];
        if (typeof value !== 'string' || !SHA256_RE.test(value)) {
          invalid.push(`${label} ${digestField} must be a 64-hex digest`);
          return false;
        }
      }
      // legacy field：仅旧归档 Gate Receipt 携带（Runtime Proof 已删除）；
      // 存在时仍须为合法 64-hex。
      if (p['runtime_proof_digest'] !== undefined &&
          (typeof p['runtime_proof_digest'] !== 'string' || !SHA256_RE.test(p['runtime_proof_digest'] as string))) {
        invalid.push(`${label} runtime_proof_digest must be a 64-hex digest when present (legacy field)`);
        return false;
      }
      if (typeof p['summary'] !== 'string' || p['summary'].length === 0) {
        invalid.push(`${label} summary must be a non-empty string`);
        return false;
      }
      if (p['receipt_chain_valid'] !== true) {
        invalid.push(`${label} receipt_chain_valid must be true`);
        return false;
      }
      // verification_source（SG 双路径机制，2026-08-13 登记）：可选字段；
      // 出现时须为 "receipts" 或 "git_facts"（git_facts = 兜底 Gate 标记），
      // 语义对齐 review-admission VNEXT_GATE_RECORD_FIELDS / admit-pipeline
      // VNEXT_GATE_FIELDS（未知值 fail-closed）。
      if (p['verification_source'] !== undefined &&
          p['verification_source'] !== 'receipts' &&
          p['verification_source'] !== 'git_facts') {
        invalid.push(`${label} verification_source must be "receipts" or "git_facts" when present`);
        return false;
      }
      // restricted_bootstrap（第 8 轮 f162a773）：Runtime gate-admission 规定
      // 该字段出现时只能为 true（admit-pipeline / proofloop-gate 同语义）；
      // 而受限 bootstrap 不是完整执行证明 —— cutover 完成门禁不接受
      // restricted_bootstrap Gate 授权删除（值非法与值合法都 fail closed）。
      const restrictedBootstrap = p['restricted_bootstrap'];
      if (restrictedBootstrap !== undefined) {
        if (restrictedBootstrap !== true) {
          invalid.push(`${label} restricted_bootstrap must be true when present`);
          return false;
        }
        invalid.push(`${label} restricted_bootstrap Gate cannot authorize cutover (restricted bootstrap is not a completion proof)`);
        return false;
      }
    }
    if (expected.type === 'STAGE_REVIEW_RESULT') {
      for (const digestField of ['stage_plan_receipt_digest', 'spv_receipt_digest', 'stage_gate_receipt_digest']) {
        const value = p[digestField];
        if (typeof value !== 'string' || !SHA256_RE.test(value)) {
          invalid.push(`${label} ${digestField} must be a 64-hex digest`);
          return false;
        }
      }
      // legacy field：仅旧归档 Review Receipt 携带（Runtime Proof 已删除）；
      // 存在时仍须为合法 64-hex。
      if (p['runtime_proof_digest'] !== undefined &&
          (typeof p['runtime_proof_digest'] !== 'string' || !SHA256_RE.test(p['runtime_proof_digest'] as string))) {
        invalid.push(`${label} runtime_proof_digest must be a 64-hex digest when present (legacy field)`);
        return false;
      }
      if (typeof p['summary'] !== 'string' || p['summary'].length === 0) {
        invalid.push(`${label} summary must be a non-empty string`);
        return false;
      }
      if (p['receipt_chain_valid'] !== true) {
        invalid.push(`${label} receipt_chain_valid must be true`);
        return false;
      }
      const verdict = p['verdict'];
      if (typeof verdict !== 'string' || !(['ACCEPTED', 'REPAIR', 'REJECTED', 'BLOCKED'] as readonly string[]).includes(verdict)) {
        invalid.push(`${label} verdict is outside the closed vocabulary`);
        return false;
      }
    }
    if (expected.action !== undefined && p['action'] !== expected.action) {
      invalid.push(`${label} action discriminator mismatch`);
      return false;
    }
    if (expected.verdict !== undefined && p['verdict'] !== expected.verdict) {
      invalid.push(`${label} verdict mismatch`);
      return false;
    }
    if (expected.commitSha === true) {
      const sha = p['commit_sha'];
      if (typeof sha !== 'string' || !GIT_SHA_RE.test(sha)) {
        invalid.push(`${label} commit_sha binding mismatch`);
        return false;
      }
    }
    if (expected.requireStageSlice === true) {
      if (p['stage_id'] !== stage) {
        invalid.push(`${label} payload stage binding mismatch`);
        return false;
      }
      if (expected.sliceId !== undefined && p['slice_id'] !== expected.sliceId) {
        invalid.push(`${label} payload slice binding mismatch`);
        return false;
      }
    }
    if (expected.requireProofIndex === true && p['proof_index_digest'] !== binding.proofIndexDigest(expected.sliceId ?? '')) {
      invalid.push(`${label} proof_index_digest binding mismatch`);
      return false;
    }
    return bound(p, label, { snapshotDescendantOk: expected.snapshotDescendantOk === true });
  };

  const expectSliceFacts = (sliceId: string): void => {
    // CV 链：链内每个 receipt 全量校验；tip 必须 CV_PASS。
    const cv = readVerifiedReceipts(root, cvReceiptDir(root, stage, sliceId), `CV chain ${sliceId}`);
    if (!cv.ok) { invalid.push(`${sliceId} CV: ${cv.error}`); return; }
    for (const entry of cv.receipts) {
      const label = `${sliceId} CV ${entry.type}`;
      if (entry.outerStageId !== stage || entry.outerSliceId !== sliceId) {
        invalid.push(`${label} outer binding mismatch`);
        return;
      }
      if (entry.type !== 'CV_PASS' && entry.type !== 'CV_REPAIR') {
        invalid.push(`${label} unknown CV receipt type`);
        return;
      }
      // 真实调用 Runtime 完整 closed schema 校验器（修复 1c3536bf：
      // 必需字段/分支字段/引用数组/未知字段全部由该校验器把关）。
      try {
        validateVNextCvResultEnvelope(entry.payload);
      } catch (error) {
        invalid.push(`${label} failed the vNext CV closed schema: ${errorMessage(error)}`);
        return;
      }
      if (!assertClosedPayload(entry, label, {
        type: 'CV_RESULT',
        requireStageSlice: true,
        sliceId,
        requireProofIndex: true,
      })) return;
      // CV_RESULT verdict 与 receipt type 一致（CV_PASS→PASS，CV_REPAIR→REPAIR）。
      const expectedVerdict = entry.type === 'CV_PASS' ? 'PASS' : 'REPAIR';
      if (entry.payload['verdict'] !== expectedVerdict) {
        invalid.push(`${label} verdict does not match receipt type`);
        return;
      }
    }
    if (cv.tip === null) { missing.push(`${sliceId} CV_PASS`); }
    else if (cv.tip.type !== 'CV_PASS') { invalid.push(`${sliceId} CV chain tip is ${cv.tip.type} (must be CV_PASS)`); }

    // INTEGRATION 链：链内每个 receipt 全量校验；tip 必须 INTEGRATION_PASS。
    const integration = readVerifiedReceipts(root, integrationReceiptDir(root, stage, sliceId), `Integration chain ${sliceId}`);
    if (!integration.ok) { invalid.push(`${sliceId} INTEGRATION: ${integration.error}`); return; }
    for (const entry of integration.receipts) {
      const label = `${sliceId} INTEGRATION ${entry.type}`;
      if (entry.outerStageId !== stage || entry.outerSliceId !== sliceId) {
        invalid.push(`${label} outer binding mismatch`);
        return;
      }
      if (entry.type !== 'INTEGRATION_PASS') {
        invalid.push(`${label} unknown INTEGRATION receipt type`);
        return;
      }
      if (!assertClosedPayload(entry, label, {
        type: 'INTEGRATION_RESULT',
        action: 'INTEGRATION',
        commitSha: true,
        requireStageSlice: true,
        sliceId,
        requireProofIndex: true,
      })) return;
    }
    if (integration.tip === null) { missing.push(`${sliceId} INTEGRATION_PASS(integrated)`); }
    else if (integration.tip.type !== 'INTEGRATION_PASS') { invalid.push(`${sliceId} INTEGRATION chain tip is ${integration.tip.type} (must be INTEGRATION_PASS)`); }
  };
  for (const slice of manifest.slices) {
    expectSliceFacts(slice.slice_id);
  }

  // Stage Gate：链内每个 receipt 全量校验；tip 必须 GATE_PASS。
  const gate = readVerifiedReceipts(root, stageGateReceiptDir(root, stage), 'stage-gate chain');
  if (!gate.ok) {
    invalid.push(`GATE: ${gate.error}`);
  } else if (gate.receipts.length > 0) {
    for (const entry of gate.receipts) {
      const label = `GATE ${entry.type}`;
      if (entry.outerStageId !== stage) {
        invalid.push(`${label} outer stage binding mismatch`);
        break;
      }
      if (entry.type !== 'GATE_PASS' && entry.type !== 'GATE_FAIL') {
        invalid.push(`${label} unknown GATE receipt type`);
        break;
      }
      const expectedVerdict = entry.type === 'GATE_PASS' ? 'PASS' : 'FAIL';
      if (!assertClosedPayload(entry, label, { type: 'GATE_RESULT', action: 'GATE', verdict: expectedVerdict, snapshotDescendantOk: true })) break;
    }
    if (gate.tip === null) { missing.push('GATE_PASS'); }
    else if (gate.tip.type !== 'GATE_PASS') { invalid.push(`stage-gate chain tip is ${gate.tip.type} (must be GATE_PASS)`); }
  } else {
    missing.push('GATE_PASS');
  }

  // Stage Review：链内每个 receipt 全量校验；tip 必须 STAGE_REVIEW_PASS。
  const review = readVerifiedReceipts(root, reviewReceiptDir(root, stage), 'review chain');
  if (!review.ok) {
    invalid.push(`REVIEW: ${review.error}`);
  } else if (review.receipts.length > 0) {
    for (const entry of review.receipts) {
      const label = `REVIEW ${entry.type}`;
      if (entry.outerStageId !== stage) {
        invalid.push(`${label} outer stage binding mismatch`);
        break;
      }
      if (entry.type !== 'STAGE_REVIEW_PASS' && entry.type !== 'STAGE_REVIEW_REPAIR') {
        invalid.push(`${label} unknown REVIEW receipt type`);
        break;
      }
      const expectedVerdict = entry.type === 'STAGE_REVIEW_PASS' ? 'ACCEPTED' : 'REPAIR';
      if (!assertClosedPayload(entry, label, { type: 'STAGE_REVIEW_RESULT', action: 'STAGE_REVIEW', verdict: expectedVerdict, snapshotDescendantOk: true })) break;
    }
    if (review.tip === null) { missing.push('STAGE_REVIEW_PASS(ACCEPTED)'); }
    else if (review.tip.type !== 'STAGE_REVIEW_PASS') { invalid.push(`review chain tip is ${review.tip.type} (must be STAGE_REVIEW_PASS)`); }
  } else {
    missing.push('STAGE_REVIEW_PASS(ACCEPTED)');
  }

  // Project Acceptance（Brain 裁决 2d1b3d3d：只认 PROJECT_REVIEW_PASS
  // （verdict PROJECT_ACCEPTED）为 PA；仅存在 PROJECT_E2E_* → 视为 PA 不
  // 存在（跳过）；PA receipt 存在则验证 stage 绑定 + verdict ACCEPTED）。
  let projectVerdict = 'not_present';
  const project = readVerifiedReceipts(root, projectReceiptDir(root), 'project chain');
  if (!project.ok) {
    invalid.push(`PROJECT: ${project.error}`);
  } else if (project.receipts.length > 0) {
    // 第 9 轮 repair（failure_signature -008）：project 类别闭集 + outer
    // project_id 绑定。真实 producer 的 envelope stage_id 恒等于
    // payload.project_id（E2E：runProjectAcceptanceE2E 写
    // stage_id=manifest.project_id；review：finalizeProjectReview 写
    // stage_id=manifest.project_id）——outer 与 payload 可分离即伪造。
    const PROJECT_RECEIPT_TYPES = new Set<string>([...PROJECT_E2E_TYPES, 'PROJECT_REVIEW_PASS']);
    for (const entry of project.receipts) {
      if (!PROJECT_RECEIPT_TYPES.has(entry.type)) {
        invalid.push(`PROJECT chain contains an unknown receipt type "${entry.type}"`);
        break;
      }
      const payload = entry.payload as Record<string, unknown>;
      const payloadProjectId = typeof payload['project_id'] === 'string' ? payload['project_id'] : undefined;
      if (entry.outerStageId !== payloadProjectId) {
        invalid.push(`${entry.type} outer project binding mismatch (outer stage_id must equal payload project_id)`);
        break;
      }
    }
    const reviewPassEntries = project.receipts.filter((entry) => entry.type === 'PROJECT_REVIEW_PASS');
    const e2eEntries = project.receipts.filter((entry) => PROJECT_E2E_TYPES.includes(entry.type));
    // E2E 全量校验（修复 06bfcc55：无论 PA 是否存在，E2E receipt 都是
    // project 链的组成部分——PA 存在时同样完整校验，不得借分支跳过；
    // 仅 E2E（无 PA）时 PA 视为不存在（Brain 裁决 2d1b3d3d 不作硬前置））。
    let e2eOk = true;
    for (const entry of e2eEntries) {
      let parsed: ProjectE2EReceipt;
      try {
        parsed = parseProjectE2EReceipt(entry.payload);
      } catch (error) {
        invalid.push(`PROJECT_E2E ${entry.type} failed the closed E2E schema: ${errorMessage(error)}`);
        e2eOk = false;
        break;
      }
      // 顶层/嵌套字段闭集（含 steps 每项与 service_cleanup 嵌套闭集）。
      if (!assertE2EClosedFields(entry.payload)) {
        invalid.push(`PROJECT_E2E ${entry.type} contains unknown fields`);
        e2eOk = false;
        break;
      }
      // 第 9 轮 repair：envelope type ↔ payload verdict 一致性（producer
      // PROJECT_E2E_TYPE_BY_VERDICT 唯一事实）——合法自摘要的
      // PROJECT_E2E_FAIL + payload verdict PASS 不得混入项目链。
      if (PROJECT_E2E_TYPE_BY_VERDICT[parsed.verdict] !== entry.type) {
        invalid.push(`PROJECT_E2E envelope type "${entry.type}" does not match payload verdict "${parsed.verdict}"`);
        e2eOk = false;
        break;
      }
      // 第 9 轮 repair：非法 E2E 链结构拒绝——真实 producer 的 E2E receipt
      // 恒为 genesis（writeReceipt 从不写 previous_digest）；E2E 带前驱
      // （无论指向 review 还是另一 E2E）均为伪造链结构。
      if (entry.previousDigest !== undefined) {
        invalid.push(`PROJECT_E2E ${entry.type} must be a genesis Receipt (real producer never chains PROJECT_E2E_*)`);
        e2eOk = false;
        break;
      }
    }
    if (!e2eOk) return { ok: false, missing, invalid };
    if (e2eEntries.length === project.receipts.length) {
      // 仅 E2E（无 PA）→ 跳过（PA 不作硬前置）。
      projectVerdict = 'not_present';
    } else if (reviewPassEntries.length === 0) {
      invalid.push('project chain has no PROJECT_REVIEW_PASS');
    } else {
      // 第 9 轮 repair：PROJECT_REVIEW_PASS.previous_digest 必须指向同一
      // project receipt category 中的 PROJECT_E2E_*（真实
      // finalizeProjectReview 恒以 E2E gate receipt envelope digest 为前驱
      // 写链）；独立伪造的 review 根 Receipt 拒绝。
      const e2eDigests = new Set(e2eEntries.map((e) => e.digest));
      for (const entry of reviewPassEntries) {
        const p = entry.payload as Record<string, unknown>;
        if (!assertProjectReviewClosed(p)) {
          invalid.push('PROJECT_REVIEW_PASS failed the closed PROJECT_REVIEW schema');
          break;
        }
        if (p['verdict'] !== 'PROJECT_ACCEPTED') {
          invalid.push('PROJECT_REVIEW_PASS verdict must be PROJECT_ACCEPTED');
          break;
        }
        const stageReceipts = p['stage_receipts'];
        const stageBound = Array.isArray(stageReceipts) && (stageReceipts as Array<Record<string, unknown>>).some((s) => s['stage_id'] === stage);
        if (!stageBound) {
          invalid.push('PROJECT_REVIEW_PASS stage binding mismatch (stage_receipts lacks the target stage)');
          break;
        }
        if (entry.previousDigest === undefined || !e2eDigests.has(entry.previousDigest)) {
          invalid.push('PROJECT_REVIEW_PASS previous_digest must chain to a PROJECT_E2E_* Receipt in the same project category');
          break;
        }
      }
      projectVerdict = 'PROJECT_ACCEPTED';
    }
  }

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };
  return {
    ok: true,
    slices: manifest.slices.map((s) => s.slice_id),
    stage_gate: 'PASS',
    stage_review: 'ACCEPTED',
    project_acceptance: { present: projectVerdict === 'PROJECT_ACCEPTED', verdict: projectVerdict },
  };
}

/** 原子预检：全部目标 root-bound、非 symlink、普通文件、可删。任一失败 → 零删除。 */
function preflightTargets(
  root: string,
  command: CliCommand,
  deleteList: readonly string[],
): { ok: true; targets: string[] } | { ok: false; envelope: CliEnvelope } {
  const findings: CliFinding[] = [];
  const targets: string[] = [];
  for (const entry of deleteList) {
    if (!isRootBoundRelative(root, entry)) {
      findings.push({ code: 'CUTOVER.PATH_ESCAPE', message: `delete_list entry is not root-bound (refusing): "${entry}"` });
      continue;
    }
    // 先对 lexical 路径（root 内相对路径 resolve，不 follow symlink）做
    // lstat：symlink 一律拒绝（修复 2d1b3d3d —— canonicalize 后当普通
    // 文件会放行指向非 legacy 文件的 symlink）。lexical === canonical
    // 由 root-bound 相对路径保证（walkComponents 会 realpath 每个组件，
    // 所以 lexical 本身就是非 symlink 的规范路径）。
    const lexical = path.resolve(root, entry);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(lexical);
    } catch (error) {
      findings.push({
        code: 'CUTOVER.PRECONDITION_FAILED',
        message: `delete target does not exist (refusing): "${entry}" (${errorMessage(error)})`,
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      findings.push({
        code: 'CUTOVER.DELETE_TARGET_INVALID',
        message: `delete target is a symbolic link (refusing): "${entry}"`,
      });
      continue;
    }
    if (!stat.isFile()) {
      findings.push({
        code: 'CUTOVER.PRECONDITION_FAILED',
        message: `delete target is not a regular file (refusing): "${entry}"`,
      });
      continue;
    }
    targets.push(lexical);
  }
  if (findings.length > 0) {
    return {
      ok: false,
      envelope: {
        ...errorEnvelope(command, 'CUTOVER.PRECONDITION_FAILED', 'cutover execute refused: delete_list preflight failed (zero deletions)'),
        findings,
        // 失败结果也携带已删/未删明细（此处预检失败 → 零删除）。
        result: { deleted: [], pending: [...deleteList], failed: true },
      } as CliEnvelope,
    };
  }
  return { ok: true, targets };
}

function runCutoverExecute(
  root: string,
  command: CliCommand,
  request: StageCliRequestInput,
): CliEnvelope {
  // 1. confirmed + delete_list 基本校验（irreversible 确认）。
  const validated = validateExecuteRequest(command, request);
  if (!validated.ok) return validated.envelope;

  // 2. canonical stage（Acceptance 事实目标）。
  const raw = request as unknown as CutoverExecuteRequest;
  let stage: string;
  try {
    stage = assertCanonicalStageId(raw.stage ?? request.stage, 'stage');
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `cutover execute requires a canonical request field "stage": ${errorMessage(error)}`,
    );
  }

  // 3. Acceptance A–E 完整门禁链（REF-S10-CUTOVER-RISK：A–E 全绿 + 明确
  //    切换 Gate（Stage Gate PASS + Stage Review ACCEPTED）后才执行；
  //    Brain 裁决 b1fa7d9a：Project Acceptance 不作硬前置，PA receipt 已
  //    存在则验证 stage 绑定 + verdict ACCEPTED，不存在则跳过）。
  let binding: AcceptanceBinding;
  try {
    const manifest = readVNextManifest(root, defaultManifestPath(root, stage));
    const authority = readVNextAdmissionAuthority(root, stage);
    const manifestDigest = computeDigest(manifest);
    const planDigest = manifest.plan.plan_digest;
    // authority 绑定校验（修复 2d1b3d3d）：authority 的 stage_id/manifest/
    // plan/snapshot/SPV digest 必须与当前 Manifest/Plan/snapshot 一致；
    // 不一致 → fail closed 零删除（陈旧 authority 不得授权不可逆删除）。
    const spv = authority.spv;
    const stagePlan = authority.stagePlan;
    if (spv.stage_id !== stage || stagePlan.stage_id !== stage) {
      throw new Error('admission authority stage_id does not match the target stage');
    }
    if (spv.manifest_digest !== manifestDigest || stagePlan.manifest_digest !== manifestDigest) {
      throw new Error('admission authority manifest_digest does not match the current Manifest');
    }
    if (spv.plan_digest !== planDigest || stagePlan.plan_digest !== planDigest) {
      throw new Error('admission authority plan_digest does not match the current Plan');
    }
    if (spv.snapshot_digest !== stagePlan.snapshot_digest) {
      throw new Error('admission authority SPV/StagePlan snapshot_digest mismatch');
    }
    // SPV 交叉绑定（修复 1c3536bf）：StagePlan 必须显式绑定其 SPV digest。
    if (stagePlan.spv_receipt_digest !== spv.digest) {
      throw new Error('admission authority StagePlan spv_receipt_digest does not bind the SPV digest');
    }
    const proofIndexDigestBySlice = new Map<string, string>();
    for (const slice of manifest.slices) {
      proofIndexDigestBySlice.set(slice.slice_id, computeDigest(slice.proof_index));
    }
    binding = {
      manifestDigest,
      planDigest,
      snapshotDigest: spv.snapshot_digest,
      proofIndexDigest: (sliceId: string) => {
        const digest = proofIndexDigestBySlice.get(sliceId);
        if (digest === undefined) throw new Error(`unknown slice "${sliceId}"`);
        return digest;
      },
    };
  } catch (error) {
    return errorEnvelope(
      command,
      'CUTOVER.ACCEPTANCE_BINDING_UNAVAILABLE',
      `cutover execute refused: cannot derive or verify the Acceptance binding values for stage "${stage}" (${errorMessage(error)})`,
    );
  }
  const acceptance = verifyAcceptanceFacts(root, stage, binding);
  if (!acceptance.ok) {
    if (acceptance.invalid.length > 0) {
      return errorEnvelope(
        command,
        'CUTOVER.RECEIPT_INVALID',
        `cutover execute refused: Acceptance A-E receipt facts are invalid or forged for stage "${stage}" (${acceptance.invalid.join('; ')})`,
      );
    }
    return errorEnvelope(
      command,
      'CUTOVER.ACCEPTANCE_GATE_REQUIRED',
      `cutover execute refused: Acceptance A-E facts incomplete for stage "${stage}" (missing: ${acceptance.missing.join(', ')})`,
    );
  }

  // 4. 精确删除清单绑定：delete_list 必须与 status 检测出的 legacy 删除
  //    目标完全一致（不允许任意 root-bound 文件）。
  const detected = detectLegacyDeleteTargets(root);
  const requested = [...validated.deleteList].sort();
  if (requested.length !== detected.length || requested.some((entry, i) => entry !== detected[i])) {
    return errorEnvelope(
      command,
      'CUTOVER.DELETE_LIST_MISMATCH',
      `cutover execute refused: delete_list must exactly match the detected legacy delete targets (detected: ${JSON.stringify(detected)})`,
    );
  }

  // 5. 原子预检（存在性、普通文件、root-bound、可删）通过后才删除。
  const preflight = preflightTargets(root, command, validated.deleteList);
  if (!preflight.ok) return preflight.envelope;

  // 6. 删除循环：失败 → 停止并报告已删/未删明细。
  const deleted: string[] = [];
  const pending: string[] = [];
  let failed = false;
  for (const target of preflight.targets) {
    const relative = path.relative(root, target);
    try {
      fs.unlinkSync(target);
      deleted.push(relative.split(path.sep).join('/'));
    } catch (error) {
      failed = true;
      pending.push(...preflight.targets.slice(deleted.length).map((t) => path.relative(root, t).split(path.sep).join('/')));
      return {
        ...errorEnvelope(
          command,
          'CUTOVER.DELETE_FAILED',
          `cutover execute failed after partial deletion: deleted=${JSON.stringify(deleted)} pending=${JSON.stringify(pending)} (${errorMessage(error)})`,
        ),
        result: { deleted, pending, failed: true },
      } as CliEnvelope;
    }
  }
  void failed;
  return okEnvelope(command, {
    schema_version: 2,
    stage,
    acceptance_facts: {
      verified: true,
      slices: acceptance.slices,
      stage_gate: acceptance.stage_gate,
      stage_review: acceptance.stage_review,
      project_acceptance: acceptance.project_acceptance,
    },
    delete_list_matched: true,
    confirmed: true,
    deleted,
    pending,
    note: 'irreversible cutover executed for the confirmed and status-matched delete_list (Acceptance A-E + Stage Gate PASS + Stage Review ACCEPTED verified; Project Acceptance verified when present, never a hard gate)',
    findings: [],
  });
}

// ============================================================
// Dispatcher
// ============================================================

/**
 * Run one cutover-domain operation and return its canonical envelope。
 * status 只读；execute 带 irreversible 保护（confirmed + Acceptance A–E
 * 门禁 + 精确清单绑定 + 原子预检）。所有失败均为 structured finding
 * （exit 2）。
 */
export function runCutoverDomain(
  root: string,
  command: CliCommand,
  request: StageCliRequestInput,
): CliEnvelope {
  switch (command.operation) {
    case 'status':
      return runCutoverStatus(root, command);
    case 'execute':
      return runCutoverExecute(root, command, request);
    default:
      return errorEnvelope(
        command,
        'RUNTIME.NOT_IMPLEMENTED',
        `operation "cutover ${String(command.operation)}" is a closed command without a handler yet`,
      );
  }
}

// ============================================================
// Handler-direct argv entry（canonical root assertion + unified request）
// ============================================================

/**
 * Handler-direct entry for the cutover domain: parses the closed flag set,
 * asserts the canonical trust root, resolves the unified closed request input
 * (cutover 域字段已登记于 proofloop-common.ts) and dispatches
 * `runCutoverDomain`.  Success paths are exercised through the built public
 * `proofloop cutover …` dispatcher; this entry stays the handler-direct seam
 * for boundary cases (缺参、root escape、非 cutover route)。
 */
export async function runCutoverFromArgv(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<CliEnvelope> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const command: CliCommand = {
    domain: argv[0] ?? 'cutover',
    operation: argv[1] ?? null,
  };
  if (command.domain !== 'cutover') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `unknown domain "${command.domain}" (cutover entry)`,
    );
  }
  if (command.operation === null) {
    return errorEnvelope(
      command,
      'USAGE',
      'usage: proofloop cutover <status|execute> [flags] — missing <operation> for domain "cutover"',
    );
  }
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv.slice(2));
  } catch (error) {
    return errorEnvelope(
      command,
      'USAGE',
      `usage: proofloop cutover <operation> [flags] — ${errorMessage(error)}`,
    );
  }
  if (parsed.help) {
    return okEnvelope(command, {
      usage: 'proofloop cutover <status|execute> [flags]',
    });
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
  return runCutoverDomain(root, command, requestValidation.request);
}

if (require.main === module) {
  runCutoverFromArgv(process.argv.slice(2)).then((envelope) => {
    emitEnvelope(envelope);
    // USAGE → exit 1（与 dist callability 矩阵一致）；structured blocked → exit 2。
    const code = envelope.ok ? 0 : envelope.findings[0]?.code === 'USAGE' ? 1 : 2;
    process.exitCode = code;
  });
}
