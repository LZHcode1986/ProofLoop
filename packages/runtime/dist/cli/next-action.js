"use strict";
/**
 * next-action — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Path-only input → `NextActionService` (the S02-D full Reconcile →
 * Validate → Reduce → Action pipeline). Legacy-compatible argument shape
 * (file path or inline `--json`):
 *
 *   node packages/runtime/dist/cli/next-action.js <input.json>
 *   node packages/runtime/dist/cli/next-action.js --json '<json>'
 *
 * Input (path-only; camelCase aliases accepted):
 *   { "stage_id": "S03", "project_root": ".", "manifest_path"?, "tasks_path"? }
 *
 * Output: the proofloop_next contract JSON
 *   { action, action_detail, responsible_role, receipt_chain_valid, findings }
 *
 * The CLI is a thin wrapper: it never reads the filesystem itself to derive
 * the action — derivation is exclusively the `NextActionService` (HP-003,
 * PO-S02-D-02/04). Zero host dependencies.
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
exports.nextActionFromInput = nextActionFromInput;
exports.nextActionCli = nextActionCli;
const next_action_service_1 = require("../next-action-service");
const path = __importStar(require("node:path"));
// ============================================================
// Input normalization (old snake_case contract + camelCase aliases)
// ============================================================
function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Run the next-action pipeline from a path-only input JSON object.
 *
 * @throws TypeError when the required identity fields are missing.
 */
function nextActionFromInput(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new TypeError('next-action input must be a JSON object');
    }
    const input = raw;
    const projectRoot = str(input.project_root) ?? str(input.projectRoot);
    const stageId = str(input.stage_id) ?? str(input.stageId);
    if (projectRoot === undefined) {
        throw new TypeError('next-action input requires project_root (string)');
    }
    if (stageId === undefined) {
        throw new TypeError('next-action input requires stage_id (string)');
    }
    // Relative manifest/tasks paths resolve inside the project root (legacy
    // executor-next-action path semantics — never outside it).
    const resolveWithin = (p) => p === undefined || path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
    return new next_action_service_1.NextActionService().nextAction({
        projectRoot,
        stageId,
        manifestPath: resolveWithin(str(input.manifest_path) ?? str(input.manifestPath)),
        tasksPath: resolveWithin(str(input.tasks_path) ?? str(input.tasksPath)),
    });
}
// ============================================================
// CLI entry
// ============================================================
/** Read `<input.json>` or `--json '<json>'` (legacy arg contract). */
function readInputArg(argv) {
    const [arg1, arg2] = argv;
    if (arg1 === '--json') {
        if (!arg2)
            return { raw: '' };
        return { raw: arg2 };
    }
    if (arg1 !== undefined) {
        return { raw: require('node:fs').readFileSync(arg1, 'utf-8') };
    }
    return { raw: '' };
}
/**
 * Legacy-compatible CLI:
 *   node dist/cli/next-action.js <input.json>
 *   node dist/cli/next-action.js --json '<json>'
 */
function nextActionCli(argv) {
    let raw;
    try {
        raw = readInputArg(argv).raw;
    }
    catch (err) {
        console.error(`Error: Cannot read input file: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
    if (!raw) {
        console.error('Usage: node dist/cli/next-action.js <input.json>');
        console.error('       node dist/cli/next-action.js --json \'<json>\'');
        console.error('');
        console.error('Input (path-only, old CLI contract):');
        console.error('  { "stage_id": "S03", "project_root": ".",');
        console.error('    "manifest_path": ".proofloop/manifests/S03.json",   // optional');
        console.error('    "tasks_path": "delivery/stages/S03/tasks.md" }      // optional');
        console.error('Outputs the proofloop_next contract JSON to stdout.');
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
    try {
        const output = nextActionFromInput(data);
        console.log(JSON.stringify(output, null, 2));
        return 0;
    }
    catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
}
if (require.main === module) {
    process.exitCode = nextActionCli(process.argv.slice(2));
}
//# sourceMappingURL=next-action.js.map