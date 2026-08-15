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

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  validateReceipt,
  verifyReceiptChain,
  verifyReceiptDigest,
  SchemaValidationError,
} from '@proofloop/kernel';
import type { Receipt, ReceiptType } from '@proofloop/kernel';
import {
  receiptCategoryDir,
  RECEIPT_CONTENT_CATEGORIES,
  RECEIPT_TYPE_CATEGORY,
} from './receipt-layout';
import type { ReceiptContentCategory } from './receipt-layout';
import { canonicalPathWithinRoot, openNoFollowRead } from './path-guard';

// ============================================================
// Result types
// ============================================================

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

// ============================================================
// Internal helpers
// ============================================================

/** Empty result for a missing/unreadable category directory. */
function emptyResult(
  category: ReceiptContentCategory,
  dir: string,
): ReceiptCategoryReadResult {
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

/**
 * Fail-closed trust-root escape result (S2-F-003): a category directory whose
 * canonical path escapes the project root is NEVER read — an escaped directory
 * could otherwise redirect the receipt read to files outside the worktree and
 * derive state from them. The result reports an error-level
 * RUNTIME.RECEIPT_CHAIN_BROKEN chain condition so reconcile's
 * `handleCategoryRead` blocks every fact of that category (PO-S02-C-03 fact
 * blocking) without changing the reader's API shape.
 */
function trustRootEscapeResult(
  category: ReceiptContentCategory,
  dir: string,
): ReceiptCategoryReadResult {
  return {
    category,
    dir,
    chainValid: false,
    chainCondition: {
      code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
      reason: `receipt category directory escapes the project root trust boundary: ${dir}`,
    },
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
export function readReceiptCategory(options: ReadReceiptCategoryOptions): ReceiptCategoryReadResult {
  const { projectRoot, category } = options;
  const dir = receiptCategoryDir(projectRoot, category, options.stageId, options.sliceId);

  // Trust-root boundary (S2-F-003): a category directory whose canonical path
  // escapes the project root is NEVER read. An escape surfaces as a broken
  // chain so no fact can be derived from outside files (fail-closed).
  if (canonicalPathWithinRoot(projectRoot, dir) === null) {
    return trustRootEscapeResult(category, dir);
  }

  let filenames: string[];
  try {
    filenames = fs.readdirSync(dir);
  } catch {
    // Missing directory → no receipts, chain trivially valid.
    return emptyResult(category, dir);
  }

  // Same file selection as the kernel chain verifier: `.json` files only
  // (kernel temp files end in `.tmp.<pid>` and non-json files are excluded by
  // extension). Sorted for deterministic processing order.
  const jsonFiles = filenames.filter((f) => f.endsWith('.json')).sort();

  const receipts: ReadReceiptResult[] = [];
  const invalidFiles: InvalidReceiptFile[] = [];
  const misplaced: MisplacedReceiptFile[] = [];

  for (const filename of jsonFiles) {
    const filePath = path.join(dir, filename);

    // Trust-root boundary (S2-F-003 round 3, atomic no-follow boundary): the
    // candidate file is opened with O_NOFOLLOW against its canonical parent,
    // so a symlink replacement between any pre-check and the read cannot
    // redirect the open/read outside the root (a symlink at the final
    // component — in-root or external — fails closed with ELOOP). The escaped
    // file is reported as an invalid file and never read / never enters the
    // receipt list / derivation (fail-closed, PO-S02-C-03 fact blocking).
    const opened = openNoFollowRead(projectRoot, filePath);
    if (!opened.ok) {
      invalidFiles.push({
        filePath,
        code: 'RUNTIME.SCHEMA_MISMATCH',
        reason:
          opened.reason === 'escape' || opened.reason === 'inode-mismatch'
            ? 'receipt file path escapes the project root trust boundary'
            : 'cannot stat receipt file',
      });
      continue;
    }
    try {
      // Directories named `*.json` are never receipts (PO-S02-C-05).
      if (!fs.fstatSync(opened.fd).isFile()) {
        continue;
      }

      // Read via the no-follow fd (content identical to `readFileSync(path)`),
      // then parse.
      let raw: string;
      try {
        raw = fs.readFileSync(opened.fd, 'utf-8');
      } catch {
        invalidFiles.push({
          filePath,
          code: 'RUNTIME.SCHEMA_MISMATCH',
          reason: 'cannot read receipt file',
        });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        invalidFiles.push({
          filePath,
          code: 'RUNTIME.SCHEMA_MISMATCH',
          reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      // Kernel schema validation (RUNTIME.SCHEMA_MISMATCH on failure).
      let validated: Receipt;
      try {
        validated = validateReceipt(parsed);
      } catch (err) {
        const reason =
          err instanceof SchemaValidationError ? err.message : String(err);
        invalidFiles.push({ filePath, code: 'RUNTIME.SCHEMA_MISMATCH', reason });
        continue;
      }

      // Type/category classification (PO-S02-C-05): a receipt whose type does
      // not belong to this category directory is a misplacement — reported and
      // never used as a fact.
      const expectedCategory = RECEIPT_TYPE_CATEGORY[validated.type];
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
      // The kernel re-reads by path — a residual kernel-side window, noted in
      // the round-3 limitations; the fact content itself comes from the
      // no-follow fd read above.
      if (!verifyReceiptDigest(opened.filePath)) {
        invalidFiles.push({
          filePath,
          code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
          reason: 'stored digest does not match computed digest',
        });
        continue;
      }

      receipts.push({ filePath, receipt: validated });
    } finally {
      fs.closeSync(opened.fd);
    }
  }

  // Deterministic ordering: (timestamp, digest) ascending — locale-independent
  // plain string comparison. `latest` is the newest per this order.
  const ordered = [...receipts].sort(compareReceiptsByTimestampDigest);
  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : null;

  // Chain verification over the whole category directory (kernel seam,
  // PO-S02-C-03): broken link, tampered digest, or duplicate digest → invalid.
  const chain = verifyReceiptChain(dir);
  let chainCondition: ChainBrokenCondition | null = null;
  if (!chain.valid) {
    if (chain.brokenLink) {
      chainCondition = {
        code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
        reason:
          `broken link at index ${chain.brokenLink.index}: expected ` +
          `${chain.brokenLink.expected}, got ${chain.brokenLink.actual}`,
      };
    } else if (chain.duplicateDigests && chain.duplicateDigests.length > 0) {
      chainCondition = {
        code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
        reason:
          'duplicate digests: ' +
          chain.duplicateDigests.map((d) => d.digest).join(', '),
      };
    } else {
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
export function compareReceiptsByTimestampDigest(
  a: ReadReceiptResult,
  b: ReadReceiptResult,
): number {
  if (a.receipt.timestamp < b.receipt.timestamp) return -1;
  if (a.receipt.timestamp > b.receipt.timestamp) return 1;
  if (a.receipt.digest < b.receipt.digest) return -1;
  if (a.receipt.digest > b.receipt.digest) return 1;
  return 0;
}

// ============================================================
// All-categories reader
// ============================================================

export interface ReadAllReceiptsOptions {
  readonly projectRoot: string;
  readonly stageId: string;
  readonly sliceId: string;
}

export type ReceiptCategoryResults = Readonly<
  Record<ReceiptContentCategory, ReceiptCategoryReadResult>
>;

/**
 * Read every canonical content category directory for one stage/slice context.
 *
 * Convenience composition over `readReceiptCategory` used by Reconcile
 * (S02-C-T03) to run `verifyReceiptChain` per category directory (PO-S02-C-03).
 */
export function readAllReceiptCategories(
  options: ReadAllReceiptsOptions,
): ReceiptCategoryResults {
  const results = {} as Record<ReceiptContentCategory, ReceiptCategoryReadResult>;
  for (const category of RECEIPT_CONTENT_CATEGORIES) {
    results[category] = readReceiptCategory({
      projectRoot: options.projectRoot,
      category,
      stageId: options.stageId,
      sliceId: options.sliceId,
    });
  }
  return results;
}
