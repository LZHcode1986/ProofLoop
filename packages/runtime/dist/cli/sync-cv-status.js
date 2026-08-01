"use strict";
/**
 * sync-cv-status — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Reconcile → derive the current CV status of a slice (READ-ONLY — the CLI
 * never writes the evidence file; the Executor is the sole writer of
 * `## Current CV Status`). Legacy-compatible argument shape (file path or
 * inline `--json`):
 *
 *   node packages/runtime/dist/cli/sync-cv-status.js <options.json>
 *   node packages/runtime/dist/cli/sync-cv-status.js --json '<json>'
 *
 * Options (old field names `deliveryRoot`/`evidencePath` accepted as
 * aliases):
 *   { "stageId": "S03", "sliceId": "S03-H", "projectRoot": ".",
 *     "manifestPath"?, "tasksPath"? }
 *
 * Output JSON:
 *   { success, stage_id, slice_id, slice_state, cv_status, cv_level,
 *     latest_cv_receipt, repair_attempt, slice_evidence_finalized,
 *     evidence_file_present, open_finding, findings }
 *
 * Zero host dependencies.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncCvStatus = syncCvStatus;
exports.syncCvStatusCli = syncCvStatusCli;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const reconcile_1 = require("../reconcile");
const manifest_source_1 = require("../manifest-source");
// ============================================================
// Derivation
// ============================================================
function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Derive the CV status snapshot of a slice from reconciled persisted facts
 * (read-only — HP-003: every fact comes from the deterministic three-source
 * merge, never a guess).
 */
function syncCvStatus(options) {
    const { stageId, sliceId, projectRoot } = options;
    if (!stageId || !sliceId || !projectRoot) {
        return { success: false, error: 'sync-cv-status requires stageId, sliceId and projectRoot' };
    }
    // Relative manifest/tasks paths resolve inside the project root (legacy
    // path semantics — never outside it).
    const resolveWithin = (p) => p === undefined || path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
    const manifestPath = resolveWithin(options.manifestPath);
    const tasksPath = resolveWithin(options.tasksPath);
    let state;
    try {
        state = (0, reconcile_1.reconcileStage)({
            projectRoot,
            stageId,
            manifestPath,
            tasksMdPath: tasksPath,
        });
    }
    catch (err) {
        return {
            success: false,
            error: `reconcile failed for stage "${stageId}": ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    const slice = state.slices.find((s) => s.slice_id === sliceId);
    if (slice === undefined) {
        return {
            success: false,
            error: `slice "${sliceId}" not found in stage "${stageId}"`,
            stage_id: stageId,
            findings: state.findings,
        };
    }
    // CV level + evidence path come from the manifest source (deterministic).
    let cvLevel;
    let evidenceFilePresent;
    try {
        const { manifest } = (0, manifest_source_1.manifestSource)({
            projectRoot,
            stageId,
            manifestPath,
        });
        const declared = manifest.slices.find((s) => s.slice_id === sliceId);
        if (declared !== undefined) {
            cvLevel = declared.cv_minimum_level;
            evidenceFilePresent = fs.existsSync(path.join(projectRoot, declared.evidence_path));
        }
    }
    catch (err) {
        if (!(err instanceof manifest_source_1.ManifestSourceError))
            throw err;
        // manifest unavailable → level/evidence facts stay absent (never a guess)
    }
    const receipt = slice.latest_cv_receipt;
    const latestCvReceipt = receipt === null
        ? null
        : { type: receipt.type, digest: receipt.digest, timestamp: receipt.timestamp };
    const openFinding = receipt !== null && receipt.type === 'CV_REPAIR'
        ? (typeof receipt.payload?.['summary'] === 'string' && receipt.payload['summary'].length > 0
            ? receipt.payload['summary']
            : 'CV repair required')
        : null;
    return {
        success: true,
        stage_id: stageId,
        slice_id: sliceId,
        slice_state: slice.slice_state,
        cv_status: slice.cv_status,
        cv_level: cvLevel,
        latest_cv_receipt: latestCvReceipt,
        repair_attempt: slice.repair_attempt,
        slice_evidence_finalized: slice.slice_evidence_finalized,
        evidence_file_present: evidenceFilePresent,
        open_finding: openFinding,
        findings: state.findings,
    };
}
// ============================================================
// CLI entry
// ============================================================
/** Read `<options.json>` or `--json '<json>'` (legacy arg contract). */
function readInputArg(argv) {
    const [arg1, arg2] = argv;
    if (arg1 === '--json')
        return arg2 ?? '';
    if (arg1 !== undefined)
        return fs.readFileSync(arg1, 'utf-8');
    return '';
}
/**
 * Legacy-compatible CLI:
 *   node dist/cli/sync-cv-status.js <options.json>
 *   node dist/cli/sync-cv-status.js --json '<json>'
 */
function syncCvStatusCli(argv) {
    let raw;
    try {
        raw = readInputArg(argv);
    }
    catch (err) {
        console.error(`Error: Cannot read options file: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
    if (!raw) {
        console.error('Usage: node dist/cli/sync-cv-status.js <options.json>');
        console.error('       node dist/cli/sync-cv-status.js --json \'<json>\'');
        console.error('');
        console.error('Options JSON:');
        console.error('  { "stageId": "S03", "sliceId": "S03-H", "projectRoot": ".",');
        console.error('    "manifestPath": "optional", "tasksPath": "optional" }');
        console.error('Derives the slice CV status snapshot from reconcile (read-only)');
        console.error('and outputs it as JSON to stdout.');
        return 1;
    }
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch (err) {
        console.error(`Error: Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
    const options = {
        stageId: str(data.stageId) ?? str(data.stage_id) ?? '',
        sliceId: str(data.sliceId) ?? str(data.slice_id) ?? '',
        projectRoot: str(data.projectRoot) ?? str(data.project_root) ?? str(data.deliveryRoot) ?? '',
        manifestPath: str(data.manifestPath) ?? str(data.manifest_path),
        tasksPath: str(data.tasksPath) ?? str(data.tasks_path),
    };
    const output = syncCvStatus(options);
    console.log(JSON.stringify(output, null, 2));
    return output.success ? 0 : 1;
}
if (require.main === module) {
    process.exitCode = syncCvStatusCli(process.argv.slice(2));
}
//# sourceMappingURL=sync-cv-status.js.map