import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getPlatformInfo } from './platform-adapter.js';
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