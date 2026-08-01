"use strict";
/**
 * admission-boundary.spec.ts — S02-E-T03 (PO-S02-E-04)
 *
 * Public seam: `@proofloop/runtime` — `admitSliceCommit` and
 * `admitIntegration` (the slice-boundary committer/integration admit
 * methods wired onto the unified S02-E-T01 pipeline). Filesystem
 * integration: real temp git repos with the canonical `.proofloop` layout,
 * kernel `writeReceipt`-produced receipts, `verifyReceiptChain` per
 * category chain, and fresh `reconcileStage` readback as the oracle
 * (AWI-006 — every successful admit is chain-verified and read back as the
 * corresponding committed/integrated fact; every refusal produces NO
 * Receipt).
 *
 * Covered in this task (PO-S02-E-04):
 *  - admitSliceCommit: precondition slice derived CV_PASSED (reconcile
 *    fact) + cv receipt digest binding valid (request digest === the latest
 *    CV_PASS receipt digest) + non-empty commit SHA → SLICE_COMMIT Receipt
 *    to `committer/<stage>/<slice>/` + reducer INTEGRATE advance
 *    CV_PASSED → INTEGRATING; wrong state / invalid digest binding /
 *    unknown slice / schema-invalid request → structured rejection, no
 *    Receipt.
 *  - admitIntegration: precondition slice derived INTEGRATING (reconcile
 *    fact) + SLICE_COMMIT receipt existing and binding the SAME commit SHA
 *    → INTEGRATION_PASS Receipt to `integration/<stage>/<slice>/` +
 *    reducer FINISH_INTEGRATION advance INTEGRATING → INTEGRATED; SHA
 *    mismatch / commit binding missing / wrong state / unknown slice /
 *    schema-invalid request → structured rejection, no Receipt.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 transition table CV_PASSED → INTEGRATING → INTEGRATED,
 * AWI-006, PO-S02-E-04, and the S02-C-T04 canonical payload contract:
 * SLICE_COMMIT payload.status === 'committed' + slice_commit_sha +
 * cv_receipt_digest === latest CV_PASS digest; INTEGRATION_PASS
 * payload.status === 'integrated' + slice_commit_sha === the committed
 * SHA) — not derived from the implementation under test.
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
const TASKS = ['S02-E-T01', 'S02-E-T02', 'S02-E-T03'];
function makeCommitRequest(overrides = {}) {
    return {
        type: 'slice_commit',
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        commitSha: 'a'.repeat(40),
        cvReceiptDigest: 'd'.repeat(64),
        ...overrides,
    };
}
function makeIntegrationRequest(overrides = {}) {
    return {
        type: 'integration',
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        commitSha: 'a'.repeat(40),
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-boundary-'));
    (0, node_child_process_1.execFileSync)('git', ['init', '-q', root]);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.email', 'boundary@test.local']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.name', 'Boundary Test']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
    const sliceDef = (sid, taskIds) => ({
        slice_id: sid,
        goal: 'AdmissionService slice-boundary admit 操作',
        observable_outcome: 'commit/integration admits with chain-verified receipts',
        public_seam: '@proofloop/runtime AdmissionService',
        dependencies: ['S02-A'],
        proof_obligations: [
            {
                po_id: 'PO-S02-E-04',
                behavior: 'admitSliceCommit / admitIntegration all cases',
                public_seam: 'admitSliceCommit / admitIntegration',
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
        writeEvidence: (finalized) => {
            const content = `# Slice ${sliceId} Evidence\n\n` +
                `## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
                (finalized
                    ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n` +
                        `### Proof Obligation Coverage\n\n` +
                        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
                        `|---|---|---|---|---|\n| PO-S02-E-04 | admission-boundary.spec.ts | yes | yes | pass |\n\n` +
                        `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
                    : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
                        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
                        `|---|---|---|---|---|\n| *None* | | | | |\n`);
            fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, content);
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
/** Manifest + all tasks checked + evidence finalized (no receipts yet). */
function fxBase() {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    return fx;
}
/** READY_FOR_CV: all checked + finalized + mode=finalize-slice TASK_COMPLETE. */
function fxReadyForCv() {
    const fx = fxBase();
    fx.seedReceipt('tasks', { payload: { mode: 'finalize-slice' } });
    fx.commitAll();
    return fx;
}
/**
 * CV_PASSED: a CV_PASS receipt exists (the commit precondition). The
 * baseline commit SHA is the real fixture HEAD — the value a real
 * committer would record as `slice_commit_sha`.
 */
function fxCvPassed() {
    const fx = fxBase();
    const commitSha = fx.commitAll();
    const seeded = fx.seedReceipt('cv', {
        type: 'CV_PASS',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: { verdict: 'PASS', snapshot_digest: 's1', summary: 'seed pass' },
    });
    return { fx, cvPassDigest: seeded.digest, commitSha };
}
/**
 * INTEGRATING: CV_PASS + a SLICE_COMMIT receipt bound to the baseline
 * commit SHA and the latest CV_PASS digest (S02-C-T04 committed derivation).
 */
function fxIntegrating() {
    const fx = fxBase();
    const commitSha = fx.commitAll();
    const cv = fx.seedReceipt('cv', {
        type: 'CV_PASS',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: { verdict: 'PASS', snapshot_digest: 's1', summary: 'seed pass' },
    });
    fx.seedReceipt('committer', {
        type: 'SLICE_COMMIT',
        timestamp: '2025-01-02T00:00:00.000Z',
        payload: {
            status: 'committed',
            slice_commit_sha: commitSha,
            cv_receipt_digest: cv.digest,
        },
    });
    return { fx, cvPassDigest: cv.digest, commitSha };
}
/**
 * CV_PASSED with an INVALID commit binding: a SLICE_COMMIT whose
 * cv_receipt_digest does not match the latest CV_PASS digest — the S02-C
 * committed derivation stays false (never a guess), so the slice derives
 * CV_PASSED, not INTEGRATING.
 */
function fxInvalidCommitBinding() {
    const fx = fxBase();
    const commitSha = fx.commitAll();
    fx.seedReceipt('cv', {
        type: 'CV_PASS',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: { verdict: 'PASS', snapshot_digest: 's1', summary: 'seed pass' },
    });
    fx.seedReceipt('committer', {
        type: 'SLICE_COMMIT',
        timestamp: '2025-01-02T00:00:00.000Z',
        payload: {
            status: 'committed',
            slice_commit_sha: commitSha,
            cv_receipt_digest: 'f'.repeat(64),
        },
    });
    return { fx, commitSha };
}
/** Runtime intermediate: slice INTEGRATING but NO SLICE_COMMIT receipt. */
function integratingWithoutCommitState() {
    return {
        stage_id: STAGE_ID,
        slices: [
            {
                slice_id: SLICE_ID,
                dependencies: [],
                tasks: [],
                slice_state: kernel_2.SliceState.INTEGRATING,
                cv_status: kernel_2.CVStatus.PASS,
                slice_evidence_finalized: true,
                repair_attempt: 0,
                scope_check_passed: false,
                committed: true,
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
/** Spy reducer — records the RuntimeAction call sequence (PO-S02-E-04). */
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
function committerDir(fx) {
    return path.join(fx.root, '.proofloop', 'receipts', 'committer', fx.stageId, fx.sliceId);
}
function integrationDir(fx) {
    return path.join(fx.root, '.proofloop', 'receipts', 'integration', fx.stageId, fx.sliceId);
}
// ============================================================
// admitSliceCommit (PO-S02-E-04)
// ============================================================
(0, vitest_1.describe)('admitSliceCommit (PO-S02-E-04)', () => {
    (0, vitest_1.it)('accepted from CV_PASSED with valid cv digest + SHA: SLICE_COMMIT receipt, reducer INTEGRATE, readback INTEGRATING/committed', () => {
        const { fx, cvPassDigest, commitSha } = fxCvPassed();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitSliceCommit)(makeCommitRequest({ commitSha, cvReceiptDigest: cvPassDigest }), depsFor(fx, { reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        // Reducer INTEGRATE advances CV_PASSED → INTEGRATING (PO-S02-E-04).
        (0, vitest_1.expect)(calls).toEqual([{ entity: 'slice', event: 'INTEGRATE' }]);
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('INTEGRATING');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.cv_status).toBe('PASS');
        // Receipt payload binds the committed SHA + cv receipt digest (S02-C-T04 contract).
        const receipt = readReceiptFile(committerDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.type).toBe('SLICE_COMMIT');
        (0, vitest_1.expect)(receipt.stage_id).toBe(STAGE_ID);
        (0, vitest_1.expect)(receipt.slice_id).toBe(SLICE_ID);
        (0, vitest_1.expect)(receipt.payload).toMatchObject({
            status: 'committed',
            slice_commit_sha: commitSha,
            cv_receipt_digest: cvPassDigest,
        });
        // Chain verification + fresh reconcile readback (AWI-006 / PO-S02-E-01).
        const chain = (0, kernel_1.verifyReceiptChain)(committerDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(1);
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.slices[0]?.slice_state).toBe('INTEGRATING');
        (0, vitest_1.expect)(reread.slices[0]?.committed).toBe(true);
        (0, vitest_1.expect)(reread.slices[0]?.integrated).toBe(false);
        (0, vitest_1.expect)(reread.receipt_chain).toContain(result.receipt_ref);
    });
    (0, vitest_1.it)('refused when the slice is not CV_PASSED (READY_FOR_CV) — no Receipt', () => {
        const fx = fxReadyForCv();
        const result = (0, runtime_1.admitSliceCommit)(makeCommitRequest(), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('CV_PASSED');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
        (0, vitest_1.expect)(fs.existsSync(committerDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('refused when the cv receipt digest binding is invalid (mismatched digest) — no Receipt', () => {
        const { fx, cvPassDigest } = fxCvPassed();
        const result = (0, runtime_1.admitSliceCommit)(makeCommitRequest({ cvReceiptDigest: 'f'.repeat(64) }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('cv');
        // The valid digest still binds; the mismatch is what refused the admit.
        (0, vitest_1.expect)(cvPassDigest.length).toBe(64);
        (0, vitest_1.expect)(fs.existsSync(committerDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('refused for an unknown slice (DOMAIN.STAGE_NOT_FOUND) — no Receipt', () => {
        const { fx } = fxCvPassed();
        const result = (0, runtime_1.admitSliceCommit)(makeCommitRequest({ sliceId: 'S02-XX' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.STAGE_NOT_FOUND');
        (0, vitest_1.expect)(fs.existsSync(committerDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('schema-invalid request (empty commit SHA) refused fail-closed — no write', () => {
        const { fx } = fxCvPassed();
        const result = (0, runtime_1.admitSliceCommit)(makeCommitRequest({ commitSha: '' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.new_state).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(fs.existsSync(committerDir(fx))).toBe(false);
    });
});
// ============================================================
// admitIntegration (PO-S02-E-04)
// ============================================================
(0, vitest_1.describe)('admitIntegration (PO-S02-E-04)', () => {
    (0, vitest_1.it)('accepted from INTEGRATING with matching SHA: INTEGRATION_PASS receipt, reducer FINISH_INTEGRATION, readback INTEGRATED/integrated', () => {
        const { fx, commitSha } = fxIntegrating();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitIntegration)(makeIntegrationRequest({ commitSha }), depsFor(fx, { reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        // Reducer FINISH_INTEGRATION advances INTEGRATING → INTEGRATED.
        (0, vitest_1.expect)(calls).toEqual([{ entity: 'slice', event: 'FINISH_INTEGRATION' }]);
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('INTEGRATED');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.cv_status).toBe('PASS');
        // Receipt payload binds the SAME commit SHA as the SLICE_COMMIT (S02-C-T04 contract).
        const receipt = readReceiptFile(integrationDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.type).toBe('INTEGRATION_PASS');
        (0, vitest_1.expect)(receipt.stage_id).toBe(STAGE_ID);
        (0, vitest_1.expect)(receipt.slice_id).toBe(SLICE_ID);
        (0, vitest_1.expect)(receipt.payload).toMatchObject({
            status: 'integrated',
            slice_commit_sha: commitSha,
        });
        // Chain verification + fresh reconcile readback (AWI-006 / PO-S02-E-01).
        const chain = (0, kernel_1.verifyReceiptChain)(integrationDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(1);
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.slices[0]?.slice_state).toBe('INTEGRATED');
        (0, vitest_1.expect)(reread.slices[0]?.committed).toBe(true);
        (0, vitest_1.expect)(reread.slices[0]?.integrated).toBe(true);
        (0, vitest_1.expect)(reread.receipt_chain).toContain(result.receipt_ref);
    });
    (0, vitest_1.it)('refused when the request SHA does not match the SLICE_COMMIT receipt — no Receipt', () => {
        const { fx } = fxIntegrating();
        const result = (0, runtime_1.admitIntegration)(makeIntegrationRequest({ commitSha: 'b'.repeat(40) }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('SHA');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('INTEGRATING');
        (0, vitest_1.expect)(fs.existsSync(integrationDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('refused when the slice is not INTEGRATING (CV_PASSED, no commit receipt) — no Receipt', () => {
        const { fx } = fxCvPassed();
        const result = (0, runtime_1.admitIntegration)(makeIntegrationRequest(), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('INTEGRATING');
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
        (0, vitest_1.expect)(fs.existsSync(integrationDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('refused when the commit binding is invalid (SLICE_COMMIT cv digest mismatch → CV_PASSED) — no Receipt', () => {
        const { fx, commitSha } = fxInvalidCommitBinding();
        const result = (0, runtime_1.admitIntegration)(makeIntegrationRequest({ commitSha }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        // Even a SHA that matches the recorded SLICE_COMMIT cannot integrate an
        // uncommitted (CV_PASSED) slice.
        (0, vitest_1.expect)(result.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
        (0, vitest_1.expect)(fs.existsSync(integrationDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('refused at the INTEGRATING runtime intermediate with no SLICE_COMMIT receipt binding — no Receipt', () => {
        const fx = fxBase();
        fx.commitAll();
        const result = (0, runtime_1.admitIntegration)(makeIntegrationRequest(), depsFor(fx, { reconcile: () => integratingWithoutCommitState() }));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('SLICE_COMMIT');
        (0, vitest_1.expect)(fs.existsSync(integrationDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('refused for an unknown slice (DOMAIN.STAGE_NOT_FOUND) — no Receipt', () => {
        const { fx } = fxIntegrating();
        const result = (0, runtime_1.admitIntegration)(makeIntegrationRequest({ sliceId: 'S02-XX' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.STAGE_NOT_FOUND');
        (0, vitest_1.expect)(fs.existsSync(integrationDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('schema-invalid request (empty commit SHA) refused fail-closed — no write', () => {
        const { fx } = fxIntegrating();
        const result = (0, runtime_1.admitIntegration)(makeIntegrationRequest({ commitSha: '' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.new_state).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(fs.existsSync(integrationDir(fx))).toBe(false);
    });
});
//# sourceMappingURL=admission-boundary.spec.js.map