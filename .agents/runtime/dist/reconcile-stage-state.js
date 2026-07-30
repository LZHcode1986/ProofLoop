/**
 * reconcile-stage-state.ts
 *
 * Deterministic runtime tool that reads persisted facts from the filesystem
 * and returns a structured DeriveNextActionInput.  The Executor provides only
 * paths and optional overrides; this module does all the reading and interpretation.
 *
 * Flow:
 *   Executor provides paths
 *   → reconcile-stage-state reads facts (tasks, evidence, receipts, git)
 *   → deriveNextAction() outputs the single next action
 *   → Executor executes the action
 *
 * Accept-Reject boundary:
 *   All path resolution delegates to the shared canonical-artifact-path module
 *   which enforces symlink-free, trust-root-bounded paths.  No file is ever
 *   modified — pure read operations only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Manifest as ManifestSchema, CvReceipt as CvReceiptSchema, StageGateReceipt } from './schemas.js';
import { assertRegularFileBelowTrustedRoot } from './canonical-artifact-path.js';
import { computeCanonicalJsonDigest } from './canonical-digest.js';
// ── Git helpers ───────────────────────────────────────────────────────────────
/**
 * Return the current HEAD commit SHA from the git repository.
 * Returns null if git is unavailable or not in a repository.
 */
function getHeadSha() {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: process.cwd(),
            stdio: 'pipe',
            encoding: 'utf-8',
        }).trim();
    }
    catch {
        return null;
    }
}
/**
 * Check whether a commit exists and is an ancestor of HEAD.
 * Returns { exists, ancestor }.
 */
function hasCommitAncestor(commitSha) {
    if (!/^[a-f0-9]{40}$/i.test(commitSha))
        return { exists: false, ancestor: false };
    try {
        execFileSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], {
            cwd: process.cwd(),
            stdio: 'ignore',
        });
        execFileSync('git', ['merge-base', '--is-ancestor', commitSha, 'HEAD'], {
            cwd: process.cwd(),
            stdio: 'ignore',
        });
        return { exists: true, ancestor: true };
    }
    catch {
        try {
            execFileSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], {
                cwd: process.cwd(),
                stdio: 'ignore',
            });
            return { exists: true, ancestor: false };
        }
        catch {
            return { exists: false, ancestor: false };
        }
    }
}
// ── tasks.md parsing ──────────────────────────────────────────────────────────
/**
 * Parse a tasks.md file and extract checkbox states for the given slice's tasks.
 *
 * The tasks.md is structured as Markdown sections per slice, e.g.:
 *
 *   ## Slice S01-A — Title
 *   ...
 *   ### Tasks
 *   - [x] S01-A-T1: Some description
 *   - [ ] S01-A-T2: Another task
 *
 * Returns TaskCheckboxState[] in the order of the provided taskIds.
 */
export function parseTaskCheckboxes(tasksMd, _sliceId, taskIds) {
    // Build a lookup from task_id → checked status
    const checkedMap = new Map();
    // Match lines like: - [x] S01-A-T1: ... or - [ ] S01-A-T2: ...
    const checkboxRegex = /^- \[( |x|X)\] (\S+):/gm;
    let match;
    while ((match = checkboxRegex.exec(tasksMd)) !== null) {
        const isChecked = match[1] === 'x' || match[1] === 'X';
        const taskId = match[2];
        checkedMap.set(taskId, isChecked);
    }
    // Build result in the order of taskIds
    return taskIds.map(taskId => ({
        task_id: taskId,
        checked: checkedMap.get(taskId) ?? false,
        evidence_written: false, // filled in later from evidence file
    }));
}
// ── Slice Evidence parsing ────────────────────────────────────────────────────
/**
 * Find the `## Current CV Status` section in a Slice Evidence markdown and
 * extract structured information.
 */
export function parseCvStatusFromEvidence(evidencePath) {
    let content;
    try {
        content = fs.readFileSync(evidencePath, 'utf-8');
    }
    catch {
        return {
            cv_status: 'NOT_RUN',
            repair_attempt: 0,
            scope_check_passed: false,
            slice_evidence_finalized: false,
        };
    }
    // Default state
    const result = {
        cv_status: 'NOT_RUN',
        repair_attempt: 0,
        scope_check_passed: false,
        slice_evidence_finalized: false,
    };
    // ── Parse ## Current CV Status section ──
    // Use line-based parsing for robustness, similar to update-current-cv-status.ts
    const lines = content.split('\n');
    let cvHeadingIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '## Current CV Status') {
            cvHeadingIdx = i;
            break;
        }
    }
    if (cvHeadingIdx !== -1) {
        // Find end: next heading or end of file
        let cvEndIdx = lines.length;
        for (let i = cvHeadingIdx + 1; i < lines.length; i++) {
            if (/^##\s/.test(lines[i].trim())) {
                cvEndIdx = i;
                break;
            }
        }
        const sectionLines = lines.slice(cvHeadingIdx + 1, cvEndIdx);
        // Extract Status line
        let openFinding = '';
        for (const line of sectionLines) {
            const statusMatch = line.match(/^- Status:\s*(.+)$/);
            if (statusMatch) {
                result.cv_status = statusMatch[1].trim();
            }
            const findingMatch = line.match(/^- Open Finding:\s*(.+)$/);
            if (findingMatch) {
                openFinding = findingMatch[1].trim();
            }
        }
        // Scope check passed: Status is CV_PASS or PASS and no open findings
        if ((result.cv_status === 'CV_PASS' || result.cv_status === 'PASS') &&
            (openFinding === '' || openFinding === '*None*')) {
            result.scope_check_passed = true;
        }
        // Repair attempt count: if Status is REPAIR or CV_REPAIR_REQUIRED,
        // check open finding for attempt count.
        if (result.cv_status === 'REPAIR' || result.cv_status === 'CV_REPAIR_REQUIRED') {
            result.repair_attempt = 0;
            const attemptMatch = openFinding.match(/attempt\s*(\d+)/i);
            if (attemptMatch) {
                result.repair_attempt = parseInt(attemptMatch[1], 10);
            }
        }
    }
    // ── Check if slice evidence is finalized ──
    // Find the Proof Obligation Coverage section using line-based parsing
    let pocHeadingIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '### Proof Obligation Coverage') {
            pocHeadingIdx = i;
            break;
        }
    }
    if (pocHeadingIdx !== -1) {
        // Find end: next heading at any level or end of file
        let pocEndIdx = lines.length;
        for (let i = pocHeadingIdx + 1; i < lines.length; i++) {
            if (/^#{1,4}\s/.test(lines[i].trim())) {
                pocEndIdx = i;
                break;
            }
        }
        // Get table lines (those starting with |)
        const tableLines = lines.slice(pocHeadingIdx + 1, pocEndIdx).filter(l => l.trim().startsWith('|'));
        // Skip header (index 0) and separator (index 1); look for data rows
        const dataRows = tableLines.filter((_line, index) => {
            if (index === 0)
                return false; // header row
            if (index === 1 && /^[\s|:\-]+$/.test(_line.trim()))
                return false; // separator row
            return true;
        });
        // Check if any data row has actual content (not the *None* placeholder)
        result.slice_evidence_finalized = dataRows.some(row => {
            const trimmed = row.trim();
            // The skeleton placeholder row is: | *None* | | | | |
            if (/^\|\s*\*None\*\s*\|/.test(trimmed))
                return false;
            // Empty rows don't count either
            const cells = trimmed.split('|').filter(c => c.trim().length > 0);
            return cells.length >= 2;
        });
    }
    // ── Determine evidence_written per task ──
    // The helper has access to the full content but this function returns
    // aggregate info.  Per-task evidence_written is determined by
    // parseTaskEvidenceWritten below.
    return result;
}
/**
 * Check whether a specific task has evidence written in the Slice Evidence file.
 *
 * Tasks are written under ## Task Evidence as subsections like:
 *
 *   ### T1: Task Title
 *   ...
 *
 * The initial skeleton contains only the placeholder line:
 *   *No tasks have been executed yet.*
 *
 * Returns true if the task has a non-placeholder section.
 */
export function hasTaskEvidenceWritten(evidenceContent, taskId) {
    const lines = evidenceContent.split('\n');
    // Find the ## Task Evidence section
    let taskEvHeadingIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '## Task Evidence') {
            taskEvHeadingIdx = i;
            break;
        }
    }
    if (taskEvHeadingIdx === -1)
        return false;
    // Find end: next ## heading or end of file
    let taskEvEndIdx = lines.length;
    for (let i = taskEvHeadingIdx + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i].trim())) {
            taskEvEndIdx = i;
            break;
        }
    }
    // Get the section body lines
    const sectionLines = lines.slice(taskEvHeadingIdx + 1, taskEvEndIdx);
    // Check if the section contains only the placeholder
    const hasOnlyPlaceholder = sectionLines.every(l => l.trim() === '' || /^\*No tasks have been executed yet\.\*$/.test(l.trim()));
    if (hasOnlyPlaceholder)
        return false;
    // Look for a subsection heading for this task.
    // Task subsections are typically: ### <taskId>: <title>
    const taskSectionRegex = new RegExp(`^###\\s+${escapeRegex(taskId)}\\b`, 'm');
    return taskSectionRegex.test(sectionLines.join('\n'));
}
/**
 * Escape regex special characters in a string.
 */
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// ── CV Receipt reading ────────────────────────────────────────────────────────
/**
 * Find the latest (by timestamp) CV receipt for a given stage + slice.
 *
 * Scans the cvReceiptRoot / <stageId> / <sliceId> / directory for .json files,
 * parses each with the CvReceipt schema, and returns the one with the greatest
 * timestamp (lexical if ISO-8601, or file mtime as fallback).
 *
 * Returns null if no valid receipt is found.
 */
export function findLatestCvReceipt(cvReceiptRoot, stageId, sliceId) {
    const receiptDir = path.resolve(cvReceiptRoot, stageId, sliceId);
    let entries;
    try {
        entries = fs.readdirSync(receiptDir);
    }
    catch {
        return null;
    }
    const jsonFiles = entries.filter(e => e.toLowerCase().endsWith('.json')).sort();
    // Read all JSON files and parse with CvReceipt schema
    const receipts = [];
    for (const file of jsonFiles) {
        const filePath = path.join(receiptDir, file);
        try {
            // Only accept regular files (skip symlinks, dirs, etc.)
            const stat = fs.lstatSync(filePath);
            if (!stat.isFile() || stat.isSymbolicLink())
                continue;
            const content = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(content);
            const receipt = CvReceiptSchema.parse(parsed);
            receipts.push(receipt);
        }
        catch {
            // Skip invalid receipts
            continue;
        }
    }
    if (receipts.length === 0)
        return null;
    // Find the latest by timestamp (ISO-8601 string comparison works lexically)
    receipts.sort((a, b) => {
        const tA = a.timestamp ?? '';
        const tB = b.timestamp ?? '';
        if (tA < tB)
            return 1;
        if (tA > tB)
            return -1;
        return 0;
    });
    return receipts[0];
}
/**
 * Collect ALL CV receipts for a given stage + slice, ordered oldest to newest.
 */
export function collectAllCvReceipts(cvReceiptRoot, stageId, sliceId) {
    const receiptDir = path.resolve(cvReceiptRoot, stageId, sliceId);
    let entries;
    try {
        entries = fs.readdirSync(receiptDir);
    }
    catch {
        return [];
    }
    const jsonFiles = entries.filter(e => e.toLowerCase().endsWith('.json')).sort();
    const receipts = [];
    for (const file of jsonFiles) {
        const filePath = path.join(receiptDir, file);
        try {
            // Only accept regular files
            const stat = fs.lstatSync(filePath);
            if (!stat.isFile() || stat.isSymbolicLink())
                continue;
            const content = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(content);
            const receipt = CvReceiptSchema.parse(parsed);
            receipts.push(receipt);
        }
        catch {
            continue;
        }
    }
    // Sort oldest to newest
    receipts.sort((a, b) => {
        const tA = a.timestamp ?? '';
        const tB = b.timestamp ?? '';
        if (tA < tB)
            return -1;
        if (tA > tB)
            return 1;
        return 0;
    });
    return receipts;
}
// ── Integration status ────────────────────────────────────────────────────────
/**
 * Check if a slice has a persisted integration receipt with status 'integrated'.
 *
 * Integration receipts are stored at:
 *   <integrationRoot>/<stageId>/<sliceId>/<filename>.json
 *
 * The receipt JSON must be parseable, must contain stage_id, slice_id, commit_sha
 * matching the expected values, and must have status === 'integrated'.
 */
export function checkSliceIntegrated(integrationRoot, stageId, sliceId, _commitSha) {
    const integrationDir = path.resolve(integrationRoot, stageId, sliceId);
    let entries;
    try {
        entries = fs.readdirSync(integrationDir);
    }
    catch {
        return false;
    }
    const jsonFiles = entries.filter(e => e.toLowerCase().endsWith('.json'));
    for (const file of jsonFiles) {
        const filePath = path.join(integrationDir, file);
        try {
            // Only accept regular files
            const stat = fs.lstatSync(filePath);
            if (!stat.isFile() || stat.isSymbolicLink())
                continue;
            const content = fs.readFileSync(filePath, 'utf-8').trim();
            if (!content)
                continue;
            const parsed = JSON.parse(content);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                continue;
            const record = parsed;
            if (record.stage_id !== stageId || record.slice_id !== sliceId)
                continue;
            if (_commitSha && record.commit_sha !== _commitSha)
                continue;
            if (record.status === 'integrated')
                return true;
        }
        catch {
            continue;
        }
    }
    return false;
}
// ── Stage Gate receipt reading ────────────────────────────────────────────────
/**
 * Read and parse a Stage Gate receipt from disk.
 * Returns null if the file doesn't exist, can't be parsed, or fails schema validation.
 */
export function readStageGateReceipt(receiptPath) {
    try {
        const resolvedPath = path.resolve(receiptPath);
        // Delegate file-validity checks to the caller (assertRegularFileBelowTrustedRoot).
        // Here we only need to read and parse — lstat-based symlink rejection is
        // redundant and can reject valid regular files on platforms where the path
        // traverses above a trusted-root system alias (e.g. macOS /tmp -> /private/tmp).
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const parsed = JSON.parse(content);
        return StageGateReceipt.parse(parsed);
    }
    catch {
        return null;
    }
}
// ── Main reconciliation function ──────────────────────────────────────────────
/**
 * Reconcile persisted state from the filesystem into a DeriveNextActionInput.
 *
 * This is the deterministic bridge between persisted facts (manifest, tasks.md,
 * evidence files, receipts, git) and the deriveNextAction state machine.
 *
 * @param input - Paths and identifiers for the reconciliation.
 * @returns A fully populated DeriveNextActionInput ready for deriveNextAction().
 * @throws If required files cannot be read or parsed, or if manifest validation fails.
 */
export function reconcileStageState(input) {
    const { stage_id, manifest_path, tasks_path, cv_receipt_root = path.resolve(process.cwd(), '.proofloop', 'receipts', 'cv'), integration_receipt_root = path.resolve(process.cwd(), '.proofloop', 'receipts', 'integration'), stage_gate_receipt_path, delivery_root = process.cwd(), } = input;
    // ── 1. Read and validate Manifest ──
    let manifest;
    let manifestData;
    try {
        const resolvedManifestPath = assertRegularFileBelowTrustedRoot(path.resolve(manifest_path), delivery_root);
        if (!resolvedManifestPath) {
            throw new Error(`Manifest path "${manifest_path}" does not resolve to a regular file within the delivery root.`);
        }
        const content = fs.readFileSync(resolvedManifestPath, 'utf-8');
        manifestData = JSON.parse(content);
        manifest = ManifestSchema.parse(manifestData);
    }
    catch (err) {
        throw new Error(`Failed to read/parse manifest at "${manifest_path}": ${err instanceof Error ? err.message : String(err)}`);
    }
    // Validate stage_id matches
    if (manifest.stage_id !== stage_id) {
        throw new Error(`Manifest stage_id "${manifest.stage_id}" does not match input stage_id "${stage_id}".`);
    }
    const manifestDigest = computeCanonicalJsonDigest(ManifestSchema, manifestData);
    // ── 2. Read tasks.md and parse checkbox states ──
    let tasksMd;
    try {
        const resolvedTasksPath = assertRegularFileBelowTrustedRoot(path.resolve(tasks_path), delivery_root);
        if (!resolvedTasksPath) {
            throw new Error(`Tasks path "${tasks_path}" does not resolve to a regular file within the delivery root.`);
        }
        tasksMd = fs.readFileSync(resolvedTasksPath, 'utf-8');
    }
    catch (err) {
        throw new Error(`Failed to read tasks.md at "${tasks_path}": ${err instanceof Error ? err.message : String(err)}`);
    }
    // ── 3. Read evidence files and CV receipts per slice ──
    const allCvReceipts = [];
    const slices = [];
    for (const sliceDef of manifest.slices) {
        const { slice_id, dependencies = [], tasks: taskIds = [], evidence_path } = sliceDef;
        // ── Parse task checkboxes from tasks.md ──
        const taskCheckboxes = parseTaskCheckboxes(tasksMd, slice_id, taskIds);
        // ── Read slice evidence file ──
        // Evidence path from manifest is relative to delivery_root
        const evidenceFullPath = path.resolve(delivery_root, evidence_path);
        let evidenceContent = null;
        try {
            const resolvedEvPath = assertRegularFileBelowTrustedRoot(evidenceFullPath, delivery_root);
            if (resolvedEvPath) {
                evidenceContent = fs.readFileSync(resolvedEvPath, 'utf-8');
            }
        }
        catch {
            evidenceContent = null;
        }
        // Parse CV status from evidence
        let evCvStatus = 'NOT_RUN';
        let evRepairAttempt = 0;
        let evScopeCheckPassed = false;
        let evSliceEvidenceFinalized = false;
        if (evidenceContent !== null) {
            const evStatus = parseCvStatusFromEvidence(evidenceFullPath);
            evCvStatus = evStatus.cv_status;
            evRepairAttempt = evStatus.repair_attempt;
            evScopeCheckPassed = evStatus.scope_check_passed;
            evSliceEvidenceFinalized = evStatus.slice_evidence_finalized;
            // Update per-task evidence_written
            for (const tcb of taskCheckboxes) {
                tcb.evidence_written = hasTaskEvidenceWritten(evidenceContent, tcb.task_id);
            }
        }
        // ── Read CV receipts ──
        const latestReceipt = findLatestCvReceipt(cv_receipt_root, stage_id, slice_id);
        const sliceReceipts = collectAllCvReceipts(cv_receipt_root, stage_id, slice_id);
        allCvReceipts.push(...sliceReceipts);
        // If there's a latest receipt, update repair_attempt from receipt history
        // (receipt count is more accurate than the evidence file's Open Finding text).
        let repairAttempt = evRepairAttempt;
        if (sliceReceipts.length > 0) {
            const repairReceiptCount = sliceReceipts.filter(r => r.verdict === 'REPAIR').length;
            // repair_attempt in the state machine is 0-based: how many repairs have been attempted.
            // Repair count-1 gives us the next attempt index.
            repairAttempt = Math.max(0, repairReceiptCount - 1);
        }
        // ── Check git commit status ──
        // A slice is considered "committed" if there's a CV PASS receipt whose
        // snapshot content has been committed.  We check this by looking for any
        // commit that references the slice evidence file.
        let committed = false;
        if (latestReceipt && latestReceipt.verdict === 'PASS') {
            // Try to find the slice evidence commit in git log
            try {
                const evidenceRelPath = path.relative(process.cwd(), evidenceFullPath);
                // Check if the evidence file has been committed (is tracked by git and has no uncommitted changes)
                const gitStatus = execFileSync('git', ['status', '--porcelain', evidenceRelPath], {
                    cwd: process.cwd(),
                    stdio: 'pipe',
                    encoding: 'utf-8',
                }).trim();
                // If status is empty, the file has no uncommitted changes
                if (gitStatus.length === 0) {
                    // Check that the file is actually tracked (not just clean but untracked)
                    const tracked = execFileSync('git', ['ls-files', '--cached', evidenceRelPath], {
                        cwd: process.cwd(),
                        stdio: 'pipe',
                        encoding: 'utf-8',
                    }).trim();
                    if (tracked.length > 0) {
                        committed = true;
                    }
                }
            }
            catch {
                committed = false;
            }
        }
        // ── Check integration status ──
        const integrated = checkSliceIntegrated(integration_receipt_root, stage_id, slice_id);
        // ── Determine if all dependencies are complete ──
        // (this is computed later in deriveNextAction, but we mark complete here)
        const complete = committed && integrated;
        slices.push({
            slice_id,
            dependencies,
            tasks: taskCheckboxes,
            slice_evidence_finalized: evSliceEvidenceFinalized,
            cv_status: evCvStatus,
            repair_attempt: repairAttempt,
            scope_check_passed: evScopeCheckPassed,
            latest_cv_receipt: latestReceipt ?? null,
            committed,
            integrated,
            complete,
        });
    }
    // ── 4. Read Stage Gate receipt ──
    let stageGateState = {};
    if (stage_gate_receipt_path) {
        const receipt = readStageGateReceipt(stage_gate_receipt_path);
        if (receipt) {
            stageGateState = {
                receipt,
                receipt_path: path.resolve(stage_gate_receipt_path),
                gate_run: true,
                gate_passed: receipt.verdict === 'PASS',
            };
        }
    }
    // ── 5. Check git state at stage level ──
    let stageCommitted = false;
    let stageIntegrated = false;
    try {
        // Check if tasks.md is committed
        const tasksRelPath = path.relative(process.cwd(), path.resolve(tasks_path));
        const tasksStatus = execFileSync('git', ['status', '--porcelain', tasksRelPath], {
            cwd: process.cwd(),
            stdio: 'pipe',
            encoding: 'utf-8',
        }).trim();
        if (tasksStatus.length === 0) {
            const tracked = execFileSync('git', ['ls-files', '--cached', tasksRelPath], {
                cwd: process.cwd(),
                stdio: 'pipe',
                encoding: 'utf-8',
            }).trim();
            if (tracked.length > 0) {
                stageCommitted = true;
            }
        }
    }
    catch {
        stageCommitted = false;
    }
    // Stage is integrated when all slices are integrated
    stageIntegrated = slices.length > 0 && slices.every(s => s.integrated);
    // ── 6. Build DeriveNextActionInput ──
    const result = {
        stage_id,
        manifest: {
            stage_id: manifest.stage_id,
            source_digest: manifest.source_digest,
            slices: manifest.slices,
        },
        manifest_digest: manifestDigest,
        cv_receipts: allCvReceipts,
        stage_gate: stageGateState,
        slices,
        stage_committed: stageCommitted,
        stage_integrated: stageIntegrated,
    };
    return result;
}
// ── CLI entry point ───────────────────────────────────────────────────────────
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
        const base = path.basename(scriptPath);
        return base === 'reconcile-stage-state.js' || base === 'reconcile-stage-state.ts';
    }
}
if (isScriptEntry()) {
    const inputPath = process.argv[2];
    if (!inputPath) {
        console.error('Usage: node dist/reconcile-stage-state.js <input.json>');
        console.error('');
        console.error('Reads a JSON input file conforming to ReconcileStageStateInput');
        console.error('and outputs a DeriveNextActionInput JSON to stdout.');
        process.exit(1);
    }
    let input;
    try {
        const raw = fs.readFileSync(inputPath, 'utf-8');
        const parsed = JSON.parse(raw);
        // Minimal validation
        if (typeof parsed.stage_id !== 'string' || typeof parsed.manifest_path !== 'string' || typeof parsed.tasks_path !== 'string') {
            throw new Error('Input must contain stage_id (string), manifest_path (string), and tasks_path (string).');
        }
        input = parsed;
    }
    catch (err) {
        console.error(`Error reading input: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    try {
        const result = reconcileStageState(input);
        console.log(JSON.stringify(result, null, 2));
    }
    catch (err) {
        console.error(`Error reconciling stage state: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
//# sourceMappingURL=reconcile-stage-state.js.map