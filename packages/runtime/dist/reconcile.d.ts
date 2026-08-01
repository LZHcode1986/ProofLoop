/**
 * @proofloop/runtime — ReconcileService: three-source merge (S02-C-T03)
 *
 * Merges the three authoritative sources of a stage reconcile into one
 * deterministic normalized state snapshot (HP-003 — never a guess):
 *
 *   1. Manifest source (S02-C-T02): stage/slice structure + task/evidence
 *      paths, validated through the kernel `validateManifest` seam. Missing /
 *      parse-failed / schema-invalid / stage_id-mismatched manifest →
 *      `DOMAIN.STAGE_NOT_FOUND` (PO-S02-C-02).
 *   2. Git source (S02-C-T02): HEAD, tasks.md checkbox states and evidence
 *      file facts from the real work tree. A non-git root / unborn HEAD /
 *      missing tasks.md makes the Git source unavailable →
 *      `RUNTIME.SCHEMA_MISMATCH` (PO-S02-C-02).
 *   3. Receipts source (S02-C-T01): the canonical category directory layout,
 *      read through the receipt reader — kernel `verifyReceiptChain` per
 *      category directory (PO-S02-C-03), schema validation, type/category
 *      misplacement detection and deterministic (timestamp, digest) ordering.
 *
 * Inconsistency → Finding mapping (Authority Excerpts, PO-S02-C-02):
 *   - receipt references unknown slice/stage        → DOMAIN.STAGE_NOT_FOUND
 *   - schema-invalid / legacy receipt               → RUNTIME.SCHEMA_MISMATCH
 *   - misplaced receipt (type/category mismatch)    → RUNTIME.SCHEMA_MISMATCH
 *   - slice-bound receipt disagreeing with its
 *     directory                                     → RUNTIME.SCHEMA_MISMATCH
 *   - manifest missing / stage_id mismatch          → DOMAIN.STAGE_NOT_FOUND
 *   - non-git root (git source unavailable)         → RUNTIME.SCHEMA_MISMATCH
 *   - git HEAD does not contain the SHA recorded in
 *     a SLICE_COMMIT receipt                        → RUNTIME.RECEIPT_CHAIN_BROKEN
 *   - broken / tampered / duplicate-digest chain    → RUNTIME.RECEIPT_CHAIN_BROKEN
 *   - task checked while evidence missing (or vice
 *     versa)                                        → RUNTIME.SCHEMA_MISMATCH
 *                                                    (severity 'warn' — recoverable;
 *                                                     the only warn finding of the
 *                                                     closed 9-code set, picked for
 *                                                     the work-tree fact mismatch)
 *
 * Affected facts stay un-guessed (HP-003):
 *   - receipts referencing unknown slices/stages are never merged — the
 *     unknown entity simply does not exist in the normalized output;
 *   - a receipt whose own slice_id disagrees with its containing directory
 *     is attributed to neither slice (ambiguous → no guess);
 *   - when a category chain is invalid, NO fact is derived from that chain —
 *     the category is marked `receipt_chain_valid: false` (PO-S02-C-03 fact
 *     blocking) and the overall `receipt_chain_valid` is false;
 *   - when the Git source is unavailable the per-task facts stay at the
 *     un-guessed default and the error Finding blocks downstream use.
 *
 * Per-slice/stage authoritative derivation (cv_status / slice_state /
 * committed / integrated / complete / stage_state) is the S02-C-T04 concern,
 * implemented below against the PO-S02-C-04 mapping (receipts authoritative;
 * missing/unbound receipts never mark committed/integrated/complete; stage
 * derivation through S02-A `deriveStageState` with READY folding; a
 * contradictory stage fact combination surfaces a `DOMAIN.INVALID_TRANSITION`
 * finding instead of a silent guess).
 *
 * Determinism (HP-003): every scan order is fixed (manifest declaration
 * order, canonical category order, sorted directory listings) and findings are
 * sorted by (code, severity, message) with exact-duplicate collapse.
 * Read-only — never writes, repairs or commits.
 */
import type { Finding } from '@proofloop/kernel';
import type { ChainBrokenCondition } from './receipt-reader';
import type { ReceiptContentCategory } from './receipt-layout';
import type { ReconciledStageState } from './state-model';
export interface ReconcileStageInput {
    /** Project root (must be the git root when the Git source is available). */
    readonly projectRoot: string;
    /** Stage id to reconcile. */
    readonly stageId: string;
    /** Custom manifest path (defaults to `.proofloop/manifests/<stage>.json`). */
    readonly manifestPath?: string;
    /** Custom tasks.md path (defaults to `delivery/stages/<stage>/tasks.md`). */
    readonly tasksMdPath?: string;
}
/**
 * Chain-integrity state of one canonical receipt category directory
 * (PO-S02-C-03).
 *
 * Slice-level categories (tasks/cv/committer/integration) carry their slice
 * id; stage-level categories (plan/stage-gate/review/project) have
 * `slice_id: null`.
 */
export interface CategoryChainState {
    readonly category: ReceiptContentCategory;
    /** Slice id for slice-level categories; null for stage-level categories. */
    readonly slice_id: string | null;
    /** Kernel `verifyReceiptChain` verdict over this category directory. */
    readonly receipt_chain_valid: boolean;
    /** Structured chain condition when invalid, else null. */
    readonly chain_condition: ChainBrokenCondition | null;
}
/**
 * Reconcile output: the normalized `ReconciledStageState` plus the chain
 * validity markers (PO-S02-C-03). Structurally a superset of
 * `ReconciledStageState` (the observable outcome of the reconcile seam).
 */
export interface ReconcileStageResult extends ReconciledStageState {
    /**
     * Overall chain validity: true only when EVERY scanned category chain is
     * valid (no receipts scanned → vacuously true, like an empty chain).
     */
    readonly receipt_chain_valid: boolean;
    /** Per-category chain validity in canonical category order. */
    readonly receipt_categories: readonly CategoryChainState[];
}
/**
 * Deterministic comparator over canonical Findings: code ascending, then
 * severity ascending ('error' < 'warn'), then message ascending — plain
 * locale-independent string comparison (HP-003).
 */
export declare function compareFindings(a: Finding, b: Finding): number;
/**
 * Deterministic finding ordering: sort by (code, severity, message) and
 * collapse exact duplicates. Identical (code, severity, message) findings
 * carry the same information, so the collapse is order-stable and lossless.
 */
export declare function sortFindings(findings: readonly Finding[]): Finding[];
/**
 * Reconcile the Manifest + Git + Receipts sources of one stage into a
 * deterministic normalized snapshot with canonical Findings.
 *
 * Deterministic (HP-003) and read-only; never guesses, repairs or writes.
 *
 * @throws {TypeError} when `projectRoot` / `stageId` are missing or empty.
 */
export declare function reconcileStage(input: ReconcileStageInput): ReconcileStageResult;
//# sourceMappingURL=reconcile.d.ts.map