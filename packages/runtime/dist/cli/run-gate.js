"use strict";
/**
 * run-gate — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Stage Gate execution, minimal version (HP-004: per-step timeout +
 * exit-code checks; no cancellation / process-tree cleanup /
 * GATE_INTERRUPTED — those are S04/AWI-015). Legacy-compatible contract:
 *
 *   node packages/runtime/dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]
 *
 * Flow:
 *  1. load + kernel-validate the manifest;
 *  2. load the Slice COMPLETE Facts (JSON array) — every manifest slice must
 *     carry a fact with `integrated: true`; facts for undeclared slices are
 *     refused (stale-fact guard);
 *  3. execute the manifest `runtime_proof` steps: `command`/`probe` steps run
 *     synchronously with per-step timeout and `expected.exit_code` check
 *     (absent expected → 0; `exit_code: null` → any exit accepted);
 *     `not_applicable` steps are skipped; `service_start`/`service_stop`
 *     steps that are NOT marked not_applicable fail the gate (service
 *     lifecycle execution is deferred to S04 — honest fail-closed);
 *  4. write the gate result JSON to `<output-dir>/gate-result.json`
 *     (default `<projectRoot>/.proofloop/runtime/<stageId>/`).
 *
 * Output: JSON `{ success, gate, stage_id, steps, errors, output_path }`;
 * exit 0 on PASS / 1 on FAIL. The GATE_PASS/GATE_FAIL Receipt is written by
 * the unified admit pipeline (S03-H-T02 `admitGateResult`) — run-gate never
 * writes receipts itself.
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
exports.runGate = runGate;
exports.runGateCli = runGateCli;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const kernel_1 = require("@proofloop/kernel");
/**
 * Validate the Slice COMPLETE Facts file: a JSON array; every manifest slice
 * present with `integrated: true`; no facts for undeclared slices.
 */
function validateFacts(manifest, raw, errors) {
    if (!Array.isArray(raw)) {
        errors.push('Slice COMPLETE facts file must contain a JSON array.');
        return null;
    }
    const facts = raw;
    const byId = new Map();
    for (const entry of facts) {
        if (typeof entry !== 'object' || entry === null) {
            errors.push('Slice COMPLETE facts entries must be JSON objects.');
            return null;
        }
        const fact = entry;
        const sliceId = fact['slice_id'];
        if (typeof sliceId !== 'string' || sliceId.length === 0) {
            errors.push('Slice COMPLETE facts entries must carry a non-empty slice_id.');
            return null;
        }
        byId.set(sliceId, fact);
    }
    for (const slice of manifest.slices) {
        const fact = byId.get(slice.slice_id);
        if (fact === undefined) {
            errors.push(`Slice "${slice.slice_id}" has no COMPLETE fact entry — gate refused`);
        }
        else if (fact.integrated !== true) {
            errors.push(`Slice "${slice.slice_id}" COMPLETE fact is not integrated: true — gate refused`);
        }
    }
    for (const sliceId of byId.keys()) {
        if (!manifest.slices.some((s) => s.slice_id === sliceId)) {
            errors.push(`COMPLETE fact for undeclared slice "${sliceId}" — stale facts refused`);
        }
    }
    return byId.size > 0 && errors.length === 0 ? facts : null;
}
// ============================================================
// Step execution (minimal — HP-004)
// ============================================================
function expectedExitCode(step) {
    const expected = step.expected;
    if (expected === undefined)
        return 0;
    const value = expected['exit_code'];
    if (value === null || value === undefined)
        return null; // any exit accepted
    return typeof value === 'number' ? value : 0;
}
function executeStep(step, projectRoot) {
    // not_applicable steps are skipped by declaration.
    if (step.not_applicable !== undefined) {
        return { id: step.id, type: step.type, exit_code: null, passed: true, skipped: true };
    }
    // Service lifecycle steps without not_applicable are deferred to S04
    // (HP-004) — fail the gate honestly instead of silently skipping.
    if (step.type === 'service_start' || step.type === 'service_stop') {
        return {
            id: step.id,
            type: step.type,
            exit_code: null,
            passed: false,
            error: `service lifecycle step "${step.id}" is not marked not_applicable — ` +
                `service lifecycle execution is deferred to S04 (HP-004)`,
        };
    }
    const cwd = path.resolve(projectRoot, step.cwd ?? '.');
    const expected = expectedExitCode(step);
    try {
        (0, node_child_process_1.execFileSync)(step.executable, step.args ?? [], {
            cwd,
            timeout: step.timeout_ms,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf-8',
        });
        const passed = expected === null || expected === 0;
        return { id: step.id, type: step.type, exit_code: 0, passed };
    }
    catch (err) {
        const e = err;
        if (e.code === 'ETIMEDOUT') {
            return {
                id: step.id,
                type: step.type,
                exit_code: null,
                passed: false,
                error: `step "${step.id}" timed out after ${step.timeout_ms}ms`,
            };
        }
        const actual = e.status ?? 1;
        const passed = expected === null || actual === expected;
        return {
            id: step.id,
            type: step.type,
            exit_code: actual,
            passed,
            error: passed
                ? undefined
                : `step "${step.id}" exited ${actual}, expected ${expected === null ? 'any' : expected}`,
        };
    }
}
// ============================================================
// runGate
// ============================================================
/**
 * Run the Stage Gate (minimal version) over a manifest + Slice COMPLETE
 * facts, executing the manifest runtime_proof steps with per-step timeout
 * and exit-code checks.
 */
function runGate(input) {
    const projectRoot = path.resolve(input.projectRoot ?? '.');
    const errors = [];
    let manifest;
    try {
        manifest = (0, kernel_1.validateManifest)(JSON.parse(fs.readFileSync(input.manifestPath, 'utf-8')));
    }
    catch (err) {
        return {
            success: false,
            gate: 'FAIL',
            stage_id: 'unknown',
            steps: [],
            errors: [`cannot load/validate manifest "${input.manifestPath}": ${err instanceof Error ? err.message : String(err)}`],
        };
    }
    let factsRaw;
    try {
        factsRaw = JSON.parse(fs.readFileSync(input.factsPath, 'utf-8'));
    }
    catch (err) {
        return {
            success: false,
            gate: 'FAIL',
            stage_id: manifest.stage_id,
            steps: [],
            errors: [`cannot read facts file "${input.factsPath}": ${err instanceof Error ? err.message : String(err)}`],
        };
    }
    const facts = validateFacts(manifest, factsRaw, errors);
    const steps = [];
    if (facts !== null) {
        for (const step of manifest.runtime_proof ?? []) {
            steps.push(executeStep(step, projectRoot));
        }
        for (const step of steps) {
            if (!step.passed && step.error !== undefined) {
                errors.push(step.error);
            }
        }
    }
    const gate = errors.length === 0 ? 'PASS' : 'FAIL';
    // Result file (best-effort — a write failure is surfaced, not silent).
    const outputDir = path.resolve(input.outputDir ?? path.join(projectRoot, '.proofloop', 'runtime', manifest.stage_id));
    const outputPath = path.join(outputDir, 'gate-result.json');
    let writtenPath;
    try {
        fs.mkdirSync(outputDir, { recursive: true });
        const partial = {
            success: gate === 'PASS',
            gate,
            stage_id: manifest.stage_id,
            steps,
            errors,
            output_path: outputPath,
        };
        fs.writeFileSync(outputPath, JSON.stringify(partial, null, 2), 'utf-8');
        writtenPath = outputPath;
    }
    catch (err) {
        errors.push(`cannot write gate result to "${outputPath}": ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
        success: gate === 'PASS' && writtenPath !== undefined,
        gate: errors.length === 0 && writtenPath !== undefined ? 'PASS' : 'FAIL',
        stage_id: manifest.stage_id,
        steps,
        errors,
        output_path: writtenPath,
    };
}
// ============================================================
// CLI entry
// ============================================================
/**
 * Legacy-compatible CLI:
 *   node dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]
 */
function runGateCli(argv) {
    const [manifestPath, factsPath, outputDir, projectRoot] = argv;
    if (!manifestPath || !factsPath) {
        console.error('Usage: node dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]');
        console.error('');
        console.error('Executes the Stage Gate (runtime_proof steps with per-step');
        console.error('timeout + exit-code checks) and writes gate-result.json.');
        console.error('Outputs the gate result JSON to stdout; exit 0 on PASS, 1 on FAIL.');
        return 1;
    }
    if (!fs.existsSync(manifestPath)) {
        console.error(`Manifest file not found: ${manifestPath}`);
        return 1;
    }
    if (!fs.existsSync(factsPath)) {
        console.error(`Slice COMPLETE facts file not found: ${factsPath}`);
        return 1;
    }
    const result = runGate({
        manifestPath,
        factsPath,
        outputDir: outputDir || undefined,
        projectRoot: projectRoot || undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.success ? 0 : 1;
}
if (require.main === module) {
    process.exitCode = runGateCli(process.argv.slice(2));
}
//# sourceMappingURL=run-gate.js.map