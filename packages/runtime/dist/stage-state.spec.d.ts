/**
 * deriveStageState — PO-S02-A-05
 *
 * Verifies the public `deriveStageState` seam of @proofloop/runtime: the
 * deterministic stage state derivation function (slice aggregate facts +
 * receipt presence summary → unique StageState).
 *
 * Mapping rules (authority — kernel §6 Stage State Machine + Slice PO-S02-A-05):
 *   - no STAGE_PLAN receipt            → UNINITIALIZED
 *   - STAGE_PLAN, no SPV_PASS          → PLANNING
 *   - SPV_PASS, some slice not
 *     integrated                       → EXECUTING (READY folded: the 12-type
 *                                        receipt closed set has no
 *                                        `stage_activated` receipt, so READY
 *                                        is a transient state that collapses
 *                                        into EXECUTING and is never derived)
 *   - all slices integrated, no
 *     STAGE_REVIEW_PASS                → UNDER_REVIEW
 *   - all slices integrated +
 *     STAGE_REVIEW_PASS                → COMPLETED
 *
 * Contradictory fact combinations (a receipt implies an upstream receipt
 * that is absent, or a receipt claims a stage state the slice facts cannot
 * support) are rejected with a structured `StageStateDerivationError`
 * carrying the conflicting facts (canonical §7 code DOMAIN.INVALID_TRANSITION)
 * — never a silent choice between two defensible states.
 *
 * Expected values are the authority mapping rules written as known-good
 * literals — not derived from the implementation.
 */
export {};
//# sourceMappingURL=stage-state.spec.d.ts.map