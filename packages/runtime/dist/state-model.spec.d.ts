/**
 * State model & RuntimeAction — PO-S02-A-01
 *
 * Verifies the public type seam of @proofloop/runtime:
 *   - ReconciledStageState / ReconciledSliceState normalized state model,
 *     using kernel canonical enum types (StageState / SliceState / CVStatus /
 *     ProjectState) — no open strings.
 *   - Closed-set RuntimeAction union, mapping 1:1 to the kernel §6 event
 *     groups: Stage 8 + Slice 7 + CV 6 + Project 4 = 21 distinct literals,
 *     with cross-entity same-name literals (START, SUBMIT_FOR_REVIEW, REOPEN,
 *     COMPLETE) disambiguated by entity binding.
 *
 * The canonical literal sets below are the independent oracle (kernel
 * `packages/kernel/src/transitions.ts` §6 transition tables / authority
 * excerpts) — known-good literals, not derived from the implementation.
 */
export {};
//# sourceMappingURL=state-model.spec.d.ts.map