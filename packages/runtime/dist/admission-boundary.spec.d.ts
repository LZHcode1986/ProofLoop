/**
 * admission-boundary.spec.ts — S02-E-T03 (PO-S02-E-04)
 *
 * Public seam: `@proofloop/runtime` — `admitSliceCommit` and
 * `admitIntegration` (the slice-boundary committer/integration admit
 * methods wired onto the unified S02-E-T01 pipeline). Filesystem
 * integration: real temp git repos with the canonical `.proofloop` layout,
 * kernel `writeReceipt`-produced receipts, `verifyReceiptChain` per
 * category chain, and fresh `reconcileStage` readback as the oracle
 * (AWI-006 — every successful admit is chain-verified and read back as the
 * corresponding committed/integrated fact; every refusal produces NO
 * Receipt).
 *
 * Covered in this task (PO-S02-E-04):
 *  - admitSliceCommit: precondition slice derived CV_PASSED (reconcile
 *    fact) + cv receipt digest binding valid (request digest === the latest
 *    CV_PASS receipt digest) + non-empty commit SHA → SLICE_COMMIT Receipt
 *    to `committer/<stage>/<slice>/` + reducer INTEGRATE advance
 *    CV_PASSED → INTEGRATING; wrong state / invalid digest binding /
 *    unknown slice / schema-invalid request → structured rejection, no
 *    Receipt.
 *  - admitIntegration: precondition slice derived INTEGRATING (reconcile
 *    fact) + SLICE_COMMIT receipt existing and binding the SAME commit SHA
 *    → INTEGRATION_PASS Receipt to `integration/<stage>/<slice>/` +
 *    reducer FINISH_INTEGRATION advance INTEGRATING → INTEGRATED; SHA
 *    mismatch / commit binding missing / wrong state / unknown slice /
 *    schema-invalid request → structured rejection, no Receipt.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 transition table CV_PASSED → INTEGRATING → INTEGRATED,
 * AWI-006, PO-S02-E-04, and the S02-C-T04 canonical payload contract:
 * SLICE_COMMIT payload.status === 'committed' + slice_commit_sha +
 * cv_receipt_digest === latest CV_PASS digest; INTEGRATION_PASS
 * payload.status === 'integrated' + slice_commit_sha === the committed
 * SHA) — not derived from the implementation under test.
 */
export {};
//# sourceMappingURL=admission-boundary.spec.d.ts.map