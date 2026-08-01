"use strict";
/**
 * admit-pipeline.spec.ts — PO-S03-H-05 (S03-H-T03)
 *
 * Existence-gate message precision of `runAdmitPipeline` (the unified admit
 * pipeline, AWI-006). The gate refuses ANY error-level
 * `DOMAIN.STAGE_NOT_FOUND` reconcile finding (fail closed — the refusal
 * condition is unchanged), but the rejection message must now carry precise
 * attribution distinguishing two branches:
 *
 *   Branch A — "stage not declared in the manifest" (manifest missing /
 *              stage_id mismatch): message explicitly attributes the refusal
 *              to the missing manifest declaration and carries the original
 *              reconcile finding content.
 *   Branch B — other DOMAIN.STAGE_NOT_FOUND sources (unknown slice
 *              directories, receipts referencing unknown stage/slice):
 *              message explicitly attributes the refusal to the concrete
 *              source (with the original finding content) and must NOT use
 *              the branch-A "not declared in the manifest" wording.
 *
 * Both branches refuse with no Receipt (no widening of the release
 * surface). A legal declared-stage admit must be unaffected (regression).
 *
 * Public seam: `@proofloop/runtime` — `runAdmitPipeline` gate behavior via
 * the real admit methods (admitCVResult / admitWorkerResult) over real
 * fixture projects. The gate itself is never mocked.
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
// ============================================================
// Known-good literals
// ============================================================
const STAGE_ID = 'S02';
const SLICE_ID = 'S02-A';
const TASKS = ['S02-A-T01', 'S02-A-T02'];
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-gate-'));
    (0, node_child_process_1.execFileSync)('git', ['init', '-q', root]);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.email', 'gate@test.local']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.name', 'Gate Test']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
    const sliceDef = (sid, taskIds) => ({
        slice_id: sid,
        goal: 'existence gate precision',
        observable_outcome: 'precise STAGE_NOT_FOUND attribution, fail-closed kept',
        public_seam: '@proofloop/runtime runAdmitPipeline gate',
        dependencies: [],
        proof_obligations: [
            {
                po_id: 'PO-S03-H-05',
                behavior: 'gate message distinguishes manifest-declaration vs other sources',
                public_seam: 'runAdmitPipeline gate',
                oracle_source: 'real fixture project',
                success_criteria: 'two-branch messages precise + regression',
                required_observation: 'fixture oracle',
                applicable_risk_facts: ['persistent_state'],
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
                stage_goal: 'existence gate precision',
                outcomes: ['precise attribution'],
                slices: [sliceDef(sliceId, TASKS)],
                dependencies: [],
                risk_facts: [],
            };
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
                `|---|---|---|---|---|\n| *None* | | | | |\n`;
            const finalizedContent = `# Slice ${sliceId} Evidence\n\n` +
                `## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
                `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n` +
                `### Proof Obligation Coverage\n\n` +
                `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
                `|---|---|---|---|---|\n| PO-S03-H-05 | admit-pipeline.spec.ts | yes | yes | pass |\n\n` +
                `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`;
            fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, finalized ? finalizedContent : partial);
        },
        seedReceipt: (category, sliceIdForDir, overrides) => {
            const dir = sliceIdForDir !== undefined
                ? (0, runtime_1.receiptCategoryDir)(root, category, stageId, sliceIdForDir)
                : (0, runtime_1.receiptCategoryDir)(root, category, stageId);
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
        commitAll: () => {
            (0, node_child_process_1.execFileSync)('git', ['-C', root, 'add', '-A']);
            (0, node_child_process_1.execFileSync)('git', ['-C', root, 'commit', '-q', '-m', 'fixture']);
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
                // best-effort
            }
        },
    };
    cleanups.push(fx.cleanup);
    return fx;
}
/** IN_PROGRESS slice (legal declared stage): manifest + tasks + evidence. */
function fxInProgress() {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([TASKS[0]]);
    fx.writeEvidence(false);
    fx.commitAll();
    return fx;
}
function cvRequest(stageId, sliceId) {
    return {
        type: 'cv_result',
        stageId,
        sliceId,
        verdict: 'PASS',
        snapshotDigest: 'a'.repeat(40),
        summary: 'cv pass',
    };
}
// ============================================================
// Branch A — stage not declared in the manifest
// ============================================================
(0, vitest_1.describe)('existence gate branch A — stage not declared in the manifest (PO-S03-H-05)', () => {
    (0, vitest_1.it)('refuses with precise manifest-declaration attribution + original finding content', () => {
        // Plain temp dir with NO manifest for stage S99 → reconcile surfaces the
        // manifest-declaration STAGE_NOT_FOUND finding (emptyResult path).
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-gate-no-manifest-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const result = (0, runtime_1.admitCVResult)(cvRequest('S99', 'S99-A'), { projectRoot: dir });
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0]?.code).toBe('DOMAIN.STAGE_NOT_FOUND');
        const message = result.findings[0]?.message ?? '';
        // precise attribution to the missing manifest declaration …
        (0, vitest_1.expect)(message).toContain('is not declared in the manifest');
        (0, vitest_1.expect)(message).toContain('manifest missing or stage_id mismatch');
        // … and the original reconcile finding content is carried
        (0, vitest_1.expect)(message).toContain('manifest source unavailable for stage "S99"');
    });
    (0, vitest_1.it)('stage_id mismatch against the manifest is attributed to the manifest declaration', () => {
        const fx = makeFx('S02', SLICE_ID);
        fx.writeManifest(); // manifest declares S02
        fx.writeTasksMd([]);
        fx.writeEvidence(false);
        fx.commitAll();
        // request for a stage the manifest does NOT declare → mismatch branch
        const result = (0, runtime_1.admitCVResult)(cvRequest('S99', SLICE_ID), { projectRoot: fx.root });
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        const message = result.findings[0]?.message ?? '';
        (0, vitest_1.expect)(message).toContain('is not declared in the manifest');
        (0, vitest_1.expect)(message).toContain('manifest source unavailable for stage "S99"');
    });
});
// ============================================================
// Branch B — other DOMAIN.STAGE_NOT_FOUND sources
// ============================================================
(0, vitest_1.describe)('existence gate branch B — non-manifest STAGE_NOT_FOUND sources (PO-S03-H-05)', () => {
    (0, vitest_1.it)('unknown slice directory is attributed to the concrete source (not the manifest)', () => {
        const fx = fxInProgress();
        // stray receipts directory for a slice the manifest does not declare
        fx.seedReceipt('cv', 'S02-Z', {
            type: 'CV_PASS',
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: { verdict: 'PASS', snapshot_digest: 'a'.repeat(40), summary: 'stray' },
        });
        fx.commitAll();
        const state = fx.reconcile();
        (0, vitest_1.expect)(state.findings.some((f) => f.code === 'DOMAIN.STAGE_NOT_FOUND' && f.message.includes('unknown slice'))).toBe(true);
        const result = (0, runtime_1.admitCVResult)(cvRequest(STAGE_ID, SLICE_ID), { projectRoot: fx.root });
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0]?.code).toBe('DOMAIN.STAGE_NOT_FOUND');
        const message = result.findings[0]?.message ?? '';
        // branch-B wording — must NOT use the manifest-declaration wording
        (0, vitest_1.expect)(message).not.toContain('is not declared in the manifest');
        // precise attribution to the unknown slice directory + original finding
        (0, vitest_1.expect)(message).toContain('receipts reference unknown slice "S02-Z"');
        (0, vitest_1.expect)(message).toContain('directory');
    });
    (0, vitest_1.it)('a receipt referencing an unknown stage is attributed to the receipt source', () => {
        const fx = fxInProgress();
        // valid receipt with a foreign stage_id inside a declared slice directory
        fx.seedReceipt('cv', SLICE_ID, {
            type: 'CV_PASS',
            stage_id: 'S99',
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: { verdict: 'PASS', snapshot_digest: 'a'.repeat(40), summary: 'foreign' },
        });
        fx.commitAll();
        const state = fx.reconcile();
        (0, vitest_1.expect)(state.findings.some((f) => f.code === 'DOMAIN.STAGE_NOT_FOUND' && f.message.includes('references unknown stage'))).toBe(true);
        const result = (0, runtime_1.admitCVResult)(cvRequest(STAGE_ID, SLICE_ID), { projectRoot: fx.root });
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        const message = result.findings[0]?.message ?? '';
        (0, vitest_1.expect)(message).not.toContain('is not declared in the manifest');
        (0, vitest_1.expect)(message).toContain('references unknown stage "S99"');
    });
});
// ============================================================
// Fail-closed scope + regression
// ============================================================
(0, vitest_1.describe)('existence gate fail-closed + regression (PO-S03-H-05)', () => {
    (0, vitest_1.it)('both branches refuse with no Receipt and no category directory write', () => {
        // Branch A: no manifest
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-gate-no-manifest2-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const a = (0, runtime_1.admitCVResult)(cvRequest('S99', 'S99-A'), { projectRoot: dir });
        (0, vitest_1.expect)(a.accepted).toBe(false);
        (0, vitest_1.expect)(a.receipt_ref).toBeNull();
        (0, vitest_1.expect)(fs.existsSync((0, runtime_1.planReceiptDir)(dir, 'S99'))).toBe(false);
        // Branch B: unknown slice directory
        const fx = fxInProgress();
        fx.seedReceipt('cv', 'S02-Z', {
            type: 'CV_PASS',
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: { verdict: 'PASS', snapshot_digest: 'a'.repeat(40), summary: 'stray' },
        });
        fx.commitAll();
        const b = (0, runtime_1.admitCVResult)(cvRequest(STAGE_ID, SLICE_ID), { projectRoot: fx.root });
        (0, vitest_1.expect)(b.accepted).toBe(false);
        (0, vitest_1.expect)(b.receipt_ref).toBeNull();
        // the refused admit wrote NO new receipt into the stray slice directory
        const strayDir = (0, runtime_1.cvReceiptDir)(fx.root, STAGE_ID, 'S02-Z');
        (0, vitest_1.expect)(fs.existsSync(strayDir)).toBe(true);
        const names = fs.readdirSync(strayDir).filter((f) => f.endsWith('.json'));
        (0, vitest_1.expect)(names).toHaveLength(1); // only the seeded stray receipt
        // and no receipt was created in the declared slice's cv directory either
        (0, vitest_1.expect)(fs.existsSync((0, runtime_1.cvReceiptDir)(fx.root, STAGE_ID, SLICE_ID))).toBe(false);
    });
    (0, vitest_1.it)('the two branch messages are distinguishable', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-gate-distinct-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const a = (0, runtime_1.admitCVResult)(cvRequest('S99', 'S99-A'), { projectRoot: dir });
        const aMsg = a.findings[0]?.message ?? '';
        const fx = fxInProgress();
        fx.seedReceipt('cv', 'S02-Z', {
            type: 'CV_PASS',
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: { verdict: 'PASS', snapshot_digest: 'a'.repeat(40), summary: 'stray' },
        });
        fx.commitAll();
        const b = (0, runtime_1.admitCVResult)(cvRequest(STAGE_ID, SLICE_ID), { projectRoot: fx.root });
        const bMsg = b.findings[0]?.message ?? '';
        (0, vitest_1.expect)(aMsg).toContain('is not declared in the manifest');
        (0, vitest_1.expect)(bMsg).not.toContain('is not declared in the manifest');
        (0, vitest_1.expect)(aMsg).not.toBe(bMsg);
    });
    (0, vitest_1.it)('regression: a legal declared-stage admit is unaffected by the gate', () => {
        const fx = fxInProgress();
        const result = (0, runtime_1.admitWorkerResult)({
            type: 'worker_result',
            envelope: {
                schemaVersion: 1,
                actionToken: 'tok-gate-regression',
                stageId: STAGE_ID,
                sliceId: SLICE_ID,
                taskId: TASKS[0],
                mode: 'implement-task',
                outcome: 'completed',
                evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
                changedFiles: ['packages/runtime/src/admit-pipeline.ts'],
                verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'l' }],
                summary: 'regression admit',
            },
        }, { projectRoot: fx.root });
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).toBeTruthy();
        // chain-validated + fresh reconcile readback: slice stays IN_PROGRESS
        const tasksDir = (0, runtime_1.receiptCategoryDir)(fx.root, 'tasks', STAGE_ID, SLICE_ID);
        (0, vitest_1.expect)((0, kernel_1.verifyReceiptChain)(tasksDir).valid).toBe(true);
        const slice = fx.reconcile().slices.find((s) => s.slice_id === SLICE_ID);
        (0, vitest_1.expect)(slice?.slice_state).toBe(kernel_1.SliceState.IN_PROGRESS);
    });
});
//# sourceMappingURL=admit-pipeline.spec.js.map