/**
 * admission-review-plan.spec.ts — S02-E-T04 (PO-S02-E-05 / PO-S02-E-06 /
 * PO-S02-E-07)
 *
 * Public seam: `@proofloop/runtime` — `admitStageReview`, `admitProjectReview`
 * and `admitStagePlan` (the stage-level review / project review / stage-plan
 * admit methods wired onto the unified S02-E-T01 pipeline). Filesystem
 * integration: real temp git repos with the canonical `.proofloop` layout,
 * kernel `writeReceipt`-produced receipts, `verifyReceiptChain` per category
 * chain, and fresh `reconcileStage` readback as the oracle (AWI-006 — every
 * successful admit is chain-verified and read back as the corresponding
 * fact; every refusal produces NO Receipt).
 *
 * Covered in this task (PO-S02-E-05 / PO-S02-E-06 / PO-S02-E-07):
 *  - admitStageReview: ACCEPTED (stage derived UNDER_REVIEW → STAGE_REVIEW_PASS
 *    receipt to `review/<stage>/` + reducer COMPLETE → COMPLETED, chain
 *    valid, fresh reconcile readback COMPLETED), REPAIR (legal branch — NO
 *    receipt, reducer REOPEN → EXECUTING, warn Finding, accepted result with
 *    null receipt_ref), wrong precondition (stage not UNDER_REVIEW → refused).
 *  - admitProjectReview: ACCEPTED (project derived UNDER_REVIEW by reconcile
 *    — stage COMPLETED with no PROJECT_REVIEW_PASS receipt — then reducer
 *    COMPLETE → PROJECT_REVIEW_PASS receipt to `project/`, chain valid,
 *    readback COMPLETED), REPAIR (legal branch — NO receipt, reducer REOPEN →
 *    IN_PROGRESS, warn Finding), wrong precondition (project NOT derived
 *    UNDER_REVIEW — IN_PROGRESS default or already COMPLETED — refused via
 *    the real reconcile-derived gate, no synthetic dispatch).
 *  - admitStagePlan: success (request manifest digest === canonical digest of
 *    `.proofloop/manifests/<stage>.json`, stage UNINITIALIZED →
 *    STAGE_PLAN receipt to `plan/<stage>/` + reducer PLAN → PLANNING, chain
 *    valid, readback PLANNING), digest mismatch refused, duplicate admit
 *    (STAGE_PLAN receipt already exists → stage not UNINITIALIZED) refused.
 *  - canonicalManifestDigest / manifestFileDigest helper sanity: deterministic,
 *    key-order independent (canonical JSON), content-addressed.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 Stage/Project transition tables UNDER_REVIEW → COMPLETED |
 * EXECUTING / IN_PROGRESS, UNINITIALIZED → PLANNING; AWI-006;
 * PO-S02-E-05/06/07; §4 Manifest lifecycle digest binding) — not derived
 * from the implementation under test.
 */
export {};
//# sourceMappingURL=admission-review-plan.spec.d.ts.map