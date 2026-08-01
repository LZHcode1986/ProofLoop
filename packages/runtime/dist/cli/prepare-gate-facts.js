"use strict";
/**
 * prepare-gate-facts — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Reconcile + git-clean check + HEAD + all-slices-integrated → writes the
 * Slice COMPLETE Facts JSON consumed by run-gate. Legacy-compatible
 * contract:
 *
 *   node packages/runtime/dist/cli/prepare-gate-facts.js <reconcile-input.json>
 *
 * Input (path-only, old ReconcileStageStateInput shape; camelCase aliases
 * accepted):
 *   { "stage_id": "S03", "project_root": ".", "manifest_path"?, "tasks_path"? }
 *
 * Gate preconditions (fail closed — any unmet precondition produces
 * `{ success: false, error }` and NO facts file):
 *  - the working tree is git-clean (`git status --porcelain` empty);
 *  - HEAD resolves;
 *  - every manifest slice is derived INTEGRATED by reconcile.
 *
 * Output facts file: `<projectRoot>/.proofloop/runtime/<stageId>/slice-complete-facts.json`
 * (array of `{ slice_id, integrated, committed, head_sha, git_clean }`,
 * written atomically via temp + rename). CLI stdout matches the legacy
 * shape `{ success: true, path }`.
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
exports.prepareGateFacts = prepareGateFacts;
exports.prepareGateFactsCli = prepareGateFactsCli;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const reconcile_1 = require("../reconcile");
// ============================================================
// Git helpers (deterministic, read-only)
// ============================================================
function git(args, cwd) {
    return (0, node_child_process_1.execFileSync)('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function workingTreeClean(projectRoot) {
    const porcelain = git(['status', '--porcelain'], projectRoot);
    return porcelain.length === 0;
}
function headSha(projectRoot) {
    return git(['rev-parse', 'HEAD'], projectRoot);
}
// ============================================================
// prepareGateFacts
// ============================================================
function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Prepare the Slice COMPLETE Facts for a Stage Gate from reconciled stage
 * state (reconcile + git clean + HEAD + all slices integrated).
 *
 * @throws Error on any unmet gate precondition (no facts file is written).
 */
function prepareGateFacts(input) {
    const raw = input;
    const stageId = str(raw.stage_id) ?? str(raw.stageId);
    const projectRootArg = str(raw.project_root) ?? str(raw.projectRoot);
    if (!stageId || !projectRootArg) {
        return { success: false, error: 'prepare-gate-facts requires stage_id and project_root' };
    }
    const projectRoot = path.resolve(projectRootArg);
    const resolveWithin = (p) => p === undefined || path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
    const manifestPath = resolveWithin(str(raw.manifest_path) ?? str(raw.manifestPath));
    const tasksPath = resolveWithin(str(raw.tasks_path) ?? str(raw.tasksPath));
    // 1. Working tree must be clean (fail closed).
    let clean;
    try {
        clean = workingTreeClean(projectRoot);
    }
    catch (err) {
        return {
            success: false,
            error: `git status failed in "${projectRoot}": ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    if (!clean) {
        return {
            success: false,
            error: `working tree is not clean in "${projectRoot}" — gate facts refused (git status --porcelain non-empty)`,
        };
    }
    // 2. HEAD must resolve.
    let head;
    try {
        head = headSha(projectRoot);
    }
    catch (err) {
        return {
            success: false,
            error: `cannot resolve HEAD in "${projectRoot}": ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    // 3. Reconcile through the runtime service (never re-derive by hand).
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
    // 4. Every slice must be integrated (fail closed).
    const notIntegrated = state.slices.filter((s) => !s.integrated);
    if (notIntegrated.length > 0) {
        return {
            success: false,
            error: `cannot prepare gate facts: not every slice is integrated. ` +
                `Non-integrated slices: ${notIntegrated.map((s) => s.slice_id).join(', ')}`,
        };
    }
    const facts = state.slices.map((s) => ({
        slice_id: s.slice_id,
        integrated: s.integrated,
        committed: s.committed,
        head_sha: head,
        git_clean: true,
    }));
    // 5. Atomic write (temp + rename) to the deterministic output path.
    const outputDir = path.join(projectRoot, '.proofloop', 'runtime', stageId);
    const outputPath = path.join(outputDir, 'slice-complete-facts.json');
    try {
        fs.mkdirSync(outputDir, { recursive: true });
        const tmpPath = `${outputPath}.tmp.${process.pid}`;
        fs.writeFileSync(tmpPath, JSON.stringify(facts, null, 2), 'utf-8');
        fs.renameSync(tmpPath, outputPath);
    }
    catch (err) {
        return {
            success: false,
            error: `failed to write gate facts to "${outputPath}": ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    return { success: true, path: outputPath, facts };
}
// ============================================================
// CLI entry
// ============================================================
/**
 * Legacy-compatible CLI:
 *   node dist/cli/prepare-gate-facts.js <reconcile-input.json>
 */
function prepareGateFactsCli(argv) {
    const [inputPath] = argv;
    if (!inputPath) {
        console.error('Usage: node dist/cli/prepare-gate-facts.js <reconcile-input.json>');
        console.error('');
        console.error('Reconciles the stage, checks git-clean + HEAD + all slices');
        console.error('integrated, and writes slice-complete-facts.json to');
        console.error('.proofloop/runtime/<stageId>/.');
        console.error('Outputs JSON: { "success": true, "path": "<output-path>" }');
        return 1;
    }
    let input;
    try {
        input = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    }
    catch (err) {
        console.error(JSON.stringify({ success: false, error: `Cannot read input: ${err instanceof Error ? err.message : String(err)}` }));
        return 1;
    }
    const result = prepareGateFacts(input);
    if (!result.success) {
        console.error(JSON.stringify({ success: false, error: result.error ?? 'unknown error' }));
        return 1;
    }
    console.log(JSON.stringify({ success: true, path: result.path }));
    return 0;
}
if (require.main === module) {
    process.exitCode = prepareGateFactsCli(process.argv.slice(2));
}
//# sourceMappingURL=prepare-gate-facts.js.map