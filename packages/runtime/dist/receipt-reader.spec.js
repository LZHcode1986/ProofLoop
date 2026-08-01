"use strict";
/**
 * readReceiptCategory — PO-S02-C-05 (misplacement), PO-S02-C-03 (chain),
 * PO-S02-C-01 (reader determinism)
 *
 * Verifies the runtime receipt reader seam against REAL filesystem fixtures
 * (temp directory + canonical `.proofloop` layout) — no mocks, no cached
 * state files. Receipt files are produced by the kernel ReceiptWriter
 * (`writeReceipt`), the canonical writer, so every fixture receipt carries a
 * correct content digest and chain linkage.
 *
 * Behaviors under test:
 *   - type/category mismatch (e.g. CV_PASS in the integration dir) →
 *     RUNTIME.SCHEMA_MISMATCH misplacement condition; the misplaced receipt is
 *     never used as a fact.
 *   - tampered chained receipt → chain invalid with RUNTIME.RECEIPT_CHAIN_BROKEN
 *     condition; the tampered file is excluded from facts (fact blocking).
 *   - `.tmp/`, non-json files and directories are never read as receipts.
 *   - deterministic (timestamp, digest) ordering; latest = newest; identical
 *     input produces deep-equal output on repeated reads.
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
const runtime_1 = require("@proofloop/runtime");
const cleanups = [];
(0, vitest_1.afterEach)(() => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        fn?.();
    }
});
function makeFixture(stageId = 'S02', sliceId = 'S02-C') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-reader-'));
    const fx = {
        root,
        stageId,
        sliceId,
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
/**
 * Write a schema-valid receipt into a category directory via the kernel
 * ReceiptWriter (canonical writer — computes the content digest and enforces
 * chain preconditions). Returns the write result { path, digest }.
 */
function writeReceiptFile(dir, overrides = {}) {
    fs.mkdirSync(dir, { recursive: true });
    return (0, kernel_1.writeReceipt)({
        version: 1,
        type: 'TASK_COMPLETE',
        stage_id: 'S02',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: {},
        ...overrides,
    }, { receiptDir: dir, tempDir: dir });
}
function readCategory(fx, category) {
    return (0, runtime_1.readReceiptCategory)({
        projectRoot: fx.root,
        category,
        stageId: fx.stageId,
        sliceId: fx.sliceId,
    });
}
// ============================================================
// Misplacement — type/category mismatch (PO-S02-C-05)
// ============================================================
(0, vitest_1.describe)('readReceiptCategory — misplaced receipt (PO-S02-C-05)', () => {
    (0, vitest_1.it)('detects CV_PASS inside the integration directory as RUNTIME.SCHEMA_MISMATCH and never uses it as a fact', () => {
        const fx = makeFixture();
        const cvDir = (0, runtime_1.cvReceiptDir)(fx.root, fx.stageId, fx.sliceId);
        const integrationDir = (0, runtime_1.integrationReceiptDir)(fx.root, fx.stageId, fx.sliceId);
        // A valid CV_PASS in its own directory.
        writeReceiptFile(cvDir, { type: 'CV_PASS', slice_id: fx.sliceId, timestamp: '2025-01-01T00:00:00.000Z' });
        // A schema-valid CV_PASS misplaced into the integration directory.
        writeReceiptFile(integrationDir, { type: 'CV_PASS', slice_id: fx.sliceId, timestamp: '2025-01-01T00:00:00.000Z' });
        const integration = readCategory(fx, 'integration');
        (0, vitest_1.expect)(integration.misplaced).toHaveLength(1);
        (0, vitest_1.expect)(integration.misplaced[0].receiptType).toBe('CV_PASS');
        (0, vitest_1.expect)(integration.misplaced[0].expectedCategory).toBe('cv');
        (0, vitest_1.expect)(integration.misplaced[0].foundInCategory).toBe('integration');
        (0, vitest_1.expect)(integration.misplaced[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        // The misplaced receipt must NOT be read as an integration fact.
        (0, vitest_1.expect)(integration.receipts).toHaveLength(0);
        (0, vitest_1.expect)(integration.latest).toBeNull();
        // The cv directory still reads its own receipt correctly.
        const cv = readCategory(fx, 'cv');
        (0, vitest_1.expect)(cv.misplaced).toHaveLength(0);
        (0, vitest_1.expect)(cv.invalidFiles).toHaveLength(0);
        (0, vitest_1.expect)(cv.receipts).toHaveLength(1);
        (0, vitest_1.expect)(cv.latest?.receipt.type).toBe('CV_PASS');
    });
    (0, vitest_1.it)('does not flag a correctly placed receipt as misplaced', () => {
        const fx = makeFixture();
        const stageGateDir = (0, runtime_1.stageGateReceiptDir)(fx.root, fx.stageId);
        writeReceiptFile(stageGateDir, { type: 'GATE_PASS', stage_id: fx.stageId });
        const gate = readCategory(fx, 'stage-gate');
        (0, vitest_1.expect)(gate.misplaced).toHaveLength(0);
        (0, vitest_1.expect)(gate.receipts).toHaveLength(1);
        (0, vitest_1.expect)(gate.latest?.receipt.type).toBe('GATE_PASS');
    });
});
// ============================================================
// Chain integrity (PO-S02-C-03)
// ============================================================
(0, vitest_1.describe)('readReceiptCategory — chain verification (PO-S02-C-03)', () => {
    (0, vitest_1.it)('reports a valid chain for intact chained receipts', () => {
        const fx = makeFixture();
        const dir = (0, runtime_1.tasksReceiptDir)(fx.root, fx.stageId, fx.sliceId);
        const r1 = writeReceiptFile(dir, { type: 'TASK_COMPLETE', slice_id: fx.sliceId, timestamp: '2025-01-01T00:00:00.000Z' });
        writeReceiptFile(dir, {
            type: 'TASK_COMPLETE',
            slice_id: fx.sliceId,
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: r1.digest,
        });
        const result = readCategory(fx, 'tasks');
        (0, vitest_1.expect)(result.chainValid).toBe(true);
        (0, vitest_1.expect)(result.chainCondition).toBeNull();
        (0, vitest_1.expect)(result.receipts).toHaveLength(2);
    });
    (0, vitest_1.it)('reports RUNTIME.RECEIPT_CHAIN_BROKEN when a chained receipt is tampered and blocks its facts', () => {
        const fx = makeFixture();
        const dir = (0, runtime_1.tasksReceiptDir)(fx.root, fx.stageId, fx.sliceId);
        const r1 = writeReceiptFile(dir, { type: 'TASK_COMPLETE', slice_id: fx.sliceId, timestamp: '2025-01-01T00:00:00.000Z' });
        const r2 = writeReceiptFile(dir, {
            type: 'TASK_COMPLETE',
            slice_id: fx.sliceId,
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: r1.digest,
        });
        // Tamper with r2's content WITHOUT recomputing its digest.
        const raw = JSON.parse(fs.readFileSync(r2.path, 'utf-8'));
        raw.payload = { tampered: true };
        fs.writeFileSync(r2.path, JSON.stringify(raw));
        const result = readCategory(fx, 'tasks');
        (0, vitest_1.expect)(result.chainValid).toBe(false);
        (0, vitest_1.expect)(result.chainCondition).not.toBeNull();
        (0, vitest_1.expect)(result.chainCondition?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
        // The tampered file is excluded from facts (fact blocking).
        (0, vitest_1.expect)(result.invalidFiles.some((p) => p.filePath === r2.path && p.code === 'RUNTIME.RECEIPT_CHAIN_BROKEN')).toBe(true);
        (0, vitest_1.expect)(result.receipts.every((r) => r.filePath !== r2.path)).toBe(true);
        (0, vitest_1.expect)(result.receipts.map((r) => r.filePath)).toEqual([r1.path]);
        (0, vitest_1.expect)(result.latest?.filePath).toBe(r1.path);
    });
});
// ============================================================
// Exclusion — .tmp / non-json / directories (PO-S02-C-05)
// ============================================================
(0, vitest_1.describe)('readReceiptCategory — never treats .tmp/non-json/directories as receipts (PO-S02-C-05)', () => {
    (0, vitest_1.it)('reads only regular .json receipt files in the category directory', () => {
        const fx = makeFixture();
        const cvDir = (0, runtime_1.cvReceiptDir)(fx.root, fx.stageId, fx.sliceId);
        const valid = writeReceiptFile(cvDir, { type: 'CV_PASS', slice_id: fx.sliceId, timestamp: '2025-01-01T00:00:00.000Z' });
        // Non-json files and kernel temp-style files inside the category dir.
        fs.writeFileSync(path.join(cvDir, 'readme.txt'), 'not a receipt');
        fs.writeFileSync(path.join(cvDir, 'notes.json.tmp'), '{"version":1}');
        // A valid receipt inside the .tmp scratch dir — must never be scanned.
        writeReceiptFile((0, runtime_1.tmpReceiptDir)(fx.root), {
            type: 'CV_PASS',
            slice_id: fx.sliceId,
            timestamp: '2025-01-01T00:00:00.000Z',
        });
        const result = readCategory(fx, 'cv');
        (0, vitest_1.expect)(result.receipts).toHaveLength(1);
        (0, vitest_1.expect)(result.receipts[0].filePath).toBe(valid.path);
        (0, vitest_1.expect)(result.latest?.receipt.type).toBe('CV_PASS');
        (0, vitest_1.expect)(result.invalidFiles).toHaveLength(0);
        (0, vitest_1.expect)(result.misplaced).toHaveLength(0);
        (0, vitest_1.expect)(result.chainValid).toBe(true);
    });
    (0, vitest_1.it)('returns an empty, valid result for a missing category directory', () => {
        const fx = makeFixture();
        const result = readCategory(fx, 'committer');
        (0, vitest_1.expect)(result.receipts).toHaveLength(0);
        (0, vitest_1.expect)(result.latest).toBeNull();
        (0, vitest_1.expect)(result.invalidFiles).toHaveLength(0);
        (0, vitest_1.expect)(result.misplaced).toHaveLength(0);
        (0, vitest_1.expect)(result.chainValid).toBe(true);
    });
});
// ============================================================
// Deterministic ordering (PO-S02-C-01 reader part)
// ============================================================
(0, vitest_1.describe)('readReceiptCategory — deterministic (timestamp, digest) ordering (PO-S02-C-01)', () => {
    (0, vitest_1.it)('orders receipts by timestamp then digest and picks the newest; repeated reads are deep-equal', () => {
        const fx = makeFixture();
        const dir = (0, runtime_1.cvReceiptDir)(fx.root, fx.stageId, fx.sliceId);
        const r1 = writeReceiptFile(dir, {
            type: 'CV_PASS',
            slice_id: fx.sliceId,
            timestamp: '2025-01-01T00:00:00.000Z',
            payload: { seq: 1 },
        });
        const r2a = writeReceiptFile(dir, {
            type: 'CV_PASS',
            slice_id: fx.sliceId,
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: { seq: 2 },
        });
        // Same timestamp as r2a — the tie must be broken by digest (lexicographic).
        const r2b = writeReceiptFile(dir, {
            type: 'CV_PASS',
            slice_id: fx.sliceId,
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: { seq: 3 },
        });
        const r3 = writeReceiptFile(dir, {
            type: 'CV_PASS',
            slice_id: fx.sliceId,
            timestamp: '2025-01-03T00:00:00.000Z',
            payload: { seq: 4 },
        });
        // Expected order: chronological by timestamp; same timestamp → digest
        // lexicographic (digests come from the kernel writer as the independent
        // content-addressing oracle).
        const sameTimestampSorted = [r2a, r2b].slice().sort((a, b) => a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0);
        const expectedDigests = [
            r1.digest,
            ...sameTimestampSorted.map((w) => w.digest),
            r3.digest,
        ];
        const result = readCategory(fx, 'cv');
        (0, vitest_1.expect)(result.receipts.map((r) => r.receipt.digest)).toEqual(expectedDigests);
        (0, vitest_1.expect)(result.latest?.receipt.digest).toBe(r3.digest);
        // Determinism (HP-003): same input, same output.
        const again = readCategory(fx, 'cv');
        (0, vitest_1.expect)(again).toEqual(result);
    });
});
// ============================================================
// All categories (PO-S02-C-03 — per category dir chain verification)
// ============================================================
(0, vitest_1.describe)('readAllReceiptCategories — every canonical category directory (PO-S02-C-03)', () => {
    (0, vitest_1.it)('reads one valid receipt per content category with intact chains', () => {
        const fx = makeFixture();
        const stage = fx.stageId;
        const slice = fx.sliceId;
        writeReceiptFile((0, runtime_1.planReceiptDir)(fx.root, stage), { type: 'STAGE_PLAN', stage_id: stage });
        writeReceiptFile((0, runtime_1.tasksReceiptDir)(fx.root, stage, slice), { type: 'TASK_COMPLETE', slice_id: slice });
        writeReceiptFile((0, runtime_1.cvReceiptDir)(fx.root, stage, slice), { type: 'CV_PASS', slice_id: slice });
        writeReceiptFile((0, runtime_1.committerReceiptDir)(fx.root, stage, slice), { type: 'SLICE_COMMIT', slice_id: slice });
        writeReceiptFile((0, runtime_1.integrationReceiptDir)(fx.root, stage, slice), { type: 'INTEGRATION_PASS', slice_id: slice });
        writeReceiptFile((0, runtime_1.stageGateReceiptDir)(fx.root, stage), { type: 'GATE_PASS', stage_id: stage });
        writeReceiptFile((0, runtime_1.reviewReceiptDir)(fx.root, stage), { type: 'STAGE_REVIEW_PASS', stage_id: stage });
        writeReceiptFile((0, runtime_1.projectReceiptDir)(fx.root), { type: 'PROJECT_REVIEW_PASS', stage_id: stage });
        const all = (0, runtime_1.readAllReceiptCategories)({ projectRoot: fx.root, stageId: stage, sliceId: slice });
        (0, vitest_1.expect)(all.plan.latest?.receipt.type).toBe('STAGE_PLAN');
        (0, vitest_1.expect)(all.tasks.latest?.receipt.type).toBe('TASK_COMPLETE');
        (0, vitest_1.expect)(all.cv.latest?.receipt.type).toBe('CV_PASS');
        (0, vitest_1.expect)(all.committer.latest?.receipt.type).toBe('SLICE_COMMIT');
        (0, vitest_1.expect)(all.integration.latest?.receipt.type).toBe('INTEGRATION_PASS');
        (0, vitest_1.expect)(all['stage-gate'].latest?.receipt.type).toBe('GATE_PASS');
        (0, vitest_1.expect)(all.review.latest?.receipt.type).toBe('STAGE_REVIEW_PASS');
        (0, vitest_1.expect)(all.project.latest?.receipt.type).toBe('PROJECT_REVIEW_PASS');
        for (const category of runtime_1.RECEIPT_CONTENT_CATEGORIES) {
            (0, vitest_1.expect)(all[category].chainValid).toBe(true);
            (0, vitest_1.expect)(all[category].chainCondition).toBeNull();
            (0, vitest_1.expect)(all[category].misplaced).toHaveLength(0);
            (0, vitest_1.expect)(all[category].invalidFiles).toHaveLength(0);
            (0, vitest_1.expect)(all[category].receipts).toHaveLength(1);
        }
    });
});
//# sourceMappingURL=receipt-reader.spec.js.map