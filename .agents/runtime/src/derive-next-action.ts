/**
 * derive-next-action.ts
 *
 * Deterministic state machine that maps the current slice/stage evidence state
 * to a single next action. Pure function — no I/O, no Session IDs, no side
 * effects. All inputs are persisted business facts.
 *
 * The derivation follows the rectification plan §13 rules:
 *
 *   Task evidence written but not checked          → recover
 *   First empty task in slice order                → implement (exactly one)
 *   All tasks checked, no finalize                 → finalize
 *   READY_FOR_CV, no CV receipt                    → fresh initial CV
 *   PENDING_RECHECK                                → fresh recheck CV
 *   REPAIR, repair_attempt = 0                     → repair
 *   REPAIR, repair_attempt = 1                     → diagnose
 *   REPAIR, repair_attempt >= 2                    → IMPLEMENTATION_DEFECT / UNRESOLVED_CV_FAILURE
 *   legacy REPLAN / BLOCKED / ESCALATION_REQUIRED   → fail closed (blocked)
 *   PASS without receipt-backed scope outcome       → Brain escalation
 *   PASS with receipt-backed scope outcome, no commit → Committer
 *   committed, no integration                      → Integration
 *   integrated                                     → SLICE_COMPLETE
 *   all slices complete                            → Stage Gate
 *   Stage Gate PASS receipt                        → STAGE_GATE_PASSED
 *   Unmet dependency (not all complete)            → blocked / Brain
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidStageGatePassReceipt, CvReceipt as CvReceiptSchema } from './schemas.js';
import type { CvReceipt, CvVerdict, Manifest, StageGateReceipt, CvLifecycleState, SliceCompleteFacts } from './schemas.js';

// ── Enum-like string constants ─────────────────────────────────────────────────

/** Possible next action types derived from state. */
export type NextActionType =
  | 'recover'
  | 'implement'
  | 'finalize'
  | 'sync_cv_status'
  | 'initial_cv'
  | 'recheck_cv'
  | 'repair'
  | 'diagnose'
  | 'unresolved_cv_failure'
  | 'implement_defect'
  | 'brain_escalation'
  | 'committer'
  | 'integration'
  | 'slice_complete'
  | 'stage_gate'
  | 'stage_gate_passed'
  | 'blocked';

/** Possible CV Status values in a Slice Evidence `## Current CV Status` section. */
export type CvStatus = CvLifecycleState |
  // Compatibility adapter for evidence written before lifecycle/verdict
  // separation. Legacy routed verdict strings are intentionally not accepted.
  'PENDING_RECHECK' | 'PASS' | 'REPAIR';

export function canonicalCvStatus(status: CvStatus): CvLifecycleState {
  switch (status) {
    case 'PASS': return 'CV_PASS';
    case 'REPAIR': return 'CV_REPAIR_REQUIRED';
    case 'PENDING_RECHECK': return 'CV_VERIFYING';
    default: return status;
  }
}

const CV_STATUS_VERDICT: Partial<Record<CvLifecycleState, CvVerdict>> = {
  CV_PASS: 'PASS', CV_REPAIR_REQUIRED: 'REPAIR', CV_REPLAN_REQUIRED: 'REPLAN',
  CV_BLOCKED: 'BLOCKED', CV_ESCALATION_REQUIRED: 'ESCALATION_REQUIRED',
};

// These values were once accepted as lifecycle statuses, but are not state
// machine inputs anymore. Treating one as a routed state would let mutable
// evidence manufacture an action without a receipt-bound CV verdict.
const LEGACY_ROUTE_STATUSES = new Set<string>(['REPLAN', 'BLOCKED', 'ESCALATION_REQUIRED']);

// ── Input state types ──────────────────────────────────────────────────────────

/** Status of a single task checkbox in the Slice Evidence. */
export interface TaskCheckboxState {
  task_id: string;
  /** Whether the task checkbox is checked ([x] vs [ ]). */
  checked: boolean;
  /** Whether task evidence has been written (section is non-empty, not the placeholder). */
  evidence_written: boolean;
}

/** State of a slice's evidence and CV lifecycle. */
export interface SliceDeriveState {
  slice_id: string;
  /** Slice dependency IDs. */
  dependencies: string[];
  /** Task checkbox states, in manifest declaration order. */
  tasks: TaskCheckboxState[];
  /** Whether `## Current Slice Evidence > Proof Obligation Coverage` is finalized. */
  slice_evidence_finalized: boolean;
  /** Current CV status from `## Current CV Status > Status`. */
  cv_status: CvStatus;
  /** Evidence 文件中实际保存的展示状态。 */
  persisted_cv_status: CvStatus;
  /** 是否需要同步 Evidence 中的展示状态到权威状态。 */
  status_sync_required: boolean;
  /** 同步目标状态。 */
  status_sync_target?: CvLifecycleState;
  /** Number of repair attempts so far. */
  repair_attempt: number;
  /** Whether scope check has passed (required before Committer can proceed). */
  scope_check_passed: boolean;
  /** Most recent CV receipt, if any. */
  latest_cv_receipt?: CvReceipt | null;
  /** Verifiable persisted facts used to authorize Slice COMPLETE. */
  slice_complete_facts?: SliceCompleteFacts | null;
  /** Whether the slice has been committed (Committer step done). */
  committed: boolean;
  /** Whether the slice has been integrated (integration step done). */
  integrated: boolean;
  /** Whether this slice is complete (all upstream tasks done). */
  complete: boolean;
}

/** Overall stage-gate state. */
export interface StageGateState {
  /** Legacy runtime hint. It is deliberately ignored for authorization. */
  gate_run?: boolean;
  /** Legacy caller boolean. It is deliberately ignored for authorization. */
  gate_passed?: boolean;
  /** Persisted receipt data loaded from disk. */
  receipt?: StageGateReceipt | null;
  /** Absolute or repository-relative path of the persisted receipt. */
  receipt_path?: string;
  /**
   * Files found in the CV receipt directory that failed to parse.
   * Populated by reconcile-stage-state when invalid CV receipt files are detected.
   * When non-empty, derive-next-action should escalate rather than silently proceeding.
   */
  cv_receipt_invalid_files?: string[];
}

export interface PersistedStageFacts {
  stage_id: string;
  manifest?: Pick<Manifest, 'stage_id' | 'source_digest' | 'slices'>;
  manifest_digest?: string;
  /** Canonical persisted CV receipts, ordered oldest to newest. */
  cv_receipts?: CvReceipt[];
}

/** Complete input for deriveNextAction. */
export interface DeriveNextActionInput extends Partial<PersistedStageFacts> {
  /** Stage Gate state. */
  stage_gate: StageGateState;
  /** All slices in manifest declaration order (deterministic). */
  slices: SliceDeriveState[];
  /** Whether the stage has been committed (all slices). */
  stage_committed?: boolean;
  /** Whether the stage has been integrated. */
  stage_integrated?: boolean;
}

// ── Output action type ─────────────────────────────────────────────────────────

export interface NextAction {
  /** Plan-shaped action name. `action_type` remains as a compatibility adapter. */
  action: NextActionType;
  /** The single next action to take (compatibility adapter). */
  action_type: NextActionType;
  /** Slice this action applies to, if relevant. */
  slice_id?: string;
  /** Task this action applies to, if relevant. */
  task_id?: string;
  /** Mode for implement / finalize / etc. */
  mode?: string;
  /** Contract reference for the action. */
  contract_ref?: string;
  /** Canonical contract path for dispatchers that need the full reference. */
  contract?: string;
  /** Human-readable justification for the derivation. */
  reason: string;
}

// ── Derivation engine ──────────────────────────────────────────────────────────

/** Keep the historical action_type while exposing the plan-shaped action. */
function action(actionType: NextActionType, fields: Omit<NextAction, 'action' | 'action_type' | 'reason'> & { reason: string }): NextAction {
  return { action: actionType, action_type: actionType, ...fields };
}

/**
 * Derive the single next action from the current state of all slices.
 *
 * The derivation is deterministic and follows these priority rules:
 *
 * 1. Stage Gate already passed → STAGE_GATE_PASSED (terminal)
 * 2. All slices complete → STAGE GATE action
 * 3. For each incomplete slice (in manifest order):
 *    a. Dependency not satisfied → blocked / Brain
 *    b. Task fact reconciliation: any checked !== evidence_written → recover (consistency)
 *    c. First empty task → implement (exactly one)
 *    d. All tasks checked, not finalized → finalize
 *    e. CV state machine → initial CV / recheck / repair / diagnose / escalation
 *    f. PASS without receipt-backed scope outcome → Brain escalation
 *    g. PASS with receipt-backed scope outcome, no commit → Committer
 *    h. Commit no integration → Integration
 *    i. Integrated → SLICE_COMPLETE
 * 4. Fallback → blocked
 */
export function deriveNextAction(input: DeriveNextActionInput): NextAction {
  const { stage_gate, slices } = input;
  const stageId = input.stage_id ?? input.manifest?.stage_id;
  const manifestSliceIds = input.manifest?.slices.map(slice => slice.slice_id) ?? slices.map(slice => slice.slice_id);
  const manifestIds = new Set(manifestSliceIds);
  const manifestAndStageAgree = !input.manifest || !input.stage_id || input.manifest.stage_id === input.stage_id;
  // A loaded manifest without its canonical digest cannot be bound to a gate
  // receipt.  Falling back to source_digest would authorize a receipt for a
  // different (canonical) manifest representation.
  const manifestFactsAvailable = !input.manifest || (typeof input.manifest_digest === 'string' && input.manifest_digest.length > 0);

  // Only the file on disk is authoritative.  In particular, stage_gate.receipt
  // is intentionally not used: accepting an object supplied by the dispatcher
  // would turn a caller-controlled fact into a terminal authorization.
  let persistedReceipt: unknown;
  if (stage_gate.receipt_path) {
    try {
      const resolvedReceiptPath = path.resolve(stage_gate.receipt_path);
      let current = resolvedReceiptPath;
      while (true) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error('symlinked receipt path');
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      const stat = fs.lstatSync(resolvedReceiptPath);
      if (!stat.isFile()) throw new Error('not a regular receipt file');
      persistedReceipt = JSON.parse(fs.readFileSync(resolvedReceiptPath, 'utf8'));
    } catch {
      persistedReceipt = undefined;
    }
  }
  const receiptIsValid = Boolean(
    manifestAndStageAgree && manifestFactsAvailable && stageId && stage_gate.receipt_path && persistedReceipt &&
    isValidStageGatePassReceipt(
      persistedReceipt,
      stageId,
      input.manifest_digest,
      manifestSliceIds,
    ),
  );

  // A caller boolean can never authorize this terminal action.  The receipt,
  // manifest, and completed slice facts must all agree (including a duplicate
  // ID check so two facts cannot masquerade as two manifest slices).
  const sliceFactsMatchManifest = manifestAndStageAgree && slices.length === manifestIds.size &&
    new Set(slices.map(slice => slice.slice_id)).size === slices.length &&
    slices.every(slice => manifestIds.has(slice.slice_id));
  const persistedSliceFactsMatch = sliceFactsMatchManifest && slices.every(slice => {
    const facts = slice.slice_complete_facts;
    return Boolean(facts && facts.slice_id === slice.slice_id && facts.cv.verdict === 'PASS' &&
      facts.commit.commit_sha && facts.integration.integration_ref);
  });
  if (receiptIsValid && sliceFactsMatchManifest && persistedSliceFactsMatch && slices.every(s => s.complete)) {
    return action('stage_gate_passed', {
      reason: 'Stage Gate PASS is persisted for this stage, manifest, and every manifest slice.',
      contract_ref: 'execute-stage', contract: '.agents/contracts/brain/execute-stage.md', mode: 'return',
    });
  }

  // ── All slices complete → Stage Gate ──
  const incompleteSlices = slices.filter(s => !s.complete);
  if (incompleteSlices.length === 0) {
    return action('stage_gate', {
      mode: 'run-stage', contract_ref: 'execute-stage', contract: '.agents/contracts/brain/execute-stage.md',
      reason: `All ${slices.length} slices complete in the manifest. Run Stage Gate and persist its receipt before returning PASS.`
    });
  }

  // ── Process incomplete slices in order ──
  let allBlockedByDependency = true;
  const hasInvalidPersistedCvHistory = input.cv_receipts?.some(receipt => !CvReceiptSchema.safeParse(receipt).success) ?? false;

  for (const slice of slices) {
    if (slice.complete) continue;

    // ── Dependency check ──
    // If a slice has an unmet dependency, skip it and try later slices.
    // Only return 'blocked' if NO slice in the stage is runnable.
    let dependencyBlocked = false;
    for (const depId of slice.dependencies) {
      const depSlice = slices.find(s => s.slice_id === depId);
      if (!depSlice || !depSlice.complete) {
        dependencyBlocked = true;
        break;
      }
    }
    if (dependencyBlocked) {
      continue; // skip this slice, try later runnable slices
    }

    // This slice is not blocked by dependencies
    allBlockedByDependency = false;

    // ── Task ordering is evidence-before-checkbox, strictly in task order ──
    // Never dispatch a later task when the first unchecked task already has
    // evidence.  Recovery closes the consistency boundary without rerunning
    // RED/GREEN for completed work.
    for (const t of slice.tasks) {
      // Reconcile the first inconsistency in declaration order. This makes an
      // unchecked task with evidence win over every later task, while also
      // preventing dispatch past a checked task with missing evidence.
      if (!t.checked && t.evidence_written) {
        return action('recover', {
          slice_id: slice.slice_id, task_id: t.task_id,
          mode: 'recover-task', contract_ref: 'worker', contract: '.agents/contracts/executor/worker.md',
          reason: `Task "${t.task_id}" is the first unchecked task and already has evidence; recover it before dispatching any later task.`,
        });
      }
      if (t.checked && !t.evidence_written) {
        return action('recover', {
          slice_id: slice.slice_id, task_id: t.task_id,
          mode: 'recover-task', contract_ref: 'worker', contract: '.agents/contracts/executor/worker.md',
          reason: `Task "${t.task_id}" has a checkbox without persisted evidence; this inconsistency must be recovered before dispatching later work.`
        });
      }
      if (!t.checked) {
        return action('implement', {
          slice_id: slice.slice_id, task_id: t.task_id,
          mode: 'implement-task', contract_ref: 'worker', contract: '.agents/contracts/executor/worker.md',
          reason: `Slice "${slice.slice_id}" first unchecked task is "${t.task_id}". Worker implements exactly this one task.`,
        });
      }
    }

    // ── All tasks checked but evidence not finalized ──
    const allTasksChecked = slice.tasks.length > 0 && slice.tasks.every(t => t.checked);
    if (allTasksChecked && !slice.slice_evidence_finalized) {
      return action('finalize', {
        slice_id: slice.slice_id, mode: 'finalize-slice', contract_ref: 'worker', contract: '.agents/contracts/executor/worker.md',
        reason: `Slice "${slice.slice_id}" all ${slice.tasks.length} tasks checked. Worker must finalize Slice Evidence.`,
      });
    }

    // ── sync_cv_status: 修复中断导致的展示状态与权威状态不一致 ──
    if (slice.status_sync_required && slice.status_sync_target) {
      return action('sync_cv_status', {
        slice_id: slice.slice_id,
        mode: 'sync',
        contract_ref: 'runtime',
        contract: '.agents/runtime/dist/update-current-cv-status.js',
        reason: `Persisted CV display state must be synchronized to ${slice.status_sync_target}.`,
      });
    }

    // ── CV state machine ──
    if (hasInvalidPersistedCvHistory) {
      return action('brain_escalation', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
        reason: 'Persisted CV receipt history contains an invalid receipt; lifecycle state cannot be derived.' });
    }
    const parsedCvReceipt = slice.latest_cv_receipt ? CvReceiptSchema.safeParse(slice.latest_cv_receipt) : null;
    const cvReceipt = parsedCvReceipt?.success ? parsedCvReceipt.data : null;
    const cvStatus = slice.cv_status;
    if (stageId && slice.latest_cv_receipt && (!cvReceipt || cvReceipt.stage_id !== stageId || cvReceipt.slice_id !== slice.slice_id)) {
      return action('brain_escalation', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Slice "${slice.slice_id}" has an invalid or mismatched persisted CV receipt; lifecycle state cannot be derived.` });
    }

    if (stageId && (cvStatus === 'REPAIR' || cvStatus === 'PENDING_RECHECK') && !cvReceipt) {
      return action('brain_escalation', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Slice "${slice.slice_id}" has ${cvStatus} status without a matching persisted CV receipt.` });
    }

    // Legacy routed statuses are rejected rather than adapted to a route. A
    // persisted receipt cannot resurrect this removed input format; callers
    // must use the canonical CV_* lifecycle state.
    if (LEGACY_ROUTE_STATUSES.has(cvStatus)) {
      return action('blocked', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Legacy CV status "${cvStatus}" is unsupported; no lifecycle action is authorized without a canonical receipt-bound state.` });
    }
    const lifecycleStatus = canonicalCvStatus(cvStatus);
    const expectedVerdict = CV_STATUS_VERDICT[lifecycleStatus];
    const legacyCompatibilityStatus = cvStatus === 'PASS' || cvStatus === 'REPAIR' || cvStatus === 'PENDING_RECHECK';
    // Canonical lifecycle outcomes are never routed from a mutable status
    // alone. The receipt must be valid, latest, and verdict-aligned.
    const historyForSlice = input.cv_receipts?.filter(receipt => {
      const parsed = CvReceiptSchema.safeParse(receipt);
      return parsed.success && parsed.data.stage_id === stageId && parsed.data.slice_id === slice.slice_id;
    }) ?? [];
    if (stageId && historyForSlice.length > 0) {
      const historyLatest = historyForSlice[historyForSlice.length - 1];
      if (!cvReceipt || historyLatest.verdict !== cvReceipt.verdict || historyLatest.snapshot !== cvReceipt.snapshot) {
        return action('brain_escalation', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
          reason: `Slice "${slice.slice_id}" latest CV receipt does not match persisted receipt history.` });
      }
    }
    if (expectedVerdict && (!cvReceipt || cvReceipt.verdict !== expectedVerdict) && !(legacyCompatibilityStatus && !stageId)) {
      return action('brain_escalation', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Slice "${slice.slice_id}" lifecycle state ${lifecycleStatus} lacks a latest immutable CV receipt with verdict ${expectedVerdict}.` });
    }

    if (lifecycleStatus === 'READY_FOR_CV') {
      // Derive: no CV receipt → initial; otherwise recheck
      if (!cvReceipt) {
        return action('initial_cv', {
          slice_id: slice.slice_id, mode: 'initial', contract_ref: 'code-verifier', contract: '.agents/contracts/executor/code-verifier.md',
          reason: `Slice "${slice.slice_id}" is READY_FOR_CV with no prior receipt. Code Verifier performs initial CV.`,
        });
      }
    }

    if (lifecycleStatus === 'CV_VERIFYING') {
      // A prior REPAIR receipt means this is the recheck boundary. Without a
      // receipt, verification is in-flight and must not be dispatched twice.
      if (cvReceipt?.verdict === 'REPAIR' || cvStatus === 'PENDING_RECHECK') {
        return action('recheck_cv', {
          slice_id: slice.slice_id, mode: 'recheck', contract_ref: 'code-verifier', contract: '.agents/contracts/executor/code-verifier.md',
          reason: `Slice "${slice.slice_id}" is CV_VERIFYING after repair. Code Verifier performs fresh recheck CV.`,
        });
      }
      return action('brain_escalation', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Slice "${slice.slice_id}" is CV_VERIFYING without a verifiable prior receipt.` });
    }

    if (cvStatus === 'PENDING_RECHECK') {
      return action('recheck_cv', {
        slice_id: slice.slice_id, mode: 'recheck', contract_ref: 'code-verifier', contract: '.agents/contracts/executor/code-verifier.md',
        reason: `Slice "${slice.slice_id}" is PENDING_RECHECK after repair. Code Verifier performs fresh recheck CV.`,
      });
    }

    if (lifecycleStatus === 'CV_REPAIR_REQUIRED') {
      // With stage facts available, repair_attempt is derived only from the
      // receipt history.  The legacy counter remains a compatibility adapter
      // for callers that do not identify a stage at all.
      const persistedRepairCount = stageId
        ? (input.cv_receipts
          ? input.cv_receipts.filter(receipt => {
              const parsed = CvReceiptSchema.safeParse(receipt);
              return parsed.success && parsed.data.stage_id === stageId &&
                parsed.data.slice_id === slice.slice_id && parsed.data.verdict === 'REPAIR';
            }).length
          : (cvReceipt?.verdict === 'REPAIR' ? 1 : 0))
        : slice.repair_attempt + 1;
      const repairAttempt = Math.max(0, persistedRepairCount - 1);
      if (repairAttempt === 0) {
        return action('repair', { slice_id: slice.slice_id, mode: 'repair', contract_ref: 'worker', contract: '.agents/contracts/executor/worker.md',
          reason: `Slice "${slice.slice_id}" CV returned REPAIR. Worker performs first repair attempt.` });
      }
      if (repairAttempt === 1) {
        return action('diagnose', { slice_id: slice.slice_id, mode: 'diagnose', contract_ref: 'worker', contract: '.agents/contracts/executor/worker.md',
          reason: `Slice "${slice.slice_id}" CV still REPAIR after one persisted repair receipt. Worker diagnoses the root cause.` });
      }
      return action('unresolved_cv_failure', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Slice "${slice.slice_id}" CV still REPAIR after ${repairAttempt} attempts (persisted repair receipts). Escalated as IMPLEMENTATION_DEFECT / UNRESOLVED_CV_FAILURE.` });
    }

    if (lifecycleStatus === 'CV_REPLAN_REQUIRED' || lifecycleStatus === 'CV_BLOCKED' || lifecycleStatus === 'CV_ESCALATION_REQUIRED') {
      return action('brain_escalation', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Slice "${slice.slice_id}" CV status is "${cvStatus}". Requires Brain escalation.` });
    }

    // ── CV PASS → Committer / Integration / post-merge ──
    // Scope is a CV receipt fact, not a standalone action or a caller boolean.
    if (lifecycleStatus === 'CV_PASS') {
      // Scope is a persisted CV outcome and is folded into the existing
      // Committer → Integration flow.  Never dispatch a standalone scope_check
      // action, and never let the mutable compatibility boolean override a
      // persisted receipt when stage facts are available.
      const scopePassed = stageId
        ? Boolean(cvReceipt && cvReceipt.verdict === 'PASS' && cvReceipt.scope_violations.length === 0)
        : slice.scope_check_passed; // compatibility adapter for legacy callers without persisted stage facts
      if (!scopePassed) {
        return action('brain_escalation', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
          reason: `Slice "${slice.slice_id}" has PASS status without a persisted PASS receipt proving scope outcome; no standalone scope gate is dispatched.` });
      }
      if (!slice.committed) return action('committer', { slice_id: slice.slice_id, mode: 'slice-output', contract_ref: 'committer', contract: '.agents/contracts/executor/committer.md',
        reason: `Slice "${slice.slice_id}" CV PASS and persisted scope outcome PASS. Committer closes the slice boundary.` });
      if (!slice.integrated) return action('integration', { slice_id: slice.slice_id, mode: 'post-merge', contract_ref: 'integration', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Slice "${slice.slice_id}" committed but not integrated. Run Integration and post-merge checks.` });
      return action('slice_complete', { slice_id: slice.slice_id, mode: 'complete', contract_ref: 'execute-stage', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Slice "${slice.slice_id}" is PASS, committed, integrated, and ready to mark complete.` });
    }

    // ── SLICE_COMPLETE status — just mark it ──
    if (lifecycleStatus === 'SLICE_COMPLETE') {
      return action('slice_complete', { slice_id: slice.slice_id, mode: 'complete', contract_ref: 'execute-stage', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Slice "${slice.slice_id}" is already marked SLICE_COMPLETE.` });
    }

    // ── NOT_RUN with no tasks → blocked (no work defined) ──
    if (cvStatus === 'NOT_RUN' && slice.tasks.length === 0) {
      return action('blocked', { slice_id: slice.slice_id, mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
        reason: `Slice "${slice.slice_id}" has no tasks and CV NOT_RUN. No work can proceed.` });
    }
  }

  // ── Fallback ──
  if (allBlockedByDependency) {
    return action('blocked', { mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
      reason: 'All remaining incomplete slices have unmet dependencies. No runnable slice available.' });
  }
  return action('blocked', { mode: 'escalate', contract_ref: 'brain', contract: '.agents/contracts/brain/execute-stage.md',
    reason: 'No actionable state found. All slices may have unmet preconditions.' });
}

/**
 * Determine the initial CV status for a Slice Evidence skeleton.
 */
export function deriveInitialCvStatus(cvMinimumLevel: string): CvStatus {
  return 'NOT_RUN';
}

/**
 * Map a CV Verdict to a CV status for the `## Current CV Status` section.
 */
export function cvVerdictToLifecycleState(verdict: CvVerdict): CvLifecycleState {
  switch (verdict) {
    case 'PASS': return 'CV_PASS';
    case 'REPAIR': return 'CV_REPAIR_REQUIRED';
    case 'REPLAN': return 'CV_REPLAN_REQUIRED';
    case 'BLOCKED': return 'CV_BLOCKED';
    case 'ESCALATION_REQUIRED': return 'CV_ESCALATION_REQUIRED';
  }
}

/** Compatibility adapter that now emits canonical lifecycle states. */
export function cvVerdictToStatus(verdict: CvVerdict): CvStatus {
  return cvVerdictToLifecycleState(verdict);
}

/**
 * Determine the next CV status after a recheck is dispatched.
 */
export function derivePostRecheckStatus(currentCvStatus: CvStatus): CvStatus {
  if (currentCvStatus === 'REPAIR' || currentCvStatus === 'CV_REPAIR_REQUIRED') {
    return currentCvStatus === 'CV_REPAIR_REQUIRED' ? 'CV_VERIFYING' : 'PENDING_RECHECK';
  }
  return currentCvStatus;
}

// ── CLI runtime validation ──────────────────────────────────────────────────────

const VALID_CV_STATUSES: ReadonlySet<string> = new Set([
  'NOT_RUN',
  'READY_FOR_CV',
  'CV_VERIFYING',
  'CV_REPAIR_REQUIRED',
  'CV_REPLAN_REQUIRED',
  'CV_BLOCKED',
  'CV_ESCALATION_REQUIRED',
  'CV_PASS',
  'SLICE_COMPLETE',
  // compatibility adapters (legacy routed verdict strings are rejected)
  'PENDING_RECHECK', 'PASS', 'REPAIR',
]);

interface ValidationResult {
  valid: true;
  input: DeriveNextActionInput;
}

interface ValidationError {
  valid: false;
  error: string;
}

/**
 * Perform minimal fail-closed runtime validation of a DeriveNextActionInput.
 *
 * Rejects missing/invalid stage_gate, non-array/missing slices, missing required
 * slice fields, illegal cv_status values, and non-integer repair_attempt.
 */
function validateDeriveInput(data: unknown): ValidationResult | ValidationError {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Input must be a JSON object.' };
  }
  const obj = data as Record<string, unknown>;

  // ── stage_gate ──
  if (!obj.stage_gate || typeof obj.stage_gate !== 'object') {
    return { valid: false, error: 'Missing or invalid "stage_gate": must be an object.' };
  }
  const sg = obj.stage_gate as Record<string, unknown>;
  if (sg.gate_run !== undefined && typeof sg.gate_run !== 'boolean') {
    return { valid: false, error: '"stage_gate.gate_run" must be a boolean when provided.' };
  }
  if (sg.gate_passed !== undefined && typeof sg.gate_passed !== 'boolean') {
    return { valid: false, error: '"stage_gate.gate_passed" must be a boolean when provided.' };
  }
  if (sg.receipt_path !== undefined && typeof sg.receipt_path !== 'string') {
    return { valid: false, error: '"stage_gate.receipt_path" must be a string when provided.' };
  }
  if (obj.stage_id !== undefined && typeof obj.stage_id !== 'string') {
    return { valid: false, error: '"stage_id" must be a string when provided.' };
  }
  if (obj.manifest_digest !== undefined && typeof obj.manifest_digest !== 'string') {
    return { valid: false, error: '"manifest_digest" must be a string when provided.' };
  }

  // ── slices ──
  if (!Array.isArray(obj.slices)) {
    return { valid: false, error: '"slices" must be an array.' };
  }
  for (let i = 0; i < obj.slices.length; i++) {
    const slice = obj.slices[i];
    if (!slice || typeof slice !== 'object') {
      return { valid: false, error: `slices[${i}] must be an object.` };
    }
    const s = slice as Record<string, unknown>;

    if (typeof s.slice_id !== 'string' || s.slice_id === '') {
      return { valid: false, error: `slices[${i}].slice_id must be a non-empty string.` };
    }
    if (!Array.isArray(s.dependencies)) {
      return { valid: false, error: `slices[${i}].dependencies must be an array.` };
    }
    if (!Array.isArray(s.tasks)) {
      return { valid: false, error: `slices[${i}].tasks must be an array.` };
    }
    if (typeof s.slice_evidence_finalized !== 'boolean') {
      return { valid: false, error: `slices[${i}].slice_evidence_finalized must be a boolean.` };
    }
    if (typeof s.cv_status !== 'string' || !VALID_CV_STATUSES.has(s.cv_status)) {
      return {
        valid: false,
        error: `slices[${i}].cv_status must be one of: ${[...VALID_CV_STATUSES].join(', ')}. Got "${String(s.cv_status)}".`,
      };
    }
    if (typeof s.repair_attempt !== 'number' || !Number.isInteger(s.repair_attempt) || s.repair_attempt < 0) {
      return { valid: false, error: `slices[${i}].repair_attempt must be a non-negative integer.` };
    }
    if (typeof s.committed !== 'boolean') {
      return { valid: false, error: `slices[${i}].committed must be a boolean.` };
    }
    if (typeof s.integrated !== 'boolean') {
      return { valid: false, error: `slices[${i}].integrated must be a boolean.` };
    }
    if (typeof s.complete !== 'boolean') {
      return { valid: false, error: `slices[${i}].complete must be a boolean.` };
    }

    // Validate each task
    const tasks = s.tasks as unknown[];
    for (let j = 0; j < tasks.length; j++) {
      const task = tasks[j];
      if (!task || typeof task !== 'object') {
        return { valid: false, error: `slices[${i}].tasks[${j}] must be an object.` };
      }
      const t = task as Record<string, unknown>;
      if (typeof t.task_id !== 'string' || t.task_id === '') {
        return { valid: false, error: `slices[${i}].tasks[${j}].task_id must be a non-empty string.` };
      }
      if (typeof t.checked !== 'boolean') {
        return { valid: false, error: `slices[${i}].tasks[${j}].checked must be a boolean.` };
      }
      if (typeof t.evidence_written !== 'boolean') {
        return { valid: false, error: `slices[${i}].tasks[${j}].evidence_written must be a boolean.` };
      }
    }

    // Validate scope_check_passed
    if (typeof s.scope_check_passed !== 'boolean') {
      return { valid: false, error: `slices[${i}].scope_check_passed must be a boolean.` };
    }

    // Validate latest_cv_receipt if present
    if (s.latest_cv_receipt !== undefined && s.latest_cv_receipt !== null) {
      if (typeof s.latest_cv_receipt !== 'object') {
        return { valid: false, error: `slices[${i}].latest_cv_receipt must be an object or null.` };
      }
    }
    if (s.slice_complete_facts !== undefined && s.slice_complete_facts !== null &&
        typeof s.slice_complete_facts !== 'object') {
      return { valid: false, error: `slices[${i}].slice_complete_facts must be an object or null.` };
    }
  }

  // ── stage-level booleans ──
  if (obj.stage_committed !== undefined && typeof obj.stage_committed !== 'boolean') {
    return { valid: false, error: '"stage_committed" must be a boolean when provided.' };
  }
  if (obj.stage_integrated !== undefined && typeof obj.stage_integrated !== 'boolean') {
    return { valid: false, error: '"stage_integrated" must be a boolean when provided.' };
  }

  return { valid: true, input: data as DeriveNextActionInput };
}

// ── CLI entry point ─────────────────────────────────────────────────────────────

function isScriptEntry(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  try {
    const resolved = path.resolve(scriptPath);
    const currentFile = fileURLToPath(import.meta.url);
    return resolved === currentFile;
  } catch {
    const base = path.basename(scriptPath);
    return base === 'derive-next-action.js' || base === 'derive-next-action.ts';
  }
}

if (isScriptEntry()) {
  const arg1 = process.argv[2];
  const arg2 = process.argv[3];

  // Support --json flag for inline JSON input
  let raw: string;
  if (arg1 === '--json') {
    raw = arg2 || '';
  } else if (arg1) {
    try {
      raw = fs.readFileSync(arg1, 'utf-8');
    } catch (err) {
      console.error(`Error: Cannot read state file "${arg1}": ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    raw = '';
  }

  if (!raw) {
    console.error('Usage: node dist/derive-next-action.js <state.json>');
    console.error('       node dist/derive-next-action.js --json \'<json>\'');
    console.error('');
    console.error('Reads a JSON state file (or inline JSON with --json flag)');
    console.error('and outputs the derived next action as JSON to stdout.');
    console.error('');
    console.error('The state.json must conform to DeriveNextActionInput:');
    console.error('  { stage_gate: {...}, slices: [...], stage_committed: bool, stage_integrated: bool }');
    process.exit(1);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const validation = validateDeriveInput(data);
  if (!validation.valid) {
    console.error(`Validation Error: ${validation.error}`);
    process.exit(1);
  }

  try {
    const result = deriveNextAction(validation.input);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(`Error deriving next action: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
