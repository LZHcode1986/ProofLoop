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

import { describe, it, expect } from 'vitest';
import {
  validateReceipt,
  validateManifest,
  validateRuntimeLock,
  validateFinding,
  SchemaValidationError,
} from '@proofloop/kernel';
// S09-C-T01: the canonical Runtime Proof step validator lives in this file
// (source-relative import; the public package surface is not re-exported).
// The error class is imported from the SAME source module so instanceof
// assertions match the validator's thrown instances.
import { validateRuntimeProofStep, SchemaValidationError as SourceSchemaValidationError } from './validators';
// S09-C-T03: the shared canonical Stage ID guard (^S\d+$) lives in this file
// (source-relative import, same convention as the Runtime Proof validator).
import {
  isCanonicalStageId,
  assertCanonicalStageId,
  CANONICAL_STAGE_ID_RE,
} from './validators';

// ============================================================
// SchemaValidationError — class structure
// ============================================================

describe('SchemaValidationError', () => {
  it('extends Error', () => {
    const err = new SchemaValidationError('test', []);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SchemaValidationError);
  });

  it('has code RUNTIME.SCHEMA_MISMATCH', () => {
    const err = new SchemaValidationError('test', []);
    expect(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });

  it('carries fieldErrors array', () => {
    const err = new SchemaValidationError('validation failed', [
      { path: 'version', message: 'Expected 1, got 2' },
      { path: 'type', message: 'Invalid enum value' },
    ]);
    expect(err.fieldErrors).toHaveLength(2);
    expect(err.fieldErrors[0].path).toBe('version');
    expect(err.fieldErrors[0].message).toBe('Expected 1, got 2');
  });

  it('has correct name', () => {
    const err = new SchemaValidationError('test', []);
    expect(err.name).toBe('SchemaValidationError');
  });
});

// ============================================================
// validateReceipt
// ============================================================

describe('validateReceipt', () => {
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

  it('returns canonical Receipt on valid input', () => {
    const result = validateReceipt(validReceipt);
    expect(result).toBeDefined();
    expect(result.type).toBe('TASK_COMPLETE');
    expect(result.stage_id).toBe('S01');
    expect(result.version).toBe(1);
  });

  it('accepts optional fields omitted', () => {
    const input = {
      version: 1,
      type: 'CV_PASS',
      stage_id: 'S01',
      timestamp: '2025-01-01T00:00:00.000Z',
      digest: 'def456',
      payload: {},
    };
    const result = validateReceipt(input);
    expect(result.type).toBe('CV_PASS');
    expect(result.slice_id).toBeUndefined();
    expect(result.previous_digest).toBeUndefined();
    expect(result.signature).toBeUndefined();
  });

  // Legacy pre-project-E2E regression fixture: the 12 pre-gate receipt types.
  // The canonical set is now the 16-type closed set (incl. GATE_INTERRUPTED
  // and PROJECT_E2E_*); full 16-type coverage lives in the dedicated
  // `RECEIPT_TYPES_16` describe block below. This fixture is intentionally
  // kept as the old-12 regression, not updated to the new count.
  it('accepts the 12 legacy pre-project-E2E receipt types (old-12 regression fixture)', () => {
    const types = [
      'SLICE_PLAN', 'STAGE_PLAN', 'SPV_PASS', 'TASK_COMPLETE',
      'CV_PASS', 'CV_REPAIR', 'SLICE_COMMIT', 'INTEGRATION_PASS',
      'GATE_PASS', 'GATE_FAIL', 'STAGE_REVIEW_PASS', 'PROJECT_REVIEW_PASS',
    ] as const;
    for (const type of types) {
      const result = validateReceipt({
        version: 1,
        type,
        stage_id: 'S01',
        timestamp: '2025-01-01T00:00:00.000Z',
        digest: 'x',
        payload: {},
      });
      expect(result.type).toBe(type);
    }
  });

  it('throws SchemaValidationError on invalid version', () => {
    expect(() =>
      validateReceipt({ ...validReceipt, version: 2 }),
    ).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on missing required field', () => {
    expect(() =>
      validateReceipt({ type: 'CV_PASS' }),
    ).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on invalid type literal', () => {
    expect(() =>
      validateReceipt({ ...validReceipt, type: 'INVALID_TYPE' }),
    ).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on non-object input', () => {
    expect(() => validateReceipt(null)).toThrow(SchemaValidationError);
    expect(() => validateReceipt(undefined)).toThrow(SchemaValidationError);
    expect(() => validateReceipt('string')).toThrow(SchemaValidationError);
    expect(() => validateReceipt(42)).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError with fieldErrors containing path details', () => {
    try {
      validateReceipt({ version: 2 });
    } catch (e) {
      const err = e as SchemaValidationError;
      expect(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(err.fieldErrors.length).toBeGreaterThan(0);
      expect(err.fieldErrors.some(f => f.path.includes('version'))).toBe(true);
    }
  });
});

// ============================================================
// validateManifest
// ============================================================

describe('validateManifest', () => {
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

  it('returns canonical Manifest on valid input', () => {
    const result = validateManifest(validManifest);
    expect(result).toBeDefined();
    expect(result.stage_id).toBe('S01');
    expect(result.slices).toHaveLength(2);
    expect(result.slices[0].slice_id).toBe('S01-A');
  });

  it('accepts optional fields omitted', () => {
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
    const result = validateManifest(input);
    expect(result.compiled_at).toBeUndefined();
    expect(result.compiled_by).toBeUndefined();
    expect(result.runtime_proof).toBeUndefined();
  });

  it('throws SchemaValidationError on missing required fields', () => {
    expect(() => validateManifest({})).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on invalid slice shape', () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        slices: [{ bad: 'data' }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on slice missing observable_outcome', () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        slices: [{ slice_id: 'S01-A', goal: 'Types' }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('accepts manifest with runtime_proof', () => {
    const result = validateManifest({
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
    expect(result.runtime_proof).toBeDefined();
    expect(result.runtime_proof).toHaveLength(1);
    expect(result.runtime_proof![0].id).toBe('build');
  });

  it('accepts manifest with repartition_requested: true', () => {
    const result = validateManifest({
      ...validManifest,
      repartition_requested: true,
    });
    expect(result.repartition_requested).toBe(true);
  });

  it('accepts manifest with repartition_requested: false', () => {
    const result = validateManifest({
      ...validManifest,
      repartition_requested: false,
    });
    expect(result.repartition_requested).toBe(false);
  });

  it('accepts manifest without repartition_requested (optional field)', () => {
    const result = validateManifest(validManifest);
    expect(result.repartition_requested).toBeUndefined();
  });

  it('throws SchemaValidationError when repartition_requested is not a boolean', () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        repartition_requested: 'yes',
      }),
    ).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on non-object input', () => {
    expect(() => validateManifest(null)).toThrow(SchemaValidationError);
  });
});

// ============================================================
// validateRuntimeLock
// ============================================================

describe('validateRuntimeLock', () => {
  const validLock = {
    runtime_version: '1.0.0',
    domain_schema_version: 1,
    risk_policy_version: 2,
    capability_policy_version: 1,
    host_adapter: 'node-adapter',
    extension_package: '@proofloop/pi-extension',
    extension_version: '0.1.0',
  };

  it('returns canonical RuntimeLock on valid input', () => {
    const result = validateRuntimeLock(validLock);
    expect(result).toBeDefined();
    expect(result.runtime_version).toBe('1.0.0');
    expect(result.host_adapter).toBe('node-adapter');
  });

  it('throws SchemaValidationError on missing field', () => {
    expect(() =>
      validateRuntimeLock({ runtime_version: '1.0.0' }),
    ).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on non-object input', () => {
    expect(() => validateRuntimeLock('bad')).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on wrong type for runtime_version', () => {
    expect(() =>
      validateRuntimeLock({ ...validLock, runtime_version: 123 }),
    ).toThrow(SchemaValidationError);
  });
});

// ============================================================
// validateFinding
// ============================================================

describe('validateFinding', () => {
  const validFinding = {
    code: 'HOST.PROJECT_NOT_TRUSTED',
    severity: 'error',
    message: 'Project is not trusted.',
  };

  it('returns canonical Finding on valid input', () => {
    const result = validateFinding(validFinding);
    expect(result).toBeDefined();
    expect(result.code).toBe('HOST.PROJECT_NOT_TRUSTED');
    expect(result.severity).toBe('error');
  });

  it('accepts warn severity', () => {
    const result = validateFinding({
      code: 'RUNTIME.VERSION_MISMATCH',
      severity: 'warn',
      message: 'Warning',
    });
    expect(result.severity).toBe('warn');
  });

  it('accepts all 9 canonical Finding codes', () => {
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
    ] as const;
    for (const code of codes) {
      const result = validateFinding({ code, severity: 'error', message: 'Test' });
      expect(result.code).toBe(code);
    }
  });

  it('throws SchemaValidationError on invalid code', () => {
    expect(() =>
      validateFinding({ code: 'INVALID.CODE', severity: 'error', message: 'x' }),
    ).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on invalid severity', () => {
    expect(() =>
      validateFinding({ ...validFinding, severity: 'critical' }),
    ).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on missing message', () => {
    expect(() =>
      validateFinding({ code: 'HOST.PATH_PROTECTED', severity: 'error' }),
    ).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError on non-object input', () => {
    expect(() => validateFinding(123)).toThrow(SchemaValidationError);
  });
});

// ============================================================
// Semantic timestamp validation (Fix 1)
// ============================================================

describe('validateReceipt — semantic timestamp validation', () => {
  const base = {
    version: 1,
    type: 'TASK_COMPLETE' as const,
    stage_id: 'S01',
    timestamp: '2025-01-01T00:00:00.000Z',
    digest: 'abc',
    payload: {},
  };

  it('rejects Feb 29 in non-leap year (2023)', () => {
    expect(() =>
      validateReceipt({ ...base, timestamp: '2023-02-29T00:00:00.000Z' }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects Feb 30', () => {
    expect(() =>
      validateReceipt({ ...base, timestamp: '2025-02-30T00:00:00.000Z' }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects Apr 31', () => {
    expect(() =>
      validateReceipt({ ...base, timestamp: '2025-04-31T00:00:00.000Z' }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects month 13', () => {
    expect(() =>
      validateReceipt({ ...base, timestamp: '2025-13-01T00:00:00.000Z' }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects hour 24', () => {
    expect(() =>
      validateReceipt({ ...base, timestamp: '2025-01-01T24:00:00.000Z' }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects minute 60', () => {
    expect(() =>
      validateReceipt({ ...base, timestamp: '2025-01-01T00:60:00.000Z' }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects second 60', () => {
    expect(() =>
      validateReceipt({ ...base, timestamp: '2025-01-01T00:00:60.000Z' }),
    ).toThrow(SchemaValidationError);
  });

  it('accepts Feb 29 in leap year (2024)', () => {
    const result = validateReceipt({
      ...base,
      timestamp: '2024-02-29T12:30:00.000Z',
    });
    expect(result.timestamp).toBe('2024-02-29T12:30:00.000Z');
  });

  it('rejects zero-padded month with extra digit', () => {
    expect(() =>
      validateReceipt({ ...base, timestamp: '2025-001-01T00:00:00.000Z' }),
    ).toThrow(SchemaValidationError);
  });
});

// ============================================================
// Runtime proof step constraining (Fix 2)
// ============================================================

describe('validateManifest — runtime proof step type constraining', () => {
  const makeSlice = (sliceId: string, goal: string) => ({
    slice_id: sliceId,
    goal,
    observable_outcome: `${goal} outcome`,
    public_seam: 'Public API',
    dependencies: [] as string[],
    proof_obligations: [] as Array<Record<string, unknown>>,
    tasks: [`${sliceId}-T01`],
    risk_facts: [] as string[],
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

  it('accepts type: command', () => {
    const result = validateManifest({
      ...baseManifest,
      runtime_proof: [{ ...validProofStep, type: 'command' }],
    });
    expect(result.runtime_proof![0].type).toBe('command');
  });

  it('accepts type: service_start', () => {
    const result = validateManifest({
      ...baseManifest,
      runtime_proof: [{ ...validProofStep, type: 'service_start', readiness_signal: 'ready' }],
    });
    expect(result.runtime_proof![0].type).toBe('service_start');
  });

  it('accepts type: service_stop', () => {
    const result = validateManifest({
      ...baseManifest,
      runtime_proof: [{ ...validProofStep, type: 'service_stop', service_ref: 'app' }],
    });
    expect(result.runtime_proof![0].type).toBe('service_stop');
  });

  it('accepts type: probe', () => {
    const result = validateManifest({
      ...baseManifest,
      runtime_proof: [{ ...validProofStep, type: 'probe' }],
    });
    expect(result.runtime_proof![0].type).toBe('probe');
  });

  it('rejects invalid runtime proof step type', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{ ...validProofStep, type: 'invalid_type' }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects runtime proof step type as number', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{ ...validProofStep, type: 123 }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects non-positive timeout_ms (zero)', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{ ...validProofStep, timeout_ms: 0 }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects non-positive timeout_ms (negative)', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{ ...validProofStep, timeout_ms: -100 }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects timeout_ms as floating point', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{ ...validProofStep, timeout_ms: 300.5 }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects timeout_ms as string', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{ ...validProofStep, timeout_ms: '300000' }],
      }),
    ).toThrow(SchemaValidationError);
  });
});

// ============================================================
// Runtime proof step — nested field validation (Fix 2/3)
// ============================================================

describe('validateManifest — runtime proof step nested field validation', () => {
  const makeSlice = (sliceId: string, goal: string) => ({
    slice_id: sliceId,
    goal,
    observable_outcome: `${goal} outcome`,
    public_seam: 'Public API',
    dependencies: [] as string[],
    proof_obligations: [] as Array<Record<string, unknown>>,
    tasks: [`${sliceId}-T01`],
    risk_facts: [] as string[],
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

  it('accepts expected.exit_code as number (0)', () => {
    const result = validateManifest({
      ...baseManifest,
      runtime_proof: [{
        ...validProofStep,
        expected: { exit_code: 0 },
      }],
    });
    expect(result.runtime_proof![0].expected).toEqual({ exit_code: 0 });
  });

  it('rejects expected.exit_code as string', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{
          ...validProofStep,
          expected: { exit_code: '0' },
        }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects expected.exit_code as boolean', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{
          ...validProofStep,
          expected: { exit_code: true },
        }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('accepts expected.exit_code as null', () => {
    const result = validateManifest({
      ...baseManifest,
      runtime_proof: [{
        ...validProofStep,
        expected: { exit_code: null },
      }],
    });
    expect(result.runtime_proof![0].expected).toEqual({ exit_code: null });
  });

  it('accepts not_applicable.reason as string', () => {
    const result = validateManifest({
      ...baseManifest,
      runtime_proof: [{
        ...validProofStep,
        not_applicable: { reason: 'Not applicable in this context.' },
      }],
    });
    expect(result.runtime_proof![0].not_applicable).toEqual({ reason: 'Not applicable in this context.' });
  });

  it('rejects not_applicable.reason as number', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{
          ...validProofStep,
          not_applicable: { reason: 42 },
        }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects not_applicable.reason as empty string', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{
          ...validProofStep,
          not_applicable: { reason: '' },
        }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects runtime_proof step with args containing non-string element', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{
          ...validProofStep,
          args: ['run', 123],
        }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects runtime_proof step missing required id field', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{
          type: 'command',
          executable: 'npm',
          args: ['build'],
          cwd: '.',
          timeout_ms: 300000,
        }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects runtime_proof step with expected as non-object (string)', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{
          ...validProofStep,
          expected: 'not-an-object',
        }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects runtime_proof step with not_applicable as non-object (number)', () => {
    expect(() =>
      validateManifest({
        ...baseManifest,
        runtime_proof: [{
          ...validProofStep,
          not_applicable: 42,
        }],
      }),
    ).toThrow(SchemaValidationError);
  });
});

// ============================================================
// cv_minimum_level literal constraining (Fix 2)
// ============================================================

describe('validateManifest — cv_minimum_level constraining', () => {
  const makeSlice = (level: string) => ({
    slice_id: 'S01-A',
    goal: 'Goal',
    observable_outcome: 'Outcome',
    public_seam: 'Public API',
    dependencies: [] as string[],
    proof_obligations: [] as Array<Record<string, unknown>>,
    tasks: ['S01-A-T01'],
    risk_facts: [] as string[],
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

  it('accepts cv_minimum_level: lite', () => {
    const result = validateManifest({ ...baseManifest, slices: [makeSlice('lite')] });
    expect(result.slices[0].cv_minimum_level).toBe('lite');
  });

  it('accepts cv_minimum_level: standard', () => {
    const result = validateManifest({ ...baseManifest, slices: [makeSlice('standard')] });
    expect(result.slices[0].cv_minimum_level).toBe('standard');
  });

  it('accepts cv_minimum_level: enhanced', () => {
    const result = validateManifest({ ...baseManifest, slices: [makeSlice('enhanced')] });
    expect(result.slices[0].cv_minimum_level).toBe('enhanced');
  });

  it('rejects invalid cv_minimum_level', () => {
    expect(() =>
      validateManifest({ ...baseManifest, slices: [makeSlice('super')] }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects cv_minimum_level as number', () => {
    expect(() =>
      validateManifest({ ...baseManifest, slices: [{
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
      }] }),
    ).toThrow(SchemaValidationError);
  });

  it('rejects cv_minimum_level as empty string', () => {
    expect(() =>
      validateManifest({ ...baseManifest, slices: [makeSlice('')] }),
    ).toThrow(SchemaValidationError);
  });
});

// ============================================================
// Fail-closed — all invalid inputs throw (not return false)
// ============================================================

describe('fail-closed behavior', () => {
  it('validateReceipt throws on null/undefined', () => {
    expect(() => validateReceipt(null)).toThrow(SchemaValidationError);
    expect(() => validateReceipt(undefined)).toThrow(SchemaValidationError);
  });

  it('validateManifest throws on null', () => {
    expect(() => validateManifest(null)).toThrow(SchemaValidationError);
  });

  it('validateRuntimeLock throws on null', () => {
    expect(() => validateRuntimeLock(null)).toThrow(SchemaValidationError);
  });

  it('validateFinding throws on null', () => {
    expect(() => validateFinding(null)).toThrow(SchemaValidationError);
  });

  it('all functions produce fieldErrors with path details', () => {
    const inputs: Array<{ name: string; fn: (d: unknown) => unknown; data: unknown }> = [
      { name: 'Receipt', fn: validateReceipt, data: { version: 99 } },
      { name: 'Manifest', fn: validateManifest, data: {} },
      { name: 'RuntimeLock', fn: validateRuntimeLock, data: { runtime_version: 123 } },
      { name: 'Finding', fn: validateFinding, data: { code: 'BAD.CODE', severity: 'error', message: 'x' } },
    ];
    for (const { name, fn, data } of inputs) {
      try {
        fn(data);
        expect.unreachable(`${name} should have thrown`);
      } catch (e) {
        const err = e as SchemaValidationError;
        expect(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
        expect(err.fieldErrors.length).toBeGreaterThan(0);
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
//   - All 12 legacy pre-project-E2E Receipt types (old-12 regression fixture)
//     and all 9 Finding codes in round-trip
// ============================================================

// -----------------------------------------------------------------
// 1. Comprehensive VALID fixtures
// -----------------------------------------------------------------

describe('comprehensive valid fixtures', () => {
  // Each contract type gets at least 2 independent valid fixtures
  // with varied values to prove validation isn't hardcoded to one
  // specific shape.

  describe('Receipt — valid variants', () => {
    const validVariants = [
      // Minimal receipt (only required fields + optional omitted)
      {
        version: 1,
        type: 'SLICE_PLAN' as const,
        stage_id: 'S02',
        timestamp: '2025-06-15T10:30:00.000Z',
        digest: 'a1b2c3d4e5f6',
        payload: {},
      },
      // Full receipt with all optionals
      {
        version: 1,
        type: 'STAGE_PLAN' as const,
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
        type: 'GATE_FAIL' as const,
        stage_id: 'S99',
        timestamp: '2024-12-31T23:59:59.999Z',
        digest: '000000000000',
        payload: { reason: 'gate failure' },
      },
    ];

    for (let i = 0; i < validVariants.length; i++) {
      it(`passes variant ${i + 1} (type: ${validVariants[i].type})`, () => {
        const result = validateReceipt(validVariants[i]);
        expect(result).toBeDefined();
        expect(result.version).toBe(1);
        expect(result.type).toBe(validVariants[i].type);
      });
    }
  });

  describe('Manifest — valid variants', () => {
    const makeSlice = (sliceId: string, goal: string) => ({
      slice_id: sliceId,
      goal,
      observable_outcome: `${goal} outcome`,
      public_seam: 'Public API',
      dependencies: [] as string[],
      proof_obligations: [] as Array<Record<string, unknown>>,
      tasks: [`${sliceId}-T01`],
      risk_facts: [] as string[],
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
      it(`passes variant ${i + 1} (stage: ${validVariants[i].stage_id})`, () => {
        const result = validateManifest(validVariants[i]);
        expect(result).toBeDefined();
        expect(result.stage_id).toBe(validVariants[i].stage_id);
      });
    }
  });

  describe('RuntimeLock — valid variants', () => {
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
      it(`passes variant ${i + 1} (runtime: ${validVariants[i].runtime_version})`, () => {
        const result = validateRuntimeLock(validVariants[i]);
        expect(result).toBeDefined();
        expect(result.runtime_version).toBe(validVariants[i].runtime_version);
      });
    }
  });

  describe('Finding — valid variants', () => {
    const validVariants = [
      { code: 'HOST.PATH_PROTECTED' as const, severity: 'error' as const, message: 'Path is protected by policy.' },
      { code: 'HOST.TOOL_NOT_ACTIVE' as const, severity: 'warn' as const, message: 'Tool is not active' },
      { code: 'RUNTIME.RECEIPT_CHAIN_BROKEN' as const, severity: 'error' as const, message: 'Receipt chain verification failed' },
      { code: 'DOMAIN.STAGE_NOT_FOUND' as const, severity: 'warn' as const, message: 'Stage not found in registry' },
      { code: 'DOMAIN.INVALID_TRANSITION' as const, severity: 'error' as const, message: 'Invalid state transition attempted' },
    ];

    for (let i = 0; i < validVariants.length; i++) {
      it(`passes variant ${i + 1} (code: ${validVariants[i].code})`, () => {
        const result = validateFinding(validVariants[i]);
        expect(result).toBeDefined();
        expect(result.code).toBe(validVariants[i].code);
        expect(result.severity).toBe(validVariants[i].severity);
      });
    }
  });
});

// -----------------------------------------------------------------
// 2. Comprehensive INVALID fixtures
// -----------------------------------------------------------------

describe('comprehensive invalid fixtures', () => {
  // --- Receipt invalid ---
  describe('Receipt — missing each required field', () => {
    const base = {
      version: 1,
      type: 'TASK_COMPLETE' as const,
      stage_id: 'S01',
      timestamp: '2025-01-01T00:00:00.000Z',
      digest: 'abc',
      payload: {},
    };

    const requiredFields = ['version', 'type', 'stage_id', 'timestamp', 'digest', 'payload'] as const;
    for (const field of requiredFields) {
      it(`throws when required field "${field}" is missing`, () => {
        const { [field]: _, ...rest } = base;
        expect(() => validateReceipt(rest)).toThrow(SchemaValidationError);
      });
    }

    it('throws when payload is not an object', () => {
      expect(() => validateReceipt({ ...base, payload: 'not-an-object' })).toThrow(SchemaValidationError);
    });

    it('throws when type is empty string', () => {
      expect(() => validateReceipt({ ...base, type: '' })).toThrow(SchemaValidationError);
    });

    it('throws when stage_id is empty string', () => {
      expect(() => validateReceipt({ ...base, stage_id: '' })).toThrow(SchemaValidationError);
    });

    it('throws when timestamp is empty string', () => {
      expect(() => validateReceipt({ ...base, timestamp: '' })).toThrow(SchemaValidationError);
    });

    it('throws when digest is empty string', () => {
      expect(() => validateReceipt({ ...base, digest: '' })).toThrow(SchemaValidationError);
    });

    it('throws when type is wrong type (number)', () => {
      expect(() => validateReceipt({ ...base, type: 123 })).toThrow(SchemaValidationError);
    });

    it('throws when version is wrong type (string)', () => {
      expect(() => validateReceipt({ ...base, version: '1' })).toThrow(SchemaValidationError);
    });

    it('throws when stage_id is wrong type (null)', () => {
      expect(() => validateReceipt({ ...base, stage_id: null })).toThrow(SchemaValidationError);
    });
  });

  describe('Receipt — invalid enum literals', () => {
    const base = {
      version: 1,
      type: 'TASK_COMPLETE' as const,
      stage_id: 'S01',
      timestamp: '2025-01-01T00:00:00.000Z',
      digest: 'abc',
      payload: {},
    };

    it('throws for made-up receipt type', () => {
      expect(() => validateReceipt({ ...base, type: 'SPACE_LAUNCH' })).toThrow(SchemaValidationError);
    });

    it('throws for lowercase receipt type', () => {
      expect(() => validateReceipt({ ...base, type: 'cv_pass' })).toThrow(SchemaValidationError);
    });

    it('throws for numeric version !== 1 (version 0)', () => {
      expect(() => validateReceipt({ ...base, version: 0 })).toThrow(SchemaValidationError);
    });

    it('throws for negative version', () => {
      expect(() => validateReceipt({ ...base, version: -1 })).toThrow(SchemaValidationError);
    });
  });

  // --- Manifest invalid ---
  describe('Manifest — missing each required field', () => {
    const makeSlice = (sliceId: string, goal: string) => ({
      slice_id: sliceId,
      goal,
      observable_outcome: `${goal} outcome`,
      public_seam: 'Public API',
      dependencies: [] as string[],
      proof_obligations: [] as Array<Record<string, unknown>>,
      tasks: [`${sliceId}-T01`],
      risk_facts: [] as string[],
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

    const requiredFields = ['stage_id', 'source_path', 'source_digest', 'stage_goal', 'slices', 'dependencies', 'risk_facts'] as const;
    for (const field of requiredFields) {
      it(`throws when required field "${field}" is missing`, () => {
        const { [field]: _, ...rest } = base;
        expect(() => validateManifest(rest)).toThrow(SchemaValidationError);
      });
    }

    it('throws when stage_id is empty string', () => {
      expect(() => validateManifest({ ...base, stage_id: '' })).toThrow(SchemaValidationError);
    });

    it('throws when source_path is wrong type (number)', () => {
      expect(() => validateManifest({ ...base, source_path: 42 })).toThrow(SchemaValidationError);
    });

    it('throws when slices is not an array', () => {
      expect(() => validateManifest({ ...base, slices: 'not-array' })).toThrow(SchemaValidationError);
    });

    it('throws when a slice entry is missing slice_id', () => {
      expect(() => validateManifest({
        ...base,
        slices: [{ goal: 'No-slice-id' }],
      })).toThrow(SchemaValidationError);
    });

    it('throws when a slice entry has empty slice_id', () => {
      expect(() => validateManifest({
        ...base,
        slices: [{ slice_id: '', goal: 'Empty-slice-id' }],
      })).toThrow(SchemaValidationError);
    });

    it('throws when a slice entry is missing observable_outcome', () => {
      expect(() => validateManifest({
        ...base,
        slices: [{ slice_id: 'S01-A', goal: 'Goal' }],
      })).toThrow(SchemaValidationError);
    });

    it('throws when a slice entry has wrong type for dependencies', () => {
      expect(() => validateManifest({
        ...base,
        slices: [{
          ...makeSlice('S01-A', 'Goal'),
          dependencies: 'not-an-array',
        }],
      })).toThrow(SchemaValidationError);
    });

    it('throws when runtime_proof entry is missing required field', () => {
      expect(() => validateManifest({
        ...base,
        runtime_proof: [{ incomplete: true }],
      })).toThrow(SchemaValidationError);
    });
  });

  // --- RuntimeLock invalid ---
  describe('RuntimeLock — missing each required field', () => {
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
    ] as const;

    for (const field of requiredFields) {
      it(`throws when required field "${field}" is missing`, () => {
        const { [field]: _, ...rest } = base;
        expect(() => validateRuntimeLock(rest)).toThrow(SchemaValidationError);
      });
    }

    it('throws when runtime_version is empty string', () => {
      expect(() => validateRuntimeLock({ ...base, runtime_version: '' })).toThrow(SchemaValidationError);
    });

    it('throws when domain_schema_version is a string (must be number)', () => {
      expect(() => validateRuntimeLock({ ...base, domain_schema_version: '1' })).toThrow(SchemaValidationError);
    });

    it('throws when risk_policy_version is a string (must be number)', () => {
      expect(() => validateRuntimeLock({ ...base, risk_policy_version: '2' })).toThrow(SchemaValidationError);
    });

    it('throws when host_adapter is wrong type (boolean)', () => {
      expect(() => validateRuntimeLock({ ...base, host_adapter: true })).toThrow(SchemaValidationError);
    });

    it('throws when extension_package is wrong type (object)', () => {
      expect(() => validateRuntimeLock({ ...base, extension_package: {} })).toThrow(SchemaValidationError);
    });

    it('throws when domain_schema_version is wrong type (string)', () => {
      expect(() => validateRuntimeLock({ ...base, domain_schema_version: '1' })).toThrow(SchemaValidationError);
    });
  });

  // --- Finding invalid ---
  describe('Finding — missing each required field', () => {
    const base = {
      code: 'HOST.PROJECT_NOT_TRUSTED' as const,
      severity: 'error' as const,
      message: 'Some message',
    };

    const requiredFields = ['code', 'severity', 'message'] as const;
    for (const field of requiredFields) {
      it(`throws when required field "${field}" is missing`, () => {
        const { [field]: _, ...rest } = base;
        expect(() => validateFinding(rest)).toThrow(SchemaValidationError);
      });
    }

    it('throws when code is empty string', () => {
      expect(() => validateFinding({ ...base, code: '' })).toThrow(SchemaValidationError);
    });

    it('throws when message is empty string', () => {
      expect(() => validateFinding({ ...base, message: '' })).toThrow(SchemaValidationError);
    });

    it('throws for non-canonical code format', () => {
      expect(() => validateFinding({ ...base, code: 'HOST.NONEXISTENT' })).toThrow(SchemaValidationError);
    });

    it('throws when severity is invalid string', () => {
      expect(() => validateFinding({ ...base, severity: 'critical' })).toThrow(SchemaValidationError);
    });

    it('throws when severity is wrong type (number)', () => {
      expect(() => validateFinding({ ...base, severity: 1 })).toThrow(SchemaValidationError);
    });

    it('throws when code is wrong type (number)', () => {
      expect(() => validateFinding({ ...base, code: 999 })).toThrow(SchemaValidationError);
    });

    it('throws when message is wrong type (array)', () => {
      expect(() => validateFinding({ ...base, message: ['details'] })).toThrow(SchemaValidationError);
    });
  });

  // --- Empty/null/undefined inputs for all 4 ---
  describe('empty/null/undefined inputs for all types', () => {
    const inputs: Array<{ name: string; fn: (d: unknown) => unknown }> = [
      { name: 'Receipt', fn: validateReceipt },
      { name: 'Manifest', fn: validateManifest },
      { name: 'RuntimeLock', fn: validateRuntimeLock },
      { name: 'Finding', fn: validateFinding },
    ];

    for (const { name, fn } of inputs) {
      it(`${name} throws on null`, () => {
        expect(() => fn(null)).toThrow(SchemaValidationError);
      });

      it(`${name} throws on undefined`, () => {
        expect(() => fn(undefined)).toThrow(SchemaValidationError);
      });

      it(`${name} throws on empty object`, () => {
        expect(() => fn({})).toThrow(SchemaValidationError);
      });

      it(`${name} throws on empty string`, () => {
        expect(() => fn('')).toThrow(SchemaValidationError);
      });

      it(`${name} throws on number`, () => {
        expect(() => fn(42)).toThrow(SchemaValidationError);
      });

      it(`${name} throws on array`, () => {
        expect(() => fn([])).toThrow(SchemaValidationError);
      });

      it(`${name} throws on boolean`, () => {
        expect(() => fn(true)).toThrow(SchemaValidationError);
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

describe('JSON round-trip', () => {
  // Helper: round-trip a value through JSON and validation
  function roundTripReceipt(input: Record<string, unknown>) {
    const json = JSON.stringify(input);
    const parsed = JSON.parse(json);
    return validateReceipt(parsed);
  }

  function roundTripManifest(input: Record<string, unknown>) {
    const json = JSON.stringify(input);
    const parsed = JSON.parse(json);
    return validateManifest(parsed);
  }

  function roundTripRuntimeLock(input: Record<string, unknown>) {
    const json = JSON.stringify(input);
    const parsed = JSON.parse(json);
    return validateRuntimeLock(parsed);
  }

  function roundTripFinding(input: Record<string, unknown>) {
    const json = JSON.stringify(input);
    const parsed = JSON.parse(json);
    return validateFinding(parsed);
  }

  describe('Receipt round-trip', () => {
    it('round-trips a minimal receipt with deep equality', () => {
      const input = {
        version: 1,
        type: 'SLICE_PLAN',
        stage_id: 'S01-A',
        timestamp: '2025-01-15T10:00:00.000Z',
        digest: 'abc123',
        payload: {},
      };
      const result = roundTripReceipt(input);
      expect(result).toEqual(input);
    });

    it('round-trips a full receipt with all optional fields', () => {
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
      expect(result).toEqual(input);
    });

    // Legacy pre-project-E2E regression fixture: the 12 pre-gate receipt
    // types. The canonical set is now 16 (incl. GATE_INTERRUPTED and
    // PROJECT_E2E_*); the dedicated `RECEIPT_TYPES_16` block covers the full
    // set. Kept intentionally as the old-12 regression.
    it('round-trips the 12 legacy pre-project-E2E receipt types (old-12 regression fixture)', () => {
      const types = [
        'SLICE_PLAN', 'STAGE_PLAN', 'SPV_PASS', 'TASK_COMPLETE',
        'CV_PASS', 'CV_REPAIR', 'SLICE_COMMIT', 'INTEGRATION_PASS',
        'GATE_PASS', 'GATE_FAIL', 'STAGE_REVIEW_PASS', 'PROJECT_REVIEW_PASS',
      ] as const;

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
        expect(result).toEqual(input);
      }
    });
  });

  describe('Manifest round-trip', () => {
    const makeSlice = (sliceId: string, goal: string) => ({
      slice_id: sliceId,
      goal,
      observable_outcome: `${goal} outcome`,
      public_seam: 'Public API',
      dependencies: [] as string[],
      proof_obligations: [] as Array<Record<string, unknown>>,
      tasks: [`${sliceId}-T01`],
      risk_facts: [] as string[],
      evidence_path: `stages/S01/evidence/${sliceId}.md`,
      cv_minimum_level: 'enhanced',
    });

    it('round-trips a manifest with multiple slices', () => {
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
      expect(result).toEqual(input);
    });

    it('round-trips a manifest with empty arrays', () => {
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
      expect(result).toEqual(input);
    });
  });

  describe('RuntimeLock round-trip', () => {
    it('round-trips a standard runtime lock', () => {
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
      expect(result).toEqual(input);
    });

    it('round-trips with numeric version fields', () => {
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
      expect(result).toEqual(input);
    });
  });

  describe('Finding round-trip', () => {
    it('round-trips an error finding', () => {
      const input = {
        code: 'HOST.PROJECT_NOT_TRUSTED',
        severity: 'error',
        message: 'Project is not in trust store.',
      };
      const result = roundTripFinding(input);
      expect(result).toEqual(input);
    });

    it('round-trips a warn finding', () => {
      const input = {
        code: 'RUNTIME.VERSION_MISMATCH',
        severity: 'warn',
        message: 'Runtime version differs from expected.',
      };
      const result = roundTripFinding(input);
      expect(result).toEqual(input);
    });

    it('round-trips all 9 Finding codes', () => {
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
      ] as const;

      for (const code of codes) {
        const input = {
          code,
          severity: 'warn' as const,
          message: `Finding: ${code}`,
        };
        const result = roundTripFinding(input);
        expect(result).toEqual(input);
      }
    });

    it('round-trips preserves severity:error for all 9 codes', () => {
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
      ] as const;

      for (const code of codes) {
        const input = {
          code,
          severity: 'error' as const,
          message: `Error: ${code}`,
        };
        const result = roundTripFinding(input);
        expect(result).toEqual(input);
      }
    });
  });
});

// ============================================================
// GATE_INTERRUPTED — additive 11th receipt type (PO-S05-A-06, HP-004/AWI-015)
//
// S05-A-T05: the kernel contract adds exactly ONE additive ReceiptType,
// `GATE_INTERRUPTED`. The validator closed set accepts it; the existing 10
// pre-gate types keep identical validation / chain / digest behavior (the
// untouched 12-type pre-project-E2E fixtures above remain the regression).
// ============================================================

describe('GATE_INTERRUPTED — additive 11th receipt type (PO-S05-A-06)', () => {
  /** Closed 13-type pre-project-E2E set — current canonical set is 16 types. */
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
  ] as const;

  const base = {
    version: 1 as const,
    stage_id: 'S05',
    timestamp: '2025-08-01T00:00:00.000Z',
    digest: 'gate-interrupted-digest',
    payload: {},
  };

  it('accepts the exact 13-type pre-project-E2E set (12 existing + GATE_INTERRUPTED)', () => {
    expect(RECEIPT_TYPES_13).toHaveLength(13);
    expect(new Set(RECEIPT_TYPES_13).size).toBe(13); // no alias / duplicate
    for (const type of RECEIPT_TYPES_13) {
      const result = validateReceipt({ ...base, type });
      expect(result.type).toBe(type);
    }
  });

  it('accepts a GATE_INTERRUPTED receipt carrying the canonical interruption payload (reason + duration_ms)', () => {
    const cancelled = validateReceipt({
      ...base,
      type: 'GATE_INTERRUPTED',
      payload: { reason: 'cancelled', duration_ms: 12000 },
    });
    expect(cancelled.type).toBe('GATE_INTERRUPTED');
    expect(cancelled.payload).toEqual({ reason: 'cancelled', duration_ms: 12000 });

    const timeout = validateReceipt({
      ...base,
      type: 'GATE_INTERRUPTED',
      payload: { reason: 'timeout', duration_ms: 300000 },
    });
    expect(timeout.type).toBe('GATE_INTERRUPTED');
    expect(timeout.payload).toEqual({ reason: 'timeout', duration_ms: 300000 });
  });

  it('old-12 regression: every pre-S05 receipt type validates byte-identically (round-trip)', () => {
    const old12 = RECEIPT_TYPES_13.filter((t) => t !== 'GATE_INTERRUPTED');
    expect(old12).toHaveLength(12);
    for (const type of old12) {
      const input = {
        version: 1 as const,
        type,
        stage_id: 'S01',
        timestamp: '2025-01-01T00:00:00.000Z',
        digest: `digest-for-${type}`,
        payload: {},
      };
      const json = JSON.stringify(input);
      const result = validateReceipt(JSON.parse(json));
      expect(result).toEqual(input);
    }
  });

  it('rejects unknown aliases / misspelled interruption types (fail closed, no silent widening)', () => {
    expect(() =>
      validateReceipt({ ...base, type: 'GATE_INTERRUPT' }),
    ).toThrow(SchemaValidationError);
    expect(() =>
      validateReceipt({ ...base, type: 'GATE_CANCELLED' }),
    ).toThrow(SchemaValidationError);
    expect(() =>
      validateReceipt({ ...base, type: 'GATE_ABORTED' }),
    ).toThrow(SchemaValidationError);
  });
});

// ============================================================
// PROJECT_E2E_PASS / PROJECT_E2E_FAIL / PROJECT_E2E_BLOCKED — additive
// 14th–16th receipt types (B1c, blueprint §6.4 `run_e2e`)
//
// B1c-A-T0X: the kernel contract adds exactly THREE additive ReceiptTypes for
// the project-level E2E gate verdict (style aligned with
// GATE_PASS/GATE_FAIL/GATE_INTERRUPTED). The validator closed set accepts
// them; the existing 13 types keep identical validation / chain / digest
// behavior (the untouched fixtures above remain the old-13 regression).
// Semantics: PROJECT_E2E_* are EVIDENCE-only receipts in the `project/`
// category — they are consumed by finalize-project-review and never
// participate in project_state derivation (only PROJECT_REVIEW_PASS triggers
// COMPLETED; a FAILED E2E run can never prematurely complete the project).
// ============================================================

describe('PROJECT_E2E_* — additive project-level E2E gate receipt types (B1c)', () => {
  /** Closed 16-type set — the canonical §4 receipt enumeration after B1c. */
  const RECEIPT_TYPES_16 = [
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
    'PROJECT_E2E_PASS',
    'PROJECT_E2E_FAIL',
    'PROJECT_E2E_BLOCKED',
  ] as const;

  const base = {
    version: 1 as const,
    stage_id: 'project-x',
    timestamp: '2026-08-01T00:00:00.000Z',
    digest: 'project-e2e-digest',
    payload: {},
  };

  it('accepts the exact 16-type closed set (13 existing + PROJECT_E2E_*)', () => {
    expect(RECEIPT_TYPES_16).toHaveLength(16);
    expect(new Set(RECEIPT_TYPES_16).size).toBe(16); // no alias / duplicate
    for (const type of RECEIPT_TYPES_16) {
      const result = validateReceipt({ ...base, type });
      expect(result.type).toBe(type);
    }
  });

  it('accepts a PROJECT_E2E_PASS receipt carrying the canonical E2E payload (project_id + verdict + per-step results + service_cleanup)', () => {
    const pass = validateReceipt({
      ...base,
      type: 'PROJECT_E2E_PASS',
      payload: {
        project_id: 'project-x',
        verdict: 'PASS',
        snapshot: 'a1b2c3d4e5f6a7b8',
        manifest_digest: 'a1b2c3d4e5f6a7b8',
        expected_snapshot: 'a1b2c3d4e5f6a7b8',
        executed_snapshot: 'a1b2c3d4e5f6a7b8',
        steps: [{ step_id: 'smoke-1', exit_code: 0 }],
        service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
        created_at: '2026-08-01T00:00:00.000Z',
      },
    });
    expect(pass.type).toBe('PROJECT_E2E_PASS');
    expect(pass.payload.project_id).toBe('project-x');
    expect(pass.payload.verdict).toBe('PASS');

    const fail = validateReceipt({
      ...base,
      type: 'PROJECT_E2E_FAIL',
      payload: { project_id: 'project-x', verdict: 'FAIL' },
    });
    expect(fail.type).toBe('PROJECT_E2E_FAIL');
    expect(fail.payload.verdict).toBe('FAIL');

    const blocked = validateReceipt({
      ...base,
      type: 'PROJECT_E2E_BLOCKED',
      payload: { project_id: 'project-x', verdict: 'BLOCKED' },
    });
    expect(blocked.type).toBe('PROJECT_E2E_BLOCKED');
    expect(blocked.payload.verdict).toBe('BLOCKED');
  });

  it('old-13 regression: every pre-B1c receipt type validates byte-identically (round-trip)', () => {
    const old13 = RECEIPT_TYPES_16.filter((t) => !t.startsWith('PROJECT_E2E_'));
    expect(old13).toHaveLength(13);
    for (const type of old13) {
      const input = {
        version: 1 as const,
        type,
        stage_id: 'S01',
        timestamp: '2025-01-01T00:00:00.000Z',
        digest: `digest-for-${type}`,
        payload: {},
      };
      const json = JSON.stringify(input);
      const result = validateReceipt(JSON.parse(json));
      expect(result).toEqual(input);
    }
  });

  it('rejects a misspelled project E2E type (fail closed, no silent widening)', () => {
    expect(() =>
      validateReceipt({ ...base, type: 'PROJECT_E2E' }),
    ).toThrow(SchemaValidationError);
    expect(() =>
      validateReceipt({ ...base, type: 'PROJECT_E2E_PASSED' }),
    ).toThrow(SchemaValidationError);
    expect(() =>
      validateReceipt({ ...base, type: 'PROJECT_E2E_RUN' }),
    ).toThrow(SchemaValidationError);
  });
});

// ============================================================
// S09-C-T01 — canonical executable Runtime Proof step schema
// ============================================================

describe('validateRuntimeProofStep — canonical executable Runtime Proof step schema (S09-C-T01)', () => {
  const executableStep: Record<string, unknown> = {
    id: 'build',
    type: 'command',
    executable: 'npm',
    args: ['run', 'build'],
    cwd: '.',
    timeout_ms: 300000,
    expected: { exit_code: 0 },
  };

  it('accepts each canonical executable step type (command/service_start/service_stop/probe)', () => {
    for (const type of ['command', 'service_start', 'service_stop', 'probe']) {
      const result = validateRuntimeProofStep({ ...executableStep, type });
      expect(result).toMatchObject({ type });
    }
  });

  it('accepts service_start with readiness_signal and service_stop with service_ref', () => {
    const start = validateRuntimeProofStep({
      ...executableStep,
      type: 'service_start',
      readiness_signal: 'ready',
    });
    expect(start).toMatchObject({ type: 'service_start' });
    const stop = validateRuntimeProofStep({
      ...executableStep,
      type: 'service_stop',
      service_ref: 'app-start',
    });
    expect(stop).toMatchObject({ type: 'service_stop' });
  });

  it('accepts a not_applicable-only step', () => {
    const result = validateRuntimeProofStep({
      not_applicable: { reason: 'skipped in this context' },
    });
    expect(result).toEqual({ not_applicable: { reason: 'skipped in this context' } });
  });

  it('rejects a step that mixes executable fields with not_applicable', () => {
    expect(() =>
      validateRuntimeProofStep({ ...executableStep, not_applicable: { reason: 'n/a' } }),
    ).toThrow(SourceSchemaValidationError);
  });

  it('rejects a not_applicable step carrying extra fields', () => {
    expect(() =>
      validateRuntimeProofStep({ not_applicable: { reason: 'n/a' }, id: 'x' }),
    ).toThrow(SourceSchemaValidationError);
  });

  it('rejects unknown step types including second-set semantics (service_probe/file_assertion)', () => {
    expect(() => validateRuntimeProofStep({ ...executableStep, type: 'service_probe' })).toThrow(SourceSchemaValidationError);
    expect(() => validateRuntimeProofStep({ ...executableStep, type: 'file_assertion' })).toThrow(SourceSchemaValidationError);
    expect(() => validateRuntimeProofStep({ ...executableStep, type: 'invalid_type' })).toThrow(SourceSchemaValidationError);
    expect(() => validateRuntimeProofStep({ ...executableStep, type: 123 })).toThrow(SourceSchemaValidationError);
  });

  it('rejects an empty or non-string executable', () => {
    expect(() => validateRuntimeProofStep({ ...executableStep, executable: '' })).toThrow(SourceSchemaValidationError);
    expect(() => validateRuntimeProofStep({ ...executableStep, executable: 42 })).toThrow(SourceSchemaValidationError);
  });

  it('rejects non-string args elements', () => {
    expect(() => validateRuntimeProofStep({ ...executableStep, args: ['run', 123] })).toThrow(SourceSchemaValidationError);
    expect(() => validateRuntimeProofStep({ ...executableStep, args: 'run' })).toThrow(SourceSchemaValidationError);
  });

  it('rejects non-positive or non-integer timeout_ms', () => {
    expect(() => validateRuntimeProofStep({ ...executableStep, timeout_ms: 0 })).toThrow(SourceSchemaValidationError);
    expect(() => validateRuntimeProofStep({ ...executableStep, timeout_ms: -100 })).toThrow(SourceSchemaValidationError);
    expect(() => validateRuntimeProofStep({ ...executableStep, timeout_ms: 300.5 })).toThrow(SourceSchemaValidationError);
    expect(() => validateRuntimeProofStep({ ...executableStep, timeout_ms: '300000' })).toThrow(SourceSchemaValidationError);
  });

  it('rejects a step missing any required executable field', () => {
    for (const field of ['id', 'type', 'executable', 'args', 'cwd', 'timeout_ms', 'expected']) {
      const step = { ...executableStep };
      delete step[field];
      expect(() => validateRuntimeProofStep(step)).toThrow(SourceSchemaValidationError);
    }
  });

  it('rejects unknown fields on an executable step', () => {
    expect(() => validateRuntimeProofStep({ ...executableStep, bogus: true })).toThrow(SourceSchemaValidationError);
  });
});

// ============================================================
// S09-C-T03 — shared canonical Stage ID guard (^S\d+$)
// ============================================================

describe('canonical Stage ID guard (S09-C-T03)', () => {
  const LEGACY_LABELS = ['S08B0', 'S08B'];

  it('accepts canonical stage ids matching /^S\\d+$/', () => {
    for (const stageId of ['S1', 'S09', 'S10', 'S0', 'S123']) {
      expect(isCanonicalStageId(stageId)).toBe(true);
      expect(CANONICAL_STAGE_ID_RE.test(stageId)).toBe(true);
    }
  });

  it.each([
    'S08B0',
    'S08B',
    'S08-A',
    's09',
    'S',
    'S9.5',
    'S9_1',
    'S2/../../etc/passwd',
    'S2\\..\\..\\tmp',
    '9S',
    'S 9',
    '',
  ])('rejects non-canonical stage id %j (legacy labels fail closed)', (stageId) => {
    expect(isCanonicalStageId(stageId)).toBe(false);
    expect(CANONICAL_STAGE_ID_RE.test(stageId)).toBe(false);
  });

  it('assertCanonicalStageId returns the value for canonical ids', () => {
    expect(assertCanonicalStageId('S09')).toBe('S09');
  });

  it('assertCanonicalStageId throws SchemaValidationError for legacy S08B0/S08B labels and non-strings', () => {
    for (const legacy of LEGACY_LABELS) {
      expect(() => assertCanonicalStageId(legacy)).toThrow(SourceSchemaValidationError);
      expect(() => assertCanonicalStageId(legacy)).toThrow(/canonical Stage ID/);
    }
    expect(() => assertCanonicalStageId(42)).toThrow(SourceSchemaValidationError);
    expect(() => assertCanonicalStageId(undefined)).toThrow(SourceSchemaValidationError);
  });

  // NOTE: the v1 Receipt/Manifest validators intentionally keep the v1
  // stage_id contract (non-empty string).  The shared canonical Stage ID
  // grammar is enforced at every vNext Runtime boundary (candidate parser,
  // compiler, Mechanical Validator, plan/stage/review status, admission).
});
