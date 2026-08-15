import { describe, expect, it, vi } from 'vitest';
import {
  SchemaValidationError,
  admissionRequestSliceId,
  admissionRequestStageId,
  admitCVResult,
  assertAdmissionRequest,
} from '@proofloop/runtime';
import type { AdmissionDeps, ReceiptWriterPort } from '@proofloop/runtime';

const DIGEST = 'a'.repeat(64);

function cvEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: 'S08',
    slice_id: 'S08-E',
    worker_receipt_digest: DIGEST,
    manifest_digest: 'b'.repeat(64),
    plan_digest: 'c'.repeat(64),
    proof_index_digest: 'd'.repeat(64),
    context_ref: `.proofloop/context/${'e'.repeat(64)}.json`,
    context_digest: 'e'.repeat(64),
    snapshot_digest: 'f'.repeat(40),
    verification_type: 'initial',
    verdict: 'PASS',
    summary: 'vNext CV pass',
    acceptance_refs_checked: ['acceptance-1'],
    seam_refs_checked: ['seam-1'],
    oracle_refs_checked: ['oracle-1'],
    risk_refs_considered: [{
      ref_id: 'risk-1',
      applicability: 'APPLICABLE',
      reason: 'fixture risk is in scope',
    }],
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
    ...overrides,
  };
}

function fakeDeps(): {
  readonly deps: AdmissionDeps;
  readonly writes: number[];
  readonly reconcile: ReturnType<typeof vi.fn>;
} {
  const writes: number[] = [];
  const writer: ReceiptWriterPort = {
    write: () => {
      writes.push(1);
      return { path: '/tmp/receipt.json', digest: DIGEST };
    },
    verifyChain: () => ({ valid: true, receipts: [] }),
  };
  const reconcile = vi.fn(() => {
    throw new Error('legacy reconcile must not run');
  });
  return {
    deps: { projectRoot: process.cwd(), writer, reconcile },
    writes,
    reconcile,
  };
}

describe('vNext CV AdmissionRequest boundary', () => {
  it('keeps cv_result_vnext closed and validates the complete envelope', () => {
    expect(() => assertAdmissionRequest({
      type: 'cv_result_vnext',
      envelope: cvEnvelope(),
    })).not.toThrow();

    expect(() => assertAdmissionRequest({
      type: 'cv_result_vnext',
      envelope: cvEnvelope(),
      verdict: 'PASS',
    })).toThrow(SchemaValidationError);
    expect(() => assertAdmissionRequest({
      type: 'cv_result_vnext',
      envelope: cvEnvelope({ unexpected: true }),
    })).toThrow(SchemaValidationError);
  });

  it('keeps a vNext request out of legacy admitCVResult without a writer call', () => {
    const fixture = fakeDeps();
    const request = {
      type: 'cv_result_vnext',
      envelope: cvEnvelope(),
    };

    const result = admitCVResult(request as never, fixture.deps);

    expect(result).toMatchObject({ accepted: false, receipt_ref: null, new_state: null });
    expect(result.findings[0]).toMatchObject({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
    });
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  it('binds stage/slice of a cv_result_vnext request to the envelope, never to outer scalars', () => {
    const request = {
      type: 'cv_result_vnext' as const,
      envelope: cvEnvelope({ stage_id: 'S08', slice_id: 'S08-E' }),
      stageId: 'OUTER-S08',
      sliceId: 'OUTER-S08-E',
    };

    expect(admissionRequestStageId(request as never)).toBe('S08');
    expect(admissionRequestSliceId(request as never)).toBe('S08-E');
  });

  it('rejects a cv_result_vnext request carrying outer scalar CV fields at the schema boundary', () => {
    expect(() => assertAdmissionRequest({
      type: 'cv_result_vnext',
      envelope: cvEnvelope(),
      verdict: 'PASS',
      snapshot_digest: 'f'.repeat(40),
      summary: 'outer scalar must not enter the vNext request',
    })).toThrow(SchemaValidationError);
    expect(() => assertAdmissionRequest({
      type: 'cv_result_vnext',
      envelope: cvEnvelope(),
      stageId: 'S08',
      sliceId: 'S08-E',
    })).toThrow(SchemaValidationError);
  });
});
