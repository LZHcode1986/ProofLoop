/**
 * @proofloop/runtime — Canonical receipt category directory layout (PO-S02-C-05)
 *
 * The runtime-owned Artifact Path Policy: all persisted receipts live under
 * `<projectRoot>/.proofloop/receipts/` in one of eight canonical content
 * category directories, plus a `.tmp/` scratch directory that is NEVER read
 * as a receipt source:
 *
 *   plan/<stage>/            SLICE_PLAN, STAGE_PLAN, SPV_PASS
 *   tasks/<stage>/<slice>/   TASK_COMPLETE
 *   cv/<stage>/<slice>/      CV_PASS, CV_REPAIR
 *   committer/<stage>/<slice>/  SLICE_COMMIT
 *   integration/<stage>/<slice>/ INTEGRATION_PASS
 *   stage-gate/<stage>/      GATE_PASS, GATE_FAIL, GATE_INTERRUPTED
 *   review/<stage>/          STAGE_REVIEW_PASS
 *   project/                 PROJECT_REVIEW_PASS
 *   .tmp/                    scratch — never a receipt source
 *
 * Reconcile (S02-C-T03) reads ONLY this layout; the kernel ReceiptWriter
 * (S01) writes into it; kernel `verifyReceiptChain` runs per category
 * directory (each directory holds its own independent chain, PO-S02-C-03).
 *
 * Policy note: `SPV_PASS` (the stage-plan semantic proof verification pass)
 * is classified under `plan/<stage>/` — it is the plan-lifecycle receipt
 * (STAGE_PLAN → SPV_PASS), matching deriveStageState's stage-boundary trio
 * STAGE_PLAN / SPV_PASS / STAGE_REVIEW_PASS.
 *
 * Determinism (HP-003): all path resolution is pure `path.join` over the
 * canonical segment names — no I/O, no timestamps, no locale-dependent
 * ordering.
 */
import type { ReceiptType } from '@proofloop/kernel';
/** Receipt category directory names (closed set, canonical). */
export type ReceiptCategory = 'plan' | 'tasks' | 'cv' | 'committer' | 'integration' | 'stage-gate' | 'review' | 'project' | 'tmp';
/** Content categories that may hold receipt files (excludes `.tmp`). */
export type ReceiptContentCategory = Exclude<ReceiptCategory, 'tmp'>;
/** Closed set of all 9 category directory names. */
export declare const RECEIPT_CATEGORIES: readonly ReceiptCategory[];
/** Closed set of the 8 content categories (never `.tmp`). */
export declare const RECEIPT_CONTENT_CATEGORIES: readonly ReceiptContentCategory[];
/** Canonical receipts root: `<projectRoot>/.proofloop/receipts`. */
export declare function receiptsRoot(projectRoot: string): string;
/** `plan/<stage>/` — SLICE_PLAN, STAGE_PLAN, SPV_PASS. */
export declare function planReceiptDir(projectRoot: string, stageId: string): string;
/** `tasks/<stage>/<slice>/` — TASK_COMPLETE. */
export declare function tasksReceiptDir(projectRoot: string, stageId: string, sliceId: string): string;
/** `cv/<stage>/<slice>/` — CV_PASS, CV_REPAIR. */
export declare function cvReceiptDir(projectRoot: string, stageId: string, sliceId: string): string;
/** `committer/<stage>/<slice>/` — SLICE_COMMIT. */
export declare function committerReceiptDir(projectRoot: string, stageId: string, sliceId: string): string;
/** `integration/<stage>/<slice>/` — INTEGRATION_PASS. */
export declare function integrationReceiptDir(projectRoot: string, stageId: string, sliceId: string): string;
/** `stage-gate/<stage>/` — GATE_PASS, GATE_FAIL, GATE_INTERRUPTED. */
export declare function stageGateReceiptDir(projectRoot: string, stageId: string): string;
/** `review/<stage>/` — STAGE_REVIEW_PASS. */
export declare function reviewReceiptDir(projectRoot: string, stageId: string): string;
/** `project/` — PROJECT_REVIEW_PASS. */
export declare function projectReceiptDir(projectRoot: string): string;
/** `.tmp/` — scratch, never read as receipts. */
export declare function tmpReceiptDir(projectRoot: string): string;
/**
 * Resolve the directory for a category.
 *
 * Stage-level categories (`plan`, `stage-gate`, `review`) require `stageId`;
 * slice-level categories (`tasks`, `cv`, `committer`, `integration`) require
 * both `stageId` and `sliceId`; `project` and `tmp` require neither.
 *
 * @throws {TypeError} when a required stage/slice id is missing.
 */
export declare function receiptCategoryDir(projectRoot: string, category: ReceiptCategory, stageId?: string, sliceId?: string): string;
/** Full deterministic layout map for one stage/slice context. */
export interface ReceiptLayout {
    /** `<projectRoot>/.proofloop/receipts`. */
    readonly root: string;
    /** `plan/<stage>/`. */
    readonly plan: string;
    /** `tasks/<stage>/<slice>/`. */
    readonly tasks: string;
    /** `cv/<stage>/<slice>/`. */
    readonly cv: string;
    /** `committer/<stage>/<slice>/`. */
    readonly committer: string;
    /** `integration/<stage>/<slice>/`. */
    readonly integration: string;
    /** `stage-gate/<stage>/`. */
    readonly stageGate: string;
    /** `review/<stage>/`. */
    readonly review: string;
    /** `project/`. */
    readonly project: string;
    /** `.tmp/` scratch. */
    readonly tmp: string;
}
/** Deterministic layout map for one stage/slice context (PO-S02-C-05). */
export declare function receiptLayout(projectRoot: string, stageId: string, sliceId: string): ReceiptLayout;
/**
 * Canonical mapping from each of the 13 receipt types to the content category
 * directory that may hold it. This is the closed-set classification used to
 * detect misplaced receipts (type/category mismatch → RUNTIME.SCHEMA_MISMATCH).
 *
 * The mapping is total: every one of the 13 receipt types maps to exactly one
 * content category, and no type maps to the `.tmp` scratch directory.
 */
export declare const RECEIPT_TYPE_CATEGORY: Readonly<Record<ReceiptType, ReceiptContentCategory>>;
/** Inverse map: content category → ordered list of allowed receipt types. */
export declare const RECEIPT_TYPES_BY_CATEGORY: Readonly<Record<ReceiptContentCategory, readonly ReceiptType[]>>;
//# sourceMappingURL=receipt-layout.d.ts.map