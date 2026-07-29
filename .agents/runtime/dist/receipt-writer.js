import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StageGateReceipt, isValidStageGatePassReceipt, StageReviewReceiptSchema, ProjectE2EReceiptSchema, WriteProjectReviewReceiptOptionsSchema, CvReceipt, } from './schemas.js';
// ── Snapshot computation ───────────────────────────────────────────────────────
/**
 * Compute a content-aware snapshot identifier for a directory tree.
 *
 * Walks files (skipping .git, node_modules and hidden dirs), hashing
 * relative paths + file contents into a SHA-256 digest, returning the
 * first 16 hex characters as a short identifier.
 */
export function computeSnapshot(dir) {
    const entries = [];
    function walk(dirPath) {
        let items;
        try {
            items = fs.readdirSync(dirPath, { withFileTypes: true });
        }
        catch {
            return; // skip unreadable directories
        }
        // Sort for deterministic ordering
        items.sort((a, b) => a.name.localeCompare(b.name));
        for (const item of items) {
            const fullPath = path.join(dirPath, item.name);
            if (item.isDirectory()) {
                // Skip hidden directories, node_modules, and .git
                if (item.name.startsWith('.') || item.name === 'node_modules')
                    continue;
                walk(fullPath);
            }
            else if (item.isFile()) {
                entries.push(fullPath);
            }
        }
    }
    walk(dir);
    // Hash relative paths + content
    const hash = crypto.createHash('sha256');
    const baseLength = path.resolve(dir).length;
    for (const file of entries.sort()) {
        let content;
        try {
            content = fs.readFileSync(file);
        }
        catch {
            continue; // skip unreadable files
        }
        const relativePath = file.slice(baseLength).replace(/\\/g, '/');
        hash.update(relativePath);
        hash.update(content);
    }
    return hash.digest('hex').slice(0, 16);
}
// ── Gate Receipt writer ────────────────────────────────────────────────────────
/**
 * Write a structured JSON Stage Gate receipt to disk.
 *
 * Validates data against StageGateReceipt schema before writing.
 * Output file name: `stage-gate-{stage_id}.json`
 *
 * Returns the absolute path of the written receipt file.
 */
export function writeGateReceipt(outputDir, data) {
    // Schema validation — fail-closed even if caller bypasses CLI
    const parsed = StageGateReceipt.parse(data);
    if (parsed.verdict === 'PASS' && !isValidStageGatePassReceipt(parsed, parsed.stage_id, parsed.manifest_digest)) {
        throw new Error('Invalid Stage Gate PASS receipt: Slice COMPLETE facts, successful proof steps, and cleanup facts are required.');
    }
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    const safeStageId = parsed.stage_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `stage-gate-${safeStageId}.json`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    return path.resolve(filePath);
}
/** Canonical immutable Stage Gate receipt writer. */
export function writeStageGateReceipt(data, receiptRoot = path.join(process.cwd(), '.proofloop', 'receipts', 'stage-gate')) {
    const parsed = StageGateReceipt.parse(data);
    if (!isValidStageGatePassReceipt(parsed, parsed.stage_id, parsed.manifest_digest)) {
        throw new Error('Invalid Stage Gate PASS receipt: it must prove every executed step and include completed_slice_ids.');
    }
    fs.mkdirSync(receiptRoot, { recursive: true });
    const filePath = path.join(receiptRoot, `${parsed.stage_id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), { encoding: 'utf-8', flag: 'wx' });
    return path.resolve(filePath);
}
// ── Stage Review Receipt ────────────────────────────────────────────────────────
/**
 * Write a structured JSON Stage Review Receipt to disk.
 *
 * Validates data against StageReviewReceiptSchema before writing.
 * Output file name: `stage-review-{stage_id}.json`
 *
 * Returns the absolute path of the written receipt file.
 */
export function writeStageReviewReceipt(outputDir, data) {
    // Schema validation — fail-closed even if caller bypasses CLI
    const parsed = StageReviewReceiptSchema.parse(data);
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    const safeStageId = parsed.stage_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `stage-review-${safeStageId}.json`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    return path.resolve(filePath);
}
// ── Project E2E Receipt ────────────────────────────────────────────────────────
/**
 * Write a structured JSON Project E2E Receipt to disk.
 *
 * Validates data against ProjectE2EReceiptSchema before writing.
 * Output file name: `project-e2e-{project_id}.json`
 *
 * Returns the absolute path of the written receipt file.
 */
export function writeProjectE2EReceipt(outputDir, data) {
    // Schema validation — fail-closed even if caller bypasses CLI
    const parsed = ProjectE2EReceiptSchema.parse(data);
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    const fileName = `project-e2e-${parsed.project_id}.json`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    return path.resolve(filePath);
}
// ── Project Review Receipt ──────────────────────────────────────────────────────
/**
 * Write a structured JSON Project Review Receipt to disk.
 *
 * Validates data against WriteProjectReviewReceiptOptionsSchema before writing.
 * Output file name: `project-review.json`
 *
 * Returns the absolute path of the written receipt file.
 */
export function internalWriteProjectReviewReceipt(outputDir, data) {
    // Schema validation — fail-closed even if caller bypasses CLI
    const parsed = WriteProjectReviewReceiptOptionsSchema.parse(data);
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, 'project-review.json');
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    return path.resolve(filePath);
}
// ── CV Receipt writer ──────────────────────────────────────────────────────────
/**
 * The root directory for all CV receipts: `.proofloop/receipts/cv/`
 * Resolved relative to `process.cwd()` when not overridden.
 */
export function getDefaultCvReceiptRoot() {
    return path.join(process.cwd(), '.proofloop', 'receipts', 'cv');
}
/**
 * Write a CV Receipt to disk at `.proofloop/receipts/cv/<stage-id>/<slice-id>/`.
 *
 * The filename follows the pattern `{initial|recheck}-NNN.json` where NNN is
 * the next available sequence number **globally across all receipt files** for
 * that slice (not per-prefix). The file is never overwritten — each call
 * produces a strictly increasing number.
 *
 * Write uses exclusive-create (`wx` flag) to prevent races. If the target
 * file already exists (concurrent write), the function retries with the next
 * sequence number up to a limited number of attempts.
 *
 * @param data            The CV receipt data (validated against CvReceipt schema).
 * @param receiptRoot     Override the receipt root directory. Defaults to
 *                        `.proofloop/receipts/cv/` under cwd().
 * @returns The absolute path of the written receipt file.
 */
export function writeCvReceipt(data, receiptRoot) {
    // Schema validation — fail-closed
    const parsed = CvReceipt.parse(data);
    const root = receiptRoot ?? getDefaultCvReceiptRoot();
    // Build path: <root>/<stage-id>/<slice-id>/
    const safeStageId = parsed.stage_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeSliceId = parsed.slice_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const receiptDir = path.join(root, safeStageId, safeSliceId);
    // Ensure directory exists
    fs.mkdirSync(receiptDir, { recursive: true });
    // ── Determine next global sequence number across all receipt files ──
    // Scan all {initial|recheck}-NNN.json in this slice directory
    const RECEIPT_FILE_RE = /^(initial|recheck)-(\d{3})\.json$/;
    const allReceiptFiles = fs.readdirSync(receiptDir)
        .filter(f => RECEIPT_FILE_RE.test(f))
        .sort();
    let globalMaxSeq = 0;
    for (const f of allReceiptFiles) {
        const m = f.match(RECEIPT_FILE_RE);
        if (m) {
            const seq = parseInt(m[2], 10);
            if (seq > globalMaxSeq)
                globalMaxSeq = seq;
        }
    }
    const prefix = parsed.verification_type ?? 'initial';
    const jsonContent = JSON.stringify(parsed, null, 2);
    // ── Attempt write with exclusive-create and retry ──
    const MAX_RETRIES = 5;
    let candidateSeq = globalMaxSeq;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        candidateSeq++;
        const seqStr = String(candidateSeq).padStart(3, '0');
        const fileName = `${prefix}-${seqStr}.json`;
        const filePath = path.join(receiptDir, fileName);
        try {
            fs.writeFileSync(filePath, jsonContent, { encoding: 'utf-8', flag: 'wx' });
            return path.resolve(filePath);
        }
        catch (err) {
            // EEXIST / EACCES — file was created between our scan and write
            if (isFileExistsError(err)) {
                // Re-read the directory to detect concurrent writes
                const updatedFiles = fs.readdirSync(receiptDir)
                    .filter(f => RECEIPT_FILE_RE.test(f));
                for (const uf of updatedFiles) {
                    const um = uf.match(RECEIPT_FILE_RE);
                    if (um) {
                        const seq = parseInt(um[2], 10);
                        if (seq > globalMaxSeq)
                            globalMaxSeq = seq;
                    }
                }
                candidateSeq = globalMaxSeq;
                continue; // retry
            }
            // Re-throw other errors (e.g. permission denied, disk full)
            throw err;
        }
    }
    // Exhausted retries — throw
    throw new Error(`Cannot write CV receipt after ${MAX_RETRIES} attempts. ` +
        `Directory "${receiptDir}" is being contended.`);
}
/**
 * Check whether a thrown error indicates the file already exists.
 */
function isFileExistsError(err) {
    if (err && typeof err === 'object' && 'code' in err) {
        const code = err.code;
        return code === 'EEXIST' || code === 'EACCES';
    }
    return false;
}
// ── CLI entry point ─────────────────────────────────────────────────────────────
/**
 * Determine whether this module is being run as a script (CLI entry point).
 *
 * Compares the resolved file path against the current module URL to handle
 * cross-platform differences (Windows backslashes vs forward slashes).
 */
function isScriptEntry() {
    const scriptPath = process.argv[1];
    if (!scriptPath)
        return false;
    try {
        const resolved = path.resolve(scriptPath);
        const currentFile = fileURLToPath(import.meta.url);
        return resolved === currentFile;
    }
    catch {
        // Fallback: check basename
        const base = path.basename(scriptPath);
        return base === 'receipt-writer.js' || base === 'receipt-writer.ts';
    }
}
/**
 * CLI usage:
 *   `node dist/receipt-writer.js stage-review <json-input>`
 *
 * Parses the JSON input and calls the appropriate receipt writer, outputting
 * the resulting receipt path as JSON to stdout.
 *
 * Note: project-review mode is deliberately NOT exposed via CLI.
 * Use finalize-project-review.ts instead.
 */
if (isScriptEntry()) {
    const mode = process.argv[2];
    const input = JSON.parse(process.argv[3]);
    if (mode === 'stage-review') {
        const result = writeStageReviewReceipt(input.outputDir, input.data);
        console.log(JSON.stringify(result));
    }
    else if (mode === 'stage-gate') {
        const result = writeStageGateReceipt(input.data, input.receiptRoot);
        console.log(JSON.stringify(result));
    }
    else if (mode === 'cv') {
        const result = writeCvReceipt(input.data, input.receiptRoot);
        console.log(JSON.stringify(result));
    }
    else {
        console.error('Usage: node receipt-writer.js stage-review <json-input>');
        console.error('       node receipt-writer.js stage-gate <json-input>');
        console.error('       node receipt-writer.js cv <json-input>');
        process.exit(1);
    }
}
/**
 * Validate a Gate receipt file against the StageGateReceipt schema.
 */
export function validateReceipt(receiptPath) {
    try {
        if (!fs.existsSync(receiptPath)) {
            return { valid: false, error: `Receipt file not found: ${receiptPath}` };
        }
        const content = fs.readFileSync(receiptPath, 'utf-8');
        const parsed = JSON.parse(content);
        // Validate against the schema and the stronger PASS invariants.  FAIL and
        // BLOCKED receipts remain useful diagnostics; only PASS can authorize a
        // stage transition.
        const validated = StageGateReceipt.parse(parsed);
        if (validated.verdict === 'PASS' &&
            !isValidStageGatePassReceipt(validated, validated.stage_id, validated.manifest_digest)) {
            return { valid: false, error: 'Stage Gate PASS receipt does not contain complete proof facts.' };
        }
        return { valid: true };
    }
    catch (err) {
        return { valid: false, error: `Receipt validation error: ${err}` };
    }
}
/**
 * Read and parse a CV receipt from disk.
 */
export function readCvReceipt(receiptPath) {
    const content = fs.readFileSync(receiptPath, 'utf-8');
    const parsed = JSON.parse(content);
    return CvReceipt.parse(parsed);
}
//# sourceMappingURL=receipt-writer.js.map