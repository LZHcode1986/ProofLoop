/**
 * @proofloop/runtime — Receipt reader over the canonical category layout
 *
 * Reads the persisted receipts of ONE canonical receipt category directory:
 *   - only regular `.json` files are considered (`.tmp/`, non-json files and
 *     directories are never receipts);
 *   - every candidate passes kernel `validateReceipt` (RUNTIME.SCHEMA_MISMATCH
 *     condition per invalid file);
 *   - a receipt whose type does not belong to the category directory is a
 *     misplacement (RUNTIME.SCHEMA_MISMATCH condition) and is never used as a
 *     fact;
 *   - kernel `verifyReceiptChain` runs on the category directory (PO-S02-C-03):
 *     intact chain → `chainValid: true`; broken link / tampered digest /
 *     duplicate digest → `chainValid: false` plus a structured
 *     RUNTIME.RECEIPT_CHAIN_BROKEN condition;
 *   - valid receipts are deterministically ordered by (timestamp, digest) and
 *     the newest is exposed as `latest` (PO-S02-C-01 reader part — same input
 *     always yields the same output, HP-003).
 *
 * The reader is read-only and deterministic; it reports conditions and facts
 * but never guesses, repairs, or writes. Reconcile (S02-C-T03) consumes these
 * results and applies the chain-validity fact-blocking policy: when
 * `chainValid` is false, no fact may be derived from that chain
 * (PO-S02-C-03).
 */
import type { Receipt, ReceiptType } from '@proofloop/kernel';
import type { ReceiptContentCategory } from './receipt-layout';
/** One valid, category-correct receipt read from disk. */
export interface ReadReceiptResult {
    /** Absolute path of the receipt file. */
    readonly filePath: string;
    /** Validated receipt payload. */
    readonly receipt: Receipt;
}
/** A file in the category directory that failed parse/schema/self-digest. */
export interface InvalidReceiptFile {
    readonly filePath: string;
    readonly code: 'RUNTIME.SCHEMA_MISMATCH' | 'RUNTIME.RECEIPT_CHAIN_BROKEN';
    readonly reason: string;
}
/** A schema-valid receipt whose type does not belong to this category dir. */
export interface MisplacedReceiptFile {
    readonly filePath: string;
    readonly receiptType: ReceiptType;
    readonly expectedCategory: ReceiptContentCategory;
    readonly foundInCategory: ReceiptContentCategory;
    readonly code: 'RUNTIME.SCHEMA_MISMATCH';
}
/** Structured chain-integrity failure condition (PO-S02-C-03). */
export interface ChainBrokenCondition {
    readonly code: 'RUNTIME.RECEIPT_CHAIN_BROKEN';
    readonly reason: string;
}
/** Full read result for one category directory. */
export interface ReceiptCategoryReadResult {
    readonly category: ReceiptContentCategory;
    /** The category directory that was scanned. */
    readonly dir: string;
    /** Kernel `verifyReceiptChain` verdict over the category directory. */
    readonly chainValid: boolean;
    /** Structured chain condition when `chainValid` is false, else null. */
    readonly chainCondition: ChainBrokenCondition | null;
    /**
     * Valid, category-correct receipts in deterministic (timestamp, digest)
     * ascending order. Consumers must NOT derive facts when `chainValid` is
     * false (PO-S02-C-03 fact blocking).
     */
    readonly receipts: readonly ReadReceiptResult[];
    /** The newest receipt per the deterministic order, or null. */
    readonly latest: ReadReceiptResult | null;
    /** Files that failed parse/schema/self-digest (never facts). */
    readonly invalidFiles: readonly InvalidReceiptFile[];
    /** Receipts whose type does not belong to this category (never facts). */
    readonly misplaced: readonly MisplacedReceiptFile[];
}
export interface ReadReceiptCategoryOptions {
    readonly projectRoot: string;
    readonly category: ReceiptContentCategory;
    readonly stageId: string;
    /** Required for slice-level categories (tasks/cv/committer/integration). */
    readonly sliceId?: string;
}
/**
 * Read and validate the receipts of one canonical category directory.
 *
 * Deterministic (HP-003): same input → same output. Read-only; never repairs
 * or writes.
 *
 * @throws {TypeError} when a required stage/slice id is missing for the
 *         category (delegated to the layout resolver).
 */
export declare function readReceiptCategory(options: ReadReceiptCategoryOptions): ReceiptCategoryReadResult;
/**
 * Deterministic comparator over read receipts: timestamp ascending, digest
 * ascending as the tie-break (locale-independent plain string comparison).
 *
 * Sorting with this comparator is stable and reproducible across hosts and
 * locales (HP-003 / HP-005).
 */
export declare function compareReceiptsByTimestampDigest(a: ReadReceiptResult, b: ReadReceiptResult): number;
export interface ReadAllReceiptsOptions {
    readonly projectRoot: string;
    readonly stageId: string;
    readonly sliceId: string;
}
export type ReceiptCategoryResults = Readonly<Record<ReceiptContentCategory, ReceiptCategoryReadResult>>;
/**
 * Read every canonical content category directory for one stage/slice context.
 *
 * Convenience composition over `readReceiptCategory` used by Reconcile
 * (S02-C-T03) to run `verifyReceiptChain` per category directory (PO-S02-C-03).
 */
export declare function readAllReceiptCategories(options: ReadAllReceiptsOptions): ReceiptCategoryResults;
//# sourceMappingURL=receipt-reader.d.ts.map