"use strict";
/**
 * NextActionService — proofloop_next pipeline tests (S02-D-T02)
 *
 * Real-fixture integration tests over the full pipeline
 * (reconcile → validate chain → deterministic persisted extras → pure derive
 * → proofloop_next wrap), covering the pipeline side of:
 *
 *   PO-S02-D-02 (pipeline side): any error-level inconsistency → the unique
 *     action VALIDATE with all findings returned, receipt_chain_valid
 *     truthfully reflecting the chain state — never a guessed execution
 *     action.
 *   PO-S02-D-04: the full pipeline (path → reconcile → validate → derive)
 *     output equals the pure `deriveNextAction` on the same reconcile output
 *     for fixtures whose extra facts are neutral; the extras-only behaviors
 *     (gate / repartition / evidence / envelope) are each proven by a
 *     pipeline-vs-pure divergence on the SAME fixture.
 *   PO-S02-D-05: every pipeline output satisfies the proofloop_next structure
 *     contract (action ∈ 15-value closed set, non-empty action_detail,
 *     responsible_role ∈ 10-value RoleType closed set, findings ≤ 20,
 *     receipt_chain_valid boolean, exactly the 5 contract keys).
 *   PO-S02-D-03 (pipeline side): restart determinism — two fresh service
 *     instances over the same fixture deep-equal (HP-003).
 *
 * Fixtures are REAL filesystem projects (temp dir + real git repo + canonical
 * `.proofloop` layout + kernel ReceiptWriter-produced receipts). No mocks, no
 * cached state files (HP-003).
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
// Closed value sets (kernel §5 — independent literals)
// ============================================================
const NEXT_ACTION_CLOSED_SET = [
    'DISPATCH_WORKER',
    'RUN_CV',
    'RUN_GATE',
    'ADMIT_WORKER_RESULT',
    'ADMIT_CV_RESULT',
    'ADMIT_SLICE_COMMIT',
    'ADMIT_INTEGRATION',
    'PREPARE_STAGE_REVIEW',
    'FINALIZE_STAGE_REVIEW',
    'COMPILE_ACCEPTANCE',
    'RUN_E2E',
    'INITIALIZE_EVIDENCE',
    'VALIDATE',
    'ADMIT_SPV_RESULT',
    'REPARTITION',
];
const ROLE_CLOSED_SET = [
    'brain',
    'planner',
    'executor',
    'worker',
    'code-verifier',
    'stage-reviewer',
    'researcher',
    'prototype',
    'committer',
    'general',
];
// ============================================================
// Fixture helpers (real temp dir + real git repo + real files)
// ============================================================
const cleanups = [];
(0, vitest_1.afterEach)(() => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        fn?.();
    }
});
const TASKS = ['S02-C-T01', 'S02-C-T02', 'S02-C-T03'];
function makeFx(stageId = 'S02') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-nextaction-'));
    (0, node_child_process_1.execFileSync)('git', ['init', '-q', root]);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.email', 'nextaction@test.local']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.name', 'NextAction Test']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
    const fx = {
        root,
        stageId,
        write: (rel, content) => {
            const p = path.join(root, rel);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content, 'utf-8');
        },
        writeManifest: (overrides = {}) => {
            const manifest = {
                stage_id: stageId,
                source_path: `delivery/stages/${stageId}/tasks.md`,
                source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
                stage_goal: 'Runtime core application services',
                outcomes: ['deterministic next action', 'finding not guessing'],
                slices: [makeSliceDef('S02-C', TASKS)],
                dependencies: [],
                risk_facts: [],
                ...overrides,
            };
            fx.write(`.proofloop/manifests/${stageId}.json`, JSON.stringify(manifest, null, 2));
        },
        writeTasksMd: (content) => fx.write(`delivery/stages/${stageId}/tasks.md`, content),
        writeEvidence: (sliceId, content) => fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, content),
        writeReceipt: (category, sliceId, overrides) => {
            const dir = sliceId !== undefined
                ? (0, runtime_1.receiptCategoryDir)(root, category, stageId, sliceId)
                : (0, runtime_1.receiptCategoryDir)(root, category, stageId);
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
            return fx.head();
        },
        head: () => (0, node_child_process_1.execFileSync)('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
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
/** Schema-valid manifest slice (known-good literals, independent of impl). */
function makeSliceDef(sliceId, taskIds) {
    return {
        slice_id: sliceId,
        goal: 'next action pipeline',
        observable_outcome: 'unique canonical next action from real project state',
        public_seam: '@proofloop/runtime NextActionService',
        dependencies: [],
        proof_obligations: [
            {
                po_id: 'PO-S02-D-04',
                behavior: 'pipeline output equals the pure derivation on the reconcile output',
                public_seam: 'NextActionService + deriveNextAction',
                oracle_source: 'real fixture project',
                success_criteria: 'pipeline vs pure deep-equal',
                required_observation: 'fixture oracle',
                applicable_risk_facts: ['core_state_machine'],
            },
        ],
        tasks: [...taskIds],
        risk_facts: ['core_state_machine'],
        evidence_path: `delivery/stages/${sliceId.slice(0, 3)}/evidence/${sliceId}.md`,
        cv_minimum_level: 'enhanced',
    };
}
function makeTasksMd(stageId, entries) {
    const out = [`# Stage ${stageId} — Runtime Core`];
    out.push(`<!-- SLICE:S02-C:BEGIN -->`, `## Slice S02-C`);
    for (const t of entries) {
        out.push(`- [${t.checked ? 'x' : ' '}] ${t.id}: task`);
    }
    out.push(`<!-- SLICE:S02-C:END -->`);
    return out.join('\n');
}
/** Canonical evidence file: per-task sections + PO matrix (finalized option). */
function makeEvidence(sliceId, writtenTasks, finalized = false) {
    const out = [
        `# Slice ${sliceId} Evidence`,
        ``,
        `## Task Evidence`,
        ``,
    ];
    for (const t of writtenTasks) {
        out.push(`### ${t}`, ``, `- Task Goal: next action`, `- Status: COMPLETE`, ``);
    }
    out.push(`## Current Slice Evidence`, ``, `### Proof Obligation Coverage`, ``, `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`, `|---|---|---|---|---|`);
    if (finalized) {
        out.push(`| PO-S02-D-04 | integration | r1 | g1 | PASS |`);
    }
    else {
        out.push(`| *None* | | | | |`);
    }
    out.push(``, `## Current CV Status`, ``, `- Status: NOT_RUN`, ``);
    return out.join('\n');
}
const allChecked = TASKS.map((id) => ({ id, checked: true }));
const firstUnchecked = TASKS.map((id, i) => ({ id, checked: i > 0 }));
const allUnchecked = TASKS.map((id) => ({ id, checked: false }));
/** Base fixture: valid manifest + tasks.md all checked + evidence finalized, no receipts. */
function baseFx(stageId = 'S02') {
    const fx = makeFx(stageId);
    fx.writeManifest();
    fx.writeTasksMd(makeTasksMd(stageId, allChecked));
    fx.writeEvidence('S02-C', makeEvidence('S02-C', TASKS, true));
    const head = fx.commitAll();
    return { fx, head };
}
/** Stage boundary receipts: STAGE_PLAN + SPV_PASS → stage EXECUTING. */
function planFx(stageId = 'S02') {
    const fx = makeFx(stageId);
    fx.writeManifest();
    fx.writeTasksMd(makeTasksMd(stageId, allChecked));
    fx.writeEvidence('S02-C', makeEvidence('S02-C', TASKS, true));
    const head = fx.commitAll();
    fx.writeReceipt('plan', undefined, {
        type: 'STAGE_PLAN',
        stage_id: stageId,
        timestamp: '2025-01-01T00:00:00.000Z',
    });
    fx.writeReceipt('plan', undefined, {
        type: 'SPV_PASS',
        stage_id: stageId,
        timestamp: '2025-01-02T00:00:00.000Z',
    });
    return { fx, head };
}
/** Fully consistent fixture: base + every category receipt aligned with git → stage COMPLETED. */
function fullFx(stageId = 'S02') {
    const { fx, head } = planFx(stageId);
    const cv = fx.writeReceipt('cv', 'S02-C', {
        type: 'CV_PASS',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-03T00:00:00.000Z',
    });
    fx.writeReceipt('committer', 'S02-C', {
        type: 'SLICE_COMMIT',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-04T00:00:00.000Z',
        payload: { slice_commit_sha: head, status: 'committed', cv_receipt_digest: cv.digest },
    });
    fx.writeReceipt('integration', 'S02-C', {
        type: 'INTEGRATION_PASS',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-05T00:00:00.000Z',
        payload: { status: 'integrated', slice_commit_sha: head },
    });
    fx.writeReceipt('review', undefined, {
        type: 'STAGE_REVIEW_PASS',
        stage_id: stageId,
        timestamp: '2025-01-06T00:00:00.000Z',
    });
    return { fx, head };
}
/** Partial fixture: T01 unchecked (no evidence section) + T02/T03 checked → implement-task row. */
function partialFx(stageId = 'S02') {
    const fx = makeFx(stageId);
    fx.writeManifest();
    fx.writeTasksMd(makeTasksMd(stageId, firstUnchecked));
    fx.writeEvidence('S02-C', makeEvidence('S02-C', ['S02-C-T02', 'S02-C-T03'], false));
    const head = fx.commitAll();
    fx.writeReceipt('plan', undefined, {
        type: 'STAGE_PLAN',
        stage_id: stageId,
        timestamp: '2025-01-01T00:00:00.000Z',
    });
    fx.writeReceipt('plan', undefined, {
        type: 'SPV_PASS',
        stage_id: stageId,
        timestamp: '2025-01-02T00:00:00.000Z',
    });
    return { fx, head };
}
/** INITIALIZE_EVIDENCE fixture: nothing started + evidence file missing + stage EXECUTING. */
function initializeFx(stageId = 'S02') {
    const fx = makeFx(stageId);
    fx.writeManifest();
    fx.writeTasksMd(makeTasksMd(stageId, allUnchecked));
    // NOTE: no evidence file is written.
    const head = fx.commitAll();
    fx.writeReceipt('plan', undefined, {
        type: 'STAGE_PLAN',
        stage_id: stageId,
        timestamp: '2025-01-01T00:00:00.000Z',
    });
    fx.writeReceipt('plan', undefined, {
        type: 'SPV_PASS',
        stage_id: stageId,
        timestamp: '2025-01-02T00:00:00.000Z',
    });
    return { fx, head };
}
/** Envelope fixture: partial + a pending worker result envelope in the results dir. */
function envelopeFx(stageId = 'S02') {
    const { fx, head } = partialFx(stageId);
    const dir = path.join(fx.root, '.pi', 'proofloop-runtime', 'results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tok-1.json'), JSON.stringify({
        schemaVersion: 1,
        actionToken: 'tok-1',
        stageId,
        sliceId: 'S02-C',
        taskId: 'S02-C-T01',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-C.md',
        changedFiles: [],
        verificationRuns: [],
        summary: 'done',
    }, null, 2), 'utf-8');
    return { fx, head };
}
/** Gate fixture: all slices integrated + GATE_PASS, NO STAGE_REVIEW_PASS → stage UNDER_REVIEW. */
function gateFx(stageId = 'S02') {
    const { fx, head } = planFx(stageId);
    const cv = fx.writeReceipt('cv', 'S02-C', {
        type: 'CV_PASS',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-03T00:00:00.000Z',
    });
    fx.writeReceipt('committer', 'S02-C', {
        type: 'SLICE_COMMIT',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-04T00:00:00.000Z',
        payload: { slice_commit_sha: head, status: 'committed', cv_receipt_digest: cv.digest },
    });
    fx.writeReceipt('integration', 'S02-C', {
        type: 'INTEGRATION_PASS',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-05T00:00:00.000Z',
        payload: { status: 'integrated', slice_commit_sha: head },
    });
    fx.writeReceipt('stage-gate', undefined, {
        type: 'GATE_PASS',
        stage_id: stageId,
        timestamp: '2025-01-06T00:00:00.000Z',
    });
    return { fx, head };
}
/** Gate-interrupted fixture: all slices integrated + GATE_INTERRUPTED only (S05-A-T05). */
function gateInterruptedFx(stageId = 'S02') {
    const { fx, head } = planFx(stageId);
    const cv = fx.writeReceipt('cv', 'S02-C', {
        type: 'CV_PASS',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-03T00:00:00.000Z',
    });
    fx.writeReceipt('committer', 'S02-C', {
        type: 'SLICE_COMMIT',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-04T00:00:00.000Z',
        payload: { slice_commit_sha: head, status: 'committed', cv_receipt_digest: cv.digest },
    });
    fx.writeReceipt('integration', 'S02-C', {
        type: 'INTEGRATION_PASS',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-05T00:00:00.000Z',
        payload: { status: 'integrated', slice_commit_sha: head },
    });
    fx.writeReceipt('stage-gate', undefined, {
        type: 'GATE_INTERRUPTED',
        stage_id: stageId,
        timestamp: '2025-01-06T00:00:00.000Z',
        payload: { reason: 'timeout', duration_ms: 300000 },
    });
    return { fx, head };
}
// ============================================================
// Helpers
// ============================================================
/** Contract-field view of a DerivedNextAction (drops slice/task/mode context). */
function contractOf(derived) {
    return {
        action: derived.action,
        action_detail: derived.action_detail,
        responsible_role: derived.responsible_role,
        receipt_chain_valid: derived.receipt_chain_valid,
        findings: [...derived.findings],
    };
}
/** proofloop_next structure contract (PO-S02-D-05). */
function expectContract(out) {
    (0, vitest_1.expect)(NEXT_ACTION_CLOSED_SET).toContain(out.action);
    (0, vitest_1.expect)(typeof out.action_detail).toBe('string');
    (0, vitest_1.expect)(out.action_detail.length).toBeGreaterThan(0);
    (0, vitest_1.expect)(ROLE_CLOSED_SET).toContain(out.responsible_role);
    (0, vitest_1.expect)(typeof out.receipt_chain_valid).toBe('boolean');
    (0, vitest_1.expect)(Array.isArray(out.findings)).toBe(true);
    (0, vitest_1.expect)(out.findings.length).toBeLessThanOrEqual(20);
    (0, vitest_1.expect)(Object.keys(out).sort()).toEqual([
        'action',
        'action_detail',
        'findings',
        'receipt_chain_valid',
        'responsible_role',
    ]);
}
// ============================================================
// Input validation
// ============================================================
(0, vitest_1.describe)('NextActionService — input validation', () => {
    (0, vitest_1.it)('missing projectRoot → TypeError', () => {
        const service = new runtime_1.NextActionService();
        (0, vitest_1.expect)(() => service.nextAction({ projectRoot: '', stageId: 'S02' })).toThrow(TypeError);
        (0, vitest_1.expect)(() => service.nextAction({ projectRoot: '', stageId: 'S02' })).toThrow(/projectRoot is required/);
    });
    (0, vitest_1.it)('missing stageId → TypeError', () => {
        const service = new runtime_1.NextActionService();
        (0, vitest_1.expect)(() => service.nextAction({ projectRoot: '/tmp', stageId: '' })).toThrow(TypeError);
        (0, vitest_1.expect)(() => service.nextAction({ projectRoot: '/tmp', stageId: '' })).toThrow(/stageId is required/);
    });
});
// ============================================================
// PO-S02-D-02 (pipeline side) — error-level inconsistency → VALIDATE
// ============================================================
(0, vitest_1.describe)('NextActionService — error-level inconsistency → VALIDATE (PO-S02-D-02)', () => {
    (0, vitest_1.it)('unknown-slice receipt → VALIDATE with findings, receipt_chain_valid stays truthful (true)', () => {
        const { fx } = baseFx();
        // Receipts exist for a slice the manifest does not declare.
        fx.writeReceipt('cv', 'S02-Z', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-Z',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const out = new runtime_1.NextActionService().nextAction({
            projectRoot: fx.root,
            stageId: fx.stageId,
        });
        expectContract(out);
        (0, vitest_1.expect)(out.action).toBe('VALIDATE');
        (0, vitest_1.expect)(out.findings.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(out.findings.some((f) => f.code === 'DOMAIN.STAGE_NOT_FOUND')).toBe(true);
        // The scanned category chains are intact — chain validity truthfully stays true.
        (0, vitest_1.expect)(out.receipt_chain_valid).toBe(true);
        // Never a guessed execution action.
        (0, vitest_1.expect)(out.action).not.toMatch(/DISPATCH|RUN_|ADMIT_|COMPILE|INITIALIZE/);
    });
    (0, vitest_1.it)('tampered receipt chain → VALIDATE with receipt_chain_valid=false (truthful chain state)', () => {
        const { fx } = baseFx();
        const r1 = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-01T00:00:00.000Z',
        });
        const r2 = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: r1.digest,
        });
        // Tamper with r2's content WITHOUT recomputing its digest.
        const raw = JSON.parse(fs.readFileSync(r2.path, 'utf-8'));
        raw.payload = { tampered: true };
        fs.writeFileSync(r2.path, JSON.stringify(raw));
        const out = new runtime_1.NextActionService().nextAction({
            projectRoot: fx.root,
            stageId: fx.stageId,
        });
        expectContract(out);
        (0, vitest_1.expect)(out.action).toBe('VALIDATE');
        (0, vitest_1.expect)(out.receipt_chain_valid).toBe(false);
        (0, vitest_1.expect)(out.findings.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(out.findings.some((f) => f.code === 'RUNTIME.RECEIPT_CHAIN_BROKEN')).toBe(true);
        (0, vitest_1.expect)(out.findings.every((f) => f.severity === 'error')).toBe(true);
    });
});
// ============================================================
// PO-S02-D-04 — pipeline composition equals the pure derivation
// ============================================================
(0, vitest_1.describe)('NextActionService — pipeline vs pure function composition (PO-S02-D-04)', () => {
    (0, vitest_1.it)('fully consistent fixture: pipeline output === pure deriveNextAction on the same reconcile output', () => {
        const { fx } = fullFx();
        const input = { projectRoot: fx.root, stageId: fx.stageId };
        const serviceOut = new runtime_1.NextActionService().nextAction(input);
        const pureOut = contractOf((0, runtime_1.deriveNextAction)((0, runtime_1.reconcileStage)(input)));
        expectContract(serviceOut);
        (0, vitest_1.expect)(serviceOut).toEqual(pureOut);
        (0, vitest_1.expect)(serviceOut.action).toBe('COMPILE_ACCEPTANCE');
        (0, vitest_1.expect)(serviceOut.receipt_chain_valid).toBe(true);
        (0, vitest_1.expect)(serviceOut.findings).toEqual([]);
    });
    (0, vitest_1.it)('partial fixture: pipeline output === pure deriveNextAction; DISPATCH_WORKER implement-task', () => {
        const { fx } = partialFx();
        const input = { projectRoot: fx.root, stageId: fx.stageId };
        const serviceOut = new runtime_1.NextActionService().nextAction(input);
        const pureOut = contractOf((0, runtime_1.deriveNextAction)((0, runtime_1.reconcileStage)(input)));
        expectContract(serviceOut);
        (0, vitest_1.expect)(serviceOut).toEqual(pureOut);
        (0, vitest_1.expect)(serviceOut.action).toBe('DISPATCH_WORKER');
        (0, vitest_1.expect)(serviceOut.action_detail).toContain('implement-task');
        (0, vitest_1.expect)(serviceOut.action_detail).toContain('S02-C-T01');
    });
    (0, vitest_1.it)('inconsistent fixture: both pipeline and pure path yield VALIDATE (chain-invalid branch)', () => {
        const { fx } = baseFx();
        const r1 = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-01T00:00:00.000Z',
        });
        const r2 = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: r1.digest,
        });
        const raw = JSON.parse(fs.readFileSync(r2.path, 'utf-8'));
        raw.payload = { tampered: true };
        fs.writeFileSync(r2.path, JSON.stringify(raw));
        const input = { projectRoot: fx.root, stageId: fx.stageId };
        const serviceOut = new runtime_1.NextActionService().nextAction(input);
        const pureOut = contractOf((0, runtime_1.deriveNextAction)((0, runtime_1.reconcileStage)(input)));
        expectContract(serviceOut);
        (0, vitest_1.expect)(serviceOut).toEqual(pureOut);
        (0, vitest_1.expect)(serviceOut.action).toBe('VALIDATE');
        (0, vitest_1.expect)(serviceOut.receipt_chain_valid).toBe(false);
    });
});
// ============================================================
// PO-S02-D-05 — proofloop_next output structure contract
// ============================================================
(0, vitest_1.describe)('NextActionService — output structure contract (PO-S02-D-05)', () => {
    (0, vitest_1.it)('every fixture output satisfies action/action_detail/role/findings/chain domains', () => {
        const outputs = [
            // Consistent full-completion → COMPILE_ACCEPTANCE.
            new runtime_1.NextActionService().nextAction({
                projectRoot: fullFx().fx.root,
                stageId: 'S02',
            }),
            // Partial → DISPATCH_WORKER.
            new runtime_1.NextActionService().nextAction({
                projectRoot: partialFx().fx.root,
                stageId: 'S02',
            }),
            // Nothing started + missing evidence → INITIALIZE_EVIDENCE.
            new runtime_1.NextActionService().nextAction({
                projectRoot: initializeFx().fx.root,
                stageId: 'S02',
            }),
            // Pending envelope → ADMIT_WORKER_RESULT.
            new runtime_1.NextActionService().nextAction({
                projectRoot: envelopeFx().fx.root,
                stageId: 'S02',
            }),
            // GATE_PASS under review → FINALIZE_STAGE_REVIEW.
            new runtime_1.NextActionService().nextAction({
                projectRoot: gateFx().fx.root,
                stageId: 'S02',
            }),
        ];
        (0, vitest_1.expect)(outputs).toHaveLength(5);
        (0, vitest_1.expect)(new Set(outputs.map((o) => o.action)).size).toBe(outputs.length);
        for (const out of outputs) {
            expectContract(out);
        }
    });
});
// ============================================================
// PO-S02-D-03 (pipeline side) — restart determinism (HP-003)
// ============================================================
(0, vitest_1.describe)('NextActionService — determinism across fresh instances (HP-003)', () => {
    (0, vitest_1.it)('same fixture through two fresh service instances deep-equals', () => {
        const { fx } = fullFx();
        const input = { projectRoot: fx.root, stageId: fx.stageId };
        const first = new runtime_1.NextActionService().nextAction(input);
        const second = new runtime_1.NextActionService().nextAction(input);
        (0, vitest_1.expect)(second).toEqual(first);
        (0, vitest_1.expect)(JSON.stringify(second)).toBe(JSON.stringify(first));
        (0, vitest_1.expect)(first.action).toBe('COMPILE_ACCEPTANCE');
    });
    (0, vitest_1.it)('deterministic with findings present (inconsistent fixture)', () => {
        const { fx } = baseFx();
        fx.writeReceipt('cv', 'S02-Z', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-Z',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const input = { projectRoot: fx.root, stageId: fx.stageId };
        const first = new runtime_1.NextActionService().nextAction(input);
        const second = new runtime_1.NextActionService().nextAction(input);
        (0, vitest_1.expect)(second).toEqual(first);
        (0, vitest_1.expect)(first.findings.length).toBeGreaterThan(0);
    });
});
// ============================================================
// Extras — deterministic persisted facts (pipeline-specific behaviors)
// ============================================================
(0, vitest_1.describe)('NextActionService — persisted extras change the derivation only with positive facts', () => {
    (0, vitest_1.it)('manifest repartition_requested=true on COMPLETED → REPARTITION (pure path: COMPILE_ACCEPTANCE)', () => {
        const { fx } = fullFx();
        // Overwrite the work-tree manifest with the canonical F-S02-08 fact.
        const manifestPath = path.join(fx.root, '.proofloop', 'manifests', `${fx.stageId}.json`);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        manifest.repartition_requested = true;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const input = { projectRoot: fx.root, stageId: fx.stageId };
        const serviceOut = new runtime_1.NextActionService().nextAction(input);
        expectContract(serviceOut);
        (0, vitest_1.expect)(serviceOut.action).toBe('REPARTITION');
        // The pure function over the raw reconcile output cannot see the manifest
        // fact → COMPILE_ACCEPTANCE. The pipeline's extras drive REPARTITION.
        (0, vitest_1.expect)(contractOf((0, runtime_1.deriveNextAction)((0, runtime_1.reconcileStage)(input))).action).toBe('COMPILE_ACCEPTANCE');
    });
    (0, vitest_1.it)('planned slice with missing evidence file → INITIALIZE_EVIDENCE (pure path: implement-task)', () => {
        const { fx } = initializeFx();
        const input = { projectRoot: fx.root, stageId: fx.stageId };
        const serviceOut = new runtime_1.NextActionService().nextAction(input);
        expectContract(serviceOut);
        (0, vitest_1.expect)(serviceOut.action).toBe('INITIALIZE_EVIDENCE');
        (0, vitest_1.expect)(serviceOut.action_detail).toContain('S02-C');
        // Without the evidence-file existence fact the raw pure path would guess
        // implement-task for the first unchecked task.
        (0, vitest_1.expect)(contractOf((0, runtime_1.deriveNextAction)((0, runtime_1.reconcileStage)(input))).action).toBe('DISPATCH_WORKER');
    });
    (0, vitest_1.it)('pending worker result envelope → ADMIT_WORKER_RESULT (pure path: implement-task)', () => {
        const { fx } = envelopeFx();
        const input = { projectRoot: fx.root, stageId: fx.stageId };
        const serviceOut = new runtime_1.NextActionService().nextAction(input);
        expectContract(serviceOut);
        (0, vitest_1.expect)(serviceOut.action).toBe('ADMIT_WORKER_RESULT');
        (0, vitest_1.expect)(serviceOut.action_detail).toContain('tok-1');
        // The envelope is the pipeline-only persisted fact — the raw pure path
        // would dispatch the next task.
        (0, vitest_1.expect)(contractOf((0, runtime_1.deriveNextAction)((0, runtime_1.reconcileStage)(input))).action).toBe('DISPATCH_WORKER');
    });
    (0, vitest_1.it)('GATE_PASS receipt present under review → FINALIZE_STAGE_REVIEW (pure path: RUN_GATE)', () => {
        const { fx } = gateFx();
        const input = { projectRoot: fx.root, stageId: fx.stageId };
        const serviceOut = new runtime_1.NextActionService().nextAction(input);
        expectContract(serviceOut);
        (0, vitest_1.expect)(serviceOut.action).toBe('FINALIZE_STAGE_REVIEW');
        // The gate presence is a pipeline-only persisted fact — without it the
        // raw pure path would emit RUN_GATE (all integrated, no GATE_PASS seen).
        (0, vitest_1.expect)(contractOf((0, runtime_1.deriveNextAction)((0, runtime_1.reconcileStage)(input))).action).toBe('RUN_GATE');
    });
});
// ============================================================
// GATE_INTERRUPTED — retry semantics (PO-S05-A-06, HP-004/AWI-015)
// ============================================================
(0, vitest_1.describe)('NextActionService — GATE_INTERRUPTED is retryable, never GATE_FAIL/GATE_PASS (PO-S05-A-06)', () => {
    (0, vitest_1.it)('GATE_INTERRUPTED-only stage-gate category → RUN_GATE (gate retry), no GATE_FAIL finding, chain valid', () => {
        const { fx } = gateInterruptedFx();
        const input = { projectRoot: fx.root, stageId: fx.stageId };
        const out = new runtime_1.NextActionService().nextAction(input);
        expectContract(out);
        // gate_fail_present matches ONLY GATE_FAIL receipts and gate_pass_present
        // ONLY GATE_PASS receipts — an interruption is neither, so the gate is
        // still pending and retryable (row 11).
        (0, vitest_1.expect)(out.action).toBe('RUN_GATE');
        (0, vitest_1.expect)(out.receipt_chain_valid).toBe(true);
        (0, vitest_1.expect)(out.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(false);
    });
    (0, vitest_1.it)('GATE_INTERRUPTED + GATE_FAIL → VALIDATE with the GATE_FAIL blocking finding (GATE_FAIL still wins)', () => {
        const { fx } = gateInterruptedFx();
        fx.writeReceipt('stage-gate', undefined, {
            type: 'GATE_FAIL',
            stage_id: fx.stageId,
            timestamp: '2025-01-07T00:00:00.000Z',
            payload: { verdict: 'FAIL' },
        });
        const out = new runtime_1.NextActionService().nextAction({
            projectRoot: fx.root,
            stageId: fx.stageId,
        });
        expectContract(out);
        (0, vitest_1.expect)(out.action).toBe('VALIDATE');
        (0, vitest_1.expect)(out.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(true);
    });
    (0, vitest_1.it)('GATE_INTERRUPTED is never derived as GATE_PASS: no FINALIZE_STAGE_REVIEW without a real GATE_PASS', () => {
        const { fx } = gateInterruptedFx();
        const out = new runtime_1.NextActionService().nextAction({
            projectRoot: fx.root,
            stageId: fx.stageId,
        });
        (0, vitest_1.expect)(out.action).not.toBe('FINALIZE_STAGE_REVIEW');
        (0, vitest_1.expect)(out.action).not.toBe('VALIDATE');
        // the pure path agrees: the derive table sees no GATE_PASS/GATE_FAIL fact
        (0, vitest_1.expect)(contractOf((0, runtime_1.deriveNextAction)((0, runtime_1.reconcileStage)({ projectRoot: fx.root, stageId: fx.stageId }))).action).toBe('RUN_GATE');
    });
});
//# sourceMappingURL=next-action-service.spec.js.map