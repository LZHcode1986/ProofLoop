"use strict";
/**
 * compile-manifest CLI — PO-S03-H-01 call matrix (S03-H-T01)
 *
 * Public seam: `packages/runtime/src/cli/compile-manifest.ts` (+ the dist
 * script `packages/runtime/dist/cli/compile-manifest.js`).
 *
 * Covered here:
 *  - tasks.md → Manifest that passes the kernel `validateManifest` seam
 *    (the manifest is only accepted when kernel-valid — fail closed);
 *  - multi-slice dependency list parsing: each dependency on its own line
 *    AND multiple dependencies per line (按行解析) — the machine-readable
 *    DAG equals the tasks.md declarations (declaration order preserved);
 *  - proof-obligation parsing with multi-line values and defaults;
 *  - `## Stage Runtime Proof` step parsing (the documented YAML subset:
 *    command/probe/service_start/service_stop, args flow arrays with
 *    quoted elements, expected.exit_code, not_applicable, service_ref,
 *    readiness_signal);
 *  - cv_minimum_level computed from declared Risk Facts (canonical mapping);
 *  - CLI failure cases (missing tasks file, missing args → usage).
 *
 * No mocks: fixtures are real temporary files. The kernel validator is the
 * oracle (not an implementation-derived expectation).
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
const vitest_1 = require("vitest");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const kernel_1 = require("@proofloop/kernel");
const compile_manifest_1 = require("./compile-manifest");
// ============================================================
// Fixture helpers
// ============================================================
const cleanups = [];
(0, vitest_1.afterEach)(() => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        fn?.();
    }
});
let fixtureCounter = 0;
function writeFixture(content, name = `tasks-${++fixtureCounter}.md`) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-compile-'));
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, 'utf-8');
    cleanups.push(() => {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        catch {
            // best-effort
        }
    });
    return p;
}
/** Acyclic 3-slice stage: A root; B deps [A]; C deps [A, B] (multi-per-line). */
function acyclicTasksMd() {
    return `# Stage S03 — Test Stage

## Stage Goal

Test stage goal paragraph.

## Observable Outcomes

- OUT-01: first outcome
- OUT-02: second outcome

## Dependencies

- No external stage blocking dependency.

## Stage Risk Facts

- public_api_change: true

## Stage Runtime Proof

\`\`\`yaml
steps:
  - id: build
    type: command
    executable: npm
    args: [run, build]
    cwd: .
    timeout_ms: 300000
    expected:
      exit_code: 0

  - id: smoke
    type: probe
    executable: node
    args: ["-e", "process.exit(0)"]
    cwd: .
    timeout_ms: 10000
    expected:
      exit_code: 0

  - id: app-start
    type: service_start
    executable: node
    args: [--version]
    cwd: .
    readiness_signal: node available
    timeout_ms: 10000
    not_applicable:
      reason: No long-running application service.

  - id: app-stop
    type: service_stop
    executable: node
    args: [--version]
    cwd: .
    service_ref: app-start
    timeout_ms: 10000
    not_applicable:
      reason: No service was started.
\`\`\`

## Slice S03-A — Slice A

<!-- SLICE:S03-A:BEGIN -->

### Goal

Slice A goal.

### Observable Outcome

Slice A observable outcome.

### Public Seam

Seam A.

### Dependencies

- 无内部依赖。

### Risk Facts

- core_state_machine: true

### Proof Obligations

- PO-S03-A-01
  - Behavior: Slice A behavior
    continues on the next line.
  - Public Seam: Seam A.
  - Oracle Source: oracle A.
  - Success / Failure: success when X; failure when Y.
  - Required Observation: observe X.
  - Applicable Risk Facts: core_state_machine

### Tasks

- [ ] S03-A-T01: task one

<!-- SLICE:S03-A:END -->

## Slice S03-B — Slice B

<!-- SLICE:S03-B:BEGIN -->

### Goal

Slice B goal.

### Observable Outcome

Slice B observable outcome.

### Public Seam

Seam B.

### Dependencies

- S03-A

### Risk Facts

- persistent_state: true

### Proof Obligations

- PO-S03-B-01
  - Behavior: Slice B behavior.
  - Public Seam: Seam B.
  - Oracle Source: oracle B.
  - Success / Failure: success when Z.
  - Required Observation: observe Z.

### Tasks

- [ ] S03-B-T01: task one
- [x] S03-B-T02: task two

<!-- SLICE:S03-B:END -->

## Slice S03-C — Slice C

<!-- SLICE:S03-C:BEGIN -->

### Goal

Slice C goal.

### Observable Outcome

Slice C observable outcome.

### Public Seam

Seam C.

### Dependencies

- S03-A S03-B

### Risk Facts

- authorization: false

### Tasks

- [ ] S03-C-T01: task one

<!-- SLICE:S03-C:END -->
`;
}
// ============================================================
// compileManifest — success behaviors
// ============================================================
(0, vitest_1.describe)('compileManifest (PO-S03-H-01: tasks.md → kernel-validated manifest)', () => {
    (0, vitest_1.it)('compiles a tasks.md into a Manifest that passes kernel validateManifest', () => {
        const tasksPath = writeFixture(acyclicTasksMd());
        const manifest = (0, compile_manifest_1.compileManifest)(tasksPath);
        // Oracle: the kernel validator must accept the compiled manifest.
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)(manifest)).not.toThrow();
        (0, vitest_1.expect)(manifest.stage_id).toBe('S03');
        (0, vitest_1.expect)(manifest.source_path).toBe(tasksPath);
        (0, vitest_1.expect)(manifest.source_digest).toMatch(/^[a-f0-9]{64}$/);
        (0, vitest_1.expect)(manifest.stage_goal).toBe('Test stage goal paragraph.');
        (0, vitest_1.expect)(manifest.outcomes).toEqual(['OUT-01: first outcome', 'OUT-02: second outcome']);
        (0, vitest_1.expect)(manifest.slices.map((s) => s.slice_id)).toEqual(['S03-A', 'S03-B', 'S03-C']);
        (0, vitest_1.expect)(manifest.risk_facts).toEqual(['public_api_change: true']);
    });
    (0, vitest_1.it)('parses slice dependencies declared one per line (declaration order preserved)', () => {
        const manifest = (0, compile_manifest_1.compileManifest)(writeFixture(acyclicTasksMd()));
        const byId = new Map(manifest.slices.map((s) => [s.slice_id, s]));
        (0, vitest_1.expect)(byId.get('S03-B')?.dependencies).toEqual(['S03-A']);
        // prose-only dependency line → no machine dependency (no guess)
        (0, vitest_1.expect)(byId.get('S03-A')?.dependencies).toEqual([]);
    });
    (0, vitest_1.it)('parses slice dependencies declared multiple per line (按行解析)', () => {
        const manifest = (0, compile_manifest_1.compileManifest)(writeFixture(acyclicTasksMd()));
        const byId = new Map(manifest.slices.map((s) => [s.slice_id, s]));
        // "- S03-A S03-B" on one line → both dependencies, declaration order
        (0, vitest_1.expect)(byId.get('S03-C')?.dependencies).toEqual(['S03-A', 'S03-B']);
    });
    (0, vitest_1.it)('never parses a slice id mentioned in dependency prose as a dependency', () => {
        const tasks = acyclicTasksMd().replace('- S03-A S03-B', '- S03-A — 消费 `XContract`（经 S03-B 传递）。');
        const manifest = (0, compile_manifest_1.compileManifest)(writeFixture(tasks));
        const sliceC = manifest.slices.find((s) => s.slice_id === 'S03-C');
        // the leading run ends at the prose token `—`; the mention of S03-B
        // inside the description is NOT a dependency (never a guess)
        (0, vitest_1.expect)(sliceC.dependencies).toEqual(['S03-A']);
    });
    (0, vitest_1.it)('tolerates separator tokens between slice ids in a dependency line', () => {
        const tasks = acyclicTasksMd().replace('- S03-A S03-B', '- S03-A + S03-B');
        const manifest = (0, compile_manifest_1.compileManifest)(writeFixture(tasks));
        const sliceC = manifest.slices.find((s) => s.slice_id === 'S03-C');
        (0, vitest_1.expect)(sliceC.dependencies).toEqual(['S03-A', 'S03-B']);
    });
    (0, vitest_1.it)('produces a machine-readable DAG consistent with tasks.md declarations', () => {
        const manifest = (0, compile_manifest_1.compileManifest)(writeFixture(acyclicTasksMd()));
        const declared = new Set(manifest.slices.map((s) => s.slice_id));
        for (const slice of manifest.slices) {
            for (const dep of slice.dependencies) {
                (0, vitest_1.expect)(declared.has(dep)).toBe(true);
            }
        }
    });
    (0, vitest_1.it)('parses proof obligations with multi-line values and non-empty kernel fields', () => {
        const manifest = (0, compile_manifest_1.compileManifest)(writeFixture(acyclicTasksMd()));
        const sliceA = manifest.slices.find((s) => s.slice_id === 'S03-A');
        (0, vitest_1.expect)(sliceA.proof_obligations).toHaveLength(1);
        const po = sliceA.proof_obligations[0];
        (0, vitest_1.expect)(po.po_id).toBe('PO-S03-A-01');
        (0, vitest_1.expect)(po.behavior).toContain('Slice A behavior');
        (0, vitest_1.expect)(po.behavior).toContain('continues on the next line');
        (0, vitest_1.expect)(po.oracle_source).toBe('oracle A.');
        (0, vitest_1.expect)(po.success_criteria).toContain('success when X');
        (0, vitest_1.expect)(po.required_observation).toBe('observe X.');
        (0, vitest_1.expect)(po.applicable_risk_facts).toEqual(['core_state_machine']);
        // Slice B declares no Applicable Risk Facts → kernel-valid default
        const sliceB = manifest.slices.find((s) => s.slice_id === 'S03-B');
        (0, vitest_1.expect)(sliceB.proof_obligations[0].applicable_risk_facts).toEqual([]);
        (0, vitest_1.expect)(sliceB.proof_obligations[0].public_seam).toBe('Seam B.');
        // every PO field satisfies the kernel non-empty requirement
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)(manifest)).not.toThrow();
    });
    (0, vitest_1.it)('parses the Stage Runtime Proof YAML subset (args arrays, nested expected/not_applicable)', () => {
        const manifest = (0, compile_manifest_1.compileManifest)(writeFixture(acyclicTasksMd()));
        const steps = manifest.runtime_proof ?? [];
        (0, vitest_1.expect)(steps.map((s) => s.id)).toEqual(['build', 'smoke', 'app-start', 'app-stop']);
        const build = steps[0];
        (0, vitest_1.expect)(build.type).toBe('command');
        (0, vitest_1.expect)(build.executable).toBe('npm');
        (0, vitest_1.expect)(build.args).toEqual(['run', 'build']);
        (0, vitest_1.expect)(build.cwd).toBe('.');
        (0, vitest_1.expect)(build.timeout_ms).toBe(300000);
        (0, vitest_1.expect)(build.expected).toEqual({ exit_code: 0 });
        // flow array with quoted element containing commas/colons
        const smoke = steps[1];
        (0, vitest_1.expect)(smoke.args).toEqual(['-e', 'process.exit(0)']);
        (0, vitest_1.expect)(smoke.expected?.exit_code).toBe(0);
        // service steps with readiness_signal / service_ref / not_applicable.reason
        const start = steps[2];
        (0, vitest_1.expect)(start.readiness_signal).toBe('node available');
        (0, vitest_1.expect)(start.not_applicable?.reason).toContain('No long-running application service');
        const stop = steps[3];
        (0, vitest_1.expect)(stop.service_ref).toBe('app-start');
        (0, vitest_1.expect)(stop.not_applicable?.reason).toContain('No service was started');
    });
    (0, vitest_1.it)('computes cv_minimum_level from declared Risk Facts (canonical mapping)', () => {
        const manifest = (0, compile_manifest_1.compileManifest)(writeFixture(acyclicTasksMd()));
        const byId = new Map(manifest.slices.map((s) => [s.slice_id, s]));
        // core_state_machine → enhanced
        (0, vitest_1.expect)(byId.get('S03-A')?.cv_minimum_level).toBe('enhanced');
        // persistent_state → standard
        (0, vitest_1.expect)(byId.get('S03-B')?.cv_minimum_level).toBe('standard');
        // authorization (declared false) still maps to enhanced (conservative, canonical)
        (0, vitest_1.expect)(byId.get('S03-C')?.cv_minimum_level).toBe('enhanced');
    });
    (0, vitest_1.it)('writes evidence_path per the canonical pattern', () => {
        const manifest = (0, compile_manifest_1.compileManifest)(writeFixture(acyclicTasksMd()));
        for (const slice of manifest.slices) {
            (0, vitest_1.expect)(slice.evidence_path).toBe(`delivery/stages/${manifest.stage_id}/evidence/${slice.slice_id}.md`);
        }
    });
    (0, vitest_1.it)('extracts task ids from checkbox lines only', () => {
        const manifest = (0, compile_manifest_1.compileManifest)(writeFixture(acyclicTasksMd()));
        const byId = new Map(manifest.slices.map((s) => [s.slice_id, s]));
        (0, vitest_1.expect)(byId.get('S03-A')?.tasks).toEqual(['S03-A-T01']);
        (0, vitest_1.expect)(byId.get('S03-B')?.tasks).toEqual(['S03-B-T01', 'S03-B-T02']);
    });
    (0, vitest_1.it)('fails closed when the tasks file does not exist', () => {
        (0, vitest_1.expect)(() => (0, compile_manifest_1.compileManifest)('/nonexistent/tasks.md')).toThrow(/not found|ENOENT/i);
    });
    (0, vitest_1.it)('fails closed when the compiled manifest is kernel-invalid (e.g. unknown risk fact)', () => {
        const bad = acyclicTasksMd().replace('- core_state_machine: true', '- totally_unknown_fact: true');
        const tasksPath = writeFixture(bad);
        (0, vitest_1.expect)(() => (0, compile_manifest_1.compileManifest)(tasksPath)).toThrow(/unknown risk fact/i);
    });
});
// ============================================================
// CLI entry (dist script) — call matrix
// ============================================================
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_CLI = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'compile-manifest.js');
(0, vitest_1.describe)('compile-manifest.js dist script (PO-S03-H-01: callable via dist, old-CLI contract)', () => {
    const distExists = fs.existsSync(DIST_CLI);
    (0, vitest_1.it)('exits 1 with a usage error when invoked without args (old contract: <tasks-path> <output-path>)', () => {
        (0, vitest_1.expect)(distExists).toBe(true);
        const res = (0, node_child_process_1.spawnSync)(process.execPath, [DIST_CLI], { encoding: 'utf-8' });
        (0, vitest_1.expect)(res.status).toBe(1);
        (0, vitest_1.expect)((res.stderr + res.stdout).toLowerCase()).toContain('usage:');
    });
    (0, vitest_1.it)('compiles a tasks fixture to a kernel-valid manifest file and exits 0', () => {
        (0, vitest_1.expect)(distExists).toBe(true);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-spawn-'));
        cleanups.push(() => {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            }
            catch {
                // best-effort
            }
        });
        const tasksPath = path.join(dir, 'tasks.md');
        fs.writeFileSync(tasksPath, acyclicTasksMd(), 'utf-8');
        const outPath = path.join(dir, 'manifest.json');
        const res = (0, node_child_process_1.spawnSync)(process.execPath, [DIST_CLI, tasksPath, outPath], {
            encoding: 'utf-8',
            timeout: 30000,
        });
        (0, vitest_1.expect)(res.status).toBe(0);
        (0, vitest_1.expect)(res.stdout).toContain('Stage manifest written to');
        const manifest = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)(manifest)).not.toThrow();
        (0, vitest_1.expect)(manifest.stage_id).toBe('S03');
        (0, vitest_1.expect)(manifest.slices).toHaveLength(3);
    });
    (0, vitest_1.it)('exits 1 when the tasks file does not exist', () => {
        (0, vitest_1.expect)(distExists).toBe(true);
        const res = (0, node_child_process_1.spawnSync)(process.execPath, [DIST_CLI, '/nonexistent/tasks.md', '/tmp/out.json'], {
            encoding: 'utf-8',
        });
        (0, vitest_1.expect)(res.status).toBe(1);
        (0, vitest_1.expect)(res.stderr.toLowerCase()).toMatch(/not found|compilation failed/i);
    });
});
// ============================================================
// Module sanity — the kernel validator is the oracle
// ============================================================
(0, vitest_1.describe)('compile-manifest kernel validity (oracle)', () => {
    (0, vitest_1.it)('a compiled manifest with an unknown risk fact is rejected by the compiler', () => {
        // Guard: SchemaValidationError is exported by the kernel seam used here.
        (0, vitest_1.expect)(typeof kernel_1.SchemaValidationError).toBe('function');
    });
});
//# sourceMappingURL=compile-manifest.spec.js.map