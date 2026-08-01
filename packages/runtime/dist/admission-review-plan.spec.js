"use strict";
/**
 * admission-review-plan.spec.ts — S02-E-T04 (PO-S02-E-05 / PO-S02-E-06 /
 * PO-S02-E-07)
 *
 * Public seam: `@proofloop/runtime` — `admitStageReview`, `admitProjectReview`
 * and `admitStagePlan` (the stage-level review / project review / stage-plan
 * admit methods wired onto the unified S02-E-T01 pipeline). Filesystem
 * integration: real temp git repos with the canonical `.proofloop` layout,
 * kernel `writeReceipt`-produced receipts, `verifyReceiptChain` per category
 * chain, and fresh `reconcileStage` readback as the oracle (AWI-006 — every
 * successful admit is chain-verified and read back as the corresponding
 * fact; every refusal produces NO Receipt).
 *
 * Covered in this task (PO-S02-E-05 / PO-S02-E-06 / PO-S02-E-07):
 *  - admitStageReview: ACCEPTED (stage derived UNDER_REVIEW → STAGE_REVIEW_PASS
 *    receipt to `review/<stage>/` + reducer COMPLETE → COMPLETED, chain
 *    valid, fresh reconcile readback COMPLETED), REPAIR (legal branch — NO
 *    receipt, reducer REOPEN → EXECUTING, warn Finding, accepted result with
 *    null receipt_ref), wrong precondition (stage not UNDER_REVIEW → refused).
 *  - admitProjectReview: ACCEPTED (project derived UNDER_REVIEW by reconcile
 *    — stage COMPLETED with no PROJECT_REVIEW_PASS receipt — then reducer
 *    COMPLETE → PROJECT_REVIEW_PASS receipt to `project/`, chain valid,
 *    readback COMPLETED), REPAIR (legal branch — NO receipt, reducer REOPEN →
 *    IN_PROGRESS, warn Finding), wrong precondition (project NOT derived
 *    UNDER_REVIEW — IN_PROGRESS default or already COMPLETED — refused via
 *    the real reconcile-derived gate, no synthetic dispatch).
 *  - admitStagePlan: success (request manifest digest === canonical digest of
 *    `.proofloop/manifests/<stage>.json`, stage UNINITIALIZED →
 *    STAGE_PLAN receipt to `plan/<stage>/` + reducer PLAN → PLANNING, chain
 *    valid, readback PLANNING), digest mismatch refused, duplicate admit
 *    (STAGE_PLAN receipt already exists → stage not UNINITIALIZED) refused.
 *  - canonicalManifestDigest / manifestFileDigest helper sanity: deterministic,
 *    key-order independent (canonical JSON), content-addressed.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 Stage/Project transition tables UNDER_REVIEW → COMPLETED |
 * EXECUTING / IN_PROGRESS, UNINITIALIZED → PLANNING; AWI-006;
 * PO-S02-E-05/06/07; §4 Manifest lifecycle digest binding) — not derived
 * from the implementation under test.
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
// Known-good literals (authority excerpts — never derived)
// ============================================================
const STAGE_ID = 'S02';
const SLICE_ID = 'S02-E';
const TASKS = ['S02-E-T01', 'S02-E-T02', 'S02-E-T03'];
function makeStageReviewRequest(overrides = {}) {
    return {
        type: 'stage_review',
        stageId: STAGE_ID,
        verdict: 'ACCEPTED',
        summary: 'stage review verdict',
        ...overrides,
    };
}
function makeProjectReviewRequest(overrides = {}) {
    return {
        type: 'project_review',
        stageId: STAGE_ID,
        verdict: 'ACCEPTED',
        summary: 'project review verdict',
        ...overrides,
    };
}
function makeStagePlanRequest(overrides = {}) {
    return {
        type: 'stage_plan',
        stageId: STAGE_ID,
        manifestDigest: 'e'.repeat(64),
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-review-'));
    (0, node_child_process_1.execFileSync)('git', ['init', '-q', root]);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.email', 'review@test.local']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.name', 'Review Test']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
    const sliceDef = (sid, taskIds) => ({
        slice_id: sid,
        goal: 'AdmissionService stage-level admit 操作',
        observable_outcome: 'stage review / project review / stage plan admits',
        public_seam: '@proofloop/runtime AdmissionService',
        dependencies: ['S02-A'],
        proof_obligations: [
            {
                po_id: 'PO-S02-E-05',
                behavior: 'admitStageReview all cases',
                public_seam: 'admitStageReview',
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
                        `|---|---|---|---|---|\n| PO-S02-E-05 | admission-review-plan.spec.ts | yes | yes | pass |\n\n` +
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
/** Manifest + all tasks checked + evidence finalized (no commits yet). */
function fxBase() {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    return fx;
}
/**
 * Stage UNINITIALIZED (no stage-boundary receipts) + project IN_PROGRESS:
 * the admitStagePlan success / admitProjectReview success / wrong-precondition
 * fixtures.
 */
function fxUninitialized() {
    const fx = fxBase();
    fx.commitAll();
    return fx;
}
/**
 * All slices integrated with the full stage-boundary receipt precondition
 * (STAGE_PLAN + SPV_PASS in `plan/<stage>/`, SLICE_COMMIT + INTEGRATION_PASS
 * bound to a real committed baseline SHA) and no STAGE_REVIEW_PASS → the
 * stage derives UNDER_REVIEW (PO-S02-C-04 / deriveStageState R2→R3→R4).
 */
function fxUnderReview() {
    const fx = fxBase();
    const baselineSha = fx.commitAll();
    // Stage-boundary receipts: STAGE_PLAN → SPV_PASS (plan/<stage>/ chain).
    fx.seedReceipt('plan', {
        type: 'STAGE_PLAN',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: { status: 'planned' },
    });
    fx.seedReceipt('plan', {
        type: 'SPV_PASS',
        timestamp: '2025-01-01T00:00:01.000Z',
        payload: { verdict: 'PASS' },
    });
    const cv = fx.seedReceipt('cv', {
        type: 'CV_PASS',
        slice_id: SLICE_ID,
        timestamp: '2025-01-02T00:00:00.000Z',
        payload: { verdict: 'PASS', snapshot_digest: 's1', summary: 'seed pass' },
    });
    fx.seedReceipt('committer', {
        type: 'SLICE_COMMIT',
        slice_id: SLICE_ID,
        timestamp: '2025-01-02T00:00:01.000Z',
        payload: {
            status: 'committed',
            slice_commit_sha: baselineSha,
            cv_receipt_digest: cv.digest,
        },
    });
    fx.seedReceipt('integration', {
        type: 'INTEGRATION_PASS',
        slice_id: SLICE_ID,
        timestamp: '2025-01-03T00:00:00.000Z',
        payload: {
            status: 'integrated',
            slice_commit_sha: baselineSha,
        },
    });
    fx.commitAll();
    return { fx, baselineSha };
}
/**
 * Stage COMPLETED with no PROJECT_REVIEW_PASS receipt → the project derives
 * UNDER_REVIEW (F-1: the project-level review is the gate AFTER the stage
 * completed its stage review — stage COMPLETED ⇒ project UNDER_REVIEW).
 * Extends fxUnderReview (stage UNDER_REVIEW) by seeding STAGE_REVIEW_PASS
 * into `review/<stage>/`, which advances the stage to COMPLETED.
 */
function fxProjectUnderReview() {
    const { fx } = fxUnderReview();
    fx.seedReceipt('review', {
        type: 'STAGE_REVIEW_PASS',
        timestamp: '2025-01-03T01:00:00.000Z',
        payload: { verdict: 'ACCEPTED', summary: 'seed stage review pass' },
    });
    fx.commitAll();
    return fx;
}
// ============================================================
// Shared helpers
// ============================================================
function depsFor(fx, extra) {
    return { projectRoot: fx.root, ...extra };
}
/** Spy reducer — records the RuntimeAction call sequence (PO-S02-E-05/06/07). */
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
function reviewDir(fx) {
    return path.join(fx.root, '.proofloop', 'receipts', 'review', fx.stageId);
}
function projectDir(fx) {
    return path.join(fx.root, '.proofloop', 'receipts', 'project');
}
function planDir(fx) {
    return path.join(fx.root, '.proofloop', 'receipts', 'plan', fx.stageId);
}
// ============================================================
// admitStageReview (PO-S02-E-05)
// ============================================================
(0, vitest_1.describe)('admitStageReview (PO-S02-E-05)', () => {
    (0, vitest_1.it)('ACCEPTED from UNDER_REVIEW: STAGE_REVIEW_PASS receipt to review/<stage>/, reducer COMPLETE, stage COMPLETED, chain valid, readback', () => {
        const { fx } = fxUnderReview();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitStageReview)(makeStageReviewRequest({ verdict: 'ACCEPTED', summary: 'stage accepted' }), depsFor(fx, { reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        // Reducer COMPLETE advances UNDER_REVIEW → COMPLETED (PO-S02-E-05).
        (0, vitest_1.expect)(calls).toEqual([{ entity: 'stage', event: 'COMPLETE' }]);
        (0, vitest_1.expect)(result.new_state?.stage_state).toBe('COMPLETED');
        // Receipt payload binds the verdict + summary.
        const receipt = readReceiptFile(reviewDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.type).toBe('STAGE_REVIEW_PASS');
        (0, vitest_1.expect)(receipt.stage_id).toBe(STAGE_ID);
        (0, vitest_1.expect)(receipt.slice_id).toBeUndefined();
        (0, vitest_1.expect)(receipt.payload).toMatchObject({
            verdict: 'ACCEPTED',
            summary: 'stage accepted',
        });
        // Chain verification + fresh reconcile readback (AWI-006 / PO-S02-E-01).
        const chain = (0, kernel_1.verifyReceiptChain)(reviewDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(1);
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.stage_state).toBe('COMPLETED');
        (0, vitest_1.expect)(reread.receipt_chain).toContain(result.receipt_ref);
    });
    (0, vitest_1.it)('REPAIR: legal branch — NO Receipt, reducer REOPEN → EXECUTING, warn Finding, accepted result with null receipt_ref', () => {
        const { fx } = fxUnderReview();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitStageReview)(makeStageReviewRequest({ verdict: 'REPAIR', summary: 'needs fixes' }), depsFor(fx, { reduce }));
        // REPAIR is a legal branch but NOT a success-Receipt branch (PO-S02-E-05).
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(calls).toEqual([{ entity: 'stage', event: 'REOPEN' }]);
        (0, vitest_1.expect)(result.new_state?.stage_state).toBe('EXECUTING');
        (0, vitest_1.expect)(result.findings).toHaveLength(1);
        (0, vitest_1.expect)(result.findings[0].severity).toBe('warn');
        // No receipt was written anywhere.
        (0, vitest_1.expect)(fs.existsSync(reviewDir(fx))).toBe(false);
        // Persisted facts unchanged — fresh reconcile still derives UNDER_REVIEW
        // (no STAGE_REVIEW_PASS receipt; all slices still integrated).
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.stage_state).toBe('UNDER_REVIEW');
    });
    (0, vitest_1.it)('wrong precondition (stage not UNDER_REVIEW) refused — no Receipt', () => {
        const fx = fxUninitialized();
        const result = (0, runtime_1.admitStageReview)(makeStageReviewRequest({ verdict: 'ACCEPTED' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('UNDER_REVIEW');
        (0, vitest_1.expect)(fs.existsSync(reviewDir(fx))).toBe(false);
    });
});
// ============================================================
// admitProjectReview (PO-S02-E-06)
// ============================================================
(0, vitest_1.describe)('admitProjectReview (PO-S02-E-06)', () => {
    (0, vitest_1.it)('ACCEPTED: stage COMPLETED → project derived UNDER_REVIEW → reducer COMPLETE; PROJECT_REVIEW_PASS receipt to project/, chain valid, readback', () => {
        const fx = fxProjectUnderReview();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitProjectReview)(makeProjectReviewRequest({ verdict: 'ACCEPTED', summary: 'project accepted' }), depsFor(fx, { reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        // The project is derived UNDER_REVIEW by reconcile (stage COMPLETED, no
        // PROJECT_REVIEW_PASS receipt) — NO synthetic SUBMIT_FOR_REVIEW dispatch
        // runs; only the verdict advance executes (F-1 real gate).
        (0, vitest_1.expect)(calls).toEqual([{ entity: 'project', event: 'COMPLETE' }]);
        (0, vitest_1.expect)(result.new_state?.project_state).toBe('COMPLETED');
        const receipt = readReceiptFile(projectDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.type).toBe('PROJECT_REVIEW_PASS');
        (0, vitest_1.expect)(receipt.stage_id).toBe(STAGE_ID);
        (0, vitest_1.expect)(receipt.slice_id).toBeUndefined();
        (0, vitest_1.expect)(receipt.payload).toMatchObject({
            verdict: 'ACCEPTED',
            summary: 'project accepted',
        });
        const chain = (0, kernel_1.verifyReceiptChain)(projectDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(1);
        // Fresh reconcile reads the receipt back via the receipt chain and
        // derives the project COMPLETED from the PROJECT_REVIEW_PASS receipt.
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.project_state).toBe('COMPLETED');
        (0, vitest_1.expect)(reread.receipt_chain).toContain(result.receipt_ref);
    });
    (0, vitest_1.it)('REPAIR: legal branch — NO Receipt, reducer REOPEN → IN_PROGRESS, warn Finding, accepted result with null receipt_ref', () => {
        const fx = fxProjectUnderReview();
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitProjectReview)(makeProjectReviewRequest({ verdict: 'REPAIR', summary: 'fix before accept' }), depsFor(fx, { reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(calls).toEqual([{ entity: 'project', event: 'REOPEN' }]);
        (0, vitest_1.expect)(result.new_state?.project_state).toBe('IN_PROGRESS');
        (0, vitest_1.expect)(result.findings).toHaveLength(1);
        (0, vitest_1.expect)(result.findings[0].severity).toBe('warn');
        // No receipt was written anywhere.
        (0, vitest_1.expect)(fs.existsSync(projectDir(fx))).toBe(false);
        // Persisted facts unchanged — fresh reconcile still derives project
        // UNDER_REVIEW (no PROJECT_REVIEW_PASS receipt; stage still COMPLETED).
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.project_state).toBe('UNDER_REVIEW');
    });
    (0, vitest_1.it)('real-seam refusal: project IN_PROGRESS (no STAGE_REVIEW_PASS) → ACCEPTED refused — no Receipt', () => {
        const fx = fxUninitialized();
        const result = (0, runtime_1.admitProjectReview)(makeProjectReviewRequest({ verdict: 'ACCEPTED' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('UNDER_REVIEW');
        (0, vitest_1.expect)(fs.existsSync(projectDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('real-seam refusal: project COMPLETED (PROJECT_REVIEW_PASS receipt exists) → ACCEPTED refused — no Receipt', () => {
        const fx = fxProjectUnderReview();
        fx.seedReceipt('project', {
            type: 'PROJECT_REVIEW_PASS',
            timestamp: '2025-01-04T00:00:00.000Z',
            payload: { verdict: 'ACCEPTED', summary: 'already accepted' },
        });
        fx.commitAll();
        const result = (0, runtime_1.admitProjectReview)(makeProjectReviewRequest({ verdict: 'ACCEPTED' }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('COMPLETED');
        // Nothing new was written — the seeded receipt is the only one.
        const chain = (0, kernel_1.verifyReceiptChain)(projectDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(1);
    });
    (0, vitest_1.it)('path-traversal stageId "../../evil" refused at the schema layer (RUNTIME.SCHEMA_MISMATCH) — no receipt, no project/ file', () => {
        const fx = fxProjectUnderReview();
        const result = (0, runtime_1.admitProjectReview)(makeProjectReviewRequest({ stageId: '../../evil', verdict: 'ACCEPTED' }), depsFor(fx));
        // The charset gate (F-2) rejects the traversal BEFORE reconcile — the
        // shared project/ chain can never be polluted by a synthetic receipt.
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.new_state).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(fs.existsSync(projectDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('legal-charset stageId absent from the manifest (S99) refused (DOMAIN.STAGE_NOT_FOUND) — no Receipt', () => {
        const fx = fxProjectUnderReview();
        const result = (0, runtime_1.admitProjectReview)(makeProjectReviewRequest({ stageId: 'S99', verdict: 'ACCEPTED' }), depsFor(fx));
        // Schema-valid but not declared in any manifest — the pipeline
        // existence gate refuses before any state advance or write (F-2).
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.STAGE_NOT_FOUND');
        (0, vitest_1.expect)(fs.existsSync(projectDir(fx))).toBe(false);
    });
});
// ============================================================
// admitStagePlan (PO-S02-E-07)
// ============================================================
(0, vitest_1.describe)('admitStagePlan (PO-S02-E-07)', () => {
    (0, vitest_1.it)('success with matching manifest digest: STAGE_PLAN receipt to plan/<stage>/, reducer PLAN, stage PLANNING, chain valid, readback', () => {
        const fx = fxUninitialized();
        const canonicalDigest = (0, runtime_1.manifestFileDigest)({ projectRoot: fx.root, stageId: STAGE_ID });
        const { calls, reduce } = spyReduce();
        const result = (0, runtime_1.admitStagePlan)(makeStagePlanRequest({ manifestDigest: canonicalDigest }), depsFor(fx, { reduce }));
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).not.toBeNull();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        // Reducer PLAN advances UNINITIALIZED → PLANNING (PO-S02-E-07).
        (0, vitest_1.expect)(calls).toEqual([{ entity: 'stage', event: 'PLAN' }]);
        (0, vitest_1.expect)(result.new_state?.stage_state).toBe('PLANNING');
        // Receipt payload binds the manifest digest (Manifest lifecycle binding).
        const receipt = readReceiptFile(planDir(fx), result.receipt_ref);
        (0, vitest_1.expect)(receipt.type).toBe('STAGE_PLAN');
        (0, vitest_1.expect)(receipt.stage_id).toBe(STAGE_ID);
        (0, vitest_1.expect)(receipt.slice_id).toBeUndefined();
        (0, vitest_1.expect)(receipt.payload).toMatchObject({ manifest_digest: canonicalDigest });
        const chain = (0, kernel_1.verifyReceiptChain)(planDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(1);
        // Fresh reconcile derives PLANNING from the STAGE_PLAN receipt.
        const reread = fx.reconcile();
        (0, vitest_1.expect)(reread.stage_state).toBe('PLANNING');
        (0, vitest_1.expect)(reread.receipt_chain).toContain(result.receipt_ref);
    });
    (0, vitest_1.it)('digest mismatch refused (request digest ≠ canonical manifest digest) — no Receipt', () => {
        const fx = fxUninitialized();
        const result = (0, runtime_1.admitStagePlan)(makeStagePlanRequest({ manifestDigest: 'a'.repeat(64) }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(result.findings[0].message).toContain('manifest digest');
        (0, vitest_1.expect)(fs.existsSync(planDir(fx))).toBe(false);
    });
    (0, vitest_1.it)('duplicate admit refused (STAGE_PLAN receipt already exists → stage not UNINITIALIZED) — no Receipt', () => {
        const fx = fxBase();
        fx.seedReceipt('plan', {
            type: 'STAGE_PLAN',
            timestamp: '2025-01-01T00:00:00.000Z',
            payload: { seeded: true },
        });
        fx.commitAll();
        const canonicalDigest = (0, runtime_1.manifestFileDigest)({ projectRoot: fx.root, stageId: STAGE_ID });
        const result = (0, runtime_1.admitStagePlan)(makeStagePlanRequest({ manifestDigest: canonicalDigest }), depsFor(fx));
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        // Only the seed receipt exists — nothing new was written.
        const chain = (0, kernel_1.verifyReceiptChain)(planDir(fx));
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(1);
    });
});
// ============================================================
// Canonical manifest digest helper (PO-S02-E-07 binding source)
// ============================================================
(0, vitest_1.describe)('canonical manifest digest (PO-S02-E-07 binding)', () => {
    (0, vitest_1.it)('is deterministic, key-order independent (canonical JSON) and content-addressed', () => {
        const fx = fxUninitialized();
        const manifestPath = path.join(fx.root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
        const d1 = (0, runtime_1.manifestFileDigest)({ projectRoot: fx.root, stageId: STAGE_ID });
        const d2 = (0, runtime_1.manifestFileDigest)({ projectRoot: fx.root, stageId: STAGE_ID });
        (0, vitest_1.expect)(d1).toBe(d2);
        (0, vitest_1.expect)(d1).toMatch(/^[0-9a-f]{64}$/);
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        // Reordering object keys must NOT change the digest (canonical JSON).
        const reordered = {};
        for (const key of Object.keys(raw).sort().reverse()) {
            reordered[key] = raw[key];
        }
        (0, vitest_1.expect)((0, runtime_1.canonicalManifestDigest)(reordered)).toBe((0, runtime_1.canonicalManifestDigest)(raw));
        // Changing content MUST change the digest (content addressing).
        (0, vitest_1.expect)((0, runtime_1.canonicalManifestDigest)({ ...raw, stage_goal: 'different goal' })).not.toBe((0, runtime_1.canonicalManifestDigest)(raw));
    });
});
//# sourceMappingURL=admission-review-plan.spec.js.map