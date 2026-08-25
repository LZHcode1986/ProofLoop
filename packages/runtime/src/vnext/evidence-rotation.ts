/**
 * S15-A-T01 — Replan Evidence rotation core (Runtime-owned, root-bound).
 *
 * The rotation core accepts a Runtime-derived `ReplanDisposition` (§8.8 closed
 * schema) and the old Evidence binding, and performs the post-admission
 * Evidence rotation transaction:
 *
 *   - preflight (zero writes) — disposition closed-schema validation,
 *     root-bound evidence path, old Evidence identity/binding verification,
 *     append-only history target, unrecovered-journal detection;
 *   - journal write (root-bound, atomic);
 *   - CAS archive of the old Evidence to
 *     `delivery/stages/<stage>/evidence/history/<parent_epoch_digest>/<slice>.md`;
 *   - CAS swap of the canonical Evidence file to the new skeleton with the
 *     carry-forward Task Evidence content preserved byte-for-byte;
 *   - journal removal; interrupted transactions are recoverable (complete) or
 *     rollback-able, and every fail-closed condition reports
 *     `REPLAN.EVIDENCE_ROTATION_BLOCKED` with zero writes or a journal rollback.
 *
 * This module is the core only; the public `plan refresh-evidence(mode=replan)`
 * seam wiring lives in the refresh CLI path (S15-A-T02).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest, isCanonicalStageId } from '@proofloop/kernel';
import {
  errorMessage,
  ensureDirectoryNoFollow,
  openVerifiedDirectory,
  parseEvidencePlanBinding,
  resolveProjectRoot,
  resolveRootBoundPath,
  vnextError,
  type VNextCliError,
} from '../cli/vnext-cli-support-vnext';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';

/** Root-bound transaction journal file name (lives in the Evidence directory). */
export const REPLAN_JOURNAL_FILE = '.vnext-replan-journal.json';

/** Fail-closed error type for every Replan Evidence rotation blocker. */
export const REPLAN_EVIDENCE_ROTATION_BLOCKED = 'REPLAN.EVIDENCE_ROTATION_BLOCKED';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA1_HEX = /^[0-9a-f]{40}$/;
const TASK_ID_GRAMMAR = /^S\d+-[A-Z0-9]+-T\d+$/;

/** Impact scope of a Runtime-derived Replan disposition (§8.1/§8.8): the
 *  closed four-state scope. `stage-wide` re-establishes every execution fact
 *  of the Stage; `slice-wide` is precise (target + transitive downstream
 *  Slices). */
export type ReplanImpactScope = 'task-local' | 'slice-wide' | 'stage-wide';

/**
 * Replan disposition — closed schema (§8.8).  Runtime-derived; the rotation
 * core validates it fail-closed and never re-derives impact.
 */
export interface ReplanDisposition {
  readonly schema_version: 1;
  readonly stage_id: string;
  readonly parent_epoch_digest: string;
  readonly impact_scope: ReplanImpactScope;
  readonly changed_task_ids: readonly string[];
  readonly carry_forward_task_ids: readonly string[];
  readonly invalidated_task_ids: readonly string[];
  readonly previous_manifest_digest: string;
  readonly manifest_digest: string;
  readonly previous_plan_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
}

export function parseReplanDisposition(value: unknown): ReplanDisposition | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const required: ReadonlyArray<keyof ReplanDisposition> = [
    'schema_version',
    'stage_id',
    'parent_epoch_digest',
    'impact_scope',
    'changed_task_ids',
    'carry_forward_task_ids',
    'invalidated_task_ids',
    'previous_manifest_digest',
    'manifest_digest',
    'previous_plan_digest',
    'plan_digest',
    'snapshot_digest',
  ];
  if (required.some((field) => !(field in record))) return null;
  const unknown = Object.keys(record).filter((field) => !(required as readonly string[]).includes(field));
  if (unknown.length > 0) return null; // closed schema

  if (record.schema_version !== 1) return null;
  const stageId = record.stage_id;
  if (typeof stageId !== 'string' || !isCanonicalStageId(stageId)) return null;
  const parentEpochDigest = record.parent_epoch_digest;
  if (typeof parentEpochDigest !== 'string' || !SHA256_HEX.test(parentEpochDigest)) return null;
  const impactScope = record.impact_scope;
  if (impactScope !== 'task-local' && impactScope !== 'slice-wide' && impactScope !== 'stage-wide') return null;

  const readTaskIds = (field: string): readonly string[] | null => {
    const value = record[field];
    if (!Array.isArray(value)) return null;
    const taskIds = value as unknown[];
    if (taskIds.some((id) => typeof id !== 'string')) return null;
    const ids = taskIds as string[];
    if (ids.some((id) => !TASK_ID_GRAMMAR.test(id) || !id.startsWith(`${stageId}-`))) return null;
    return ids;
  };

  const changed = readTaskIds('changed_task_ids');
  const carried = readTaskIds('carry_forward_task_ids');
  const invalidated = readTaskIds('invalidated_task_ids');
  if (changed === null || carried === null || invalidated === null) return null;
  // §8.1: a stage-wide disposition re-establishes the whole Stage from Stage
  // Contract / global Authority binding changes alone — every Task contract
  // digest may be unchanged, so an EMPTY changed root is valid ONLY for
  // stage-wide. task-local and slice-wide must always name their changed
  // root Tasks; every resolved scope must invalidate a non-empty set.
  if (changed.length === 0 && impactScope !== 'stage-wide') return null;
  if (invalidated.length === 0) return null;

  // Cross-field rules (§8.8): a replanned Task is never carried forward; the
  // invalidated set covers every changed Task plus the affected closure.
  // stage-wide re-runs the whole Stage, so it never carries anything forward.
  const changedSet = new Set(changed);
  const carriedSet = new Set(carried);
  const invalidatedSet = new Set(invalidated);
  if (carriedSet.size !== carried.length) return null; // duplicates are forged
  if (invalidatedSet.size !== invalidated.length) return null;
  if (new Set(changed).size !== changed.length) return null;
  if (impactScope === 'stage-wide' && carried.length > 0) return null;
  if (changed.some((id) => carriedSet.has(id))) return null;
  if (invalidated.some((id) => carriedSet.has(id))) return null;
  if (!changed.every((id) => invalidatedSet.has(id))) return null;

  const readHex = (field: string, pattern: RegExp): string | null => {
    const value = record[field];
    if (typeof value !== 'string' || !pattern.test(value)) return null;
    return value;
  };
  const previousManifestDigest = readHex('previous_manifest_digest', SHA256_HEX);
  const manifestDigest = readHex('manifest_digest', SHA256_HEX);
  const previousPlanDigest = readHex('previous_plan_digest', SHA256_HEX);
  const planDigest = readHex('plan_digest', SHA256_HEX);
  const snapshotDigest = readHex('snapshot_digest', GIT_SHA1_HEX);
  if (
    previousManifestDigest === null ||
    manifestDigest === null ||
    previousPlanDigest === null ||
    planDigest === null ||
    snapshotDigest === null
  ) {
    return null;
  }

  return {
    schema_version: 1,
    stage_id: stageId,
    parent_epoch_digest: parentEpochDigest,
    impact_scope: impactScope,
    changed_task_ids: changed,
    carry_forward_task_ids: carried,
    invalidated_task_ids: invalidated,
    previous_manifest_digest: previousManifestDigest,
    manifest_digest: manifestDigest,
    previous_plan_digest: previousPlanDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
  };
}

export function computeReplanDispositionDigest(disposition: ReplanDisposition): string {
  return computeDigest(disposition);
}

export type ReplanRotationMode = 'rotate' | 'recover' | 'rollback';

export interface ReplanRotationRequest {
  readonly root?: string;
  readonly disposition: ReplanDisposition;
  readonly sliceId: string;
  /** Root-relative canonical Evidence file (e.g. delivery/stages/S13/evidence/S13-A.md). */
  readonly evidencePath: string;
  /** New canonical skeleton content (rendered from the new Manifest by the caller). */
  readonly newSkeleton: string;
  readonly mode?: ReplanRotationMode;
}

export interface ReplanRotationResult {
  readonly success: boolean;
  readonly stage_id: string;
  readonly slice_id: string;
  readonly disposition_digest: string;
  /** Root-relative history archive path ('' when no archive was written). */
  readonly archive_path: string;
  readonly recovered: boolean;
  readonly rolled_back: boolean;
  readonly blocked_recovery: boolean;
  readonly errors: readonly VNextCliError[];
}

/** Journal payload schema version. */
const JOURNAL_VERSION = 1;

interface RotationJournal {
  readonly version: 1;
  readonly stage_id: string;
  readonly slice_id: string;
  readonly disposition_digest: string;
  readonly evidence_path: string; // root-relative
  readonly archive_path: string; // root-relative
  readonly old_content: string;
  readonly new_content: string;
  readonly old_identity: string; // "dev:ino"
}

function blocked(reason: string): VNextCliError {
  return vnextError(REPLAN_EVIDENCE_ROTATION_BLOCKED, reason);
}

function blockedResult(
  stageId: string,
  sliceId: string,
  dispositionDigest: string,
  errors: VNextCliError[],
): ReplanRotationResult {
  return {
    success: false,
    stage_id: stageId,
    slice_id: sliceId,
    disposition_digest: dispositionDigest,
    archive_path: '',
    recovered: false,
    rolled_back: false,
    blocked_recovery: false,
    errors,
  };
}

function successResult(
  stageId: string,
  sliceId: string,
  dispositionDigest: string,
  archivePath: string,
  extra: Partial<Pick<ReplanRotationResult, 'recovered' | 'rolled_back'>>,
): ReplanRotationResult {
  return {
    success: true,
    stage_id: stageId,
    slice_id: sliceId,
    disposition_digest: dispositionDigest,
    archive_path: archivePath,
    recovered: extra.recovered ?? false,
    rolled_back: extra.rolled_back ?? false,
    blocked_recovery: false,
    errors: [],
  };
}

/** Capture `dev:ino` of an open regular file as the identity token. */
function identityOf(fd: number): string {
  const stat = fs.fstatSync(fd);
  return `${stat.dev}:${stat.ino}`;
}

/**
 * No-replace atomic install inside a verified directory (CAS).  Temp write +
 * fsync + hard link; `linkSync` never overwrites an existing target, so a
 * concurrent creator wins and this fails closed.  Temp cleanup uses `rmSync`
 * (not `unlinkSync`) so injected interruption hooks only ever observe the
 * journal removal itself.
 */
function installNoReplace(
  procPrefix: string,
  fileName: string,
  content: string,
): { ok: true } | { ok: false; message: string } {
  if (fileName.length === 0 || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
    return { ok: false, message: `invalid file name "${fileName}"` };
  }
  const target = `${procPrefix}/${fileName}`;
  const tempName = `.${fileName}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const temp = `${procPrefix}/${tempName}`;
  let fd: number | undefined;
  let linked = false;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error('short write during atomic install');
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temp, target);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, message: 'target already exists (CAS no-replace) — refusing to overwrite' };
      }
      throw error;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `atomic install failed: ${errorMessage(error)}` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // best effort; the target is already a complete hard link if `linked`
    }
  }
}

interface OpenEvidence {
  readonly content: string;
  readonly identity: string;
}

/** Read the canonical Evidence file no-follow; fail closed on symlink/missing. */
function readEvidenceNoFollow(root: string, evidencePath: string): OpenEvidence | null {
  const opened = openNoFollowRead(root, evidencePath);
  if (!opened.ok) {
    return null;
  }
  try {
    const content = fs.readFileSync(opened.fd, 'utf8');
    return { content, identity: identityOf(opened.fd) };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(opened.fd);
    } catch {
      // best effort
    }
  }
}

/** Resolve the root-relative Evidence directory for a root-relative file path. */
function evidenceDirectoryOf(root: string, evidencePath: string): string {
  const canonical = resolveRootBoundPath(root, evidencePath, 'evidence-path');
  const dir = path.posix.dirname(evidencePath);
  const canonicalDir = resolveRootBoundPath(root, dir, 'evidence-dir');
  void canonical;
  void canonicalDir;
  return dir;
}

/**
 * Extract the `### <task-id>` Task Evidence block from old Evidence content.
 * Blocks live under the `## Task Evidence` section; a block runs from its
 * `### <task-id>` heading to the next `### `/`## ` heading or EOF.
 */
function extractTaskEvidenceBlock(content: string, taskId: string): string | null {
  const header = `### ${taskId}`;
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return null;
  const block: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > start && (line.startsWith('### ') || line.startsWith('## '))) break;
    block.push(line);
  }
  return block.join('\n');
}

/**
 * Build the new canonical content: the caller-rendered skeleton with the
 * `## Task Evidence` placeholder replaced by the preserved carry-forward Task
 * Evidence blocks (byte-for-byte) plus the placeholder for invalidated Tasks.
 */
function buildRotatedContent(newSkeleton: string, carriedBlocks: readonly string[]): string {
  if (carriedBlocks.length === 0) return newSkeleton;
  const sectionHeader = '## Task Evidence';
  const lines = newSkeleton.split('\n');
  const start = lines.findIndex((line) => line.trim() === sectionHeader);
  if (start === -1) return newSkeleton;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  const head = lines.slice(0, start + 1);
  const tail = lines.slice(end);
  const placeholderLine = lines.slice(start + 1, end).find((line) => line.trim() === '*Not yet captured.*');
  const body = [...carriedBlocks];
  if (placeholderLine !== undefined) {
    body.push(placeholderLine.trim());
  }
  return [...head, ...body, ...tail].join('\n');
}

function taskIdsOfSlice(ids: readonly string[], sliceId: string): string[] {
  return ids.filter((id) => id.startsWith(`${sliceId}-`));
}

/** Root-relative journal path inside the Evidence directory. */
function journalPathOf(evidencePath: string): string {
  return `${path.posix.dirname(evidencePath)}/${REPLAN_JOURNAL_FILE}`;
}

/** Root-relative archive path for the old Evidence. */
function archivePathOf(stageId: string, parentEpochDigest: string, sliceId: string): string {
  return `delivery/stages/${stageId}/evidence/history/${parentEpochDigest}/${sliceId}.md`;
}

export function rotateReplanEvidence(request: ReplanRotationRequest): ReplanRotationResult {
  const mode: ReplanRotationMode = request.mode ?? 'rotate';
  if (mode !== 'rotate' && mode !== 'recover' && mode !== 'rollback') {
    return blockedResult('', '', '', [vnextError('USAGE', `unsupported rotation mode "${String(request.mode)}"`)]);
  }
  if (typeof request.sliceId !== 'string' || request.sliceId.length === 0) {
    return blockedResult('', '', '', [vnextError('USAGE', 'sliceId is required')]);
  }
  if (typeof request.evidencePath !== 'string' || request.evidencePath.length === 0) {
    return blockedResult('', request.sliceId, '', [vnextError('USAGE', 'evidencePath is required')]);
  }
  if (typeof request.newSkeleton !== 'string' || request.newSkeleton.length === 0) {
    return blockedResult('', request.sliceId, '', [vnextError('USAGE', 'newSkeleton is required')]);
  }
  const disposition = parseReplanDisposition(request.disposition);
  if (disposition === null) {
    return blockedResult('', request.sliceId, '', [
      blocked('disposition failed closed schema validation (REF-S15-ROTATION-ACCEPT)'),
    ]);
  }
  const dispositionDigest = computeReplanDispositionDigest(disposition);
  const stageId = disposition.stage_id;
  const sliceId = request.sliceId;
  const root = resolveProjectRoot(request.root);
  const journalRelative = journalPathOf(request.evidencePath);

  const run = (): ReplanRotationResult => {
    if (mode === 'recover') return runRecover(root, request, disposition, dispositionDigest, journalRelative);
    if (mode === 'rollback') return runRollback(root, request, disposition, dispositionDigest, journalRelative);
    return runRotate(root, request, disposition, dispositionDigest, journalRelative);
  };
  try {
    return run();
  } catch (error) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked(`rotation failed with an internal error: ${errorMessage(error)}`),
    ]);
  }
}

function runRotate(
  root: string,
  request: ReplanRotationRequest,
  disposition: ReplanDisposition,
  dispositionDigest: string,
  journalRelative: string,
): ReplanRotationResult {
  const sliceId = request.sliceId;
  const stageId = disposition.stage_id;

  // ---- zero-write preflight -------------------------------------------------
  const canonical = resolveRootBoundPath(root, request.evidencePath, 'evidence-path');
  if (canonicalPathWithinRoot(root, request.evidencePath) === null) {
    return blockedResult(stageId, sliceId, dispositionDigest, [blocked('evidence path escapes the project root')]);
  }

  // Unrecovered journal detection: a prior interrupted transaction must be
  // recovered or rolled back before any new rotation.
  const journalFile = resolveRootBoundPath(root, journalRelative, 'journal');
  if (fs.existsSync(journalFile)) {
    return {
      success: false,
      stage_id: stageId,
      slice_id: sliceId,
      disposition_digest: dispositionDigest,
      archive_path: '',
      recovered: false,
      rolled_back: false,
      blocked_recovery: true,
      errors: [blocked('an unrecovered rotation journal exists; recover or roll back before rotating again')],
    };
  }

  const old = readEvidenceNoFollow(root, request.evidencePath);
  if (old === null) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('canonical Evidence is missing, a symlink, or unreadable'),
    ]);
  }

  // Old Evidence binding must match the disposition's previous digests and the
  // slice identity (non-pristine detection per §8.8).
  const oldBinding = parseEvidencePlanBinding(old.content);
  if (oldBinding === null) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('old Evidence has no parseable Plan Binding header'),
    ]);
  }
  if (oldBinding.stage_id !== stageId || oldBinding.slice_id !== sliceId) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('old Evidence binding stage/slice does not match the disposition'),
    ]);
  }
  if (oldBinding.plan_digest !== disposition.previous_plan_digest) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('old Evidence plan digest does not match disposition.previous_plan_digest'),
    ]);
  }
  if (oldBinding.manifest_digest !== disposition.previous_manifest_digest) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('old Evidence manifest digest does not match disposition.previous_manifest_digest'),
    ]);
  }

  // New skeleton binding must match the disposition's new digests.
  const newBinding = parseEvidencePlanBinding(request.newSkeleton);
  if (newBinding === null) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('new skeleton has no parseable Plan Binding header'),
    ]);
  }
  if (newBinding.stage_id !== stageId || newBinding.slice_id !== sliceId) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('new skeleton binding stage/slice does not match the disposition'),
    ]);
  }
  if (newBinding.plan_digest !== disposition.plan_digest) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('new skeleton plan digest does not match disposition.plan_digest'),
    ]);
  }
  if (newBinding.manifest_digest !== disposition.manifest_digest) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('new skeleton manifest digest does not match disposition.manifest_digest'),
    ]);
  }
  if (newBinding.plan_ref !== oldBinding.plan_ref) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('new skeleton plan_ref differs from the old Evidence binding'),
    ]);
  }

  // Carry-forward Task Evidence blocks must exist in the old Evidence so they
  // can be preserved byte-for-byte; current/invalidated Tasks are never reused.
  const carried = taskIdsOfSlice(disposition.carry_forward_task_ids, sliceId);
  const invalidated = taskIdsOfSlice(disposition.invalidated_task_ids, sliceId);
  const carriedBlocks: string[] = [];
  for (const taskId of carried) {
    const block = extractTaskEvidenceBlock(old.content, taskId);
    if (block === null) {
      return blockedResult(stageId, sliceId, dispositionDigest, [
        blocked(`carry-forward Task ${taskId} has no Task Evidence block in the old Evidence`),
      ]);
    }
    carriedBlocks.push(block);
  }

  // Append-only archive target: must not exist yet (CAS on history).
  const archiveRelative = archivePathOf(stageId, disposition.parent_epoch_digest, sliceId);
  const archiveFile = resolveRootBoundPath(root, archiveRelative, 'archive-target');
  if (fs.existsSync(archiveFile)) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked('history archive target already exists; refusing to overwrite append-only history'),
    ]);
  }

  const newContent = buildRotatedContent(request.newSkeleton, carriedBlocks);

  // ---- journal ---------------------------------------------------------------
  const journal: RotationJournal = {
    version: JOURNAL_VERSION,
    stage_id: stageId,
    slice_id: sliceId,
    disposition_digest: dispositionDigest,
    evidence_path: request.evidencePath,
    archive_path: archiveRelative,
    old_content: old.content,
    new_content: newContent,
    old_identity: old.identity,
  };
  const journalDir = evidenceDirectoryOf(root, request.evidencePath);
  const journalVerified = ensureDirectoryNoFollow(root, journalDir);
  const journalOpen = openVerifiedDirectory(journalVerified);
  try {
    const write = installNoReplace(journalOpen.procPrefix, REPLAN_JOURNAL_FILE, JSON.stringify(journal, null, 2));
    if (!write.ok) {
      return blockedResult(stageId, sliceId, dispositionDigest, [
        blocked(`cannot install rotation journal: ${write.message}`),
      ]);
    }
  } finally {
    try {
      fs.closeSync(journalOpen.dirfd);
    } catch {
      // best effort
    }
  }

  // ---- archive old Evidence (CAS) ---------------------------------------------
  const historyDir = path.posix.dirname(archiveRelative);
  let archived = false;
  let swapped = false;
  try {
    const historyVerified = ensureDirectoryNoFollow(root, historyDir);
    const historyOpen = openVerifiedDirectory(historyVerified);
    try {
      const write = installNoReplace(historyOpen.procPrefix, `${sliceId}.md`, old.content);
      if (!write.ok) {
        return blockedResult(stageId, sliceId, dispositionDigest, [
          blocked(`cannot archive old Evidence: ${write.message}`),
        ]);
      }
      archived = true;
    } finally {
      try {
        fs.closeSync(historyOpen.dirfd);
      } catch {
        // best effort
      }
    }

    // ---- CAS swap of the canonical file ---------------------------------------
    const swap = swapEvidenceFile(root, request.evidencePath, newContent, old.identity);
    if (!swap.ok) {
      return blockedResult(stageId, sliceId, dispositionDigest, [
        blocked(`cannot swap canonical Evidence: ${swap.message}`),
      ]);
    }
    swapped = true;
  } catch (error) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked(`rotation write stage failed: ${errorMessage(error)}`),
    ]);
  } finally {
    if (!swapped && archived) {
      // In-process failure after archive: roll the archive back so the
      // transaction is zero-write apart from the journal.
      try {
        fs.rmSync(archiveFile, { force: true });
      } catch {
        // best effort; journal remains for recover/rollback
      }
    }
  }

  // ---- journal removal ---------------------------------------------------------
  try {
    fs.unlinkSync(journalFile);
  } catch (error) {
    return blockedResult(stageId, sliceId, dispositionDigest, [
      blocked(`rotation completed but journal removal failed: ${errorMessage(error)}`),
    ]);
  }

  return successResult(stageId, sliceId, dispositionDigest, archiveRelative, {});
}

/** CAS swap: verify identity unchanged, then replace the canonical file. */
function swapEvidenceFile(
  root: string,
  evidencePath: string,
  content: string,
  expectedIdentity: string,
): { ok: true } | { ok: false; message: string } {
  const dir = evidenceDirectoryOf(root, evidencePath);
  const verified = ensureDirectoryNoFollow(root, dir);
  const opened = openVerifiedDirectory(verified);
  try {
    const baseName = path.posix.basename(evidencePath);
    const targetPath = `${opened.procPrefix}/${baseName}`;
    const before = fs.lstatSync(targetPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      return { ok: false, message: 'canonical Evidence is not a regular file' };
    }
    if (`${before.dev}:${before.ino}` !== expectedIdentity) {
      return { ok: false, message: 'canonical Evidence identity changed during rotation (competitor replacement detected)' };
    }
    const tempName = `.${baseName}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    const tempPath = `${opened.procPrefix}/${tempName}`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
      const bytes = Buffer.from(content, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (written <= 0) throw new Error('short write while swapping Evidence');
        offset += written;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      // Re-verify the target right before renameSync (CAS):
      const rightBefore = fs.lstatSync(targetPath);
      if (!rightBefore.isFile() || rightBefore.isSymbolicLink()) {
        return { ok: false, message: 'canonical Evidence target is no longer a regular file before CAS rename' };
      }
      if (`${rightBefore.dev}:${rightBefore.ino}` !== expectedIdentity) {
        return { ok: false, message: 'canonical Evidence identity changed before CAS rename (competitor replacement detected)' };
      }

      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // best effort
        }
      }
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // best effort
      }
      return { ok: false, message: errorMessage(error) };
    }
    return { ok: true };
  } finally {
    try {
      fs.closeSync(opened.dirfd);
    } catch {
      // best effort
    }
  }
}

function readJournal(root: string, journalRelative: string): RotationJournal | null {
  const journalFile = resolveRootBoundPath(root, journalRelative, 'journal');
  let raw: string;
  try {
    raw = fs.readFileSync(journalFile, 'utf8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const required: ReadonlyArray<keyof RotationJournal> = [
    'version',
    'stage_id',
    'slice_id',
    'disposition_digest',
    'evidence_path',
    'archive_path',
    'old_content',
    'new_content',
    'old_identity',
  ];
  if (required.some((field) => !(field in record))) return null;
  const unknown = Object.keys(record).filter((field) => !(required as readonly string[]).includes(field));
  if (unknown.length > 0) return null; // closed schema

  if (record.version !== JOURNAL_VERSION) return null;
  if (
    typeof record.stage_id !== 'string' ||
    typeof record.slice_id !== 'string' ||
    typeof record.disposition_digest !== 'string' ||
    typeof record.evidence_path !== 'string' ||
    typeof record.archive_path !== 'string' ||
    typeof record.old_content !== 'string' ||
    typeof record.new_content !== 'string' ||
    typeof record.old_identity !== 'string'
  ) {
    return null;
  }
  return {
    version: JOURNAL_VERSION,
    stage_id: record.stage_id,
    slice_id: record.slice_id,
    disposition_digest: record.disposition_digest,
    evidence_path: record.evidence_path,
    archive_path: record.archive_path,
    old_content: record.old_content,
    new_content: record.new_content,
    old_identity: record.old_identity,
  };
}

function validateJournal(
  root: string,
  journal: RotationJournal,
  request: ReplanRotationRequest,
  disposition: ReplanDisposition,
  dispositionDigest: string,
): { ok: true } | { ok: false; message: string } {
  const stageId = disposition.stage_id;
  const sliceId = request.sliceId;

  if (journal.stage_id !== stageId) {
    return { ok: false, message: `journal stage_id "${journal.stage_id}" does not match disposition stage "${stageId}"` };
  }
  if (journal.slice_id !== sliceId) {
    return { ok: false, message: `journal slice_id "${journal.slice_id}" does not match request slice "${sliceId}"` };
  }
  if (journal.disposition_digest !== dispositionDigest) {
    return { ok: false, message: 'journal disposition_digest does not match current disposition digest' };
  }
  if (journal.evidence_path !== request.evidencePath) {
    return { ok: false, message: 'journal evidence_path does not match request evidencePath' };
  }

  if (canonicalPathWithinRoot(root, journal.evidence_path) === null) {
    return { ok: false, message: 'journal evidence_path escapes the project root' };
  }
  if (canonicalPathWithinRoot(root, journal.archive_path) === null) {
    return { ok: false, message: 'journal archive_path escapes the project root' };
  }

  const expectedArchive = archivePathOf(stageId, disposition.parent_epoch_digest, sliceId);
  if (journal.archive_path !== expectedArchive) {
    return { ok: false, message: `journal archive_path "${journal.archive_path}" does not match expected epoch history path "${expectedArchive}"` };
  }

  if (!/^\d+:\d+$/.test(journal.old_identity)) {
    return { ok: false, message: `journal old_identity "${journal.old_identity}" is malformed` };
  }

  const oldBinding = parseEvidencePlanBinding(journal.old_content);
  if (oldBinding === null) {
    return { ok: false, message: 'journal old_content has no valid Plan Binding header' };
  }
  if (oldBinding.stage_id !== stageId || oldBinding.slice_id !== sliceId) {
    return { ok: false, message: 'journal old_content Plan Binding stage/slice does not match journal' };
  }
  if (oldBinding.plan_digest !== disposition.previous_plan_digest) {
    return { ok: false, message: 'journal old_content plan_digest does not match disposition.previous_plan_digest' };
  }
  if (oldBinding.manifest_digest !== disposition.previous_manifest_digest) {
    return { ok: false, message: 'journal old_content manifest_digest does not match disposition.previous_manifest_digest' };
  }

  const newBinding = parseEvidencePlanBinding(journal.new_content);
  if (newBinding === null) {
    return { ok: false, message: 'journal new_content has no valid Plan Binding header' };
  }
  if (newBinding.stage_id !== stageId || newBinding.slice_id !== sliceId) {
    return { ok: false, message: 'journal new_content Plan Binding stage/slice does not match journal' };
  }
  if (newBinding.plan_digest !== disposition.plan_digest) {
    return { ok: false, message: 'journal new_content plan_digest does not match disposition.plan_digest' };
  }
  if (newBinding.manifest_digest !== disposition.manifest_digest) {
    return { ok: false, message: 'journal new_content manifest_digest does not match disposition.manifest_digest' };
  }
  if (newBinding.plan_ref !== oldBinding.plan_ref) {
    return { ok: false, message: 'journal new_content plan_ref differs from old_content plan_ref' };
  }

  return { ok: true };
}

function runRecover(
  root: string,
  request: ReplanRotationRequest,
  disposition: ReplanDisposition,
  dispositionDigest: string,
  journalRelative: string,
): ReplanRotationResult {
  const stageId = disposition.stage_id;
  const sliceId = request.sliceId;
  const journal = readJournal(root, journalRelative);
  if (journal === null) {
    return {
      success: false,
      stage_id: stageId,
      slice_id: sliceId,
      disposition_digest: dispositionDigest,
      archive_path: '',
      recovered: false,
      rolled_back: false,
      blocked_recovery: true,
      errors: [blocked('no valid rotation journal exists to recover (or journal failed closed schema validation)')],
    };
  }
  const journalValid = validateJournal(root, journal, request, disposition, dispositionDigest);
  if (!journalValid.ok) {
    return {
      success: false,
      stage_id: stageId,
      slice_id: sliceId,
      disposition_digest: dispositionDigest,
      archive_path: '',
      recovered: false,
      rolled_back: false,
      blocked_recovery: true,
      errors: [blocked(`journal validation failed: ${journalValid.message}`)],
    };
  }
  const current = readEvidenceNoFollow(root, request.evidencePath);
  const archiveFile = resolveRootBoundPath(root, journal.archive_path, 'archive-target');
  const archiveExists = fs.existsSync(archiveFile);

  if (current === null) {
    return {
      success: false,
      stage_id: stageId,
      slice_id: sliceId,
      disposition_digest: dispositionDigest,
      archive_path: '',
      recovered: false,
      rolled_back: false,
      blocked_recovery: true,
      errors: [blocked('canonical Evidence is unreadable')],
    };
  }
  if (current.content === journal.new_content && archiveExists) {
    // Transaction already fully applied; only journal removal remains.
    try {
      fs.unlinkSync(resolveRootBoundPath(root, journalRelative, 'journal'));
    } catch (error) {
      return {
        success: false,
        stage_id: stageId,
        slice_id: sliceId,
        disposition_digest: dispositionDigest,
        archive_path: '',
        recovered: false,
        rolled_back: false,
        blocked_recovery: true,
        errors: [blocked(`recover completed but journal removal failed: ${errorMessage(error)}`)],
      };
    }
    return successResult(stageId, sliceId, dispositionDigest, journal.archive_path, { recovered: true });
  }
  if (current.content === journal.old_content && !archiveExists) {
    if (current.identity !== journal.old_identity) {
      return {
        success: false,
        stage_id: stageId,
        slice_id: sliceId,
        disposition_digest: dispositionDigest,
        archive_path: '',
        recovered: false,
        rolled_back: false,
        blocked_recovery: true,
        errors: [blocked('canonical Evidence identity on disk does not match journal old_identity (competitor replacement detected)')],
      };
    }
    // Transaction not started past preflight; complete it forward.
    const archiveRelative = journal.archive_path;
    const historyDir = path.posix.dirname(archiveRelative);
    try {
      const historyVerified = ensureDirectoryNoFollow(root, historyDir);
      const historyOpen = openVerifiedDirectory(historyVerified);
      try {
        const write = installNoReplace(historyOpen.procPrefix, `${sliceId}.md`, journal.old_content);
        if (!write.ok) {
          return {
            success: false,
            stage_id: stageId,
            slice_id: sliceId,
            disposition_digest: dispositionDigest,
            archive_path: '',
            recovered: false,
            rolled_back: false,
            blocked_recovery: true,
            errors: [blocked(`cannot archive old Evidence during recovery: ${write.message}`)],
          };
        }
      } finally {
        try {
          fs.closeSync(historyOpen.dirfd);
        } catch {
          // best effort
        }
      }
      const swap = swapEvidenceFile(root, request.evidencePath, journal.new_content, journal.old_identity);
      if (!swap.ok) {
        return {
          success: false,
          stage_id: stageId,
          slice_id: sliceId,
          disposition_digest: dispositionDigest,
          archive_path: '',
          recovered: false,
          rolled_back: false,
          blocked_recovery: true,
          errors: [blocked(`cannot swap canonical Evidence during recovery: ${swap.message}`)],
        };
      }
    } catch (error) {
      return {
        success: false,
        stage_id: stageId,
        slice_id: sliceId,
        disposition_digest: dispositionDigest,
        archive_path: '',
        recovered: false,
        rolled_back: false,
        blocked_recovery: true,
        errors: [blocked(`recovery write stage failed: ${errorMessage(error)}`)],
      };
    }
    try {
      fs.rmSync(resolveRootBoundPath(root, journalRelative, 'journal'), { force: false });
    } catch (error) {
      return {
        success: false,
        stage_id: stageId,
        slice_id: sliceId,
        disposition_digest: dispositionDigest,
        archive_path: '',
        recovered: false,
        rolled_back: false,
        blocked_recovery: true,
        errors: [blocked(`recovery completed but journal removal failed: ${errorMessage(error)}`)],
      };
    }
    return successResult(stageId, sliceId, dispositionDigest, journal.archive_path, { recovered: true });
  }
  return {
    success: false,
    stage_id: stageId,
    slice_id: sliceId,
    disposition_digest: dispositionDigest,
    archive_path: '',
    recovered: false,
    rolled_back: false,
    blocked_recovery: true,
    errors: [
      blocked('current canonical state matches neither the journaled old nor new content'),
    ],
  };
}

function runRollback(
  root: string,
  request: ReplanRotationRequest,
  disposition: ReplanDisposition,
  dispositionDigest: string,
  journalRelative: string,
): ReplanRotationResult {
  const stageId = disposition.stage_id;
  const sliceId = request.sliceId;
  const journal = readJournal(root, journalRelative);
  if (journal === null) {
    return {
      success: false,
      stage_id: stageId,
      slice_id: sliceId,
      disposition_digest: dispositionDigest,
      archive_path: '',
      recovered: false,
      rolled_back: false,
      blocked_recovery: true,
      errors: [blocked('no valid rotation journal exists to roll back (or journal failed closed schema validation)')],
    };
  }
  const journalValid = validateJournal(root, journal, request, disposition, dispositionDigest);
  if (!journalValid.ok) {
    return {
      success: false,
      stage_id: stageId,
      slice_id: sliceId,
      disposition_digest: dispositionDigest,
      archive_path: '',
      recovered: false,
      rolled_back: false,
      blocked_recovery: true,
      errors: [blocked(`journal validation failed: ${journalValid.message}`)],
    };
  }
  const current = readEvidenceNoFollow(root, request.evidencePath);
  const archiveFile = resolveRootBoundPath(root, journal.archive_path, 'archive-target');
  const archiveExists = fs.existsSync(archiveFile);
  const journalFile = resolveRootBoundPath(root, journalRelative, 'journal');

  if (current === null) {
    return {
      success: false,
      stage_id: stageId,
      slice_id: sliceId,
      disposition_digest: dispositionDigest,
      archive_path: '',
      recovered: false,
      rolled_back: false,
      blocked_recovery: true,
      errors: [blocked('canonical Evidence is unreadable')],
    };
  }
  if (current.content === journal.old_content && !archiveExists) {
    // Nothing was applied; drop the journal.
    try {
      fs.unlinkSync(journalFile);
    } catch (error) {
      return {
        success: false,
        stage_id: stageId,
        slice_id: sliceId,
        disposition_digest: dispositionDigest,
        archive_path: '',
        recovered: false,
        rolled_back: false,
        blocked_recovery: true,
        errors: [blocked(`rollback completed but journal removal failed: ${errorMessage(error)}`)],
      };
    }
    return successResult(stageId, sliceId, dispositionDigest, '', { rolled_back: true });
  }
  if (current.content === journal.new_content && archiveExists) {
    let archivedContent: string;
    try {
      archivedContent = fs.readFileSync(archiveFile, 'utf8');
    } catch (error) {
      return {
        success: false,
        stage_id: stageId,
        slice_id: sliceId,
        disposition_digest: dispositionDigest,
        archive_path: '',
        recovered: false,
        rolled_back: false,
        blocked_recovery: true,
        errors: [blocked(`archive copy is unreadable during rollback: ${errorMessage(error)}`)],
      };
    }
    if (archivedContent !== journal.old_content) {
      return {
        success: false,
        stage_id: stageId,
        slice_id: sliceId,
        disposition_digest: dispositionDigest,
        archive_path: '',
        recovered: false,
        rolled_back: false,
        blocked_recovery: true,
        errors: [blocked('archive copy content does not match journaled old_content during rollback')],
      };
    }
    // Revert: restore old canonical content, remove the archive copy, drop the journal.
    try {
      const swap = swapEvidenceFile(root, request.evidencePath, journal.old_content, current.identity);
      if (!swap.ok) {
        return {
          success: false,
          stage_id: stageId,
          slice_id: sliceId,
          disposition_digest: dispositionDigest,
          archive_path: '',
          recovered: false,
          rolled_back: false,
          blocked_recovery: true,
          errors: [blocked(`cannot restore old Evidence during rollback: ${swap.message}`)],
        };
      }
      fs.unlinkSync(archiveFile);
      fs.unlinkSync(journalFile);
      removeEmptyHistoryDirs(root, archiveFile);
    } catch (error) {
      return {
        success: false,
        stage_id: stageId,
        slice_id: sliceId,
        disposition_digest: dispositionDigest,
        archive_path: '',
        recovered: false,
        rolled_back: false,
        blocked_recovery: true,
        errors: [blocked(`rollback failed: ${errorMessage(error)}`)],
      };
    }
    return successResult(stageId, sliceId, dispositionDigest, '', { rolled_back: true });
  }
  return {
    success: false,
    stage_id: stageId,
    slice_id: sliceId,
    disposition_digest: dispositionDigest,
    archive_path: '',
    recovered: false,
    rolled_back: false,
    blocked_recovery: true,
    errors: [
      blocked('current canonical state matches neither the journaled old nor new content'),
    ],
  };
}

function journalFileOf(root: string, journalRelative: string): string {
  return resolveRootBoundPath(root, journalRelative, 'journal');
}

/**
 * After a rollback removes the archived Evidence copy, remove now-empty
 * history directories (append-only archives leave no empty shell dirs).
 * Only directories that are guaranteed empty are removed; non-empty ones
 * are left untouched.
 */
function removeEmptyHistoryDirs(root: string, archiveFile: string): void {
  const historyDir = path.dirname(path.dirname(archiveFile));
  const epochDir = path.dirname(archiveFile);
  for (const dir of [epochDir, historyDir]) {
    try {
      const canonical = canonicalPathWithinRoot(root, dir);
      if (canonical === null) continue;
      fs.rmdirSync(dir);
    } catch {
      // Directory is not empty or already gone; leave it.
    }
  }
}