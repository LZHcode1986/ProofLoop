/**
 * @proofloop/runtime — Normalized state model & closed-set RuntimeAction
 *
 * PO-S02-A-01: normalized runtime state model (ReconciledStageState /
 * ReconciledSliceState) and the closed-set RuntimeAction union, mapping 1:1
 * to the kernel §6 event groups (Stage 8 + Slice 7 + CV 6 + Project 4 = 21
 * distinct literals), with cross-entity same-name literals disambiguated by
 * entity binding.
 *
 * Types only — no behavior. The pure-function reducer (PO-S02-A-02/03/04)
 * and the deterministic stage derivation function deriveStageState
 * (PO-S02-A-05) belong to later tasks and consume these shapes.
 *
 * All state enums use kernel canonical types (StageState / SliceState /
 * CVStatus / ProjectState) — open strings are forbidden (§5 Canonical Type
 * Registry).
 */
import type { StageEvent, SliceEvent, CvEvent, ProjectEvent, StageState, SliceState, CVStatus, ProjectState, Receipt, Finding } from '@proofloop/kernel';
/**
 * Canonical entity bound to a RuntimeAction.
 *
 * The four kernel §6 state machines. Closed set — no other values.
 */
export declare const RUNTIME_ACTION_ENTITIES: readonly ["stage", "slice", "cv", "project"];
/** Entity dimension of the RuntimeAction closed set. */
export type RuntimeActionEntity = (typeof RUNTIME_ACTION_ENTITIES)[number];
/**
 * Closed-set runtime action union — exactly the kernel §6 event literals.
 *
 * 21 distinct literals across the four groups:
 *   Stage 8:    PLAN | FINALIZE_PLAN | START | PROGRESS | SUBMIT_FOR_REVIEW |
 *               REOPEN | COMPLETE | REPARTITION
 *   Slice 7:    START | FINISH_TASKS | RUN_CV | REVISE | PASS_CV | INTEGRATE |
 *               FINISH_INTEGRATION
 *   CV 6:       MARK_READY | START_CV | PASS | REQUEST_REPAIR | FIX | RECHECK
 *   Project 4:  SUBMIT_FOR_REVIEW | REOPEN | COMPLETE | RESUME
 *
 * Cross-entity same-name literals (START, SUBMIT_FOR_REVIEW, REOPEN, COMPLETE)
 * are disambiguated by the entity binding, e.g.:
 *   { entity: 'stage',  event: 'START' }   → stage  READY → EXECUTING
 *   { entity: 'slice',  event: 'START' }   → slice  PLANNED → IN_PROGRESS
 *
 * No other values are admitted.
 */
export type RuntimeAction = {
    readonly entity: 'stage';
    readonly event: StageEvent;
} | {
    readonly entity: 'slice';
    readonly event: SliceEvent;
} | {
    readonly entity: 'cv';
    readonly event: CvEvent;
} | {
    readonly entity: 'project';
    readonly event: ProjectEvent;
};
/**
 * Normalized state of a single task checkbox within a slice.
 *
 * Produced by Reconcile (S02-C) from tasks.md checkbox state + Evidence
 * sections; consumed by NextAction (S02-D) and Admission (S02-E).
 */
export interface ReconciledTaskState {
    /** Canonical task identifier (e.g. "S02-A-T01"). */
    readonly task_id: string;
    /** Whether the tasks.md checkbox is checked ([x] vs [ ]). */
    readonly checked: boolean;
    /** Whether the per-task Evidence section has been written. */
    readonly evidence_written: boolean;
}
/**
 * Normalized slice state.
 *
 * Fact fields (per-task checked/evidence_written, evidence_finalized, CV
 * status, committed/integrated/complete) plus kernel canonical lifecycle
 * state.  Produced by Reconcile (S02-C); consumed by NextAction (S02-D) and
 * Admission (S02-E).  Open strings are forbidden — slice_state and cv_status
 * are kernel canonical enums.
 */
export interface ReconciledSliceState {
    /** Canonical slice identifier (e.g. "S02-A"). */
    readonly slice_id: string;
    /** Slice dependency identifiers (declaration order oracle). */
    readonly dependencies: readonly string[];
    /** Task checkbox states, in manifest declaration order. */
    readonly tasks: readonly ReconciledTaskState[];
    /** Kernel canonical slice lifecycle state (§6 Slice State Machine). */
    readonly slice_state: SliceState;
    /** Kernel canonical CV lifecycle status (§6 CV Status). */
    readonly cv_status: CVStatus;
    /** Whether `## Current Slice Evidence` is finalized. */
    readonly slice_evidence_finalized: boolean;
    /** Number of repair attempts so far. */
    readonly repair_attempt: number;
    /** Whether the scope check has passed (Committer precondition). */
    readonly scope_check_passed: boolean;
    /** Whether the slice has been committed (Committer step done). */
    readonly committed: boolean;
    /** Whether the slice has been integrated. */
    readonly integrated: boolean;
    /** Whether this slice is complete (all upstream tasks done). */
    readonly complete: boolean;
    /** Most recent CV receipt, or null when no CV receipt exists. */
    readonly latest_cv_receipt: Receipt | null;
    /** Most recent SLICE_COMMIT receipt, or null when no commit receipt exists. */
    readonly latest_commit_receipt: Receipt | null;
}
/**
 * Normalized stage state.
 *
 * stage_id, ordered slices[], derived StageState (materialized by the
 * reducer / deriveStageState, PO-S02-A-05), project state (for Project
 * RuntimeActions), the receipt chain state, and the structured Findings
 * container (empty when the three sources are consistent).  Produced by
 * Reconcile (S02-C); consumed by NextAction (S02-D) and Admission (S02-E).
 */
export interface ReconciledStageState {
    /** Canonical stage identifier (e.g. "S02"). */
    readonly stage_id: string;
    /** Normalized slice states in manifest declaration order. */
    readonly slices: readonly ReconciledSliceState[];
    /** Kernel canonical derived stage state (§6 Stage State Machine). */
    readonly stage_state: StageState;
    /** Kernel canonical project state (§6 Project State Machine). */
    readonly project_state: ProjectState;
    /** Ordered receipt digests forming the stage receipt chain (oldest → newest). */
    readonly receipt_chain: readonly string[];
    /** Structured findings from reconciliation — empty when consistent. */
    readonly findings: readonly Finding[];
}
//# sourceMappingURL=state-model.d.ts.map