"use strict";
/**
 * admission.spec.ts — S02-E-T01 (PO-S02-E-01 skeleton part)
 *
 * Public seam: `@proofloop/runtime` — the 7-member `AdmissionRequest`
 * discriminated union + the unified admit pipeline `runAdmitPipeline` (the
 * AWI-006 pipeline: request schema validation → reconcile current state →
 * reducer precheck → canonical Receipt construction → kernel `writeReceipt`
 * → post-write chain verification → `{ accepted, receipt_ref, new_state,
 * findings }`).
 *
 * Covered in this task:
 *  1. Schema validation of all 7 request types — valid passes, invalid
 *     variants fail closed with `SchemaValidationError`
 *     (RUNTIME.SCHEMA_MISMATCH) carrying per-field errors; the
 *     `worker_result` envelope reuses the canonical S02-B
 *     `validateWorkerResultEnvelope` seam.
 *  2. The pipeline fails closed on invalid input — a structured rejection
 *     (accepted=false, receipt_ref=null, SCHEMA_MISMATCH finding) and the
 *     writer is never invoked.
 *  3. The pipeline persists receipts ONLY through the injected
 *     `ReceiptWriterPort` (kernel ReceiptWriter by default): a fake writer
 *     proves every write goes through the port, and a static source scan of
 *     `admit-pipeline.ts` proves the module contains no direct file-write
 *     API (mkdir scaffolding and chain-tip reads are the only fs access).
 *  4. Pipeline skeleton behavior: precheck rejection (no Receipt), broken
 *     category chain refusal (RUNTIME.RECEIPT_CHAIN_BROKEN), all-7-types
 *     pipeline runs mapping to the canonical receipt type/category, and
 *     `previous_digest` chain-tip linkage against a REAL fixture directory
 *     written through the kernel ReceiptWriter.
 *
 * Expected values below are known-good literals taken from the authority
 * excerpts (kernel §4/§5/§6/§7, AWI-006) — not derived from the
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
const kernel_1 = require("@proofloop/kernel");
const kernel_2 = require("@proofloop/kernel");
const runtime_1 = require("@proofloop/runtime");
// ============================================================
// Known-good literals (authority excerpts — never derived)
// ============================================================
const STAGE_ID = 'S02';
const SLICE_ID = 'S02-E';
const FIXED_TIMESTAMP = '2025-01-01T00:00:00.000Z';
const COMMIT_SHA = 'c'.repeat(40);
const CV_RECEIPT_DIGEST = 'd'.repeat(64);
const MANIFEST_DIGEST = 'e'.repeat(64);
const VALID_ENVELOPE = {
    schemaVersion: 1,
    actionToken: 'tok-1',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: 'S02-E-T01',
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: 'delivery/stages/S02/evidence/S02-E.md',
    changedFiles: ['packages/runtime/src/admission-request.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 'skeleton done',
};
/** One valid request per union member — the 7 AdmissionRequest types. */
function validRequests() {
    return [
        { type: 'worker_result', envelope: VALID_ENVELOPE },
        {
            type: 'cv_result',
            stageId: STAGE_ID,
            sliceId: SLICE_ID,
            verdict: 'PASS',
            snapshotDigest: COMMIT_SHA,
            summary: 'cv pass',
        },
        {
            type: 'slice_commit',
            stageId: STAGE_ID,
            sliceId: SLICE_ID,
            commitSha: COMMIT_SHA,
            cvReceiptDigest: CV_RECEIPT_DIGEST,
        },
        {
            type: 'integration',
            stageId: STAGE_ID,
            sliceId: SLICE_ID,
            commitSha: COMMIT_SHA,
        },
        { type: 'stage_review', stageId: STAGE_ID, verdict: 'ACCEPTED', summary: 'ok' },
        { type: 'project_review', stageId: STAGE_ID, verdict: 'REPAIR', summary: 'fix' },
        { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST },
    ];
}
/** Invalid variants — one or more per union member (fail-closed matrix). */
const INVALID_VARIANTS = [
    ['worker_result — envelope outcome outside the closed set', {
            type: 'worker_result',
            envelope: { ...VALID_ENVELOPE, outcome: 'bogus' },
        }],
    ['worker_result — envelope stageId violates the identifier charset (path safety)', {
            type: 'worker_result',
            envelope: { ...VALID_ENVELOPE, stageId: '../../evil' },
        }],
    ['worker_result — envelope sliceId violates the identifier charset (path safety)', {
            type: 'worker_result',
            envelope: { ...VALID_ENVELOPE, sliceId: '../S02-E' },
        }],
    ['cv_result — stageId violates the identifier charset (path safety)', {
            type: 'cv_result',
            stageId: '../../evil',
            sliceId: SLICE_ID,
            verdict: 'PASS',
            snapshotDigest: COMMIT_SHA,
            summary: 's',
        }],
    ['cv_result — sliceId violates the identifier charset (path safety)', {
            type: 'cv_result',
            stageId: STAGE_ID,
            sliceId: 'S02/../x',
            verdict: 'PASS',
            snapshotDigest: COMMIT_SHA,
            summary: 's',
        }],
    ['slice_commit — sliceId violates the identifier charset (path safety)', {
            type: 'slice_commit',
            stageId: STAGE_ID,
            sliceId: 'S02..\\evil',
            commitSha: COMMIT_SHA,
            cvReceiptDigest: CV_RECEIPT_DIGEST,
        }],
    ['stage_review — stageId violates the identifier charset (path safety)', {
            type: 'stage_review',
            stageId: '../S02',
            verdict: 'ACCEPTED',
            summary: 's',
        }],
    ['project_review — stageId violates the identifier charset (path safety)', {
            type: 'project_review',
            stageId: 'S 02',
            verdict: 'ACCEPTED',
            summary: 's',
        }],
    ['stage_plan — stageId violates the identifier charset (path safety)', {
            type: 'stage_plan',
            stageId: '../../evil',
            manifestDigest: MANIFEST_DIGEST,
        }],
    ['worker_result — envelope missing entirely', { type: 'worker_result' }],
    ['worker_result — envelope carries an unknown field', {
            type: 'worker_result',
            envelope: { ...VALID_ENVELOPE, extra: 1 },
        }],
    ['worker_result — top-level unknown field', {
            type: 'worker_result',
            envelope: VALID_ENVELOPE,
            stageId: STAGE_ID,
        }],
    ['cv_result — verdict outside {PASS, REPAIR}', {
            type: 'cv_result',
            stageId: STAGE_ID,
            sliceId: SLICE_ID,
            verdict: 'CONFIRMED',
            snapshotDigest: COMMIT_SHA,
            summary: 's',
        }],
    ['cv_result — snapshot binding missing', {
            type: 'cv_result',
            stageId: STAGE_ID,
            sliceId: SLICE_ID,
            verdict: 'PASS',
            summary: 's',
        }],
    ['cv_result — unknown field', {
            type: 'cv_result',
            stageId: STAGE_ID,
            sliceId: SLICE_ID,
            verdict: 'PASS',
            snapshotDigest: COMMIT_SHA,
            summary: 's',
            extra: true,
        }],
    ['slice_commit — commitSha missing', {
            type: 'slice_commit',
            stageId: STAGE_ID,
            sliceId: SLICE_ID,
            cvReceiptDigest: CV_RECEIPT_DIGEST,
        }],
    ['slice_commit — cvReceiptDigest missing', {
            type: 'slice_commit',
            stageId: STAGE_ID,
            sliceId: SLICE_ID,
            commitSha: COMMIT_SHA,
        }],
    ['integration — sliceId missing', {
            type: 'integration',
            stageId: STAGE_ID,
            commitSha: COMMIT_SHA,
        }],
    ['stage_review — verdict outside {ACCEPTED, REPAIR}', {
            type: 'stage_review',
            stageId: STAGE_ID,
            verdict: 'REJECTED',
            summary: 's',
        }],
    ['project_review — summary missing', {
            type: 'project_review',
            stageId: STAGE_ID,
            verdict: 'ACCEPTED',
        }],
    ['stage_plan — manifestDigest missing', { type: 'stage_plan', stageId: STAGE_ID }],
    ['unknown type discriminant', { type: 'spv_pass', stageId: STAGE_ID }],
    ['non-object input', 'nope'],
    ['null input', null],
];
/** Deterministic reconciled stage state used as the fake reconcile output. */
function fakeReconciledState(stageId = STAGE_ID) {
    return {
        stage_id: stageId,
        slices: [],
        stage_state: kernel_2.StageState.EXECUTING,
        project_state: kernel_2.ProjectState.IN_PROGRESS,
        receipt_chain: [],
        findings: [],
        receipt_chain_valid: true,
        receipt_categories: [],
    };
}
function makeFakeWriter(chainValid = true) {
    const state = { writeCalls: [], verifyChainCalls: [] };
    const writer = {
        write(data, options) {
            state.writeCalls.push({ data: data, options });
            return { path: '/fake/receipts/abc.json', digest: 'fake-digest-64-hex' };
        },
        verifyChain(receiptDir) {
            state.verifyChainCalls.push(receiptDir);
            if (!chainValid) {
                return {
                    valid: false,
                    receipts: [],
                    brokenLink: { index: 0, expected: '(genesis)', actual: '(tampered digest)' },
                };
            }
            return { valid: true, receipts: [] };
        },
    };
    return { writer, state };
}
/** Per-request-type step wiring (receipt type + canonical category dir). */
const SLICE_BOUND_TYPES = new Set([
    'worker_result',
    'cv_result',
    'slice_commit',
    'integration',
]);
const RECEIPT_TYPE_BY_REQUEST = {
    worker_result: 'TASK_COMPLETE',
    cv_result: 'CV_PASS',
    slice_commit: 'SLICE_COMMIT',
    integration: 'INTEGRATION_PASS',
    stage_review: 'STAGE_REVIEW_PASS',
    project_review: 'PROJECT_REVIEW_PASS',
    stage_plan: 'STAGE_PLAN',
    spv_result: 'SPV_PASS',
    gate_result: 'GATE_PASS',
    gate_interrupted: 'GATE_INTERRUPTED',
};
function targetDirFor(root, type) {
    switch (type) {
        case 'worker_result': return path.join(root, 'tasks', STAGE_ID, SLICE_ID);
        case 'cv_result': return path.join(root, 'cv', STAGE_ID, SLICE_ID);
        case 'slice_commit': return path.join(root, 'committer', STAGE_ID, SLICE_ID);
        case 'integration': return path.join(root, 'integration', STAGE_ID, SLICE_ID);
        case 'stage_review': return path.join(root, 'review', STAGE_ID);
        case 'project_review': return path.join(root, 'project');
        case 'stage_plan': return path.join(root, 'plan', STAGE_ID);
        case 'spv_result': return path.join(root, 'plan', STAGE_ID);
        case 'gate_result': return path.join(root, 'stage-gate', STAGE_ID);
        case 'gate_interrupted': return path.join(root, 'stage-gate', STAGE_ID);
    }
}
function makeSteps(request, root, nextState = fakeReconciledState()) {
    return {
        precheck: () => ({ accepted: true, nextState }),
        buildReceipt: () => ({
            type: RECEIPT_TYPE_BY_REQUEST[request.type],
            stage_id: STAGE_ID,
            ...(SLICE_BOUND_TYPES.has(request.type) ? { slice_id: SLICE_ID } : {}),
            timestamp: FIXED_TIMESTAMP,
            payload: { request_type: request.type },
        }),
        targetDir: () => targetDirFor(root, request.type),
    };
}
// ============================================================
// Temp fixture helper
// ============================================================
const TEMP_ROOTS = [];
function makeTempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-s02e-'));
    TEMP_ROOTS.push(root);
    return root;
}
(0, vitest_1.afterAll)(() => {
    for (const root of TEMP_ROOTS) {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        }
        catch { /* best-effort */ }
    }
});
// ============================================================
// 1. Schema validation — the 7 AdmissionRequest types
// ============================================================
(0, vitest_1.describe)('AdmissionRequest schema validation (PO-S02-E-01 skeleton)', () => {
    (0, vitest_1.it)('closed discriminant set: the 10 canonical request types (7 S02 + SPV/GATE S03 + gate_interrupted S05)', () => {
        (0, vitest_1.expect)(runtime_1.ADMISSION_REQUEST_TYPES).toEqual([
            'worker_result',
            'cv_result',
            'slice_commit',
            'integration',
            'stage_review',
            'project_review',
            'stage_plan',
            'spv_result',
            'gate_result',
            'gate_interrupted',
        ]);
    });
    (0, vitest_1.it)('closed verdict sets: CV {PASS, REPAIR} and review {ACCEPTED, REPAIR}', () => {
        (0, vitest_1.expect)(runtime_1.CV_VERDICTS).toEqual(['PASS', 'REPAIR']);
        (0, vitest_1.expect)(runtime_1.REVIEW_VERDICTS).toEqual(['ACCEPTED', 'REPAIR']);
    });
    (0, vitest_1.it)('all 7 valid request types pass assertAdmissionRequest', () => {
        for (const request of validRequests()) {
            (0, vitest_1.expect)(() => (0, runtime_1.assertAdmissionRequest)(request), `valid ${request.type}`).not.toThrow();
        }
    });
    (0, vitest_1.it)('all 7 request types carry a stageId binding readable via admissionRequestStageId', () => {
        for (const request of validRequests()) {
            (0, vitest_1.expect)((0, runtime_1.admissionRequestStageId)(request)).toBe(STAGE_ID);
        }
    });
    (0, vitest_1.it)('slice-bound request types expose their sliceId; stage-level types return null', () => {
        for (const request of validRequests()) {
            const expected = SLICE_BOUND_TYPES.has(request.type) ? SLICE_ID : null;
            (0, vitest_1.expect)((0, runtime_1.admissionRequestSliceId)(request), request.type).toBe(expected);
        }
    });
    vitest_1.it.each(INVALID_VARIANTS)('invalid variant rejected fail-closed: %s', (_label, value) => {
        (0, vitest_1.expect)(() => (0, runtime_1.assertAdmissionRequest)(value)).toThrow(runtime_1.SchemaValidationError);
        let thrown;
        try {
            (0, runtime_1.assertAdmissionRequest)(value);
        }
        catch (err) {
            thrown = err;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(runtime_1.SchemaValidationError);
        const err = thrown;
        (0, vitest_1.expect)(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(err.fieldErrors.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(err.message.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('worker_result reuses the S02-B envelope validator with envelope-prefixed field errors', () => {
        let thrown;
        try {
            (0, runtime_1.assertAdmissionRequest)({
                type: 'worker_result',
                envelope: { ...VALID_ENVELOPE, outcome: 'bogus' },
            });
        }
        catch (err) {
            thrown = err;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(runtime_1.SchemaValidationError);
        const err = thrown;
        (0, vitest_1.expect)(err.fieldErrors.some((fe) => fe.path === 'envelope.outcome')).toBe(true);
    });
});
// ============================================================
// 2. Unified admit pipeline — fail-closed + port-only persistence
// ============================================================
(0, vitest_1.describe)('runAdmitPipeline (PO-S02-E-01 pipeline skeleton)', () => {
    (0, vitest_1.it)('accepts a valid request: one receipt written through the port, structured result', () => {
        const root = makeTempRoot();
        const { writer, state } = makeFakeWriter();
        const nextState = fakeReconciledState();
        const request = { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST };
        const result = (0, runtime_1.runAdmitPipeline)({ request, reconcile: () => fakeReconciledState(), steps: makeSteps(request, root, nextState), writer });
        (0, vitest_1.expect)(result.accepted).toBe(true);
        (0, vitest_1.expect)(result.receipt_ref).toBe('fake-digest-64-hex');
        (0, vitest_1.expect)(result.new_state).toEqual(nextState);
        (0, vitest_1.expect)(result.findings).toEqual([]);
        // Exactly one persistence call, through the port.
        (0, vitest_1.expect)(state.writeCalls).toHaveLength(1);
        const data = state.writeCalls[0].data;
        (0, vitest_1.expect)(data.version).toBe(1);
        (0, vitest_1.expect)(data.type).toBe('STAGE_PLAN');
        (0, vitest_1.expect)(data.stage_id).toBe(STAGE_ID);
        (0, vitest_1.expect)(data.timestamp).toBe(FIXED_TIMESTAMP);
        (0, vitest_1.expect)(data.payload).toEqual({ request_type: 'stage_plan' });
        // The pipeline hands the writer a digest-free receipt — the kernel
        // ReceiptWriter computes the content-addressed digest itself.
        (0, vitest_1.expect)(data.digest).toBeUndefined();
        // Empty chain → no previous_digest (genesis linkage).
        (0, vitest_1.expect)(data.previous_digest).toBeUndefined();
    });
    (0, vitest_1.it)('fails closed on invalid input: structured rejection, no reconcile, no write', () => {
        const { writer, state } = makeFakeWriter();
        let reconcileCalled = false;
        const result = (0, runtime_1.runAdmitPipeline)({
            request: { type: 'spv_pass', stageId: STAGE_ID },
            reconcile: () => { reconcileCalled = true; return fakeReconciledState(); },
            steps: makeSteps({ type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST }, makeTempRoot()),
            writer,
        });
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.new_state).toBeNull();
        (0, vitest_1.expect)(result.findings).toHaveLength(1);
        (0, vitest_1.expect)(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(result.findings[0].severity).toBe('error');
        (0, vitest_1.expect)(reconcileCalled).toBe(false);
        (0, vitest_1.expect)(state.writeCalls).toHaveLength(0);
        (0, vitest_1.expect)(state.verifyChainCalls).toHaveLength(0);
    });
    (0, vitest_1.it)('rejects when the reducer precheck refuses the transition — no Receipt is written', () => {
        const root = makeTempRoot();
        const { writer, state } = makeFakeWriter();
        const state0 = fakeReconciledState();
        const steps = {
            ...makeSteps({ type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST }, root, state0),
            precheck: () => ({
                accepted: false,
                findings: [{
                        code: 'DOMAIN.INVALID_TRANSITION',
                        severity: 'error',
                        message: 'stage S02 is not UNINITIALIZED — STAGE_PLAN admit refused',
                    }],
            }),
        };
        const result = (0, runtime_1.runAdmitPipeline)({
            request: { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST },
            reconcile: () => state0,
            steps,
            writer,
        });
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.new_state).toEqual(state0);
        (0, vitest_1.expect)(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
        // Refused before any chain check or write.
        (0, vitest_1.expect)(state.writeCalls).toHaveLength(0);
        (0, vitest_1.expect)(state.verifyChainCalls).toHaveLength(0);
    });
    (0, vitest_1.it)('refuses to append to a broken category chain (RUNTIME.RECEIPT_CHAIN_BROKEN)', () => {
        const root = makeTempRoot();
        const { writer, state } = makeFakeWriter(false);
        const result = (0, runtime_1.runAdmitPipeline)({
            request: { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST },
            reconcile: () => fakeReconciledState(),
            steps: makeSteps({ type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST }, root),
            writer,
        });
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
        (0, vitest_1.expect)(state.verifyChainCalls).toHaveLength(1);
        (0, vitest_1.expect)(state.writeCalls).toHaveLength(0);
    });
    (0, vitest_1.it)('returns a structured rejection when reconcile fails', () => {
        const { writer, state } = makeFakeWriter();
        const result = (0, runtime_1.runAdmitPipeline)({
            request: { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST },
            reconcile: () => { throw new Error('fixture reconcile failure'); },
            steps: makeSteps({ type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST }, makeTempRoot()),
            writer,
        });
        (0, vitest_1.expect)(result.accepted).toBe(false);
        (0, vitest_1.expect)(result.receipt_ref).toBeNull();
        (0, vitest_1.expect)(result.new_state).toBeNull();
        (0, vitest_1.expect)(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(state.writeCalls).toHaveLength(0);
    });
    (0, vitest_1.it)('runs the full pipeline for all 7 request types with the canonical receipt binding', () => {
        for (const request of validRequests()) {
            const root = makeTempRoot();
            const { writer, state } = makeFakeWriter();
            const result = (0, runtime_1.runAdmitPipeline)({
                request,
                reconcile: () => fakeReconciledState(),
                steps: makeSteps(request, root),
                writer,
            });
            (0, vitest_1.expect)(result.accepted, request.type).toBe(true);
            (0, vitest_1.expect)(result.receipt_ref, request.type).toBe('fake-digest-64-hex');
            (0, vitest_1.expect)(result.findings, request.type).toEqual([]);
            (0, vitest_1.expect)(state.writeCalls).toHaveLength(1);
            const data = state.writeCalls[0].data;
            (0, vitest_1.expect)(data.type, request.type).toBe(RECEIPT_TYPE_BY_REQUEST[request.type]);
            (0, vitest_1.expect)(data.stage_id, request.type).toBe(STAGE_ID);
            const expectedSlice = SLICE_BOUND_TYPES.has(request.type) ? SLICE_ID : undefined;
            (0, vitest_1.expect)(data.slice_id, request.type).toBe(expectedSlice);
            // The write lands in the canonical category directory of the receipt type.
            (0, vitest_1.expect)(state.verifyChainCalls).toContain(targetDirFor(root, request.type));
        }
    });
});
// ============================================================
// 3. previous_digest linkage against a REAL fixture directory
// ============================================================
(0, vitest_1.describe)('previous_digest chain linkage (real fixture directory)', () => {
    (0, vitest_1.it)('links the new receipt to the existing category chain tip via the kernel writer', () => {
        const root = makeTempRoot();
        const targetDir = path.join(root, 'plan', STAGE_ID);
        fs.mkdirSync(targetDir, { recursive: true });
        // Seed a genesis STAGE_PLAN receipt through the kernel ReceiptWriter.
        const seeded = (0, kernel_1.writeReceipt)({
            version: 1,
            type: 'STAGE_PLAN',
            stage_id: STAGE_ID,
            timestamp: '2024-12-01T00:00:00.000Z',
            payload: { seeded: true },
        }, { receiptDir: targetDir, tempDir: targetDir });
        const request = { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST };
        const result = (0, runtime_1.runAdmitPipeline)({
            request,
            reconcile: () => fakeReconciledState(),
            steps: {
                precheck: () => ({ accepted: true, nextState: fakeReconciledState() }),
                buildReceipt: () => ({
                    type: 'STAGE_PLAN',
                    stage_id: STAGE_ID,
                    timestamp: FIXED_TIMESTAMP,
                    payload: { manifest_digest: MANIFEST_DIGEST },
                }),
                targetDir: () => targetDir,
            },
            // Default port = kernel ReceiptWriter + verifyReceiptChain.
        });
        (0, vitest_1.expect)(result.accepted).toBe(true);
        // The new receipt is content-addressed — distinct payload ⇒ distinct digest.
        (0, vitest_1.expect)(result.receipt_ref).not.toBe(seeded.digest);
        // The full chain is intact and both receipts are linked.
        const chain = (0, kernel_1.verifyReceiptChain)(targetDir);
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toHaveLength(2);
        // The new receipt's previous_digest points at the seeded genesis digest.
        const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.json')).sort();
        const newReceiptRaw = files
            .map((f) => JSON.parse(fs.readFileSync(path.join(targetDir, f), 'utf-8')))
            .find((r) => r.digest === result.receipt_ref);
        (0, vitest_1.expect)(newReceiptRaw).toBeDefined();
        (0, vitest_1.expect)(newReceiptRaw?.previous_digest).toBe(seeded.digest);
        (0, vitest_1.expect)(newReceiptRaw?.type).toBe('STAGE_PLAN');
    });
});
// ============================================================
// 4. Port-only persistence — source-level guard + default port
// ============================================================
(0, vitest_1.describe)('no direct file writes outside the ReceiptWriterPort (AWI-006)', () => {
    (0, vitest_1.it)('admit-pipeline.ts contains no direct file-write API', () => {
        const src = fs.readFileSync(path.join(__dirname, 'admit-pipeline.ts'), 'utf8');
        const banned = [
            ['writeFileSync', 'writeFileSync'],
            ['writeFile(', 'writeFile('],
            ['appendFileSync', 'appendFileSync'],
            ['appendFile(', 'appendFile('],
            ['createWriteStream', 'createWriteStream'],
            ['copyFileSync', 'copyFileSync'],
            ['renameSync', 'renameSync'],
        ];
        for (const [label, token] of banned) {
            (0, vitest_1.expect)(src.includes(token), `admit-pipeline.ts must not call ${label}`).toBe(false);
        }
        // Directory scaffolding (mkdir) and read-only chain-tip resolution are
        // the ONLY fs access — persistence always goes through the port.
        (0, vitest_1.expect)(src.includes('mkdirSync')).toBe(true);
    });
    (0, vitest_1.it)('admission.ts (the 7 admit methods) contains no direct file-write API', () => {
        // PO-S02-E-01 — the service (admission.ts) must not bypass the unified
        // pipeline with a direct filesystem write. The pipeline source scan
        // alone does not prove the METHODS are clean; the methods themselves are
        // scanned here (S02-E-T05 matrix completion).
        const src = fs.readFileSync(path.join(__dirname, 'admission.ts'), 'utf8');
        const banned = [
            ['writeFileSync', 'writeFileSync'],
            ['writeFile(', 'writeFile('],
            ['appendFileSync', 'appendFileSync'],
            ['appendFile(', 'appendFile('],
            ['createWriteStream', 'createWriteStream'],
            ['copyFileSync', 'copyFileSync'],
            ['renameSync', 'renameSync'],
        ];
        for (const [label, token] of banned) {
            (0, vitest_1.expect)(src.includes(token), `admission.ts must not call ${label}`).toBe(false);
        }
    });
    (0, vitest_1.it)('all 7 admit methods route persistence through runAdmitPipeline (single creation path)', () => {
        // PO-S02-E-01 — the unified pipeline is the ONLY Receipt-creation path
        // for the 7 admit methods: every method body is a `return
        // runAdmitPipeline({...})` delegation, and the module contains exactly
        // one such call per method (no other write path exists).
        const src = fs.readFileSync(path.join(__dirname, 'admission.ts'), 'utf8');
        const methodNames = [
            'admitWorkerResult',
            'admitCVResult',
            'admitSliceCommit',
            'admitIntegration',
            'admitStageReview',
            'admitProjectReview',
            'admitStagePlan',
        ];
        for (const name of methodNames) {
            (0, vitest_1.expect)(src.includes(`export function ${name}(`), `admission.ts exports ${name}`).toBe(true);
        }
        // Exactly one pipeline invocation per admit method (7 total) — the
        // single creation path is exhaustive for the Stage's 7 admit kinds.
        const pipelineCalls = src.split('runAdmitPipeline({').length - 1;
        (0, vitest_1.expect)(pipelineCalls).toBe(7);
    });
    (0, vitest_1.it)('defaultReceiptWriter delegates to the kernel ReceiptWriter seam (real write + chain verify)', () => {
        const root = makeTempRoot();
        const dir = path.join(root, 'plan', STAGE_ID);
        fs.mkdirSync(dir, { recursive: true });
        const written = runtime_1.defaultReceiptWriter.write({
            version: 1,
            type: 'STAGE_PLAN',
            stage_id: STAGE_ID,
            timestamp: FIXED_TIMESTAMP,
            payload: { manifest_digest: MANIFEST_DIGEST },
        }, { receiptDir: dir, tempDir: dir });
        (0, vitest_1.expect)(fs.existsSync(written.path)).toBe(true);
        const chain = runtime_1.defaultReceiptWriter.verifyChain(dir);
        (0, vitest_1.expect)(chain.valid).toBe(true);
        (0, vitest_1.expect)(chain.receipts).toContain(written.path);
    });
});
//# sourceMappingURL=admission.spec.js.map