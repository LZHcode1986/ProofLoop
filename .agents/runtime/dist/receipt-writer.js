import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getPlatformInfo } from './platform-adapter.js';
import { WriteProjectReviewReceiptOptionsSchema } from './schemas.js';
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
// ── Receipt writer ─────────────────────────────────────────────────────────────
/**
 * Write a structured JSON Stage Gate receipt to disk.
 *
 * Receipt schema matches `.agents/runtime/src/schemas.ts StageGateReceipt`
 * but with extended runtime detail.
 *
 * Returns the absolute path of the written receipt file.
 */
export function writeReceipt(options) {
    const { outputDir, data } = options;
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    // Build the complete receipt
    const receipt = {
        stage_id: data.stage_id,
        snapshot: data.snapshot,
        platform: data.platform,
        tool_versions: {
            node: process.version,
            platform: getPlatformInfo().platform,
            ...data.tool_versions,
        },
        steps: data.steps,
        exit_code: data.exit_code,
        observations: data.observations,
        verdict: data.verdict,
        timestamps: {
            started_at: data.timestamps.started_at,
            completed_at: data.timestamps.completed_at ?? new Date().toISOString(),
        },
    };
    // Include cleanup info if provided
    if (data.cleanup) {
        receipt.cleanup = data.cleanup;
    }
    // Include service cleanup details if provided
    if (data.service_cleanup) {
        receipt.service_cleanup = data.service_cleanup;
    }
    // Write to file
    const safeStageId = data.stage_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `stage-gate-receipt-${safeStageId}-${Date.now()}.json`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(receipt, null, 2), 'utf-8');
    return path.resolve(filePath);
}
/**
 * Write a structured JSON Stage Review Receipt to disk.
 *
 * Returns the absolute path of the written receipt file.
 */
export function writeStageReviewReceipt(options) {
    const { outputDir, data } = options;
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    const receipt = {
        stage_id: data.stage_id,
        verdict: data.verdict,
        finding_id: data.finding_id,
        route_code: data.route_code,
        subtype: data.subtype,
        affected_outcomes: data.affected_outcomes,
        affected_artifacts: data.affected_artifacts,
        evidence: data.evidence,
        reason: data.reason,
        reviewed_at: data.reviewed_at ?? new Date().toISOString(),
        reviewer: data.reviewer ?? 'stage-reviewer',
    };
    const safeStageId = data.stage_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `stage-review-receipt-${safeStageId}.json`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(receipt, null, 2), 'utf-8');
    return path.resolve(filePath);
}
/**
 * Write a structured JSON Project E2E Receipt to disk.
 *
 * Returns the absolute path of the written receipt file.
 */
export function writeProjectE2EReceipt(options) {
    const { outputDir, data } = options;
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    const receipt = {
        project_id: data.project_id,
        verdict: data.verdict,
        snapshot: data.snapshot,
        manifest_digest: data.manifest_digest,
        source_snapshot: data.source_snapshot,
        expected_snapshot: data.expected_snapshot,
        executed_snapshot: data.executed_snapshot,
        steps: data.steps,
        service_cleanup: data.service_cleanup,
        created_at: data.created_at ?? new Date().toISOString(),
    };
    const filePath = path.join(outputDir, `project-e2e-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(receipt, null, 2), 'utf-8');
    return path.resolve(filePath);
}
/**
 * Write a structured JSON Project Review Receipt to disk.
 *
 * Returns the absolute path of the written receipt file.
 */
export function writeProjectReviewReceipt(options) {
    const { outputDir, data } = options;
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    const receipt = {
        project_id: data.project_id,
        verdict: data.verdict,
        findings: data.findings,
        snapshot: data.snapshot,
        reviewed_at: data.reviewed_at ?? new Date().toISOString(),
        reviewer: data.reviewer ?? 'brain',
        project_manifest: data.project_manifest,
        project_e2e_receipt: data.project_e2e_receipt,
        stage_review_receipts: data.stage_review_receipts,
        stage_gate_receipts: data.stage_gate_receipts,
        accepted_deviations: data.accepted_deviations,
        criteria_results: data.criteria_results,
    };
    const filePath = path.join(outputDir, 'project-review.json');
    fs.writeFileSync(filePath, JSON.stringify(receipt, null, 2), 'utf-8');
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
        const result = writeStageReviewReceipt(input);
        console.log(JSON.stringify(result));
    }
    else if (mode === 'project-review') {
        const parsedData = WriteProjectReviewReceiptOptionsSchema.parse(input.data);
        const result = writeProjectReviewReceipt({
            outputDir: input.outputDir,
            data: parsedData,
        });
        console.log(JSON.stringify(result));
    }
    else {
        console.error('Usage: node receipt-writer.js <stage-review|project-review> <json-input>');
        process.exit(1);
    }
}
export function validateReceipt(receiptPath) {
    try {
        if (!fs.existsSync(receiptPath)) {
            return { valid: false, error: `Receipt file not found: ${receiptPath}` };
        }
        const content = fs.readFileSync(receiptPath, 'utf-8');
        const parsed = JSON.parse(content);
        // Required top-level fields
        const requiredFields = ['stage_id', 'snapshot', 'platform', 'steps', 'verdict', 'timestamps'];
        for (const field of requiredFields) {
            if (!(field in parsed)) {
                return { valid: false, error: `Receipt missing required field: ${field}` };
            }
        }
        // Verdict must be valid
        if (!['PASS', 'FAIL', 'BLOCKED'].includes(parsed.verdict)) {
            return { valid: false, error: `Receipt has invalid verdict: ${parsed.verdict}` };
        }
        // Steps must be an array
        if (!Array.isArray(parsed.steps)) {
            return { valid: false, error: 'Receipt steps must be an array' };
        }
        return { valid: true };
    }
    catch (err) {
        return { valid: false, error: `Receipt validation error: ${err}` };
    }
}
//# sourceMappingURL=receipt-writer.js.map