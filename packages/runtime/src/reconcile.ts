/**
 * @proofloop/runtime — ReconcileService: three-source merge (S02-C-T03)
 *
 * Merges the three authoritative sources of a stage reconcile into one
 * deterministic normalized state snapshot (HP-003 — never a guess):
 *
 *   1. Manifest source (S02-C-T02): stage/slice structure + task/evidence
 *      paths, validated through the kernel `validateManifest` seam. Missing /
 *      parse-failed / schema-invalid / stage_id-mismatched manifest →
 *      `DOMAIN.STAGE_NOT_FOUND` (PO-S02-C-02).
 *   2. Git source (S02-C-T02): HEAD, tasks.md checkbox states and evidence
 *      file facts from the real work tree. A non-git root / unborn HEAD /
 *      missing tasks.md makes the Git source unavailable →
 *      `RUNTIME.SCHEMA_MISMATCH` (PO-S02-C-02).
 *   3. Receipts source (S02-C-T01): the canonical category directory layout,
 *      read through the receipt reader — kernel `verifyReceiptChain` per
 *      category directory (PO-S02-C-03), schema validation, type/category
 *      misplacement detection and deterministic (timestamp, digest) ordering.
 *
 * Inconsistency → Finding mapping (Authority Excerpts, PO-S02-C-02):
 *   - receipt references unknown slice/stage        → DOMAIN.STAGE_NOT_FOUND
 *   - schema-invalid / legacy receipt               → RUNTIME.SCHEMA_MISMATCH
 *   - misplaced receipt (type/category mismatch)    → RUNTIME.SCHEMA_MISMATCH
 *   - slice-bound receipt disagreeing with its
 *     directory                                     → RUNTIME.SCHEMA_MISMATCH
 *   - manifest missing / stage_id mismatch          → DOMAIN.STAGE_NOT_FOUND
 *   - non-git root (git source unavailable)         → RUNTIME.SCHEMA_MISMATCH
 *   - git HEAD does not contain the SHA recorded in
 *     a SLICE_COMMIT receipt                        → RUNTIME.RECEIPT_CHAIN_BROKEN
 *   - broken / tampered / duplicate-digest chain    → RUNTIME.RECEIPT_CHAIN_BROKEN
 *   - task checked while evidence missing (or vice
 *     versa)                                        → RUNTIME.SCHEMA_MISMATCH
 *                                                    (severity 'warn' — recoverable;
 *                                                     the only warn finding of the
 *                                                     closed 9-code set, picked for
 *                                                     the work-tree fact mismatch)
 *
 * Affected facts stay un-guessed (HP-003):
 *   - receipts referencing unknown slices/stages are never merged — the
 *     unknown entity simply does not exist in the normalized output;
 *   - a receipt whose own slice_id disagrees with its containing directory
 *     is attributed to neither slice (ambiguous → no guess);
 *   - when a category chain is invalid, NO fact is derived from that chain —
 *     the category is marked `receipt_chain_valid: false` (PO-S02-C-03 fact
 *     blocking) and the overall `receipt_chain_valid` is false;
 *   - when the Git source is unavailable the per-task facts stay at the
 *     un-guessed default and the error Finding blocks downstream use.
 *
 * Per-slice/stage authoritative derivation (cv_status / slice_state /
 * committed / integrated / complete / stage_state) is the S02-C-T04 concern,
 * implemented below against the PO-S02-C-04 mapping (receipts authoritative;
 * missing/unbound receipts never mark committed/integrated/complete; stage
 * derivation through S02-A `deriveStageState` with READY folding; a
 * contradictory stage fact combination surfaces a `DOMAIN.INVALID_TRANSITION`
 * finding instead of a silent guess).
 *
 * Determinism (HP-003): every scan order is fixed (manifest declaration
 * order, canonical category order, sorted directory listings) and findings are
 * sorted by (code, severity, message) with exact-duplicate collapse.
 * Read-only — never writes, repairs or commits.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StageState, SliceState, CVStatus, ProjectState } from '@proofloop/kernel';
import type { Finding, Manifest } from '@proofloop/kernel';
import { manifestSource, ManifestSourceError } from './manifest-source';
import { gitSource, GitSourceError, resolveGitRoot, readGitHead } from './git-source';
import type { GitSourceResult } from './git-source';
import { readReceiptCategory, compareReceiptsByTimestampDigest } from './receipt-reader';
import type {
  ReceiptCategoryReadResult,
  ReadReceiptResult,
  ChainBrokenCondition,
} from './receipt-reader';
import { receiptsRoot } from './receipt-layout';
import type { ReceiptContentCategory } from './receipt-layout';
import { canonicalPathWithinRoot } from './path-guard';
import { deriveStageState, StageStateDerivationError } from './stage-state';
import type { StageReceiptSummary } from './stage-state';
import type {
  ReconciledStageState,
  ReconciledSliceState,
  ReconciledTaskState,
} from './state-model';

// ============================================================
// Public input/output shapes
// ============================================================

export interface ReconcileStageInput {
  /** Project root (must be the git root when the Git source is available). */
  readonly projectRoot: string;
  /** Stage id to reconcile. */
  readonly stageId: string;
  /** Custom manifest path (defaults to `.proofloop/manifests/<stage>.json`). */
  readonly manifestPath?: string;
  /** Custom tasks.md path (defaults to `delivery/stages/<stage>/tasks.md`). */
  readonly tasksMdPath?: string;
}

/**
 * Chain-integrity state of one canonical receipt category directory
 * (PO-S02-C-03).
 *
 * Slice-level categories (tasks/cv/committer/integration) carry their slice
 * id; stage-level categories (plan/stage-gate/review/project) have
 * `slice_id: null`.
 */
export interface CategoryChainState {
  readonly category: ReceiptContentCategory;
  /** Slice id for slice-level categories; null for stage-level categories. */
  readonly slice_id: string | null;
  /** Kernel `verifyReceiptChain` verdict over this category directory. */
  readonly receipt_chain_valid: boolean;
  /** Structured chain condition when invalid, else null. */
  readonly chain_condition: ChainBrokenCondition | null;
}

/**
 * Reconcile output: the normalized `ReconciledStageState` plus the chain
 * validity markers (PO-S02-C-03). Structurally a superset of
 * `ReconciledStageState` (the observable outcome of the reconcile seam).
 */
export interface ReconcileStageResult extends ReconciledStageState {
  /**
   * Overall chain validity: true only when EVERY scanned category chain is
   * valid (no receipts scanned → vacuously true, like an empty chain).
   */
  readonly receipt_chain_valid: boolean;
  /** Per-category chain validity in canonical category order. */
  readonly receipt_categories: readonly CategoryChainState[];
}

// ============================================================
// Category sets
// ============================================================

/** Slice-level categories — one directory per slice, chain per directory. */
const SLICE_LEVEL_CATEGORIES: readonly ReceiptContentCategory[] = [
  'tasks',
  'cv',
  'committer',
  'integration',
];

/** Stage-level categories — one directory per stage, read once. */
const STAGE_LEVEL_CATEGORIES: readonly ReceiptContentCategory[] = [
  'plan',
  'stage-gate',
  'review',
  'project',
];

// ============================================================
// Finding ordering — deterministic (code, severity, message)
// ============================================================

/**
 * Deterministic comparator over canonical Findings: code ascending, then
 * severity ascending ('error' < 'warn'), then message ascending — plain
 * locale-independent string comparison (HP-003).
 */
export function compareFindings(a: Finding, b: Finding): number {
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  if (a.severity !== b.severity) return a.severity < b.severity ? -1 : 1;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  return 0;
}

/**
 * Deterministic finding ordering: sort by (code, severity, message) and
 * collapse exact duplicates. Identical (code, severity, message) findings
 * carry the same information, so the collapse is order-stable and lossless.
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const sorted = [...findings].sort(compareFindings);
  const out: Finding[] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (
      last === undefined ||
      last.code !== f.code ||
      last.severity !== f.severity ||
      last.message !== f.message
    ) {
      out.push(f);
    }
  }
  return out;
}

// ============================================================
// Internal helpers
// ============================================================

/** Path relative to the project root — host-independent finding messages. */
function relPath(projectRoot: string, absolutePath: string): string {
  const rel = path.relative(projectRoot, absolutePath);
  return rel.length === 0 ? '.' : rel;
}

/** Attribution context for one receipt read. */
interface AttributionContext {
  readonly projectRoot: string;
  readonly stageId: string;
  readonly category: ReceiptContentCategory;
  /** Directory slice for slice-level categories; null for stage-level. */
  readonly directorySlice: string | null;
  readonly knownSlices: ReadonlySet<string>;
  readonly findings: Finding[];
}

/**
 * Attribute a valid category-correct receipt to the reconciled stage.
 *
 * Rules (never a guess, HP-003):
 *   - `stage_id` not matching the reconciled stage → DOMAIN.STAGE_NOT_FOUND,
 *     the receipt is not merged;
 *   - `slice_id` referencing a slice the manifest does not declare →
 *     DOMAIN.STAGE_NOT_FOUND, the receipt is not merged;
 *   - `slice_id` present and different from the containing directory slice →
 *     RUNTIME.SCHEMA_MISMATCH (a slice-bound receipt disagreeing with its
 *     directory — ambiguous attribution), the receipt is not merged.
 *
 * @returns true when the receipt may be merged as a fact.
 */
function attributeReceipt(read: ReadReceiptResult, ctx: AttributionContext): boolean {
  const { receipt } = read;
  const label = relPath(ctx.projectRoot, read.filePath);

  if (receipt.stage_id !== ctx.stageId) {
    ctx.findings.push({
      code: 'DOMAIN.STAGE_NOT_FOUND',
      severity: 'error',
      message: `receipt ${label} references unknown stage "${receipt.stage_id}"`,
    });
    return false;
  }
  if (receipt.slice_id !== undefined && !ctx.knownSlices.has(receipt.slice_id)) {
    ctx.findings.push({
      code: 'DOMAIN.STAGE_NOT_FOUND',
      severity: 'error',
      message: `receipt ${label} references unknown slice "${receipt.slice_id}"`,
    });
    return false;
  }
  if (
    ctx.directorySlice !== null &&
    receipt.slice_id !== undefined &&
    receipt.slice_id !== ctx.directorySlice
  ) {
    ctx.findings.push({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
      message:
        `receipt ${label} is slice-bound to "${receipt.slice_id}" but lives in ` +
        `the "${ctx.directorySlice}" ${ctx.category} directory`,
    });
    return false;
  }
  return true;
}

/**
 * Check a SLICE_COMMIT receipt's recorded commit against the Git source
 * (PO-S02-C-02): the recorded `slice_commit_sha` must exist in the current
 * git history (be an ancestor of HEAD, equality included). A recorded SHA
 * that is not an ancestor of HEAD → RUNTIME.RECEIPT_CHAIN_BROKEN — the Git
 * source and the receipt chain disagree, no commit fact may be trusted.
 */
function checkCommitReceiptHead(
  read: ReadReceiptResult,
  gitHead: string | null,
  ctx: AttributionContext,
): void {
  const sha = read.receipt.payload?.['slice_commit_sha'];
  if (typeof sha !== 'string' || sha.length === 0) {
    // No recorded SHA — nothing to compare (committer-boundary binding is
    // the S02-C-T04 domain, not a T03 inconsistency kind).
    return;
  }
  if (gitHead === null) {
    // Git source unavailable — the git-unavailable Finding already covers it.
    return;
  }
  if (!isCommitAncestorOfHead(ctx.projectRoot, sha, gitHead)) {
    ctx.findings.push({
      code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
      severity: 'error',
      message:
        `SLICE_COMMIT receipt ${relPath(ctx.projectRoot, read.filePath)} records commit ` +
        `${sha} which is not an ancestor of git HEAD ${gitHead}`,
    });
  }
}

/**
 * Reject Receipt payload schemas that are not understood by the legacy
 * reader (S08-E-T07).  Legacy v1 receipts predate the payload discriminator
 * (an explicit schema_version: 1 is also the known legacy shape); vNext
 * receipts use 2 for EVERY Receipt type (TASK_COMPLETE / CV_PASS / CV_REPAIR /
 * SLICE_COMMIT / INTEGRATION_PASS / GATE_PASS / GATE_FAIL /
 * STAGE_REVIEW_PASS / STAGE_PLAN / SPV_PASS ...) and must remain readable by
 * their own consumers, but never become legacy facts — no v2 Receipt of any
 * type may enter the legacy reconcile/reducer derivation, and a category
 * chain may never mix v1/v2 payload schemas.
 */
function legacyPayloadSchemaFinding(
  read: ReadReceiptResult,
  ctx: Omit<AttributionContext, 'directorySlice' | 'category'>,
): Finding | null {
  const payload = read.receipt.payload;
  if (!Object.prototype.hasOwnProperty.call(payload, 'schema_version')) return null;

  const schemaVersion = payload['schema_version'];
  if (schemaVersion === 1) return null;

  const label = relPath(ctx.projectRoot, read.filePath);
  const value = JSON.stringify(schemaVersion);
  const detail =
    schemaVersion === 2
      ? 'is a vNext receipt and is incompatible with the legacy reader'
      : `is unsupported by the legacy reader (expected legacy v1 or vNext 2, got ${value})`;
  return {
    code: 'RUNTIME.SCHEMA_MISMATCH',
    severity: 'error',
    message:
      `legacy reconcile rejected ${read.receipt.type} receipt ${label}: ` +
      `payload.schema_version=${value} ${detail} (compatibility boundary)`,
  };
}

/** `git merge-base --is-ancestor <sha> <head>` — exit 0 ⇒ true. */
function isCommitAncestorOfHead(projectRoot: string, sha: string, head: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, head], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories under slice-level category stage dirs that the manifest does
 * not declare → receipts exist for an unknown slice (PO-S02-C-02).
 *
 * Trust-root boundary (S2-F-003): the receipts root is verified per category
 * stage dir; a stage dir whose canonical path escapes the project root is
 * NEVER listed (skipped) — the category reads already fail closed
 * (`chainValid: false`), and an escaped dir must not contribute outside-derived
 * "unknown slice" findings either.
 */
function findUnknownSliceDirs(
  projectRoot: string,
  stageId: string,
  knownSlices: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const category of SLICE_LEVEL_CATEGORIES) {
    const stageDir = path.join(receiptsRoot(projectRoot), category, stageId);
    if (canonicalPathWithinRoot(projectRoot, stageDir) === null) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(stageDir, { withFileTypes: true });
    } catch {
      continue; // no receipts of this category at all
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !knownSlices.has(entry.name)) {
        out.push(path.join(stageDir, entry.name));
      }
    }
  }
  return out.sort();
}

/** Accumulated receipt-merge state shared by the category handler. */
interface MergeState {
  readonly categoryStates: CategoryChainState[];
  /** Valid, attributed receipts in deterministic (timestamp, digest) order. */
  readonly validReads: ReadReceiptResult[];
}

/**
 * Process one category directory read: chain-validity marker + findings
 * (chain / invalid files / misplacements) + fact merge when the chain is
 * valid (attribution + commit-SHA check).
 */
function handleCategoryRead(
  sliceId: string | null,
  category: ReceiptContentCategory,
  result: ReceiptCategoryReadResult,
  ctx: Omit<AttributionContext, 'directorySlice' | 'category'>,
  merge: MergeState,
  gitHead: string | null,
): void {
  merge.categoryStates.push({
    category,
    slice_id: sliceId,
    receipt_chain_valid: result.chainValid,
    chain_condition: result.chainCondition,
  });

  if (!result.chainValid) {
    ctx.findings.push({
      code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
      severity: 'error',
      message:
        `receipt chain broken in ${category}` +
        (sliceId !== null ? ` (slice "${sliceId}")` : '') +
        `: ${result.chainCondition?.reason ?? 'chain verification failed'}`,
    });
  }
  for (const file of result.invalidFiles) {
    ctx.findings.push({
      code: file.code,
      severity: 'error',
      message: `invalid receipt ${relPath(ctx.projectRoot, file.filePath)}: ${file.reason}`,
    });
  }
  for (const m of result.misplaced) {
    ctx.findings.push({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
      message:
        `misplaced receipt ${relPath(ctx.projectRoot, m.filePath)}: type ${m.receiptType} ` +
        `found in ${m.foundInCategory} directory (expected ${m.expectedCategory})`,
    });
  }

  // PO-S02-C-03 fact blocking: NO fact may be derived from a broken chain.
  if (!result.chainValid) return;

  // Legacy/vNext isolation: the physical chain remains valid, but a category
  // containing any non-legacy payload schema is not a legacy fact source.
  // Check the complete valid receipt set before attribution or validReads
  // merge so mixed v1/vNext chains are blocked as a whole rather than
  // partially read, for EVERY Receipt type (S08-E-T07).
  const legacySchemaFindings = result.receipts
    .map((read) => legacyPayloadSchemaFinding(read, ctx))
    .filter((finding): finding is Finding => finding !== null);
  if (legacySchemaFindings.length > 0) {
    ctx.findings.push(...legacySchemaFindings);
    return;
  }

  const attrCtx: AttributionContext = {
    ...ctx,
    category,
    directorySlice: sliceId,
  };
  for (const read of result.receipts) {
    if (!attributeReceipt(read, attrCtx)) continue;
    merge.validReads.push(read);
    if (category === 'committer' && read.receipt.type === 'SLICE_COMMIT') {
      checkCommitReceiptHead(read, gitHead, attrCtx);
    }
  }
}

/** Deterministic empty state when the manifest source is unavailable. */
function emptyResult(stageId: string, findings: Finding[]): ReconcileStageResult {
  return {
    stage_id: stageId,
    slices: [],
    stage_state: StageState.UNINITIALIZED,
    project_state: ProjectState.IN_PROGRESS,
    receipt_chain: [],
    findings: sortFindings(findings),
    receipt_chain_valid: true,
    receipt_categories: [],
  };
}

// ============================================================
// S02-C-T04 — per-slice/stage authoritative derivation (PO-S02-C-04)
//
// Receipts are the authoritative source for every derived fact; a missing or
// unbound receipt NEVER marks committed/integrated/complete (HP-003 — never
// a guess). Canonical payload contract for the bound boundaries:
//   - SLICE_COMMIT    payload.status === 'committed',
//                     payload.slice_commit_sha === the committed git sha,
//                     payload.cv_receipt_digest === the latest CV_PASS
//                     receipt digest (the "绑定 cv receipt digest" binding);
//   - INTEGRATION_PASS payload.status === 'integrated',
//                     payload.slice_commit_sha === the same commit SHA as
//                     the committed SLICE_COMMIT (the "绑定同一 commit SHA"
//                     binding);
//   - TASK_COMPLETE   payload.mode is the worker mode ('finalize-slice' |
//                     'repair' | ...) of the completed step.
// ============================================================

/** Per-slice receipt facts consumed by the authoritative derivation. */
interface SliceReceiptFacts {
  /** Latest attributed chain-valid cv receipt, or null. */
  readonly latestCv: ReadReceiptResult | null;
  /** Latest attributed chain-valid SLICE_COMMIT receipt, or null. */
  readonly latestSliceCommit: ReadReceiptResult | null;
  /** Latest attributed chain-valid INTEGRATION_PASS receipt, or null. */
  readonly latestIntegrationPass: ReadReceiptResult | null;
  /** Latest attributed chain-valid TASK_COMPLETE receipt, or null. */
  readonly latestTaskComplete: ReadReceiptResult | null;
  /** Count of attributed chain-valid CV_REPAIR receipts. */
  readonly cvRepairCount: number;
  /** Any attributed TASK_COMPLETE with payload.mode === 'finalize-slice'. */
  readonly hasFinalizeSliceTaskComplete: boolean;
  /** Latest attributed TASK_COMPLETE with payload.mode 'repair'. */
  readonly latestRepairTaskComplete: ReadReceiptResult | null;
}

/** Newest receipt of a scan per the deterministic (timestamp, digest) order. */
function latestOfType(reads: readonly ReadReceiptResult[]): ReadReceiptResult | null {
  let latest: ReadReceiptResult | null = null;
  for (const read of reads) {
    if (latest === null || compareReceiptsByTimestampDigest(latest, read) < 0) {
      latest = read;
    }
  }
  return latest;
}

/**
 * Build the per-slice receipt facts of one slice from the attributed,
 * chain-valid receipt merge (PO-S02-C-03 fact blocking: receipts of a broken
 * chain never reach `validReads`, so no fact is derived from them).
 */
function buildSliceReceiptFacts(
  validReads: readonly ReadReceiptResult[],
  sliceId: string,
): SliceReceiptFacts {
  const cvReads: ReadReceiptResult[] = [];
  const commitReads: ReadReceiptResult[] = [];
  const integrationReads: ReadReceiptResult[] = [];
  const taskReads: ReadReceiptResult[] = [];
  let cvRepairCount = 0;
  for (const read of validReads) {
    if (read.receipt.slice_id !== sliceId) continue;
    switch (read.receipt.type) {
      case 'CV_PASS':
        cvReads.push(read);
        break;
      case 'CV_REPAIR':
        cvReads.push(read);
        cvRepairCount += 1;
        break;
      case 'SLICE_COMMIT':
        commitReads.push(read);
        break;
      case 'INTEGRATION_PASS':
        integrationReads.push(read);
        break;
      case 'TASK_COMPLETE':
        taskReads.push(read);
        break;
      default:
        break;
    }
  }
  const repairTaskCompletes = taskReads.filter((r) => {
    const mode = r.receipt.payload?.['mode'];
    return mode === 'repair';
  });
  return {
    latestCv: latestOfType(cvReads),
    latestSliceCommit: latestOfType(commitReads),
    latestIntegrationPass: latestOfType(integrationReads),
    latestTaskComplete: latestOfType(taskReads),
    cvRepairCount,
    hasFinalizeSliceTaskComplete: taskReads.some(
      (r) => r.receipt.payload?.['mode'] === 'finalize-slice',
    ),
    latestRepairTaskComplete: latestOfType(repairTaskCompletes),
  };
}

/**
 * Authoritative CV status (PO-S02-C-04): CV_PASS → PASS; CV_REPAIR → REPAIR
 * (slice back to READY_FOR_CV); a repair-mode TASK_COMPLETE deterministically
 * later than the last CV_REPAIR (cross-category (timestamp, digest) order) →
 * PENDING_RECHECK; no cv receipt → NOT_STARTED (never guessed).
 */
function deriveCvStatus(facts: SliceReceiptFacts): CVStatus {
  const latest = facts.latestCv;
  if (latest === null) return CVStatus.NOT_STARTED;
  if (latest.receipt.type === 'CV_PASS') return CVStatus.PASS;
  // latest is CV_REPAIR: repair-mode TASK_COMPLETE after it → recheck pending.
  if (
    facts.latestRepairTaskComplete !== null &&
    compareReceiptsByTimestampDigest(facts.latestRepairTaskComplete, latest) > 0
  ) {
    return CVStatus.PENDING_RECHECK;
  }
  return CVStatus.REPAIR;
}

/**
 * Authoritative committed fact (PO-S02-C-04): a SLICE_COMMIT receipt bound
 * to the latest CV_PASS receipt digest (payload.cv_receipt_digest) with
 * status 'committed'. A missing receipt, a non-PASS latest cv receipt, or a
 * missing/mismatching binding all leave committed false — never a guess.
 */
function deriveCommitted(facts: SliceReceiptFacts): boolean {
  const commit = facts.latestSliceCommit;
  if (commit === null) return false;
  if (commit.receipt.payload?.['status'] !== 'committed') return false;
  const latestCv = facts.latestCv;
  if (latestCv === null || latestCv.receipt.type !== 'CV_PASS') return false;
  return commit.receipt.payload?.['cv_receipt_digest'] === latestCv.receipt.digest;
}

/**
 * Authoritative integrated fact (PO-S02-C-04): an INTEGRATION_PASS receipt
 * bound to the SAME commit SHA as the committed SLICE_COMMIT. Without a
 * valid committed fact there is no commit SHA to bind to → not integrated.
 */
function deriveIntegrated(facts: SliceReceiptFacts, committed: boolean): boolean {
  if (!committed) return false;
  const integration = facts.latestIntegrationPass;
  if (integration === null) return false;
  if (integration.receipt.payload?.['status'] !== 'integrated') return false;
  const commitSha = facts.latestSliceCommit?.receipt.payload?.['slice_commit_sha'];
  if (typeof commitSha !== 'string' || commitSha.length === 0) return false;
  return integration.receipt.payload?.['slice_commit_sha'] === commitSha;
}

/**
 * Normalized per-slice state: raw merged facts + the PO-S02-C-04
 * authoritative derivation (slice_state / cv_status / committed / integrated
 * / complete), deterministically mapped — the most advanced state with
 * positive evidence wins, the safe defaults never guess.
 */
function buildSliceState(
  sliceDef: Manifest['slices'][number],
  git: GitSourceResult | undefined,
  facts: SliceReceiptFacts,
): ReconciledSliceState {
  const tasks: ReconciledTaskState[] = sliceDef.tasks.map((taskId) => ({
    task_id: taskId,
    checked: git?.tasks.find((t) => t.task_id === taskId)?.checked ?? false,
    evidence_written:
      git?.evidence.find((e) => e.task_id === taskId)?.evidence_written ?? false,
  }));

  const allTasksChecked =
    git !== undefined && git.tasks.length > 0 && git.tasks.every((t) => t.checked);
  const evidenceFinalized = git?.evidence_finalized ?? false;
  const cvStatus = deriveCvStatus(facts);
  const committed = deriveCommitted(facts);
  const integrated = deriveIntegrated(facts, committed);
  const complete =
    allTasksChecked && evidenceFinalized && cvStatus === CVStatus.PASS && committed && integrated;

  // slice_state: the most advanced §6 SliceState with positive evidence.
  let sliceState: SliceState;
  if (facts.latestCv !== null) {
    sliceState =
      facts.latestCv.receipt.type === 'CV_REPAIR'
        ? SliceState.READY_FOR_CV // CV_REPAIR 回 READY_FOR_CV
        : integrated
          ? SliceState.INTEGRATED
          : committed
            ? SliceState.INTEGRATING
            : SliceState.CV_PASSED;
  } else if (allTasksChecked && evidenceFinalized && facts.hasFinalizeSliceTaskComplete) {
    // 全 task checked + evidence finalized + mode=finalize-slice
    // TASK_COMPLETE receipt → READY_FOR_CV.
    sliceState = SliceState.READY_FOR_CV;
  } else if (
    git?.tasks.some((t) => t.checked) === true ||
    git?.evidence.some((e) => e.evidence_written) === true ||
    facts.latestTaskComplete !== null
  ) {
    // Work has begun but the slice has not reached READY_FOR_CV → IN_PROGRESS.
    sliceState = SliceState.IN_PROGRESS;
  } else {
    sliceState = SliceState.PLANNED;
  }

  return {
    slice_id: sliceDef.slice_id,
    dependencies: sliceDef.dependencies,
    tasks,
    slice_state: sliceState,
    cv_status: cvStatus,
    slice_evidence_finalized: evidenceFinalized,
    repair_attempt: Math.max(0, facts.cvRepairCount - 1),
    scope_check_passed: false,
    committed,
    integrated,
    complete,
    latest_cv_receipt: facts.latestCv?.receipt ?? null,
    latest_commit_receipt: facts.latestSliceCommit?.receipt ?? null,
  };
}

// ============================================================
// ReconcileService
// ============================================================

/**
 * Reconcile the Manifest + Git + Receipts sources of one stage into a
 * deterministic normalized snapshot with canonical Findings.
 *
 * Deterministic (HP-003) and read-only; never guesses, repairs or writes.
 *
 * @throws {TypeError} when `projectRoot` / `stageId` are missing or empty.
 */
export function reconcileStage(input: ReconcileStageInput): ReconcileStageResult {
  const { projectRoot, stageId } = input;
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('reconcileStage: projectRoot is required');
  }
  if (typeof stageId !== 'string' || stageId.length === 0) {
    throw new TypeError('reconcileStage: stageId is required');
  }
  const findings: Finding[] = [];

  // ── 1. Manifest source (PO-S02-C-02: missing/invalid/stage-mismatch →
  //        DOMAIN.STAGE_NOT_FOUND; without it no slice structure is known) ──
  let manifest: Manifest | null = null;
  try {
    manifest = manifestSource({
      projectRoot,
      stageId,
      manifestPath: input.manifestPath,
    }).manifest;
  } catch (err) {
    const reason = err instanceof ManifestSourceError ? err.reason : String(err);
    findings.push({
      code: 'DOMAIN.STAGE_NOT_FOUND',
      severity: 'error',
      message: `manifest source unavailable for stage "${stageId}": ${reason}`,
    });
  }
  if (manifest === null) {
    // No slice structure — nothing can be attributed; report the failure and
    // return the empty un-guessed state.
    return emptyResult(stageId, findings);
  }

  const sliceDefs = manifest.slices;
  const knownSlices = new Set(sliceDefs.map((s) => s.slice_id));
  const merge: MergeState = {
    categoryStates: [],
    validReads: [],
  };
  const baseCtx = { projectRoot, stageId, knownSlices, findings };

  // ── 2. Git source (PO-S02-C-02: non-git root → RUNTIME.SCHEMA_MISMATCH) ──
  let gitHead: string | null = null;
  try {
    const gitRoot = resolveGitRoot(projectRoot);
    gitHead = readGitHead(gitRoot);
  } catch (err) {
    const reason = err instanceof GitSourceError ? err.reason : String(err);
    findings.push({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
      message: `git source unavailable: ${reason}`,
    });
  }

  const gitBySlice = new Map<string, GitSourceResult>();
  if (gitHead !== null) {
    for (const sliceDef of sliceDefs) {
      try {
        gitBySlice.set(
          sliceDef.slice_id,
          gitSource({
            projectRoot,
            stageId,
            sliceId: sliceDef.slice_id,
            taskIds: sliceDef.tasks,
            evidencePath: sliceDef.evidence_path,
            tasksMdPath: input.tasksMdPath,
          }),
        );
      } catch (err) {
        const reason = err instanceof GitSourceError ? err.reason : String(err);
        findings.push({
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message: `git source unavailable for slice "${sliceDef.slice_id}": ${reason}`,
        });
      }
    }
  }

  // ── 3. Receipts source (PO-S02-C-03 per-category chain verification; ──
  //        PO-S02-C-05 misplacement; per-declared-slice + stage-level once) ──
  for (const sliceDef of sliceDefs) {
    for (const category of SLICE_LEVEL_CATEGORIES) {
      const result = readReceiptCategory({
        projectRoot,
        category,
        stageId,
        sliceId: sliceDef.slice_id,
      });
      handleCategoryRead(sliceDef.slice_id, category, result, baseCtx, merge, gitHead);
    }
  }
  for (const category of STAGE_LEVEL_CATEGORIES) {
    const result = readReceiptCategory({ projectRoot, category, stageId });
    handleCategoryRead(null, category, result, baseCtx, merge, gitHead);
  }

  // Receipt directories referencing slices the manifest does not declare.
  for (const dir of findUnknownSliceDirs(projectRoot, stageId, knownSlices)) {
    findings.push({
      code: 'DOMAIN.STAGE_NOT_FOUND',
      severity: 'error',
      message:
        `receipts reference unknown slice "${path.basename(dir)}" ` +
        `(directory ${relPath(projectRoot, dir)})`,
    });
  }

  // ── 4. Recoverable warn findings: task checked ↔ evidence missing ──
  //        (PO-S02-C-02 — only when the git facts are actually known)
  for (const sliceDef of sliceDefs) {
    const git = gitBySlice.get(sliceDef.slice_id);
    if (git === undefined) continue;
    for (const task of git.tasks) {
      const evidenceWritten =
        git.evidence.find((e) => e.task_id === task.task_id)?.evidence_written ?? false;
      if (task.checked && !evidenceWritten) {
        findings.push({
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'warn',
          message:
            `task "${task.task_id}" is checked in tasks.md but its evidence ` +
            `section is missing — recoverable`,
        });
      } else if (!task.checked && evidenceWritten) {
        findings.push({
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'warn',
          message:
            `task "${task.task_id}" has evidence written but is not checked in ` +
            `tasks.md — recoverable`,
        });
      }
    }
  }

  // ── 5. Assemble the normalized result with the per-slice/stage
  //        authoritative derivation (PO-S02-C-04 / PO-S02-A-05) ──
  const slices: ReconciledSliceState[] = sliceDefs.map((sliceDef) =>
    buildSliceState(
      sliceDef,
      gitBySlice.get(sliceDef.slice_id),
      buildSliceReceiptFacts(merge.validReads, sliceDef.slice_id),
    ),
  );

  // Deterministic flat receipt chain: all valid, attributed receipts of
  // chain-valid categories, ordered by (timestamp, digest), digest only.
  const orderedReads = [...merge.validReads].sort(compareReceiptsByTimestampDigest);
  const receiptChain = orderedReads.map((r) => r.receipt.digest);

  const receiptChainValid = merge.categoryStates.every(
    (c) => c.receipt_chain_valid,
  );

  // Stage derivation through S02-A `deriveStageState` (PO-S02-A-05): slice
  // aggregate facts + stage-boundary receipt presence → unique StageState;
  // READY folds into EXECUTING. A contradictory fact combination throws
  // StageStateDerivationError — surface the canonical DOMAIN.INVALID_TRANSITION
  // Finding and keep the un-guessed UNINITIALIZED default (never a guess).
  const stageReceipts: StageReceiptSummary = {
    has_stage_plan: merge.validReads.some((r) => r.receipt.type === 'STAGE_PLAN'),
    has_spv_pass: merge.validReads.some((r) => r.receipt.type === 'SPV_PASS'),
    has_stage_review_pass: merge.validReads.some(
      (r) => r.receipt.type === 'STAGE_REVIEW_PASS',
    ),
  };
  let stageState: StageState;
  try {
    stageState = deriveStageState({ slices, receipts: stageReceipts });
  } catch (err) {
    if (err instanceof StageStateDerivationError) {
      findings.push({
        code: 'DOMAIN.INVALID_TRANSITION',
        severity: 'error',
        message: err.message,
      });
      stageState = StageState.UNINITIALIZED;
    } else {
      throw err;
    }
  }

  return {
    stage_id: stageId,
    slices,
    stage_state: stageState,
    // project_state — deterministic derivation from the persisted facts
    // (HP-003, F-1): a PROJECT_REVIEW_PASS receipt in the shared `project/`
    // category chain proves the project review completed → COMPLETED;
    // otherwise a stage that completed its own stage review (COMPLETED) is
    // the next gate on the project-review path → UNDER_REVIEW; without any
    // positive fact the safe default is IN_PROGRESS (never a guess).
    project_state: deriveProjectState(merge.validReads, stageState),
    receipt_chain: receiptChain,
    findings: sortFindings(findings),
    receipt_chain_valid: receiptChainValid,
    receipt_categories: merge.categoryStates,
  };
}

/**
 * Deterministic project_state derivation from persisted facts (F-1):
 *   - an attributed PROJECT_REVIEW_PASS receipt → COMPLETED;
 *   - else stage COMPLETED (stage review passed, no project review yet) →
 *     UNDER_REVIEW — the project-level review is the gate AFTER the stage
 *     completed its stage review;
 *   - else → IN_PROGRESS (safe default; a missing manifest keeps the
 *     emptyResult default IN_PROGRESS — no facts to judge on).
 *
 * B1c semantics (blueprint §6.4 `run_e2e`): PROJECT_E2E_PASS /
 * PROJECT_E2E_FAIL / PROJECT_E2E_BLOCKED receipts (the project-level E2E gate
 * verdicts in the shared `project/` category) are EVIDENCE-only and NEVER
 * participate in this derivation — only PROJECT_REVIEW_PASS triggers
 * COMPLETED, so a FAILED E2E run can never prematurely complete the project.
 * The check below matches only PROJECT_REVIEW_PASS by construction, so the
 * E2E verdict receipts fall through to the stage-state branch unchanged.
 */
function deriveProjectState(
  validReads: readonly ReadReceiptResult[],
  stageState: StageState,
): ProjectState {
  if (validReads.some((r) => r.receipt.type === 'PROJECT_REVIEW_PASS')) {
    return ProjectState.COMPLETED;
  }
  if (stageState === StageState.COMPLETED) {
    return ProjectState.UNDER_REVIEW;
  }
  return ProjectState.IN_PROGRESS;
}
