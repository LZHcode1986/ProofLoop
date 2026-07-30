/**
 * prepare-stage-gate-facts.ts
 *
 * Automatically generates the Slice COMPLETE Facts JSON for a Stage Gate
 * from reconciled stage state.  This replaces manual fact assembly by the
 * Executor with a deterministic runtime procedure.
 *
 * Flow:
 *   Executor provides a ReconcileStageStateInput path-only JSON
 *   → prepareStageGateFacts reads, reconciles, validates, and writes facts
 *   → run-stage consumes the facts file for Stage Gate execution
 *
 * Output:
 *   <projectRoot>/.proofloop/runtime/<stageId>/slice-complete-facts.json
 *
 * Atomic write guarantees:
 *   - Write to a temporary file (<outputPath>.tmp.<pid>)
 *   - fsync the file descriptor
 *   - Rename (atomic on POSIX, near-atomic on Windows NTFS)
 *   - No partial reads by concurrent consumers
 */
import fs from 'node:fs';
import path from 'node:path';
import { reconcileStageState } from './reconcile-stage-state.js';
/**
 * Prepare Slice COMPLETE Facts from reconciled stage state.
 *
 * Reads all persisted receipts (CV, Committer, Integration) via
 * reconcileStageState and verifies that every slice is complete with
 * valid slice_complete_facts before writing.
 *
 * @param input - Path-only ReconcileStageStateInput (stage_id, project_root,
 *                manifest_path, tasks_path, optional stage_gate_receipt_path).
 * @returns The absolute path to the written slice-complete-facts.json file.
 * @throws Error if any slice is not complete or lacks slice_complete_facts.
 */
export function prepareStageGateFacts(input) {
    const state = reconcileStageState(input);
    // Validate: every slice must be complete and have slice_complete_facts
    const incompleteSlices = state.slices.filter(s => !s.complete);
    const slicesWithoutFacts = state.slices.filter(s => s.complete && !s.slice_complete_facts);
    if (incompleteSlices.length > 0) {
        throw new Error(`Cannot prepare Stage Gate facts: not every slice is complete. ` +
            `Incomplete slices: ${incompleteSlices.map(s => s.slice_id).join(', ')}`);
    }
    if (slicesWithoutFacts.length > 0) {
        throw new Error(`Cannot prepare Stage Gate facts: complete slices missing slice_complete_facts. ` +
            `Affected slices: ${slicesWithoutFacts.map(s => s.slice_id).join(', ')}`);
    }
    // Collect facts from all slices
    const facts = state.slices.map(s => s.slice_complete_facts);
    // Write to deterministic output path
    const projectRoot = path.resolve(input.project_root);
    const outputDir = path.join(projectRoot, '.proofloop', 'runtime', input.stage_id);
    const outputPath = path.join(outputDir, 'slice-complete-facts.json');
    fs.mkdirSync(outputDir, { recursive: true });
    // Atomic write: temp file + fsync + rename
    const tmpPath = outputPath + '.tmp.' + process.pid;
    const tmpFd = fs.openSync(tmpPath, 'wx');
    try {
        fs.writeFileSync(tmpFd, JSON.stringify(facts, null, 2), 'utf-8');
        fs.fsyncSync(tmpFd);
    }
    finally {
        fs.closeSync(tmpFd);
    }
    fs.renameSync(tmpPath, outputPath);
    return outputPath;
}
// ── CLI entry point ───────────────────────────────────────────────────────────
const scriptPath = process.argv[1];
if (scriptPath && (scriptPath.endsWith('prepare-stage-gate-facts.js') || scriptPath.endsWith('prepare-stage-gate-facts.ts'))) {
    const inputPath = process.argv[2];
    if (!inputPath) {
        console.error('Usage: node dist/prepare-stage-gate-facts.js <reconcile-input.json>');
        console.error('');
        console.error('Reads a ReconcileStageStateInput JSON file and writes');
        console.error('slice-complete-facts.json to .proofloop/runtime/<stageId>/.');
        console.error('');
        console.error('Outputs JSON: { "success": true, "path": "<output-path>" }');
        process.exit(1);
    }
    try {
        const raw = fs.readFileSync(inputPath, 'utf-8');
        const input = JSON.parse(raw);
        const outputPath = prepareStageGateFacts(input);
        console.log(JSON.stringify({ success: true, path: outputPath }));
    }
    catch (err) {
        console.error(JSON.stringify({ success: false, error: String(err) }));
        process.exit(1);
    }
}
//# sourceMappingURL=prepare-stage-gate-facts.js.map