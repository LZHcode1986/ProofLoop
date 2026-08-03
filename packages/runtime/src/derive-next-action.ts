/**
 * @proofloop/runtime — Deterministic next-action derivation (PO-S02-D-01 /
 * PO-S02-D-02 pure-function side, S02-D-T01)
 *
 * `deriveNextAction` implements the S02-D priority table (rows 0–13) as an
 * explicitly ordered, deterministic mapping from the reconciled persisted
 * facts to exactly one canonical `NextAction` from the 15-value closed set.
 *
 * The input is the S02-C `ReconciledStageState` shape, optionally extended by
 * the persisted facts of `NextActionExtras` that Reconcile does not yet carry:
 *   - `repartition_requested`    — manifest canonical fact (F-S02-08);
 *   - `gate_pass_present` /
 *     `gate_fail_present`        — GATE_PASS / GATE_FAIL receipt existence;
 *   - `receipt_chain_valid`      — overall chain validity (ReconcileStageResult
 *                                  carries it; absent defaults to true, the
 *                                  same vacuous default as an empty chain);
 *   - `evidence_file_present_by_slice` — per-slice evidence-file existence
 *                                  (absent defaults to present — see row 10a);
 *   - `pending_worker_result_envelopes` — persisted worker result envelopes
 *                                  awaiting admit (S02-B `WorkerResultEnvelope`);
 *   - `pending_cv_result_envelopes` — persisted CV result envelopes awaiting
 *                                  admit (existence + stage/slice binding only;
 *                                  S03 defines the precise schema).
 *
 * Every branch is decided ONLY from persisted facts carried in the input
 * state — no timestamps, no randomness, no cache, no external calls
 * (HP-003). The first matching row wins; the function never emits multiple
 * actions and never emits a non-canonical action (kernel §5 closed sets).
 *
 * Row 10 dependency rule: incomplete slices are scanned in manifest
 * declaration order; a slice whose dependency is not complete is skipped
 * (jump to the first runnable slice). The same dependency rule gates the
 * per-slice rows 6–9 (a slice cannot be acted upon before its dependency is
 * complete).
 */

import { StageState, SliceState, CVStatus } from '@proofloop/kernel';
import type { Finding, NextAction, RoleType } from '@proofloop/kernel';
import type { ReconciledStageState, ReconciledSliceState } from './state-model';
import type { WorkerResultEnvelope, WorkerStepMode } from './relay-contract';

// ============================================================
// Public input/output shapes
// ============================================================

/**
 * Minimal existence+binding fact of a pending CV result envelope.
 *
 * S02 only depends on envelope existence and its stage/slice binding (the
 * CV verdict envelope shares the WorkerResultEnvelope mechanism/lifecycle);
 * S03 defines the precise schema.
 */
export interface PendingCvResultEnvelope {
  /** Owning stage id (binding). */
  readonly stageId: string;
  /** Owning slice id (binding) — optional when the verdict is stage-scoped. */
  readonly sliceId?: string;
}

/**
 * Optional persisted facts supplementing `ReconciledStageState`.
 *
 * All fields are optional so that a plain `ReconciledStageState` (Reconcile
 * output) is a valid input; absent facts never enable an action that
 * requires positive knowledge (HP-003 — never a guess).
 */
export interface NextActionExtras {
  /** Manifest canonical persisted fact: repartition requested (F-S02-08). */
  readonly repartition_requested?: boolean;
  /** A GATE_PASS receipt exists for this stage. */
  readonly gate_pass_present?: boolean;
  /** A GATE_FAIL receipt exists for this stage (error-level inconsistency). */
  readonly gate_fail_present?: boolean;
  /** Overall receipt-chain validity (false blocks every execution action). */
  readonly receipt_chain_valid?: boolean;
  /** Per-slice evidence-file presence; absent defaults to present. */
  readonly evidence_file_present_by_slice?: Readonly<Record<string, boolean>>;
  /** Worker result envelopes awaiting admit, bound to this stage. */
  readonly pending_worker_result_envelopes?: readonly WorkerResultEnvelope[];
  /** CV result envelopes awaiting admit, bound to this stage. */
  readonly pending_cv_result_envelopes?: readonly PendingCvResultEnvelope[];
}

/** Input to `deriveNextAction` — the reconciled stage state + extras. */
export type DeriveNextActionInput = ReconciledStageState & NextActionExtras;

/**
 * The unique next action aligned with the proofloop_next contract:
 * action ∈ 15-value closed set, non-empty readable action_detail,
 * responsible_role ∈ 10-value RoleType closed set, boolean chain validity,
 * findings array. Slice/task/mode context is attached for DISPATCH_WORKER /
 * RUN_CV / ADMIT class actions so the T02 pipeline can wrap without
 * re-deriving.
 */
export interface DerivedNextAction {
  readonly action: NextAction;
  readonly action_detail: string;
  readonly responsible_role: RoleType;
  readonly receipt_chain_valid: boolean;
  readonly findings: readonly Finding[];
  readonly slice_id?: string;
  readonly task_id?: string;
  /** Worker mode for DISPATCH_WORKER (implement/recover/finalize/repair/diagnose). */
  readonly mode?: WorkerStepMode;
}

// ============================================================
// Deterministic finding ordering — canonical (code, severity, message)
// ============================================================

/** Deterministic comparator mirroring Reconcile's canonical order. */
function compareFindings(a: Finding, b: Finding): number {
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  if (a.severity !== b.severity) return a.severity < b.severity ? -1 : 1;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  return 0;
}

/** Sort by (code, severity, message) and collapse exact duplicates. */
function sortFindings(findings: readonly Finding[]): Finding[] {
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

/** Result assembler — single output shape for every row. */
function makeResult(
  state: ReconciledStageState,
  chainValid: boolean,
  fields: {
    readonly action: NextAction;
    readonly action_detail: string;
    readonly responsible_role: RoleType;
    readonly findings?: readonly Finding[];
    readonly slice_id?: string;
    readonly task_id?: string;
    readonly mode?: WorkerStepMode;
  },
): DerivedNextAction {
  return {
    action: fields.action,
    action_detail: fields.action_detail,
    responsible_role: fields.responsible_role,
    receipt_chain_valid: chainValid,
    findings: fields.findings ?? [...state.findings],
    slice_id: fields.slice_id,
    task_id: fields.task_id,
    mode: fields.mode,
  };
}

/**
 * Dependency rule (rows 6–10): a slice is runnable only when every declared
 * dependency exists and is complete. A missing dependency counts as
 * unsatisfied (never a guess — no runnable action for that slice).
 */
function dependenciesSatisfied(
  slice: ReconciledSliceState,
  slices: readonly ReconciledSliceState[],
): boolean {
  for (const depId of slice.dependencies) {
    const dep = slices.find((s) => s.slice_id === depId);
    if (dep === undefined || !dep.complete) return false;
  }
  return true;
}

/**
 * Per-slice scan in manifest declaration order: the first incomplete slice
 * whose dependencies are satisfied and that matches `predicate`.
 */
function findRunnableSlice(
  slices: readonly ReconciledSliceState[],
  predicate: (slice: ReconciledSliceState) => boolean,
): ReconciledSliceState | null {
  for (const slice of slices) {
    if (slice.complete) continue;
    if (!dependenciesSatisfied(slice, slices)) continue;
    if (predicate(slice)) return slice;
  }
  return null;
}

/** Row 10a evidence-file-missing fact (absent → present, never a guess). */
function evidenceFileMissing(slice: ReconciledSliceState, state: DeriveNextActionInput): boolean {
  return state.evidence_file_present_by_slice?.[slice.slice_id] === false;
}

/** Blocking finding helper for the VALIDATE fallback rows. */
function blockingFinding(message: string): Finding {
  return { code: 'DOMAIN.INVALID_TRANSITION', severity: 'error', message };
}

// ============================================================
// Row 6 — CV_REPAIR branch (repair / diagnose / recheck)
// ============================================================

/**
 * Row 6 sub-branches for one slice in READY_FOR_CV with the latest CV fact
 * being CV_REPAIR (cv_status REPAIR or PENDING_RECHECK, derived by Reconcile
 * from the CV receipt chain):
 *   6b PENDING_RECHECK (repair/diagnose TASK_COMPLETE admitted after the last
 *      CV_REPAIR) → RUN_CV recheck;
 *   6c REPAIR + repair_attempt 0 (CV_REPAIR count 1) → DISPATCH_WORKER repair;
 *   6d REPAIR + repair_attempt 1 (CV_REPAIR count 2) → DISPATCH_WORKER diagnose;
 *   6e REPAIR + repair_attempt ≥ 2 (CV_REPAIR count ≥ 3) → VALIDATE fallback
 *      with the UNRESOLVED_CV_FAILURE blocking finding.
 */
function cvRepairBranch(
  slice: ReconciledSliceState,
  state: ReconciledStageState,
  chainValid: boolean,
): DerivedNextAction {
  if (slice.cv_status === CVStatus.PENDING_RECHECK) {
    return makeResult(state, chainValid, {
      action: 'RUN_CV',
      action_detail:
        `RUN_CV (recheck) for slice "${slice.slice_id}" — repair result admitted ` +
        `after the last CV_REPAIR; recheck pending (PENDING_RECHECK)`,
      responsible_role: 'code-verifier',
      slice_id: slice.slice_id,
    });
  }
  if (slice.repair_attempt === 0) {
    return makeResult(state, chainValid, {
      action: 'DISPATCH_WORKER',
      action_detail:
        `DISPATCH_WORKER mode=repair for slice "${slice.slice_id}" — first CV repair ` +
        `(CV_REPAIR count 1)`,
      responsible_role: 'executor',
      slice_id: slice.slice_id,
      mode: 'repair',
    });
  }
  if (slice.repair_attempt === 1) {
    return makeResult(state, chainValid, {
      action: 'DISPATCH_WORKER',
      action_detail:
        `DISPATCH_WORKER mode=diagnose for slice "${slice.slice_id}" — CV still REPAIR ` +
        `after one repair (CV_REPAIR count 2); root-cause diagnosis required`,
      responsible_role: 'executor',
      slice_id: slice.slice_id,
      mode: 'diagnose',
    });
  }
  const blocking = blockingFinding(
    `UNRESOLVED_CV_FAILURE: slice "${slice.slice_id}" still REPAIR after ` +
      `${slice.repair_attempt} repair attempts — human intervention required`,
  );
  return makeResult(state, chainValid, {
    action: 'VALIDATE',
    action_detail:
      `VALIDATE — unresolved CV failure for slice "${slice.slice_id}" ` +
      `(UNRESOLVED_CV_FAILURE after ${slice.repair_attempt} repair attempts)`,
    responsible_role: 'executor',
    findings: sortFindings([...state.findings, blocking]),
    slice_id: slice.slice_id,
  });
}

// ============================================================
// deriveNextAction — the explicitly ordered priority table (rows 0–13)
// ============================================================

/**
 * Derive the unique next action from the reconciled persisted facts.
 *
 * Top-down evaluation of the S02-D priority table; the first matching row
 * wins and is returned immediately — never multiple actions. Pure function
 * (HP-003): only the input state decides; no I/O, timestamps, randomness,
 * cache or external calls.
 */
export function deriveNextAction(state: DeriveNextActionInput): DerivedNextAction {
  const chainValid = state.receipt_chain_valid ?? true;

  // ── Row 0: any error-level inconsistency → VALIDATE with all findings ──
  // GATE_FAIL blocking is post-supplanted by GATE_PASS: a retry-passed gate
  // (GATE_PASS after GATE_FAIL) means the latest verdict overrides the old
  // failure — no longer blocking. Both receipts remain immutable; only the
  // derivation semantics change.
  const hasErrorFinding = state.findings.some((f) => f.severity === 'error');
  const chainInvalid = !chainValid;
  const gateFailed = state.gate_fail_present === true && state.gate_pass_present !== true;
  if (hasErrorFinding || chainInvalid || gateFailed) {
    const synthesized: Finding[] = [];
    if (gateFailed) {
      synthesized.push(
        blockingFinding(
          `GATE_FAIL receipt exists for stage "${state.stage_id}" — stage gate failed; execution blocked`,
        ),
      );
    }
    const findings = sortFindings([...state.findings, ...synthesized]);
    return {
      action: 'VALIDATE',
      action_detail:
        `VALIDATE — ${findings.length} finding(s) block execution ` +
        `(${findings.map((f) => f.code).join(', ')})`,
      responsible_role: 'executor',
      receipt_chain_valid: chainValid,
      findings,
    };
  }

  // ── Row 1: stage UNINITIALIZED (no STAGE_PLAN) → VALIDATE fallback ──
  if (state.stage_state === StageState.UNINITIALIZED) {
    const blocking = blockingFinding(
      `Stage "${state.stage_id}" is UNINITIALIZED — no STAGE_PLAN receipt; ` +
        `stage planning must be initiated externally`,
    );
    return makeResult(state, chainValid, {
      action: 'VALIDATE',
      action_detail:
        `VALIDATE — stage "${state.stage_id}" not planned (UNINITIALIZED, no STAGE_PLAN receipt)`,
      responsible_role: 'executor',
      findings: sortFindings([...state.findings, blocking]),
    });
  }

  // ── Row 2: stage PLANNING → ADMIT_SPV_RESULT (§6 gate, before slice dispatch) ──
  if (state.stage_state === StageState.PLANNING) {
    return makeResult(state, chainValid, {
      action: 'ADMIT_SPV_RESULT',
      action_detail:
        `ADMIT_SPV_RESULT — stage "${state.stage_id}" is PLANNING; ` +
        `PLANNING → READY only via spv_pass`,
      responsible_role: 'planner',
    });
  }

  // ── Row 3: stage COMPLETED → REPARTITION (3a) / COMPILE_ACCEPTANCE (3b) ──
  if (state.stage_state === StageState.COMPLETED) {
    if (state.repartition_requested === true) {
      return makeResult(state, chainValid, {
        action: 'REPARTITION',
        action_detail:
          `REPARTITION — stage "${state.stage_id}" COMPLETED with manifest ` +
          `repartition_requested=true`,
        responsible_role: 'planner',
      });
    }
    return makeResult(state, chainValid, {
      action: 'COMPILE_ACCEPTANCE',
      action_detail:
        `COMPILE_ACCEPTANCE — stage "${state.stage_id}" COMPLETED ` +
        `(STAGE_REVIEW_PASS present) with no repartition request`,
      responsible_role: 'executor',
    });
  }

  // ── Row 4: pending worker result envelope → ADMIT_WORKER_RESULT ──
  const workerEnvelopes = (state.pending_worker_result_envelopes ?? []).filter(
    (e) => e.stageId === state.stage_id,
  );
  if (workerEnvelopes.length > 0) {
    const first = workerEnvelopes[0];
    return makeResult(state, chainValid, {
      action: 'ADMIT_WORKER_RESULT',
      action_detail:
        `ADMIT_WORKER_RESULT — ${workerEnvelopes.length} worker result envelope(s) pending ` +
        `for stage "${state.stage_id}"` +
        (first.sliceId !== undefined ? ` (first: slice "${first.sliceId}")` : ''),
      responsible_role: 'executor',
      slice_id: first.sliceId,
      task_id: first.taskId,
    });
  }

  // ── Row 5: pending CV result envelope → ADMIT_CV_RESULT (no repeated RUN_CV) ──
  const cvEnvelopes = (state.pending_cv_result_envelopes ?? []).filter(
    (e) => e.stageId === state.stage_id,
  );
  if (cvEnvelopes.length > 0) {
    const first = cvEnvelopes[0];
    return makeResult(state, chainValid, {
      action: 'ADMIT_CV_RESULT',
      action_detail:
        `ADMIT_CV_RESULT — ${cvEnvelopes.length} CV result envelope(s) pending for stage ` +
        `"${state.stage_id}"` +
        (first.sliceId !== undefined ? ` (first: slice "${first.sliceId}")` : ''),
      responsible_role: 'executor',
      slice_id: first.sliceId,
    });
  }

  // ── Row 6: READY_FOR_CV + latest CV fact CV_REPAIR (repair/diagnose/recheck) ──
  const repairSlice = findRunnableSlice(
    state.slices,
    (s) =>
      s.slice_state === SliceState.READY_FOR_CV &&
      (s.cv_status === CVStatus.REPAIR || s.cv_status === CVStatus.PENDING_RECHECK),
  );
  if (repairSlice !== null) return cvRepairBranch(repairSlice, state, chainValid);

  // ── Row 7: READY_FOR_CV with no CV receipt → RUN_CV (initial) ──
  const initialCvSlice = findRunnableSlice(
    state.slices,
    (s) => s.slice_state === SliceState.READY_FOR_CV && s.cv_status === CVStatus.NOT_STARTED,
  );
  if (initialCvSlice !== null) {
    return makeResult(state, chainValid, {
      action: 'RUN_CV',
      action_detail:
        `RUN_CV (initial) for slice "${initialCvSlice.slice_id}" — READY_FOR_CV with no ` +
        `CV receipt yet`,
      responsible_role: 'code-verifier',
      slice_id: initialCvSlice.slice_id,
    });
  }

  // ── Row 8: slice CV_PASSED without SLICE_COMMIT → ADMIT_SLICE_COMMIT ──
  const commitSlice = findRunnableSlice(
    state.slices,
    (s) => s.slice_state === SliceState.CV_PASSED && !s.committed,
  );
  if (commitSlice !== null) {
    return makeResult(state, chainValid, {
      action: 'ADMIT_SLICE_COMMIT',
      action_detail:
        `ADMIT_SLICE_COMMIT — slice "${commitSlice.slice_id}" CV_PASSED without a ` +
        `SLICE_COMMIT receipt (cv receipt digest binding is the Committer precondition)`,
      responsible_role: 'committer',
      slice_id: commitSlice.slice_id,
    });
  }

  // ── Row 9: slice committed without INTEGRATION_PASS → ADMIT_INTEGRATION ──
  const integrationSlice = findRunnableSlice(
    state.slices,
    (s) => s.slice_state === SliceState.INTEGRATING && !s.integrated,
  );
  if (integrationSlice !== null) {
    return makeResult(state, chainValid, {
      action: 'ADMIT_INTEGRATION',
      action_detail:
        `ADMIT_INTEGRATION — slice "${integrationSlice.slice_id}" committed (SLICE_COMMIT) ` +
        `without an INTEGRATION_PASS receipt (same commit SHA binding is the precondition)`,
      responsible_role: 'executor',
      slice_id: integrationSlice.slice_id,
    });
  }

  // ── Row 10: per-slice execution branch (manifest order, deps satisfied) ──
  for (const slice of state.slices) {
    if (slice.complete) continue;
    if (!dependenciesSatisfied(slice, state.slices)) continue;

    // 10a — no task started and the evidence file is missing → initialize.
    if (slice.slice_state === SliceState.PLANNED && evidenceFileMissing(slice, state)) {
      return makeResult(state, chainValid, {
        action: 'INITIALIZE_EVIDENCE',
        action_detail:
          `INITIALIZE_EVIDENCE — slice "${slice.slice_id}" has no task started and its ` +
          `evidence file is missing`,
        responsible_role: 'executor',
        slice_id: slice.slice_id,
      });
    }

    // 10b — first task inconsistency (checked ≠ evidence_written) → recover.
    for (const task of slice.tasks) {
      if (task.checked !== task.evidence_written) {
        return makeResult(state, chainValid, {
          action: 'DISPATCH_WORKER',
          action_detail:
            `DISPATCH_WORKER mode=recover-task for slice "${slice.slice_id}" task ` +
            `"${task.task_id}" — checkbox/evidence mismatch (recoverable)`,
          responsible_role: 'executor',
          slice_id: slice.slice_id,
          task_id: task.task_id,
          mode: 'recover-task',
        });
      }
    }

    // 10c — first unchecked task in declaration order → implement exactly one.
    const firstUnchecked = slice.tasks.find((t) => !t.checked);
    if (firstUnchecked !== undefined) {
      return makeResult(state, chainValid, {
        action: 'DISPATCH_WORKER',
        action_detail:
          `DISPATCH_WORKER mode=implement-task for slice "${slice.slice_id}" task ` +
          `"${firstUnchecked.task_id}" (first unchecked in manifest order)`,
        responsible_role: 'executor',
        slice_id: slice.slice_id,
        task_id: firstUnchecked.task_id,
        mode: 'implement-task',
      });
    }

    // 10d — all tasks checked but the slice has not derived READY_FOR_CV
    //       (no finalize-slice TASK_COMPLETE receipt) → finalize-slice.
    if (
      slice.tasks.length > 0 &&
      slice.tasks.every((t) => t.checked) &&
      slice.slice_state === SliceState.IN_PROGRESS
    ) {
      return makeResult(state, chainValid, {
        action: 'DISPATCH_WORKER',
        action_detail:
          `DISPATCH_WORKER mode=finalize-slice for slice "${slice.slice_id}" — all tasks ` +
          `checked but no finalize-slice TASK_COMPLETE receipt (not READY_FOR_CV yet)`,
        responsible_role: 'executor',
        slice_id: slice.slice_id,
        mode: 'finalize-slice',
      });
    }
    // No actionable row for this slice — continue scanning in manifest order.
  }

  // ── Row 11: all slices integrated without GATE_PASS → RUN_GATE ──
  if (
    state.slices.length > 0 &&
    state.slices.every((s) => s.integrated) &&
    state.gate_pass_present !== true
  ) {
    return makeResult(state, chainValid, {
      action: 'RUN_GATE',
      action_detail:
        `RUN_GATE — all ${state.slices.length} slices integrated without a GATE_PASS receipt`,
      responsible_role: 'executor',
    });
  }

  // ── Row 12: GATE_PASS present without STAGE_REVIEW_PASS (UNDER_REVIEW)
  //           → FINALIZE_STAGE_REVIEW ──
  if (state.stage_state === StageState.UNDER_REVIEW && state.gate_pass_present === true) {
    return makeResult(state, chainValid, {
      action: 'FINALIZE_STAGE_REVIEW',
      action_detail:
        `FINALIZE_STAGE_REVIEW — stage "${state.stage_id}" UNDER_REVIEW with GATE_PASS ` +
        `present and no STAGE_REVIEW_PASS receipt`,
      responsible_role: 'stage-reviewer',
    });
  }

  // ── Row 13: all rows missed (all blocked) → VALIDATE fallback ──
  const blocking = blockingFinding(
    `No canonical next action derivable for stage "${state.stage_id}" — all slices ` +
      `blocked or no actionable state (DOMAIN.INVALID_TRANSITION)`,
  );
  return makeResult(state, chainValid, {
    action: 'VALIDATE',
    action_detail:
      `VALIDATE — no canonical next action derivable from the persisted facts for stage ` +
      `"${state.stage_id}" (all blocked)`,
    responsible_role: 'executor',
    findings: sortFindings([...state.findings, blocking]),
  });
}
