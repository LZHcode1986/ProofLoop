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
import type { FindingCode, ReceiptType } from './contracts';
/**
 * Error thrown when a contract payload fails schema validation.
 *
 * code: 'RUNTIME.SCHEMA_MISMATCH' (§7 Error Contracts)
 * fieldErrors: structured path + message for each violation.
 */
export declare class SchemaValidationError extends Error {
    /** Canonical error code. */
    readonly code: 'RUNTIME.SCHEMA_MISMATCH';
    /** Per-field validation errors. */
    readonly fieldErrors: Array<{
        path: string;
        message: string;
    }>;
    constructor(message: string, fieldErrors: Array<{
        path: string;
        message: string;
    }>);
}
/**
 * Inferred Receipt type.
 * Matches the Receipt interface from contracts.ts.
 *
 * This type mirrors the shape returned by validateReceipt.
 */
export type ValidatedReceipt = {
    version: 1;
    type: ReceiptType;
    stage_id: string;
    slice_id?: string;
    timestamp: string;
    digest: string;
    previous_digest?: string;
    payload: Record<string, unknown>;
    signature?: string;
};
/**
 * Inferred Manifest type.
 * Matches the Manifest interface from contracts.ts.
 */
export type ValidatedManifest = {
    stage_id: string;
    source_path: string;
    source_digest: string;
    stage_goal: string;
    outcomes: string[];
    slices: Array<{
        slice_id: string;
        goal: string;
        observable_outcome: string;
        public_seam: string;
        dependencies: string[];
        proof_obligations: Array<{
            po_id: string;
            behavior: string;
            public_seam: string;
            oracle_source: string;
            success_criteria: string;
            required_observation: string;
            applicable_risk_facts: string[];
        }>;
        tasks: string[];
        risk_facts: string[];
        evidence_path: string;
        cv_minimum_level: string;
    }>;
    dependencies: string[];
    risk_facts: string[];
    runtime_proof?: Array<{
        id: string;
        type: string;
        executable: string;
        args: string[];
        cwd: string;
        timeout_ms: number;
        expected?: Record<string, unknown>;
        not_applicable?: Record<string, unknown>;
        service_ref?: string;
        readiness_signal?: string;
    }>;
    compiled_at?: string;
    compiled_by?: string;
    repartition_requested?: boolean;
};
/**
 * Inferred RuntimeLock type.
 * Matches the RuntimeLock interface from contracts.ts.
 */
export type ValidatedRuntimeLock = {
    runtime_version: string;
    domain_schema_version: number;
    risk_policy_version: number;
    capability_policy_version: number;
    host_adapter: string;
    extension_package: string;
    extension_version: string;
};
/**
 * Inferred Finding type.
 * Matches the Finding interface from contracts.ts.
 */
export type ValidatedFinding = {
    code: FindingCode;
    severity: 'error' | 'warn';
    message: string;
};
/**
 * Validate an unknown value as a canonical Receipt (§4).
 *
 * @throws {SchemaValidationError} if data is not a valid Receipt.
 */
export declare function validateReceipt(data: unknown): ValidatedReceipt;
/**
 * Validate an unknown value as a canonical Manifest (§4).
 *
 * @throws {SchemaValidationError} if data is not a valid Manifest.
 */
export declare function validateManifest(data: unknown): ValidatedManifest;
/**
 * Validate an unknown value as a canonical RuntimeLock (§4).
 *
 * @throws {SchemaValidationError} if data is not a valid RuntimeLock.
 */
export declare function validateRuntimeLock(data: unknown): ValidatedRuntimeLock;
/**
 * Validate an unknown value as a canonical Finding (§5/§7).
 *
 * @throws {SchemaValidationError} if data is not a valid Finding.
 */
export declare function validateFinding(data: unknown): ValidatedFinding;
//# sourceMappingURL=validators.d.ts.map