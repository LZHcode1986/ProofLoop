/**
 * receiptLayout — PO-S02-C-05 (contract part)
 *
 * Verifies the canonical receipt category directory layout policy of
 * @proofloop/runtime (runtime-owned Artifact Path Policy):
 *
 *   <projectRoot>/.proofloop/receipts/
 *     plan/<stage>/            SLICE_PLAN, STAGE_PLAN, SPV_PASS
 *     tasks/<stage>/<slice>/   TASK_COMPLETE
 *     cv/<stage>/<slice>/      CV_PASS, CV_REPAIR
 *     committer/<stage>/<slice>/  SLICE_COMMIT
 *     integration/<stage>/<slice>/ INTEGRATION_PASS
 *     stage-gate/<stage>/      GATE_PASS, GATE_FAIL
 *     review/<stage>/          STAGE_REVIEW_PASS
 *     project/                 PROJECT_REVIEW_PASS
 *     .tmp/                    scratch — never a receipt source
 *
 * Expected path segments are written as known-good literals (independent of
 * the implementation). The type→category classification is the closed 12-type
 * receipt set mapped onto the 8 content categories — every type belongs to
 * exactly one category, no category is empty.
 *
 * Policy note (asserted below): SPV_PASS is classified under `plan/<stage>/` —
 * it is the stage-plan semantic proof verification pass (plan lifecycle:
 * STAGE_PLAN → SPV_PASS), matching deriveStageState's stage-boundary trio.
 */
export {};
//# sourceMappingURL=receipt-layout.spec.d.ts.map