"use strict";
/**
 * @proofloop/runtime — WorkerRelayPort contract types & WorkerResultEnvelope validator
 *
 * PO-S02-B-01: `WorkerRelayPort` / `WorkerRelayStepInput` / `WorkerRelayStepResult`
 * public contract (§3b WorkerRelayPort Contract, Blueprint §6).  The port is the
 * ONLY seam through which the runtime executes worker steps — the runtime never
 * imports or references any host (pi-subagents) implementation (ADR-012 / AWI-024 /
 * HP-010).  A fake port implemented purely from these types proves any host can
 * satisfy the seam.
 *
 * PO-S02-B-04: `WorkerResultEnvelope` public type + fail-closed validator (§4 File /
 * Artifact Contracts, Blueprint §13).  The envelope is non-authoritative (Admission
 * consumes and deletes it); a Child-reported `completed` outcome never implies Task
 * completion by itself (Blueprint #13 / #9.6).
 *
 * All closed literal sets are declared `as const` and re-exported — no open
 * strings, no field aliases, no `any`.  Relay diagnostics (runRef etc.) stay
 * opaque: the runtime never parses them and they never enter business Receipts
 * (Blueprint #9.6 / #11 / #22).
 *
 * Types + one validator only — no behavior, no I/O, zero host imports.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKER_RELAY_TERMINALS = exports.WORKER_OUTCOMES = exports.WORKER_RELAY_KINDS = exports.WORKER_EXECUTIONS = exports.WORKER_CONTINUATIONS = exports.WORKER_STEP_MODES = void 0;
exports.validateWorkerResultEnvelope = validateWorkerResultEnvelope;
const kernel_1 = require("@proofloop/kernel");
// ============================================================
// Closed literal sets (§3b / Blueprint §6 / §13)
// ============================================================
/** Worker step modes — closed 5-value set. */
exports.WORKER_STEP_MODES = [
    'implement-task',
    'recover-task',
    'finalize-slice',
    'diagnose',
    'repair',
];
/** Continuation policy — closed 2-value set. */
exports.WORKER_CONTINUATIONS = ['prefer', 'fresh'];
/** Execution status of a relayed worker step — closed 5-value set. */
exports.WORKER_EXECUTIONS = [
    'completed',
    'needs-attention',
    'failed',
    'timed-out',
    'cancelled',
];
/** Relay transport kind — closed 3-value set. */
exports.WORKER_RELAY_KINDS = ['spawned', 'resumed', 'fresh-fallback'];
/** Worker result outcome — closed 4-value set. */
exports.WORKER_OUTCOMES = ['completed', 'blocked', 'needs-decision', 'failed'];
/** Relay process-terminal status — closed 3-value set (§3b / Blueprint §6). */
exports.WORKER_RELAY_TERMINALS = ['observed', 'unknown', 'not-supported'];
const ENVELOPE_KNOWN_FIELDS = new Set([
    'schemaVersion',
    'actionToken',
    'stageId',
    'sliceId',
    'taskId',
    'mode',
    'outcome',
    'evidenceRef',
    'changedFiles',
    'verificationRuns',
    'summary',
]);
const VERIFICATION_RUN_KNOWN_FIELDS = new Set(['commandId', 'exitCode', 'logRef']);
function isRecord(x) {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function checkUnknownFields(obj, known, path, errors) {
    for (const key of Object.keys(obj)) {
        if (!known.has(key)) {
            errors.push({ path: path ? `${path}.${key}` : key, message: `Unknown field "${key}"` });
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
 * Identifier charset check (F-2): the envelope stageId / sliceId are used
 * verbatim in receipt category path construction, so they are restricted to
 * the safe charset `^[A-Za-z0-9_-]+$` — path separators and traversal
 * segments are rejected before any path is built or receipt written.
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
function expectOptionalString(value, path, errors) {
    if (value !== undefined)
        expectString(value, path, errors);
}
function expectNumber(value, path, errors) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push({
            path,
            message: `Expected number, got ${value === null ? 'null' : typeof value}`,
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
function expectStringArray(value, path, errors) {
    if (!Array.isArray(value)) {
        errors.push({ path, message: `Expected array, got ${value === null ? 'null' : typeof value}` });
        return;
    }
    value.forEach((item, i) => {
        if (typeof item !== 'string') {
            errors.push({ path: `${path}[${i}]`, message: `Expected string, got ${typeof item}` });
        }
    });
}
function validateVerificationRuns(value, path, errors) {
    if (!Array.isArray(value)) {
        errors.push({ path, message: `Expected array, got ${value === null ? 'null' : typeof value}` });
        return;
    }
    value.forEach((run, i) => {
        if (!isRecord(run)) {
            errors.push({ path: `${path}[${i}]`, message: 'Expected object' });
            return;
        }
        checkUnknownFields(run, VERIFICATION_RUN_KNOWN_FIELDS, `${path}[${i}]`, errors);
        expectString(run.commandId, `${path}[${i}].commandId`, errors);
        expectNumber(run.exitCode, `${path}[${i}].exitCode`, errors);
        expectString(run.logRef, `${path}[${i}].logRef`, errors);
    });
}
/**
 * Validate an unknown value as a canonical `WorkerResultEnvelope` (§4 / §13).
 *
 * Fail-closed: any violation throws `SchemaValidationError` with
 * `fieldErrors` (path + message per violation) — no partial acceptance, no
 * silent defaulting, no boolean-only result.  On success the input object is
 * returned unchanged (typed as `WorkerResultEnvelope`).
 */
function validateWorkerResultEnvelope(data) {
    const errors = [];
    if (!isRecord(data)) {
        errors.push({
            path: '',
            message: `Expected object, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}`,
        });
        throw new kernel_1.SchemaValidationError(`Schema validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, errors);
    }
    checkUnknownFields(data, ENVELOPE_KNOWN_FIELDS, '', errors);
    if (data.schemaVersion !== 1) {
        errors.push({
            path: 'schemaVersion',
            message: `Expected 1, got ${JSON.stringify(data.schemaVersion)}`,
        });
    }
    expectString(data.actionToken, 'actionToken', errors);
    expectIdentifier(data.stageId, 'stageId', errors);
    expectIdentifier(data.sliceId, 'sliceId', errors);
    expectOptionalString(data.taskId, 'taskId', errors);
    expectStringLiteral(data.mode, exports.WORKER_STEP_MODES, 'mode', errors);
    expectStringLiteral(data.outcome, exports.WORKER_OUTCOMES, 'outcome', errors);
    expectString(data.evidenceRef, 'evidenceRef', errors);
    expectStringArray(data.changedFiles, 'changedFiles', errors);
    validateVerificationRuns(data.verificationRuns, 'verificationRuns', errors);
    expectString(data.summary, 'summary', errors);
    if (errors.length > 0) {
        throw new kernel_1.SchemaValidationError(`Schema validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, errors);
    }
    return data;
}
//# sourceMappingURL=relay-contract.js.map