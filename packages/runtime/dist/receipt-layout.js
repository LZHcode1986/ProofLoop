"use strict";
/**
 * @proofloop/runtime — Canonical receipt category directory layout (PO-S02-C-05)
 *
 * The runtime-owned Artifact Path Policy: all persisted receipts live under
 * `<projectRoot>/.proofloop/receipts/` in one of eight canonical content
 * category directories, plus a `.tmp/` scratch directory that is NEVER read
 * as a receipt source:
 *
 *   plan/<stage>/            SLICE_PLAN, STAGE_PLAN, SPV_PASS
 *   tasks/<stage>/<slice>/   TASK_COMPLETE
 *   cv/<stage>/<slice>/      CV_PASS, CV_REPAIR
 *   committer/<stage>/<slice>/  SLICE_COMMIT
 *   integration/<stage>/<slice>/ INTEGRATION_PASS
 *   stage-gate/<stage>/      GATE_PASS, GATE_FAIL, GATE_INTERRUPTED
 *   review/<stage>/          STAGE_REVIEW_PASS
 *   project/                 PROJECT_REVIEW_PASS
 *   .tmp/                    scratch — never a receipt source
 *
 * Reconcile (S02-C-T03) reads ONLY this layout; the kernel ReceiptWriter
 * (S01) writes into it; kernel `verifyReceiptChain` runs per category
 * directory (each directory holds its own independent chain, PO-S02-C-03).
 *
 * Policy note: `SPV_PASS` (the stage-plan semantic proof verification pass)
 * is classified under `plan/<stage>/` — it is the plan-lifecycle receipt
 * (STAGE_PLAN → SPV_PASS), matching deriveStageState's stage-boundary trio
 * STAGE_PLAN / SPV_PASS / STAGE_REVIEW_PASS.
 *
 * Determinism (HP-003): all path resolution is pure `path.join` over the
 * canonical segment names — no I/O, no timestamps, no locale-dependent
 * ordering.
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
exports.RECEIPT_TYPES_BY_CATEGORY = exports.RECEIPT_TYPE_CATEGORY = exports.RECEIPT_CONTENT_CATEGORIES = exports.RECEIPT_CATEGORIES = void 0;
exports.receiptsRoot = receiptsRoot;
exports.planReceiptDir = planReceiptDir;
exports.tasksReceiptDir = tasksReceiptDir;
exports.cvReceiptDir = cvReceiptDir;
exports.committerReceiptDir = committerReceiptDir;
exports.integrationReceiptDir = integrationReceiptDir;
exports.stageGateReceiptDir = stageGateReceiptDir;
exports.reviewReceiptDir = reviewReceiptDir;
exports.projectReceiptDir = projectReceiptDir;
exports.tmpReceiptDir = tmpReceiptDir;
exports.receiptCategoryDir = receiptCategoryDir;
exports.receiptLayout = receiptLayout;
const path = __importStar(require("node:path"));
/** Closed set of all 9 category directory names. */
exports.RECEIPT_CATEGORIES = [
    'plan',
    'tasks',
    'cv',
    'committer',
    'integration',
    'stage-gate',
    'review',
    'project',
    'tmp',
];
/** Closed set of the 8 content categories (never `.tmp`). */
exports.RECEIPT_CONTENT_CATEGORIES = [
    'plan',
    'tasks',
    'cv',
    'committer',
    'integration',
    'stage-gate',
    'review',
    'project',
];
// ============================================================
// Path resolution
// ============================================================
/** Canonical receipts root: `<projectRoot>/.proofloop/receipts`. */
function receiptsRoot(projectRoot) {
    return path.join(projectRoot, '.proofloop', 'receipts');
}
/** `plan/<stage>/` — SLICE_PLAN, STAGE_PLAN, SPV_PASS. */
function planReceiptDir(projectRoot, stageId) {
    return path.join(receiptsRoot(projectRoot), 'plan', stageId);
}
/** `tasks/<stage>/<slice>/` — TASK_COMPLETE. */
function tasksReceiptDir(projectRoot, stageId, sliceId) {
    return path.join(receiptsRoot(projectRoot), 'tasks', stageId, sliceId);
}
/** `cv/<stage>/<slice>/` — CV_PASS, CV_REPAIR. */
function cvReceiptDir(projectRoot, stageId, sliceId) {
    return path.join(receiptsRoot(projectRoot), 'cv', stageId, sliceId);
}
/** `committer/<stage>/<slice>/` — SLICE_COMMIT. */
function committerReceiptDir(projectRoot, stageId, sliceId) {
    return path.join(receiptsRoot(projectRoot), 'committer', stageId, sliceId);
}
/** `integration/<stage>/<slice>/` — INTEGRATION_PASS. */
function integrationReceiptDir(projectRoot, stageId, sliceId) {
    return path.join(receiptsRoot(projectRoot), 'integration', stageId, sliceId);
}
/** `stage-gate/<stage>/` — GATE_PASS, GATE_FAIL, GATE_INTERRUPTED. */
function stageGateReceiptDir(projectRoot, stageId) {
    return path.join(receiptsRoot(projectRoot), 'stage-gate', stageId);
}
/** `review/<stage>/` — STAGE_REVIEW_PASS. */
function reviewReceiptDir(projectRoot, stageId) {
    return path.join(receiptsRoot(projectRoot), 'review', stageId);
}
/** `project/` — PROJECT_REVIEW_PASS. */
function projectReceiptDir(projectRoot) {
    return path.join(receiptsRoot(projectRoot), 'project');
}
/** `.tmp/` — scratch, never read as receipts. */
function tmpReceiptDir(projectRoot) {
    return path.join(receiptsRoot(projectRoot), 'tmp');
}
/**
 * Fail-closed guard for missing required path parameters.
 *
 * Stage-level categories (`plan`, `stage-gate`, `review`) require `stageId`;
 * slice-level categories (`tasks`, `cv`, `committer`, `integration`) require
 * both `stageId` and `sliceId`. Missing identifiers throw a TypeError instead
 * of silently producing an ambiguous path (HP-003: never guess).
 */
function requireId(value, label) {
    if (value === undefined || value.length === 0) {
        throw new TypeError(`receiptCategoryDir: ${label} is required for this category`);
    }
    return value;
}
/**
 * Resolve the directory for a category.
 *
 * Stage-level categories (`plan`, `stage-gate`, `review`) require `stageId`;
 * slice-level categories (`tasks`, `cv`, `committer`, `integration`) require
 * both `stageId` and `sliceId`; `project` and `tmp` require neither.
 *
 * @throws {TypeError} when a required stage/slice id is missing.
 */
function receiptCategoryDir(projectRoot, category, stageId, sliceId) {
    switch (category) {
        case 'plan':
            return planReceiptDir(projectRoot, requireId(stageId, 'stageId'));
        case 'tasks':
            return tasksReceiptDir(projectRoot, requireId(stageId, 'stageId'), requireId(sliceId, 'sliceId'));
        case 'cv':
            return cvReceiptDir(projectRoot, requireId(stageId, 'stageId'), requireId(sliceId, 'sliceId'));
        case 'committer':
            return committerReceiptDir(projectRoot, requireId(stageId, 'stageId'), requireId(sliceId, 'sliceId'));
        case 'integration':
            return integrationReceiptDir(projectRoot, requireId(stageId, 'stageId'), requireId(sliceId, 'sliceId'));
        case 'stage-gate':
            return stageGateReceiptDir(projectRoot, requireId(stageId, 'stageId'));
        case 'review':
            return reviewReceiptDir(projectRoot, requireId(stageId, 'stageId'));
        case 'project':
            return projectReceiptDir(projectRoot);
        case 'tmp':
            return tmpReceiptDir(projectRoot);
    }
}
/** Deterministic layout map for one stage/slice context (PO-S02-C-05). */
function receiptLayout(projectRoot, stageId, sliceId) {
    return {
        root: receiptsRoot(projectRoot),
        plan: planReceiptDir(projectRoot, stageId),
        tasks: tasksReceiptDir(projectRoot, stageId, sliceId),
        cv: cvReceiptDir(projectRoot, stageId, sliceId),
        committer: committerReceiptDir(projectRoot, stageId, sliceId),
        integration: integrationReceiptDir(projectRoot, stageId, sliceId),
        stageGate: stageGateReceiptDir(projectRoot, stageId),
        review: reviewReceiptDir(projectRoot, stageId),
        project: projectReceiptDir(projectRoot),
        tmp: tmpReceiptDir(projectRoot),
    };
}
// ============================================================
// Receipt type → category classification (PO-S02-C-05)
// ============================================================
/**
 * Canonical mapping from each of the 13 receipt types to the content category
 * directory that may hold it. This is the closed-set classification used to
 * detect misplaced receipts (type/category mismatch → RUNTIME.SCHEMA_MISMATCH).
 *
 * The mapping is total: every one of the 13 receipt types maps to exactly one
 * content category, and no type maps to the `.tmp` scratch directory.
 */
exports.RECEIPT_TYPE_CATEGORY = {
    SLICE_PLAN: 'plan',
    STAGE_PLAN: 'plan',
    SPV_PASS: 'plan',
    TASK_COMPLETE: 'tasks',
    CV_PASS: 'cv',
    CV_REPAIR: 'cv',
    SLICE_COMMIT: 'committer',
    INTEGRATION_PASS: 'integration',
    GATE_PASS: 'stage-gate',
    GATE_FAIL: 'stage-gate',
    GATE_INTERRUPTED: 'stage-gate',
    STAGE_REVIEW_PASS: 'review',
    PROJECT_REVIEW_PASS: 'project',
};
/**
 * Inverse map: content category → allowed receipt types.
 *
 * Derived deterministically from `RECEIPT_TYPE_CATEGORY` (single source of
 * truth); each category's list is sorted so the derived structure is stable.
 */
function buildTypesByCategory() {
    const buckets = {
        plan: [],
        tasks: [],
        cv: [],
        committer: [],
        integration: [],
        'stage-gate': [],
        review: [],
        project: [],
    };
    for (const type of Object.keys(exports.RECEIPT_TYPE_CATEGORY)) {
        buckets[exports.RECEIPT_TYPE_CATEGORY[type]].push(type);
    }
    for (const category of Object.keys(buckets)) {
        buckets[category].sort();
    }
    return buckets;
}
/** Inverse map: content category → ordered list of allowed receipt types. */
exports.RECEIPT_TYPES_BY_CATEGORY = buildTypesByCategory();
//# sourceMappingURL=receipt-layout.js.map