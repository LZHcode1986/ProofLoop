"use strict";
/**
 * @proofloop/kernel — Contract Validators (Pure TypeScript)
 *
 * Public validation seam for Receipt, Manifest, RuntimeLock, and Finding
 * JSON payloads.  Every validator is a pure TypeScript type guard that
 * produces the canonical type from contracts.ts and is fail-closed:
 * invalid inputs throw SchemaValidationError.
 *
 * §7 Error Contracts — RUNTIME.SCHEMA_MISMATCH
 *
 * This file has ZERO external dependencies — all validation is performed
 * with plain typeof checks, null checks, Array.isArray, and regex patterns.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaValidationError = void 0;
exports.validateReceipt = validateReceipt;
exports.validateManifest = validateManifest;
exports.validateRuntimeLock = validateRuntimeLock;
exports.validateFinding = validateFinding;
// ============================================================
// SchemaValidationError
// ============================================================
/**
 * Error thrown when a contract payload fails schema validation.
 *
 * code: 'RUNTIME.SCHEMA_MISMATCH' (§7 Error Contracts)
 * fieldErrors: structured path + message for each violation.
 */
class SchemaValidationError extends Error {
    /** Canonical error code. */
    code = 'RUNTIME.SCHEMA_MISMATCH';
    /** Per-field validation errors. */
    fieldErrors;
    constructor(message, fieldErrors) {
        super(message);
        this.name = 'SchemaValidationError';
        this.fieldErrors = fieldErrors;
        // Maintain proper prototype chain for instanceof checks
        Object.setPrototypeOf(this, SchemaValidationError.prototype);
    }
}
exports.SchemaValidationError = SchemaValidationError;
// -----------------------------------------------------------------
// Primitive type guards
// -----------------------------------------------------------------
function isString(x) {
    return typeof x === 'string';
}
function isNonEmptyString(x) {
    return typeof x === 'string' && x.length > 0;
}
function isNumber(x) {
    return typeof x === 'number' && !Number.isNaN(x);
}
function isObject(x) {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isArray(x) {
    return Array.isArray(x);
}
function isBoolean(x) {
    return typeof x === 'boolean';
}
// -----------------------------------------------------------------
// Field validators
// -----------------------------------------------------------------
/**
 * Validate a required string field (min length enforced).
 */
function expectString(value, path, errors, minLength = 1) {
    if (!isString(value)) {
        errors.push({ path, message: `Expected string, got ${value === null ? 'null' : typeof value}` });
        return undefined;
    }
    if (value.length < minLength) {
        errors.push({ path, message: `String must be at least ${minLength} character(s)` });
        return undefined;
    }
    return value;
}
/**
 * Validate an optional string field.
 */
function expectOptionalString(value, path, errors) {
    if (value === undefined)
        return undefined;
    return expectString(value, path, errors);
}
/**
 * Validate a required number field.
 */
function expectNumber(value, path, errors) {
    if (!isNumber(value)) {
        errors.push({ path, message: `Expected number, got ${value === null ? 'null' : typeof value}` });
        return undefined;
    }
    return value;
}
/**
 * Validate an optional number field.
 */
function expectOptionalNumber(value, path, errors) {
    if (value === undefined)
        return undefined;
    return expectNumber(value, path, errors);
}
/**
 * Validate a required literal value (=== comparison).
 */
function expectLiteral(value, expected, path, errors) {
    if (value !== expected) {
        errors.push({ path, message: `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}` });
        return undefined;
    }
    return expected;
}
/**
 * Validate a required union of string literal values.
 */
function expectStringLiteral(value, literals, path, errors) {
    if (!isString(value)) {
        errors.push({ path, message: `Expected string, got ${value === null ? 'null' : typeof value}` });
        return undefined;
    }
    if (!literals.includes(value)) {
        errors.push({
            path,
            message: `Expected one of: ${literals.map(l => JSON.stringify(l)).join(', ')}`,
        });
        return undefined;
    }
    return value;
}
/**
 * Validate a required object (Record).
 */
function expectObject(value, path, errors) {
    if (!isObject(value)) {
        errors.push({
            path,
            message: `Expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
        });
        return undefined;
    }
    return value;
}
/**
 * Validate an optional object field.
 */
function expectOptionalObject(value, path, errors) {
    if (value === undefined)
        return undefined;
    return expectObject(value, path, errors);
}
/**
 * Validate a required array.
 */
function expectArray(value, path, errors) {
    if (!isArray(value)) {
        errors.push({ path, message: `Expected array, got ${value === null ? 'null' : typeof value}` });
        return undefined;
    }
    return value;
}
/**
 * Validate a required array of strings.
 */
function expectStringArray(value, path, errors) {
    const arr = expectArray(value, path, errors);
    if (!arr)
        return undefined;
    for (let i = 0; i < arr.length; i++) {
        if (!isString(arr[i])) {
            errors.push({ path: `${path}[${i}]`, message: `Expected string, got ${typeof arr[i]}` });
        }
    }
    return arr;
}
/**
 * Validate a required boolean.
 */
function expectBoolean(value, path, errors) {
    if (!isBoolean(value)) {
        errors.push({ path, message: `Expected boolean, got ${typeof value}` });
        return undefined;
    }
    return value;
}
// -----------------------------------------------------------------
// ISO 8601 datetime validation
// -----------------------------------------------------------------
/** Regex for ISO 8601 datetime with optional timezone offset. */
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;
/**
 * Validate an ISO 8601 datetime string with semantic date validation.
 *
 * In addition to format validation via regex, this function:
 * 1. Parses the date with `new Date(str)` to reject NaN dates
 * 2. Validates month (1-12), day (1-31), hours (0-23), minutes (0-59), seconds (0-59)
 * 3. Validates day-of-month for each month/year (rejects Feb 29 in non-leap year,
 *    Apr 31, etc.) using JavaScript's Date month rollover
 */
function expectISODateTime(value, path, errors) {
    const str = expectString(value, path, errors);
    if (!str)
        return undefined;
    if (!ISO_8601_REGEX.test(str)) {
        errors.push({ path, message: `Expected ISO 8601 datetime string (e.g., "2025-01-01T00:00:00.000Z")` });
        return undefined;
    }
    // Semantic validation: parse date components to reject impossible dates
    const match = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (!match) {
        errors.push({ path, message: `Cannot parse ISO date components in "${str}"` });
        return undefined;
    }
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const hours = parseInt(match[4], 10);
    const minutes = parseInt(match[5], 10);
    const seconds = parseInt(match[6], 10);
    // Range checks
    if (month < 1 || month > 12) {
        errors.push({ path, message: `Month out of range: ${month} in "${str}"` });
        return undefined;
    }
    if (day < 1 || day > 31) {
        errors.push({ path, message: `Day out of range: ${day} in "${str}"` });
        return undefined;
    }
    if (hours < 0 || hours > 23) {
        errors.push({ path, message: `Hours out of range: ${hours} in "${str}"` });
        return undefined;
    }
    if (minutes < 0 || minutes > 59) {
        errors.push({ path, message: `Minutes out of range: ${minutes} in "${str}"` });
        return undefined;
    }
    if (seconds < 0 || seconds > 59) {
        errors.push({ path, message: `Seconds out of range: ${seconds} in "${str}"` });
        return undefined;
    }
    // Validate day-of-month (catches Feb 29 in non-leap year, Apr 31, etc.)
    // JS Date month is 0-indexed, so new Date(year, month, 0) gives the last day of month-1
    // e.g., new Date(2025, 2, 0) = Feb 28, 2025 (last day of February)
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day > daysInMonth) {
        errors.push({ path, message: `Invalid day ${day} for month ${month}/${year}: "${str}"` });
        return undefined;
    }
    // Final sanity check: Date.parse should not be NaN
    const parsed = new Date(str);
    if (isNaN(parsed.getTime())) {
        errors.push({ path, message: `Date.parse rejected: "${str}"` });
        return undefined;
    }
    return str;
}
// ============================================================
// Finding Code literals (§7 Error Contracts)
// ============================================================
const FINDING_CODES = [
    'HOST.PROJECT_NOT_TRUSTED',
    'HOST.PATH_PROTECTED',
    'HOST.TOOL_NOT_ACTIVE',
    'HOST.PATH_OUTSIDE_PROJECT',
    'RUNTIME.VERSION_MISMATCH',
    'RUNTIME.RECEIPT_CHAIN_BROKEN',
    'RUNTIME.SCHEMA_MISMATCH',
    'DOMAIN.STAGE_NOT_FOUND',
    'DOMAIN.INVALID_TRANSITION',
];
// ============================================================
// Receipt Type literals (§4 File / Artifact Contracts)
// ============================================================
const RECEIPT_TYPES = [
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
// ============================================================
// Validation helpers (non-zod equivalents)
// ============================================================
function checkUnknownFields(data, knownFields, path, errors) {
    for (const key of Object.keys(data)) {
        if (!knownFields.has(key)) {
            errors.push({ path: `${path}.${key}`, message: `Unknown field "${key}"` });
        }
    }
}
// ============================================================
// Receipt validation
// ============================================================
const RECEIPT_KNOWN_FIELDS = new Set([
    'version', 'type', 'stage_id', 'slice_id', 'timestamp',
    'digest', 'previous_digest', 'payload', 'signature',
]);
function validateReceiptData(data, path, errors) {
    const obj = expectObject(data, path, errors);
    if (!obj)
        return undefined;
    // Check for unknown fields (fail-closed / strict mode)
    checkUnknownFields(obj, RECEIPT_KNOWN_FIELDS, path, errors);
    // version: must be literal 1
    expectLiteral(obj.version, 1, `${path}.version`, errors);
    // type: must be one of the 13 receipt types (closed set)
    expectStringLiteral(obj.type, RECEIPT_TYPES, `${path}.type`, errors);
    // stage_id: required string
    expectString(obj.stage_id, `${path}.stage_id`, errors);
    // slice_id: optional string
    if (obj.slice_id !== undefined) {
        expectString(obj.slice_id, `${path}.slice_id`, errors);
    }
    // timestamp: required ISO 8601
    expectISODateTime(obj.timestamp, `${path}.timestamp`, errors);
    // digest: required string
    expectString(obj.digest, `${path}.digest`, errors);
    // previous_digest: optional string
    if (obj.previous_digest !== undefined) {
        expectString(obj.previous_digest, `${path}.previous_digest`, errors);
    }
    // payload: required object (record)
    expectObject(obj.payload, `${path}.payload`, errors);
    // signature: optional string
    if (obj.signature !== undefined) {
        expectString(obj.signature, `${path}.signature`, errors);
    }
    return obj;
}
// ============================================================
// Manifest slice validation
// ============================================================
const SLICE_KNOWN_FIELDS = new Set([
    'slice_id', 'goal', 'observable_outcome', 'public_seam',
    'dependencies', 'proof_obligations', 'tasks', 'risk_facts',
    'evidence_path', 'cv_minimum_level',
]);
function validateSliceData(data, path, errors) {
    const obj = expectObject(data, path, errors);
    if (!obj)
        return undefined;
    checkUnknownFields(obj, SLICE_KNOWN_FIELDS, path, errors);
    expectString(obj.slice_id, `${path}.slice_id`, errors);
    expectString(obj.goal, `${path}.goal`, errors);
    expectString(obj.observable_outcome, `${path}.observable_outcome`, errors);
    expectString(obj.public_seam, `${path}.public_seam`, errors);
    expectStringArray(obj.dependencies, `${path}.dependencies`, errors);
    validateProofObligationsArray(obj.proof_obligations, `${path}.proof_obligations`, errors);
    expectStringArray(obj.tasks, `${path}.tasks`, errors);
    expectStringArray(obj.risk_facts, `${path}.risk_facts`, errors);
    expectString(obj.evidence_path, `${path}.evidence_path`, errors);
    expectStringLiteral(obj.cv_minimum_level, ['lite', 'standard', 'enhanced'], `${path}.cv_minimum_level`, errors);
    return obj;
}
// ============================================================
// Proof obligation validation
// ============================================================
const PO_KNOWN_FIELDS = new Set([
    'po_id', 'behavior', 'public_seam', 'oracle_source',
    'success_criteria', 'required_observation', 'applicable_risk_facts',
]);
function validateProofObligationData(data, path, errors) {
    const obj = expectObject(data, path, errors);
    if (!obj)
        return undefined;
    checkUnknownFields(obj, PO_KNOWN_FIELDS, path, errors);
    expectString(obj.po_id, `${path}.po_id`, errors);
    expectString(obj.behavior, `${path}.behavior`, errors);
    expectString(obj.public_seam, `${path}.public_seam`, errors);
    expectString(obj.oracle_source, `${path}.oracle_source`, errors);
    expectString(obj.success_criteria, `${path}.success_criteria`, errors);
    expectString(obj.required_observation, `${path}.required_observation`, errors);
    expectStringArray(obj.applicable_risk_facts, `${path}.applicable_risk_facts`, errors);
    return obj;
}
function validateProofObligationsArray(data, path, errors) {
    const arr = expectArray(data, path, errors);
    if (!arr)
        return;
    for (let i = 0; i < arr.length; i++) {
        validateProofObligationData(arr[i], `${path}[${i}]`, errors);
    }
}
// ============================================================
// Runtime proof step type literals
// ============================================================
const PROOF_STEP_TYPES = [
    'command',
    'service_start',
    'service_stop',
    'probe',
];
// ============================================================
// Runtime proof step validation
// ============================================================
const PROOF_STEP_KNOWN_FIELDS = new Set([
    'id', 'type', 'executable', 'args', 'cwd', 'timeout_ms',
    'expected', 'not_applicable', 'service_ref', 'readiness_signal',
]);
function validateRuntimeProofStepData(data, path, errors) {
    const obj = expectObject(data, path, errors);
    if (!obj)
        return undefined;
    checkUnknownFields(obj, PROOF_STEP_KNOWN_FIELDS, path, errors);
    expectString(obj.id, `${path}.id`, errors);
    expectStringLiteral(obj.type, PROOF_STEP_TYPES, `${path}.type`, errors);
    expectString(obj.executable, `${path}.executable`, errors);
    const args = expectArray(obj.args, `${path}.args`, errors);
    if (args) {
        for (let i = 0; i < args.length; i++) {
            if (!isString(args[i])) {
                errors.push({ path: `${path}.args[${i}]`, message: `Expected string, got ${typeof args[i]}` });
            }
        }
    }
    expectString(obj.cwd, `${path}.cwd`, errors);
    const timeoutMs = expectNumber(obj.timeout_ms, `${path}.timeout_ms`, errors);
    if (timeoutMs !== undefined) {
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
            errors.push({ path: `${path}.timeout_ms`, message: `Expected positive integer, got ${timeoutMs}` });
        }
    }
    // expected: optional object with exit_code validation
    if (obj.expected !== undefined) {
        const expectedObj = expectObject(obj.expected, `${path}.expected`, errors);
        if (expectedObj) {
            // Validate exit_code if present (must be number or null)
            if (expectedObj.exit_code !== undefined && expectedObj.exit_code !== null) {
                if (typeof expectedObj.exit_code !== 'number' || Number.isNaN(expectedObj.exit_code)) {
                    errors.push({ path: `${path}.expected.exit_code`, message: `Expected number or null, got ${typeof expectedObj.exit_code}` });
                }
            }
        }
    }
    // not_applicable: optional object with reason validation
    if (obj.not_applicable !== undefined) {
        const naObj = expectObject(obj.not_applicable, `${path}.not_applicable`, errors);
        if (naObj) {
            // Validate reason if present (must be non-empty string)
            if (naObj.reason !== undefined) {
                expectString(naObj.reason, `${path}.not_applicable.reason`, errors);
            }
        }
    }
    // service_ref: optional string (for service_stop steps)
    if (obj.service_ref !== undefined) {
        expectString(obj.service_ref, `${path}.service_ref`, errors);
    }
    // readiness_signal: optional string (for service_start steps)
    if (obj.readiness_signal !== undefined) {
        expectString(obj.readiness_signal, `${path}.readiness_signal`, errors);
    }
    return obj;
}
function validateRuntimeProofSteps(data, path, errors) {
    if (data === undefined)
        return; // optional field
    const arr = expectArray(data, path, errors);
    if (!arr)
        return;
    for (let i = 0; i < arr.length; i++) {
        validateRuntimeProofStepData(arr[i], `${path}[${i}]`, errors);
    }
}
// ============================================================
// Manifest validation
// ============================================================
const MANIFEST_KNOWN_FIELDS = new Set([
    'stage_id', 'source_path', 'source_digest', 'stage_goal',
    'outcomes', 'slices', 'dependencies', 'risk_facts',
    'runtime_proof', 'compiled_at', 'compiled_by', 'repartition_requested',
]);
function validateManifestData(data, path, errors) {
    const obj = expectObject(data, path, errors);
    if (!obj)
        return undefined;
    checkUnknownFields(obj, MANIFEST_KNOWN_FIELDS, path, errors);
    expectString(obj.stage_id, `${path}.stage_id`, errors);
    expectString(obj.source_path, `${path}.source_path`, errors);
    expectString(obj.source_digest, `${path}.source_digest`, errors);
    expectString(obj.stage_goal, `${path}.stage_goal`, errors);
    expectStringArray(obj.outcomes, `${path}.outcomes`, errors);
    // slices: array of slice objects
    const slices = expectArray(obj.slices, `${path}.slices`, errors);
    if (slices) {
        for (let i = 0; i < slices.length; i++) {
            validateSliceData(slices[i], `${path}.slices[${i}]`, errors);
        }
    }
    expectStringArray(obj.dependencies, `${path}.dependencies`, errors);
    expectStringArray(obj.risk_facts, `${path}.risk_facts`, errors);
    // runtime_proof: optional array of proof step objects
    validateRuntimeProofSteps(obj.runtime_proof, `${path}.runtime_proof`, errors);
    // compiled_at: optional string
    if (obj.compiled_at !== undefined) {
        expectString(obj.compiled_at, `${path}.compiled_at`, errors);
    }
    // compiled_by: optional string
    if (obj.compiled_by !== undefined) {
        expectString(obj.compiled_by, `${path}.compiled_by`, errors);
    }
    // repartition_requested: optional boolean (canonical REPARTITION fact source,
    // §4 Manifest contract — F-S02-08); absent (undefined) is valid and defaults
    // to false/not requested
    if (obj.repartition_requested !== undefined) {
        expectBoolean(obj.repartition_requested, `${path}.repartition_requested`, errors);
    }
    return obj;
}
// ============================================================
// RuntimeLock validation
// ============================================================
const RUNTIME_LOCK_KNOWN_FIELDS = new Set([
    'runtime_version', 'domain_schema_version', 'risk_policy_version',
    'capability_policy_version', 'host_adapter', 'extension_package',
    'extension_version',
]);
function validateRuntimeLockData(data, path, errors) {
    const obj = expectObject(data, path, errors);
    if (!obj)
        return undefined;
    checkUnknownFields(obj, RUNTIME_LOCK_KNOWN_FIELDS, path, errors);
    expectString(obj.runtime_version, `${path}.runtime_version`, errors);
    if (typeof obj.runtime_version === 'string' && !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+(\+[a-zA-Z0-9.]+)?)?$/.test(obj.runtime_version)) {
        errors.push({ path: `${path}.runtime_version`, message: 'must be semver (x.y.z)' });
    }
    expectNumber(obj.domain_schema_version, `${path}.domain_schema_version`, errors);
    if (typeof obj.domain_schema_version === 'number' && (!Number.isInteger(obj.domain_schema_version) || obj.domain_schema_version < 1)) {
        errors.push({ path: `${path}.domain_schema_version`, message: 'must be a positive integer' });
    }
    expectNumber(obj.risk_policy_version, `${path}.risk_policy_version`, errors);
    expectNumber(obj.capability_policy_version, `${path}.capability_policy_version`, errors);
    expectString(obj.host_adapter, `${path}.host_adapter`, errors);
    expectString(obj.extension_package, `${path}.extension_package`, errors);
    expectString(obj.extension_version, `${path}.extension_version`, errors);
    return obj;
}
// ============================================================
// Finding validation
// ============================================================
const FINDING_KNOWN_FIELDS = new Set([
    'code', 'severity', 'message',
]);
function validateFindingData(data, path, errors) {
    const obj = expectObject(data, path, errors);
    if (!obj)
        return undefined;
    checkUnknownFields(obj, FINDING_KNOWN_FIELDS, path, errors);
    expectStringLiteral(obj.code, FINDING_CODES, `${path}.code`, errors);
    expectStringLiteral(obj.severity, ['error', 'warn'], `${path}.severity`, errors);
    expectString(obj.message, `${path}.message`, errors);
    return obj;
}
// ============================================================
// Parse helpers — collect errors and throw SchemaValidationError
// ============================================================
function collectErrors(label, validateFn) {
    const errors = [];
    const result = validateFn(errors);
    if (errors.length > 0) {
        throw new SchemaValidationError(`Schema validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, errors);
    }
    return result;
}
// ============================================================
// Public validation functions
// ============================================================
/**
 * Validate an unknown value as a canonical Receipt (§4).
 *
 * @throws {SchemaValidationError} if data is not a valid Receipt.
 */
function validateReceipt(data) {
    return collectErrors('Receipt', (errors) => validateReceiptData(data, '', errors));
}
/**
 * Validate an unknown value as a canonical Manifest (§4).
 *
 * @throws {SchemaValidationError} if data is not a valid Manifest.
 */
function validateManifest(data) {
    return collectErrors('Manifest', (errors) => validateManifestData(data, '', errors));
}
/**
 * Validate an unknown value as a canonical RuntimeLock (§4).
 *
 * @throws {SchemaValidationError} if data is not a valid RuntimeLock.
 */
function validateRuntimeLock(data) {
    return collectErrors('RuntimeLock', (errors) => validateRuntimeLockData(data, '', errors));
}
/**
 * Validate an unknown value as a canonical Finding (§5/§7).
 *
 * @throws {SchemaValidationError} if data is not a valid Finding.
 */
function validateFinding(data) {
    return collectErrors('Finding', (errors) => validateFindingData(data, '', errors));
}
//# sourceMappingURL=validators.js.map