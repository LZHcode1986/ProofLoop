/**
 * @proofloop/runtime — S02-D-T03 fixture derivation matrix
 * (PO-S02-D-01 / PO-S02-D-02 / PO-S02-D-03 / PO-S02-D-05)
 *
 * Real-fixture independent proofs of the S02-D priority table over the full
 * NextActionService pipeline (reconcile → validate chain → deterministic
 * persisted extras → pure derive → proofloop_next wrap). Every fixture is a
 * REAL temp project: real git repo + canonical `.proofloop` layout + kernel
 * ReceiptWriter-produced receipts. No mocks, no cached state files (HP-003).
 *
 * This file fills the real-fixture matrix gaps of S02-D-T01 (pure-function
 * synthetic-state rows) and S02-D-T02 (pipeline: rows 0/3/4/10a/10c/12 +
 * determinism + structure) with a real-fixture assertion for EVERY priority
 * row 0–13, including the mandated counterexample states:
 *
 *   Row 0  — error-level inconsistency → VALIDATE (GATE_FAIL variant here;
 *            unknown-slice / tampered-chain in next-action-service.spec.ts;
 *            kitchen-sink reusing the S02-C inconsistency constructions)
 *   Row 1  — stage UNINITIALIZED (no STAGE_PLAN) → VALIDATE fallback
 *   Row 2  — stage PLANNING → ADMIT_SPV_RESULT (beats slice dispatch)
 *   Row 3a — COMPLETED + manifest repartition_requested=true → REPARTITION
 *   Row 3b — COMPLETED without repartition request → COMPILE_ACCEPTANCE
 *   Row 4  — pending worker result envelope → ADMIT_WORKER_RESULT
 *            (counterexample: beats implementing the next unchecked task)
 *   Row 5  — pending CV result envelope → ADMIT_CV_RESULT
 *            (counterexample: never RUN_CV; S02 never guesses the S03 CV
 *            envelope schema — pipeline fail-closed pinned too)
 *   Row 6  — CV_REPAIR branch: 6c repair / 6d diagnose / 6b recheck / 6e
 *            UNRESOLVED_CV_FAILURE fallback (all four real fixtures)
 *   Row 7  — READY_FOR_CV without CV receipt → RUN_CV (initial)
 *   Row 8  — slice CV_PASSED without SLICE_COMMIT → ADMIT_SLICE_COMMIT
 *   Row 9  — slice committed without INTEGRATION_PASS → ADMIT_INTEGRATION
 *   Row 10 — per-slice execution: 10a INITIALIZE_EVIDENCE / 10b recover-task
 *            (with warn finding) / 10c implement-task / 10d finalize-slice;
 *            dependency-blocked slice skipped, first runnable slice wins
 *   Row 11 — all slices integrated without GATE_PASS → RUN_GATE
 *   Row 12 — UNDER_REVIEW + GATE_PASS without STAGE_REVIEW_PASS →
 *            FINALIZE_STAGE_REVIEW (counterexample: no RUN_GATE /
 *            PREPARE_STAGE_REVIEW loop)
 *   Row 13 — all rows missed (mutually dependency-blocked) → VALIDATE with
 *            the blocking DOMAIN.INVALID_TRANSITION finding
 *
 * PO-S02-D-03: restart determinism on additional fixtures (fresh service
 * instances deep-equal).
 * PO-S02-D-05: every fixture output is checked against the proofloop_next
 * structure contract (action ∈ 15-value closed set, non-empty action_detail,
 * responsible_role ∈ 10-value RoleType closed set, boolean
 * receipt_chain_valid, findings ≤ 20, exactly the 5 contract keys).
 *
 * Matrix coverage completeness: rows 0–13 each have at least one real
 * fixture assertion in this file; the rows additionally proven in
 * next-action-service.spec.ts (0/3/4/10a/10c/12) are re-proven here with
 * distinct fixtures/assertions so the matrix stands alone.
 */
export {};
//# sourceMappingURL=next-action-matrix.spec.d.ts.map