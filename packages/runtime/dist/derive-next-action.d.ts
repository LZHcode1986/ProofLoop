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
import type { Finding, NextAction, RoleType } from '@proofloop/kernel';
import type { ReconciledStageState } from './state-model';
import type { WorkerResultEnvelope, WorkerStepMode } from './relay-contract';
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
/**
 * Derive the unique next action from the reconciled persisted facts.
 *
 * Top-down evaluation of the S02-D priority table; the first matching row
 * wins and is returned immediately — never multiple actions. Pure function
 * (HP-003): only the input state decides; no I/O, timestamps, randomness,
 * cache or external calls.
 */
export declare function deriveNextAction(state: DeriveNextActionInput): DerivedNextAction;
//# sourceMappingURL=derive-next-action.d.ts.map