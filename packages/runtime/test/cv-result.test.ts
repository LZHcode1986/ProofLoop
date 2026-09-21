/**
 * Slice-level CV result closed-set envelope + verdict gate tests (S03-D-T01;
 * bounded repair S03-D-CV1-r2).
 *
 * # PO: PO-S03-D-01, PO-S03-D-02
 *
 * Exercises the S03-D-T01 seam (packages/runtime/src/execute/cv-result.ts)
 * against the code-verifier-template allowed-result envelope, whose canonical
 * schema is INTENTIONALLY MIXED:
 *   - snake_case (template-owned): execution_mode / stage_id / slice_id /
 *     verification_type / acceptance_refs_checked / failed_acceptance_refs /
 *     invalid_tests / counterexamples / scope_violations /
 *     forbidden_substitutions / regression_failures / claimed_route_code /
 *     failed_criterion / failure_signature / required_recheck_scope /
 *     previous_failure_signature / repair_diff_basis / subtype / reason /
 *     invalidation_scope / resume_target;
 *   - template camelCase (must remain EXACTLY these): actionToken / verdict /
 *     summary / planRef / authorityRefs / gitBasis (nested head /
 *     candidateRef / diffRef) / resultRef.
 *
 * All-snake or all-camel substitutes (plan_ref / authority_refs / git_basis /
 * result_ref / candidate_ref / diff_ref / executionMode / stageId / ...) are
 * unknown keys and fail closed.
 *
 * Covered behavior:
 *   - closed-set validation: verdict ∈ {PASS, FINDINGS, BLOCKED}
 *     (REVIEW_RESET_REQUIRED is a lifecycle signal only and is never a
 *     verdict), verification_type ∈ {initial, recheck}, canonical stage/slice
 *     ids, root-relative planRef, canonical authorityRefs, gitBasis {head
 *     40-hex, candidateRef, diffRef}, resultRef required under NORMAL and
 *     forbidden under PRE_MES_BOOTSTRAP, summary non-empty, the acceptance
 *     list fields, claimed_route_code closed (or null), FINDINGS-only fields
 *     (failed_criterion / failure_signature / required_recheck_scope) and
 *     recheck-only fields (previous_failure_signature / repair_diff_basis)
 *     required exactly in their owning combinations — out-of-place, unknown-
 *     key, control-character and out-of-bound entries fail closed (E2E-08 /
 *     E2E-20 / HP-005 / STATIC-20; worker-template result envelope);
 *   - NON-SUCCESS closure: FINDINGS/BLOCKED require a non-null closed
 *     claimed_route_code (CV evidence only) plus subtype / reason /
 *     invalidation_scope / resume_target (closed, §2.2.3 resume targets);
 *     those fields are out-of-place on PASS and fail closed;
 *   - verdict gate: ONLY `PASS` (+ candidate ref durable) → READY_TO_INTEGRATE;
 *     PASS without a durable candidate ref stays not-ready; FINDINGS/BLOCKED
 *     are structured findings back to Brain — the gate never emits a route
 *     code, never claims CV PASS == INTEGRATED and never routes (ADR-005).
 *
 * The CV reads its basis only from the packet target / Authority / Plan / Git
 * facts; MES status is never evidence for a PASS/FINDING (HP-005), and Worker
 * Result refs are never primary evidence (code-verifier-template).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCvResult,
  gateCvResult,
  CV_VERDICTS,
  CV_VERIFICATION_TYPES,
  CV_REVIEW_RESET_SIGNAL,
} from '../dist/execute/cv-result';
import { SchemaValidationError } from '../dist/mes/validate';

const STAGE = 'S03';
const SLICE = 'S03-D';
const PLAN_REF = 'delivery/stages/S03/plan.md';
const HEAD = '1317795640cb12c940e89ca1610a6ddfc425f409';
const CANDIDATE_REF = 'refs/heads/proofloop-s03-d';
const DIFF_REF = 'diff/S03-D-candidate.patch';
const RESULT_REF = 'mes/result/S03/S03-D/cv-1';
const TOKEN = '29d9ba61-297f-4d71-b095-98de43174ff6';

function validCvResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution_mode: 'NORMAL',
    actionToken: TOKEN,
    verdict: 'PASS',
    stage_id: STAGE,
    slice_id: SLICE,
    verification_type: 'initial',
    planRef: PLAN_REF,
    authorityRefs: ['PRD.md#FR-006', 'tech-spec/contracts.md#2.2.3', 'tech-spec/architecture.md#ADR-005'],
    gitBasis: { head: HEAD, candidateRef: CANDIDATE_REF, diffRef: DIFF_REF },
    resultRef: RESULT_REF,
    summary: 'independently refuted every PO against the slice goal; no counterexample found',
    acceptance_refs_checked: ['tech-spec/acceptance.md#E2E-08', 'tech-spec/acceptance.md#E2E-20'],
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
    claimed_route_code: null,
    ...overrides,
  };
}

/** A canonical non-success (FINDINGS) template-shaped fixture. */
function validFindingsResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validCvResult({
    verdict: 'FINDINGS',
    claimed_route_code: 'IMPLEMENTATION_DEFECT',
    subtype: 'CV_CRITERION_FAILED',
    reason: 'independent refutation found a concrete counterexample; bounded repair required',
    invalidation_scope: ['packages/runtime/src/execute/cv-result.ts'],
    resume_target: 'producer',
    failed_criterion: 'slice goal not proven for PO-S03-D-01',
    failure_signature: 'counterexample: acceptance_refs_checked contains an unbound ref',
    required_recheck_scope: ['packages/runtime/test/cv-result.test.ts'],
    counterexamples: ['blah'],
    ...overrides,
  });
}

describe('slice-level cv result envelope (PO-S03-D-01)', () => {
  test('accepts a bounded slice-level cv result or fails closed', () => {
    // PASS initial under NORMAL — fully closed envelope round-trips with the
    // exact mixed-shape canonical transport.
    const result = validateCvResult(validCvResult());
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.stage_id, STAGE);
    assert.equal(result.slice_id, SLICE);
    assert.equal(result.verification_type, 'initial');
    assert.equal(result.execution_mode, 'NORMAL');
    assert.equal(result.gitBasis.head, HEAD);
    assert.equal(result.gitBasis.candidateRef, CANDIDATE_REF);
    assert.equal(result.gitBasis.diffRef, DIFF_REF);
    assert.equal(result.planRef, PLAN_REF);
    assert.equal(result.claimed_route_code, null);
    assert.deepEqual([...CV_VERDICTS], ['PASS', 'FINDINGS', 'BLOCKED']);
    assert.deepEqual([...CV_VERIFICATION_TYPES], ['initial', 'recheck']);
    assert.equal(CV_REVIEW_RESET_SIGNAL, 'REVIEW_RESET_REQUIRED');

    // FINDINGS with the required FINDINGS-only AND non-success fields.
    const findings = validateCvResult(validFindingsResult());
    assert.equal(findings.verdict, 'FINDINGS');
    assert.equal(findings.failed_criterion, 'slice goal not proven for PO-S03-D-01');
    assert.deepEqual(findings.required_recheck_scope, ['packages/runtime/test/cv-result.test.ts']);
    assert.equal(findings.subtype, 'CV_CRITERION_FAILED');
    assert.equal(findings.resume_target, 'producer');
    assert.deepEqual(findings.invalidation_scope, ['packages/runtime/src/execute/cv-result.ts']);

    // BLOCKED with the non-success closure closes too.
    const blocked = validateCvResult(
      validCvResult({
        verdict: 'BLOCKED',
        claimed_route_code: 'RUNTIME_BLOCKER',
        subtype: 'CV_BLOCKED_EXTERNAL',
        reason: 'cannot verify: candidate ref unavailable in packet basis',
        invalidation_scope: [],
        resume_target: 'recovery',
      }),
    );
    assert.equal(blocked.verdict, 'BLOCKED');
    assert.equal(blocked.claimed_route_code, 'RUNTIME_BLOCKER');
    assert.equal(blocked.resume_target, 'recovery');

    // recheck with the required recheck-only fields (same-CV bounded recheck).
    const recheck = validateCvResult(
      validCvResult({
        verification_type: 'recheck',
        verdict: 'PASS',
        previous_failure_signature: 'counterexample: unbound acceptance ref',
        repair_diff_basis: 'diff/S03-D-repair.patch',
      }),
    );
    assert.equal(recheck.verification_type, 'recheck');
    assert.equal(recheck.previous_failure_signature, 'counterexample: unbound acceptance ref');
    assert.equal(recheck.repair_diff_basis, 'diff/S03-D-repair.patch');

    // PRE_MES_BOOTSTRAP must omit resultRef (Git-bound evidence only).
    const bootstrap = validateCvResult(
      validCvResult({ execution_mode: 'PRE_MES_BOOTSTRAP', resultRef: undefined }),
    );
    assert.equal(bootstrap.execution_mode, 'PRE_MES_BOOTSTRAP');
    assert.equal(bootstrap.resultRef, undefined);

    const schemaError = (input: Record<string, unknown>): string | undefined => {
      try {
        validateCvResult(input);
        return undefined;
      } catch (err) {
        assert.ok(err instanceof SchemaValidationError, 'must throw SchemaValidationError');
        const e = err as SchemaValidationError;
        assert.ok(typeof e.message === 'string' && e.message.length > 0);
        return e.message;
      }
    };

    // camelCase substitutes for snake_case fields are NOT canonical — they are
    // unknown keys and fail closed.
    assert.match(schemaError(validCvResult({ executionMode: 'NORMAL' }))!, /executionMode|Unknown/i);
    assert.match(schemaError(validCvResult({ stageId: STAGE }))!, /stageId|Unknown/i);
    assert.match(schemaError(validCvResult({ sliceId: SLICE }))!, /sliceId|Unknown/i);
    assert.match(schemaError(validCvResult({ verificationType: 'initial' }))!, /verificationType|Unknown/i);

    // all-snake substitutions for template camelCase fields are NOT canonical
    // either — they are unknown keys and fail closed.
    assert.match(schemaError(validCvResult({ plan_ref: PLAN_REF }))!, /plan_ref|Unknown/i);
    assert.match(schemaError(validCvResult({ authority_refs: ['PRD.md#FR-006'] }))!, /authority_refs|Unknown/i);
    assert.match(schemaError(validCvResult({ result_ref: RESULT_REF }))!, /result_ref|Unknown/i);
    assert.match(
      schemaError(validCvResult({ git_basis: { head: HEAD, candidate_ref: CANDIDATE_REF, diff_ref: DIFF_REF } }))!,
      /git_basis|Unknown/i,
    );
    assert.match(
      schemaError(validCvResult({ gitBasis: { head: HEAD, candidate_ref: CANDIDATE_REF, diffRef: DIFF_REF } }))!,
      /candidate_ref|Unknown/i,
    );
    assert.match(
      schemaError(validCvResult({ gitBasis: { head: HEAD, candidateRef: CANDIDATE_REF, diff_ref: DIFF_REF } }))!,
      /diff_ref|Unknown/i,
    );

    // Other unknown keys fail closed.
    assert.match(schemaError(validCvResult({ nextAction: 'worker repair' }))!, /unknown field|Unknown field|nextAction/i);
    assert.match(schemaError(validCvResult({ verdict: 'PASS', extra: 1 }))!, /extra/i);

    // verdict must be closed: REVIEW_RESET_REQUIRED is a lifecycle signal,
    // never a verdict inside the result envelope.
    assert.match(
      schemaError(validCvResult({ verdict: CV_REVIEW_RESET_SIGNAL }))!,
      /REVIEW_RESET_REQUIRED|lifecycle/i,
    );
    assert.match(schemaError(validCvResult({ verdict: 'MAYBE' }))!, /verdict/i);

    // verification_type closed.
    assert.match(schemaError(validCvResult({ verification_type: 'fresh' }))!, /verification_type/i);

    // stage / slice ids canonical.
    assert.match(schemaError(validCvResult({ stage_id: 'S0X' }))!, /stage_id/i);
    assert.match(schemaError(validCvResult({ slice_id: 's03-d' }))!, /slice_id/i);

    // (S03-STAGE-REVIEW-F001) stage/slice closure: the Slice's stage prefix
    // must EXACTLY equal the CV result stage_id — a cross-stage slice (e.g.
    // stage_id S03 together with slice_id S04-F) fails closed in both
    // directions, never silently narrowed.
    assert.match(schemaError(validCvResult({ stage_id: 'S03', slice_id: 'S04-F' }))!, /slice_id/i, 'slice with a foreign stage prefix must fail closed');
    assert.match(schemaError(validCvResult({ stage_id: 'S02', slice_id: 'S03-D' }))!, /slice_id/i, 'slice whose stage prefix contradicts stage_id must fail closed');
    // planRef must be canonical root-relative.
    assert.match(schemaError(validCvResult({ planRef: '/abs/plan.md' }))!, /planRef/i);

    // authorityRefs must be canonical refs.
    assert.match(schemaError(validCvResult({ authorityRefs: [] }))!, /authorityRefs/i);
    assert.match(schemaError(validCvResult({ authorityRefs: ['not-a-ref'] }))!, /authorityRefs/i);

    // gitBasis closed: head must be 40-hex; candidateRef / diffRef canonical.
    assert.match(schemaError(validCvResult({ gitBasis: { head: 'zz', candidateRef: CANDIDATE_REF, diffRef: DIFF_REF } }))!, /gitBasis|head/i);
    assert.match(schemaError(validCvResult({ gitBasis: { head: HEAD, candidateRef: '../evil', diffRef: DIFF_REF } }))!, /candidateRef/i);
    assert.match(schemaError(validCvResult({ gitBasis: { head: HEAD, candidateRef: CANDIDATE_REF, diffRef: 'C:\\windows\\path' } }))!, /diffRef/i);
    assert.match(schemaError(validCvResult({ gitBasis: { head: HEAD, candidateRef: CANDIDATE_REF, diffRef: DIFF_REF, extraBasis: 1 } }))!, /extraBasis/i);

    // resultRef: REQUIRED under NORMAL, FORBIDDEN under PRE_MES_BOOTSTRAP.
    assert.match(schemaError(validCvResult({ resultRef: undefined }))!, /resultRef/i);
    assert.match(schemaError(validCvResult({ execution_mode: 'PRE_MES_BOOTSTRAP' }))!, /resultRef/i);

    // summary non-empty.
    assert.match(schemaError(validCvResult({ summary: '' }))!, /summary/i);

    // acceptance lists closed (arrays of ref strings without control chars).
    assert.match(schemaError(validCvResult({ acceptance_refs_checked: 'nope' }))!, /acceptance_refs_checked/i);
    assert.match(schemaError(validCvResult({ scope_violations: [3] }))!, /scope_violations/i);
    assert.match(schemaError(validCvResult({ summary: 'bad\u0007control' }))!, /control/i);
    assert.match(schemaError(validCvResult({ actionToken: 'bad\u001fcontrol' }))!, /actionToken/i);

    // failed_acceptance_refs must be a subset of acceptance_refs_checked.
    assert.match(
      schemaError(
        validCvResult({ failed_acceptance_refs: ['tech-spec/acceptance.md#E2E-99'] }),
      )!,
      /failed_acceptance_refs/i,
    );

    // claimed_route_code closed (or null) on PASS.
    assert.match(schemaError(validCvResult({ claimed_route_code: 'NOT_A_ROUTE' }))!, /claimed_route_code/i);

    // NON-SUCCESS closure: FINDINGS requires claimed_route_code + subtype +
    // reason + invalidation_scope + resume_target; BLOCKED likewise; out-of-
    // place on PASS fails closed.
    assert.match(
      schemaError(validCvResult({ verdict: 'FINDINGS', claimed_route_code: 'PLAN_GAP', failed_criterion: 'c', failure_signature: 's', required_recheck_scope: ['x'] }))!,
      /subtype|reason|invalidation_scope|resume_target|FINDINGS/i,
    );
    // FINDINGS missing the non-null claimed_route_code (evidence) fails closed.
    assert.match(
      schemaError(validFindingsResult({ claimed_route_code: undefined }))!,
      /claimed_route_code/i,
    );
    // FINDINGS with a non-closed resume_target fails closed.
    assert.match(
      schemaError(validFindingsResult({ resume_target: 'somewhere-else' }))!,
      /resume_target/i,
    );
    // BLOCKED missing the non-null claimed_route_code fails closed.
    assert.match(
      schemaError(
        validCvResult({
          verdict: 'BLOCKED',
          claimed_route_code: undefined,
          subtype: 'CV_BLOCKED',
          reason: 'r',
          invalidation_scope: [],
          resume_target: 'producer',
        }),
      )!,
      /claimed_route_code|BLOCKED/i,
    );
    // On PASS the non-success fields are out-of-place.
    assert.match(
      schemaError(validCvResult({ subtype: 'smuggled', reason: 'r', invalidation_scope: [], resume_target: 'producer' }))!,
      /subtype|reason|invalidation_scope|resume_target/i,
    );

    // FINDINGS-only fields are REQUIRED exactly when verdict === FINDINGS, and
    // fail closed when present under any other verdict.
    assert.match(
      schemaError(validFindingsResult({ failed_criterion: undefined, failure_signature: undefined, required_recheck_scope: undefined }))!,
      /failed_criterion|failure_signature|required_recheck_scope|FINDINGS/i,
    );
    assert.match(
      schemaError(validFindingsResult({ required_recheck_scope: [] }))!,
      /required_recheck_scope/i,
    );
    assert.match(
      schemaError(
        validCvResult({ failed_criterion: 'smuggled', failure_signature: 's', required_recheck_scope: ['x'] }),
      )!,
      /failed_criterion|FINDINGS/i,
    );

    // recheck-only fields REQUIRED exactly under verification_type recheck and
    // fail closed on initial.
    assert.match(
      schemaError(validCvResult({ verification_type: 'recheck', previous_failure_signature: 'old' }))!,
      /repair_diff_basis|recheck/i,
    );
    assert.match(
      schemaError(
        validCvResult({
          verification_type: 'recheck',
          previous_failure_signature: 'old',
          repair_diff_basis: '',
        }),
      )!,
      /repair_diff_basis/i,
    );
    assert.match(
      schemaError(
        validCvResult({ verification_type: 'initial', previous_failure_signature: 'old', repair_diff_basis: 'diff/x.patch' }),
      )!,
      /previous_failure_signature|recheck/i,
    );

    // PASS verdict with concrete counterexamples is inconsistent (PASS requires
    // no concrete counterexample per code-verifier-template).
    assert.match(
      schemaError(validCvResult({ counterexamples: ['some counterexample'] }))!,
      /counterexamples|PASS/i,
    );
  });
});

describe('slice-level cv verdict gate (PO-S03-D-02)', () => {
  test('gates integration readiness on cv pass only', () => {
    // PASS + durable candidate ref → READY_TO_INTEGRATE.
    const pass = validateCvResult(validCvResult());
    assert.deepEqual(gateCvResult(pass, { candidateRefDurable: true }), { state: 'READY_TO_INTEGRATE' });

    // PASS WITHOUT a durable candidate ref is NOT ready to integrate.
    assert.deepEqual(gateCvResult(pass, { candidateRefDurable: false }), { state: 'PASS_PENDING_CANDIDATE_REF' });

    // FINDINGS → structured finding back to Brain; never READY_TO_INTEGRATE.
    const findings = validateCvResult(validFindingsResult());
    assert.deepEqual(gateCvResult(findings, { candidateRefDurable: true }), { state: 'FINDINGS' });
    assert.deepEqual(gateCvResult(findings, { candidateRefDurable: false }), { state: 'FINDINGS' });

    // BLOCKED → structured blocker back to Brain (E2E-08); never ready.
    const blocked = validateCvResult(
      validCvResult({
        verdict: 'BLOCKED',
        claimed_route_code: 'RUNTIME_BLOCKER',
        subtype: 'CV_BLOCKED_EXTERNAL',
        reason: 'cannot verify: candidate ref unavailable in packet basis',
        invalidation_scope: [],
        resume_target: 'recovery',
      }),
    );
    assert.deepEqual(gateCvResult(blocked, { candidateRefDurable: true }), { state: 'BLOCKED' });

    // ADR-005: CV PASS is never INTEGRATED itself — the gate can only ever say
    // READY_TO_INTEGRATE; integration is a separate step. No route decision
    // exists on the gate: the closed gate state set carries no route code.
    const gateStates = new Set<string>(['READY_TO_INTEGRATE', 'PASS_PENDING_CANDIDATE_REF', 'FINDINGS', 'BLOCKED']);
    for (const s of gateStates) {
      assert.ok(!s.includes('INTEGRATED') || s === 'READY_TO_INTEGRATE');
      assert.equal(s.includes('REPAIR') || s.includes('REPLAN') || s.includes('HUMAN'), false, `${s} must not be a route`);
    }
  });
});