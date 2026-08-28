/**
 * proofloop-context.ts — S10-B-T02: context 域 handler。
 *
 * Closed operation set（S10-B-T02）：
 *  - `context prepare` → 按角色投影 digest-bound Context（角色闭集：
 *    planning/spv/worker/cv/stage-reviewer/project-reviewer）。
 *    worker 角色复用 `projectVNextWorkerDispatch` + `persistVNextWorkerContext`
 *    （与 next 派发同一投影规则、同一 Runtime 写 seam，可校验一致）；
 *    其余角色走 `projectVNextRoleContext` 只读投影（ref+digest，不落盘）。
 *  - `context show` → 只读显示已投影 Context（--ref 读回模式 + role 匹配，
 *    拒绝跨角色复用；或按 role/stage/slice/task 重新投影）。cv 角色的
 *    Evidence read gate 需要绑定同一 tuple 的 refutation observation 才
 *    满足（`verifyVNextRefutationObservationBinding`）。
 *  - `context admit-refutation-observation` → 投影 digest-bound
 *    REFUTATION_OBSERVATION 记录（initial CV 读 Evidence 前的反驳观察）。
 *
 * 所有操作消费 unified request contract（domain/operation + bounded params
 * 或 flags）并输出 canonical envelope。unknown role / 缺 stage / 无效 ref /
 * observation 缺失在任何写入前 fail closed。本 handler 不直接写
 * `.proofloop/context`：唯一写路径是 Runtime seam
 * `persistVNextWorkerContext`（worker prepare）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest, validateReceipt, verifyReceiptDigest } from '@proofloop/kernel';
import {
  VNEXT_CONTEXT_ROLES,
  assertVNextManifestReferenceBindings,
  isVNextContextRole,
  persistVNextRefutationObservation,
  persistVNextRoleContext,
  persistVNextWorkerContext,
  projectVNextRefutationObservation,
  projectVNextRoleContext,
  projectVNextWorkerDispatch,
  readVNextManifest,
  verifyVNextRefutationObservationBinding,
  VNextHandoffError,
} from '../vnext';
import type {
  VNextAdmissionAuthority,
  VNextRefutationObservation,
  VNextRoleContext,
  VNextWorkerContext,
  VNextWorkerDispatch,
} from '../vnext';
import { verifyVNextWorkerContextBindings } from '../vnext/dispatch';
import {
  deriveHistoricalInvalidatedBindings,
  loadAncestorReplanDispositionRecords,
  readCurrentEpoch,
} from '../vnext/replan-epoch';
import {
  assertClosedVNextCvPayload,
  assertVNextCvChainSequence,
  assertVNextCvReceiptTypeVerdict,
} from '../vnext/cv-validation';
import type { VNextCvPayloadBinding } from '../vnext/cv-validation';
import { deriveVNextWorkerDispatchForStage } from '../vnext/next';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import {
  errorEnvelope,
  okEnvelope,
  okEnvelopeWithRefs,
  parseCliArgs,
  resolveRequestInput,
  resolveTrustRoot,
  type CliCommand,
  type CliEnvelope,
  type CliRequestInput,
  type ParsedCliArgs,
} from './proofloop-common';

// ============================================================
// Bounded operation parameters（unified request contract + flags）
// ============================================================

export interface ContextOperationParams {
  /** Target canonical Stage ID（`^S\d+$`）。 */
  readonly stage?: string;
  /** Closed Context role (planning|spv|worker|cv|stage-reviewer|project-reviewer). */
  readonly role?: string;
  /** Slice binding（Manifest-declared）。 */
  readonly slice?: string;
  /** Task binding（属于 slice）。 */
  readonly task?: string;
  /** admit-refutation-observation: non-empty observation text。 */
  readonly observation?: string;
  /** show: digest-addressed persisted observation ref（gate 验证输入）。 */
  readonly observationRef?: string;
  /** show: root-relative Context ref（`.proofloop/context/<digest>.json`）。 */
  readonly ref?: string;
}

/** Merge the closed request input and CLI flags into bounded context params. */
export function collectContextParams(
  parsed: ParsedCliArgs,
  request: CliRequestInput,
): ContextOperationParams {
  return {
    stage: parsed.stage ?? request.stage,
    role: parsed.role ?? request.role,
    slice: parsed.slice ?? request.slice,
    task: parsed.task ?? request.task,
    observation: parsed.observation ?? request.observation,
    observationRef: parsed.observationRef ?? request.observation_ref,
    ref: parsed.ref ?? request.ref,
  };
}

// ============================================================
// Helpers
// ============================================================

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map a seam fail-closed error to a canonical CONTEXT.* finding code. */
function contextFindingCode(error: unknown): string {
  if (error instanceof VNextHandoffError) {
    switch (error.code) {
      case 'v1-input':
      case 'manifest-invalid':
        return 'CONTEXT.MANIFEST_INVALID';
      case 'manifest-binding':
        return 'CONTEXT.MANIFEST_BINDING';
      case 'snapshot-binding':
        return 'CONTEXT.SNAPSHOT_BINDING';
      case 'admission-missing':
      case 'admission-invalid':
        return 'CONTEXT.ADMISSION_AUTHORITY_MISSING';
      case 'task-anchor-gap':
        return 'CONTEXT.TASK_NOT_FOUND';
      case 'reference-digest-mismatch':
        return 'CONTEXT.REFERENCE_MISMATCH';
      case 'execution-scope-gap':
        return 'CONTEXT.SCOPE_GAP';
      case 'path-escape':
        return 'RUNTIME.PATH_OUTSIDE_ROOT';
      default:
        return 'CONTEXT.BLOCKED';
    }
  }
  return 'CONTEXT.BLOCKED';
}

function blockedEnvelope(
  command: CliCommand,
  error: unknown,
): CliEnvelope {
  return errorEnvelope(command, contextFindingCode(error), errorMessage(error));
}

/** Validate the closed role parameter（unknown role fails closed pre-write）。 */
function requireRole(
  command: CliCommand,
  role: string | undefined,
): string | null {
  if (role === undefined) {
    return null;
  }
  if (!isVNextContextRole(role)) {
    // surfaced as a structured finding by the caller
    return null;
  }
  return role;
}

/** Validate the canonical Stage parameter（`^S\d+$`）。 */
function requireStage(
  command: CliCommand,
  stage: string | undefined,
): CliEnvelope | { readonly stage: string } {
  if (stage === undefined) {
    return errorEnvelope(
      command,
      'CONTEXT.STAGE_REQUIRED',
      'context operation requires a target stage (--stage <stage-id> or request field "stage")',
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

interface ResolvedManifestAuthority {
  readonly manifest: Record<string, unknown>;
  readonly manifestDigest: string;
  readonly authority: VNextAdmissionAuthority;
  readonly snapshotDigest: string;
}

/** Read the validated current epoch as the existing admission authority shape. */
function readCurrentEpochAuthority(root: string, stage: string): VNextAdmissionAuthority {
  const current = readCurrentEpoch(root, stage);
  return { spv: current.spv, stagePlan: current.stagePlan };
}

/** Read the admitted Manifest + Stage Plan/SPV authority（snapshot binding）。 */
function resolveManifestAuthority(
  root: string,
  command: CliCommand,
  stage: string,
): CliEnvelope | ResolvedManifestAuthority {
  let manifest: Record<string, unknown>;
  try {
    const loaded = readVNextManifest(root, `.proofloop/manifests/${stage}.json`) as unknown;
    manifest = loaded as Record<string, unknown>;
  } catch (error) {
    return errorEnvelope(
      command,
      'CONTEXT.MANIFEST_NOT_FOUND',
      `Manifest ".proofloop/manifests/${stage}.json" cannot be read as an admitted v2 Manifest: ${errorMessage(error)}`,
    );
  }
  if (manifest.stage_id !== stage) {
    return errorEnvelope(
      command,
      'CONTEXT.MANIFEST_BINDING',
      `Manifest stage_id "${String(manifest.stage_id)}" does not match requested stage "${stage}"`,
    );
  }
  let authority: VNextAdmissionAuthority;
  try {
    authority = readCurrentEpochAuthority(root, stage);
  } catch (error) {
    return errorEnvelope(
      command,
      'CONTEXT.ADMISSION_AUTHORITY_MISSING',
      `Stage Plan admission + fresh SPV authority are required for a digest-bound Context: ${errorMessage(error)}`,
    );
  }
  // S10-B-T02 repair round 3: revalidate the authority's Manifest/Plan
  // binding — a stale authority must never project a new Context.
  const manifestDigest = computeDigest(manifest);
  const manifestPlanDigest = (manifest.plan as { plan_digest: string }).plan_digest;
  if (
    authority.spv.manifest_digest !== manifestDigest ||
    authority.stagePlan.manifest_digest !== manifestDigest ||
    authority.spv.plan_digest !== manifestPlanDigest ||
    authority.stagePlan.plan_digest !== manifestPlanDigest ||
    authority.stagePlan.spv_receipt_digest !== authority.spv.digest ||
    // S10-B-T02 repair round 4: the authority tuple must be internally
    // consistent — Stage Plan snapshot and SPV snapshot must agree.
    authority.stagePlan.snapshot_digest !== authority.spv.snapshot_digest
  ) {
    return errorEnvelope(
      command,
      'CONTEXT.ADMISSION_AUTHORITY_STALE',
      `admission authority is stale or internally inconsistent: its Manifest/Plan/snapshot binding does not match the current Manifest "${stage}"`,
    );
  }
  return {
    manifest,
    manifestDigest,
    authority,
    snapshotDigest: authority.spv.snapshot_digest,
  };
}

/** Historical invalidated Task IDs across ancestor replan epochs（与 next 同一事实源）。 */
function readHistoricalInvalidatedTaskIds(root: string, stageId: string): Set<string> {
  const currentEpoch = readCurrentEpoch(root, stageId);
  const ancestorRecords = loadAncestorReplanDispositionRecords(root, stageId, currentEpoch);
  const historicalBindings = deriveHistoricalInvalidatedBindings(ancestorRecords);
  const taskIds = new Set<string>();
  for (const b of historicalBindings) {
    if (b.stage_id === stageId) {
      taskIds.add(b.task_id);
    }
  }
  return taskIds;
}

/** Completed Task IDs from persisted Worker Receipts（与 next 同一事实源）。 */
function readCompletedTaskIds(root: string, stageId: string): string[] {
  const currentEpoch = readCurrentEpoch(root, stageId);
  const ancestorRecords = loadAncestorReplanDispositionRecords(root, stageId, currentEpoch);
  const historicalBindings = deriveHistoricalInvalidatedBindings(ancestorRecords);
  const base = path.join(root, '.proofloop', 'receipts', 'tasks', stageId);
  let sliceDirs: string[];
  try {
    sliceDirs = fs.readdirSync(base).filter((name) => {
      try {
        return fs.statSync(path.join(base, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const taskIds: string[] = [];
  for (const sliceDir of sliceDirs) {
    const directory = path.join(base, sliceDir);
    let names: string[];
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(directory, name);
      const canonical = canonicalPathWithinRoot(root, file);
      if (canonical === null) continue;
      const opened = openNoFollowRead(root, canonical);
      if (!opened.ok) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(opened.fd, 'utf8');
      } catch {
        continue;
      } finally {
        fs.closeSync(opened.fd);
      }
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const receipt = validateReceipt(parsed);
        if (receipt.type !== 'TASK_COMPLETE') continue;
        const payload = receipt.payload as Record<string, unknown> | undefined;
        if (payload === undefined || typeof payload !== 'object') continue;
        const taskId = payload.task_id;
        if (typeof taskId !== 'string' || taskId.length === 0) continue;

        // Outer envelope must bind to the requested stage and slice directory
        if (receipt.stage_id !== stageId || receipt.slice_id !== sliceDir) continue;

        // Resolve stage_id and slice_id: fallback to outer envelope when payload omits them;
        // fail closed (skip receipt) if payload fields conflict with the outer envelope.
        let receiptStageId = receipt.stage_id;
        if (typeof payload.stage_id === 'string' && payload.stage_id.length > 0) {
          if (payload.stage_id !== receipt.stage_id) continue;
          receiptStageId = payload.stage_id;
        }

        let receiptSliceId = receipt.slice_id;
        if (typeof payload.slice_id === 'string' && payload.slice_id.length > 0) {
          if (payload.slice_id !== receipt.slice_id) continue;
          receiptSliceId = payload.slice_id;
        }
        const isHistoricalInvalidated = historicalBindings.some(
          (binding) =>
            binding.stage_id === receiptStageId &&
            binding.manifest_digest === payload.manifest_digest &&
            binding.plan_digest === payload.plan_digest &&
            binding.snapshot_digest === payload.snapshot_digest &&
            binding.task_id === taskId,
        );
        if (isHistoricalInvalidated) continue;
        taskIds.push(taskId);
      } catch {
        // non-JSON or invalid receipt files are not Worker facts
      }
    }
  }
  return [...new Set(taskIds)];
}

/** Slices closed by an admitted SLICE_COMMIT fact（与 next 同一事实源）。 */
function readCommittedSliceIds(root: string, stageId: string): Set<string> {
  const base = path.join(root, '.proofloop', 'receipts', 'committer', stageId);
  let sliceDirs: string[];
  try {
    sliceDirs = fs.readdirSync(base).filter((name) => {
      try {
        return fs.statSync(path.join(base, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return new Set();
  }
  const committed = new Set<string>();
  for (const sliceDir of sliceDirs) {
    const directory = path.join(base, sliceDir);
    let names: string[];
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
    } catch {
      continue;
    }
    if (names.length > 0) committed.add(sliceDir);
  }
  return committed;
}

/**
 * Whether the worktree Plan projection has the given Task checkbox checked —
 * the SAME persisted fact source the next consumer uses for the dispatch
 * completion mode (recover-task for already-produced implementation evidence
 * without an admitted TASK_COMPLETE fact).
 */
function planTaskCheckboxChecked(root: string, planPath: string, taskId: string): boolean {
  const lexical = path.join(root, planPath);
  let opened;
  try {
    opened = openNoFollowRead(root, lexical);
  } catch {
    return false;
  }
  if (!opened.ok) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(opened.fd, 'utf8');
  } catch {
    return false;
  } finally {
    fs.closeSync(opened.fd);
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*-\s*\[([ xX])\]\s+(\S+)/.exec(line);
    if (match !== null && match[2] === taskId) return match[1].toLowerCase() === 'x';
  }
  return false;
}

/**
 * Select the dispatch Slice with the SAME rule as the execution next
 * consumer: the Slice of in-flight Worker facts (when unique and not
 * committed), otherwise the first Manifest Slice that is not committed and
 * whose declared dependencies are all committed.  Committed Slices are
 * skipped so a completed Slice is never re-dispatched.
 */
function selectDispatchSliceId(
  manifest: Record<string, unknown>,
  completedTaskIds: readonly string[],
  committed: ReadonlySet<string>,
): string | undefined {
  const factSliceIds = [
    ...new Set(
      completedTaskIds
        .map((taskId) => taskId.slice(0, taskId.lastIndexOf('-')))
        .filter((sliceId) => sliceId.length > 0 && !committed.has(sliceId)),
    ),
  ];
  if (factSliceIds.length > 1) return undefined;
  if (factSliceIds.length === 1) return factSliceIds[0];
  const slices = Array.isArray(manifest.slices)
    ? (manifest.slices as Array<Record<string, unknown>>)
    : [];
  const candidate = slices.find((slice) => {
    const sliceId = typeof slice.slice_id === 'string' ? slice.slice_id : '';
    const dependsOn = Array.isArray(slice.depends_on)
      ? (slice.depends_on as string[])
      : [];
    return (
      sliceId.length > 0 &&
      !committed.has(sliceId) &&
      dependsOn.every((dependency) => committed.has(dependency))
    );
  });
  return typeof candidate?.slice_id === 'string' ? candidate.slice_id : undefined;
}

/** Resolve the declared Worker task set before considering a finalize dispatch. */
function declaredTaskIdsForSlice(
  manifest: Record<string, unknown>,
  sliceId: string,
): string[] | undefined {
  const slices = Array.isArray(manifest.slices)
    ? (manifest.slices as Array<Record<string, unknown>>)
    : [];
  const slice = slices.find((candidate) => candidate.slice_id === sliceId);
  if (slice === undefined) return undefined;
  const proofIndex = slice.proof_index;
  if (typeof proofIndex !== 'object' || proofIndex === null || Array.isArray(proofIndex)) {
    throw new VNextHandoffError('manifest-invalid', `Slice ${sliceId} has no verified Proof Index`);
  }
  const taskRefs = (proofIndex as Record<string, unknown>).task_refs;
  if (!Array.isArray(taskRefs) || taskRefs.length === 0 || !taskRefs.every((refId) => typeof refId === 'string')) {
    throw new VNextHandoffError('manifest-invalid', `Slice ${sliceId} has no verified Proof Index task_refs`);
  }
  const referenceIndex = (manifest.reference_index ?? {}) as Record<string, Record<string, unknown>>;
  const taskIds: string[] = [];
  for (const refId of taskRefs as string[]) {
    const descriptor = referenceIndex[refId];
    const ref = typeof descriptor?.ref === 'string' ? descriptor.ref : '';
    const taskId = /#\/entities\/([^/]+)$/.exec(ref)?.[1];
    if (descriptor?.kind !== 'task' || taskId === undefined || !taskId.startsWith(`${sliceId}-`)) {
      throw new VNextHandoffError('task-anchor-gap', `Task anchor for Slice ${sliceId} is not available from the verified Proof Index`);
    }
    taskIds.push(taskId);
  }
  return taskIds;
}

/**
 * Project the Worker dispatch with the SAME completion-mode rule as the next
 * consumer.  A Slice whose verified Proof Index task set is fully completed
 * projects `finalize-slice` without a task anchor; otherwise the existing
 * implement/recover task projection remains unchanged.  Both projections are
 * pure; only the caller may persist through the Runtime seam.
 */
function projectWorkerDispatch(
  root: string,
  resolved: ResolvedManifestAuthority,
  requestedSliceId: string | undefined,
): VNextWorkerDispatch {
  const stageId = resolved.manifest.stage_id as string;
  if (requestedSliceId !== undefined) {
    const declaredSliceIds = (resolved.manifest.slices as Array<{ slice_id: string }>).map((s) => s.slice_id);
    if (!declaredSliceIds.includes(requestedSliceId)) {
      throw new VNextHandoffError('task-anchor-gap', `requested slice "${requestedSliceId}" is not declared by the Manifest`);
    }
  }
  const dispatch = deriveVNextWorkerDispatchForStage(root, stageId, {
    snapshotDigest: resolved.snapshotDigest,
  });
  if (requestedSliceId !== undefined && dispatch.slice_id !== requestedSliceId) {
    throw new VNextHandoffError('task-anchor-gap', `requested slice "${requestedSliceId}" does not match the canonical dispatch slice "${dispatch.slice_id}"`);
  }
  return dispatch;
}

/** Validate the `ref` parameter shape（root-relative digest-addressed Context）。 */
function validateContextRef(root: string, command: CliCommand, ref: string): CliEnvelope | string {
  if (path.isAbsolute(ref) || ref.includes('\\') || ref.includes('\u0000')) {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      `context ref must be a canonical root-relative path: "${ref}"`,
    );
  }
  const parts = ref.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      `context ref contains a non-canonical path component: "${ref}"`,
    );
  }
  if (!/^\.proofloop\/context\/[a-f0-9]{64}\.json$/.test(ref)) {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      `context ref must be a digest-addressed Context path (.proofloop/context/<64-hex>.json): "${ref}"`,
    );
  }
  if (canonicalPathWithinRoot(root, ref) === null) {
    return errorEnvelope(
      command,
      'RUNTIME.PATH_OUTSIDE_ROOT',
      `context ref escapes the project root: "${ref}"`,
    );
  }
  return ref;
}

/** Build the cv-validation payload binding for a Slice（round 6）：the
 * Manifest Proof Index digest + exact reference sets + Worker tip digest. */
function cvBinding(
  manifest: Record<string, unknown>,
  sliceId: string,
  manifestDigest: string,
  planDigest: string,
  workerTipDigest: string,
): VNextCvPayloadBinding {
  const slices = Array.isArray(manifest.slices)
    ? (manifest.slices as Array<Record<string, unknown>>)
    : [];
  const slice = slices.find((candidate) => candidate.slice_id === sliceId);
  const proofIndex = slice?.proof_index as Record<string, unknown> | undefined;
  const asRefs = (value: unknown): string[] =>
    Array.isArray(value) ? (value as string[]) : [];
  const riskRefs = Array.isArray(proofIndex?.risk_refs)
    ? (proofIndex.risk_refs as Array<Record<string, unknown>>).map((risk) =>
        typeof risk.ref_id === 'string' ? risk.ref_id : '',
      ).filter((refId) => refId.length > 0)
    : [];
  return {
    stageId: manifest.stage_id as string,
    sliceId,
    manifestDigest,
    planDigest,
    proofIndexDigest: proofIndex === undefined ? '' : computeDigest(proofIndex),
    workerTipDigest,
    expectedAcceptanceRefs: asRefs(proofIndex?.acceptance_refs),
    expectedSeamRefs: asRefs(proofIndex?.seam_refs),
    expectedOracleRefs: asRefs(proofIndex?.oracle_refs),
    expectedRiskRefs: riskRefs,
  };
}

/** CV repair history of the bound Slice（repair round 4，S11-A-T01 链语义）：a
 * persisted CV_REPAIR receipt drives the cv role verification type（initial vs
 * recheck）.
 *
 * S11-A-T01: the persisted CV Receipt set of the Slice is read as ONE
 * previous_digest-linked single chain（the complete CV Receipt category：
 * CV_PASS + CV_REPAIR）, and only the chain TIP may project recheck facts.
 * Directory order, timestamps and Agent narrative never select the “latest”
 * fact（S10-E regression: filename-sorted first-valid selection projected the
 * OLD CV_REPAIR instead of the chain tip）.  Every member is revalidated
 * （unchanged S10 strength）: the receipt must be digest-addressed
 * （filename === digest）, schema/self-digest valid, bound to the CURRENT
 * Manifest/Plan/snapshot tuple, a closed v2 CV_RESULT payload with type↔
 * verdict agreement, and bound to a persisted Worker Receipt of the Slice —
 * a forged/self-declared receipt can never force recheck.
 *
 * The single chain must be unambiguous: exactly one genesis, no fork, no
 * dangling previous_digest, no duplicate digest, no cycle/orphan, and a
 * legal sequence（reused from the shared cv-validation rule
 * `assertVNextCvChainSequence`——the same single-truth rule cv-admission and
 * the next consumer apply: genesis must be an initial verification, every
 * successor must be a recheck whose previous_failure_signature exactly
 * matches the preceding CV_REPAIR, nothing may follow a CV_PASS, and Worker
 * tip reuse follows the legal REPAIR→recheck successor rule）.  Any invalid
 * member, corrupted 64-hex-named candidate, or topology/sequence violation
 * fails closed to `hasRepair: false` — a broken chain never silently falls
 * back to an OLD CV_REPAIR.  When the chain tip is a CV_PASS, no recheck is
 * projected. */
type CvRepairHistory = {
  readonly hasRepair: boolean;
  readonly previousFailureSignature?: string;
  readonly repairDiffDigest?: string;
  readonly failedCriterion?: string;
  readonly counterexamples?: readonly string[];
  readonly requiredRecheckScope?: readonly string[];
};

/** A digest-valid CV_PASS/CV_REPAIR receipt that passed every closed check. */
interface CvRepairChainMember {
  readonly digest: string;
  readonly receiptType: string;
  readonly payload: Record<string, unknown>;
  readonly previousDigest: string | undefined;
}

function readCvRepairHistory(
  root: string,
  stageId: string,
  sliceId: string,
  manifest: Record<string, unknown>,
  manifestDigest: string,
  planDigest: string,
  snapshotDigest: string,
): CvRepairHistory {
  const noRepairHistory = (): CvRepairHistory => ({
    hasRepair: false,
    previousFailureSignature: undefined,
    repairDiffDigest: undefined,
    failedCriterion: undefined,
    counterexamples: [],
    requiredRecheckScope: [],
  });
  const directory = path.join(root, '.proofloop', 'receipts', 'cv', stageId, sliceId);
  const taskDirectory = path.join(root, '.proofloop', 'receipts', 'tasks', stageId, sliceId);
  let taskDigests: Set<string>;
  try {
    taskDigests = new Set(
      fs.readdirSync(taskDirectory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/\.json$/, '')),
    );
  } catch {
    taskDigests = new Set();
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return noRepairHistory();
  }
  // Phase 1 — collect chain members.  Only digest-valid CV_PASS/CV_REPAIR
  // receipts that pass the FULL existing per-receipt validation can be chain
  // members.  Files that are not 64-hex-digest-addressed or that are VALID
  // receipts of a non-CV category are not CV facts and keep the skip contract
  //（S10 contract）; a 64-hex-named CANDIDATE CV receipt that is corrupted
  // （unparseable JSON / digest-addressing mismatch / schema-invalid /
  // self-digest-broken, or an IO-level failure: path escape / open failure /
  // read failure）fails the whole history closed instead of being silently
  // skipped（S11-A-T01 repair: never fall back to an older chain member past
  // a corrupted candidate）.  A digest-valid CV receipt that fails any
  // binding/closed-payload/Worker-binding check is an INVALID CHAIN MEMBER
  // and fails the whole history closed（S11-A-T01）.
  const members = new Map<string, CvRepairChainMember>();
  for (const name of names) {
    // digest-addressed receipt candidate: filename basename must be 64-hex
    // （non-64-hex files are not CV receipt candidates）
    const fileDigest = name.replace(/\.json$/, '');
    if (!/^[a-f0-9]{64}$/.test(fileDigest)) continue;
    const file = path.join(directory, name);
    // S11-A-T01 repair round 2（IO 级 fail closed）：64-hex 候选的路径/打开/
    // 读取失败必须使整个历史 fail closed（返回 noRepairHistory），不得
    // continue 跳过——否则合法旧链 tip 与路径逃逸候选（如指向 root 外的
    // symlink）、非 regular 候选（目录/FIFO/socket）或不可读候选并存时仍会
    // 投影旧 recheck。唯一例外是 readdir 后条目消失的 ENOENT 竞态（合法
    // 缺失）：条目已不在目录中，按目录扫描语义跳过该名字，避免把并发清理
    // 误判为损坏候选而引入 flaky；条目仍存在时的打开失败才是损坏候选。
    // 该例外必须由 lstatSync 以 ENOENT 确认（repair round 3）：只有
    // error.code === 'ENOENT' 才证明条目确实从磁盘消失；EACCES/EIO/
    // ENOTDIR 等非 ENOENT 的 lstat 异常无法确认合法缺失，同样是损坏候选，
    // 必须 fail closed，不得被当作“条目不存在”而 continue 跳过。
    const canonical = canonicalPathWithinRoot(root, file);
    if (canonical === null) {
      // 路径逃逸（如 symlink 链指向 root 外）：损坏候选，fail closed。
      return noRepairHistory();
    }
    const opened = openNoFollowRead(root, canonical);
    if (!opened.ok) {
      if (opened.reason === 'unreadable') {
        try {
          // 条目仍存在：打开失败是真实损坏候选（不可读等），fail closed。
          fs.lstatSync(file);
        } catch (error) {
          // 仅 ENOENT（readdir 列出后条目确实从磁盘消失的竞态）允许
          // continue；非 ENOENT lstat 异常必须 fail closed——否则不可读
          // 损坏候选可绕过检查并回退投影旧链 tip。
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        }
      }
      return noRepairHistory();
    }
    let raw: string;
    try {
      raw = fs.readFileSync(opened.fd, 'utf8');
    } catch {
      // 打开成功后读取失败：损坏候选，fail closed（不得静默跳过）。
      return noRepairHistory();
    } finally {
      fs.closeSync(opened.fd);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 64-hex-named candidate that is not valid JSON is a corrupted CV
      // candidate: fail closed instead of silently skipping it.
      return noRepairHistory();
    }
    if (parsed.digest !== fileDigest) {
      // 64-hex-named candidate whose content digest does not match its
      // digest-addressed filename is corrupted: fail closed.
      return noRepairHistory();
    }
    // Round 6: REAL Runtime Receipt validation — schema/type/verdict via
    // validateReceipt + content digest via verifyReceiptDigest + the
    // closed CV payload rules (incl. recheck branch fields).
    let receipt;
    try {
      receipt = validateReceipt(parsed);
    } catch {
      // 64-hex-named candidate that is schema-invalid is corrupted: fail
      // closed instead of silently skipping it.
      return noRepairHistory();
    }
    if (!verifyReceiptDigest(canonical)) {
      // 64-hex-named candidate whose on-disk content does not hash to its
      // declared digest is self-digest-broken: fail closed.
      return noRepairHistory();
    }
    // Only the complete CV Receipt category（CV_PASS | CV_REPAIR）can be a
    // chain member; any other VALID receipt type is not a CV fact of this
    // chain and keeps the skip contract.
    if (receipt.type !== 'CV_REPAIR' && receipt.type !== 'CV_PASS') continue;
    // Duplicate digest files corrupt the chain identity: fail closed.
    if (members.has(fileDigest)) return noRepairHistory();
    const payload = receipt.payload as Record<string, unknown> | undefined;
    if (payload === undefined || typeof payload !== 'object') return noRepairHistory();
    try {
      assertVNextCvReceiptTypeVerdict(receipt.type, payload);
      // binding：当前 Manifest/Plan/Proof Index + Worker tip + stage/slice
      // tuple + closed recheck 闭合字段（cv-validation 单真值）
      assertClosedVNextCvPayload(
        payload,
        cvBinding(manifest, sliceId, manifestDigest, planDigest, payload.worker_receipt_digest as string),
      );
    } catch {
      return noRepairHistory();
    }
    if (receipt.stage_id !== stageId || receipt.slice_id !== sliceId) return noRepairHistory();
    if (payload.snapshot_digest !== snapshotDigest) return noRepairHistory();
    // worker receipt binding（round 6）：validateReceipt + content digest +
    // stage/slice + Manifest/Plan/snapshot tuple + task tuple
    if (typeof payload.worker_receipt_digest !== 'string' || !taskDigests.has(payload.worker_receipt_digest)) {
      return noRepairHistory();
    }
    const workerReceiptPath = path.join(taskDirectory, `${payload.worker_receipt_digest}.json`);
    const workerCanonical = canonicalPathWithinRoot(root, workerReceiptPath);
    if (workerCanonical === null) return noRepairHistory();
    if (!verifyReceiptDigest(workerCanonical)) return noRepairHistory();
    const workerOpened = openNoFollowRead(root, workerCanonical);
    if (!workerOpened.ok) return noRepairHistory();
    let workerRaw: string;
    try {
      workerRaw = fs.readFileSync(workerOpened.fd, 'utf8');
    } catch {
      return noRepairHistory();
    } finally {
      fs.closeSync(workerOpened.fd);
    }
    try {
      const workerParsed = JSON.parse(workerRaw) as Record<string, unknown>;
      const workerReceipt = validateReceipt(workerParsed);
      if (workerReceipt.type !== 'TASK_COMPLETE') return noRepairHistory();
      if (workerReceipt.stage_id !== stageId || workerReceipt.slice_id !== sliceId) return noRepairHistory();
      const workerPayload = workerReceipt.payload as Record<string, unknown> | undefined;
      if (workerPayload === undefined || typeof workerPayload !== 'object') return noRepairHistory();
      if (workerPayload.schema_version !== 2) return noRepairHistory();
      // Manifest/Plan 必须精确绑定；snapshot 允许 execution descendant
      if (workerPayload.manifest_digest !== manifestDigest || workerPayload.plan_digest !== planDigest) {
        return noRepairHistory();
      }
      const workerTaskId = typeof workerPayload.task_id === 'string' ? workerPayload.task_id : '';
      if (!workerTaskId.startsWith(`${sliceId}-`)) return noRepairHistory();
    } catch {
      return noRepairHistory();
    }
    const previousDigest =
      typeof receipt.previous_digest === 'string' && receipt.previous_digest.length > 0
        ? receipt.previous_digest
        : undefined;
    members.set(fileDigest, { digest: fileDigest, receiptType: receipt.type, payload, previousDigest });
  }
  if (members.size === 0) return noRepairHistory();

  // Phase 2 — single-chain topology via previous_digest（S11-A-T01）.
  const genesis: string[] = [];
  const childOf = new Map<string, string>();
  for (const member of members.values()) {
    const previous = member.previousDigest;
    if (previous === undefined) {
      genesis.push(member.digest);
      continue;
    }
    if (!members.has(previous)) return noRepairHistory(); // dangling link
    if (childOf.has(previous)) return noRepairHistory(); // fork
    childOf.set(previous, member.digest);
  }
  // Exactly one genesis: zero genesis means a cycle（every member has a
  // predecessor）; more than one genesis means ambiguous chains.
  if (genesis.length !== 1) return noRepairHistory();
  const order: CvRepairChainMember[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = genesis[0];
  while (cursor !== undefined) {
    if (visited.has(cursor)) return noRepairHistory(); // cycle（defense in depth）
    visited.add(cursor);
    const member = members.get(cursor);
    if (member === undefined) return noRepairHistory();
    order.push(member);
    cursor = childOf.get(cursor);
  }
  if (visited.size !== members.size) return noRepairHistory(); // orphan/unreachable member
  const tip = order[order.length - 1];

  // Phase 3 — legal chain sequence（S11-A-T01 repair）: reuse the shared
  // cv-validation single-truth rule（the SAME rule cv-admission and the next
  // consumer apply）——the genesis must be an `initial` verification, every
  // later member must be a `recheck` whose previous_failure_signature
  // EXACTLY matches the failure_signature of the preceding CV_REPAIR
  // （including a CV_PASS recheck successor）, nothing may follow a CV_PASS,
  // and Worker tip reuse is limited to the legal REPAIR→recheck successor.
  // Any violation fails the whole history closed.
  try {
    assertVNextCvChainSequence(
      order.map((member) => ({ type: member.receiptType, payload: member.payload })),
    );
  } catch {
    return noRepairHistory();
  }

  // Phase 4 — project ONLY the chain tip（S11-A-T01）.  A CV_PASS tip means
  // the CV chain is closed: no recheck is projected and the repair history
  // must not fall back to an older CV_REPAIR.
  if (tip.payload.verdict !== 'REPAIR') return noRepairHistory();
  const signature = typeof tip.payload.failure_signature === 'string' ? tip.payload.failure_signature : undefined;
  const repairDiffDigest = typeof tip.payload.repair_diff_digest === 'string' ? tip.payload.repair_diff_digest : undefined;
  const failedCriterion = typeof tip.payload.failed_criterion === 'string' ? tip.payload.failed_criterion : undefined;
  const counterexamples = Array.isArray(tip.payload.counterexamples)
    ? (tip.payload.counterexamples as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
  const requiredRecheckScope = Array.isArray(tip.payload.required_recheck_scope)
    ? (tip.payload.required_recheck_scope as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    hasRepair: true,
    previousFailureSignature: signature,
    repairDiffDigest,
    failedCriterion,
    counterexamples,
    requiredRecheckScope,
  };
}

/** Find the persisted CV Context of the tuple（repair round 3/6）：the CV
 * Context must have been prepared（and persisted by the Runtime seam）BEFORE
 * any refutation observation can be admitted, and it must bind the CURRENT
 * admitted Manifest/Plan/snapshot — a self-consistent forged record with a
 * fake marker or fake digest tuple is rejected. */
function findCvContext(
  root: string,
  stageId: string,
  sliceId: string,
  taskId: string,
  manifestDigest: string,
  planDigest: string,
  snapshotDigest: string,
): { readonly ref: string; readonly digest: string } | null {
  const directory = path.join(root, '.proofloop', 'context');
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }
  for (const name of names) {
    const relative = `.proofloop/context/${name}`;
    const canonical = canonicalPathWithinRoot(root, relative);
    if (canonical === null) continue;
    const opened = openNoFollowRead(root, canonical);
    if (!opened.ok) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(opened.fd, 'utf8');
    } catch {
      continue;
    } finally {
      fs.closeSync(opened.fd);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (
      record.schema_version !== 2 ||
      record.role !== 'cv' ||
      record.stage_id !== stageId ||
      record.slice_id !== sliceId ||
      record.task_id !== taskId
    ) {
      continue;
    }
    // S10-B-T02 repair round 4: TYPE guard — a persisted record is a CV
    // Context only when it is a role Context projection, NOT a
    // REFUTATION_OBSERVATION (or any other artifact type).  A cv Context
    // carries the Evidence read gate declaration and role_fields; an
    // observation record carries `type: REFUTATION_OBSERVATION` and neither
    // of those.  Forged observation records can never masquerade as an
    // established CV Context.
    if (
      typeof record.type === 'string' ||
      record.evidence_read_gate === undefined ||
      typeof record.role_fields !== 'object' ||
      record.role_fields === null ||
      // Runtime admission provenance（round 5/6）：无 seam 标记的自洽伪造记录
      // 拒绝；带伪造 marker 但 digest tuple 不绑定当前已 admission 事实的
      // 自洽记录同样拒绝（round 6）
      record.created_by !== 'vnext-runtime-seam' ||
      record.manifest_digest !== manifestDigest ||
      record.plan_digest !== planDigest ||
      record.snapshot_digest !== snapshotDigest
    ) {
      continue;
    }
    if (typeof record.context_digest !== 'string') continue;
    const withoutDigest = { ...record } as Record<string, unknown>;
    delete withoutDigest.context_digest;
    if (computeDigest(withoutDigest) !== record.context_digest) continue;
    return { ref: relative, digest: record.context_digest };
  }
  return null;
}

/** Read + self-verify a PERSISTED refutation observation record（round 2:
 * the gate only accepts records written write-once by the Runtime seam —
 * caller-declared/forged observations are rejected）. */
function readObservationRecord(
  root: string,
  command: CliCommand,
  ref: string,
): CliEnvelope | VNextRefutationObservation {
  const refResult = validateContextRef(root, command, ref);
  if (typeof refResult !== 'string') return refResult;
  const canonical = canonicalPathWithinRoot(root, ref) as string;
  const opened = openNoFollowRead(root, canonical);
  if (!opened.ok) {
    return errorEnvelope(
      command,
      'CONTEXT.OBSERVATION_NOT_FOUND',
      `observation "${ref}" is not a persisted Runtime record (only admitted refutation observations satisfy the gate)`,
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
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return errorEnvelope(command, 'CONTEXT.OBSERVATION_INVALID', 'persisted observation is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return errorEnvelope(command, 'CONTEXT.OBSERVATION_INVALID', 'persisted observation must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== 2 || record.type !== 'REFUTATION_OBSERVATION') {
    return errorEnvelope(
      command,
      'CONTEXT.OBSERVATION_INVALID',
      'persisted observation is not a REFUTATION_OBSERVATION (schema_version 2)',
    );
  }
  for (const field of [
    'stage_id',
    'slice_id',
    'task_id',
    'role',
    'evidence_path',
    'snapshot_digest',
    'observation',
    'context_digest',
  ]) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
      return errorEnvelope(
        command,
        'CONTEXT.OBSERVATION_INVALID',
        `persisted observation field "${field}" must be a non-empty string`,
      );
    }
  }
  if (record.evidence_read !== false) {
    return errorEnvelope(
      command,
      'CONTEXT.OBSERVATION_INVALID',
      'persisted observation evidence_read must be false (observation precedes Evidence read)',
    );
  }
  if (record.created_by !== 'vnext-runtime-seam') {
    return errorEnvelope(
      command,
      'CONTEXT.OBSERVATION_INVALID',
      'persisted observation carries no Runtime seam admission provenance (forged record)',
    );
  }
  // digest-addressed ref 必须与记录自 digest 一致
  const refDigest = ref.replace(/^\.proofloop\/context\//, '').replace(/\.json$/, '');
  if (record.context_digest !== refDigest) {
    return errorEnvelope(
      command,
      'CONTEXT.OBSERVATION_INVALID',
      'persisted observation digest does not match its digest-addressed ref',
    );
  }
  return record as unknown as VNextRefutationObservation;
}

/** Validate the role-specific minimum semantic fields on read-back
 * （contract 0.5，round 3）：field PRESENCE plus VALUE revalidation against
 * the current Manifest、Authority、Receipt shape and the requested tuple —
 * a tampered value（re-digested）can never pass. */
function validateRoleFields(
  root: string,
  command: CliCommand,
  role: string,
  roleFields: unknown,
  resolved: ResolvedManifestAuthority,
): CliEnvelope | null {
  // The worker Context is the dispatch projection: its role semantics live in
  // the dispatch schema itself, so role_fields is not part of it.
  if (role === 'worker') return null;
  if (typeof roleFields !== 'object' || roleFields === null || Array.isArray(roleFields)) {
    return errorEnvelope(command, 'CONTEXT.ROLE_FIELDS_INVALID', 'Context role_fields must be an object');
  }
  const fields = roleFields as Record<string, unknown>;
  const requiredByRole: Record<string, readonly string[]> = {
    planning: ['authority_refs', 'selected_work_item_refs'],
    spv: ['stage_goal_refs', 'authority_refs', 'evidence_paths'],
    cv: ['verification', 'evidence_read', 'goal_refs', 'task_refs', 'acceptance_refs', 'seam_refs', 'oracle_refs', 'risk_refs'],
    'stage-reviewer': ['review_scope', 'integrated_snapshot', 'acceptance_refs', 'seam_refs', 'oracle_refs', 'risk_refs'],
    'project-reviewer': ['review_scope', 'acceptance_refs', 'seam_refs', 'oracle_refs', 'risk_refs'],
    worker: [],
  };
  const missing = (requiredByRole[role] ?? []).filter((field) => !(field in fields));
  if (missing.length > 0) {
    return errorEnvelope(
      command,
      'CONTEXT.ROLE_FIELDS_INVALID',
      `Context role_fields missing required field(s) for role "${role}": ${missing.join(', ')}`,
    );
  }

  // ── Value revalidation against the current Manifest/Authority ──
  const manifest = resolved.manifest;
  const referenceIndex = (manifest.reference_index ?? {}) as Record<string, Record<string, unknown>>;
  const authorityRefIds = Array.isArray(manifest.authority_ref_ids)
    ? (manifest.authority_ref_ids as string[])
    : [];
  const manifestSlices = Array.isArray(manifest.slices)
    ? (manifest.slices as Array<Record<string, unknown>>)
    : [];
  const evidencePaths = manifestSlices.map((slice) => slice.evidence_path);

  const invalid = (message: string): CliEnvelope =>
    errorEnvelope(command, 'CONTEXT.ROLE_FIELDS_INVALID', `Context role_fields value is invalid: ${message}`);

  const requireStringArray = (value: unknown, label: string): string[] | CliEnvelope => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      return invalid(`${label} must be an array of strings`);
    }
    return value as string[];
  };
  const requireStringValue = (value: unknown, label: string): string | CliEnvelope => {
    if (typeof value !== 'string' || value.length === 0) {
      return invalid(`${label} must be a non-empty string`);
    }
    return value;
  };
  const requireRefsInIndex = (refs: unknown, label: string, expectedKind: string | null): CliEnvelope | null => {
    const values = requireStringArray(refs, label);
    if (Array.isArray(values) === false) return values as CliEnvelope;
    for (const refId of values as string[]) {
      if (!(refId in referenceIndex)) {
        return invalid(`${label} contains unregistered ref "${refId}"`);
      }
      if (expectedKind !== null && referenceIndex[refId].kind !== expectedKind) {
        return invalid(`${label} ref "${refId}" has kind "${String(referenceIndex[refId].kind)}", expected "${expectedKind}"`);
      }
    }
    return null;
  };

  // authority refs must be the Manifest authority set（when the role carries them）
  if ('authority_refs' in fields) {
    const authorityRefs = requireStringArray(fields.authority_refs, 'authority_refs');
    if (Array.isArray(authorityRefs)) {
      for (const refId of authorityRefs) {
        if (!authorityRefIds.includes(refId)) {
          return invalid(`authority_refs contains "${refId}" which is not a Manifest authority ref`);
        }
      }
    } else {
      return authorityRefs;
    }
  }
  // proof/goal/acceptance/seam/oracle/risk refs must resolve in the index
  for (const [label, kind] of [
    ['selected_work_item_refs', 'goal'],
    ['stage_goal_refs', 'goal'],
    ['goal_refs', 'goal'],
    ['task_refs', 'task'],
    ['acceptance_refs', 'acceptance'],
    ['seam_refs', 'seam'],
    ['oracle_refs', 'oracle'],
    ['risk_refs', 'risk'],
  ] as const) {
    if (!(label in fields)) continue;
    const check = requireRefsInIndex(fields[label], label, kind);
    if (check !== null) return check;
  }
  // evidence_paths must be declared by the Manifest
  if ('evidence_paths' in fields) {
    const evidencePathsValue = requireStringArray(fields.evidence_paths, 'evidence_paths');
    if (!Array.isArray(evidencePathsValue)) return evidencePathsValue;
    for (const entry of evidencePathsValue) {
      if (!evidencePaths.includes(entry)) {
        return invalid(`evidence_paths contains "${entry}" which is not a Manifest Slice evidence path`);
      }
    }
  }
  // snapshot bindings
  for (const label of ['expected_head', 'integrated_snapshot']) {
    if (!(label in fields)) continue;
    const value = requireStringValue(fields[label], label);
    if (typeof value !== 'string') return value;
    if (value !== resolved.snapshotDigest) {
      return invalid(`${label} "${value}" does not bind the admitted snapshot "${resolved.snapshotDigest}"`);
    }
  }
  // closed vocabulary values
  if ('verification' in fields) {
    const value = requireStringValue(fields.verification, 'verification');
    if (typeof value !== 'string') return value;
    if (value !== 'initial' && value !== 'recheck') {
      return invalid(`verification must be initial|recheck, received "${value}"`);
    }
  }
  if ('evidence_read' in fields && fields.evidence_read !== false) {
    return invalid('evidence_read must be false');
  }
  if ('boundary' in fields) {
    const value = requireStringValue(fields.boundary, 'boundary');
    if (typeof value !== 'string') return value;
    if (value !== 'slice-commit') return invalid(`boundary must be slice-commit, received "${value}"`);
  }
  if ('review_scope' in fields) {
    const value = requireStringValue(fields.review_scope, 'review_scope');
    if (typeof value !== 'string') return value;
    if (value !== 'stage' && value !== 'project') {
      return invalid(`review_scope must be stage|project, received "${value}"`);
    }
  }
  if ('plan_ref' in fields) {
    const value = requireStringValue(fields.plan_ref, 'plan_ref');
    if (typeof value !== 'string') return value;
    if (value !== (manifest.plan as { ref: string }).ref) {
      return invalid('plan_ref does not bind the current Manifest plan ref');
    }
  }
  // receipt refs must be canonical receipt paths
  for (const label of ['receipt_refs', 'changed_files', 'constraints', 'out_of_scope', 'finding_refs', 'limitations']) {
    if (!(label in fields)) continue;
    const values = requireStringArray(fields[label], label);
    if (!Array.isArray(values)) return values;
  }
  if ('receipt_refs' in fields) {
    const receiptRefs = requireStringArray(fields.receipt_refs, 'receipt_refs');
    if (!Array.isArray(receiptRefs)) return receiptRefs;
    for (const entry of receiptRefs) {
      if (!/^\.proofloop\/receipts\/.+\.json$/.test(entry)) {
        return invalid(`receipt_refs contains a non-canonical receipt path "${entry}"`);
      }
    }
  }
  return null;
}

/** Real Receipt semantics（round 6）：content digest + schema + outer
 * tuple + Manifest/Plan payload binding（when present）。语义错误的 Receipt
 * 不得进入 role_fields。 */
function receiptSemanticsOk(
  root: string,
  canonical: string,
  expectedStage: string,
  expectedSlice: string | undefined,
  manifestDigest: string,
  planDigest: string,
): boolean {
  if (!verifyReceiptDigest(canonical)) return false;
  const opened = openNoFollowRead(root, canonical);
  if (!opened.ok) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(opened.fd, 'utf8');
  } catch {
    return false;
  } finally {
    fs.closeSync(opened.fd);
  }
  try {
    const receipt = validateReceipt(JSON.parse(raw) as unknown);
    if (receipt.stage_id !== expectedStage) return false;
    if (expectedSlice !== undefined && receipt.slice_id !== expectedSlice) return false;
    const payload = receipt.payload as Record<string, unknown> | undefined;
    if (payload !== undefined && typeof payload === 'object') {
      if (payload.manifest_digest !== undefined && payload.manifest_digest !== manifestDigest) return false;
      if (payload.plan_digest !== undefined && payload.plan_digest !== planDigest) return false;
    }
    return true;
  } catch {
    return false;
  }
}


/** Reviewer persisted facts（round 5）：real Receipt refs of the review scope
 * （stage-gate/review/integration for Stage Reviewer；project for Project
 * Reviewer）with content-digest validation, plus the Project E2E status. */
function readReviewerFacts(
  root: string,
  stageId: string,
  role: string,
  manifestDigest: string,
  planDigest: string,
): { readonly receiptRefs: string[]; readonly e2eStatus: string | null } {
  const receiptRefs: string[] = [];
  const scan = (directory: string, relativeBase: string, allowedTypes: readonly string[]): void => {
    let names: string[];
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(directory, name);
      const canonical = canonicalPathWithinRoot(root, file);
      if (canonical === null) continue;
      // Round 6: 语义级校验 — content digest + schema + outer stage tuple +
      // Manifest/Plan payload binding + 类型与目录匹配
      if (!receiptSemanticsOk(root, canonical, stageId, undefined, manifestDigest, planDigest)) continue;
      const opened = openNoFollowRead(root, canonical);
      if (!opened.ok) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(opened.fd, 'utf8');
      } catch {
        continue;
      } finally {
        fs.closeSync(opened.fd);
      }
      try {
        const parsed = JSON.parse(raw) as { type?: unknown };
        if (typeof parsed.type === 'string' && allowedTypes.includes(parsed.type)) {
          receiptRefs.push(`${relativeBase}/${name}`);
        }
      } catch {
        // non-JSON files are not Receipt facts
      }
    }
  };
  if (role === 'stage-reviewer') {
    scan(
      path.join(root, '.proofloop', 'receipts', 'stage-gate', stageId),
      `.proofloop/receipts/stage-gate/${stageId}`,
      ['GATE_PASS', 'GATE_FAIL'],
    );
    scan(
      path.join(root, '.proofloop', 'receipts', 'review', stageId),
      `.proofloop/receipts/review/${stageId}`,
      ['STAGE_REVIEW_PASS'],
    );
  } else if (role === 'project-reviewer') {
    const projectDir = path.join(root, '.proofloop', 'receipts', 'project');
    scan(projectDir, '.proofloop/receipts/project', ['PROJECT_REVIEW_PASS', 'PROJECT_E2E_PASS', 'PROJECT_E2E_FAIL']);
    // E2E status from the persisted project Receipts
    let e2eStatus: string | null = null;
    try {
      for (const name of fs.readdirSync(projectDir).filter((entry) => entry.endsWith('.json'))) {
        const file = path.join(projectDir, name);
        const canonical = canonicalPathWithinRoot(root, file);
        if (canonical === null) continue;
        if (!receiptSemanticsOk(root, canonical, stageId, undefined, manifestDigest, planDigest)) continue;
        const opened = openNoFollowRead(root, canonical);
        if (!opened.ok) continue;
        let raw: string;
        try {
          raw = fs.readFileSync(opened.fd, 'utf8');
        } catch {
          continue;
        } finally {
          fs.closeSync(opened.fd);
        }
        try {
          const parsed = JSON.parse(raw) as { type?: unknown };
          if (parsed.type === 'PROJECT_E2E_PASS') e2eStatus = 'passed';
          if (parsed.type === 'PROJECT_E2E_FAIL') e2eStatus = 'failed';
        } catch {
          // ignore
        }
      }
    } catch {
      // no project Receipts yet
    }
    return { receiptRefs: [...new Set(receiptRefs)], e2eStatus };
  }
  return { receiptRefs: [...new Set(receiptRefs)], e2eStatus: null };
}

/** The resolved Manifest record as the kernel type for the verifier. */
function currentManifestForRevalidation(
  resolved: ResolvedManifestAuthority,
): Parameters<typeof verifyVNextWorkerContextBindings>[1] {
  return resolved.manifest as unknown as Parameters<typeof verifyVNextWorkerContextBindings>[1];
}

/** Re-project the Context for the SAME tuple with CURRENT persisted facts
 * （repair round 4）and compare it field-for-field with the read-back
 * Context.  This is the definitive value-level read-back validation: any
 * tampered field（re-digested）that drifts from the current Manifest/
 * Authority/Receipt projection fails closed.  The worker Context is NOT
 * exempt — its dispatch projection（proof_index/scope/mutable_projection）
 * is re-derived the same way. */
function revalidateRoleContext(
  root: string,
  command: CliCommand,
  role: string,
  sliceId: string | undefined,
  taskId: string | undefined,
  readBack: Record<string, unknown>,
  resolved: ResolvedManifestAuthority,
): CliEnvelope | null {
  let expected: Record<string, unknown>;
  try {
    if (role === 'worker') {
      // The worker Context is the dispatch projection; its authoritative
      // value-level validation is the dispatch seam's own binding verifier
      // (proof_index/scope/mutable_projection/task entity re-resolved from
      // the current Manifest).  This works even when every Task of the Slice
      // is already admitted (no next dispatch exists to re-project).
      verifyVNextWorkerContextBindings(
        root,
        currentManifestForRevalidation(resolved),
        readBack as unknown as VNextWorkerContext,
      );
      return null;
    } else {
      const projection = projectVNextRoleContext({
        root,
        manifest: resolved.manifest,
        manifestDigest: resolved.manifestDigest,
        snapshotDigest: resolved.snapshotDigest,
        role,
        stageId: resolved.manifest.stage_id as string,
        sliceId,
        taskId,
        roleFacts: collectRoleFacts(root, role, resolved.manifest.stage_id as string, sliceId, resolved),
      });
      expected = { ...projection.context } as Record<string, unknown>;
    }
  } catch (error) {
    return errorEnvelope(
      command,
      'CONTEXT.ROLE_FIELDS_INVALID',
      `Context cannot be re-projected against current facts: ${errorMessage(error)}`,
    );
  }
  delete expected.context_digest;
  const actual = { ...readBack };
  delete actual.context_digest;
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    return errorEnvelope(
      command,
      'CONTEXT.ROLE_FIELDS_INVALID',
      'Context read-back does not match the current Manifest/Authority/Receipt projection (tampered role fields or tuple bindings)',
    );
  }
  return null;
}

/** Collect persisted facts needed by the active role projections. */
function collectRoleFacts(
  root: string,
  role: string,
  stage: string,
  sliceId: string | undefined,
  resolved: ResolvedManifestAuthority,
): Record<string, unknown> {
  const cvHistory = role === 'cv' && sliceId !== undefined
    ? readCvRepairHistory(
        root,
        stage,
        sliceId,
        resolved.manifest,
        resolved.manifestDigest,
        (resolved.manifest.plan as { plan_digest: string }).plan_digest,
        resolved.snapshotDigest,
      )
    : { hasRepair: false, counterexamples: [], requiredRecheckScope: [] };
  const reviewerFacts = role === 'stage-reviewer' || role === 'project-reviewer'
    ? readReviewerFacts(
        root,
        stage,
        role,
        resolved.manifestDigest,
        (resolved.manifest.plan as { plan_digest: string }).plan_digest,
      )
    : { receiptRefs: [], e2eStatus: null };
  return {
    cvRepairHistory: role === 'cv' ? cvHistory : undefined,
    receiptRefs: role === 'stage-reviewer' || role === 'project-reviewer' ? reviewerFacts.receiptRefs : [],
    e2eStatus: role === 'project-reviewer' ? reviewerFacts.e2eStatus : undefined,
  };
}

/** Project（read-only）the Context for the given role/stage/slice/task tuple。 */
function projectContext(
  root: string,
  command: CliCommand,
  params: ContextOperationParams,
  stage: string,
  resolved: ResolvedManifestAuthority,
): CliEnvelope {
  if (params.role === 'worker') {
    try {
      const dispatch = projectWorkerDispatch(root, resolved, params.slice);
      // S10-B-T02 repair round 3: a requested task must bind the dispatched
      // task — ignoring the request tuple is rejected.
      if (params.task !== undefined && dispatch.task_id !== params.task) {
        return errorEnvelope(
          command,
          'CONTEXT.TUPLE_MISMATCH',
          `requested task "${params.task}" does not match the dispatched task "${dispatch.task_id}"`,
        );
      }
      return okEnvelopeWithRefs(
        command,
        {
          role: 'worker',
          context_ref: dispatch.context_ref,
          context_digest: dispatch.context.context_digest,
          context: dispatch.context,
        },
        [{ ref: dispatch.context_ref, digest: dispatch.context.context_digest }],
      );
    } catch (error) {
      return blockedEnvelope(command, error);
    }
  }
  try {
    const projection = projectVNextRoleContext({
      root,
      manifest: resolved.manifest,
      manifestDigest: resolved.manifestDigest,
      snapshotDigest: resolved.snapshotDigest,
      role: params.role as string,
      stageId: stage,
      sliceId: params.slice,
      taskId: params.task,
      roleFacts: collectRoleFacts(root, params.role as string, stage, params.slice, resolved),
    });
    return okEnvelopeWithRefs(
      command,
      {
        role: projection.role,
        context_ref: projection.context_ref,
        context_digest: projection.context.context_digest,
        context: projection.context,
      },
      [{ ref: projection.context_ref, digest: projection.context.context_digest }],
    );
  } catch (error) {
    return blockedEnvelope(command, error);
  }
}

/** Attach the CV Evidence read gate status to a projected/read-back Context
 * （round 2：only the PERSISTED Runtime observation record satisfies the gate）。 */
function gateStatusForContext(
  root: string,
  command: CliCommand,
  context: VNextRoleContext,
  observationRef: string | undefined,
): CliEnvelope | { readonly required: 'refutation-observation'; readonly satisfied: boolean } {
  const required = context.evidence_read_gate?.required ?? null;
  if (required === null) {
    return { required: 'refutation-observation', satisfied: false };
  }
  if (observationRef === undefined) {
    return { required, satisfied: false };
  }
  const record = readObservationRecord(root, command, observationRef);
  if (!('ok' in record) && 'stage_id' in record) {
    const observation = record as VNextRefutationObservation;
    const binding = verifyVNextRefutationObservationBinding(root, observation, context);
    if (!binding.ok) {
      return errorEnvelope(
        command,
        'CONTEXT.OBSERVATION_INVALID',
        `refutation observation does not bind the Context Evidence tuple: ${binding.field} — ${binding.message}`,
      );
    }
    // repair round 3: admission provenance — the referenced CV Context must
    // exist on disk, be digest-self-consistent and match this Evidence tuple.
    const cvRef = validateContextRef(root, command, observation.cv_context_ref);
    if (typeof cvRef !== 'string') return cvRef as CliEnvelope;
    const cvCanonical = canonicalPathWithinRoot(root, observation.cv_context_ref) as string;
    const cvOpened = openNoFollowRead(root, cvCanonical);
    if (!cvOpened.ok) {
      return errorEnvelope(
        command,
        'CONTEXT.OBSERVATION_INVALID',
        'observation provenance CV Context is not a persisted Runtime record',
      );
    }
    let cvRaw: string;
    try {
      cvRaw = fs.readFileSync(cvOpened.fd, 'utf8');
    } finally {
      fs.closeSync(cvOpened.fd);
    }
    let cvParsed: unknown;
    try {
      cvParsed = JSON.parse(cvRaw) as unknown;
    } catch {
      return errorEnvelope(command, 'CONTEXT.OBSERVATION_INVALID', 'observation provenance CV Context is not valid JSON');
    }
    if (typeof cvParsed !== 'object' || cvParsed === null) {
      return errorEnvelope(command, 'CONTEXT.OBSERVATION_INVALID', 'observation provenance CV Context is not a JSON object');
    }
    const cvRecord = cvParsed as Record<string, unknown>;
    const cvWithoutDigest = { ...cvRecord } as Record<string, unknown>;
    delete cvWithoutDigest.context_digest;
    if (
      cvRecord.schema_version !== 2 ||
      cvRecord.role !== 'cv' ||
      cvRecord.context_digest !== observation.cv_context_digest ||
      computeDigest(cvWithoutDigest) !== observation.cv_context_digest ||
      cvRecord.stage_id !== context.stage_id ||
      cvRecord.slice_id !== context.slice_id ||
      cvRecord.task_id !== context.task_id ||
      // round 5: provenance 一致性 — 被引用的 CV Context 必须同样是 seam 产物
      cvRecord.created_by !== 'vnext-runtime-seam' ||
      observation.created_by !== 'vnext-runtime-seam'
    ) {
      return errorEnvelope(
        command,
        'CONTEXT.OBSERVATION_INVALID',
        'observation provenance CV Context does not bind this Evidence tuple (or carries no Runtime admission provenance)',
      );
    }
    return { required, satisfied: true };
  }
  return record as CliEnvelope;
}

// ============================================================
// context prepare
// ============================================================

function runContextPrepare(
  root: string,
  command: CliCommand,
  params: ContextOperationParams,
): CliEnvelope {
  if (params.role === undefined) {
    return errorEnvelope(
      command,
      'CONTEXT.ROLE_REQUIRED',
      `context prepare requires --role <role> (closed set: ${VNEXT_CONTEXT_ROLES.join('|')})`,
    );
  }
  if (!isVNextContextRole(params.role)) {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      `unknown role "${params.role}" (closed set: ${VNEXT_CONTEXT_ROLES.join('|')})`,
    );
  }
  const stageResult = requireStage(command, params.stage);
  if ('stage' in stageResult) {
    const resolved = resolveManifestAuthority(root, command, stageResult.stage);
    if (!('manifest' in resolved)) return resolved;
    const projected = projectContext(root, command, params, stageResult.stage, resolved);
    if (!projected.ok) return projected;
    // 全部角色经 Runtime seam write-once 落盘（contract 0.5：
    // 所有 Context 写入 .proofloop/context/<digest>.json，已有文件不覆盖）
    try {
      if (params.role === 'worker') {
        persistVNextWorkerContext(root, projectWorkerDispatch(root, resolved, params.slice));
      } else {
        persistVNextRoleContext(
          root,
          projectVNextRoleContext({
            root,
            manifest: resolved.manifest,
            manifestDigest: resolved.manifestDigest,
            snapshotDigest: resolved.snapshotDigest,
            role: params.role,
            stageId: stageResult.stage,
            sliceId: params.slice,
            taskId: params.task,
            roleFacts: collectRoleFacts(root, params.role, stageResult.stage, params.slice, resolved),
          }),
        );
      }
    } catch (error) {
      return blockedEnvelope(command, error);
    }
    return projected;
  }
  return stageResult;
}

// ============================================================
// context show（read-only）
// ============================================================

function runContextShow(
  root: string,
  command: CliCommand,
  params: ContextOperationParams,
): CliEnvelope {
  if (params.role === undefined) {
    return errorEnvelope(
      command,
      'CONTEXT.ROLE_REQUIRED',
      `context show requires --role <role> (closed set: ${VNEXT_CONTEXT_ROLES.join('|')})`,
    );
  }
  if (!isVNextContextRole(params.role)) {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      `unknown role "${params.role}" (closed set: ${VNEXT_CONTEXT_ROLES.join('|')})`,
    );
  }
  const stageResult = requireStage(command, params.stage);
  if (!('stage' in stageResult)) return stageResult;

  // --ref 读回模式：显示已投影（落盘）Context，校验 digest 自洽 + role 匹配
  if (params.ref !== undefined) {
    const refResult = validateContextRef(root, command, params.ref);
    if (typeof refResult !== 'string') return refResult;
    const canonical = canonicalPathWithinRoot(root, params.ref) as string;
    const opened = openNoFollowRead(root, canonical);
    if (!opened.ok) {
      return errorEnvelope(command, 'CONTEXT.NOT_FOUND', `Context "${params.ref}" is not a readable root-bound file`);
    }
    let raw: string;
    try {
      raw = fs.readFileSync(opened.fd, 'utf8');
    } finally {
      fs.closeSync(opened.fd);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return errorEnvelope(command, 'CONTEXT.INVALID', `Context "${params.ref}" is not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return errorEnvelope(command, 'CONTEXT.INVALID', `Context "${params.ref}" must be a JSON object`);
    }
    const context = parsed as VNextRoleContext;
    if (context.schema_version !== 2 || typeof context.context_digest !== 'string') {
      return errorEnvelope(command, 'CONTEXT.INVALID', `Context "${params.ref}" is not a v2 Context`);
    }
    const refDigest = params.ref.replace(/^\.proofloop\/context\//, '').replace(/\.json$/, '');
    if (context.context_digest !== refDigest) {
      return errorEnvelope(command, 'CONTEXT.INVALID', `Context digest does not match its digest-addressed ref`);
    }
    const withoutDigest = { ...context } as Record<string, unknown>;
    delete withoutDigest.context_digest;
    if (computeDigest(withoutDigest) !== context.context_digest) {
      return errorEnvelope(command, 'CONTEXT.INVALID', 'Context content does not match its context_digest');
    }
    // 跨角色复用拒绝：Context 的 role（或 worker 缺省 role）必须匹配请求 role
    const contextRole = context.role ?? 'worker';
    if (contextRole !== params.role) {
      return errorEnvelope(
        command,
        'CONTEXT.ROLE_MISMATCH',
        `Context role "${contextRole}" does not match requested role "${params.role}"; a Context cannot be reused across roles`,
      );
    }
    // S10-B-T02 repair: 重验证 root / Manifest / Plan / snapshot 与当前绑定
    // （跨项目或 stale Context fail closed）
    if (context.root_path !== root || context.root_digest !== computeDigest(root)) {
      return errorEnvelope(
        command,
        'CONTEXT.ROOT_MISMATCH',
        `Context root binding does not match the current project root (cross-project Context reuse rejected)`,
      );
    }
    const currentResolved = resolveManifestAuthority(root, command, stageResult.stage);
    if (!('manifest' in currentResolved)) return currentResolved;
    if (context.manifest_digest !== currentResolved.manifestDigest) {
      return errorEnvelope(
        command,
        'CONTEXT.MANIFEST_BINDING',
        `Context manifest_digest is stale: it does not bind the current Manifest "${stageResult.stage}"`,
      );
    }
    if (context.plan_digest !== (currentResolved.manifest.plan as { plan_digest: string }).plan_digest) {
      return errorEnvelope(
        command,
        'CONTEXT.MANIFEST_BINDING',
        'Context plan_digest is stale: it does not bind the current Manifest Plan',
      );
    }
    if (context.snapshot_digest !== currentResolved.snapshotDigest) {
      return errorEnvelope(
        command,
        'CONTEXT.SNAPSHOT_BINDING',
        `Context snapshot_digest is stale: it does not bind the admitted snapshot "${currentResolved.snapshotDigest}"`,
      );
    }
    // S10-B-T02 repair round 2: Manifest reference binding revalidation —
    // a changed reference SOURCE (file/section digest drift) fails closed
    // even when the Manifest digest itself is unchanged.
    try {
      assertVNextManifestReferenceBindings(root, currentResolved.manifest as never);
    } catch (error) {
      return errorEnvelope(
        command,
        'CONTEXT.REFERENCE_MISMATCH',
        `Manifest reference bindings are stale: ${errorMessage(error)}`,
      );
    }
    // stage/slice/task 与当前 Manifest/Plan 绑定比较 + 请求 tuple 一致性
    if (context.stage_id !== stageResult.stage) {
      return errorEnvelope(
        command,
        'CONTEXT.MANIFEST_BINDING',
        `Context stage_id "${String(context.stage_id)}" does not bind the requested stage "${stageResult.stage}"`,
      );
    }
    if (params.slice !== undefined && context.slice_id !== params.slice) {
      return errorEnvelope(
        command,
        'CONTEXT.TUPLE_MISMATCH',
        `requested slice "${params.slice}" does not match Context slice_id "${String(context.slice_id)}"`,
      );
    }
    if (params.task !== undefined && context.task_id !== params.task) {
      return errorEnvelope(
        command,
        'CONTEXT.TUPLE_MISMATCH',
        `requested task "${params.task}" does not match Context task_id "${String(context.task_id)}"`,
      );
    }
    const manifestSlices = Array.isArray(currentResolved.manifest.slices)
      ? (currentResolved.manifest.slices as Array<Record<string, unknown>>)
      : [];
    if (context.slice_id !== undefined && !manifestSlices.some((slice) => slice.slice_id === context.slice_id)) {
      return errorEnvelope(
        command,
        'CONTEXT.MANIFEST_BINDING',
        `Context slice_id "${context.slice_id}" is not declared by the current Manifest`,
      );
    }
    if (context.task_id !== undefined) {
      const boundSlice = manifestSlices.find((slice) => slice.slice_id === context.slice_id);
      const referenceIndex = (currentResolved.manifest.reference_index ?? {}) as Record<string, Record<string, unknown>>;
      const declaredTasks: string[] = [];
      if (boundSlice !== undefined) {
        const proofIndex = boundSlice.proof_index as Record<string, unknown> | undefined;
        const taskRefs = Array.isArray(proofIndex?.task_refs) ? (proofIndex.task_refs as string[]) : [];
        for (const refId of taskRefs) {
          const descriptor = referenceIndex[refId];
          if (descriptor?.kind !== 'task' || typeof descriptor.ref !== 'string') continue;
          const match = /#\/entities\/([^/]+)$/.exec(descriptor.ref);
          if (match?.[1] !== undefined) declaredTasks.push(match[1]);
        }
      }
      if (!declaredTasks.includes(context.task_id)) {
        return errorEnvelope(
          command,
          'CONTEXT.MANIFEST_BINDING',
          `Context task_id "${context.task_id}" is not bound to the current Manifest Slice`,
        );
      }
    }
    // role_fields 快速字段检查 + 完整重投影逐值比较（round 4：worker 不豁免）
    const roleFieldsCheck = validateRoleFields(root, command, contextRole, context.role_fields, currentResolved);
    if (roleFieldsCheck !== null) return roleFieldsCheck;
    const recheck = revalidateRoleContext(
      root,
      command,
      contextRole,
      context.slice_id,
      context.task_id,
      context as unknown as Record<string, unknown>,
      currentResolved,
    );
    if (recheck !== null) return recheck;
    const gate = gateStatusForContext(root, command, context, params.observationRef);
    if ('required' in gate) {
      return okEnvelope(command, { context_ref: params.ref, context_digest: context.context_digest, context, gate });
    }
    return gate;
  }

  // 投影模式（read-only）：与 prepare 相同规则，不写盘
  const resolved = resolveManifestAuthority(root, command, stageResult.stage);
  if (!('manifest' in resolved)) return resolved;
  const projected = projectContext(root, command, params, stageResult.stage, resolved);
  if (!projected.ok) return projected;
  const context = (projected.result as { context: VNextRoleContext }).context;
  const gate = gateStatusForContext(root, command, context, params.observationRef);
  if ('required' in gate) {
    return okEnvelopeWithRefs(
      command,
      {
        role: params.role,
        context_ref: (projected.result as { context_ref: string }).context_ref,
        context_digest: context.context_digest,
        context,
        gate,
      },
      projected.refs,
    );
  }
  return gate;
}

// ============================================================
// context admit-refutation-observation
// ============================================================

function runContextAdmitRefutationObservation(
  root: string,
  command: CliCommand,
  params: ContextOperationParams,
): CliEnvelope {
  if (params.role === undefined) {
    return errorEnvelope(
      command,
      'CONTEXT.ROLE_REQUIRED',
      'context admit-refutation-observation requires --role cv (CV-only operation)',
    );
  }
  if (params.role !== 'cv') {
    return errorEnvelope(
      command,
      'CONTEXT.CV_ONLY',
      `context admit-refutation-observation is CV-only; role "${params.role}" is not authorized`,
    );
  }
  if (params.observation === undefined || params.observation.trim().length === 0) {
    return errorEnvelope(
      command,
      'CONTEXT.OBSERVATION_REQUIRED',
      'context admit-refutation-observation requires a non-empty observation (--observation <text> or request field "observation")',
    );
  }
  if (params.slice === undefined) {
    return errorEnvelope(
      command,
      'CONTEXT.SLICE_REQUIRED',
      'context admit-refutation-observation requires a slice (--slice <slice-id> or request field "slice")',
    );
  }
  if (params.task === undefined) {
    return errorEnvelope(
      command,
      'CONTEXT.TASK_REQUIRED',
      'context admit-refutation-observation requires a task (--task <task-id> or request field "task")',
    );
  }
  const stageResult = requireStage(command, params.stage);
  if (!('stage' in stageResult)) return stageResult;
  const stage = stageResult.stage;

  let manifest: Record<string, unknown>;
  try {
    manifest = readVNextManifest(root, `.proofloop/manifests/${stage}.json`) as unknown as Record<string, unknown>;
  } catch (error) {
    return errorEnvelope(
      command,
      'CONTEXT.MANIFEST_NOT_FOUND',
      `Manifest ".proofloop/manifests/${stage}.json" cannot be read as an admitted v2 Manifest: ${errorMessage(error)}`,
    );
  }
  const slices = Array.isArray(manifest.slices) ? (manifest.slices as Array<Record<string, unknown>>) : [];
  const slice = slices.find((candidate) => candidate.slice_id === params.slice);
  if (slice === undefined) {
    return errorEnvelope(command, 'CONTEXT.SLICE_NOT_FOUND', `slice "${params.slice}" is not declared by the Manifest`);
  }
  const proofIndex = slice.proof_index as Record<string, unknown> | undefined;
  const taskRefs = Array.isArray(proofIndex?.task_refs) ? (proofIndex.task_refs as string[]) : [];
  const referenceIndex = (manifest.reference_index ?? {}) as Record<string, Record<string, unknown>>;
  const declaredTasks = taskRefs
    .map((refId) => {
      const descriptor = referenceIndex[refId];
      if (descriptor?.kind !== 'task' || typeof descriptor.ref !== 'string') return null;
      const match = /#\/entities\/([^/]+)$/.exec(descriptor.ref);
      return match?.[1] ?? null;
    })
    .filter((value): value is string => value !== null);
  if (!declaredTasks.includes(params.task)) {
    return errorEnvelope(command, 'CONTEXT.TASK_NOT_FOUND', `task "${params.task}" is not bound to Slice "${params.slice}"`);
  }
  const evidencePath = typeof slice.evidence_path === 'string' ? slice.evidence_path : null;
  if (evidencePath === null) {
    return errorEnvelope(command, 'CONTEXT.MANIFEST_BINDING', `Slice "${params.slice}" carries no evidence_path`);
  }
  let authority: VNextAdmissionAuthority;
  try {
    authority = readCurrentEpochAuthority(root, stage);
  } catch (error) {
    return errorEnvelope(
      command,
      'CONTEXT.ADMISSION_AUTHORITY_MISSING',
      `Stage Plan admission + fresh SPV authority are required for a digest-bound observation: ${errorMessage(error)}`,
    );
  }
  // S10-B-T02 repair round 3: the CV Context must already exist（先 prepare
  // cv 落盘）— 公开命令不得在无 CV Context 时生成 observation 记录。
  const cvContext = findCvContext(
    root,
    stage,
    params.slice,
    params.task,
    computeDigest(manifest),
    (manifest.plan as { plan_digest: string }).plan_digest,
    authority.spv.snapshot_digest,
  );
  if (cvContext === null) {
    return errorEnvelope(
      command,
      'CONTEXT.CV_CONTEXT_REQUIRED',
      `refutation observation requires the CV Context of slice "${params.slice}" task "${params.task}" to exist first (run context prepare --role cv first)`,
    );
  }
  try {
    const projection = projectVNextRefutationObservation({
      root,
      stageId: stage,
      sliceId: params.slice,
      taskId: params.task,
      evidencePath,
      snapshotDigest: authority.spv.snapshot_digest,
      observation: params.observation,
      cvContextRef: cvContext.ref,
      cvContextDigest: cvContext.digest,
      recordedAt: new Date().toISOString(),
    });
    // S10-B-T02 repair round 2: the observation is PERSISTED write-once by
    // the Runtime seam (.proofloop/context/<context_digest>.json) — the CV
    // gate only accepts this persisted record, never caller-declared JSON.
    persistVNextRefutationObservation(root, projection);
    return okEnvelopeWithRefs(
      command,
      {
        ref: projection.ref,
        digest: projection.observation.context_digest,
        observation: projection.observation,
      },
      [{ ref: projection.ref, digest: projection.observation.context_digest }],
    );
  } catch (error) {
    return blockedEnvelope(command, error);
  }
}

// ============================================================
// context domain dispatch
// ============================================================

/** Run a closed context-domain operation and return the canonical envelope. */
export function runContext(
  root: string,
  _rootSource: 'explicit' | 'auto',
  command: CliCommand,
  params: ContextOperationParams,
): CliEnvelope {
  switch (command.operation) {
    case 'prepare':
      return runContextPrepare(root, command, params);
    case 'show':
      return runContextShow(root, command, params);
    case 'admit-refutation-observation':
      return runContextAdmitRefutationObservation(root, command, params);
    default:
      // Defensive: the dispatcher closed registry rejects unknown operations
      // before any handler runs; this branch never emits a write.
      return errorEnvelope(
        command,
        'RUNTIME.SCHEMA_MISMATCH',
        `unknown context operation "${String(command.operation)}" (closed set: prepare|show|admit-refutation-observation)`,
      );
  }
}

// ============================================================
// Handler-direct argv entry（canonical root assertion + unified request）
// ============================================================

/**
 * Handler-direct entry for the context domain: parses the closed flag set,
 * asserts the canonical trust root, resolves the unified request input and
 * dispatches `runContext`.  This is the seam the built dist smoke exercises
 * with a real process; the public `proofloop <domain> <operation>` dispatcher
 * wiring follows the S10-B-T01 precedent (Runtime direct-fix).
 */
export function runContextFromArgv(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): CliEnvelope {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const command: CliCommand = {
    domain: argv[0] ?? 'context',
    operation: argv[1] ?? null,
  };
  if (command.domain !== 'context') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `unknown domain "${command.domain}" (context entry)`,
    );
  }
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv.slice(2));
  } catch (error) {
    return errorEnvelope(
      command,
      'USAGE',
      `usage: proofloop context <operation> [flags] — ${errorMessage(error)}`,
    );
  }
  let root: string;
  try {
    root = resolveTrustRoot({ explicitRoot: parsed.projectRoot ?? env.PROOFLOOP_ROOT, cwd }).root;
  } catch (error) {
    return errorEnvelope(command, errorMessage(error), errorMessage(error));
  }
  const requestValidation = resolveRequestInput(root, command, parsed);
  if (!requestValidation.ok) {
    return errorEnvelope(command, requestValidation.code, requestValidation.message);
  }
  return runContext(root, 'auto', command, collectContextParams(parsed, requestValidation.request));
}

if (require.main === module) {
  process.exitCode = runContextFromArgv(process.argv.slice(2)).ok ? 0 : 2;
}
