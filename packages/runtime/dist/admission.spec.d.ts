/**
 * admission.spec.ts — S02-E-T01 (PO-S02-E-01 skeleton part)
 *
 * Public seam: `@proofloop/runtime` — the 7-member `AdmissionRequest`
 * discriminated union + the unified admit pipeline `runAdmitPipeline` (the
 * AWI-006 pipeline: request schema validation → reconcile current state →
 * reducer precheck → canonical Receipt construction → kernel `writeReceipt`
 * → post-write chain verification → `{ accepted, receipt_ref, new_state,
 * findings }`).
 *
 * Covered in this task:
 *  1. Schema validation of all 7 request types — valid passes, invalid
 *     variants fail closed with `SchemaValidationError`
 *     (RUNTIME.SCHEMA_MISMATCH) carrying per-field errors; the
 *     `worker_result` envelope reuses the canonical S02-B
 *     `validateWorkerResultEnvelope` seam.
 *  2. The pipeline fails closed on invalid input — a structured rejection
 *     (accepted=false, receipt_ref=null, SCHEMA_MISMATCH finding) and the
 *     writer is never invoked.
 *  3. The pipeline persists receipts ONLY through the injected
 *     `ReceiptWriterPort` (kernel ReceiptWriter by default): a fake writer
 *     proves every write goes through the port, and a static source scan of
 *     `admit-pipeline.ts` proves the module contains no direct file-write
 *     API (mkdir scaffolding and chain-tip reads are the only fs access).
 *  4. Pipeline skeleton behavior: precheck rejection (no Receipt), broken
 *     category chain refusal (RUNTIME.RECEIPT_CHAIN_BROKEN), all-7-types
 *     pipeline runs mapping to the canonical receipt type/category, and
 *     `previous_digest` chain-tip linkage against a REAL fixture directory
 *     written through the kernel ReceiptWriter.
 *
 * Expected values below are known-good literals taken from the authority
 * excerpts (kernel §4/§5/§6/§7, AWI-006) — not derived from the
 * implementation under test.
 */
export {};
//# sourceMappingURL=admission.spec.d.ts.map