"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readReceiptCategory = readReceiptCategory;
exports.compareReceiptsByTimestampDigest = compareReceiptsByTimestampDigest;
exports.readAllReceiptCategories = readAllReceiptCategories;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const kernel_1 = require("@proofloop/kernel");
const receipt_layout_1 = require("./receipt-layout");
// ============================================================
// Internal helpers
// ============================================================
/** Empty result for a missing/unreadable category directory. */
function emptyResult(category, dir) {
    return {
        category,
        dir,
        chainValid: true,
        chainCondition: null,
        receipts: [],
        latest: null,
        invalidFiles: [],
        misplaced: [],
    };
}
// ============================================================
// Reader
// ============================================================
/**
 * Read and validate the receipts of one canonical category directory.
 *
 * Deterministic (HP-003): same input → same output. Read-only; never repairs
 * or writes.
 *
 * @throws {TypeError} when a required stage/slice id is missing for the
 *         category (delegated to the layout resolver).
 */
function readReceiptCategory(options) {
    const { projectRoot, category } = options;
    const dir = (0, receipt_layout_1.receiptCategoryDir)(projectRoot, category, options.stageId, options.sliceId);
    let filenames;
    try {
        filenames = fs.readdirSync(dir);
    }
    catch {
        // Missing directory → no receipts, chain trivially valid.
        return emptyResult(category, dir);
    }
    // Same file selection as the kernel chain verifier: `.json` files only
    // (kernel temp files end in `.tmp.<pid>` and non-json files are excluded by
    // extension). Sorted for deterministic processing order.
    const jsonFiles = filenames.filter((f) => f.endsWith('.json')).sort();
    const receipts = [];
    const invalidFiles = [];
    const misplaced = [];
    for (const filename of jsonFiles) {
        const filePath = path.join(dir, filename);
        // Directories named `*.json` are never receipts (PO-S02-C-05).
        let stat;
        try {
            stat = fs.statSync(filePath);
        }
        catch {
            invalidFiles.push({
                filePath,
                code: 'RUNTIME.SCHEMA_MISMATCH',
                reason: 'cannot stat receipt file',
            });
            continue;
        }
        if (!stat.isFile()) {
            continue;
        }
        // Read + parse.
        let raw;
        try {
            raw = fs.readFileSync(filePath, 'utf-8');
        }
        catch {
            invalidFiles.push({
                filePath,
                code: 'RUNTIME.SCHEMA_MISMATCH',
                reason: 'cannot read receipt file',
            });
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (err) {
            invalidFiles.push({
                filePath,
                code: 'RUNTIME.SCHEMA_MISMATCH',
                reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
        }
        // Kernel schema validation (RUNTIME.SCHEMA_MISMATCH on failure).
        let validated;
        try {
            validated = (0, kernel_1.validateReceipt)(parsed);
        }
        catch (err) {
            const reason = err instanceof kernel_1.SchemaValidationError ? err.message : String(err);
            invalidFiles.push({ filePath, code: 'RUNTIME.SCHEMA_MISMATCH', reason });
            continue;
        }
        // Type/category classification (PO-S02-C-05): a receipt whose type does
        // not belong to this category directory is a misplacement — reported and
        // never used as a fact.
        const expectedCategory = receipt_layout_1.RECEIPT_TYPE_CATEGORY[validated.type];
        if (expectedCategory !== category) {
            misplaced.push({
                filePath,
                receiptType: validated.type,
                expectedCategory,
                foundInCategory: category,
                code: 'RUNTIME.SCHEMA_MISMATCH',
            });
            continue;
        }
        // Self-digest integrity (tampered content). A stored digest that does not
        // match the file content is a chain-integrity problem (RUNTIME.RECEIPT_CHAIN_BROKEN)
        // and the file is excluded from facts (PO-S02-C-03 fact blocking).
        if (!(0, kernel_1.verifyReceiptDigest)(filePath)) {
            invalidFiles.push({
                filePath,
                code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
                reason: 'stored digest does not match computed digest',
            });
            continue;
        }
        receipts.push({ filePath, receipt: validated });
    }
    // Deterministic ordering: (timestamp, digest) ascending — locale-independent
    // plain string comparison. `latest` is the newest per this order.
    const ordered = [...receipts].sort(compareReceiptsByTimestampDigest);
    const latest = ordered.length > 0 ? ordered[ordered.length - 1] : null;
    // Chain verification over the whole category directory (kernel seam,
    // PO-S02-C-03): broken link, tampered digest, or duplicate digest → invalid.
    const chain = (0, kernel_1.verifyReceiptChain)(dir);
    let chainCondition = null;
    if (!chain.valid) {
        if (chain.brokenLink) {
            chainCondition = {
                code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
                reason: `broken link at index ${chain.brokenLink.index}: expected ` +
                    `${chain.brokenLink.expected}, got ${chain.brokenLink.actual}`,
            };
        }
        else if (chain.duplicateDigests && chain.duplicateDigests.length > 0) {
            chainCondition = {
                code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
                reason: 'duplicate digests: ' +
                    chain.duplicateDigests.map((d) => d.digest).join(', '),
            };
        }
        else {
            chainCondition = {
                code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
                reason: 'chain verification failed',
            };
        }
    }
    return {
        category,
        dir,
        chainValid: chain.valid,
        chainCondition,
        receipts: ordered,
        latest,
        invalidFiles,
        misplaced,
    };
}
/**
 * Deterministic comparator over read receipts: timestamp ascending, digest
 * ascending as the tie-break (locale-independent plain string comparison).
 *
 * Sorting with this comparator is stable and reproducible across hosts and
 * locales (HP-003 / HP-005).
 */
function compareReceiptsByTimestampDigest(a, b) {
    if (a.receipt.timestamp < b.receipt.timestamp)
        return -1;
    if (a.receipt.timestamp > b.receipt.timestamp)
        return 1;
    if (a.receipt.digest < b.receipt.digest)
        return -1;
    if (a.receipt.digest > b.receipt.digest)
        return 1;
    return 0;
}
/**
 * Read every canonical content category directory for one stage/slice context.
 *
 * Convenience composition over `readReceiptCategory` used by Reconcile
 * (S02-C-T03) to run `verifyReceiptChain` per category directory (PO-S02-C-03).
 */
function readAllReceiptCategories(options) {
    const results = {};
    for (const category of receipt_layout_1.RECEIPT_CONTENT_CATEGORIES) {
        results[category] = readReceiptCategory({
            projectRoot: options.projectRoot,
            category,
            stageId: options.stageId,
            sliceId: options.sliceId,
        });
    }
    return results;
}
//# sourceMappingURL=receipt-reader.js.map