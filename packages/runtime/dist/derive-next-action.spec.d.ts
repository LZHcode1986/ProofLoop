/**
 * @proofloop/runtime — deriveNextAction table-driven priority tests
 * (PO-S02-D-01 / PO-S02-D-02 pure-function side, S02-D-T01)
 *
 * The S02-D priority table (rows 0–13, from the Slice Proof Obligations) is
 * the independent oracle. Every row has at least one fixture asserting the
 * unique canonical action and a non-empty readable action_detail; priority
 * counterexamples assert that an earlier row wins over a later one
 * (pending worker envelope beats dispatching the next task; pending CV
 * envelope beats RUN_CV; stage gates beat slice dispatch; admit classes beat
 * dispatch classes). Dependency-blocked slices are skipped in the per-slice
 * scan, and the all-blocked state falls back to VALIDATE with a blocking
 * finding.
 *
 * PO-S02-D-02 (pure-function side): an error-level inconsistency fixture
 * yields VALIDATE with all findings and never an execution action.
 *
 * HP-003: double invocation on the same frozen state deep-equals (no
 * process-internal state, no cache, no randomness).
 */
export {};
//# sourceMappingURL=derive-next-action.spec.d.ts.map