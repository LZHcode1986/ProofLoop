/**
 * admit-extension.spec.ts — PO-S03-H-02 (S03-H-T02)
 *
 * Public seam: `@proofloop/runtime` — the extended `AdmissionRequest` union
 * (SPV/GATE members) and the new admit methods `admitSpvResult` /
 * `admitGateResult`, all wired onto the unified admit pipeline
 * (validate → reconcile → precheck → kernel `writeReceipt` → chain
 * verification, AWI-006). Filesystem integration: real temp git repos with
 * the canonical `.proofloop` layout and kernel `writeReceipt`-produced
 * receipts; fresh `reconcileStage` readback is the oracle.
 *
 * Covered:
 *  - union extension: spv_result / gate_result join the closed request-type
 *    set (S02's 7 preserved); gate verdicts {PASS, FAIL}; schema validation
 *    success + refusal cases;
 *  - admitSpvResult: SPV_PASS → plan/<stage>/, precondition stage derived
 *    PLANNING + manifest-digest binding; refusal cases (not PLANNING,
 *    digest mismatch, already approved); chain verification + reconcile
 *    readback;
 *  - admitGateResult: GATE_PASS / GATE_FAIL → stage-gate/<stage>/,
 *    preconditions git clean + all slices integrated + manifest-digest
 *    binding + HEAD binding; refusal cases (not integrated, dirty tree,
 *    HEAD mismatch, digest mismatch, stage already reviewed); chain
 *    verification + reconcile readback;
 *  - SLICE_PLAN creation-path decision record: S03 does NOT create
 *    SLICE_PLAN receipts — no `slice_plan` request member, and a
 *    worker-result admit for an undeclared slice is refused without
 *    creating any receipt (the creation path is closed; S04 plugs into the
 *    same extension point).
 *
 * Forbidden shortcuts proven absent: prechecks run on real fixtures (no
 * mocked preconditions); persistence goes only through the injected
 * ReceiptWriterPort (one writer-spy proof).
 */
export {};
//# sourceMappingURL=admit-extension.spec.d.ts.map