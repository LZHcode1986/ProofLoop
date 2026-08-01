/**
 * NextActionService — proofloop_next pipeline tests (S02-D-T02)
 *
 * Real-fixture integration tests over the full pipeline
 * (reconcile → validate chain → deterministic persisted extras → pure derive
 * → proofloop_next wrap), covering the pipeline side of:
 *
 *   PO-S02-D-02 (pipeline side): any error-level inconsistency → the unique
 *     action VALIDATE with all findings returned, receipt_chain_valid
 *     truthfully reflecting the chain state — never a guessed execution
 *     action.
 *   PO-S02-D-04: the full pipeline (path → reconcile → validate → derive)
 *     output equals the pure `deriveNextAction` on the same reconcile output
 *     for fixtures whose extra facts are neutral; the extras-only behaviors
 *     (gate / repartition / evidence / envelope) are each proven by a
 *     pipeline-vs-pure divergence on the SAME fixture.
 *   PO-S02-D-05: every pipeline output satisfies the proofloop_next structure
 *     contract (action ∈ 15-value closed set, non-empty action_detail,
 *     responsible_role ∈ 10-value RoleType closed set, findings ≤ 20,
 *     receipt_chain_valid boolean, exactly the 5 contract keys).
 *   PO-S02-D-03 (pipeline side): restart determinism — two fresh service
 *     instances over the same fixture deep-equal (HP-003).
 *
 * Fixtures are REAL filesystem projects (temp dir + real git repo + canonical
 * `.proofloop` layout + kernel ReceiptWriter-produced receipts). No mocks, no
 * cached state files (HP-003).
 */
export {};
//# sourceMappingURL=next-action-service.spec.d.ts.map