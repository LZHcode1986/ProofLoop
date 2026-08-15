import { describe, expect, it } from 'vitest';
import {
  VNEXT_CV_RESULT_TYPE,
  VNEXT_CV_RISK_APPLICABILITIES,
  VNEXT_CV_SCHEMA_VERSION,
  VNEXT_CV_VERDICTS,
  VNEXT_CV_VERIFICATION_TYPES,
} from './index';
import type {
  VNextCvAdmissionState,
  VNextCvPassInitialResult,
  VNextCvPassRecheckResult,
  VNextCvResultEnvelope,
  VNextCvRepairInitialResult,
  VNextCvRepairRecheckResult,
} from './index';

const DIGEST = 'a'.repeat(64);

const PASS_INITIAL = {
  schema_version: 2,
  type: 'CV_RESULT',
  stage_id: 'S08',
  slice_id: 'S08-E',
  worker_receipt_digest: DIGEST,
  manifest_digest: DIGEST,
  plan_digest: DIGEST,
  proof_index_digest: DIGEST,
  context_ref: `.proofloop/context/${DIGEST}.json`,
  context_digest: DIGEST,
  snapshot_digest: 'b'.repeat(40),
  verification_type: 'initial',
  verdict: 'PASS',
  summary: 'pass',
  acceptance_refs_checked: ['REF-S08-E-ACCEPTANCE'],
  seam_refs_checked: ['REF-S08-E-SEAM'],
  oracle_refs_checked: ['REF-S08-E-ORACLE'],
  risk_refs_considered: [
    { ref_id: 'REF-S08-E-RISK', applicability: 'NOT_APPLICABLE', reason: 'not triggered' },
  ],
  failed_acceptance_refs: [],
  invalid_tests: [],
  counterexamples: [],
  scope_violations: [],
  forbidden_substitutions: [],
  regression_failures: [],
} as const satisfies VNextCvPassInitialResult;

const PASS_RECHECK = {
  ...PASS_INITIAL,
  verification_type: 'recheck',
  previous_failure_signature: 'failure',
  repair_diff_digest: 'c'.repeat(64),
} as const satisfies VNextCvPassRecheckResult;

const REPAIR_INITIAL = {
  ...PASS_INITIAL,
  verdict: 'REPAIR',
  summary: 'repair required',
  failed_acceptance_refs: ['REF-S08-E-ACCEPTANCE'],
  counterexamples: ['counterexample'],
  failed_criterion: 'criterion',
  failure_signature: 'failure',
  required_recheck_scope: ['criterion and regression'],
} as const satisfies VNextCvRepairInitialResult;

const REPAIR_RECHECK = {
  ...REPAIR_INITIAL,
  verification_type: 'recheck',
  previous_failure_signature: 'failure',
  repair_diff_digest: 'c'.repeat(64),
} as const satisfies VNextCvRepairRecheckResult;

function branchFact(result: VNextCvResultEnvelope): string {
  if (result.verdict === 'REPAIR') return result.failure_signature;
  return result.summary;
}

/** Compile-time key-presence probe; a `false` assertion fails `tsc` if the key exists. */
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

/**
 * Compile-time required-key probe: `true` only when the key is REQUIRED
 * (not optional) on T. A `true as IsRequired<...>` assertion fails `tsc`
 * with TS2352 when the field is optional (`undefined extends T[K]`), which is
 * exactly the T02 runtime/type binding that must hold.
 */
type IsRequired<T, K extends keyof T> = undefined extends T[K] ? false : true;

describe('vNext CV result types', () => {
  it('exposes closed schema constants and all four discriminated branches', () => {
    expect(VNEXT_CV_SCHEMA_VERSION).toBe(2);
    expect(VNEXT_CV_RESULT_TYPE).toBe('CV_RESULT');
    expect(VNEXT_CV_VERIFICATION_TYPES).toEqual(['initial', 'recheck']);
    expect(VNEXT_CV_VERDICTS).toEqual(['PASS', 'REPAIR']);
    expect(VNEXT_CV_RISK_APPLICABILITIES).toEqual(['APPLICABLE', 'NOT_APPLICABLE']);
    expect(branchFact(PASS_INITIAL)).toBe('pass');
    expect(branchFact(PASS_RECHECK)).toBe('pass');
    expect(branchFact(REPAIR_INITIAL)).toBe('failure');
    expect(branchFact(REPAIR_RECHECK)).toBe('failure');
  });

  it('type-binds recheck metadata to recheck branches and forbids it on initial branches', () => {
    // recheck branches must carry both repair bindings at the type level.
    expect(true as HasKey<VNextCvPassRecheckResult, 'previous_failure_signature'>).toBe(true);
    expect(true as HasKey<VNextCvPassRecheckResult, 'repair_diff_digest'>).toBe(true);
    expect(true as HasKey<VNextCvRepairRecheckResult, 'previous_failure_signature'>).toBe(true);
    expect(true as HasKey<VNextCvRepairRecheckResult, 'repair_diff_digest'>).toBe(true);
    // initial branches must NOT carry recheck-only bindings at the type level.
    expect(false as HasKey<VNextCvPassInitialResult, 'previous_failure_signature'>).toBe(false);
    expect(false as HasKey<VNextCvPassInitialResult, 'repair_diff_digest'>).toBe(false);
    expect(false as HasKey<VNextCvRepairInitialResult, 'previous_failure_signature'>).toBe(false);
    expect(false as HasKey<VNextCvRepairInitialResult, 'repair_diff_digest'>).toBe(false);
    // PASS branches must NOT carry failure metadata at the type level.
    expect(false as HasKey<VNextCvPassInitialResult, 'failed_criterion'>).toBe(false);
    expect(false as HasKey<VNextCvPassRecheckResult, 'failed_criterion'>).toBe(false);
  });

  it('type-binds worker_receipt_digest as REQUIRED on every CV envelope branch (T02 runtime/type binding)', () => {
    // The closed-schema validator requires worker_receipt_digest on every CV
    // result; the envelope branch types must not allow omitting it. Each
    // `expect<IsRequired<...>>(true)` fails `tsc` (TS2345) while the field
    // stays optional — the RED probe for the T02 binding.
    expect<IsRequired<VNextCvPassInitialResult, 'worker_receipt_digest'>>(true).toBe(true);
    expect<IsRequired<VNextCvPassRecheckResult, 'worker_receipt_digest'>>(true).toBe(true);
    expect<IsRequired<VNextCvRepairInitialResult, 'worker_receipt_digest'>>(true).toBe(true);
    expect<IsRequired<VNextCvRepairRecheckResult, 'worker_receipt_digest'>>(true).toBe(true);
  });

  it('types the Runtime consumer state as a closed v2 CV_RESULT fact, not a legacy reconcile state', () => {
    const consumerState = {
      schema_version: 2,
      type: 'CV_RESULT',
      action: 'CV_PASS',
      stage_id: 'S08',
      slice_id: 'S08-E',
      verdict: 'PASS',
      verification_type: 'initial',
      manifest_digest: DIGEST,
      plan_digest: DIGEST,
      proof_index_digest: DIGEST,
      snapshot_digest: 'b'.repeat(40),
      context_ref: `.proofloop/context/${DIGEST}.json`,
      context_digest: DIGEST,
      worker_receipt_digest: DIGEST,
      receipt_chain_valid: true,
    } as const satisfies VNextCvAdmissionState;

    expect(consumerState.schema_version).toBe(2);
    expect(consumerState.type).toBe('CV_RESULT');
    expect(consumerState.action).toMatch(/^(CV_PASS|CV_REPAIR)$/);
    expect(consumerState.verdict).toMatch(/^(PASS|REPAIR)$/);
    expect(consumerState.verification_type).toMatch(/^(initial|recheck)$/);
    expect(consumerState.receipt_chain_valid).toBe(true);

    // Legacy reconcile state fields (stage_state / project_state / findings /
    // receipt_chain) must never leak into the vNext consumer state type.
    expect(false as HasKey<VNextCvAdmissionState, 'stage_state'>).toBe(false);
    expect(false as HasKey<VNextCvAdmissionState, 'project_state'>).toBe(false);
    expect(false as HasKey<VNextCvAdmissionState, 'findings'>).toBe(false);
    expect(false as HasKey<VNextCvAdmissionState, 'receipt_chain'>).toBe(false);
  });
});
