/**
 * reconcileStage — S02-C-T03 (PO-S02-C-02 finding semantics /
 * PO-S02-C-03 chain integrity + fact blocking / PO-S02-C-01 merge determinism)
 *
 * Verifies the three-source merge seam against REAL filesystem fixtures
 * (temp directory + REAL git repo + canonical `.proofloop` layout + kernel
 * ReceiptWriter-produced receipts). No mocks, no cached state files (HP-003).
 *
 * Behaviors under test:
 *   - consistent fixture → NO error findings; per-slice task/cv facts merged.
 *   - determinism: two reconciles of the same fixture are deep-equal.
 *   - every inconsistency kind → canonical Finding (code/severity/message)
 *     with the affected facts left un-guessed (PO-S02-C-02):
 *       receipt referencing unknown slice/stage  → DOMAIN.STAGE_NOT_FOUND
 *       schema-invalid / legacy receipt          → RUNTIME.SCHEMA_MISMATCH
 *       misplaced receipt (type/category)        → RUNTIME.SCHEMA_MISMATCH
 *       manifest missing / stage_id mismatch     → DOMAIN.STAGE_NOT_FOUND
 *       non-git root (git source unavailable)    → RUNTIME.SCHEMA_MISMATCH
 *       git HEAD vs SLICE_COMMIT recorded SHA    → RUNTIME.RECEIPT_CHAIN_BROKEN
 *       task checked ↔ evidence missing          → warn finding (recoverable)
 *   - broken / tampered / duplicate-digest chain → receipt_chain_valid=false
 *     + RUNTIME.RECEIPT_CHAIN_BROKEN + facts blocked (PO-S02-C-03).
 *   - findings deterministically sorted by (code, severity, message).
 *
 * T04 derivation (PO-S02-C-04 / PO-S02-C-01 derivation part) adds the
 * authoritative per-slice/stage facts on real fixtures:
 *   - partial completion → IN_PROGRESS / NOT_STARTED, never committed;
 *   - CV_PASS + finalize-slice receipt (no commit) → CV_PASSED / PASS;
 *   - bound SLICE_COMMIT (no integration) → INTEGRATING / committed;
 *   - bound INTEGRATION_PASS → INTEGRATED / complete, stage COMPLETED;
 *   - CV_REPAIR + later repair-mode TASK_COMPLETE → PENDING_RECHECK;
 *   - binding negatives: unbound SLICE_COMMIT / wrong commit SHA integration
 *     / CV_REPAIR-bound commit → committed/integrated stay false (never
 *     guess; receipt missing or unbound must not mark committed/integrated);
 *   - no receipts at all → cv NOT_STARTED, committed/integrated/complete false;
 *   - contradictory stage facts (STAGE_REVIEW_PASS while a slice is not
 *     integrated) → DOMAIN.INVALID_TRANSITION finding, stage UNINITIALIZED;
 *   - derived facts are deterministic: two reconciles deep-equal.
 *
 * T05 matrix completion (PO → test → assertion completeness):
 *   - determinism WITH findings present — two reconciles of a
 *     multi-inconsistency fixture are deep-equal, findings included, and
 *     every emitted code belongs to the closed 9-code §7 Error Contracts set
 *     (PO-S02-C-01 / PO-S02-C-02);
 *   - a receipt referencing an unknown stage → DOMAIN.STAGE_NOT_FOUND, not
 *     merged (PO-S02-C-02 independent fixture);
 *   - tampered committer chain → receipt_chain_valid false + committed fact
 *     blocked while the cv chain survives (PO-S02-C-03 fact blocking on a
 *     non-cv category);
 *   - `.tmp` scratch receipts and non-json files are never facts and produce
 *     no findings (PO-S02-C-05);
 *   - fully-complete fixture full-chain assertions: receipt_chain (all 7
 *     digests, deterministic order), per-category chains, per-task facts,
 *     cv binding, complete=true (PO-S02-C-04/01).
 */
export {};
//# sourceMappingURL=reconcile.spec.d.ts.map