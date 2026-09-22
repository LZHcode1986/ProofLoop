/**
 * FINDING_DISPOSITION durable fact construct/validate seam tests (S03-D-T02).
 *
 * # PO: PO-S03-D-03
 * # PO: PO-S06-C-02 (S06-C-T02): AUTHORITY_GAP → authority-owner disposition closure fixture
 *
 * Exercises the S03-D-T02 seam (packages/runtime/src/execute/finding-
 * disposition.ts) against contracts.md §2.2.3 / mes.md FINDING_DISPOSITION
 * YAML + E2E-20:
 *   - Brain-owned arbitration is a closed set: disposition_ref (MES-
 *     generated), finding_ref bound to the original durable finding fact,
 *     finding_disposition ∈ {ACCEPTED, VERIFIER_OVERREACH}, claimed_route_code
 *     carried over verbatim from the finding (evidence only), accepted_route_code
 *     closed (VERIFIER_OVERREACH ⇒ must be null), basis_refs, reason (non-
 *     empty), resume_target ∈ {producer, planner, authority-owner, research,
 *     recovery, verifier-lane}, created_by: brain;
 *   - VERIFIER_OVERREACH can only be produced by the Brain: the construct
 *     seam never reads a disposition out of the finding input (a verifier
 *     cannot self-claim overreach), and an overreach disposition returns to
 *     the verifier lane (resume_target === verifier-lane) with no automatic
 *     producer repair / Replan / HUMAN_REQUIRED;
 *   - claimed_route_code is ONLY evidence — the only thing that drives
 *     routing is accepted_route_code (exposed read-only via effectiveRoute);
 *   - a PASS finding or a candidate-plan revision can never produce an
 *     acceptance (E2E-20 / §2.2.2) — dispositions only arbitrate real
 *     FINDINGS/BLOCKED findings bound to an accepted Plan;
 *   - PRE_MES_BOOTSTRAP never writes this durable fact (bootstrap evidence is
 *     Git-bound; no second decision store — STATIC-13/14);
 *   - unknown keys, out-of-closed-set values, control characters, empty
 *     reason and non-brain created_by fail closed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFindingDisposition,
  validateFindingDisposition,
  effectiveRoute,
  MES_FINDING_DISPOSITION_FIELDS,
} from '../dist/execute/finding-disposition';
import {
  validateMesFactEnvelope,
  SchemaValidationError,
} from '../dist/mes/validate';
import type { MesFactEnvelope } from '../dist/mes/types';
import { CV_CLAIMED_ROUTE_CODES } from '../dist/execute/cv-result';
import { sha } from './helpers';

const PLAN_REF = 'delivery/stages/S03/plan.md';
const PLAN_DIGEST = sha('s03-plan-v1');
const GIT_BASIS = { head: 'a'.repeat(40), branch: 'worktree/s03-d', worktree: '.proofloop/worktrees/S03-D' };
const WORK_ID = 'mes:work:S03:S03-D:1';
const FINDING_ID = 'mes:fact:finding:S03:S03-D:cv-1';
const FINDING_REF = FINDING_ID;

function acceptedBinding() {
  return {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: PLAN_REF,
    source_candidate_plan_ref: PLAN_REF,
    verification_result_ref: 'mes:result:S03:planning-verification-1',
    plan_digest: PLAN_DIGEST,
  };
}

/** A durable, valid `finding` MES fact (verifier closed verdict + claim). */
function findingFact(overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return validateMesFactEnvelope({
    schema_version: 2,
    fact_id: FINDING_ID,
    fact_kind: 'finding',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.3', 'tech-spec/acceptance.md#E2E-20'],
    scope: { stage_id: 'S03', slice_id: 'S03-D' },
    work_id: WORK_ID,
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    verifier_verdict: 'FINDINGS',
    claimed_route_code: 'IMPLEMENTATION_DEFECT',
    finding_evidence_refs: ['packages/runtime/test/finding-disposition.test.ts'],
    ...overrides,
  });
}

/** A valid §2.2.3 finding-disposition decision (snake_case canonical YAML). */
function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionMode: 'NORMAL',
    finding: findingFact(),
    disposition_ref: 'mes:disposition:S03:S03-D:cv-1',
    finding_ref: FINDING_REF,
    finding_disposition: 'ACCEPTED',
    claimed_route_code: 'IMPLEMENTATION_DEFECT',
    accepted_route_code: 'IMPLEMENTATION_DEFECT',
    basis_refs: [
      'packages/runtime/src/execute/cv-result.ts',
      'tech-spec/acceptance.md#E2E-20',
      'tech-spec/contracts.md#2.2.3',
    ],
    reason: 'independent re-read of Authority, Plan, scope and code reality confirms the claim; bounded repair on the current Slice',
    resume_target: 'producer',
    created_by: 'brain',
    ...overrides,
  };
}

describe('finding disposition arbitration closed set (PO-S03-D-03)', () => {
  test('accepts brain finding dispositions and rejects verifier overreach claims', () => {
    // The closed payload field set is exactly the §2.2.3 YAML.
    assert.deepEqual([...MES_FINDING_DISPOSITION_FIELDS], [
      'disposition_ref',
      'finding_ref',
      'finding_disposition',
      'claimed_route_code',
      'accepted_route_code',
      'basis_refs',
      'reason',
      'resume_target',
    ]);

    // --- Brain ACCEPTED over a real FINDINGS finding: full envelope closes.
    const accepted = buildFindingDisposition(validInput());
    assert.equal(accepted.fact_kind, 'finding_disposition');
    assert.equal(accepted.created_by, 'brain');
    assert.equal(accepted.scope?.stage_id, 'S03');
    assert.equal(accepted.scope?.slice_id, 'S03-D');
    assert.equal(accepted.plan_binding?.binding_stage, 'accepted');
    assert.equal(accepted.disposition_ref, 'mes:disposition:S03:S03-D:cv-1');
    assert.equal(accepted.finding_ref, FINDING_REF);
    assert.equal(accepted.finding_disposition, 'ACCEPTED');
    assert.equal(accepted.claimed_route_code, 'IMPLEMENTATION_DEFECT');
    assert.equal(accepted.accepted_route_code, 'IMPLEMENTATION_DEFECT');
    assert.equal(accepted.resume_target, 'producer');
    assert.ok((accepted.reason ?? '').length > 0);
    // The constructed envelope itself round-trips the MES envelope validator.
    assert.doesNotThrow(() => validateMesFactEnvelope(accepted));

    // BLOCKED finding + ACCEPTED disposition with a different route closes too.
    const blocked = buildFindingDisposition(
      validInput({
        finding: findingFact({ verifier_verdict: 'BLOCKED', claimed_route_code: 'PLAN_GAP' }),
        finding_ref: FINDING_REF,
        claimed_route_code: 'PLAN_GAP',
        accepted_route_code: 'PLAN_GAP',
        resume_target: 'planner',
        basis_refs: ['tech-spec/contracts.md#2.2.3', 'tech-spec/acceptance.md#E2E-20'],
      }),
    );
    assert.equal(blocked.finding_disposition, 'ACCEPTED');
    assert.equal(blocked.accepted_route_code, 'PLAN_GAP');
    assert.equal(blocked.resume_target, 'planner');

    // --- VERIFIER_OVERREACH: only Brain produces it; accepted_route_code
    // must be null; the lane returns to verifier-lane (no producer repair /
    // Replan / HUMAN_REQUIRED).
    const overreach = buildFindingDisposition(
      validInput({
        finding_disposition: 'VERIFIER_OVERREACH',
        accepted_route_code: null,
        resume_target: 'verifier-lane',
        reason: 'claimed route is not supported by Authority/Plan/scope; correct verifier packet/scope/basis and return to the verifier lane',
      }),
    );
    assert.equal(overreach.finding_disposition, 'VERIFIER_OVERREACH');
    assert.equal(overreach.accepted_route_code, null);
    assert.equal(overreach.resume_target, 'verifier-lane');

    // effectiveRoute exposes ONLY accepted_route_code (evidence never routes).
    assert.equal(effectiveRoute(accepted), 'IMPLEMENTATION_DEFECT');
    assert.equal(effectiveRoute(overreach), null);

    const schemaError = (input: Record<string, unknown>): string | undefined => {
      try {
        validateFindingDisposition(input);
        return undefined;
      } catch (err) {
        assert.ok(err instanceof SchemaValidationError, 'must throw SchemaValidationError');
        const e = err as SchemaValidationError;
        assert.ok(typeof e.message === 'string' && e.message.length > 0);
        return e.message;
      }
    };
    const buildError = (input: Record<string, unknown>): string | undefined => {
      try {
        buildFindingDisposition(input);
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    };

    // --- finding input cannot self-claim overreach: a finding fact never
    // carries a disposition field, so the verb only ever comes from Brain.
    assert.equal('finding_disposition' in findingFact(), false, 'finding facts never carry a disposition');

    // disposition must be closed.
    assert.match(schemaError(validInput({ finding_disposition: 'IGNORED' }))!, /finding_disposition/i);

    // OVERREACH with a non-null accepted_route_code fails closed.
    assert.match(
      schemaError(
        validInput({
          finding_disposition: 'VERIFIER_OVERREACH',
          accepted_route_code: 'IMPLEMENTATION_DEFECT',
          resume_target: 'verifier-lane',
        }),
      )!,
      /accepted_route_code|VERIFIER_OVERREACH/i,
    );
    // OVERREACH must return to the verifier lane — a producer/planner/
    // research/recovery target would auto-trigger a route.
    assert.match(
      schemaError(
        validInput({
          finding_disposition: 'VERIFIER_OVERREACH',
          accepted_route_code: null,
          resume_target: 'producer',
        }),
      )!,
      /resume_target|verifier-lane/i,
    );

    // ACCEPTED requires a legal accepted_route_code.
    assert.match(
      schemaError(validInput({ finding_disposition: 'ACCEPTED', accepted_route_code: null }))!,
      /accepted_route_code/i,
    );
    assert.match(
      schemaError(validInput({ finding_disposition: 'ACCEPTED', accepted_route_code: 'NOT_A_ROUTE' }))!,
      /accepted_route_code/i,
    );

    // claimed_route_code closed (evidence only, must be legal).
    assert.match(schemaError(validInput({ claimed_route_code: 'BOGUS' }))!, /claimed_route_code/i);

    // resume_target closed.
    assert.match(schemaError(validInput({ resume_target: 'somewhere-else' }))!, /resume_target/i);

    // reason required.
    assert.match(schemaError(validInput({ reason: '' }))!, /reason/i);

    // basis_refs must be an array of refs.
    assert.match(schemaError(validInput({ basis_refs: 'nope' }))!, /basis_refs/i);
    assert.match(schemaError(validInput({ basis_refs: [7] }))!, /basis_refs/i);

    // control characters fail closed.
    assert.match(schemaError(validInput({ reason: 'bad\u0007control' }))!, /control/i);

    // created_by must be brain (no Agent narrative ever writes this fact).
    assert.match(schemaError(validInput({ created_by: 'worker' }))!, /created_by/i);

    // unknown keys fail closed (closed set, no smuggling).
    assert.match(schemaError(validInput({ nextAction: 'producer repair' }))!, /nextAction|Unknown/i);

    // --- constructs bind the REAL finding: finding_ref must equal the
    // finding fact id; PASS findings / candidate plans never arbitrate.
    assert.match(
      buildError(validInput({ finding_ref: 'mes:fact:finding:S03:S03-A:cv-9' }))!,
      /finding_ref|findingRef/i,
    );
    assert.match(buildError(validInput({ finding: undefined }))!, /finding/i);
    assert.match(buildError(validInput({ finding: 'not-a-fact' }))!, /finding/i);
    assert.match(
      buildError(validInput({ finding: findingFact({ verifier_verdict: 'PASS' }) }))!,
      /PASS|FINDINGS|BLOCKED|disposition/i,
    );

    // candidate plan binding (candidate revision) never produces acceptance.
    assert.match(
      buildError(
        validInput({
          finding: {
            ...findingFact(),
            plan_binding: {
              binding_stage: 'candidate',
              candidate_plan_ref: 'delivery/stages/S03/plan.md',
              accepted_plan_ref: null,
              verdict: 'PLAN_READY',
              plan_digest: PLAN_DIGEST,
            },
          },
        }),
      )!,
      /accepted|candidate/i,
    );

    // PRE_MES_BOOTSTRAP never writes this durable fact (STATIC-13/14).
    assert.match(schemaError(validInput({ executionMode: 'PRE_MES_BOOTSTRAP' }))!, /NORMAL|bootstrap|PRE_MES/i);

    // A standalone disposition decision can be validated without a finding
    // (the finding only binds at construction).
    assert.doesNotThrow(() =>
      validateFindingDisposition(
        validInput({
          finding: undefined,
          finding_ref: FINDING_REF,
          finding_disposition: 'ACCEPTED',
          accepted_route_code: 'IMPLEMENTATION_DEFECT',
        }),
      ),
    );
  });
  test('AUTHORITY_GAP closes to the authority-owner lane and USER_DECISION_REQUIRED stays a local pause (S06-C-T02 / PO-S06-C-02)', () => {
    // Local fail-closed helpers (same shape as the S03-D-T02 test above).
    const schemaError = (input: Record<string, unknown>): string | undefined => {
      try {
        validateFindingDisposition(input);
        return undefined;
      } catch (err) {
        assert.ok(err instanceof SchemaValidationError, 'must throw SchemaValidationError');
        return (err as SchemaValidationError).message;
      }
    };
    const buildError = (input: Record<string, unknown>): string | undefined => {
      try {
        buildFindingDisposition(input);
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    };

    // --- claimed-route ownership: AUTHORITY_GAP is a Planning/SPV claim.
    // Runtime closed sets and disposition validation enforce the route boundary;
    // Agent/Markdown wording is not part of this test surface.
    const gapFinding = findingFact({
      verifier_verdict: 'BLOCKED',
      claimed_route_code: 'AUTHORITY_GAP',
      authority_refs: [
        'tech-spec/architecture.md#/entities/authority-gap-and-update',
        'tech-spec/contracts.md#2.2.3a',
        'tech-spec/acceptance.md#STATIC-31',
        'tech-spec/acceptance.md#E2E-12',
      ],
      finding_evidence_refs: [
        '.opencode/agents/proofloop-plan.md',
        '.opencode/agents/stage-plan-verifier.md',
        '.pi/agents/proofloop-plan.md',
        '.pi/agents/stage-plan-verifier.md',
      ],
    });
    // Downstream verifier exclusion is typed in the Runtime: the CV claim
    // closed set never admits AUTHORITY_GAP (contracts §2.2.3a / STATIC-31).
    assert.equal(
      (CV_CLAIMED_ROUTE_CODES as readonly string[]).includes('AUTHORITY_GAP'),
      false,
      'the Runtime CV claim closed set must exclude AUTHORITY_GAP (downstream verifiers never claim the Planning/SPV route)',
    );

    // --- legal closed path: ACCEPTED AUTHORITY_GAP → authority-owner lane.
    const authorityGap = buildFindingDisposition(
      validInput({
        finding: gapFinding,
        finding_ref: FINDING_ID,
        claimed_route_code: 'AUTHORITY_GAP',
        accepted_route_code: 'AUTHORITY_GAP',
        resume_target: 'authority-owner',
        basis_refs: [
          'tech-spec/architecture.md#/entities/authority-gap-and-update',
          'tech-spec/contracts.md#2.2.3a',
          'tech-spec/acceptance.md#E2E-12',
          'tech-spec/acceptance.md#STATIC-31',
        ],
        reason:
          'bounded Planning/SPV handoff closure: current Technical Authority is insufficient for unchanged Product intent; owner update then fresh Planning/SPV (no user checkpoint)',
      }),
    );
    assert.equal(authorityGap.fact_kind, 'finding_disposition');
    assert.equal(authorityGap.finding_disposition, 'ACCEPTED');
    assert.equal(authorityGap.claimed_route_code, 'AUTHORITY_GAP');
    assert.equal(authorityGap.accepted_route_code, 'AUTHORITY_GAP');
    assert.equal(authorityGap.resume_target, 'authority-owner');
    assert.equal(effectiveRoute(authorityGap), 'AUTHORITY_GAP');
    // The claim is evidence only: it is carried over verbatim from the
    // finding fact and never becomes a second disposition store.
    assert.equal(authorityGap.finding_ref, FINDING_ID);
    assert.doesNotThrow(() => validateMesFactEnvelope(authorityGap));

    // --- USER_DECISION_REQUIRED locality: a legal Brain route that never
    // fabricates the HUMAN_REQUIRED pause inside this fact.
    const userDecision = buildFindingDisposition(
      validInput({
        finding: findingFact({ verifier_verdict: 'FINDINGS', claimed_route_code: 'USER_DECISION_REQUIRED' }),
        claimed_route_code: 'USER_DECISION_REQUIRED',
        accepted_route_code: 'USER_DECISION_REQUIRED',
        resume_target: 'producer',
        basis_refs: ['tech-spec/contracts.md#2.2.3a', 'tech-spec/acceptance.md#STATIC-31'],
        reason:
          'Brain confirmed a real product/permission/acceptance decision gap; the local HUMAN_REQUIRED pause is decided by Brain, never derived by this seam',
      }),
    );
    assert.equal(effectiveRoute(userDecision), 'USER_DECISION_REQUIRED');
    assert.equal(userDecision.resume_target, 'producer');
    assert.equal('human_required' in userDecision, false, 'the disposition seam never derives a HUMAN_REQUIRED pause field');
    assert.equal('HUMAN_REQUIRED' in userDecision, false, 'the disposition seam never derives a HUMAN_REQUIRED pause field');
    assert.doesNotThrow(() => validateMesFactEnvelope(userDecision));

    // --- fail-closed negatives: the AUTHORITY_GAP path stays inside the closed
    // sets and the verifier claim can never be edited at arbitration time.
    assert.match(
      schemaError(validInput({ claimed_route_code: 'AUTHORITY_GAP', accepted_route_code: null }))!,
      /accepted_route_code/i,
    );
    assert.match(
      schemaError(
        validInput({
          claimed_route_code: 'AUTHORITY_GAP',
          accepted_route_code: 'AUTHORITY_GAP',
          resume_target: 'authority',
        }),
      )!,
      /resume_target/i,
    );
    assert.match(
      schemaError(
        validInput({
          claimed_route_code: 'AUTHORITY_GAP',
          accepted_route_code: 'PRODUCT_GAP',
          resume_target: 'authority-owner',
        }),
      )!,
      /accepted_route_code/i,
    );
    assert.match(
      buildError(
        validInput({
          finding: gapFinding,
          claimed_route_code: 'PLAN_GAP',
          accepted_route_code: 'AUTHORITY_GAP',
          resume_target: 'authority-owner',
        }),
      )!,
      /claimed_route_code/i,
    );
  });
});