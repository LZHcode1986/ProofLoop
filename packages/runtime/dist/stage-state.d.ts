/**
 * @proofloop/runtime — Deterministic stage state derivation (PO-S02-A-05)
 *
 * `deriveStageState` derives the kernel §6 StageState from slice aggregate
 * facts (per-slice `integrated`, taken from ReconciledSliceState) plus a
 * receipt presence summary over the three stage-boundary receipt types
 * (STAGE_PLAN / SPV_PASS / STAGE_REVIEW_PASS).
 *
 * Deterministic mapping (authority — kernel §6 Stage State Machine):
 *   - no STAGE_PLAN receipt            → UNINITIALIZED
 *   - STAGE_PLAN, no SPV_PASS          → PLANNING
 *   - SPV_PASS, some slice not
 *     integrated                       → EXECUTING
 *   - all slices integrated, no
 *     STAGE_REVIEW_PASS                → UNDER_REVIEW
 *   - all slices integrated +
 *     STAGE_REVIEW_PASS                → COMPLETED
 *
 * READY folding rule: the 12-type receipt closed set (§5 Receipt.type) has no
 * `stage_activated` receipt, so under receipts-only reconciliation READY and
 * EXECUTING are indistinguishable — READY is a transient state that collapses
 * into EXECUTING. SPV_PASS present ⇒ EXECUTING by default; UNDER_REVIEW and
 * COMPLETED are refinements that require positive integration evidence (every
 * slice integrated, stage having at least one slice). READY is never derived.
 *
 * Contradictory fact combinations are rejected with a structured
 * `StageStateDerivationError` (canonical §7 code DOMAIN.INVALID_TRANSITION)
 * carrying the conflicting facts — never a silent choice between two
 * defensible states (PO-S02-A-05 forbidden shortcut).
 *
 * HP-005: pure function — no I/O, no timestamps, no randomness, no global
 * state, no mutation of the input. Only imports @proofloop/kernel (canonical
 * StageState enum) and the normalized state model type.
 */
import { StageState } from '@proofloop/kernel';
import type { ReconciledSliceState } from './state-model';
/**
 * Presence summary over the three stage-boundary receipt types.
 *
 * Produced by Reconcile (S02-C) from the classified receipt directories;
 * `deriveStageState` consumes only these three flags — the remaining receipt
 * types (TASK_COMPLETE, CV_PASS, ...) never influence the stage derivation.
 */
export interface StageReceiptSummary {
    /** A STAGE_PLAN receipt exists. */
    readonly has_stage_plan: boolean;
    /** A SPV_PASS receipt exists. */
    readonly has_spv_pass: boolean;
    /** A STAGE_REVIEW_PASS receipt exists. */
    readonly has_stage_review_pass: boolean;
}
/**
 * Input to `deriveStageState`: slice aggregate facts + receipt summary.
 *
 * slices: normalized per-slice states (Reconcile output) — only the
 *         `integrated` fact and `slice_id` (for rejection context) are read.
 * receipts: presence of the three stage-boundary receipt types.
 */
export interface DeriveStageStateInput {
    /** Normalized slice states in manifest declaration order. */
    readonly slices: readonly ReconciledSliceState[];
    /** Presence of the stage-boundary receipt types. */
    readonly receipts: StageReceiptSummary;
}
/**
 * Structured rejection for contradictory stage facts.
 *
 * Canonical §7 code DOMAIN.INVALID_TRANSITION — the fact combination implies
 * a stage state the §6 state machine cannot legally hold (e.g. STAGE_REVIEW_PASS
 * while a slice is still not integrated, or a downstream receipt without its
 * upstream precondition). Carries the conflicting facts so callers (Reconcile
 * S02-C) can surface a precise Finding instead of guessing.
 */
export declare class StageStateDerivationError extends Error {
    /** Canonical §7 Finding code — never a silent choice. */
    readonly code: 'DOMAIN.INVALID_TRANSITION';
    /** The receipt summary that participated in the contradiction. */
    readonly receipts: StageReceiptSummary;
    /** Slice ids that failed the all-integrated precondition (may be empty). */
    readonly unintegratedSliceIds: readonly string[];
    constructor(message: string, receipts: StageReceiptSummary, unintegratedSliceIds: readonly string[]);
}
/**
 * Derive the unique kernel StageState from slice facts + receipt summary.
 *
 * @param input - slice aggregate facts + stage-boundary receipt summary.
 * @returns the unique StageState per the deterministic mapping rules above.
 * @throws StageStateDerivationError for contradictory fact combinations
 *         (code DOMAIN.INVALID_TRANSITION, with the conflicting facts).
 */
export declare function deriveStageState(input: DeriveStageStateInput): StageState;
//# sourceMappingURL=stage-state.d.ts.map