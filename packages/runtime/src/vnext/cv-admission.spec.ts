import { describe, expect, it } from 'vitest';
import { SchemaValidationError } from '@proofloop/kernel';
import {
  validateVNextCvResultEnvelope,
  validateVNextCVResultEnvelope,
} from './index';

const DIGEST = 'a'.repeat(64);
const SNAPSHOT = 'b'.repeat(40);
const CONTEXT_REF = `.proofloop/context/${DIGEST}.json`;

function validResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: 'S08',
    slice_id: 'S08-E',
    worker_receipt_digest: DIGEST,
    manifest_digest: DIGEST,
    plan_digest: DIGEST,
    proof_index_digest: DIGEST,
    context_ref: CONTEXT_REF,
    context_digest: DIGEST,
    snapshot_digest: SNAPSHOT,
    verification_type: 'initial',
    verdict: 'PASS',
    summary: 'all required vNext checks passed',
    acceptance_refs_checked: ['REF-S08-E-ACCEPTANCE'],
    seam_refs_checked: ['REF-S08-E-SEAM'],
    oracle_refs_checked: ['REF-S08-E-ORACLE'],
    risk_refs_considered: [
      {
        ref_id: 'REF-S08-E-RISK',
        applicability: 'APPLICABLE',
        reason: 'execution state and persistence are in scope',
      },
    ],
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
    ...overrides,
  };
}

function validRecheck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validResult({
    verification_type: 'recheck',
    previous_failure_signature: 'previous-failure-signature',
    repair_diff_digest: 'c'.repeat(64),
    ...overrides,
  });
}

function validRepair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validResult({
    verdict: 'REPAIR',
    summary: 'the bounded criterion needs repair',
    failed_acceptance_refs: ['REF-S08-E-ACCEPTANCE'],
    counterexamples: ['the observed result contradicts the acceptance criterion'],
    failed_criterion: 'CV consumer does not preserve the vNext binding',
    failure_signature: 'failure-signature-1',
    required_recheck_scope: ['vNext CV binding and regression tests'],
    ...overrides,
  });
}

function validRepairRecheck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validRepair({
    verification_type: 'recheck',
    previous_failure_signature: 'failure-signature-1',
    repair_diff_digest: 'c'.repeat(64),
    ...overrides,
  });
}

function withoutField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function expectRejected(value: unknown): SchemaValidationError {
  let thrown: unknown;
  try {
    validateVNextCvResultEnvelope(value);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SchemaValidationError);
  return thrown as SchemaValidationError;
}

describe('vNext CV result closed schema', () => {
  it('accepts all four PASS/REPAIR initial/recheck branches', () => {
    const initial = validResult();
    const recheck = validRecheck();
    const repair = validRepair();
    const repairRecheck = validRepairRecheck();

    expect(validateVNextCvResultEnvelope(initial)).toBe(initial);
    expect(validateVNextCVResultEnvelope(recheck)).toBe(recheck);
    expect(validateVNextCvResultEnvelope(repair)).toBe(repair);
    expect(validateVNextCVResultEnvelope(repairRecheck)).toBe(repairRecheck);
  });

  it('uses the explicit vNext schema and type discriminator', () => {
    expectRejected({ ...validResult(), schema_version: 1 });
    expectRejected({ ...validResult(), type: 'cv_result' });
    expectRejected({ ...validResult(), type: 'CV_PASS' });
    expectRejected({ ...validResult(), verdict: 'CONFIRMED' });
    expectRejected({ ...validResult(), verification_type: 'resume' });
  });

  it('rejects unknown fields, including legacy CV Level/Profile fields', () => {
    const unknown = expectRejected({ ...validResult(), unexpected: true });
    expect(unknown.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'cv_result.unexpected' })]),
    );
    expectRejected({ ...validResult(), cv_level: 'enhanced' });
    expectRejected({ ...validResult(), cv_profile: 'standard' });
    expectRejected({ ...validResult(), proof_profile: 'default' });
  });

  it('rejects malformed digest, snapshot, and context bindings', () => {
    expectRejected({ ...validResult(), worker_receipt_digest: 'not-a-digest' });
    expectRejected({ ...validResult(), manifest_digest: 'A'.repeat(64) });
    expectRejected({ ...validResult(), plan_digest: 'a'.repeat(63) });
    expectRejected({ ...validResult(), proof_index_digest: 'not-a-digest' });
    expectRejected({ ...validResult(), context_digest: 'd'.repeat(64), context_ref: CONTEXT_REF });
    expectRejected({ ...validResult(), context_ref: '.proofloop/context/not-addressed.json' });
    expectRejected({ ...validResult(), snapshot_digest: 'b'.repeat(39) });
  });

  it('requires non-empty summary, proof-reference arrays, and risk decisions', () => {
    expectRejected({ ...validResult(), summary: '   ' });
    expectRejected({ ...validResult(), acceptance_refs_checked: [] });
    expectRejected({ ...validResult(), seam_refs_checked: [] });
    expectRejected({ ...validResult(), oracle_refs_checked: [] });
    expectRejected({ ...validResult(), risk_refs_considered: [] });
    expectRejected({
      ...validResult(),
      risk_refs_considered: [{ ref_id: 'REF-S08-E-RISK', applicability: 'APPLICABLE' }],
    });
  });

  it('closes PASS fields and requires the complete REPAIR failure contract', () => {
    expectRejected({
      ...validResult(),
      counterexamples: ['a counterexample means this is not PASS'],
    });
    expectRejected({ ...validResult(), failure_signature: 'not-allowed-on-pass' });
    expectRejected({ ...validResult(), required_recheck_scope: [] });
    expectRejected(validRepair({ failure_signature: undefined }));
    expectRejected(validRepair({ required_recheck_scope: [] }));
    expectRejected(validRepair({ failed_criterion: '   ' }));
  });

  it('requires previous failure and repair bindings only for recheck results', () => {
    expectRejected(validRecheck({ previous_failure_signature: undefined }));
    expectRejected(validRecheck({ repair_diff_digest: 'not-a-digest' }));
    expectRejected(withoutField(validRepairRecheck(), 'previous_failure_signature'));
    expectRejected(withoutField(validRepairRecheck(), 'repair_diff_digest'));
    expectRejected(validRepairRecheck({ repair_diff_digest: 'not-a-digest' }));
    expectRejected({
      ...validResult(),
      previous_failure_signature: 'should-not-be-present-on-initial',
    });
    expectRejected(validRepair({ repair_diff_digest: 'c'.repeat(64) }));
  });

  it('forbids recheck-only fields on every initial branch, including initial PASS', () => {
    // PASS + initial must not carry either recheck binding.
    expectRejected({
      ...validResult(),
      repair_diff_digest: 'c'.repeat(64),
    });
    // REPAIR + initial must not carry the prior-failure binding.
    expectRejected(validRepair({ previous_failure_signature: 'stale-failure' }));
  });

  it('closes PASS on every failure metadata field, not only counterexamples', () => {
    expectRejected({ ...validResult(), failed_criterion: 'not-allowed-on-pass' });
    expectRejected({ ...validResult(), required_recheck_scope: ['not-allowed-on-pass'] });
    expectRejected({ ...validResult(), failed_acceptance_refs: ['REF-S08-E-ACCEPTANCE'] });
    expectRejected({ ...validResult(), invalid_tests: ['t'] });
    expectRejected({ ...validResult(), scope_violations: ['s'] });
    expectRejected({ ...validResult(), forbidden_substitutions: ['f'] });
    expectRejected({ ...validResult(), regression_failures: ['r'] });
  });

  it('requires every REPAIR contract field by absence, not only by blank value', () => {
    expectRejected(withoutField(validRepair(), 'failed_criterion'));
    expectRejected(withoutField(validRepair(), 'failure_signature'));
    expectRejected(withoutField(validRepair(), 'required_recheck_scope'));
  });

  it('requires recheck bindings by absence on the PASS recheck branch', () => {
    expectRejected(withoutField(validRecheck(), 'previous_failure_signature'));
    expectRejected(withoutField(validRecheck(), 'repair_diff_digest'));
  });
});

describe('S09-C-T03 — CV admission rejects legacy stage labels before any read/write', () => {
  it('rejects a CV result envelope whose stage_id is the parked S08B0 label', () => {
    expect(() => validateVNextCvResultEnvelope({ ...validResult(), stage_id: 'S08B0' })).toThrowError(
      SchemaValidationError,
    );
    expect(() => validateVNextCvResultEnvelope({ ...validResult(), stage_id: 'S08B0' })).toThrowError(
      /canonical Stage ID/,
    );
  });

  it('rejects a CV result envelope whose stage_id is the parked S08B label', () => {
    expect(() => validateVNextCvResultEnvelope({ ...validResult(), stage_id: 'S08B' })).toThrowError(
      /canonical Stage ID/,
    );
  });
});
