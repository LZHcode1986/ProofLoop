/**
 * admit-pipeline.spec.ts — PO-S03-H-05 (S03-H-T03)
 *
 * Existence-gate message precision of `runAdmitPipeline` (the unified admit
 * pipeline, AWI-006). The gate refuses ANY error-level
 * `DOMAIN.STAGE_NOT_FOUND` reconcile finding (fail closed — the refusal
 * condition is unchanged), but the rejection message must now carry precise
 * attribution distinguishing two branches:
 *
 *   Branch A — "stage not declared in the manifest" (manifest missing /
 *              stage_id mismatch): message explicitly attributes the refusal
 *              to the missing manifest declaration and carries the original
 *              reconcile finding content.
 *   Branch B — other DOMAIN.STAGE_NOT_FOUND sources (unknown slice
 *              directories, receipts referencing unknown stage/slice):
 *              message explicitly attributes the refusal to the concrete
 *              source (with the original finding content) and must NOT use
 *              the branch-A "not declared in the manifest" wording.
 *
 * Both branches refuse with no Receipt (no widening of the release
 * surface). A legal declared-stage admit must be unaffected (regression).
 *
 * Public seam: `@proofloop/runtime` — `runAdmitPipeline` gate behavior via
 * the real admit methods (admitCVResult / admitWorkerResult) over real
 * fixture projects. The gate itself is never mocked.
 */
export {};
//# sourceMappingURL=admit-pipeline.spec.d.ts.map