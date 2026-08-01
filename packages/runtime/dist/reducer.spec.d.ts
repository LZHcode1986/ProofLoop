/**
 * Pure-function reducer — PO-S02-A-02 / PO-S02-A-03
 *
 * Verifies the public reducer seam of @proofloop/runtime:
 *   - PO-S02-A-02: for every legal RuntimeAction (entity-bound, 1:1 with the
 *     kernel §6 event tables), the reducer advances the corresponding
 *     Stage/Slice/CV/Project state to the canonical target and keeps the
 *     aggregate derived state consistent (composite actions such as PASS_CV =
 *     transitionSlice(PASS_CV) + transitionCv(PASS), FINISH_TASKS =
 *     transitionSlice(FINISH_TASKS) + transitionCv(MARK_READY), the repair
 *     loop REVISE ↔ REQUEST_REPAIR, and the recheck branch RECHECK/RUN_CV).
 *   - PO-S02-A-03: any action the current state does not allow is rejected
 *     with the kernel InvalidTransitionError carrying entityId/fromState/
 *     toState; unknown actions (entity/event outside the closed set) are
 *     rejected at the schema layer; never silently ignored or normalized.
 *
 * Expected values in the legal tables are the kernel §6 transition tables
 * (independent oracle — `packages/kernel/src/transitions.ts`), written as
 * known-good literals, not derived from the implementation.
 */
export {};
//# sourceMappingURL=reducer.spec.d.ts.map