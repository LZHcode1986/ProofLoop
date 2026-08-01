"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.StageStateDerivationError = void 0;
exports.deriveStageState = deriveStageState;
const kernel_1 = require("@proofloop/kernel");
// ============================================================
// Structured rejection
// ============================================================
/**
 * Structured rejection for contradictory stage facts.
 *
 * Canonical §7 code DOMAIN.INVALID_TRANSITION — the fact combination implies
 * a stage state the §6 state machine cannot legally hold (e.g. STAGE_REVIEW_PASS
 * while a slice is still not integrated, or a downstream receipt without its
 * upstream precondition). Carries the conflicting facts so callers (Reconcile
 * S02-C) can surface a precise Finding instead of guessing.
 */
class StageStateDerivationError extends Error {
    /** Canonical §7 Finding code — never a silent choice. */
    code = 'DOMAIN.INVALID_TRANSITION';
    /** The receipt summary that participated in the contradiction. */
    receipts;
    /** Slice ids that failed the all-integrated precondition (may be empty). */
    unintegratedSliceIds;
    constructor(message, receipts, unintegratedSliceIds) {
        super(message);
        this.name = 'StageStateDerivationError';
        this.receipts = receipts;
        this.unintegratedSliceIds = unintegratedSliceIds;
        // Maintain proper prototype chain for instanceof checks.
        Object.setPrototypeOf(this, StageStateDerivationError.prototype);
    }
}
exports.StageStateDerivationError = StageStateDerivationError;
// ============================================================
// Public derivation function
// ============================================================
/**
 * Derive the unique kernel StageState from slice facts + receipt summary.
 *
 * @param input - slice aggregate facts + stage-boundary receipt summary.
 * @returns the unique StageState per the deterministic mapping rules above.
 * @throws StageStateDerivationError for contradictory fact combinations
 *         (code DOMAIN.INVALID_TRANSITION, with the conflicting facts).
 */
function deriveStageState(input) {
    const { slices, receipts } = input;
    const { has_stage_plan, has_spv_pass, has_stage_review_pass } = receipts;
    const unintegrated = slices.filter(s => !s.integrated);
    const unintegratedSliceIds = unintegrated.map(s => s.slice_id);
    // R1: no STAGE_PLAN → UNINITIALIZED. Any downstream receipt without its
    // STAGE_PLAN precondition is a contradiction — reject, never guess.
    if (!has_stage_plan) {
        if (has_spv_pass || has_stage_review_pass) {
            throw new StageStateDerivationError(`Contradictory stage facts: SPV_PASS/STAGE_REVIEW_PASS receipt present without STAGE_PLAN receipt — cannot derive StageState`, receipts, unintegratedSliceIds);
        }
        return kernel_1.StageState.UNINITIALIZED;
    }
    // R2: STAGE_PLAN without SPV_PASS → PLANNING (deterministic regardless of
    // slice facts — the slice-level facts belong to later stage states).
    if (!has_spv_pass) {
        if (has_stage_review_pass) {
            throw new StageStateDerivationError(`Contradictory stage facts: STAGE_REVIEW_PASS receipt present without SPV_PASS receipt — cannot derive StageState`, receipts, unintegratedSliceIds);
        }
        return kernel_1.StageState.PLANNING;
    }
    // SPV_PASS present from here. READY folding: SPV_PASS ⇒ EXECUTING unless
    // positive integration evidence advances the stage further.
    // all-integrated requires at least one slice — zero slices carry no
    // integration evidence and stay EXECUTING.
    const allIntegrated = slices.length > 0 && unintegrated.length === 0;
    if (has_stage_review_pass) {
        // R5: COMPLETED requires every slice integrated. STAGE_REVIEW_PASS while
        // a slice is still not integrated is the canonical contradiction — both
        // COMPLETED (per review receipt) and EXECUTING (per unintegrated slice)
        // are defensible; neither is chosen silently.
        if (!allIntegrated) {
            throw new StageStateDerivationError(`Contradictory stage facts: STAGE_REVIEW_PASS receipt present but slice(s) not integrated: [${unintegratedSliceIds.join(', ')}] — cannot derive StageState`, receipts, unintegratedSliceIds);
        }
        return kernel_1.StageState.COMPLETED;
    }
    if (allIntegrated) {
        return kernel_1.StageState.UNDER_REVIEW;
    }
    return kernel_1.StageState.EXECUTING;
}
//# sourceMappingURL=stage-state.js.map