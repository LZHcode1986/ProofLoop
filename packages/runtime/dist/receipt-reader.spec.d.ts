/**
 * readReceiptCategory — PO-S02-C-05 (misplacement), PO-S02-C-03 (chain),
 * PO-S02-C-01 (reader determinism)
 *
 * Verifies the runtime receipt reader seam against REAL filesystem fixtures
 * (temp directory + canonical `.proofloop` layout) — no mocks, no cached
 * state files. Receipt files are produced by the kernel ReceiptWriter
 * (`writeReceipt`), the canonical writer, so every fixture receipt carries a
 * correct content digest and chain linkage.
 *
 * Behaviors under test:
 *   - type/category mismatch (e.g. CV_PASS in the integration dir) →
 *     RUNTIME.SCHEMA_MISMATCH misplacement condition; the misplaced receipt is
 *     never used as a fact.
 *   - tampered chained receipt → chain invalid with RUNTIME.RECEIPT_CHAIN_BROKEN
 *     condition; the tampered file is excluded from facts (fact blocking).
 *   - `.tmp/`, non-json files and directories are never read as receipts.
 *   - deterministic (timestamp, digest) ordering; latest = newest; identical
 *     input produces deep-equal output on repeated reads.
 */
export {};
//# sourceMappingURL=receipt-reader.spec.d.ts.map