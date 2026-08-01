"use strict";
/**
 * admission-methods.spec.ts — S02-E-T02 (PO-S02-E-02 / PO-S02-E-03)
 *
 * Public seam: `@proofloop/runtime` — `admitWorkerResult` and
 * `admitCVResult` (the slice-boundary admit methods wired onto the unified
 * S02-E-T01 pipeline). Filesystem integration: real temp git repos with the
 * canonical `.proofloop` layout, kernel `writeReceipt`-produced receipts,
 * `verifyReceiptChain` per category chain, and fresh `reconcileStage`
 * readback as the oracle (AWI-006 — every successful admit is chain-verified
 * and read back as the corresponding fact; every refusal produces NO
 * Receipt).
 *
 * Covered in this task:
 *  - admitWorkerResult (PO-S02-E-02): completed in the three modes
 *    implement / recover / finalize (evidence-finalized advance to
 *    READY_FOR_CV), repair / diagnose with the CV-REPAIR binding (cv
 *    FIX → PENDING_RECHECK), outcome blocked / needs-decision / failed
 *    refusal, wrong-state refusal (incl. repair without a CV_REPAIR
 *    binding), schema-invalid envelope refusal.
 *  - admitCVResult (PO-S02-E-03): PASS and REPAIR with the READY_FOR_CV
 *    precondition (composite transition sequence + reducer call sequence
 *    asserted via an injected spy), the CV_IN_PROGRESS runtime intermediate
 *    (dispatched step skipped), the PENDING_RECHECK recheck flow, wrong
 *    precondition refusal (incl. cv-REPAIR slice before repair), invalid
 *    payload refusal at the schema layer.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 tables, AWI-006, PO-S02-E-02/03) — not derived from the
 * implementation under test.
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
const kernel_2 = require("@proofloop/kernel");
const runtime_1 = require("@proofloop/runtime");
// ============================================================
// Known-good literals (authority excerpts — never derived)
// ============================================================
const STAGE_ID = 'S02';
const SLICE_ID = 'S02-E';
const TASKS = ['S02-E-T01', 'S02-E-T02'];
const COMMIT_SHA = 'a'.repeat(40);
const EVIDENCE_REF = 'delivery/stages/S02/evidence/S02-E.md';
function makeEnvelope(overrides = {}) {
    return {
        schemaVersion: 1,
        actionToken: 'tok-1',
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        taskId: 'S02-E-T01',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: EVIDENCE_REF,
        changedFiles: ['packages/runtime/src/admission.ts'],
        verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
        summary: 'implemented admitWorkerResult',
        ...overrides,
    };
}
function makeWorkerRequest(overrides = {}) {
    return { type: 'worker_result', envelope: makeEnvelope(overrides) };
}
function makeCvRequest(overrides = {}) {
    return {
        type: 'cv_result',
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        verdict: 'PASS',
        snapshotDigest: COMMIT_SHA,
        summary: 'cv pass',
        ...overrides,
    };
}
// ============================================================
// Fixture helpers (real temp dir + real git repo + canonical layout)
// ============================================================
const cleanups = [];
(0, vitest_1.afterEach)(() => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        fn?.();
    }
});
function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-admit-'));
    (0, node_child_process_1.execFileSync)('git', ['init', '-q', root]);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.email', 'admit@test.local']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.name', 'Admit Test']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
    const sliceDef = (sid, taskIds) => ({
        slice_id: sid,
        goal: 'AdmissionService 7 类 admit 操作',
        observable_outcome: 'deterministic admits with chain-verified receipts',
        public_seam: '@proofloop/runtime AdmissionService',
        dependencies: ['S02-A'],
        proof_obligations: [
            {
                po_id: 'PO-S02-E-02',
                behavior: 'admitWorkerResult all cases',
                public_seam: 'admitWorkerResult',
                oracle_source: 'real fixture project',
                success_criteria: 'receipt chain valid + reconcile readback',
                required_observation: 'fixture oracle',
                applicable_risk_facts: ['persistent_state', 'core_state_machine'],
            },
        ],
        tasks: [...taskIds],
        risk_facts: ['persistent_state'],
        evidence_path: `delivery/stages/${stageId}/evidence/${sid}.md`,
        cv_minimum_level: 'enhanced',
    });
    const fx = {
        root,
        stageId,
        sliceId,
        write: (rel, content) => {
            const p = path.join(root, rel);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content, 'utf-8');
        },
        writeManifest: () => {
            const manifest = {
                stage_id: stageId,
                source_path: `delivery/stages/${stageId}/tasks.md`,
                source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
                stage_goal: 'Runtime core application services',
                outcomes: ['deterministic admits'],
                slices: [sliceDef(sliceId, TASKS)],
                dependencies: [],
                risk_facts: [],
            };
            fx.write(`.proofloop/manifests/${stageId}.json`, JSON.stringify(manifest, null, 2));
        },
        writeTasksMd: (checkedTasks) => {
            const lines = TASKS.map((t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`);
            const content = `# Stage ${stageId} — Runtime Core\n\n` +
                `## Slice ${sliceId}\n` +
                `<!-- SLICE:${sliceId}:BEGIN -->\n\n` +
                `### Tasks\n\n${lines.join('\n')}\n\n` +
                `<!-- SLICE:${sliceId}:END -->\n`;
            fx.write(`delivery/stages/${stageId}/tasks.md`, content);
        },
        writeEvidence: (finalized, evidenceTasks = TASKS) => {
            const partial = `# Slice ${sliceId} Evidence\n\n` +
                `## Task Evidence\n\n### ${TASKS[0]}\n\n- Status: COMPLETE\n\n` +
                `## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
                `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
                `|---|---|---|---|---|\n| *None* | | | | |\n`;
            const finalizedContent = `# Slice ${sliceId} Evidence\n\n` +
                `## Task Evidence\n\n${evidenceTasks.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
                `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n` +
                `### Proof Obligation Coverage\n\n` +
                `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
                `|---|---|---|---|---|\n| PO-S02-E-02 | admission-methods.spec.ts | yes | yes | pass |\n\n` +
                `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`;
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
            return (0, node_child_process_1.execFileSync)('git', ['-C', root, 'rev-parse', 'HEAD'], {
                encoding: 'utf-8',
            }).trim();
        },
        reconcile: () => (0, runtime_1.reconcileStage)({ projectRoot: root, stageId }),
        cleanup: () => {
            try {
                fs.rmSync(root, { recursive: true, force: true });
            }
            catch {
                // best-effort cleanup
            }
        },
    };
    cleanups.push(fx.cleanup);
    return fx;
}
// ============================================================
// Fixture state builders (derived slice states)
// ============================================================
/** IN_PROGRESS: some tasks checked, evidence written but not finalized. */
function fxInProgress() {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([TASKS[0]]);
    fx.writeEvidence(false);
    fx.commitAll();
    return fx;
}
/**
 * Ready-for-finalize: all tasks checked + evidence finalized, NO receipts
 * → reconcile derives IN_PROGRESS (the finalize-slice TASK_COMPLETE receipt
 * is what advances the slice to READY_FOR_CV).
 */
function fxReadyForFinalize() {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.commitAll();
    return fx;
}
/**
 * READY_FOR_CV initial (no CV receipts): all tasks checked + evidence
 * finalized + a mode=finalize-slice TASK_COMPLETE receipt.
 */
function fxReadyForCvInitial() {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.seedReceipt('tasks', { payload: { mode: 'finalize-slice' } });
    fx.commitAll();
    return fx;
}
/** READY_FOR_CV + cv REPAIR: a CV_REPAIR receipt, no repair admitted yet. */
function fxCvRepair() {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    const seeded = fx.seedReceipt('cv', {
        type: 'CV_REPAIR',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: { verdict: 'REPAIR', snapshot_digest: 's1', summary: 'seed repair' },
    });
    fx.commitAll();
    return { fx, cvRepairDigest: seeded.digest };
}
/**
 * READY_FOR_CV + cv PENDING_RECHECK: CV_REPAIR plus a deterministically later
 * repair-mode TASK_COMPLETE (S02-C-T04 PENDING_RECHECK derivation).
 */
function fxPendingRecheck() {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    const seeded = fx.seedReceipt('cv', {
        type: 'CV_REPAIR',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: { verdict: 'REPAIR', snapshot_digest: 's1', summary: 'seed repair' },
    });
    fx.seedReceipt('tasks', {
        timestamp: '2025-01-02T00:00:00.000Z',
        payload: { mode: 'repair', cv_receipt_digest: seeded.digest },
    });
    fx.commitAll();
    return { fx, cvRepairDigest: seeded.digest };
}
/** CV_PASSED (negative precondition fixture): a CV_PASS receipt exists. */
function fxCvPassed() {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.seedReceipt('cv', {
        type: 'CV_PASS',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: { verdict: 'PASS', snapshot_digest: 's1', summary: 'seed pass' },
    });
    fx.commitAll();
    return fx;
}
/** Runtime intermediate state: slice CV_IN_PROGRESS + cv IN_PROGRESS. */
function cvInProgressState() {
    return {
        stage_id: STAGE_ID,
        slices: [
            {
                slice_id: SLICE_ID,
                dependencies: [],
                tasks: [],
                slice_state: kernel_2.SliceState.CV_IN_PROGRESS,
                cv_status: kernel_2.CVStatus.IN_PROGRESS,
                slice_evidence_finalized: true,
                repair_attempt: 0,
                scope_check_passed: false,
                committed: false,
                integrated: false,
                complete: false,
                latest_cv_receipt: null,
                latest_commit_receipt: null,
            },
        ],
        stage_state: kernel_1.StageState.EXECUTING,
        project_state: kernel_1.ProjectState.IN_PROGRESS,
        receipt_chain: [],
        findings: [],
        receipt_chain_valid: true,
        receipt_categories: [],
    };
}
// ============================================================
// Shared helpers
// ============================================================
function depsFor(fx, extra) {
    return { projectRoot: fx.root, ...extra };
}
/** Spy reducer — records the RuntimeAction call sequence (PO-S02-E-03). */
function spyReduce() {
    const calls = [];
    const reduce = (state, action) => {
        calls.push(action);
        return (0, runtime_1.reduceRuntimeAction)(state, action);
    };
    return { calls, reduce };
}
/** Read a written receipt file back from its category directory. */
function readReceiptFile(dir, digest) {
    const raw = fs.readFileSync(path.join(dir, `${digest}.json`), 'utf-8');
    return JSON.parse(raw);
}
function readTasksDir(fx) {
    return path.join(fx.root, '.proofloop', 'receipts', 'tasks', fx.stageId, fx.sliceId);
}
function readCvDir(fx) {
    return path.join(fx.root, '.proofloop', 'receipts', 'cv', fx.stageId, fx.sliceId);
}
// ============================================================
// admitWorkerResult (PO-S02-E-02)
// ============================================================
(0, vitest_1.describe)('admitWorkerResult (PO-S02-E-02)', () => {
    (0, vitest_1.it)('completed implement-task: TASK_COMPLETE receipt, slice stays IN_PROGRESS, chain valid, reconcile readback', () => {
        const fx = fxInProgress();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ mode: 'implement-task' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('IN_PROGRESS');
        // Receipt payload binds the envelope facts (PO-S02-E-02 binding).
        const receipt = readReceiptFile(readTasksDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.type).toBe('TASK_COMPLETE');
        (0, vitest_1.expect)(receipt.stage_id).toBe(STAGE_ID);
        (0, vitest_1.expect)(receipt.slice_id).toBe(SLICE_ID);
        (0, vitest_1.expect)(receipt.payload).toMatchObject({
            action_token: 'tok-1',
            mode: 'implement-task',
            evidence_ref: EVIDENCE_REF,
            changed_files: ['packages/runtime/src/admission.ts'],
            verification_runs: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
            summary: 'implemented admitWorkerResult',
        });
        // Chain verification + fresh reconcile readback (AWI-006 / PO-S02-E-01).
        const chain = (0, kernel_1.verifyReceiptChain)(readTasksDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(1);
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.slices[0]?.slice_state).toBe('IN_PROGRESS');
        (0, vitest_1.expect)(reread.receipt_chain).toContain(result.receipt_ref);
    });
    (0, vitest_1.it)('duplicate admit of the same actionToken refused (F-3 dedup) — chain keeps a single TASK_COMPLETE receipt', () => {
        const fx = fxInProgress();
        const envelope = makeEnvelope({ mode: 'implement-task' });
        const first = (0, runtime_1.admitWorkerResult)({ type: 'worker_result', envelope }, depsFor(fx));
        (0, vitest_1.expect)(first.accepted).toBe(true);
        (0, vitest_1.expect)(first.receipt_ref).not.toBeNull();
        // Receipts are immutable — the same actionToken envelope must never be
        // admitted twice: the second admit is refused before any write (F-3).
        const second = (0, runtime_1.admitWorkerResult)({ type: 'worker_result', envelope }, depsFor(fx));
        (0, vitest_1.expect)(second.accepted).toBe(false);
        (0, vitest_1.expect)(second.receipt_ref).toBeNull();
        (0, vitest_1.expect)(second.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(second.findings[0].message).toContain(envelope.actionToken);
        // The tasks/<stage>/<slice>/ chain still holds exactly ONE receipt.
        const chain = (0, kernel_1.verifyReceiptChain)(readTasksDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(1);
    });
    (0, vitest_1.it)('completed recover-task: TASK_COMPLETE receipt, slice stays IN_PROGRESS', () => {
        const fx = fxInProgress();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ mode: 'recover-task' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        const receipt = readReceiptFile(readTasksDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.payload).toMatchObject({ mode: 'recover-task' });
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readTasksDir(fx)).valid).toBe(true);
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('IN_PROGRESS');
    });
    (0, vitest_1.it)('completed finalize-slice: IN_PROGRESS + evidence finalized → READY_FOR_CV, readback READY_FOR_CV', () => {
        const fx = fxReadyForFinalize();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ mode: 'finalize-slice' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        // Reducer FINISH_TASKS composite advanced the slice.
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.cv_status).toBe('READY_FOR_CV');
        const receipt = readReceiptFile(readTasksDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.payload).toMatchObject({ mode: 'finalize-slice' });
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readTasksDir(fx)).valid).toBe(true);
        // Fresh reconcile derives READY_FOR_CV (all checked + evidence finalized
        // + mode=finalize-slice TASK_COMPLETE receipt).
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.slices[0]?.slice_state).toBe('READY_FOR_CV');
        (0, vitest_1.expect)(reread.slices[0]?.cv_status).toBe('NOT_STARTED');
        (0, vitest_1.expect)(reread.receipt_chain).toContain(result.receipt_ref);
    });
    (0, vitest_1.it)('finalize-slice refused when evidence is not finalized — no Receipt', () => {
        const fx = fxInProgress();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ mode: 'finalize-slice', taskId: TASKS[1] }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('IN_PROGRESS');
        // No receipt written.
        (0, vitest_1.expect)(fs.existsSync(readTasksDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('completed repair: CV-REPAIR binding → TASK_COMPLETE (mode=repair + cv_receipt_digest), cv FIX → PENDING_RECHECK, readback PENDING_RECHECK', () => {
        const { fx, cvRepairDigest } = fxCvRepair();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ mode: 'repair', taskId: TASKS[1], summary: 'repair done' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        // Slice stays READY_FOR_CV; cv REPAIR → FIX → PENDING_RECHECK.
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.cv_status).toBe('PENDING_RECHECK');
        const receipt = readReceiptFile(readTasksDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.payload).toMatchObject({
            mode: 'repair',
            cv_receipt_digest: cvRepairDigest,
        });
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readTasksDir(fx)).valid).toBe(true);
        // Fresh reconcile derives PENDING_RECHECK (repair TASK_COMPLETE after CV_REPAIR).
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.slices[0]?.slice_state).toBe('READY_FOR_CV');
        (0, vitest_1.expect)(reread.slices[0]?.cv_status).toBe('PENDING_RECHECK');
    });
    (0, vitest_1.it)('completed diagnose: CV-REPAIR binding → TASK_COMPLETE (mode=diagnose + cv_receipt_digest), cv FIX → PENDING_RECHECK', () => {
        const { fx, cvRepairDigest } = fxCvRepair();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ mode: 'diagnose', taskId: TASKS[1], summary: 'diagnosed' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.new_state?.slices[0]?.cv_status).toBe('PENDING_RECHECK');
        const receipt = readReceiptFile(readTasksDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.payload).toMatchObject({ mode: 'diagnose', cv_receipt_digest: cvRepairDigest });
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readTasksDir(fx)).valid).toBe(true);
        (0, vitest_1.expect)(fx.reconcile().slices[0]?.cv_status).toBe('PENDING_RECHECK');
    });
    (0, vitest_1.it)('repair refused without a CV_REPAIR receipt binding (READY_FOR_CV, no cv receipt) — no Receipt', () => {
        const fx = fxReadyForCvInitial();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ mode: 'repair', taskId: TASKS[1] }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('CV_REPAIR');
        // No new receipt in the tasks dir (the finalize-slice seed is untouched).
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readTasksDir(fx)).valid).toBe(true);
    });
    (0, vitest_1.it)('repair refused when the slice is not READY_FOR_CV — no Receipt', () => {
        const fx = fxInProgress();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ mode: 'repair', taskId: TASKS[1] }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    });
    (0, vitest_1.it)('outcome failed refused — no success Receipt (AWI-006 forbidden shortcut)', () => {
        const fx = fxInProgress();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ outcome: 'failed', summary: 'worker crashed' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('failed');
        (0, vitest_1.expect)(fs.existsSync(readTasksDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('outcome blocked refused — no Receipt', () => {
        const fx = fxInProgress();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ outcome: 'blocked', summary: 'cannot proceed' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(fs.existsSync(readTasksDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('outcome needs-decision refused — no Receipt', () => {
        const fx = fxInProgress();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ outcome: 'needs-decision', summary: 'ask the user' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(fs.existsSync(readTasksDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('implement refused when the slice is not IN_PROGRESS (READY_FOR_CV) — no Receipt', () => {
        const fx = fxReadyForCvInitial();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ mode: 'implement-task' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    });
    (0, vitest_1.it)('schema-invalid envelope refused fail-closed (RUNTIME.SCHEMA_MISMATCH) — no write', () => {
        const fx = fxInProgress();
        const result = (0, runtime_1.admitWorkerResult)(makeWorkerRequest({ outcome: 'bogus' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.new_state).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(fs.existsSync(readTasksDir(fx))).toBe(false);
    });
});
// ============================================================
// admitCVResult (PO-S02-E-03)
// ============================================================
(0, vitest_1.describe)('admitCVResult (PO-S02-E-03)', () => {
    (0, vitest_1.it)('PASS from READY_FOR_CV: reducer sequence RUN_CV → PASS_CV, CV_PASS receipt, readback CV_PASSED/PASS', () => {
        const fx = fxReadyForCvInitial();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitCVResult)(makeCvRequest({ verdict: 'PASS' }), depsFor(fx, { reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        // cv_dispatched composite + verdict application (PO-S02-E-03 sequence).
        (0, vitest_1.expect)(calls).toEqual([
            { entity: 'slice', event: 'RUN_CV' },
            { entity: 'slice', event: 'PASS_CV' },
        ]);
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.cv_status).toBe('PASS');
        const receipt = readReceiptFile(readCvDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.type).toBe('CV_PASS');
        (0, vitest_1.expect)(receipt.stage_id).toBe(STAGE_ID);
        (0, vitest_1.expect)(receipt.slice_id).toBe(SLICE_ID);
        (0, vitest_1.expect)(receipt.payload).toMatchObject({
            verdict: 'PASS',
            snapshot_digest: COMMIT_SHA,
            summary: 'cv pass',
        });
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readCvDir(fx)).valid).toBe(true);
        // Fresh reconcile derives CV_PASSED / PASS from the CV_PASS receipt.
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.slices[0]?.slice_state).toBe('CV_PASSED');
        (0, vitest_1.expect)(reread.slices[0]?.cv_status).toBe('PASS');
        (0, vitest_1.expect)(reread.receipt_chain).toContain(result.receipt_ref);
    });
    (0, vitest_1.it)('REPAIR from READY_FOR_CV: reducer sequence RUN_CV → REVISE, CV_REPAIR receipt, readback READY_FOR_CV/REPAIR', () => {
        const fx = fxReadyForCvInitial();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitCVResult)(makeCvRequest({ verdict: 'REPAIR', summary: 'needs fixes' }), depsFor(fx, { reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        (0, vitest_1.expect)(calls).toEqual([
            { entity: 'slice', event: 'RUN_CV' },
            { entity: 'slice', event: 'REVISE' },
        ]);
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.cv_status).toBe('REPAIR');
        const receipt = readReceiptFile(readCvDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.type).toBe('CV_REPAIR');
        (0, vitest_1.expect)(receipt.payload).toMatchObject({
            verdict: 'REPAIR',
            snapshot_digest: COMMIT_SHA,
        });
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readCvDir(fx)).valid).toBe(true);
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.slices[0]?.slice_state).toBe('READY_FOR_CV');
        (0, vitest_1.expect)(reread.slices[0]?.cv_status).toBe('REPAIR');
    });
    (0, vitest_1.it)('PASS from CV_IN_PROGRESS (runtime intermediate): dispatched step skipped — only PASS_CV', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([...TASKS]);
        fx.writeEvidence(true);
        fx.commitAll();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitCVResult)(makeCvRequest({ verdict: 'PASS' }), depsFor(fx, { reconcile: () => cvInProgressState(), reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        (0, vitest_1.expect)(calls).toEqual([{ entity: 'slice', event: 'PASS_CV' }]);
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.cv_status).toBe('PASS');
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readCvDir(fx)).valid).toBe(true);
    });
    (0, vitest_1.it)('REPAIR from CV_IN_PROGRESS (runtime intermediate): only REVISE, CV_REPAIR receipt', () => {
        const fx = makeFx();
        fx.writeManifest();
        fx.writeTasksMd([...TASKS]);
        fx.writeEvidence(true);
        fx.commitAll();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitCVResult)(makeCvRequest({ verdict: 'REPAIR' }), depsFor(fx, { reconcile: () => cvInProgressState(), reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        (0, vitest_1.expect)(calls).toEqual([{ entity: 'slice', event: 'REVISE' }]);
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.cv_status).toBe('REPAIR');
        const receipt = readReceiptFile(readCvDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.type).toBe('CV_REPAIR');
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readCvDir(fx)).valid).toBe(true);
    });
    (0, vitest_1.it)('recheck flow: READY_FOR_CV + PENDING_RECHECK → RECHECK then PASS_CV; CV_PASS chained to CV_REPAIR', () => {
        const { fx, cvRepairDigest } = fxPendingRecheck();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitCVResult)(makeCvRequest({ verdict: 'PASS', summary: 'recheck pass' }), depsFor(fx, { reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        // cv_dispatched via RECHECK (recheck branch), then verdict application.
        (0, vitest_1.expect)(calls).toEqual([
            { entity: 'slice', event: 'RUN_CV' },
            { entity: 'slice', event: 'PASS_CV' },
        ]);
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.cv_status).toBe('PASS');
        // The new CV_PASS receipt links to the CV_REPAIR genesis (previous_digest).
        const receipt = readReceiptFile(readCvDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.previous_digest).toBe(cvRepairDigest);
        const chain = (0, kernel_1.verifyReceiptChain)(readCvDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(2);
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.slices[0]?.slice_state).toBe('CV_PASSED');
        (0, vitest_1.expect)(reread.slices[0]?.cv_status).toBe('PASS');
    });
    (0, vitest_1.it)('wrong precondition (IN_PROGRESS) refused — no Receipt', () => {
        const fx = fxInProgress();
        const result = (0, runtime_1.admitCVResult)(makeCvRequest({ verdict: 'PASS' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(fs.existsSync(readCvDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('wrong precondition (CV_PASSED) refused — no Receipt', () => {
        const fx = fxCvPassed();
        const result = (0, runtime_1.admitCVResult)(makeCvRequest({ verdict: 'PASS' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readCvDir(fx)).valid).toBe(true);
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(readCvDir(fx)).receipts).toHaveLength(1);
    });
    (0, vitest_1.it)('READY_FOR_CV + cv REPAIR (no repair TASK_COMPLETE) refused — cv_dispatched composite illegal, no Receipt', () => {
        const { fx } = fxCvRepair();
        const result = (0, runtime_1.admitCVResult)(makeCvRequest({ verdict: 'PASS' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        // Only the seed CV_REPAIR exists — no CV_PASS was written.
        const chain = (0, kernel_1.verifyReceiptChain)(readCvDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(1);
    });
    (0, vitest_1.it)('invalid verdict refused at the schema layer — no Receipt', () => {
        const fx = fxReadyForCvInitial();
        const result = (0, runtime_1.admitCVResult)(makeCvRequest({ verdict: 'CONFIRMED' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.new_state).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(fs.existsSync(readCvDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('missing snapshot binding refused at the schema layer — no Receipt', () => {
        const fx = fxReadyForCvInitial();
        const result = (0, runtime_1.admitCVResult)({ type: 'cv_result', stageId: STAGE_ID, sliceId: SLICE_ID, verdict: 'PASS', summary: 's' }, depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.new_state).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(fs.existsSync(readCvDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('unknown slice refused (DOMAIN.STAGE_NOT_FOUND) — no Receipt', () => {
        const fx = fxReadyForCvInitial();
        const result = (0, runtime_1.admitCVResult)(makeCvRequest({ sliceId: 'S02-XX' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.STAGE_NOT_FOUND');
        (0, vitest_1.expect)(fs.existsSync(readCvDir(fx))).toBe(false);
    });
});
//# sourceMappingURL=admission-methods.spec.js.map