/**
 * proofloop-recovery.ts — S10-D-T03: recovery 域 handler。
 *
 * Contract（tech-spec §0.1/§0.2/§0.3/§5.2，Acceptance D+E，Seam §0.1/§0.2，
 * Oracle，REF-S08E-RISK persistent_state/concurrency）：
 *  - closed operation set：`recovery check` | `recovery preflight` |
 *    `recovery restart` | `recovery doctor`；
 *  - `check`：只读恢复状态报告 —— Manifest 可读性/digest 绑定、evidence
 *    目录 refresh journal 存在性（evidence-refresh 恢复语义，只读探测）、
 *    receipts 类别存在性、next 投影状态（persistContext:false 零写入）；
 *    状态层全部报告（exit 0），参数/Manifest 层失败 fail closed（exit 2）；
 *  - `preflight`：恢复前只读预检 —— Manifest、admission authority
 *    （Stage Plan + SPV）、next 投影前置条件；ready:true exit 0，任一失败
 *    canonical Finding + no-write exit 2；
 *  - `restart`：复用 vNext restart/recovery seam（VNextNextActionService.
 *    nextAction, persistContext:true）—— 只从本地持久事实（Git/Manifest/
 *    Receipts）重新投影派发状态，不重放 Worker 实现；成功时 Context 由
 *    Runtime next seam（persistVNextWorkerContext）落盘，handler 不直接写
 *    `.proofloop/*`；VALIDATE/异常 → canonical Finding + 零写入（exit 2）；
 *  - `doctor`：复用 doctor 域能力转发（runDoctor）—— S10 运行证明第 8 步
 *    `recovery doctor --json --stage S10` 必须 exit 0；
 *  - 未知操作 fail closed（RUNTIME.NOT_IMPLEMENTED，exit 2）。
 *
 * 本 handler 不直接写 `.proofloop/*`；restart 的 Context 落盘是 Runtime next
 * seam 的 owner 行为（与 stage admit-* 由 admission seam 写 Receipt 同一先例）。
 * `proofloop <domain> <operation>` dispatcher wiring（proofloop.ts）与
 * recovery 域 closed request 字段登记（proofloop-common.ts）按 S10-C/S10-D
 * 先例由 Runtime direct-fix 完成；本文件交付 handler + handler-direct argv
 * 直通入口（`dist/cli/proofloop-recovery.js`，与 review/project 域同构）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest } from '@proofloop/kernel';
import type { VNextManifest } from '@proofloop/kernel';
import { readVNextAdmissionAuthority, readVNextManifest } from '../vnext';
import { VNextNextActionService } from '../vnext/next';
import type { VNextNextActionOutput } from '../vnext/next';
import { REFRESH_JOURNAL_FILE } from '../vnext/evidence-refresh';
import { assertCanonicalStageId } from '../vnext/stage-id';
import { defaultManifestPath } from '../manifest-source';
import {
  errorEnvelope,
  failureEnvelope,
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
import { runDoctor } from './proofloop-doctor';

// ============================================================
// Bounded operation parameters（unified request contract）
// ============================================================

export interface RecoveryOperationParams {
  /** 目标 canonical Stage ID（^S\d+$；check/preflight/restart 必选）。 */
  readonly stage: string | undefined;
}

/**
 * Merge the closed request input into bounded recovery params。stage 来自
 * `--stage` flag 或 request `stage` 字段（一致性由 resolveRequestInput 保证）。
 */
export function collectRecoveryParams(
  parsed: ParsedCliArgs,
  request: StageCliRequestInput,
): RecoveryOperationParams {
  return { stage: parsed.stage ?? request.stage };
}

// ============================================================
// Helpers
// ============================================================

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnvelope(value: unknown): value is CliEnvelope {
  return typeof value === 'object' && value !== null && 'findings' in value;
}

/** canonical Stage ID 校验（^S\d+$；legacy parked label 如 S08B0 fail closed）。 */
function requireCanonicalStage(
  command: CliCommand,
  stage: string | undefined,
): CliEnvelope | string {
  if (stage === undefined) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      'recovery operation requires the request field "stage" (canonical Stage ID, e.g. S10)',
    );
  }
  try {
    return assertCanonicalStageId(stage, 'stage');
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `recovery stage is not a canonical Stage ID: ${errorMessage(error)}`,
    );
  }
}

/** Manifest 的每个 Slice evidence 目录中 refresh journal 存在性（只读探测，不解析）。 */
function scanRefreshJournals(root: string, manifest: VNextManifest): {
  present: boolean;
  evidence_paths: readonly string[];
} {
  const paths: string[] = [];
  for (const slice of manifest.slices) {
    const journalPath = path.join(root, path.dirname(slice.evidence_path), REFRESH_JOURNAL_FILE);
    try {
      if (fs.statSync(journalPath).isFile()) paths.push(slice.evidence_path);
    } catch {
      // absent —— 正常状态，无未恢复 transaction。
    }
  }
  return { present: paths.length > 0, evidence_paths: paths };
}

const RECOVERY_RECEIPT_CATEGORIES = [
  'plan',
  'tasks',
  'cv',
  'committer',
  'integration',
  'stage-gate',
  'review',
] as const;

/** 该 stage 的 receipts 类别目录存在性（只读降级探测）。 */
function probeReceiptDirectories(root: string, stageId: string): Record<string, { present: boolean }> {
  const out: Record<string, { present: boolean }> = {};
  for (const category of RECOVERY_RECEIPT_CATEGORIES) {
    const dir = path.join(root, '.proofloop', 'receipts', category, stageId);
    try {
      out[category] = { present: fs.statSync(dir).isDirectory() };
    } catch {
      out[category] = { present: false };
    }
  }
  return out;
}

const vNextNextActionService = new VNextNextActionService();

/** next 投影（persistContext:false —— 只读，零写入）。 */
function projectNext(
  root: string,
  stage: string,
  manifestPath: string,
): Record<string, unknown> {
  const out = vNextNextActionService.nextAction({
    projectRoot: root,
    stageId: stage,
    manifestPath,
    persistContext: false,
  });
  return {
    ok: true,
    action: out.action,
    action_detail: out.action_detail,
    responsible_role: out.responsible_role,
    receipt_chain_valid: out.receipt_chain_valid,
    slice_id: out.slice_id ?? null,
    task_id: out.task_id ?? null,
    mode: out.mode ?? null,
    context_ref: out.context_ref ?? null,
    manifest_digest: out.manifest_digest ?? null,
    plan_digest: out.plan_digest ?? null,
    snapshot_digest: out.snapshot_digest ?? null,
  };
}

// ============================================================
// check（只读恢复状态报告）
// ============================================================

function runRecoveryCheck(root: string, command: CliCommand, stage: string): CliEnvelope {
  const manifestPath = defaultManifestPath(root, stage);
  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    return errorEnvelope(
      command,
      'RECOVERY.MANIFEST_UNAVAILABLE',
      `recovery check cannot read the Manifest for stage "${stage}": ${errorMessage(error)}`,
    );
  }
  if (manifest.stage_id !== stage) {
    return errorEnvelope(
      command,
      'RECOVERY.MANIFEST_UNAVAILABLE',
      `Manifest stage_id "${manifest.stage_id}" does not match "${stage}"`,
    );
  }

  const journal = scanRefreshJournals(root, manifest);
  let nextProjection: Record<string, unknown>;
  try {
    nextProjection = projectNext(root, stage, manifestPath);
  } catch (error) {
    nextProjection = { ok: false, error: errorMessage(error) };
  }

  return okEnvelope(command, {
    schema_version: 2,
    stage_id: stage,
    manifest: {
      readable: true,
      ref: manifest.plan.ref,
      manifest_digest: computeDigest(manifest),
      plan_digest: manifest.plan.plan_digest,
    },
    refresh_journal: journal,
    receipts: probeReceiptDirectories(root, stage),
    next_projection: nextProjection,
    recoverable: nextProjection.ok === true && nextProjection.action !== 'VALIDATE',
    findings: [],
  });
}

// ============================================================
// preflight（恢复前只读预检）
// ============================================================

function runRecoveryPreflight(root: string, command: CliCommand, stage: string): CliEnvelope {
  const findings: CliFinding[] = [];
  const manifestPath = defaultManifestPath(root, stage);
  let manifest: VNextManifest | null = null;
  try {
    manifest = readVNextManifest(root, manifestPath);
    if (manifest.stage_id !== stage) {
      findings.push({
        code: 'RECOVERY.MANIFEST_UNAVAILABLE',
        message: `Manifest stage_id "${manifest.stage_id}" does not match "${stage}"`,
      });
      manifest = null;
    }
  } catch (error) {
    findings.push({
      code: 'RECOVERY.MANIFEST_UNAVAILABLE',
      message: `recovery preflight cannot read the Manifest for stage "${stage}": ${errorMessage(error)}`,
    });
  }

  // admission authority（Stage Plan + SPV）是重启恢复的持久事实基座。
  try {
    readVNextAdmissionAuthority(root, stage);
  } catch (error) {
    findings.push({
      code: 'RECOVERY.AUTHORITY_UNAVAILABLE',
      message: `recovery preflight cannot read the admission authority (Stage Plan + SPV) for stage "${stage}": ${errorMessage(error)}`,
    });
  }

  let nextProjection: Record<string, unknown>;
  try {
    nextProjection = projectNext(root, stage, manifestPath);
    if (nextProjection.action === 'VALIDATE') {
      findings.push({
        code: 'RECOVERY.NOT_RECOVERABLE',
        message: `recovery preflight next projection requires VALIDATE: ${String(nextProjection.action_detail)}`,
      });
    }
  } catch (error) {
    nextProjection = { ok: false, error: errorMessage(error) };
    findings.push({
      code: 'RECOVERY.NOT_RECOVERABLE',
      message: `recovery preflight next projection failed: ${errorMessage(error)}`,
    });
  }

  const journal =
    manifest === null
      ? { present: false, evidence_paths: [] as readonly string[] }
      : scanRefreshJournals(root, manifest);

  if (findings.length > 0) {
    return failureEnvelope(command, findings);
  }

  return okEnvelope(command, {
    schema_version: 2,
    stage_id: stage,
    ready: true,
    manifest: {
      readable: true,
      ref: (manifest as VNextManifest).plan.ref,
      manifest_digest: computeDigest(manifest as VNextManifest),
      plan_digest: (manifest as VNextManifest).plan.plan_digest,
    },
    refresh_journal: journal,
    next_projection: nextProjection,
    findings: [],
  });
}

// ============================================================
// restart（复用 vNext restart/recovery seam，从持久事实恢复派发状态）
// ============================================================

function runRecoveryRestart(root: string, command: CliCommand, stage: string): CliEnvelope {
  const manifestPath = defaultManifestPath(root, stage);
  let out: VNextNextActionOutput;
  try {
    // persistContext:true —— 与 restart fixture（S08-C-T04 / S08-E-T07）同一
    // 语义：fresh next 投影只从 Git/Manifest/Receipts 恢复；成功时 Context 由
    // Runtime next seam 落盘；失败路径（VALIDATE/异常）在写入前 fail closed。
    out = vNextNextActionService.nextAction({
      projectRoot: root,
      stageId: stage,
      manifestPath,
      persistContext: true,
    });
  } catch (error) {
    return errorEnvelope(
      command,
      'RECOVERY.RESTART_FAILED',
      `recovery restart could not re-project the dispatch from persisted facts: ${errorMessage(error)}`,
    );
  }
  if (out.action === 'VALIDATE') {
    return errorEnvelope(
      command,
      'RECOVERY.VALIDATE_REQUIRED',
      `recovery restart cannot recover before the Stage Plan admission: ${out.action_detail}`,
    );
  }
  return okEnvelope(command, {
    schema_version: 2,
    stage_id: stage,
    action: out.action,
    action_detail: out.action_detail,
    responsible_role: out.responsible_role,
    receipt_chain_valid: out.receipt_chain_valid,
    slice_id: out.slice_id ?? null,
    task_id: out.task_id ?? null,
    mode: out.mode ?? null,
    context_ref: out.context_ref ?? null,
    manifest_digest: out.manifest_digest ?? null,
    plan_digest: out.plan_digest ?? null,
    proof_index_digest: out.proof_index_digest ?? null,
    snapshot_digest: out.snapshot_digest ?? null,
    findings: [],
  });
}

// ============================================================
// doctor（复用 doctor 域能力转发）
// ============================================================

function runRecoveryDoctor(
  root: string,
  rootSource: 'explicit' | 'auto',
  command: CliCommand,
): CliEnvelope {
  // 转发 doctor 域能力（runDoctor）：S10 运行证明第 8 步
  // `recovery doctor --json --stage S10` 必须 exit 0。
  return runDoctor(root, rootSource, command);
}

// ============================================================
// Dispatcher
// ============================================================

/**
 * Run one recovery-domain operation and return its canonical envelope。
 * check/preflight/restart 需要 canonical `stage`；doctor 转发 doctor 域。
 * 所有失败均为 structured finding（exit 2, no-write）。
 */
export function runRecoveryDomain(
  root: string,
  rootSource: 'explicit' | 'auto',
  command: CliCommand,
  params: RecoveryOperationParams,
): CliEnvelope {
  switch (command.operation) {
    case 'check': {
      const stage = requireCanonicalStage(command, params.stage);
      if (isEnvelope(stage)) return stage;
      return runRecoveryCheck(root, command, stage);
    }
    case 'preflight': {
      const stage = requireCanonicalStage(command, params.stage);
      if (isEnvelope(stage)) return stage;
      return runRecoveryPreflight(root, command, stage);
    }
    case 'restart': {
      const stage = requireCanonicalStage(command, params.stage);
      if (isEnvelope(stage)) return stage;
      return runRecoveryRestart(root, command, stage);
    }
    case 'doctor':
      return runRecoveryDoctor(root, rootSource, command);
    default:
      // The dispatcher registry is the closed authority; this branch is a
      // defensive guard for future registry extensions without a handler.
      return errorEnvelope(
        command,
        'RUNTIME.NOT_IMPLEMENTED',
        `operation "recovery ${String(command.operation)}" is a closed command without a handler yet`,
      );
  }
}

// ============================================================
// Handler-direct argv entry（canonical root assertion + unified request）
// ============================================================

/**
 * Handler-direct entry for the recovery domain: parses the closed flag set,
 * asserts the canonical trust root, resolves the unified request input and
 * dispatches `runRecoveryDomain`.  Success paths must be exercised through the
 * built public `proofloop <domain> <operation>` dispatcher（S10-C 教训）; this
 * entry stays the seam for failure/boundary cases（缺参、非法 stage、root
 * escape、非 recovery route）。
 */
export async function runRecoveryFromArgv(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<CliEnvelope> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const command: CliCommand = {
    domain: argv[0] ?? 'recovery',
    operation: argv[1] ?? null,
  };
  if (command.domain !== 'recovery') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `unknown domain "${command.domain}" (recovery entry)`,
    );
  }
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv.slice(2));
  } catch (error) {
    return errorEnvelope(
      command,
      'USAGE',
      `usage: proofloop recovery <operation> [flags] — ${errorMessage(error)}`,
    );
  }
  if (parsed.help) {
    return okEnvelope(command, {
      usage: 'proofloop recovery <check|preflight|restart|doctor> [flags]',
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
  return runRecoveryDomain(root, 'auto', command, collectRecoveryParams(parsed, requestValidation.request));
}

if (require.main === module) {
  runRecoveryFromArgv(process.argv.slice(2)).then((envelope) => {
    process.exitCode = envelope.ok ? 0 : 2;
  });
}
