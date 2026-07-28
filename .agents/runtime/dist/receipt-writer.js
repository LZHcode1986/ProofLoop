import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StageGateReceipt, StageReviewReceiptSchema, ProjectE2EReceiptSchema, WriteProjectReviewReceiptOptionsSchema, } from './schemas.js';
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
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    const safeStageId = parsed.stage_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `stage-gate-${safeStageId}.json`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
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
export function writeProjectReviewReceipt(outputDir, data) {
    // Schema validation — fail-closed even if caller bypasses CLI
    const parsed = WriteProjectReviewReceiptOptionsSchema.parse(data);
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, 'project-review.json');
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    return path.resolve(filePath);
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
 *   `node dist/receipt-writer.js project-review <json-input>`
 *
 * Parses the JSON input and calls the appropriate receipt writer, outputting
 * the resulting receipt path as JSON to stdout.
 */
if (isScriptEntry()) {
    const mode = process.argv[2]; // 'stage-review' or 'project-review'
    const input = JSON.parse(process.argv[3]);
    if (mode === 'stage-review') {
        const result = writeStageReviewReceipt(input.outputDir, input.data);
        console.log(JSON.stringify(result));
    }
    else if (mode === 'project-review') {
        const result = writeProjectReviewReceipt(input.outputDir, input.data);
        console.log(JSON.stringify(result));
    }
    else {
        console.error('Usage: node receipt-writer.js <stage-review|project-review> <json-input>');
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
        // Validate against StageGateReceipt schema
        StageGateReceipt.parse(parsed);
        return { valid: true };
    }
    catch (err) {
        return { valid: false, error: `Receipt validation error: ${err}` };
    }
}
//# sourceMappingURL=receipt-writer.js.map