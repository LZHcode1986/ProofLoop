/**
 * Independent proof supplement — PO-S02-A-02 / PO-S02-A-03 / PO-S02-A-04
 * (S02-A-T04)
 *
 * Complements reducer.spec.ts (T02), state-model.spec.ts (T01) and
 * stage-state.spec.ts (T03) with the Slice's independent proofs:
 *
 *   1. Exhaustive legal/illegal matrix (kernel §6 transition tables as the
 *      independent oracle): every (fromState × event) combination of the
 *      four machines is classified legal (advances to the canonical target,
 *      aggregates consistent) or illegal (InvalidTransitionError with exact
 *      entityId / fromState / toState).
 *        Stage   6 states × 8 events = 48 combos (8 legal / 40 illegal)
 *        Slice   7 states × 7 events = 49 combos (7 legal / 42 illegal)
 *        CV      6 states × 6 events = 36 combos (6 legal / 30 illegal)
 *        Project 4 states × 4 events = 16 combos (4 legal / 12 illegal)
 *      This proves PO-S02-A-02 (legal rows incl. the EXECUTING→EXECUTING
 *      self-loop, COMPLETED→EXECUTING repartition, the cv repair loop and
 *      the INTEGRATED terminal state) and PO-S02-A-03 (every non-table
 *      combination throws with structured fields — incl. INTEGRATE before
 *      CV_PASSED, PASS_CV at READY_FOR_CV, COMPLETE at EXECUTING,
 *      REPARTITION at non-COMPLETED) exhaustively, with explicit
 *      matrix-completeness markers.
 *
 *   2. Pure-function proof (PO-S02-A-04 / HP-005): double invocation of the
 *      reducer on the same (state, action) input produces deep-equal
 *      outputs; invocation order does not affect the result; a deep-frozen
 *      input is never mutated (no in-place writes); a static source scan of
 *      the four production modules finds no I/O, timestamp, randomness or
 *      global-state constructs.
 *
 *   3. Module-level dependency scan (PO-S02-A-04): static import analysis of
 *      state-model.ts / reducer.ts / stage-state.ts / index.ts — only
 *      @proofloop/kernel and intra-package relative imports; no
 *      @earendil-works/*, no .agents/runtime, no relative cross-package
 *      imports.
 *
 * Expected values are the kernel §6 transition tables (independent oracle —
 * `packages/kernel/src/transitions.ts`) written as known-good literals,
 * never derived from the reducer implementation.
 */
export {};
//# sourceMappingURL=matrix-purity.spec.d.ts.map