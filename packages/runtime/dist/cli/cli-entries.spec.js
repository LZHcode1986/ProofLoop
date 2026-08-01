"use strict";
/**
 * cli-entries.spec.ts — PO-S03-H-01 call matrix (S03-H-T01)
 *
 * Call matrix (success + failure case per entry) for the six remaining new
 * runtime CLI entries:
 *
 *   initialize-slice-evidence  — skeleton creation, no-overwrite, traversal guard
 *   next-action                — path-only input → NextActionService output
 *   sync-cv-status             — reconcile-derived CV status (read-only)
 *   admit                      — 7 S02 admit operations through the pipeline
 *   prepare-gate-facts         — reconcile + git clean + HEAD + integrated
 *   run-gate                   — runtime_proof step execution (minimal, HP-004)
 *
 * plus the dist-script usage matrix for all eight entries (callable via
 * `node packages/runtime/dist/cli/<tool>.js` with the legacy arg contract).
 *
 * No mocks: real temp dirs / real git repos / real receipts. Forbidden
 * shortcut covered: the next-action and admit entries MUST go through the
 * runtime services (NextActionService / S02 admit methods) — the assertions
 * verify the service-contract output shapes, not ad-hoc derivation.
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
const runtime_1 = require("@proofloop/runtime");
const initialize_slice_evidence_1 = require("./initialize-slice-evidence");
const next_action_1 = require("./next-action");
const sync_cv_status_1 = require("./sync-cv-status");
const admit_1 = require("./admit");
const prepare_gate_facts_1 = require("./prepare-gate-facts");
const run_gate_1 = require("./run-gate");
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
const STAGE_ID = 'S03';
const SLICE_ID = 'S03-H';
const TASKS = ['S03-H-T01', 'S03-H-T02'];
const FAKE_SHA = 'a'.repeat(40);
function sliceDef(sid, taskIds) {
    return {
        slice_id: sid,
        goal: 'CLI entries',
        observable_outcome: 'callable CLI entries with zero host deps',
        public_seam: 'packages/runtime/dist/cli',
        dependencies: [],
        proof_obligations: [
            {
                po_id: 'PO-S03-H-01',
                behavior: 'CLI call matrix',
                public_seam: 'dist cli entries',
                oracle_source: 'legacy CLI contract',
                success_criteria: 'success + failure cases pass',
                required_observation: 'fixture oracle',
                applicable_risk_facts: ['public_api_change'],
            },
        ],
        tasks: [...taskIds],
        risk_facts: ['persistent_state'],
        evidence_path: `delivery/stages/${STAGE_ID}/evidence/${sid}.md`,
        cv_minimum_level: 'enhanced',
    };
}
function makeManifest(slices = [sliceDef(SLICE_ID, TASKS)]) {
    return {
        stage_id: STAGE_ID,
        source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'Runtime CLI surface',
        outcomes: ['8 callable CLI entries'],
        slices,
        dependencies: [],
        risk_facts: ['public_api_change: true'],
    };
}
function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-entries-'));
    (0, node_child_process_1.execFileSync)('git', ['init', '-q', root]);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.email', 'cli@test.local']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.name', 'Cli Test']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
    const fx = {
        root,
        stageId,
        sliceId,
        write: (rel, content) => {
            const p = path.join(root, rel);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content, 'utf-8');
        },
        writeManifest: (slices) => {
            const manifest = makeManifest(slices ?? [sliceDef(sliceId, TASKS)]);
            fx.write(`.proofloop/manifests/${stageId}.json`, JSON.stringify(manifest, null, 2));
        },
        writeTasksMd: (checkedTasks) => {
            const lines = TASKS.map((t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`);
            const content = `# Stage ${stageId} — Runtime\n\n` +
                `## Slice ${sliceId}\n` +
                `<!-- SLICE:${sliceId}:BEGIN -->\n\n` +
                `### Tasks\n\n${lines.join('\n')}\n\n` +
                `<!-- SLICE:${sliceId}:END -->\n`;
            fx.write(`delivery/stages/${stageId}/tasks.md`, content);
        },
        writeEvidence: (finalized) => {
            const partial = `# Slice ${sliceId} Evidence\n\n` +
                `## Task Evidence\n\n### ${TASKS[0]}\n\n- Status: COMPLETE\n\n` +
                `## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
                `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
                `|---|---|---|---|---|\n| *None* | | | | |\n` +
                `\n## Current CV Status\n\n- Status: NOT_RUN\n- Level: *Not yet determined*\n- Latest CV Receipt: *None*\n- Open Finding: *None*\n`;
            const finalizedContent = `# Slice ${sliceId} Evidence\n\n` +
                `## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
                `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n` +
                `### Proof Obligation Coverage\n\n` +
                `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
                `|---|---|---|---|---|\n| PO-S03-H-01 | cli-entries.spec.ts | yes | yes | pass |\n\n` +
                `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n` +
                `\n## Current CV Status\n\n- Status: NOT_RUN\n- Level: *Not yet determined*\n- Latest CV Receipt: *None*\n- Open Finding: *None*\n`;
            fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, finalized ? finalizedContent : partial);
        },
        seedReceipt: (category, overrides) => {
            const dir = (0, runtime_1.receiptCategoryDir)(root, category, stageId, sliceId);
            fs.mkdirSync(dir, { recursive: true });
            return (0, kernel_1.writeReceipt)({
                version: 1,
                type: 'TASK_COMPLETE',
                stage_id: stageId,
                slice_id: sliceId,
                timestamp: '2025-01-01T00:00:00.000Z',
                payload: {},
                ...overrides,
            }, { receiptDir: dir, tempDir: dir });
        },
        commitAll: (message = 'fixture') => {
            (0, node_child_process_1.execFileSync)('git', ['-C', root, 'add', '-A']);
            (0, node_child_process_1.execFileSync)('git', ['-C', root, 'commit', '-q', '-m', message]);
            return fx.head();
        },
        head: () => (0, node_child_process_1.execFileSync)('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
        reconcile: () => (0, runtime_1.reconcileStage)({ projectRoot: root, stageId }),
        cleanup: () => {
            try {
                fs.rmSync(root, { recursive: true, force: true });
            }
            catch {
                // best-effort
            }
        },
    };
    cleanups.push(fx.cleanup);
    return fx;
}
/** Build an INTEGRATED slice: CV_PASS → SLICE_COMMIT → INTEGRATION_PASS. */
function fxIntegrated() {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    const cv = fx.seedReceipt('cv', {
        type: 'CV_PASS',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: { verdict: 'PASS', snapshot_digest: FAKE_SHA, summary: 'pass' },
    });
    const commit = fx.seedReceipt('committer', {
        type: 'SLICE_COMMIT',
        timestamp: '2025-01-02T00:00:00.000Z',
        payload: { status: 'committed', slice_commit_sha: FAKE_SHA, cv_receipt_digest: cv.digest },
    });
    fx.seedReceipt('integration', {
        type: 'INTEGRATION_PASS',
        timestamp: '2025-01-03T00:00:00.000Z',
        payload: { status: 'integrated', slice_commit_sha: FAKE_SHA },
    });
    void commit;
    fx.commitAll();
    return fx;
}
// ============================================================
// initialize-slice-evidence
// ============================================================
(0, vitest_1.describe)('initialize-slice-evidence (PO-S03-H-01)', () => {
    (0, vitest_1.it)('creates the standard evidence skeleton for every slice', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-init-ev-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const manifest = makeManifest([sliceDef('S03-A', ['S03-A-T01']), sliceDef('S03-B', ['S03-B-T01'])]);
        const result = (0, initialize_slice_evidence_1.initializeSliceEvidence)({ manifest, deliveryRoot: dir });
        (0, vitest_1.expect)(result.errors).toEqual([]);
        (0, vitest_1.expect)(result.created).toHaveLength(2);
        (0, vitest_1.expect)(result.skipped).toEqual([]);
        for (const slice of manifest.slices) {
            const p = path.join(dir, slice.evidence_path);
            (0, vitest_1.expect)(fs.existsSync(p)).toBe(true);
            const content = fs.readFileSync(p, 'utf-8');
            (0, vitest_1.expect)(content).toContain(`# Slice ${slice.slice_id} Evidence`);
            (0, vitest_1.expect)(content).toContain('## Current CV Status');
            (0, vitest_1.expect)(content).toContain('## Task Evidence');
        }
    });
    (0, vitest_1.it)('never overwrites an existing non-empty evidence file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-init-ev-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const manifest = makeManifest();
        const evidencePath = path.join(dir, manifest.slices[0].evidence_path);
        fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
        fs.writeFileSync(evidencePath, 'PRECIOUS CONTENT', 'utf-8');
        const result = (0, initialize_slice_evidence_1.initializeSliceEvidence)({ manifest, deliveryRoot: dir });
        (0, vitest_1.expect)(result.created).toEqual([]);
        (0, vitest_1.expect)(result.skipped).toHaveLength(1);
        (0, vitest_1.expect)(fs.readFileSync(evidencePath, 'utf-8')).toBe('PRECIOUS CONTENT');
    });
    (0, vitest_1.it)('rejects evidence paths that escape the canonical evidence directory', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-init-ev-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const manifest = makeManifest();
        manifest.slices[0] = {
            ...manifest.slices[0],
            evidence_path: 'delivery/stages/S03/evidence/../S03-H.md',
        };
        const result = (0, initialize_slice_evidence_1.initializeSliceEvidence)({ manifest, deliveryRoot: dir });
        (0, vitest_1.expect)(result.errors.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(result.created).toEqual([]);
    });
    (0, vitest_1.it)('rejects a non-canonical evidence_path pattern', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-init-ev-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const manifest = makeManifest();
        manifest.slices[0] = { ...manifest.slices[0], evidence_path: 'custom/path.md' };
        const result = (0, initialize_slice_evidence_1.initializeSliceEvidence)({ manifest, deliveryRoot: dir });
        (0, vitest_1.expect)(result.errors.length).toBeGreaterThan(0);
    });
});
// ============================================================
// next-action
// ============================================================
(0, vitest_1.describe)('next-action (PO-S03-H-01)', () => {
    (0, vitest_1.it)('runs the NextActionService from a path-only input and returns the contract shape', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([]);
        fx.commitAll();
        const out = (0, next_action_1.nextActionFromInput)({
            stage_id: STAGE_ID,
            project_root: fx.root,
        });
        // proofloop_next contract — exactly the service output shape (the CLI
        // must NOT re-derive the action itself).
        (0, vitest_1.expect)(Object.keys(out).sort()).toEqual([
            'action',
            'action_detail',
            'findings',
            'receipt_chain_valid',
            'responsible_role',
        ]);
        (0, vitest_1.expect)(typeof out.action).toBe('string');
        (0, vitest_1.expect)(out.action_detail.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(typeof out.receipt_chain_valid).toBe('boolean');
        (0, vitest_1.expect)(Array.isArray(out.findings)).toBe(true);
    });
    (0, vitest_1.it)('accepts camelCase aliases for the path-only input', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([]);
        fx.commitAll();
        const out = (0, next_action_1.nextActionFromInput)({ stageId: STAGE_ID, projectRoot: fx.root });
        (0, vitest_1.expect)(out.action).toBeTruthy();
    });
    (0, vitest_1.it)('fails closed when the identity fields are missing', () => {
        (0, vitest_1.expect)(() => (0, next_action_1.nextActionFromInput)({ stage_id: STAGE_ID })).toThrow(/project_root/i);
        (0, vitest_1.expect)(() => (0, next_action_1.nextActionFromInput)({ project_root: '.' })).toThrow(/stage_id/i);
        (0, vitest_1.expect)(() => (0, next_action_1.nextActionFromInput)('nope')).toThrow(/object/i);
    });
});
// ============================================================
// sync-cv-status
// ============================================================
(0, vitest_1.describe)('sync-cv-status (PO-S03-H-01, read-only derive)', () => {
    (0, vitest_1.it)('derives the CV status snapshot from reconcile without writing anything', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([...TASKS]);
        fx.writeEvidence(true);
        fx.seedReceipt('tasks', { payload: { mode: 'finalize-slice' } });
        fx.commitAll();
        const evidenceContentBefore = fs.readFileSync(path.join(fx.root, `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`), 'utf-8');
        const out = (0, sync_cv_status_1.syncCvStatus)({ stageId: STAGE_ID, sliceId: SLICE_ID, projectRoot: fx.root });
        (0, vitest_1.expect)(out.success).toBe(true);
        (0, vitest_1.expect)(out.stage_id).toBe(STAGE_ID);
        (0, vitest_1.expect)(out.slice_id).toBe(SLICE_ID);
        (0, vitest_1.expect)(out.slice_state).toBe(kernel_1.SliceState.READY_FOR_CV);
        (0, vitest_1.expect)(out.cv_status).toBe(kernel_1.CVStatus.NOT_STARTED);
        (0, vitest_1.expect)(out.latest_cv_receipt).toBeNull();
        (0, vitest_1.expect)(out.cv_level).toBe('enhanced');
        (0, vitest_1.expect)(out.evidence_file_present).toBe(true);
        // read-only: the evidence file must be byte-identical
        (0, vitest_1.expect)(fs.readFileSync(path.join(fx.root, `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`), 'utf-8')).toBe(evidenceContentBefore);
    });
    (0, vitest_1.it)('reports CV_PASS receipt facts when a CV_PASS receipt exists', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([...TASKS]);
        fx.writeEvidence(true);
        fx.seedReceipt('tasks', { payload: { mode: 'finalize-slice' } });
        const cv = fx.seedReceipt('cv', {
            type: 'CV_PASS',
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: { verdict: 'PASS', snapshot_digest: FAKE_SHA, summary: 'pass' },
        });
        fx.commitAll();
        const out = (0, sync_cv_status_1.syncCvStatus)({ stageId: STAGE_ID, sliceId: SLICE_ID, projectRoot: fx.root });
        (0, vitest_1.expect)(out.success).toBe(true);
        (0, vitest_1.expect)(out.cv_status).toBe(kernel_1.CVStatus.PASS);
        (0, vitest_1.expect)(out.latest_cv_receipt?.type).toBe('CV_PASS');
        (0, vitest_1.expect)(out.latest_cv_receipt?.digest).toBe(cv.digest);
        (0, vitest_1.expect)(out.open_finding).toBeNull();
    });
    (0, vitest_1.it)('reports an open finding for a CV_REPAIR receipt', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([...TASKS]);
        fx.writeEvidence(true);
        fx.seedReceipt('tasks', { payload: { mode: 'finalize-slice' } });
        fx.seedReceipt('cv', {
            type: 'CV_REPAIR',
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: { verdict: 'REPAIR', snapshot_digest: FAKE_SHA, summary: 'scope gap' },
        });
        fx.commitAll();
        const out = (0, sync_cv_status_1.syncCvStatus)({ stageId: STAGE_ID, sliceId: SLICE_ID, projectRoot: fx.root });
        (0, vitest_1.expect)(out.success).toBe(true);
        (0, vitest_1.expect)(out.cv_status).toBe(kernel_1.CVStatus.REPAIR);
        (0, vitest_1.expect)(out.latest_cv_receipt?.type).toBe('CV_REPAIR');
        (0, vitest_1.expect)(out.open_finding).toContain('scope gap');
    });
    (0, vitest_1.it)('fails closed for an unknown slice', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([]);
        fx.commitAll();
        const out = (0, sync_cv_status_1.syncCvStatus)({ stageId: STAGE_ID, sliceId: 'S99-Z', projectRoot: fx.root });
        (0, vitest_1.expect)(out.success).toBe(false);
        (0, vitest_1.expect)(out.error).toMatch(/not found/i);
    });
});
// ============================================================
// admit
// ============================================================
(0, vitest_1.describe)('admit (PO-S03-H-01, 7 S02 operations)', () => {
    (0, vitest_1.it)('admits a completed worker result through the pipeline and writes a chain-verified receipt', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([TASKS[0]]);
        fx.writeEvidence(false);
        fx.commitAll();
        const result = (0, admit_1.admitRequest)({
            type: 'worker_result',
            envelope: {
                schemaVersion: 1,
                actionToken: 'tok-cli-1',
                stageId: STAGE_ID,
                sliceId: SLICE_ID,
                taskId: TASKS[0],
                mode: 'implement-task',
                outcome: 'completed',
                evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
                changedFiles: ['packages/runtime/src/cli/admit.ts'],
                verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
                summary: 'implemented via CLI',
            },
        }, fx.root);
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).toBeTruthy();
        (0, vitest_1.expect)(result.new_state).not.toBeNull();
        // post-write chain verification over the real category directory
        const dir = (0, runtime_1.receiptCategoryDir)(fx.root, 'tasks', STAGE_ID, SLICE_ID);
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(dir).valid).toBe(true);
        // fresh reconcile readback: slice still IN_PROGRESS after implement-task
        const state = fx.reconcile();
        const slice = state.slices.find((s) => s.slice_id === SLICE_ID);
        (0, vitest_1.expect)(slice?.slice_state).toBe(kernel_1.SliceState.IN_PROGRESS);
    });
    (0, vitest_1.it)('structurally rejects a cv_result admit when the slice is not in a CV state', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([TASKS[0]]);
        fx.writeEvidence(false);
        fx.commitAll();
        const result = (0, admit_1.admitRequest)({
            type: 'cv_result',
            stageId: STAGE_ID,
            sliceId: SLICE_ID,
            verdict: 'PASS',
            snapshotDigest: FAKE_SHA,
            summary: 'cv pass',
        }, fx.root);
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
    });
    (0, vitest_1.it)('fails closed for an unknown admit kind (SLICE_PLAN reserved for S04)', () => {
        const fx = makeFx();
        (0, vitest_1.expect)(() => (0, admit_1.admitRequest)({ type: 'slice_plan', stageId: STAGE_ID, sliceId: SLICE_ID }, fx.root)).toThrow(/reserved for S04/i);
    });
});
// ============================================================
// prepare-gate-facts
// ============================================================
(0, vitest_1.describe)('prepare-gate-facts (PO-S03-H-01)', () => {
    (0, vitest_1.it)('writes slice-complete facts for an all-integrated clean stage', () => {
        const fx = fxIntegrated();
        const input = {
            stage_id: STAGE_ID,
            project_root: fx.root,
            manifest_path: `.proofloop/manifests/${STAGE_ID}.json`,
            tasks_path: `delivery/stages/${STAGE_ID}/tasks.md`,
        };
        const result = (0, prepare_gate_facts_1.prepareGateFacts)(input);
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.path).toContain(`.proofloop${path.sep}runtime${path.sep}${STAGE_ID}${path.sep}slice-complete-facts.json`);
        (0, vitest_1.expect)(fs.existsSync(result.path)).toBe(true);
        const facts = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
        (0, vitest_1.expect)(facts).toHaveLength(1);
        (0, vitest_1.expect)(facts[0]['slice_id']).toBe(SLICE_ID);
        (0, vitest_1.expect)(facts[0]['integrated']).toBe(true);
        (0, vitest_1.expect)(facts[0]['git_clean']).toBe(true);
        (0, vitest_1.expect)(facts[0]['head_sha']).toBe(fx.head());
    });
    (0, vitest_1.it)('refuses when a slice is not integrated (no facts file written)', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([...TASKS]);
        fx.writeEvidence(true);
        fx.commitAll();
        const result = (0, prepare_gate_facts_1.prepareGateFacts)({ stage_id: STAGE_ID, project_root: fx.root });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/not every slice is integrated/i);
        (0, vitest_1.expect)(fs.existsSync(path.join(fx.root, '.proofloop', 'runtime', STAGE_ID, 'slice-complete-facts.json'))).toBe(false);
    });
    (0, vitest_1.it)('refuses when the working tree is not clean', () => {
        const fx = fxIntegrated();
        fx.write('uncommitted.txt', 'dirty');
        const result = (0, prepare_gate_facts_1.prepareGateFacts)({ stage_id: STAGE_ID, project_root: fx.root });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/not clean/i);
    });
    (0, vitest_1.it)('fails closed on missing identity fields', () => {
        const result = (0, prepare_gate_facts_1.prepareGateFacts)({ stage_id: '', project_root: '' });
        (0, vitest_1.expect)(result.success).toBe(false);
    });
});
// ============================================================
// run-gate
// ============================================================
function gateManifest(steps) {
    return {
        ...makeManifest(),
        runtime_proof: steps,
    };
}
(0, vitest_1.describe)('run-gate (PO-S03-H-01, minimal HP-004)', () => {
    (0, vitest_1.it)('PASSes when every slice fact is present and every step exits as expected', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const manifest = gateManifest([
            {
                id: 'ok',
                type: 'command',
                executable: 'node',
                args: ['-e', 'process.exit(0)'],
                cwd: '.',
                timeout_ms: 10000,
                expected: { exit_code: 0 },
            },
            {
                id: 'na',
                type: 'service_start',
                executable: 'node',
                args: ['--version'],
                cwd: '.',
                timeout_ms: 10000,
                not_applicable: { reason: 'library-only stage' },
            },
        ]);
        const manifestPath = path.join(dir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        const factsPath = path.join(dir, 'facts.json');
        fs.writeFileSync(factsPath, JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
        const result = (0, run_gate_1.runGate)({ manifestPath, factsPath, outputDir: path.join(dir, 'out'), projectRoot: dir });
        (0, vitest_1.expect)(result.gate).toBe('PASS');
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.errors).toEqual([]);
        (0, vitest_1.expect)(result.steps[0]).toMatchObject({ id: 'ok', passed: true, exit_code: 0 });
        (0, vitest_1.expect)(result.steps[1]).toMatchObject({ id: 'na', passed: true, skipped: true });
        // result file written
        (0, vitest_1.expect)(fs.existsSync(result.output_path)).toBe(true);
        const written = JSON.parse(fs.readFileSync(result.output_path, 'utf-8'));
        (0, vitest_1.expect)(written.gate).toBe('PASS');
    });
    (0, vitest_1.it)('FAILs when a step exits with a non-expected code', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const manifest = gateManifest([
            {
                id: 'boom',
                type: 'command',
                executable: 'node',
                args: ['-e', 'process.exit(3)'],
                cwd: '.',
                timeout_ms: 10000,
                expected: { exit_code: 0 },
            },
        ]);
        const manifestPath = path.join(dir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        const factsPath = path.join(dir, 'facts.json');
        fs.writeFileSync(factsPath, JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
        const result = (0, run_gate_1.runGate)({ manifestPath, factsPath, outputDir: path.join(dir, 'out'), projectRoot: dir });
        (0, vitest_1.expect)(result.gate).toBe('FAIL');
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.steps[0].exit_code).toBe(3);
        (0, vitest_1.expect)(result.errors.join(' ')).toContain('exited 3');
    });
    (0, vitest_1.it)('FAILs when a manifest slice has no integrated fact', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const manifestPath = path.join(dir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(makeManifest(), null, 2), 'utf-8');
        const factsPath = path.join(dir, 'facts.json');
        fs.writeFileSync(factsPath, JSON.stringify([]), 'utf-8');
        const result = (0, run_gate_1.runGate)({ manifestPath, factsPath, projectRoot: dir });
        (0, vitest_1.expect)(result.gate).toBe('FAIL');
        (0, vitest_1.expect)(result.errors.join(' ')).toContain('no COMPLETE fact');
    });
    (0, vitest_1.it)('FAILs on a fact for an undeclared slice (stale facts refused)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const manifestPath = path.join(dir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(makeManifest(), null, 2), 'utf-8');
        const factsPath = path.join(dir, 'facts.json');
        fs.writeFileSync(factsPath, JSON.stringify([{ slice_id: SLICE_ID, integrated: true }, { slice_id: 'S03-OLD', integrated: true }]), 'utf-8');
        const result = (0, run_gate_1.runGate)({ manifestPath, factsPath, projectRoot: dir });
        (0, vitest_1.expect)(result.gate).toBe('FAIL');
        (0, vitest_1.expect)(result.errors.join(' ')).toContain('undeclared slice');
    });
    (0, vitest_1.it)('FAILs on an active service step (deferred to S04, honest fail-closed)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const manifest = gateManifest([
            {
                id: 'svc',
                type: 'service_start',
                executable: 'node',
                args: ['server.js'],
                cwd: '.',
                timeout_ms: 10000,
            },
        ]);
        const manifestPath = path.join(dir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        const factsPath = path.join(dir, 'facts.json');
        fs.writeFileSync(factsPath, JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
        const result = (0, run_gate_1.runGate)({ manifestPath, factsPath, projectRoot: dir });
        (0, vitest_1.expect)(result.gate).toBe('FAIL');
        (0, vitest_1.expect)(result.errors.join(' ')).toContain('HP-004');
    });
    (0, vitest_1.it)('FAILs closed when the manifest or facts file is unreadable/invalid', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const badManifest = { ...makeManifest(), stage_id: 42 };
        const manifestPath = path.join(dir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(badManifest), 'utf-8');
        const factsPath = path.join(dir, 'facts.json');
        fs.writeFileSync(factsPath, JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
        const result = (0, run_gate_1.runGate)({ manifestPath, factsPath, projectRoot: dir });
        (0, vitest_1.expect)(result.gate).toBe('FAIL');
        (0, vitest_1.expect)(result.errors.join(' ')).toMatch(/manifest/i);
    });
    (0, vitest_1.it)('kernel oracle: gateManifest output is a valid Manifest', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)(gateManifest([]))).not.toThrow();
    });
});
// ============================================================
// dist-script usage matrix — all 8 entries callable via dist
// ============================================================
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_CLI_DIR = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli');
const CLI_TOOLS = [
    'compile-manifest',
    'validate-stage',
    'initialize-slice-evidence',
    'next-action',
    'sync-cv-status',
    'admit',
    'prepare-gate-facts',
    'run-gate',
];
(0, vitest_1.describe)('dist script callability matrix (PO-S03-H-01: node packages/runtime/dist/cli/<tool>.js)', () => {
    for (const tool of CLI_TOOLS) {
        (0, vitest_1.it)(`${tool}.js loads and enforces the usage contract (exit 1 + usage text without args)`, () => {
            const distPath = path.join(DIST_CLI_DIR, `${tool}.js`);
            (0, vitest_1.expect)(fs.existsSync(distPath)).toBe(true);
            const res = (0, node_child_process_1.spawnSync)(process.execPath, [distPath], { encoding: 'utf-8' });
            (0, vitest_1.expect)(res.status).toBe(1);
            (0, vitest_1.expect)((res.stderr + res.stdout).toLowerCase()).toContain('usage:');
        });
    }
    (0, vitest_1.it)('dist scripts contain no host-dependency imports (@earendil-works / .agents)', () => {
        for (const tool of CLI_TOOLS) {
            const distPath = path.join(DIST_CLI_DIR, `${tool}.js`);
            const src = fs.readFileSync(distPath, 'utf-8');
            (0, vitest_1.expect)(src).not.toContain('@earendil-works');
            (0, vitest_1.expect)(src).not.toContain('.agents/');
        }
    });
    (0, vitest_1.it)('admit.js runs a structured rejection through the pipeline and exits 1', () => {
        const distPath = path.join(DIST_CLI_DIR, 'admit.js');
        (0, vitest_1.expect)(fs.existsSync(distPath)).toBe(true);
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([TASKS[0]]);
        fx.writeEvidence(false);
        fx.commitAll();
        const requestPath = path.join(fx.root, 'request.json');
        fs.writeFileSync(requestPath, JSON.stringify({
            type: 'cv_result',
            stageId: STAGE_ID,
            sliceId: SLICE_ID,
            verdict: 'PASS',
            snapshotDigest: FAKE_SHA,
            summary: 'cv pass',
        }), 'utf-8');
        const res = (0, node_child_process_1.spawnSync)(process.execPath, [distPath, requestPath, fx.root], {
            encoding: 'utf-8',
            timeout: 30000,
        });
        (0, vitest_1.expect)(res.status).toBe(1);
        const out = JSON.parse(res.stdout);
        (0, vitest_1.expect)(out.accepted).toBe(false);
    });
    (0, vitest_1.it)('next-action.js runs the service over a real fixture and exits 0', () => {
        const distPath = path.join(DIST_CLI_DIR, 'next-action.js');
        (0, vitest_1.expect)(fs.existsSync(distPath)).toBe(true);
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([]);
        fx.commitAll();
        const inputPath = path.join(fx.root, 'input.json');
        fs.writeFileSync(inputPath, JSON.stringify({ stage_id: STAGE_ID, project_root: fx.root }), 'utf-8');
        const res = (0, node_child_process_1.spawnSync)(process.execPath, [distPath, inputPath], {
            encoding: 'utf-8',
            timeout: 30000,
        });
        (0, vitest_1.expect)(res.status).toBe(0);
        const out = JSON.parse(res.stdout);
        (0, vitest_1.expect)(typeof out.action).toBe('string');
        (0, vitest_1.expect)(out.action.length).toBeGreaterThan(0);
    });
});
//# sourceMappingURL=cli-entries.spec.js.map