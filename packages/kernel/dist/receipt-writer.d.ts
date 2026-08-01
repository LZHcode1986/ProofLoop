/**
 * @proofloop/kernel — Append-only ReceiptWriter: digest & chain verification.
 *
 * Kernel-owned ReceiptWriter module providing content-addressed digest
 * computation, file-level digest verification, and receipt chain verification
 * over a real filesystem directory.
 *
 * §4 File / Artifact Contracts: Receipt is immutable, content-addressed,
 * linked by previous_digest.
 *
 * HP-002: write-to-temp + fsync + rename + digest verify
 * AWI-004: atomic write, boundary tests, digest/chain validation
 */
/**
 * Configuration options for the ReceiptWriter.
 *
 * @property receiptDir - Directory where receipts are stored.
 * @property tempDir - Directory for temporary files during atomic writes.
 */
export interface ReceiptWriterOptions {
    receiptDir: string;
    tempDir: string;
}
/**
 * Fallback lock timeout in milliseconds.
 *
 * Used only when a lock directory carries no readable `owner.pid` (legacy
 * format or incomplete acquisition): if the lock directory is older than
 * this, it is considered stale and removed.  When `owner.pid` is present,
 * liveness is decided by probing the owning PID instead of mtime, so a live
 * writer whose fsync outlives this timeout is never evicted (see
 * S01-RR-005: mtime-based eviction could silently fork the receipt chain).
 */
export declare const DEFAULT_LOCK_TIMEOUT_MS = 10000;
/**
 * Result of a successful receipt write operation.
 *
 * @property path - Absolute path of the written receipt file.
 * @property digest - Content-addressed digest (SHA-256 hex) of the receipt.
 */
export interface WriteReceiptResult {
    path: string;
    digest: string;
}
/**
 * Configuration options for receipt chain verification.
 *
 * Future extension point for filtering or ordering options.
 */
export interface VerifyReceiptChainOptions {
    /** Optional: restrict verification to receipts matching a specific stage_id. */
    stageId?: string;
    /** Optional: restrict verification to receipts matching a specific slice_id. */
    sliceId?: string;
}
/**
 * Result of receipt chain verification.
 *
 * @property valid - True if the entire chain is intact (no broken links, no
 *   tampered digests, no duplicates).
 * @property receipts - Ordered list of receipt file paths that form the chain.
 * @property brokenLink - Details of the first broken link, if any.
 * @property duplicateDigests - List of digests that appear under multiple
 *   filenames (same content, different names). Each entry contains the
 *   duplicate digest and the file paths that share it.
 */
export interface ChainVerificationResult {
    valid: boolean;
    receipts: string[];
    brokenLink?: {
        index: number;
        expected: string;
        actual: string;
    };
    duplicateDigests?: Array<{
        digest: string;
        paths: string[];
    }>;
}
/**
 * Write a receipt to disk using an atomic write sequence:
 * acquire lock → temp file (wx) → fsync → rename (atomic) →
 * post-rename verification.
 *
 * The function computes a SHA-256 digest of the input data (excluding any
 * existing `digest` field), adds it to the data, serializes to canonical JSON,
 * acquires a per-directory lock, checks for duplicate, validates predecessor
 * chain integrity, and performs fork detection.
 *
 * Changes vs the previous linkSync-based implementation:
 * - Uses `renameSync` (the POSIX-guaranteed atomic operation) instead of
 *   `linkSync` + `unlinkSync`.  Exclusive-create semantics are preserved by
 *   the per-directory lock + pre-check.
 * - Calls `validateReceipt` on the full data before writing.
 * - Rejects caller-supplied `digest` when it does not match the computed digest.
 * - Detects forks: a linked receipt must append to the most recent chain tip.
 *
 * @param data - Receipt data object. Must not be null, undefined, array, or
 *   primitive. Any existing `digest` field is validated against the computed
 *   digest (mismatch throws), then stripped and recomputed.
 * @param options - Writer options including receiptDir and tempDir.
 * @returns `{ path, digest }` where path is the absolute path of the written
 *   receipt file and digest is the 64-character hex SHA-256 digest.
 * @throws {TypeError} If data is not a plain object.
 * @throws {Error} If duplicate, invalid predecessor, fork detected, or write
 *   failure.
 * @throws {SchemaValidationError} If the data (with computed digest) fails
 *   receipt schema validation.
 */
export declare function writeReceipt(data: object, options: ReceiptWriterOptions): WriteReceiptResult;
/**
 * Compute the SHA-256 digest of a data object using canonical JSON.
 *
 * The digest is computed over the canonical JSON representation of the input
 * data with sorted keys. This ensures content-addressing: identical data
 * always produces the same digest.
 *
 * @param data - The data object to digest. Must be a plain object (not null,
 *   array, or primitive).
 * @returns 64-character hex SHA-256 digest string.
 * @throws {TypeError} If data is not a plain object.
 */
export declare function computeReceiptDigest(data: object): string;
/**
 * Verify that a receipt file's stored digest matches its content.
 *
 * Reads the JSON file, computes the expected digest from all fields except
 * `digest` itself (to avoid circular dependency), and compares it with the
 * stored `digest` field.
 *
 * @param filePath - Path to the receipt JSON file.
 * @returns True if the digest matches, false otherwise (file not found,
 *   malformed JSON, missing digest field, or digest mismatch).
 */
export declare function verifyReceiptDigest(filePath: string): boolean;
/**
 * Walk all receipts in a directory, verifying the previous_digest chain.
 *
 * Reads every `.json` file in the given directory, verifies each receipt's
 * self-digest (using `verifyReceiptDigest`), and then checks that the
 * `previous_digest` links form a valid chain. The chain is walked by finding
 * receipts with no `previous_digest` (genesis receipts) and following links.
 *
 * Multiple chains can coexist in the same directory; each is independently
 * verified. The result reports all receipts found in order.
 *
 * @param receiptDir - Path to the directory containing receipt JSON files.
 * @returns ChainVerificationResult indicating validity and chain details.
 */
export declare function verifyReceiptChain(receiptDir: string): ChainVerificationResult;
/**
 * Throw a ReceiptChainError if chain verification finds any failure.
 *
 * Convenience wrapper around verifyReceiptChain that throws on the first
 * detected failure instead of returning a result object.
 *
 * @param receiptDir - Path to the directory containing receipt JSON files.
 * @throws {ReceiptChainError} If the chain has broken links or duplicate digests.
 */
export declare function assertValidReceiptChain(receiptDir: string): void;
//# sourceMappingURL=receipt-writer.d.ts.map