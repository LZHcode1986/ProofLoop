"use strict";
/**
 * validate-stage CLI — PO-S03-H-01 call matrix (S03-H-T01)
 *
 * Public seam: `packages/runtime/src/cli/validate-stage.ts` (+ dist script).
 * Planner mechanical gatekeeper over a Stage tasks.md (and optionally a
 * previously compiled manifest + an evidence directory), old-CLI contract:
 *
 *   node packages/runtime/dist/cli/validate-stage.js <tasks.md> <manifest.json> [evidence-dir]
 *
 * Gatekeeper checks:
 *  - the tasks.md compiles into a kernel-`validateManifest`-valid Manifest;
 *  - SLICE:BEGIN/END marker structure (unclosed / orphaned regions);
 *  - id uniqueness (slice / PO / task);
 *  - dependency DAG: no cycles AND every declared dependency exists in the
 *    Stage closure (Referencing Slices appear in the Stage Closure);
 *  - PO fields declared-but-empty (Behavior / Oracle Source / Success /
 *    Failure / Required Observation);
 *  - every task id occurrence belongs to a slice Tasks section;
 *  - optional compiled-manifest cross-check (stage_id, slice set, evidence
 *    paths) and optional evidence-dir existence checks.
 *
 * Output: JSON `{ valid, stage_id, errors: [{ type, message, sliceId? }] }`
 * on stdout; exit 0 valid / 1 invalid.
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
const validate_stage_1 = require("./validate-stage");
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
function makeFx() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-validate-'));
    const fx = {
        dir,
        writeTasks: (content, name = `tasks-${++fixtureCounter}.md`) => {
            const p = path.join(dir, name);
            fs.writeFileSync(p, content, 'utf-8');
            return p;
        },
        writeManifest: (manifest, name = 'manifest.json') => {
            const p = path.join(dir, name);
            fs.writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8');
            return p;
        },
        writeEvidence: (sliceId, name) => {
            const p = path.join(dir, name ?? `${sliceId}.md`);
            fs.writeFileSync(p, `# Slice ${sliceId} Evidence\n`, 'utf-8');
            return p;
        },
        cleanup: () => {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            }
            catch {
                // best-effort
            }
        },
    };
    cleanups.push(fx.cleanup);
    return fx;
}
/** Acyclic 2-slice stage: A root; B deps [A]. */
function validTasksMd() {
    return `# Stage S03 — Test Stage

## Stage Goal

Test stage goal paragraph.

## Observable Outcomes

- OUT-01: first outcome

## Dependencies

- No external stage blocking dependency.

## Stage Risk Facts

- public_api_change: true

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
  - Behavior: Slice A behavior.
  - Public Seam: Seam A.
  - Oracle Source: oracle A.
  - Success / Failure: success when X; failure when Y.
  - Required Observation: observe X.

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
`;
}
function compiledManifest() {
    return {
        stage_id: 'S03',
        source_path: 'delivery/stages/S03/tasks.md',
        source_digest: 'a'.repeat(64),
        stage_goal: 'Test stage goal paragraph.',
        outcomes: ['OUT-01: first outcome'],
        slices: [
            {
                slice_id: 'S03-A',
                goal: 'Slice A goal.',
                observable_outcome: 'Slice A observable outcome.',
                public_seam: 'Seam A.',
                dependencies: [],
                proof_obligations: [
                    {
                        po_id: 'PO-S03-A-01',
                        behavior: 'Slice A behavior.',
                        public_seam: 'Seam A.',
                        oracle_source: 'oracle A.',
                        success_criteria: 'success when X; failure when Y.',
                        required_observation: 'observe X.',
                        applicable_risk_facts: [],
                    },
                ],
                tasks: ['S03-A-T01'],
                risk_facts: ['core_state_machine: true'],
                evidence_path: 'delivery/stages/S03/evidence/S03-A.md',
                cv_minimum_level: 'enhanced',
            },
            {
                slice_id: 'S03-B',
                goal: 'Slice B goal.',
                observable_outcome: 'Slice B observable outcome.',
                public_seam: 'Seam B.',
                dependencies: ['S03-A'],
                proof_obligations: [
                    {
                        po_id: 'PO-S03-B-01',
                        behavior: 'Slice B behavior.',
                        public_seam: 'Seam B.',
                        oracle_source: 'oracle B.',
                        success_criteria: 'success when Z.',
                        required_observation: 'observe Z.',
                        applicable_risk_facts: [],
                    },
                ],
                tasks: ['S03-B-T01', 'S03-B-T02'],
                risk_facts: ['persistent_state: true'],
                evidence_path: 'delivery/stages/S03/evidence/S03-B.md',
                cv_minimum_level: 'standard',
            },
        ],
        dependencies: [],
        risk_facts: ['public_api_change: true'],
    };
}
function errorTypes(result) {
    return result.errors.map((e) => e.type);
}
// ============================================================
// validateStage — success behaviors
// ============================================================
(0, vitest_1.describe)('validateStage (Planner mechanical gatekeeper, PO-S03-H-01)', () => {
    (0, vitest_1.it)('passes a structurally valid acyclic stage', () => {
        const fx = makeFx();
        const tasksPath = fx.writeTasks(validTasksMd());
        const result = (0, validate_stage_1.validateStage)(tasksPath);
        (0, vitest_1.expect)(result.valid).toBe(true);
        (0, vitest_1.expect)(result.stage_id).toBe('S03');
        (0, vitest_1.expect)(result.errors).toEqual([]);
    });
    (0, vitest_1.it)('passes when the provided compiled manifest is consistent with the tasks', () => {
        const fx = makeFx();
        const tasksPath = fx.writeTasks(validTasksMd());
        const manifestPath = fx.writeManifest(compiledManifest());
        const result = (0, validate_stage_1.validateStage)(tasksPath, manifestPath);
        (0, vitest_1.expect)(result.valid).toBe(true);
        (0, vitest_1.expect)(result.errors).toEqual([]);
    });
    (0, vitest_1.it)('reports a compile failure as an error (unclosed slice region)', () => {
        const fx = makeFx();
        const bad = validTasksMd().replace('<!-- SLICE:S03-A:END -->', '');
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(bad));
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('UNCLOSED_SLICE');
    });
    (0, vitest_1.it)('rejects duplicate slice ids', () => {
        const fx = makeFx();
        const dup = validTasksMd() + `
## Slice S03-A — Duplicate Slice

<!-- SLICE:S03-A:BEGIN -->

### Goal

Duplicate A.

### Observable Outcome

Duplicate A outcome.

### Public Seam

Seam A.

### Risk Facts

- persistent_state: true

### Tasks

- [ ] S03-A-T99: dup task

<!-- SLICE:S03-A:END -->
`;
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(dup));
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('DUPLICATE_ID');
    });
    (0, vitest_1.it)('rejects duplicate PO ids within PO sections', () => {
        const fx = makeFx();
        const dup = validTasksMd().replace('- PO-S03-B-01\n  - Behavior: Slice B behavior.', '- PO-S03-B-01\n  - Behavior: Slice B behavior.\n  - Oracle Source: o2.\n- PO-S03-B-01\n  - Behavior: dup behavior.\n  - Oracle Source: o3.');
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(dup));
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('DUPLICATE_ID');
    });
    (0, vitest_1.it)('rejects a dependency cycle (CYCLE_DETECTED)', () => {
        const fx = makeFx();
        const cyclic = validTasksMd().replace('### Dependencies\n\n- S03-A', '### Dependencies\n\n- S03-A');
        // make B depend on A and A depend on B (introduce cycle via A section)
        const cyclic2 = cyclic.replace('### Dependencies\n\n- 无内部依赖。', '### Dependencies\n\n- S03-B');
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(cyclic2));
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('CYCLE_DETECTED');
    });
    (0, vitest_1.it)('rejects a dependency on a slice absent from the Stage closure', () => {
        const fx = makeFx();
        const undeclared = validTasksMd().replace('- S03-A\n\n### Risk Facts', '- S03-Z\n\n### Risk Facts');
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(undeclared));
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('UNDECLARED_DEPENDENCY');
    });
    (0, vitest_1.it)('rejects a PO whose Oracle Source is declared but empty', () => {
        const fx = makeFx();
        const emptyPo = validTasksMd().replace('- Oracle Source: oracle A.', '- Oracle Source:');
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(emptyPo));
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('MISSING_ORACLE_VALUE');
    });
    (0, vitest_1.it)('rejects a task id mentioned outside any slice Tasks section', () => {
        const fx = makeFx();
        const stray = validTasksMd().replace('## Slice S03-A — Slice A', '## Slice S03-A — Slice A\n\n(reference to S03-A-T99 outside the Tasks section)');
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(stray));
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('TASK_OUTSIDE_SLICE');
    });
    (0, vitest_1.it)('rejects a provided manifest whose stage_id mismatches the tasks.md', () => {
        const fx = makeFx();
        const manifest = compiledManifest();
        manifest.stage_id = 'S99';
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(validTasksMd()), fx.writeManifest(manifest));
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('STAGE_ID_MISMATCH');
    });
    (0, vitest_1.it)('rejects a provided manifest whose slice set differs from the compiled one', () => {
        const fx = makeFx();
        const manifest = compiledManifest();
        manifest.slices = manifest.slices.slice(0, 1);
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(validTasksMd()), fx.writeManifest(manifest));
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('SLICE_SET_MISMATCH');
    });
    (0, vitest_1.it)('reports missing / orphaned evidence files when an evidence dir is given', () => {
        const fx = makeFx();
        const evidenceDir = path.join(fx.dir, 'evidence');
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(path.join(evidenceDir, 'S03-A.md'), '# S03-A evidence\n', 'utf-8');
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(validTasksMd()), undefined, evidenceDir);
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('MISSING_EVIDENCE_FILE');
        // now add the second evidence file and an orphan
        fs.writeFileSync(path.join(evidenceDir, 'S03-B.md'), '# S03-B evidence\n', 'utf-8');
        fs.writeFileSync(path.join(evidenceDir, 'S03-ORPHAN.md'), '# orphan\n', 'utf-8');
        const result2 = (0, validate_stage_1.validateStage)(fx.writeTasks(validTasksMd()), undefined, evidenceDir);
        (0, vitest_1.expect)(result2.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result2)).toContain('ORPHANED_EVIDENCE_FILE');
        // remove the orphan → valid
        fs.unlinkSync(path.join(evidenceDir, 'S03-ORPHAN.md'));
        const result3 = (0, validate_stage_1.validateStage)(fx.writeTasks(validTasksMd()), undefined, evidenceDir);
        (0, vitest_1.expect)(result3.valid).toBe(true);
    });
    (0, vitest_1.it)('reports a missing evidence directory', () => {
        const fx = makeFx();
        const result = (0, validate_stage_1.validateStage)(fx.writeTasks(validTasksMd()), undefined, '/nonexistent/evidence');
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(result)).toContain('EVIDENCE_DIR_NOT_FOUND');
    });
    (0, vitest_1.it)('fails closed when the tasks file is unreadable', () => {
        const result = (0, validate_stage_1.validateStage)('/nonexistent/tasks.md');
        (0, vitest_1.expect)(result.valid).toBe(false);
        (0, vitest_1.expect)(result.errors.length).toBeGreaterThan(0);
    });
});
// ============================================================
// CLI entry (dist script)
// ============================================================
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_CLI = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'validate-stage.js');
(0, vitest_1.describe)('validate-stage.js dist script (old-CLI contract)', () => {
    (0, vitest_1.it)('exits 1 with a usage error when invoked without args', () => {
        (0, vitest_1.expect)(fs.existsSync(DIST_CLI)).toBe(true);
        const res = (0, node_child_process_1.spawnSync)(process.execPath, [DIST_CLI], { encoding: 'utf-8' });
        (0, vitest_1.expect)(res.status).toBe(1);
        (0, vitest_1.expect)((res.stderr + res.stdout).toLowerCase()).toContain('usage:');
    });
    (0, vitest_1.it)('exits 0 with a JSON result for a valid stage', () => {
        (0, vitest_1.expect)(fs.existsSync(DIST_CLI)).toBe(true);
        const fx = makeFx();
        const tasksPath = fx.writeTasks(validTasksMd());
        const manifestPath = fx.writeManifest(compiledManifest());
        const res = (0, node_child_process_1.spawnSync)(process.execPath, [DIST_CLI, tasksPath, manifestPath], {
            encoding: 'utf-8',
            timeout: 30000,
        });
        (0, vitest_1.expect)(res.status).toBe(0);
        const out = JSON.parse(res.stdout);
        (0, vitest_1.expect)(out.valid).toBe(true);
        (0, vitest_1.expect)(out.stage_id).toBe('S03');
    });
    (0, vitest_1.it)('exits 1 with a JSON result listing errors for an invalid stage', () => {
        (0, vitest_1.expect)(fs.existsSync(DIST_CLI)).toBe(true);
        const fx = makeFx();
        const bad = validTasksMd().replace('<!-- SLICE:S03-A:END -->', '');
        const tasksPath = fx.writeTasks(bad);
        const manifestPath = fx.writeManifest(compiledManifest());
        const res = (0, node_child_process_1.spawnSync)(process.execPath, [DIST_CLI, tasksPath, manifestPath], {
            encoding: 'utf-8',
            timeout: 30000,
        });
        (0, vitest_1.expect)(res.status).toBe(1);
        const out = JSON.parse(res.stdout);
        (0, vitest_1.expect)(out.valid).toBe(false);
        (0, vitest_1.expect)(errorTypes(out)).toContain('UNCLOSED_SLICE');
    });
});
//# sourceMappingURL=validate-stage.spec.js.map