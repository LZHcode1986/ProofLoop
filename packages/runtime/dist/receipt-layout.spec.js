"use strict";
/**
 * receiptLayout — PO-S02-C-05 (contract part)
 *
 * Verifies the canonical receipt category directory layout policy of
 * @proofloop/runtime (runtime-owned Artifact Path Policy):
 *
 *   <projectRoot>/.proofloop/receipts/
 *     plan/<stage>/            SLICE_PLAN, STAGE_PLAN, SPV_PASS
 *     tasks/<stage>/<slice>/   TASK_COMPLETE
 *     cv/<stage>/<slice>/      CV_PASS, CV_REPAIR
 *     committer/<stage>/<slice>/  SLICE_COMMIT
 *     integration/<stage>/<slice>/ INTEGRATION_PASS
 *     stage-gate/<stage>/      GATE_PASS, GATE_FAIL
 *     review/<stage>/          STAGE_REVIEW_PASS
 *     project/                 PROJECT_REVIEW_PASS
 *     .tmp/                    scratch — never a receipt source
 *
 * Expected path segments are written as known-good literals (independent of
 * the implementation). The type→category classification is the closed 12-type
 * receipt set mapped onto the 8 content categories — every type belongs to
 * exactly one category, no category is empty.
 *
 * Policy note (asserted below): SPV_PASS is classified under `plan/<stage>/` —
 * it is the stage-plan semantic proof verification pass (plan lifecycle:
 * STAGE_PLAN → SPV_PASS), matching deriveStageState's stage-boundary trio.
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
const path = __importStar(require("node:path"));
const runtime_1 = require("@proofloop/runtime");
const ROOT = '/fixture/project';
const STAGE = 'S02';
const SLICE = 'S02-C';
/** The closed 13-type receipt set (§4 / §5 canonical type registry, incl. the S05 additive GATE_INTERRUPTED). */
const ALL_RECEIPT_TYPES = [
    'SLICE_PLAN',
    'STAGE_PLAN',
    'SPV_PASS',
    'TASK_COMPLETE',
    'CV_PASS',
    'CV_REPAIR',
    'SLICE_COMMIT',
    'INTEGRATION_PASS',
    'GATE_PASS',
    'GATE_FAIL',
    'GATE_INTERRUPTED',
    'STAGE_REVIEW_PASS',
    'PROJECT_REVIEW_PASS',
];
(0, vitest_1.describe)('receiptLayout — canonical category directory layout (PO-S02-C-05)', () => {
    (0, vitest_1.it)('maps all 9 canonical category directories under .proofloop/receipts', () => {
        const layout = (0, runtime_1.receiptLayout)(ROOT, STAGE, SLICE);
        const base = path.join(ROOT, '.proofloop', 'receipts');
        (0, vitest_1.expect)(layout.root).toBe(base);
        (0, vitest_1.expect)(layout.plan).toBe(path.join(base, 'plan', STAGE));
        (0, vitest_1.expect)(layout.tasks).toBe(path.join(base, 'tasks', STAGE, SLICE));
        (0, vitest_1.expect)(layout.cv).toBe(path.join(base, 'cv', STAGE, SLICE));
        (0, vitest_1.expect)(layout.committer).toBe(path.join(base, 'committer', STAGE, SLICE));
        (0, vitest_1.expect)(layout.integration).toBe(path.join(base, 'integration', STAGE, SLICE));
        (0, vitest_1.expect)(layout.stageGate).toBe(path.join(base, 'stage-gate', STAGE));
        (0, vitest_1.expect)(layout.review).toBe(path.join(base, 'review', STAGE));
        (0, vitest_1.expect)(layout.project).toBe(path.join(base, 'project'));
        (0, vitest_1.expect)(layout.tmp).toBe(path.join(base, 'tmp'));
    });
    (0, vitest_1.it)('exposes the closed category set: 8 content categories + tmp', () => {
        (0, vitest_1.expect)([...runtime_1.RECEIPT_CATEGORIES]).toEqual([
            'plan',
            'tasks',
            'cv',
            'committer',
            'integration',
            'stage-gate',
            'review',
            'project',
            'tmp',
        ]);
        (0, vitest_1.expect)([...runtime_1.RECEIPT_CONTENT_CATEGORIES]).toEqual([
            'plan',
            'tasks',
            'cv',
            'committer',
            'integration',
            'stage-gate',
            'review',
            'project',
        ]);
    });
    (0, vitest_1.it)('resolves every category via receiptCategoryDir consistently with the dedicated helpers', () => {
        (0, vitest_1.expect)((0, runtime_1.receiptsRoot)(ROOT)).toBe(path.join(ROOT, '.proofloop', 'receipts'));
        (0, vitest_1.expect)((0, runtime_1.receiptCategoryDir)(ROOT, 'plan', STAGE)).toBe((0, runtime_1.planReceiptDir)(ROOT, STAGE));
        (0, vitest_1.expect)((0, runtime_1.receiptCategoryDir)(ROOT, 'tasks', STAGE, SLICE)).toBe((0, runtime_1.tasksReceiptDir)(ROOT, STAGE, SLICE));
        (0, vitest_1.expect)((0, runtime_1.receiptCategoryDir)(ROOT, 'cv', STAGE, SLICE)).toBe((0, runtime_1.cvReceiptDir)(ROOT, STAGE, SLICE));
        (0, vitest_1.expect)((0, runtime_1.receiptCategoryDir)(ROOT, 'committer', STAGE, SLICE)).toBe((0, runtime_1.committerReceiptDir)(ROOT, STAGE, SLICE));
        (0, vitest_1.expect)((0, runtime_1.receiptCategoryDir)(ROOT, 'integration', STAGE, SLICE)).toBe((0, runtime_1.integrationReceiptDir)(ROOT, STAGE, SLICE));
        (0, vitest_1.expect)((0, runtime_1.receiptCategoryDir)(ROOT, 'stage-gate', STAGE)).toBe((0, runtime_1.stageGateReceiptDir)(ROOT, STAGE));
        (0, vitest_1.expect)((0, runtime_1.receiptCategoryDir)(ROOT, 'review', STAGE)).toBe((0, runtime_1.reviewReceiptDir)(ROOT, STAGE));
        (0, vitest_1.expect)((0, runtime_1.receiptCategoryDir)(ROOT, 'project')).toBe((0, runtime_1.projectReceiptDir)(ROOT));
        (0, vitest_1.expect)((0, runtime_1.receiptCategoryDir)(ROOT, 'tmp')).toBe((0, runtime_1.tmpReceiptDir)(ROOT));
    });
    (0, vitest_1.it)('classifies every one of the 13 receipt types into exactly one content category', () => {
        const seen = new Map();
        for (const type of ALL_RECEIPT_TYPES) {
            const category = runtime_1.RECEIPT_TYPE_CATEGORY[type];
            (0, vitest_1.expect)(runtime_1.RECEIPT_CONTENT_CATEGORIES).toContain(category);
            seen.set(type, category);
        }
        // Expected classification per the canonical layout (known-good literals):
        (0, vitest_1.expect)(seen.get('SLICE_PLAN')).toBe('plan');
        (0, vitest_1.expect)(seen.get('STAGE_PLAN')).toBe('plan');
        (0, vitest_1.expect)(seen.get('SPV_PASS')).toBe('plan');
        (0, vitest_1.expect)(seen.get('TASK_COMPLETE')).toBe('tasks');
        (0, vitest_1.expect)(seen.get('CV_PASS')).toBe('cv');
        (0, vitest_1.expect)(seen.get('CV_REPAIR')).toBe('cv');
        (0, vitest_1.expect)(seen.get('SLICE_COMMIT')).toBe('committer');
        (0, vitest_1.expect)(seen.get('INTEGRATION_PASS')).toBe('integration');
        (0, vitest_1.expect)(seen.get('GATE_PASS')).toBe('stage-gate');
        (0, vitest_1.expect)(seen.get('GATE_FAIL')).toBe('stage-gate');
        (0, vitest_1.expect)(seen.get('GATE_INTERRUPTED')).toBe('stage-gate');
        (0, vitest_1.expect)(seen.get('STAGE_REVIEW_PASS')).toBe('review');
        (0, vitest_1.expect)(seen.get('PROJECT_REVIEW_PASS')).toBe('project');
    });
    (0, vitest_1.it)('derives RECEIPT_TYPES_BY_CATEGORY as the inverse of the type→category map', () => {
        for (const category of runtime_1.RECEIPT_CONTENT_CATEGORIES) {
            const types = runtime_1.RECEIPT_TYPES_BY_CATEGORY[category];
            (0, vitest_1.expect)(types.length).toBeGreaterThan(0);
            for (const type of types) {
                (0, vitest_1.expect)(runtime_1.RECEIPT_TYPE_CATEGORY[type]).toBe(category);
            }
        }
        // Every receipt type appears exactly once across all categories.
        const all = runtime_1.RECEIPT_CONTENT_CATEGORIES.flatMap((c) => [...runtime_1.RECEIPT_TYPES_BY_CATEGORY[c]]);
        (0, vitest_1.expect)(all).toHaveLength(ALL_RECEIPT_TYPES.length);
        (0, vitest_1.expect)(new Set(all).size).toBe(ALL_RECEIPT_TYPES.length);
        (0, vitest_1.expect)([...new Set(all)].sort()).toEqual([...ALL_RECEIPT_TYPES].sort());
    });
    (0, vitest_1.it)('never maps any receipt type to the .tmp scratch category', () => {
        for (const type of ALL_RECEIPT_TYPES) {
            (0, vitest_1.expect)(runtime_1.RECEIPT_TYPE_CATEGORY[type]).not.toBe('tmp');
        }
    });
    (0, vitest_1.it)('GATE_INTERRUPTED (S05 additive 13th type) belongs to stage-gate alongside GATE_PASS/GATE_FAIL', () => {
        (0, vitest_1.expect)(runtime_1.RECEIPT_TYPE_CATEGORY['GATE_INTERRUPTED']).toBe('stage-gate');
        (0, vitest_1.expect)(runtime_1.RECEIPT_TYPES_BY_CATEGORY['stage-gate']).toContain('GATE_INTERRUPTED');
        // the existing 12-type membership is unchanged
        (0, vitest_1.expect)(runtime_1.RECEIPT_TYPES_BY_CATEGORY['stage-gate']).toContain('GATE_PASS');
        (0, vitest_1.expect)(runtime_1.RECEIPT_TYPES_BY_CATEGORY['stage-gate']).toContain('GATE_FAIL');
        // no type maps to two categories and no category holds a foreign type
        const all = runtime_1.RECEIPT_CONTENT_CATEGORIES.flatMap((c) => [...runtime_1.RECEIPT_TYPES_BY_CATEGORY[c]]);
        (0, vitest_1.expect)(new Set(all).size).toBe(13);
    });
});
//# sourceMappingURL=receipt-layout.spec.js.map