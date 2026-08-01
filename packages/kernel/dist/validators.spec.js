"use strict";
/**
 * Validators — RED/GREEN tests for contract validation functions.
 *
 * PO: PO-S01-C-01, PO-S01-C-02, PO-S01-C-03
 *
 * Tests the public validation seam for Receipt, Manifest, RuntimeLock, and
 * Finding contracts.  Every validation function must:
 *   - Return the canonical parsed type on valid input
 *   - Throw SchemaValidationError on invalid input (fail-closed)
 *   - Match the exact type definitions from contracts.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const kernel_1 = require("@proofloop/kernel");
// ============================================================
// SchemaValidationError — class structure
// ============================================================
(0, vitest_1.describe)('SchemaValidationError', () => {
    (0, vitest_1.it)('extends Error', () => {
        const err = new kernel_1.SchemaValidationError('test', []);
        (0, vitest_1.expect)(err).toBeInstanceOf(Error);
        (0, vitest_1.expect)(err).toBeInstanceOf(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('has code RUNTIME.SCHEMA_MISMATCH', () => {
        const err = new kernel_1.SchemaValidationError('test', []);
        (0, vitest_1.expect)(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    });
    (0, vitest_1.it)('carries fieldErrors array', () => {
        const err = new kernel_1.SchemaValidationError('validation failed', [
            { path: 'version', message: 'Expected 1, got 2' },
            { path: 'type', message: 'Invalid enum value' },
        ]);
        (0, vitest_1.expect)(err.fieldErrors).toHaveLength(2);
        (0, vitest_1.expect)(err.fieldErrors[0].path).toBe('version');
        (0, vitest_1.expect)(err.fieldErrors[0].message).toBe('Expected 1, got 2');
    });
    (0, vitest_1.it)('has correct name', () => {
        const err = new kernel_1.SchemaValidationError('test', []);
        (0, vitest_1.expect)(err.name).toBe('SchemaValidationError');
    });
});
// ============================================================
// validateReceipt
// ============================================================
(0, vitest_1.describe)('validateReceipt', () => {
    const validReceipt = {
        version: 1,
        type: 'TASK_COMPLETE',
        stage_id: 'S01',
        slice_id: 'S01-C',
        timestamp: '2025-01-01T00:00:00.000Z',
        digest: 'abc123def456',
        previous_digest: 'prev789',
        payload: { key: 'value' },
        signature: 'signed-by-x',
    };
    (0, vitest_1.it)('returns canonical Receipt on valid input', () => {
        const result = (0, kernel_1.validateReceipt)(validReceipt);
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)(result.type).toBe('TASK_COMPLETE');
        (0, vitest_1.expect)(result.stage_id).toBe('S01');
        (0, vitest_1.expect)(result.version).toBe(1);
    });
    (0, vitest_1.it)('accepts optional fields omitted', () => {
        const input = {
            version: 1,
            type: 'CV_PASS',
            stage_id: 'S01',
            timestamp: '2025-01-01T00:00:00.000Z',
            digest: 'def456',
            payload: {},
        };
        const result = (0, kernel_1.validateReceipt)(input);
        (0, vitest_1.expect)(result.type).toBe('CV_PASS');
        (0, vitest_1.expect)(result.slice_id).toBeUndefined();
        (0, vitest_1.expect)(result.previous_digest).toBeUndefined();
        (0, vitest_1.expect)(result.signature).toBeUndefined();
    });
    (0, vitest_1.it)('accepts all 12 receipt types', () => {
        const types = [
            'SLICE_PLAN', 'STAGE_PLAN', 'SPV_PASS', 'TASK_COMPLETE',
            'CV_PASS', 'CV_REPAIR', 'SLICE_COMMIT', 'INTEGRATION_PASS',
            'GATE_PASS', 'GATE_FAIL', 'STAGE_REVIEW_PASS', 'PROJECT_REVIEW_PASS',
        ];
        for (const type of types) {
            const result = (0, kernel_1.validateReceipt)({
                version: 1,
                type,
                stage_id: 'S01',
                timestamp: '2025-01-01T00:00:00.000Z',
                digest: 'x',
                payload: {},
            });
            (0, vitest_1.expect)(result.type).toBe(type);
        }
    });
    (0, vitest_1.it)('throws SchemaValidationError on invalid version', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...validReceipt, version: 2 })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on missing required field', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ type: 'CV_PASS' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on invalid type literal', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...validReceipt, type: 'INVALID_TYPE' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on non-object input', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)(null)).toThrow(kernel_1.SchemaValidationError);
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)(undefined)).toThrow(kernel_1.SchemaValidationError);
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)('string')).toThrow(kernel_1.SchemaValidationError);
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)(42)).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError with fieldErrors containing path details', () => {
        try {
            (0, kernel_1.validateReceipt)({ version: 2 });
        }
        catch (e) {
            const err = e;
            (0, vitest_1.expect)(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
            (0, vitest_1.expect)(err.fieldErrors.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(err.fieldErrors.some(f => f.path.includes('version'))).toBe(true);
        }
    });
});
// ============================================================
// validateManifest
// ============================================================
(0, vitest_1.describe)('validateManifest', () => {
    const validManifest = {
        stage_id: 'S01',
        source_path: 'tasks/S01/tasks.md',
        source_digest: 'abc123',
        stage_goal: 'Define kernel contract types',
        outcomes: ['All types defined'],
        slices: [
            {
                slice_id: 'S01-A',
                goal: 'Types',
                observable_outcome: 'Types are defined',
                public_seam: 'Public API',
                dependencies: [],
                proof_obligations: [],
                tasks: ['S01-A-T01'],
                risk_facts: ['public_api_change'],
                evidence_path: 'stages/S01/evidence/S01-A.md',
                cv_minimum_level: 'enhanced',
            },
            {
                slice_id: 'S01-B',
                goal: 'More types',
                observable_outcome: 'More types defined',
                public_seam: 'Public API',
                dependencies: [],
                proof_obligations: [],
                tasks: ['S01-B-T01'],
                risk_facts: [],
                evidence_path: 'stages/S01/evidence/S01-B.md',
                cv_minimum_level: 'enhanced',
            },
        ],
        dependencies: [],
        risk_facts: [],
    };
    (0, vitest_1.it)('returns canonical Manifest on valid input', () => {
        const result = (0, kernel_1.validateManifest)(validManifest);
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)(result.stage_id).toBe('S01');
        (0, vitest_1.expect)(result.slices).toHaveLength(2);
        (0, vitest_1.expect)(result.slices[0].slice_id).toBe('S01-A');
    });
    (0, vitest_1.it)('accepts optional fields omitted', () => {
        const input = {
            stage_id: 'S01',
            source_path: 'tasks.md',
            source_digest: 'x',
            stage_goal: 'Goal',
            outcomes: ['Outcome'],
            slices: [],
            dependencies: [],
            risk_facts: [],
        };
        const result = (0, kernel_1.validateManifest)(input);
        (0, vitest_1.expect)(result.compiled_at).toBeUndefined();
        (0, vitest_1.expect)(result.compiled_by).toBeUndefined();
        (0, vitest_1.expect)(result.runtime_proof).toBeUndefined();
    });
    (0, vitest_1.it)('throws SchemaValidationError on missing required fields', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({})).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on invalid slice shape', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...validManifest,
            slices: [{ bad: 'data' }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on slice missing observable_outcome', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...validManifest,
            slices: [{ slice_id: 'S01-A', goal: 'Types' }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('accepts manifest with runtime_proof', () => {
        const result = (0, kernel_1.validateManifest)({
            ...validManifest,
            runtime_proof: [{
                    id: 'build',
                    type: 'command',
                    executable: 'npm',
                    args: ['run', 'build'],
                    cwd: '.',
                    timeout_ms: 300000,
                    expected: { exit_code: 0 },
                }],
        });
        (0, vitest_1.expect)(result.runtime_proof).toBeDefined();
        (0, vitest_1.expect)(result.runtime_proof).toHaveLength(1);
        (0, vitest_1.expect)(result.runtime_proof[0].id).toBe('build');
    });
    (0, vitest_1.it)('accepts manifest with repartition_requested: true', () => {
        const result = (0, kernel_1.validateManifest)({
            ...validManifest,
            repartition_requested: true,
        });
        (0, vitest_1.expect)(result.repartition_requested).toBe(true);
    });
    (0, vitest_1.it)('accepts manifest with repartition_requested: false', () => {
        const result = (0, kernel_1.validateManifest)({
            ...validManifest,
            repartition_requested: false,
        });
        (0, vitest_1.expect)(result.repartition_requested).toBe(false);
    });
    (0, vitest_1.it)('accepts manifest without repartition_requested (optional field)', () => {
        const result = (0, kernel_1.validateManifest)(validManifest);
        (0, vitest_1.expect)(result.repartition_requested).toBeUndefined();
    });
    (0, vitest_1.it)('throws SchemaValidationError when repartition_requested is not a boolean', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...validManifest,
            repartition_requested: 'yes',
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on non-object input', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)(null)).toThrow(kernel_1.SchemaValidationError);
    });
});
// ============================================================
// validateRuntimeLock
// ============================================================
(0, vitest_1.describe)('validateRuntimeLock', () => {
    const validLock = {
        runtime_version: '1.0.0',
        domain_schema_version: 1,
        risk_policy_version: 2,
        capability_policy_version: 1,
        host_adapter: 'node-adapter',
        extension_package: '@proofloop/pi-extension',
        extension_version: '0.1.0',
    };
    (0, vitest_1.it)('returns canonical RuntimeLock on valid input', () => {
        const result = (0, kernel_1.validateRuntimeLock)(validLock);
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)(result.runtime_version).toBe('1.0.0');
        (0, vitest_1.expect)(result.host_adapter).toBe('node-adapter');
    });
    (0, vitest_1.it)('throws SchemaValidationError on missing field', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)({ runtime_version: '1.0.0' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on non-object input', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)('bad')).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on wrong type for runtime_version', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)({ ...validLock, runtime_version: 123 })).toThrow(kernel_1.SchemaValidationError);
    });
});
// ============================================================
// validateFinding
// ============================================================
(0, vitest_1.describe)('validateFinding', () => {
    const validFinding = {
        code: 'HOST.PROJECT_NOT_TRUSTED',
        severity: 'error',
        message: 'Project is not trusted.',
    };
    (0, vitest_1.it)('returns canonical Finding on valid input', () => {
        const result = (0, kernel_1.validateFinding)(validFinding);
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)(result.code).toBe('HOST.PROJECT_NOT_TRUSTED');
        (0, vitest_1.expect)(result.severity).toBe('error');
    });
    (0, vitest_1.it)('accepts warn severity', () => {
        const result = (0, kernel_1.validateFinding)({
            code: 'RUNTIME.VERSION_MISMATCH',
            severity: 'warn',
            message: 'Warning',
        });
        (0, vitest_1.expect)(result.severity).toBe('warn');
    });
    (0, vitest_1.it)('accepts all 9 canonical Finding codes', () => {
        const codes = [
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
        for (const code of codes) {
            const result = (0, kernel_1.validateFinding)({ code, severity: 'error', message: 'Test' });
            (0, vitest_1.expect)(result.code).toBe(code);
        }
    });
    (0, vitest_1.it)('throws SchemaValidationError on invalid code', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)({ code: 'INVALID.CODE', severity: 'error', message: 'x' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on invalid severity', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)({ ...validFinding, severity: 'critical' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on missing message', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)({ code: 'HOST.PATH_PROTECTED', severity: 'error' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('throws SchemaValidationError on non-object input', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)(123)).toThrow(kernel_1.SchemaValidationError);
    });
});
// ============================================================
// Semantic timestamp validation (Fix 1)
// ============================================================
(0, vitest_1.describe)('validateReceipt — semantic timestamp validation', () => {
    const base = {
        version: 1,
        type: 'TASK_COMPLETE',
        stage_id: 'S01',
        timestamp: '2025-01-01T00:00:00.000Z',
        digest: 'abc',
        payload: {},
    };
    (0, vitest_1.it)('rejects Feb 29 in non-leap year (2023)', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, timestamp: '2023-02-29T00:00:00.000Z' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects Feb 30', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, timestamp: '2025-02-30T00:00:00.000Z' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects Apr 31', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, timestamp: '2025-04-31T00:00:00.000Z' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects month 13', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, timestamp: '2025-13-01T00:00:00.000Z' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects hour 24', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, timestamp: '2025-01-01T24:00:00.000Z' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects minute 60', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, timestamp: '2025-01-01T00:60:00.000Z' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects second 60', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, timestamp: '2025-01-01T00:00:60.000Z' })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('accepts Feb 29 in leap year (2024)', () => {
        const result = (0, kernel_1.validateReceipt)({
            ...base,
            timestamp: '2024-02-29T12:30:00.000Z',
        });
        (0, vitest_1.expect)(result.timestamp).toBe('2024-02-29T12:30:00.000Z');
    });
    (0, vitest_1.it)('rejects zero-padded month with extra digit', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, timestamp: '2025-001-01T00:00:00.000Z' })).toThrow(kernel_1.SchemaValidationError);
    });
});
// ============================================================
// Runtime proof step constraining (Fix 2)
// ============================================================
(0, vitest_1.describe)('validateManifest — runtime proof step type constraining', () => {
    const makeSlice = (sliceId, goal) => ({
        slice_id: sliceId,
        goal,
        observable_outcome: `${goal} outcome`,
        public_seam: 'Public API',
        dependencies: [],
        proof_obligations: [],
        tasks: [`${sliceId}-T01`],
        risk_facts: [],
        evidence_path: `stages/S01/evidence/${sliceId}.md`,
        cv_minimum_level: 'enhanced',
    });
    const baseManifest = {
        stage_id: 'S01',
        source_path: 'tasks.md',
        source_digest: 'digest',
        stage_goal: 'Goal',
        outcomes: ['outcome'],
        slices: [makeSlice('S01-A', 'Goal')],
        dependencies: [],
        risk_facts: [],
    };
    const validProofStep = {
        id: 'build',
        type: 'command',
        executable: 'npm',
        args: ['run', 'build'],
        cwd: '.',
        timeout_ms: 300000,
        expected: { exit_code: 0 },
    };
    (0, vitest_1.it)('accepts type: command', () => {
        const result = (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{ ...validProofStep, type: 'command' }],
        });
        (0, vitest_1.expect)(result.runtime_proof[0].type).toBe('command');
    });
    (0, vitest_1.it)('accepts type: service_start', () => {
        const result = (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{ ...validProofStep, type: 'service_start', readiness_signal: 'ready' }],
        });
        (0, vitest_1.expect)(result.runtime_proof[0].type).toBe('service_start');
    });
    (0, vitest_1.it)('accepts type: service_stop', () => {
        const result = (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{ ...validProofStep, type: 'service_stop', service_ref: 'app' }],
        });
        (0, vitest_1.expect)(result.runtime_proof[0].type).toBe('service_stop');
    });
    (0, vitest_1.it)('accepts type: probe', () => {
        const result = (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{ ...validProofStep, type: 'probe' }],
        });
        (0, vitest_1.expect)(result.runtime_proof[0].type).toBe('probe');
    });
    (0, vitest_1.it)('rejects invalid runtime proof step type', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{ ...validProofStep, type: 'invalid_type' }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects runtime proof step type as number', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{ ...validProofStep, type: 123 }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects non-positive timeout_ms (zero)', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{ ...validProofStep, timeout_ms: 0 }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects non-positive timeout_ms (negative)', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{ ...validProofStep, timeout_ms: -100 }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects timeout_ms as floating point', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{ ...validProofStep, timeout_ms: 300.5 }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects timeout_ms as string', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{ ...validProofStep, timeout_ms: '300000' }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
});
// ============================================================
// Runtime proof step — nested field validation (Fix 2/3)
// ============================================================
(0, vitest_1.describe)('validateManifest — runtime proof step nested field validation', () => {
    const makeSlice = (sliceId, goal) => ({
        slice_id: sliceId,
        goal,
        observable_outcome: `${goal} outcome`,
        public_seam: 'Public API',
        dependencies: [],
        proof_obligations: [],
        tasks: [`${sliceId}-T01`],
        risk_facts: [],
        evidence_path: `stages/S01/evidence/${sliceId}.md`,
        cv_minimum_level: 'enhanced',
    });
    const baseManifest = {
        stage_id: 'S01',
        source_path: 'tasks.md',
        source_digest: 'digest',
        stage_goal: 'Goal',
        outcomes: ['outcome'],
        slices: [makeSlice('S01-A', 'Goal')],
        dependencies: [],
        risk_facts: [],
    };
    const validProofStep = {
        id: 'build',
        type: 'command',
        executable: 'npm',
        args: ['run', 'build'],
        cwd: '.',
        timeout_ms: 300000,
    };
    (0, vitest_1.it)('accepts expected.exit_code as number (0)', () => {
        const result = (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    ...validProofStep,
                    expected: { exit_code: 0 },
                }],
        });
        (0, vitest_1.expect)(result.runtime_proof[0].expected).toEqual({ exit_code: 0 });
    });
    (0, vitest_1.it)('rejects expected.exit_code as string', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    ...validProofStep,
                    expected: { exit_code: '0' },
                }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects expected.exit_code as boolean', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    ...validProofStep,
                    expected: { exit_code: true },
                }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('accepts expected.exit_code as null', () => {
        const result = (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    ...validProofStep,
                    expected: { exit_code: null },
                }],
        });
        (0, vitest_1.expect)(result.runtime_proof[0].expected).toEqual({ exit_code: null });
    });
    (0, vitest_1.it)('accepts not_applicable.reason as string', () => {
        const result = (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    ...validProofStep,
                    not_applicable: { reason: 'Not applicable in this context.' },
                }],
        });
        (0, vitest_1.expect)(result.runtime_proof[0].not_applicable).toEqual({ reason: 'Not applicable in this context.' });
    });
    (0, vitest_1.it)('rejects not_applicable.reason as number', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    ...validProofStep,
                    not_applicable: { reason: 42 },
                }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects not_applicable.reason as empty string', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    ...validProofStep,
                    not_applicable: { reason: '' },
                }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects runtime_proof step with args containing non-string element', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    ...validProofStep,
                    args: ['run', 123],
                }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects runtime_proof step missing required id field', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    type: 'command',
                    executable: 'npm',
                    args: ['build'],
                    cwd: '.',
                    timeout_ms: 300000,
                }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects runtime_proof step with expected as non-object (string)', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    ...validProofStep,
                    expected: 'not-an-object',
                }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects runtime_proof step with not_applicable as non-object (number)', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
            ...baseManifest,
            runtime_proof: [{
                    ...validProofStep,
                    not_applicable: 42,
                }],
        })).toThrow(kernel_1.SchemaValidationError);
    });
});
// ============================================================
// cv_minimum_level literal constraining (Fix 2)
// ============================================================
(0, vitest_1.describe)('validateManifest — cv_minimum_level constraining', () => {
    const makeSlice = (level) => ({
        slice_id: 'S01-A',
        goal: 'Goal',
        observable_outcome: 'Outcome',
        public_seam: 'Public API',
        dependencies: [],
        proof_obligations: [],
        tasks: ['S01-A-T01'],
        risk_facts: [],
        evidence_path: 'stages/S01/evidence/S01-A.md',
        cv_minimum_level: level,
    });
    const baseManifest = {
        stage_id: 'S01',
        source_path: 'tasks.md',
        source_digest: 'digest',
        stage_goal: 'Goal',
        outcomes: ['outcome'],
        slices: [makeSlice('enhanced')],
        dependencies: [],
        risk_facts: [],
    };
    (0, vitest_1.it)('accepts cv_minimum_level: lite', () => {
        const result = (0, kernel_1.validateManifest)({ ...baseManifest, slices: [makeSlice('lite')] });
        (0, vitest_1.expect)(result.slices[0].cv_minimum_level).toBe('lite');
    });
    (0, vitest_1.it)('accepts cv_minimum_level: standard', () => {
        const result = (0, kernel_1.validateManifest)({ ...baseManifest, slices: [makeSlice('standard')] });
        (0, vitest_1.expect)(result.slices[0].cv_minimum_level).toBe('standard');
    });
    (0, vitest_1.it)('accepts cv_minimum_level: enhanced', () => {
        const result = (0, kernel_1.validateManifest)({ ...baseManifest, slices: [makeSlice('enhanced')] });
        (0, vitest_1.expect)(result.slices[0].cv_minimum_level).toBe('enhanced');
    });
    (0, vitest_1.it)('rejects invalid cv_minimum_level', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({ ...baseManifest, slices: [makeSlice('super')] })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects cv_minimum_level as number', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({ ...baseManifest, slices: [{
                    slice_id: 'S01-A',
                    goal: 'Goal',
                    observable_outcome: 'Outcome',
                    public_seam: 'Public API',
                    dependencies: [],
                    proof_obligations: [],
                    tasks: ['S01-A-T01'],
                    risk_facts: [],
                    evidence_path: 'stages/S01/evidence/S01-A.md',
                    cv_minimum_level: 1,
                }] })).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('rejects cv_minimum_level as empty string', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({ ...baseManifest, slices: [makeSlice('')] })).toThrow(kernel_1.SchemaValidationError);
    });
});
// ============================================================
// Fail-closed — all invalid inputs throw (not return false)
// ============================================================
(0, vitest_1.describe)('fail-closed behavior', () => {
    (0, vitest_1.it)('validateReceipt throws on null/undefined', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)(null)).toThrow(kernel_1.SchemaValidationError);
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)(undefined)).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('validateManifest throws on null', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)(null)).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('validateRuntimeLock throws on null', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)(null)).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('validateFinding throws on null', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)(null)).toThrow(kernel_1.SchemaValidationError);
    });
    (0, vitest_1.it)('all functions produce fieldErrors with path details', () => {
        const inputs = [
            { name: 'Receipt', fn: kernel_1.validateReceipt, data: { version: 99 } },
            { name: 'Manifest', fn: kernel_1.validateManifest, data: {} },
            { name: 'RuntimeLock', fn: kernel_1.validateRuntimeLock, data: { runtime_version: 123 } },
            { name: 'Finding', fn: kernel_1.validateFinding, data: { code: 'BAD.CODE', severity: 'error', message: 'x' } },
        ];
        for (const { name, fn, data } of inputs) {
            try {
                fn(data);
                vitest_1.expect.unreachable(`${name} should have thrown`);
            }
            catch (e) {
                const err = e;
                (0, vitest_1.expect)(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
                (0, vitest_1.expect)(err.fieldErrors.length).toBeGreaterThan(0);
            }
        }
    });
});
// ============================================================
// Comprehensive fixture tests for S01-C-T03
//
// PO: PO-S01-C-01, PO-S01-C-02, PO-S01-C-03, PO-S01-C-04
//
// Extends coverage with:
//   - Multiple valid fixture variants for each contract type
//   - Systematic invalid fixtures (every required field missing,
//     wrong primitive types, bad enum literals, empty-string
//     boundaries)
//   - JSON round-trip tests for all 4 types
//   - All 12 Receipt types and all 9 Finding codes in round-trip
// ============================================================
// -----------------------------------------------------------------
// 1. Comprehensive VALID fixtures
// -----------------------------------------------------------------
(0, vitest_1.describe)('comprehensive valid fixtures', () => {
    // Each contract type gets at least 2 independent valid fixtures
    // with varied values to prove validation isn't hardcoded to one
    // specific shape.
    (0, vitest_1.describe)('Receipt — valid variants', () => {
        const validVariants = [
            // Minimal receipt (only required fields + optional omitted)
            {
                version: 1,
                type: 'SLICE_PLAN',
                stage_id: 'S02',
                timestamp: '2025-06-15T10:30:00.000Z',
                digest: 'a1b2c3d4e5f6',
                payload: {},
            },
            // Full receipt with all optionals
            {
                version: 1,
                type: 'STAGE_PLAN',
                stage_id: 'S03',
                slice_id: 'S03-A',
                timestamp: '2025-07-01T08:00:00.000Z',
                digest: 'deadbeefcafe',
                previous_digest: 'cafebabe1234',
                payload: { taskCount: 5, owner: 'planner' },
                signature: 'sig-001',
            },
            // Receipt with numeric-looking string values
            {
                version: 1,
                type: 'GATE_FAIL',
                stage_id: 'S99',
                timestamp: '2024-12-31T23:59:59.999Z',
                digest: '000000000000',
                payload: { reason: 'gate failure' },
            },
        ];
        for (let i = 0; i < validVariants.length; i++) {
            (0, vitest_1.it)(`passes variant ${i + 1} (type: ${validVariants[i].type})`, () => {
                const result = (0, kernel_1.validateReceipt)(validVariants[i]);
                (0, vitest_1.expect)(result).toBeDefined();
                (0, vitest_1.expect)(result.version).toBe(1);
                (0, vitest_1.expect)(result.type).toBe(validVariants[i].type);
            });
        }
    });
    (0, vitest_1.describe)('Manifest — valid variants', () => {
        const makeSlice = (sliceId, goal) => ({
            slice_id: sliceId,
            goal,
            observable_outcome: `${goal} outcome`,
            public_seam: 'Public API',
            dependencies: [],
            proof_obligations: [],
            tasks: [`${sliceId}-T01`],
            risk_facts: [],
            evidence_path: `stages/S01/evidence/${sliceId}.md`,
            cv_minimum_level: 'enhanced',
        });
        const validVariants = [
            // Manifest with single slice and all required fields
            {
                stage_id: 'S02',
                source_path: 'stages/S02/tasks.md',
                source_digest: 'def456',
                stage_goal: 'Build runtime integration',
                outcomes: ['Runtime accepts kernel types'],
                slices: [makeSlice('S02-A', 'Integration')],
                dependencies: ['S01'],
                risk_facts: [],
            },
            // Manifest with multiple slices, empty outcomes/arrays, optional fields
            {
                stage_id: 'S04',
                source_path: 'stages/S04/manifest.json',
                source_digest: '789abc',
                stage_goal: 'Final review pass',
                outcomes: [],
                slices: [
                    makeSlice('S04-A', 'Audit'),
                    makeSlice('S04-B', 'Remediation'),
                ],
                dependencies: ['S01', 'S02', 'S03'],
                risk_facts: ['public_api_change'],
                compiled_at: '2025-08-01T00:00:00.000Z',
                compiled_by: 'planner-v2',
            },
            // Manifest with runtime_proof
            {
                stage_id: 'S05',
                source_path: 'stages/S05/manifest.json',
                source_digest: 'runtime-proof-test',
                stage_goal: 'Runtime proof test',
                outcomes: ['Test runtime proof'],
                slices: [makeSlice('S05-A', 'Proof test')],
                dependencies: [],
                risk_facts: [],
                runtime_proof: [
                    {
                        id: 'install',
                        type: 'command',
                        executable: 'npm',
                        args: ['install'],
                        cwd: '.',
                        timeout_ms: 300000,
                        expected: { exit_code: 0 },
                    },
                ],
            },
        ];
        for (let i = 0; i < validVariants.length; i++) {
            (0, vitest_1.it)(`passes variant ${i + 1} (stage: ${validVariants[i].stage_id})`, () => {
                const result = (0, kernel_1.validateManifest)(validVariants[i]);
                (0, vitest_1.expect)(result).toBeDefined();
                (0, vitest_1.expect)(result.stage_id).toBe(validVariants[i].stage_id);
            });
        }
    });
    (0, vitest_1.describe)('RuntimeLock — valid variants', () => {
        const validVariants = [
            // Standard lock
            {
                runtime_version: '2.0.0',
                domain_schema_version: 1,
                risk_policy_version: 2,
                capability_policy_version: 1,
                host_adapter: 'bun-adapter',
                extension_package: '@proofloop/pi-extension',
                extension_version: '0.2.0',
            },
            // Semver with pre-release tags
            {
                runtime_version: '1.0.0-beta.1',
                domain_schema_version: 1,
                risk_policy_version: 0,
                capability_policy_version: 0,
                host_adapter: 'deno-adapter',
                extension_package: '@proofloop/pi-extension',
                extension_version: '0.1.0-rc.1',
            },
        ];
        for (let i = 0; i < validVariants.length; i++) {
            (0, vitest_1.it)(`passes variant ${i + 1} (runtime: ${validVariants[i].runtime_version})`, () => {
                const result = (0, kernel_1.validateRuntimeLock)(validVariants[i]);
                (0, vitest_1.expect)(result).toBeDefined();
                (0, vitest_1.expect)(result.runtime_version).toBe(validVariants[i].runtime_version);
            });
        }
    });
    (0, vitest_1.describe)('Finding — valid variants', () => {
        const validVariants = [
            { code: 'HOST.PATH_PROTECTED', severity: 'error', message: 'Path is protected by policy.' },
            { code: 'HOST.TOOL_NOT_ACTIVE', severity: 'warn', message: 'Tool is not active' },
            { code: 'RUNTIME.RECEIPT_CHAIN_BROKEN', severity: 'error', message: 'Receipt chain verification failed' },
            { code: 'DOMAIN.STAGE_NOT_FOUND', severity: 'warn', message: 'Stage not found in registry' },
            { code: 'DOMAIN.INVALID_TRANSITION', severity: 'error', message: 'Invalid state transition attempted' },
        ];
        for (let i = 0; i < validVariants.length; i++) {
            (0, vitest_1.it)(`passes variant ${i + 1} (code: ${validVariants[i].code})`, () => {
                const result = (0, kernel_1.validateFinding)(validVariants[i]);
                (0, vitest_1.expect)(result).toBeDefined();
                (0, vitest_1.expect)(result.code).toBe(validVariants[i].code);
                (0, vitest_1.expect)(result.severity).toBe(validVariants[i].severity);
            });
        }
    });
});
// -----------------------------------------------------------------
// 2. Comprehensive INVALID fixtures
// -----------------------------------------------------------------
(0, vitest_1.describe)('comprehensive invalid fixtures', () => {
    // --- Receipt invalid ---
    (0, vitest_1.describe)('Receipt — missing each required field', () => {
        const base = {
            version: 1,
            type: 'TASK_COMPLETE',
            stage_id: 'S01',
            timestamp: '2025-01-01T00:00:00.000Z',
            digest: 'abc',
            payload: {},
        };
        const requiredFields = ['version', 'type', 'stage_id', 'timestamp', 'digest', 'payload'];
        for (const field of requiredFields) {
            (0, vitest_1.it)(`throws when required field "${field}" is missing`, () => {
                const { [field]: _, ...rest } = base;
                (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)(rest)).toThrow(kernel_1.SchemaValidationError);
            });
        }
        (0, vitest_1.it)('throws when payload is not an object', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, payload: 'not-an-object' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when type is empty string', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, type: '' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when stage_id is empty string', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, stage_id: '' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when timestamp is empty string', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, timestamp: '' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when digest is empty string', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, digest: '' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when type is wrong type (number)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, type: 123 })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when version is wrong type (string)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, version: '1' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when stage_id is wrong type (null)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, stage_id: null })).toThrow(kernel_1.SchemaValidationError);
        });
    });
    (0, vitest_1.describe)('Receipt — invalid enum literals', () => {
        const base = {
            version: 1,
            type: 'TASK_COMPLETE',
            stage_id: 'S01',
            timestamp: '2025-01-01T00:00:00.000Z',
            digest: 'abc',
            payload: {},
        };
        (0, vitest_1.it)('throws for made-up receipt type', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, type: 'SPACE_LAUNCH' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws for lowercase receipt type', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, type: 'cv_pass' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws for numeric version !== 1 (version 0)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, version: 0 })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws for negative version', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, version: -1 })).toThrow(kernel_1.SchemaValidationError);
        });
    });
    // --- Manifest invalid ---
    (0, vitest_1.describe)('Manifest — missing each required field', () => {
        const makeSlice = (sliceId, goal) => ({
            slice_id: sliceId,
            goal,
            observable_outcome: `${goal} outcome`,
            public_seam: 'Public API',
            dependencies: [],
            proof_obligations: [],
            tasks: [`${sliceId}-T01`],
            risk_facts: [],
            evidence_path: `stages/S01/evidence/${sliceId}.md`,
            cv_minimum_level: 'enhanced',
        });
        const base = {
            stage_id: 'S01',
            source_path: 'tasks.md',
            source_digest: 'digest',
            stage_goal: 'Goal',
            outcomes: ['outcome'],
            slices: [makeSlice('S01-A', 'Goal')],
            dependencies: [],
            risk_facts: [],
        };
        const requiredFields = ['stage_id', 'source_path', 'source_digest', 'stage_goal', 'slices', 'dependencies', 'risk_facts'];
        for (const field of requiredFields) {
            (0, vitest_1.it)(`throws when required field "${field}" is missing`, () => {
                const { [field]: _, ...rest } = base;
                (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)(rest)).toThrow(kernel_1.SchemaValidationError);
            });
        }
        (0, vitest_1.it)('throws when stage_id is empty string', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({ ...base, stage_id: '' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when source_path is wrong type (number)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({ ...base, source_path: 42 })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when slices is not an array', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({ ...base, slices: 'not-array' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when a slice entry is missing slice_id', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
                ...base,
                slices: [{ goal: 'No-slice-id' }],
            })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when a slice entry has empty slice_id', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
                ...base,
                slices: [{ slice_id: '', goal: 'Empty-slice-id' }],
            })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when a slice entry is missing observable_outcome', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
                ...base,
                slices: [{ slice_id: 'S01-A', goal: 'Goal' }],
            })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when a slice entry has wrong type for dependencies', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
                ...base,
                slices: [{
                        ...makeSlice('S01-A', 'Goal'),
                        dependencies: 'not-an-array',
                    }],
            })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when runtime_proof entry is missing required field', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateManifest)({
                ...base,
                runtime_proof: [{ incomplete: true }],
            })).toThrow(kernel_1.SchemaValidationError);
        });
    });
    // --- RuntimeLock invalid ---
    (0, vitest_1.describe)('RuntimeLock — missing each required field', () => {
        const base = {
            runtime_version: '1.0.0',
            domain_schema_version: 1,
            risk_policy_version: 2,
            capability_policy_version: 1,
            host_adapter: 'node',
            extension_package: '@proofloop/pi-extension',
            extension_version: '0.1.0',
        };
        const requiredFields = [
            'runtime_version', 'domain_schema_version', 'risk_policy_version',
            'capability_policy_version', 'host_adapter', 'extension_package',
            'extension_version',
        ];
        for (const field of requiredFields) {
            (0, vitest_1.it)(`throws when required field "${field}" is missing`, () => {
                const { [field]: _, ...rest } = base;
                (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)(rest)).toThrow(kernel_1.SchemaValidationError);
            });
        }
        (0, vitest_1.it)('throws when runtime_version is empty string', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)({ ...base, runtime_version: '' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when domain_schema_version is a string (must be number)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)({ ...base, domain_schema_version: '1' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when risk_policy_version is a string (must be number)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)({ ...base, risk_policy_version: '2' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when host_adapter is wrong type (boolean)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)({ ...base, host_adapter: true })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when extension_package is wrong type (object)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)({ ...base, extension_package: {} })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when domain_schema_version is wrong type (string)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateRuntimeLock)({ ...base, domain_schema_version: '1' })).toThrow(kernel_1.SchemaValidationError);
        });
    });
    // --- Finding invalid ---
    (0, vitest_1.describe)('Finding — missing each required field', () => {
        const base = {
            code: 'HOST.PROJECT_NOT_TRUSTED',
            severity: 'error',
            message: 'Some message',
        };
        const requiredFields = ['code', 'severity', 'message'];
        for (const field of requiredFields) {
            (0, vitest_1.it)(`throws when required field "${field}" is missing`, () => {
                const { [field]: _, ...rest } = base;
                (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)(rest)).toThrow(kernel_1.SchemaValidationError);
            });
        }
        (0, vitest_1.it)('throws when code is empty string', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)({ ...base, code: '' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when message is empty string', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)({ ...base, message: '' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws for non-canonical code format', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)({ ...base, code: 'HOST.NONEXISTENT' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when severity is invalid string', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)({ ...base, severity: 'critical' })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when severity is wrong type (number)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)({ ...base, severity: 1 })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when code is wrong type (number)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)({ ...base, code: 999 })).toThrow(kernel_1.SchemaValidationError);
        });
        (0, vitest_1.it)('throws when message is wrong type (array)', () => {
            (0, vitest_1.expect)(() => (0, kernel_1.validateFinding)({ ...base, message: ['details'] })).toThrow(kernel_1.SchemaValidationError);
        });
    });
    // --- Empty/null/undefined inputs for all 4 ---
    (0, vitest_1.describe)('empty/null/undefined inputs for all types', () => {
        const inputs = [
            { name: 'Receipt', fn: kernel_1.validateReceipt },
            { name: 'Manifest', fn: kernel_1.validateManifest },
            { name: 'RuntimeLock', fn: kernel_1.validateRuntimeLock },
            { name: 'Finding', fn: kernel_1.validateFinding },
        ];
        for (const { name, fn } of inputs) {
            (0, vitest_1.it)(`${name} throws on null`, () => {
                (0, vitest_1.expect)(() => fn(null)).toThrow(kernel_1.SchemaValidationError);
            });
            (0, vitest_1.it)(`${name} throws on undefined`, () => {
                (0, vitest_1.expect)(() => fn(undefined)).toThrow(kernel_1.SchemaValidationError);
            });
            (0, vitest_1.it)(`${name} throws on empty object`, () => {
                (0, vitest_1.expect)(() => fn({})).toThrow(kernel_1.SchemaValidationError);
            });
            (0, vitest_1.it)(`${name} throws on empty string`, () => {
                (0, vitest_1.expect)(() => fn('')).toThrow(kernel_1.SchemaValidationError);
            });
            (0, vitest_1.it)(`${name} throws on number`, () => {
                (0, vitest_1.expect)(() => fn(42)).toThrow(kernel_1.SchemaValidationError);
            });
            (0, vitest_1.it)(`${name} throws on array`, () => {
                (0, vitest_1.expect)(() => fn([])).toThrow(kernel_1.SchemaValidationError);
            });
            (0, vitest_1.it)(`${name} throws on boolean`, () => {
                (0, vitest_1.expect)(() => fn(true)).toThrow(kernel_1.SchemaValidationError);
            });
        }
    });
});
// -----------------------------------------------------------------
// 3. JSON round-trip tests
//
// PO: PO-S01-C-04
//
// Valid values → JSON.stringify → JSON.parse → validate →
// deep equality with original
// -----------------------------------------------------------------
(0, vitest_1.describe)('JSON round-trip', () => {
    // Helper: round-trip a value through JSON and validation
    function roundTripReceipt(input) {
        const json = JSON.stringify(input);
        const parsed = JSON.parse(json);
        return (0, kernel_1.validateReceipt)(parsed);
    }
    function roundTripManifest(input) {
        const json = JSON.stringify(input);
        const parsed = JSON.parse(json);
        return (0, kernel_1.validateManifest)(parsed);
    }
    function roundTripRuntimeLock(input) {
        const json = JSON.stringify(input);
        const parsed = JSON.parse(json);
        return (0, kernel_1.validateRuntimeLock)(parsed);
    }
    function roundTripFinding(input) {
        const json = JSON.stringify(input);
        const parsed = JSON.parse(json);
        return (0, kernel_1.validateFinding)(parsed);
    }
    (0, vitest_1.describe)('Receipt round-trip', () => {
        (0, vitest_1.it)('round-trips a minimal receipt with deep equality', () => {
            const input = {
                version: 1,
                type: 'SLICE_PLAN',
                stage_id: 'S01-A',
                timestamp: '2025-01-15T10:00:00.000Z',
                digest: 'abc123',
                payload: {},
            };
            const result = roundTripReceipt(input);
            (0, vitest_1.expect)(result).toEqual(input);
        });
        (0, vitest_1.it)('round-trips a full receipt with all optional fields', () => {
            const input = {
                version: 1,
                type: 'SLICE_COMMIT',
                stage_id: 'S05',
                slice_id: 'S05-A',
                timestamp: '2025-03-01T12:00:00.000Z',
                digest: 'feedface',
                previous_digest: 'deadbeef',
                payload: { files: ['a.ts', 'b.ts'] },
                signature: 'alice-sig',
            };
            const result = roundTripReceipt(input);
            (0, vitest_1.expect)(result).toEqual(input);
        });
        (0, vitest_1.it)('round-trips all 12 receipt types', () => {
            const types = [
                'SLICE_PLAN', 'STAGE_PLAN', 'SPV_PASS', 'TASK_COMPLETE',
                'CV_PASS', 'CV_REPAIR', 'SLICE_COMMIT', 'INTEGRATION_PASS',
                'GATE_PASS', 'GATE_FAIL', 'STAGE_REVIEW_PASS', 'PROJECT_REVIEW_PASS',
            ];
            for (const type of types) {
                const input = {
                    version: 1,
                    type,
                    stage_id: 'S01',
                    timestamp: '2025-01-01T00:00:00.000Z',
                    digest: `digest-for-${type}`,
                    payload: {},
                };
                const result = roundTripReceipt(input);
                (0, vitest_1.expect)(result).toEqual(input);
            }
        });
    });
    (0, vitest_1.describe)('Manifest round-trip', () => {
        const makeSlice = (sliceId, goal) => ({
            slice_id: sliceId,
            goal,
            observable_outcome: `${goal} outcome`,
            public_seam: 'Public API',
            dependencies: [],
            proof_obligations: [],
            tasks: [`${sliceId}-T01`],
            risk_facts: [],
            evidence_path: `stages/S01/evidence/${sliceId}.md`,
            cv_minimum_level: 'enhanced',
        });
        (0, vitest_1.it)('round-trips a manifest with multiple slices', () => {
            const input = {
                stage_id: 'S02',
                source_path: 'stages/S02/manifest.json',
                source_digest: 'digest-002',
                stage_goal: 'Build runtime',
                outcomes: ['Outcome A', 'Outcome B'],
                slices: [
                    makeSlice('S02-A', 'Slice A'),
                    makeSlice('S02-B', 'Slice B'),
                    makeSlice('S02-C', 'Slice C'),
                ],
                dependencies: ['S01'],
                risk_facts: ['risk-1'],
                compiled_at: '2025-02-01T00:00:00.000Z',
                compiled_by: 'builder',
            };
            const result = roundTripManifest(input);
            (0, vitest_1.expect)(result).toEqual(input);
        });
        (0, vitest_1.it)('round-trips a manifest with empty arrays', () => {
            const input = {
                stage_id: 'S03',
                source_path: 'stages/S03/manifest.json',
                source_digest: 'digest-003',
                stage_goal: 'Empty arrays test',
                outcomes: [],
                slices: [],
                dependencies: [],
                risk_facts: [],
            };
            const result = roundTripManifest(input);
            (0, vitest_1.expect)(result).toEqual(input);
        });
    });
    (0, vitest_1.describe)('RuntimeLock round-trip', () => {
        (0, vitest_1.it)('round-trips a standard runtime lock', () => {
            const input = {
                runtime_version: '1.2.3',
                domain_schema_version: 1,
                risk_policy_version: 2,
                capability_policy_version: 3,
                host_adapter: 'node-adapter',
                extension_package: '@proofloop/pi-extension',
                extension_version: '0.3.0',
            };
            const result = roundTripRuntimeLock(input);
            (0, vitest_1.expect)(result).toEqual(input);
        });
        (0, vitest_1.it)('round-trips with numeric version fields', () => {
            const input = {
                runtime_version: '2.0.0-rc.1',
                domain_schema_version: 1,
                risk_policy_version: 0,
                capability_policy_version: 1,
                host_adapter: 'bun-adapter',
                extension_package: '@proofloop/pi-extension',
                extension_version: '0.2.0-next',
            };
            const result = roundTripRuntimeLock(input);
            (0, vitest_1.expect)(result).toEqual(input);
        });
    });
    (0, vitest_1.describe)('Finding round-trip', () => {
        (0, vitest_1.it)('round-trips an error finding', () => {
            const input = {
                code: 'HOST.PROJECT_NOT_TRUSTED',
                severity: 'error',
                message: 'Project is not in trust store.',
            };
            const result = roundTripFinding(input);
            (0, vitest_1.expect)(result).toEqual(input);
        });
        (0, vitest_1.it)('round-trips a warn finding', () => {
            const input = {
                code: 'RUNTIME.VERSION_MISMATCH',
                severity: 'warn',
                message: 'Runtime version differs from expected.',
            };
            const result = roundTripFinding(input);
            (0, vitest_1.expect)(result).toEqual(input);
        });
        (0, vitest_1.it)('round-trips all 9 Finding codes', () => {
            const codes = [
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
            for (const code of codes) {
                const input = {
                    code,
                    severity: 'warn',
                    message: `Finding: ${code}`,
                };
                const result = roundTripFinding(input);
                (0, vitest_1.expect)(result).toEqual(input);
            }
        });
        (0, vitest_1.it)('round-trips preserves severity:error for all 9 codes', () => {
            const codes = [
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
            for (const code of codes) {
                const input = {
                    code,
                    severity: 'error',
                    message: `Error: ${code}`,
                };
                const result = roundTripFinding(input);
                (0, vitest_1.expect)(result).toEqual(input);
            }
        });
    });
});
// ============================================================
// GATE_INTERRUPTED — additive 13th receipt type (PO-S05-A-06, HP-004/AWI-015)
//
// S05-A-T05: the kernel contract adds exactly ONE additive ReceiptType,
// `GATE_INTERRUPTED`. The validator closed set accepts it; the existing 12
// types keep identical validation / chain / digest behavior (the untouched
// 12-type fixtures above remain the old-12 regression).
// ============================================================
(0, vitest_1.describe)('GATE_INTERRUPTED — additive 13th receipt type (PO-S05-A-06)', () => {
    /** Closed 13-type set — the canonical §4 receipt enumeration after S05. */
    const RECEIPT_TYPES_13 = [
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
    const base = {
        version: 1,
        stage_id: 'S05',
        timestamp: '2025-08-01T00:00:00.000Z',
        digest: 'gate-interrupted-digest',
        payload: {},
    };
    (0, vitest_1.it)('accepts the exact 13-type closed set (12 existing + GATE_INTERRUPTED)', () => {
        (0, vitest_1.expect)(RECEIPT_TYPES_13).toHaveLength(13);
        (0, vitest_1.expect)(new Set(RECEIPT_TYPES_13).size).toBe(13); // no alias / duplicate
        for (const type of RECEIPT_TYPES_13) {
            const result = (0, kernel_1.validateReceipt)({ ...base, type });
            (0, vitest_1.expect)(result.type).toBe(type);
        }
    });
    (0, vitest_1.it)('accepts a GATE_INTERRUPTED receipt carrying the canonical interruption payload (reason + duration_ms)', () => {
        const cancelled = (0, kernel_1.validateReceipt)({
            ...base,
            type: 'GATE_INTERRUPTED',
            payload: { reason: 'cancelled', duration_ms: 12000 },
        });
        (0, vitest_1.expect)(cancelled.type).toBe('GATE_INTERRUPTED');
        (0, vitest_1.expect)(cancelled.payload).toEqual({ reason: 'cancelled', duration_ms: 12000 });
        const timeout = (0, kernel_1.validateReceipt)({
            ...base,
            type: 'GATE_INTERRUPTED',
            payload: { reason: 'timeout', duration_ms: 300000 },
        });
        (0, vitest_1.expect)(timeout.type).toBe('GATE_INTERRUPTED');
        (0, vitest_1.expect)(timeout.payload).toEqual({ reason: 'timeout', duration_ms: 300000 });
    });
    (0, vitest_1.it)('old-12 regression: every pre-S05 receipt type validates byte-identically (round-trip)', () => {
        const old12 = RECEIPT_TYPES_13.filter((t) => t !== 'GATE_INTERRUPTED');
        (0, vitest_1.expect)(old12).toHaveLength(12);
        for (const type of old12) {
            const input = {
                version: 1,
                type,
                stage_id: 'S01',
                timestamp: '2025-01-01T00:00:00.000Z',
                digest: `digest-for-${type}`,
                payload: {},
            };
            const json = JSON.stringify(input);
            const result = (0, kernel_1.validateReceipt)(JSON.parse(json));
            (0, vitest_1.expect)(result).toEqual(input);
        }
    });
    (0, vitest_1.it)('rejects a 14th alias / misspelled interruption type (fail closed, no silent widening)', () => {
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, type: 'GATE_INTERRUPT' })).toThrow(kernel_1.SchemaValidationError);
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, type: 'GATE_CANCELLED' })).toThrow(kernel_1.SchemaValidationError);
        (0, vitest_1.expect)(() => (0, kernel_1.validateReceipt)({ ...base, type: 'GATE_ABORTED' })).toThrow(kernel_1.SchemaValidationError);
    });
});
//# sourceMappingURL=validators.spec.js.map