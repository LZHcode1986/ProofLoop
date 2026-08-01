/**
 * admission-methods.spec.ts — S02-E-T02 (PO-S02-E-02 / PO-S02-E-03)
 *
 * Public seam: `@proofloop/runtime` — `admitWorkerResult` and
 * `admitCVResult` (the slice-boundary admit methods wired onto the unified
 * S02-E-T01 pipeline). Filesystem integration: real temp git repos with the
 * canonical `.proofloop` layout, kernel `writeReceipt`-produced receipts,
 * `verifyReceiptChain` per category chain, and fresh `reconcileStage`
 * readback as the oracle (AWI-006 — every successful admit is chain-verified
 * and read back as the corresponding fact; every refusal produces NO
 * Receipt).
 *
 * Covered in this task:
 *  - admitWorkerResult (PO-S02-E-02): completed in the three modes
 *    implement / recover / finalize (evidence-finalized advance to
 *    READY_FOR_CV), repair / diagnose with the CV-REPAIR binding (cv
 *    FIX → PENDING_RECHECK), outcome blocked / needs-decision / failed
 *    refusal, wrong-state refusal (incl. repair without a CV_REPAIR
 *    binding), schema-invalid envelope refusal.
 *  - admitCVResult (PO-S02-E-03): PASS and REPAIR with the READY_FOR_CV
 *    precondition (composite transition sequence + reducer call sequence
 *    asserted via an injected spy), the CV_IN_PROGRESS runtime intermediate
 *    (dispatched step skipped), the PENDING_RECHECK recheck flow, wrong
 *    precondition refusal (incl. cv-REPAIR slice before repair), invalid
 *    payload refusal at the schema layer.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 tables, AWI-006, PO-S02-E-02/03) — not derived from the
 * implementation under test.
 */
export {};
//# sourceMappingURL=admission-methods.spec.d.ts.map