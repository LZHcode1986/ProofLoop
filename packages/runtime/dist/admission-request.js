"use strict";
/**
 * @proofloop/runtime — AdmissionRequest types & fail-closed schema validation
 *
 * PO-S02-E-01 (skeleton part, S02-E-T01) + PO-S03-H-02 (S03-H-T02 extension):
 * the discriminated union `AdmissionRequest` over the AWI-006 admit
 * operations (WorkerResult / CVResult / SliceCommit / Integration /
 * StageReview / ProjectReview / StagePlan) PLUS the S03 SPV/GATE admit kinds
 * (SpvResult / GateResult). All fields use kernel canonical types and closed
 * literal sets — open strings are forbidden (§5 Canonical Type Registry). The
 * `type` discriminant is a closed 9-value set; the S03 SPV/GATE members use
 * the same extension point documented in the Slice's Receipt-creation
 * ownership table.
 *
 * SLICE_PLAN creation-path decision record (PO-S03-H-02): the kernel
 * `SLICE_PLAN` receipt literal is retained, but S03 does NOT create
 * SLICE_PLAN receipts (no consumer today). A worker-result admit can never
 * create a new slice in S03 — undeclared slices are refused
 * (DOMAIN.STAGE_NOT_FOUND) and no receipt of any type (in particular no
 * SLICE_PLAN) is ever written for them. If a future flow (repartition /
 * first-entry) creates a new slice, the S04 tool flow plugs a `slice_plan`
 * request member into this same extension point.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.REVIEW_VERDICTS = exports.GATE_INTERRUPTED_REASONS = exports.GATE_VERDICTS = exports.CV_VERDICTS = exports.ADMISSION_REQUEST_TYPES = void 0;
exports.admissionRequestStageId = admissionRequestStageId;
exports.admissionRequestSliceId = admissionRequestSliceId;
exports.assertAdmissionRequest = assertAdmissionRequest;
const kernel_1 = require("@proofloop/kernel");
const relay_contract_1 = require("./relay-contract");
// ============================================================
// Closed literal sets
// ============================================================
/** Request `type` discriminants — closed 10-value set (AWI-006 + PO-S03-H-02 + S05-A). */
exports.ADMISSION_REQUEST_TYPES = [
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
];
/** CV verdicts — closed 2-value set. */
exports.CV_VERDICTS = ['PASS', 'REPAIR'];
/** Gate verdicts — closed 2-value set (PO-S03-H-02). */
exports.GATE_VERDICTS = ['PASS', 'FAIL'];
/**
 * Gate interruption reasons — closed 2-value set (S05-A-T05, HP-004/AWI-015).
 *
 * A gate interruption is NOT a gate verdict: `GATE_INTERRUPTED` is a
 * separate 13th ReceiptType whose payload carries `reason` from this closed
 * set plus `duration_ms`. GATE_VERDICTS intentionally stays {PASS, FAIL} —
 * an interrupted gate is never admitted as a verdict receipt.
 */
exports.GATE_INTERRUPTED_REASONS = ['cancelled', 'timeout'];
/** Review verdicts — closed 2-value set. */
exports.REVIEW_VERDICTS = ['ACCEPTED', 'REPAIR'];
// ============================================================
// Binding helpers
// ============================================================
/** Canonical stage id binding of a request (envelope for worker_result). */
function admissionRequestStageId(request) {
    return request.type === 'worker_result' ? request.envelope.stageId : request.stageId;
}
/**
 * Canonical slice id binding of a request, or null for stage-level kinds
 * (reviews / project review / stage plan).
 */
function admissionRequestSliceId(request) {
    switch (request.type) {
        case 'worker_result':
            return request.envelope.sliceId;
        case 'cv_result':
        case 'slice_commit':
        case 'integration':
            return request.sliceId;
        default:
            return null;
    }
}
/** Per-member known field sets — strict mode rejects any unknown field. */
const WORKER_RESULT_FIELDS = new Set(['type', 'envelope']);
const CV_RESULT_FIELDS = new Set([
    'type', 'stageId', 'sliceId', 'verdict', 'snapshotDigest', 'summary',
]);
const SLICE_COMMIT_FIELDS = new Set([
    'type', 'stageId', 'sliceId', 'commitSha', 'cvReceiptDigest',
]);
const INTEGRATION_FIELDS = new Set(['type', 'stageId', 'sliceId', 'commitSha']);
const REVIEW_FIELDS = new Set(['type', 'stageId', 'verdict', 'summary']);
const STAGE_PLAN_FIELDS = new Set(['type', 'stageId', 'manifestDigest']);
const SPV_RESULT_FIELDS = new Set(['type', 'stageId', 'manifestDigest', 'summary']);
const GATE_RESULT_FIELDS = new Set([
    'type', 'stageId', 'verdict', 'manifestDigest', 'snapshotDigest', 'summary',
]);
const GATE_INTERRUPTED_FIELDS = new Set([
    'type', 'stageId', 'reason', 'durationMs', 'manifestDigest', 'snapshotDigest',
]);
function isRecord(x) {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function checkUnknownFields(obj, known, errors) {
    for (const key of Object.keys(obj)) {
        if (!known.has(key)) {
            errors.push({ path: key, message: `Unknown field "${key}"` });
        }
    }
}
function expectString(value, path, errors) {
    if (typeof value !== 'string' || value.length === 0) {
        errors.push({
            path,
            message: `Expected non-empty string, got ${value === null ? 'null' : typeof value}`,
        });
    }
}
/**
 * Identifier charset check (F-2): stageId / sliceId are used verbatim in
 * receipt category path construction, so they are restricted to the safe
 * charset `^[A-Za-z0-9_-]+$` — path separators and traversal segments
 * (`../../evil`, `..\evil`, spaces, ...) are rejected at the schema layer
 * before any path is built or receipt written.
 */
const IDENTIFIER_CHARSET = /^[A-Za-z0-9_-]+$/;
function expectIdentifier(value, path, errors) {
    if (typeof value !== 'string' || value.length === 0) {
        errors.push({
            path,
            message: `Expected non-empty string, got ${value === null ? 'null' : typeof value}`,
        });
        return;
    }
    if (!IDENTIFIER_CHARSET.test(value)) {
        errors.push({
            path,
            message: `Expected identifier matching ^[A-Za-z0-9_-]+$, got ${JSON.stringify(value)}`,
        });
    }
}
function expectStringLiteral(value, literals, path, errors) {
    if (typeof value !== 'string') {
        errors.push({ path, message: `Expected string, got ${value === null ? 'null' : typeof value}` });
        return;
    }
    if (!literals.includes(value)) {
        errors.push({
            path,
            message: `Expected one of: ${literals.map((l) => JSON.stringify(l)).join(', ')}`,
        });
    }
}
function throwIfErrors(errors) {
    if (errors.length > 0) {
        throw new kernel_1.SchemaValidationError(`Schema validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, errors);
    }
}
/**
 * Reject any value that is not a canonical `AdmissionRequest` member.
 *
 * Unknown type discriminant, unknown fields, missing fields and out-of-set
 * literals throw `SchemaValidationError` (canonical code
 * RUNTIME.SCHEMA_MISMATCH) with per-field errors — never partial acceptance,
 * never silent defaulting. The `worker_result` envelope is validated through
 * the canonical S02-B `validateWorkerResultEnvelope` seam.
 */
function assertAdmissionRequest(value) {
    if (!isRecord(value)) {
        throw new kernel_1.SchemaValidationError(`Schema validation failed: : Expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`, [{ path: '', message: 'AdmissionRequest must be a non-null, non-array object' }]);
    }
    const errors = [];
    const type = value.type;
    if (typeof type !== 'string' ||
        !exports.ADMISSION_REQUEST_TYPES.includes(type)) {
        errors.push({
            path: 'type',
            message: `type must be one of: ${exports.ADMISSION_REQUEST_TYPES.map((t) => JSON.stringify(t)).join(', ')}`,
        });
        throwIfErrors(errors);
    }
    switch (type) {
        case 'worker_result': {
            checkUnknownFields(value, WORKER_RESULT_FIELDS, errors);
            // Canonical S02-B seam: the envelope validator produces its own
            // field-located errors; re-prefix them under `envelope.` so the
            // request-level error locates the offending envelope field.
            try {
                (0, relay_contract_1.validateWorkerResultEnvelope)(value.envelope);
            }
            catch (err) {
                if (err instanceof kernel_1.SchemaValidationError) {
                    for (const fe of err.fieldErrors) {
                        errors.push({
                            path: fe.path === '' ? 'envelope' : `envelope.${fe.path}`,
                            message: fe.message,
                        });
                    }
                }
                else {
                    throw err;
                }
            }
            break;
        }
        case 'cv_result': {
            checkUnknownFields(value, CV_RESULT_FIELDS, errors);
            expectIdentifier(value.stageId, 'stageId', errors);
            expectIdentifier(value.sliceId, 'sliceId', errors);
            expectStringLiteral(value.verdict, exports.CV_VERDICTS, 'verdict', errors);
            expectString(value.snapshotDigest, 'snapshotDigest', errors);
            expectString(value.summary, 'summary', errors);
            break;
        }
        case 'slice_commit': {
            checkUnknownFields(value, SLICE_COMMIT_FIELDS, errors);
            expectIdentifier(value.stageId, 'stageId', errors);
            expectIdentifier(value.sliceId, 'sliceId', errors);
            expectString(value.commitSha, 'commitSha', errors);
            expectString(value.cvReceiptDigest, 'cvReceiptDigest', errors);
            break;
        }
        case 'integration': {
            checkUnknownFields(value, INTEGRATION_FIELDS, errors);
            expectIdentifier(value.stageId, 'stageId', errors);
            expectIdentifier(value.sliceId, 'sliceId', errors);
            expectString(value.commitSha, 'commitSha', errors);
            break;
        }
        case 'stage_review': {
            checkUnknownFields(value, REVIEW_FIELDS, errors);
            expectIdentifier(value.stageId, 'stageId', errors);
            expectStringLiteral(value.verdict, exports.REVIEW_VERDICTS, 'verdict', errors);
            expectString(value.summary, 'summary', errors);
            break;
        }
        case 'project_review': {
            checkUnknownFields(value, REVIEW_FIELDS, errors);
            expectIdentifier(value.stageId, 'stageId', errors);
            expectStringLiteral(value.verdict, exports.REVIEW_VERDICTS, 'verdict', errors);
            expectString(value.summary, 'summary', errors);
            break;
        }
        case 'stage_plan': {
            checkUnknownFields(value, STAGE_PLAN_FIELDS, errors);
            expectIdentifier(value.stageId, 'stageId', errors);
            expectString(value.manifestDigest, 'manifestDigest', errors);
            break;
        }
        case 'spv_result': {
            checkUnknownFields(value, SPV_RESULT_FIELDS, errors);
            expectIdentifier(value.stageId, 'stageId', errors);
            expectString(value.manifestDigest, 'manifestDigest', errors);
            expectString(value.summary, 'summary', errors);
            break;
        }
        case 'gate_result': {
            checkUnknownFields(value, GATE_RESULT_FIELDS, errors);
            expectIdentifier(value.stageId, 'stageId', errors);
            expectStringLiteral(value.verdict, exports.GATE_VERDICTS, 'verdict', errors);
            expectString(value.manifestDigest, 'manifestDigest', errors);
            expectString(value.snapshotDigest, 'snapshotDigest', errors);
            expectString(value.summary, 'summary', errors);
            break;
        }
        case 'gate_interrupted': {
            checkUnknownFields(value, GATE_INTERRUPTED_FIELDS, errors);
            expectIdentifier(value.stageId, 'stageId', errors);
            expectStringLiteral(value.reason, exports.GATE_INTERRUPTED_REASONS, 'reason', errors);
            if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
                errors.push({
                    path: 'durationMs',
                    message: `Expected non-negative finite number, got ${typeof value.durationMs}`,
                });
            }
            expectString(value.manifestDigest, 'manifestDigest', errors);
            expectString(value.snapshotDigest, 'snapshotDigest', errors);
            break;
        }
        default: {
            // Unreachable for validated type values; runtime guard only — a JS
            // caller bypassing the discriminant check never gets a silent pass.
            errors.push({
                path: 'type',
                message: `Unknown AdmissionRequest type ${JSON.stringify(type)}`,
            });
        }
    }
    throwIfErrors(errors);
}
//# sourceMappingURL=admission-request.js.map