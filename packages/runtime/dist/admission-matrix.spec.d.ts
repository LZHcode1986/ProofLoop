/**
 * admission-matrix.spec.ts — S02-E-T05 (PO-S02-E-01 success matrix)
 *
 * Test-matrix completion for the AdmissionService slice: the full 7-method
 * success walk against ONE real fixture project (temp dir + real git repo +
 * canonical `.proofloop` layout + kernel `writeReceipt` receipts). This is
 * the AWI-006 acceptance walk — every one of the 7 admit methods produces a
 * Receipt that is (a) written into its canonical category directory and
 * linked into that category chain, (b) chain-validated via
 * `verifyReceiptChain`, and (c) read back by a FRESH `reconcileStage` as the
 * corresponding fact (stage COMPLETED / slice INTEGRATED / committed /
 * integrated / complete).
 *
 * The walk drives the methods in the kernel §6 lifecycle order:
 *
 *   admitStagePlan (UNINITIALIZED → PLANNING, STAGE_PLAN to plan/<stage>/)
 *     → admitWorkerResult finalize-slice (→ READY_FOR_CV, TASK_COMPLETE to
 *       tasks/<stage>/<slice>/)
 *     → admitCVResult PASS (→ CV_PASSED, CV_PASS to cv/<stage>/<slice>/)
 *     → admitSliceCommit (→ INTEGRATING, SLICE_COMMIT to
 *       committer/<stage>/<slice>/ — cv digest binding + real baseline SHA)
 *     → admitIntegration (→ INTEGRATED, INTEGRATION_PASS to
 *       integration/<stage>/<slice>/ — same SHA binding)
 *     → [seed SPV_PASS into plan/<stage>/ — S03/S04 tool-flow receipt, NOT
 *       one of the 7 admit methods; seeded so the stage derives
 *       UNDER_REVIEW, exactly as the S02-E-T04 review fixtures do]
 *     → admitStageReview ACCEPTED (→ COMPLETED, STAGE_REVIEW_PASS to
 *       review/<stage>/)
 *     → admitProjectReview ACCEPTED (→ project COMPLETED,
 *       PROJECT_REVIEW_PASS to project/)
 *
 * Every refusal case of each method is independently proven in the T02–T04
 * spec files (admission-methods / admission-boundary / admission-review-plan);
 * this file deliberately does NOT duplicate them.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 state machines, AWI-006, PO-S02-E-01..07) — not derived from
 * the implementation under test.
 */
export {};
//# sourceMappingURL=admission-matrix.spec.d.ts.map