/**
 * MES fact-kind binding tests (S01-B-T01).
 *
 * # PO: PO-S01-B-01, PO-S01-B-02, PO-S02-B-02, PO-S02-B-03
 *
 * Exercises the fact-kind-appropriate binding validator on
 * packages/runtime/src/mes/binding.ts:
 *   - candidate/SPV binding stays pre-accept (`accepted_plan_ref: null`);
 *     only a PLAN_READY candidate may be promoted into an accepted Plan
 *     binding (PO-S01-B-01);
 *   - NORMAL execution facts require an accepted Plan binding and a real MES
 *     work identity, while PRE_MES_BOOTSTRAP facts must NOT pretend to carry
 *     a pre-seed MES work identity / resultRef (PO-S01-B-02).
 *
 * Imports the compiled runtime dist (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMesFactBinding,
  promotePlanReadyToAccepted,
  verifyPlanAcceptanceSupport,
  verifyAcceptedStageReviewResultSupport,
  SchemaValidationError,
} from '../dist/mes/binding';
import type { MesFactBindRecord } from '../dist/mes/binding';
import type { MesFactEnvelope } from '../dist/mes/store';
import { validateMesFactEnvelope } from '../dist/mes/validate';

const PLAN_REF = 'delivery/stages/S01/plan.md';
const DIGEST = 'c'.repeat(64);
const VERIFICATION_REF = 'mes:verification:S01:1';
const HEAD = 'ee9518854895a9338d3610c0b8e7384988bd7c70';

const GIT_BASIS = {
  head: HEAD,
  branch: 'proofloop-s01-b',
  worktree: '.',
};

function candidateBinding(verdict: 'PLAN_READY' | 'FINDINGS' | 'BLOCKED' = 'PLAN_READY') {
  return {
    binding_stage: 'candidate' as const,
    candidate_plan_ref: PLAN_REF,
    accepted_plan_ref: null,
    verdict,
    plan_digest: DIGEST,
  };
}

function acceptedBinding() {
  return {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: PLAN_REF,
    source_candidate_plan_ref: PLAN_REF,
    verification_result_ref: VERIFICATION_REF,
    plan_digest: DIGEST,
  };
}

function scope(stage = 'S01', slice = 'S01-B', task = 'S01-B-T01') {
  return { stage_id: stage, slice_id: slice, task_id: task };
}

describe('MES fact-kind binding (S01-B-T01)', () => {
  test('keeps candidate separate until PLAN_READY', () => {
    // A candidate binding validates and stays pre-accept: accepted_plan_ref
    // must be present and null (contracts.md §2.2.1 / §2.2.2).
    const candidate = validateMesFactBinding({
      fact_kind: 'plan_binding',
      execution_mode: 'NORMAL',
      authority_refs: ['PRD.md#FR-005'],
      plan_binding: candidateBinding('FINDINGS'),
    });
    assert.equal(candidate.plan_binding!.binding_stage, 'candidate');
    assert.equal(candidate.plan_binding!.accepted_plan_ref, null);
    assert.equal((candidate.plan_binding! as { verdict: string }).verdict, 'FINDINGS');

    // A non-null accepted_plan_ref on a candidate binding fails closed.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'plan_binding',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-005'],
          plan_binding: { ...candidateBinding(), accepted_plan_ref: PLAN_REF },
        }),
      SchemaValidationError,
    );

    // Execution-bound work in NORMAL must NOT be bound to a candidate:
    // only PLAN_READY promotion produces an accepted binding.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-005'],
          scope: scope(),
          work_id: 'mes:work:S01:1',
          plan_binding: candidateBinding('PLAN_READY'),
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );

    // Valid PLAN_READY promotion input: the same candidate ref is promoted
    // into an accepted binding carrying the verification result ref.
    const promoted = promotePlanReadyToAccepted({
      candidate: candidateBinding('PLAN_READY'),
      verification_result_ref: VERIFICATION_REF,
    });
    assert.equal(promoted.binding_stage, 'accepted');
    assert.equal(promoted.accepted_plan_ref, PLAN_REF);
    assert.equal(promoted.source_candidate_plan_ref, PLAN_REF);
    assert.equal(promoted.verification_result_ref, VERIFICATION_REF);
    assert.equal(promoted.plan_digest, DIGEST);

    // FINDINGS / BLOCKED candidates can never produce an acceptance.
    for (const verdict of ['FINDINGS', 'BLOCKED'] as const) {
      assert.throws(
        () =>
          promotePlanReadyToAccepted({
            candidate: candidateBinding(verdict),
            verification_result_ref: VERIFICATION_REF,
          }),
        SchemaValidationError,
        `verdict ${verdict} must be rejected by promotion`,
      );
    }

    // An already-accepted binding is not promotion input.
    assert.throws(
      () =>
        promotePlanReadyToAccepted({
          candidate: acceptedBinding() as never,
          verification_result_ref: VERIFICATION_REF,
        }),
      SchemaValidationError,
    );
  });

  test('distinguishes NORMAL and PRE_MES_BOOTSTRAP bindings', () => {
    // NORMAL execution fact: accepted Plan binding + MES work identity +
    // Authority refs + Git basis are all required.
    const normal = validateMesFactBinding({
      fact_kind: 'work',
      execution_mode: 'NORMAL',
      authority_refs: ['PRD.md#FR-003'],
      scope: scope(),
      work_id: 'mes:work:S01:1',
      plan_binding: acceptedBinding(),
      git_basis: GIT_BASIS,
    } satisfies MesFactBindRecord);
    assert.equal(normal.execution_mode, 'NORMAL');
    assert.equal(normal.plan_binding!.binding_stage, 'accepted');

    // NORMAL work without a MES work identity fails closed.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-003'],
          scope: scope(),
          plan_binding: acceptedBinding(),
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );

    // NORMAL result requires a durable result_ref.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'result',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-003'],
          scope: scope(),
          work_id: 'mes:work:S01:1',
          plan_binding: acceptedBinding(),
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );

    // PRE_MES_BOOTSTRAP work: no pre-seed MES work identity / resultRef
    // prerequisites — but the Git-tracked plan + Git basis are still bound.
    const bootstrap = validateMesFactBinding({
      fact_kind: 'work',
      execution_mode: 'PRE_MES_BOOTSTRAP',
      authority_refs: ['PRD.md#FR-005'],
      scope: scope(),
      plan_binding: candidateBinding('PLAN_READY'),
      git_basis: GIT_BASIS,
    });
    assert.equal(bootstrap.execution_mode, 'PRE_MES_BOOTSTRAP');
    assert.equal(bootstrap.work_id, undefined);

    // Bootstrap MUST NOT pretend to carry a pre-seed MES work identity.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'PRE_MES_BOOTSTRAP',
          authority_refs: ['PRD.md#FR-005'],
          scope: scope(),
          work_id: 'mes:work:S01:1',
          plan_binding: candidateBinding('PLAN_READY'),
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );

    // Bootstrap MUST NOT point at a MES resultRef (Link evidence only).
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'result',
          execution_mode: 'PRE_MES_BOOTSTRAP',
          authority_refs: ['PRD.md#FR-005'],
          scope: scope(),
          result_ref: 'mes:result:S01:1',
          plan_binding: candidateBinding('PLAN_READY'),
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );

    // Bootstrap still requires a Git basis (durable recovery = Git facts).
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'PRE_MES_BOOTSTRAP',
          authority_refs: ['PRD.md#FR-005'],
          scope: scope(),
          plan_binding: candidateBinding('PLAN_READY'),
        }),
      SchemaValidationError,
    );

    // Unknown mode / unknown fact kind / unknown fields fail closed — no
    // caller can bypass the closed validator by smuggling values through.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'WEIRD',
          authority_refs: ['PRD.md#FR-003'],
        }),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'manifest',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-003'],
        }),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-003'],
          next_action: 'run',
        }),
      SchemaValidationError,
    );
  });


  test('rejects non-root-relative plan refs (CV-S01-B-02)', () => {
    const traversal = [
      '../../outside.md',
      '/abs/plan.md',
      'a\\b.md',
      '..',
      'a//b.md',
      '',
      'x/../y.md',
    ];
    for (const bad of traversal) {
      assert.throws(
        () =>
          validateMesFactBinding({
            fact_kind: 'plan_binding',
            execution_mode: 'NORMAL',
            authority_refs: ['PRD.md#FR-005'],
            plan_binding: { ...candidateBinding(), candidate_plan_ref: bad },
          }),
        SchemaValidationError,
        `candidate_plan_ref must reject ${JSON.stringify(bad)}`,
      );
      assert.throws(
        () =>
          validateMesFactBinding({
            fact_kind: 'plan_binding',
            execution_mode: 'NORMAL',
            authority_refs: ['PRD.md#FR-005'],
            plan_binding: { ...acceptedBinding(), accepted_plan_ref: bad, source_candidate_plan_ref: bad },
          }),
        SchemaValidationError,
        `accepted_plan_ref must reject ${JSON.stringify(bad)}`,
      );
    }
    // source_candidate_plan_ref must also stay root-relative when it differs.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'plan_binding',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-005'],
          plan_binding: { ...acceptedBinding(), source_candidate_plan_ref: '../../other.md' },
        }),
      SchemaValidationError,
    );
  });

  test('PRE_MES execution-bound facts require a Git Plan binding (CV-S01-B-05)', () => {
    const base = {
      fact_kind: 'work' as const,
      execution_mode: 'PRE_MES_BOOTSTRAP' as const,
      authority_refs: ['PRD.md#FR-005'],
      scope: scope(),
      git_basis: GIT_BASIS,
    };
    // No plan_binding at all fails closed.
    assert.throws(() => validateMesFactBinding(base), SchemaValidationError);
    // A binding whose nested verification_result_ref points at a pre-seed MES
    // resultRef is never valid bootstrap evidence.
    assert.throws(
      () =>
        validateMesFactBinding({
          ...base,
          plan_binding: {
            binding_stage: 'accepted' as const,
            accepted_plan_ref: PLAN_REF,
            source_candidate_plan_ref: PLAN_REF,
            verification_result_ref: 'mes:result:S01:1',
          },
        }),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          ...base,
          fact_kind: 'git',
          plan_binding: {
            binding_stage: 'accepted' as const,
            accepted_plan_ref: PLAN_REF,
            source_candidate_plan_ref: PLAN_REF,
            verification_result_ref: 'mes:verification:S01:1',
          },
        }),
      SchemaValidationError,
    );
    // A valid accepted Git Plan binding with a Git-bound verification ref
    // passes, and candidate (pre-accept Git Plan) is also legal.
    const ok = validateMesFactBinding({
      ...base,
      plan_binding: {
        binding_stage: 'accepted' as const,
        accepted_plan_ref: PLAN_REF,
        source_candidate_plan_ref: PLAN_REF,
        verification_result_ref: 'bootstrap:verification:abc',
      },
    });
    assert.equal(ok.plan_binding!.binding_stage, 'accepted');
    const candidateOk = validateMesFactBinding({
      ...base,
      plan_binding: {
        binding_stage: 'candidate' as const,
        candidate_plan_ref: PLAN_REF,
        accepted_plan_ref: null,
        verdict: 'PLAN_READY' as const,
      },
    });
    assert.equal(candidateOk.plan_binding!.binding_stage, 'candidate');
  });

  test('rejects drive-relative/absolute authority refs and drive-relative plan refs (CV-S01-B-06)', () => {
    const candidate = candidateBinding();
    for (const bad of ['C:foo.md#FR-003', '/abs.md#FR-003', '../../x.md#FR-003', 'a\\b.md#FR-003', 'x#', '#FR', 'a//b.md#FR-003']) {
      assert.throws(
        () =>
          validateMesFactBinding({
            fact_kind: 'plan_binding',
            execution_mode: 'NORMAL',
            authority_refs: [bad],
            plan_binding: candidate,
          }),
        SchemaValidationError,
        `authority_refs must reject ${JSON.stringify(bad)}`,
      );
    }
    for (const bad of ['C:foo.md', '/abs.md', 'C:\\foo.md', 'C:']) {
      assert.throws(
        () =>
          validateMesFactBinding({
            fact_kind: 'plan_binding',
            execution_mode: 'NORMAL',
            authority_refs: ['PRD.md#FR-003'],
            plan_binding: { ...candidateBinding(), candidate_plan_ref: bad },
          }),
        SchemaValidationError,
        `candidate_plan_ref must reject drive/absolute ${JSON.stringify(bad)}`,
      );
    }
  });

  test('promotePlanReadyToAccepted closes unknown top-level fields (CV-S01-B-07)', () => {
    const good = {
      candidate: candidateBinding('PLAN_READY'),
      verification_result_ref: VERIFICATION_REF,
    };
    assert.equal(promotePlanReadyToAccepted(good).binding_stage, 'accepted');
    assert.throws(
      () =>
        promotePlanReadyToAccepted(
          { ...good, next_action: 'run' } as unknown as Parameters<typeof promotePlanReadyToAccepted>[0],
        ),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        promotePlanReadyToAccepted(
          { ...good, actionToken: 'x' } as unknown as Parameters<typeof promotePlanReadyToAccepted>[0],
        ),
      SchemaValidationError,
    );
  });

  test('fails closed on null/non-object scope and plan_binding (CV S01-STAGE-REVIEW-F001)', () => {
    // A null / non-object scope or plan_binding must surface as the
    // canonical fail-closed SchemaValidationError (RUNTIME.SCHEMA_MISMATCH),
    // never as a raw TypeError from property access in the kind/mode rules.
    const accepted = {
      binding_stage: 'accepted' as const,
      accepted_plan_ref: PLAN_REF,
      source_candidate_plan_ref: PLAN_REF,
      verification_result_ref: VERIFICATION_REF,
      plan_digest: DIGEST,
    };
    const gitBasis = GIT_BASIS;

    // NORMAL work: null scope / null plan_binding both fail closed.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-003'],
          scope: null,
          work_id: 'mes:work:S01:1',
          plan_binding: accepted,
          git_basis: gitBasis,
        }),
      SchemaValidationError,
      'null scope must fail closed',
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-003'],
          scope: scope(),
          work_id: 'mes:work:S01:1',
          plan_binding: null,
          git_basis: gitBasis,
        }),
      SchemaValidationError,
      'null plan_binding must fail closed',
    );

    // Non-object forms (string / array) fail closed identically.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-003'],
          scope: 'S01',
          work_id: 'mes:work:S01:1',
          plan_binding: accepted,
          git_basis: gitBasis,
        }),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-003'],
          scope: scope(),
          work_id: 'mes:work:S01:1',
          plan_binding: 'accepted',
          git_basis: gitBasis,
        }),
      SchemaValidationError,
    );

    // PRE_MES_BOOTSTRAP execution-bound facts take the same fail-closed
    // path for null scope / null plan_binding.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'PRE_MES_BOOTSTRAP',
          authority_refs: ['PRD.md#FR-005'],
          scope: null,
          plan_binding: candidateBinding('PLAN_READY'),
          git_basis: gitBasis,
        }),
      SchemaValidationError,
      'bootstrap null scope must fail closed',
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'work',
          execution_mode: 'PRE_MES_BOOTSTRAP',
          authority_refs: ['PRD.md#FR-005'],
          scope: scope(),
          plan_binding: null,
          git_basis: gitBasis,
        }),
      SchemaValidationError,
      'bootstrap null plan_binding must fail closed',
    );
  });
});

describe('MES planning fact binding (S02-B-T01)', () => {
  const PLANNING_WORK_ID = 'mes:work:S02:planning:1';
  const PLANNING_VERIFICATION_REF = 'mes:verification:S02:1';
  const ACTION_TOKEN = 'e790c08d';

  function planningVerificationRecord(
    verdict: string = 'PLAN_READY',
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      fact_kind: 'planning_verification_result',
      execution_mode: 'NORMAL',
      authority_refs: ['PRD.md#FR-005'],
      work_id: PLANNING_WORK_ID,
      result_ref: PLANNING_VERIFICATION_REF,
      verifier_role: 'stage-plan-verifier',
      action_token: ACTION_TOKEN,
      plan_binding: candidateBinding(verdict as 'PLAN_READY' | 'FINDINGS' | 'BLOCKED'),
      git_basis: GIT_BASIS,
      ...extra,
    };
  }

  test('rejects invalid planning verification facts and keeps candidate separate until PLAN_READY', () => {
    // A legal pre-accept verification fact validates and keeps the typed
    // candidate binding: accepted_plan_ref present & null, verdict preserved,
    // planning work identity, verifier_role, action_token and git_basis
    // survive (PO-S02-B-02).
    for (const verdict of ['PLAN_READY', 'FINDINGS', 'BLOCKED'] as const) {
      const record = validateMesFactBinding(planningVerificationRecord(verdict));
      assert.equal(record.fact_kind, 'planning_verification_result');
      assert.equal(record.execution_mode, 'NORMAL');
      assert.equal(record.plan_binding!.binding_stage, 'candidate');
      assert.equal(record.plan_binding!.accepted_plan_ref, null);
      assert.equal((record.plan_binding! as { verdict: string }).verdict, verdict);
      assert.equal(record.plan_binding!.candidate_plan_ref, PLAN_REF);
      assert.equal(record.work_id, PLANNING_WORK_ID);
      assert.equal(record.result_ref, PLANNING_VERIFICATION_REF);
      assert.equal(record.verifier_role, 'stage-plan-verifier');
      assert.equal(record.action_token, ACTION_TOKEN);
      assert.deepEqual(record.git_basis, GIT_BASIS);
    }

    // Kind/binding mismatch: a pre-accept verification fact must bind a
    // candidate plan, never an accepted one.
    assert.throws(
      () => validateMesFactBinding(planningVerificationRecord('PLAN_READY', { plan_binding: acceptedBinding() })),
      SchemaValidationError,
      'verification fact with an accepted binding must be rejected',
    );
    // accepted_plan_ref must be present AND null on the candidate binding.
    assert.throws(
      () =>
        validateMesFactBinding(
          planningVerificationRecord('PLAN_READY', {
            plan_binding: { ...candidateBinding('PLAN_READY'), accepted_plan_ref: PLAN_REF },
          }),
        ),
      SchemaValidationError,
    );
    // verdict outside the closed set fails closed.
    assert.throws(
      () => validateMesFactBinding(planningVerificationRecord('APPROVED')),
      SchemaValidationError,
    );
    // Missing machinery fails closed: work identity / durable ref / verifier
    // role / action token / git basis.
    for (const missing of [
      { work_id: undefined },
      { result_ref: undefined },
      { verifier_role: undefined },
      { action_token: undefined },
      { git_basis: undefined },
    ]) {
      const label = Object.keys(missing)[0];
      assert.throws(
        () => validateMesFactBinding(planningVerificationRecord('PLAN_READY', missing)),
        SchemaValidationError,
        `missing ${label} must fail closed`,
      );
    }

    // verifier_role is a CLOSED value (mes.md / contracts.md §2.2.2:
    // `verifier_role: stage-plan-verifier`): any other non-empty string
    // fails closed.
    for (const badRole of ['not-stage-plan-verifier', 'another-verifier', 'stage-plan-verifier2']) {
      assert.throws(
        () => validateMesFactBinding(planningVerificationRecord('PLAN_READY', { verifier_role: badRole })),
        SchemaValidationError,
        `binding verifier_role ${JSON.stringify(badRole)} must fail closed`,
      );
    }

    // Planning verification facts are NORMAL durable facts: PRE_MES_BOOTSTRAP
    // never writes them (mes.md Planning / finding durable facts).
    assert.throws(
      () =>
        validateMesFactBinding(
          planningVerificationRecord('PLAN_READY', { execution_mode: 'PRE_MES_BOOTSTRAP' }),
        ),
      SchemaValidationError,
    );
    // Unknown fields / unknown kinds still fail closed.
    assert.throws(
      () => validateMesFactBinding({ ...planningVerificationRecord('PLAN_READY'), next_action: 'run' }),
      SchemaValidationError,
    );
  });

  test('accepts a plan acceptance fact only after a PLAN_READY verification', () => {
    // Only a PLAN_READY candidate can be promoted; the promotion keeps the
    // same candidate ref and the verification result ref (PO-S02-B-03).
    const promoted = promotePlanReadyToAccepted({
      candidate: candidateBinding('PLAN_READY'),
      verification_result_ref: PLANNING_VERIFICATION_REF,
    });
    assert.equal(promoted.binding_stage, 'accepted');
    assert.equal(promoted.accepted_plan_ref, PLAN_REF);
    assert.equal(promoted.source_candidate_plan_ref, PLAN_REF);
    assert.equal(promoted.verification_result_ref, PLANNING_VERIFICATION_REF);

    const record = validateMesFactBinding({
      fact_kind: 'plan_acceptance',
      execution_mode: 'NORMAL',
      authority_refs: ['PRD.md#FR-005'],
      plan_binding: promoted,
      git_basis: GIT_BASIS,
    });
    assert.equal(record.plan_binding!.binding_stage, 'accepted');
    assert.equal(record.plan_binding!.accepted_plan_ref, PLAN_REF);
    assert.equal(record.plan_binding!.source_candidate_plan_ref, PLAN_REF);
    assert.equal(record.plan_binding!.verification_result_ref, PLANNING_VERIFICATION_REF);
    assert.equal(record.plan_binding!.plan_digest, DIGEST);

    // Envelope-level same chain: the PLAN_READY verification envelope
    // validates, and the acceptance envelope carries the promoted binding.
    const verificationEnvelope = {
      schema_version: 2,
      fact_id: 'mes:fact:planning_verification_result:S02:1',
      fact_kind: 'planning_verification_result',
      created_by: 'brain',
      authority_refs: ['PRD.md#FR-005'],
      result_ref: PLANNING_VERIFICATION_REF,
      work_id: PLANNING_WORK_ID,
      verifier_role: 'stage-plan-verifier',
      action_token: ACTION_TOKEN,
      plan_binding: candidateBinding('PLAN_READY'),
      git_basis: GIT_BASIS,
    };
    assert.equal(validateMesFactEnvelope(verificationEnvelope).fact_kind, 'planning_verification_result');
    const acceptanceEnvelope = {
      schema_version: 2,
      fact_id: 'mes:fact:plan_acceptance:S02:1',
      fact_kind: 'plan_acceptance',
      created_by: 'brain',
      authority_refs: ['PRD.md#FR-005'],
      plan_binding: promoted,
      git_basis: GIT_BASIS,
    };
    assert.equal(validateMesFactEnvelope(acceptanceEnvelope).plan_binding!.binding_stage, 'accepted');

    // FINDINGS / BLOCKED can never produce an acceptance: promotion refuses
    // them, and an acceptance fact must never carry a candidate binding.
    for (const verdict of ['FINDINGS', 'BLOCKED'] as const) {
      assert.throws(
        () =>
          promotePlanReadyToAccepted({
            candidate: candidateBinding(verdict),
            verification_result_ref: PLANNING_VERIFICATION_REF,
          }),
        SchemaValidationError,
      );
      assert.throws(
        () =>
          validateMesFactBinding({
            fact_kind: 'plan_acceptance',
            execution_mode: 'NORMAL',
            authority_refs: ['PRD.md#FR-005'],
            plan_binding: candidateBinding('PLAN_READY'),
            git_basis: GIT_BASIS,
          }),
        SchemaValidationError,
      );
    }

    // source_candidate_plan_ref must equal the promoted accepted_plan_ref.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'plan_acceptance',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-005'],
          plan_binding: { ...promoted, source_candidate_plan_ref: 'delivery/stages/S02/other.md' },
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        validateMesFactEnvelope({
          ...acceptanceEnvelope,
          plan_binding: { ...promoted, source_candidate_plan_ref: 'delivery/stages/S02/other.md' },
        }),
      SchemaValidationError,
    );

    // A missing verification_result_ref fails closed.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'plan_acceptance',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-005'],
          plan_binding: {
            binding_stage: 'accepted',
            accepted_plan_ref: PLAN_REF,
            source_candidate_plan_ref: PLAN_REF,
          },
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );

    // Acceptance requires a git_basis and is NORMAL-only.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'plan_acceptance',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-005'],
          plan_binding: promoted,
        }),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'plan_acceptance',
          execution_mode: 'PRE_MES_BOOTSTRAP',
          authority_refs: ['PRD.md#FR-005'],
          plan_binding: promoted,
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );
  });

  test('closes the plan acceptance support relation or fails closed (S02-SR-F001 / PO-S02-B-02 / PO-S02-B-03)', () => {
    // Relational closure (mes.md / contracts.md §2.2.2): a durable
    // plan_acceptance is supportable only by a PLAN_READY
    // planning_verification_result that agrees on the promoted candidate
    // ref, digest and the same verified Git basis. This is the pure
    // relational gate the store consults on every write.
    const verificationEnvelope = (overrides: Partial<MesFactEnvelope> = {}): MesFactEnvelope => ({
      schema_version: 2,
      fact_id: 'mes:fact:planning_verification_result:S02:2',
      fact_kind: 'planning_verification_result',
      created_by: 'brain',
      authority_refs: ['PRD.md#FR-005'],
      work_id: PLANNING_WORK_ID,
      result_ref: PLANNING_VERIFICATION_REF,
      verifier_role: 'stage-plan-verifier',
      action_token: ACTION_TOKEN,
      plan_binding: candidateBinding('PLAN_READY'),
      git_basis: GIT_BASIS,
      ...overrides,
    });
    const acceptanceEnvelope = (overrides: Partial<MesFactEnvelope> = {}): MesFactEnvelope => ({
      schema_version: 2,
      fact_id: 'mes:fact:plan_acceptance:S02:2',
      fact_kind: 'plan_acceptance',
      created_by: 'brain',
      authority_refs: ['PRD.md#FR-005'],
      // The promotion chain preserves the verification ref exactly; the
      // derived accepted binding must reference the SAME durable ref the
      // verification envelope carries.
      plan_binding: { ...acceptedBinding(), verification_result_ref: PLANNING_VERIFICATION_REF },
      git_basis: GIT_BASIS,
      ...overrides,
    });

    const support = verificationEnvelope();
    assert.equal(
      verifyPlanAcceptanceSupport(acceptanceEnvelope(), support),
      undefined,
      'a PLAN_READY candidate verification agreeing on ref/digest/head must close the relation',
    );

    // Fail-closed matrix: every broken relation returns a bounded message.
    const rejectCases: Array<{
      label: string;
      acceptance: MesFactEnvelope;
      support: MesFactEnvelope | undefined;
    }> = [
      {
        label: 'missing/unbacked verification ref',
        acceptance: acceptanceEnvelope(),
        support: undefined,
      },
      {
        label: 'FINDINGS support',
        acceptance: acceptanceEnvelope(),
        support: verificationEnvelope({ plan_binding: candidateBinding('FINDINGS') }),
      },
      {
        label: 'BLOCKED support',
        acceptance: acceptanceEnvelope(),
        support: verificationEnvelope({ plan_binding: candidateBinding('BLOCKED') }),
      },
      {
        label: 'accepted (non-candidate) support binding',
        acceptance: acceptanceEnvelope(),
        support: verificationEnvelope({ plan_binding: acceptedBinding() as never }),
      },
      {
        label: 'result_ref must exactly equal the referenced ref',
        acceptance: acceptanceEnvelope(),
        support: verificationEnvelope({ result_ref: 'mes:verification:S02:other' }),
      },
      {
        label: 'accepted_plan_ref disagrees with the verified candidate_plan_ref',
        acceptance: acceptanceEnvelope({
          plan_binding: { ...acceptedBinding(), accepted_plan_ref: 'delivery/stages/S02/other.md', source_candidate_plan_ref: 'delivery/stages/S02/other.md' },
        }),
        support,
      },
      {
        label: 'source_candidate_plan_ref disagrees with the verified candidate_plan_ref',
        acceptance: acceptanceEnvelope({
          plan_binding: { ...acceptedBinding(), source_candidate_plan_ref: 'delivery/stages/S02/other.md' },
        }),
        support,
      },
      {
        label: 'plan_digest disagreement',
        acceptance: acceptanceEnvelope({
          plan_binding: { ...acceptedBinding(), plan_digest: 'd'.repeat(64) },
        }),
        support,
      },
      {
        label: 'git_basis.head disagrees (different verified basis)',
        acceptance: acceptanceEnvelope({ git_basis: { ...GIT_BASIS, head: 'f'.repeat(40) } }),
        support,
      },
    ];
    for (const { label, acceptance, support: sup } of rejectCases) {
      const error = verifyPlanAcceptanceSupport(acceptance, sup);
      assert.ok(
        typeof error === 'string' && error.length > 0,
        `${label} must fail closed with a bounded relation message`,
      );
    }
  });

  test('promotion preserves the candidate delivery_cycle_id and the PVR->PA relation closes only on equal cycle (S05-A-T02 prerequisite)', () => {
    const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';

    // Promotion preserves the candidate's cycle (contracts §2.2.2).
    const promoted = promotePlanReadyToAccepted({
      candidate: { ...candidateBinding('PLAN_READY'), delivery_cycle_id: CYCLE },
      verification_result_ref: PLANNING_VERIFICATION_REF,
    });
    assert.equal((promoted as { delivery_cycle_id?: string }).delivery_cycle_id, CYCLE);
    // A candidate WITHOUT a cycle promotes to an accepted binding without one
    // (legacy promotion chain stays legal).
    const legacyPromoted = promotePlanReadyToAccepted({
      candidate: candidateBinding('PLAN_READY'),
      verification_result_ref: PLANNING_VERIFICATION_REF,
    });
    assert.equal((legacyPromoted as { delivery_cycle_id?: string }).delivery_cycle_id, undefined);

    const support = (cycle?: string): MesFactEnvelope =>
      ({
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:2',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-005'],
        work_id: PLANNING_WORK_ID,
        result_ref: PLANNING_VERIFICATION_REF,
        verifier_role: 'stage-plan-verifier',
        action_token: ACTION_TOKEN,
        plan_binding: {
          ...candidateBinding('PLAN_READY'),
          ...(cycle !== undefined ? { delivery_cycle_id: cycle } : {}),
        },
        git_basis: GIT_BASIS,
      }) as MesFactEnvelope;

    const acceptance = (cycle?: string): MesFactEnvelope =>
      ({
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S05:1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-005'],
        supersedes_plan_acceptance_ref: null,
        plan_binding: {
          ...acceptedBinding(),
          verification_result_ref: PLANNING_VERIFICATION_REF,
          ...(cycle !== undefined ? { delivery_cycle_id: cycle } : {}),
        },
        git_basis: GIT_BASIS,
      }) as MesFactEnvelope;

    // Same cycle closes; both-legacy (no cycle) closes too.
    assert.equal(verifyPlanAcceptanceSupport(acceptance(CYCLE), support(CYCLE)), undefined);
    assert.equal(verifyPlanAcceptanceSupport(acceptance(), support()), undefined);

    // Cross-cycle / one-sided cycle relations fail closed: a legacy
    // history-only PVR cannot underpin a cycle-scoped acceptance, and vice
    // versa (contracts §2.2.2 / architecture delivery-cycle-semantics).
    const rejectCases: Array<{ label: string; acc: MesFactEnvelope; sup: MesFactEnvelope }> = [
      { label: 'different cycles', acc: acceptance(CYCLE), sup: support('cycle-other') },
      { label: 'cycle acceptance + legacy support', acc: acceptance(CYCLE), sup: support() },
      { label: 'legacy acceptance + cycle support', acc: acceptance(), sup: support(CYCLE) },
    ];
    for (const { label, acc, sup } of rejectCases) {
      const error = verifyPlanAcceptanceSupport(acc, sup);
      assert.ok(
        typeof error === 'string' && error.includes('delivery_cycle_id'),
        `${label} must fail closed with a cycle equality message`,
      );
    }
  });

  test('closes the accepted stage ↔ Review result same-cycle binding and rejects execute/generic/opaque masquerade (S05-A-T02)', () => {
    const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
    const S05_PLAN_REF = 'delivery/stages/S05/plan.md';
    const STAGE_RESULT_REF = 'mes:result:S05:stage-review-1';
    const S05_DIGEST = 'd'.repeat(64);

    const acceptedStage = (cycle?: string): MesFactEnvelope =>
      ({
        schema_version: 2,
        fact_id: 'mes:fact:stage:S05:accepted',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        plan_binding: {
          ...acceptedBinding(),
          accepted_plan_ref: S05_PLAN_REF,
          source_candidate_plan_ref: S05_PLAN_REF,
          verification_result_ref: PLANNING_VERIFICATION_REF,
          plan_digest: S05_DIGEST,
          ...(cycle !== undefined ? { delivery_cycle_id: cycle } : {}),
        },
        git_basis: GIT_BASIS,
        result_ref: STAGE_RESULT_REF,
      }) as MesFactEnvelope;

    const reviewResult = (opts: { cycle?: string; scope?: { stage_id: string; slice_id?: string; task_id?: string }; planRef?: string } = {}): MesFactEnvelope =>
      ({
        schema_version: 2,
        fact_id: 'mes:fact:result:S05:stage-review-1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: opts.scope ?? { stage_id: 'S05' },
        work_id: 'mes:work:S05:review:1',
        result_ref: STAGE_RESULT_REF,
        plan_binding: {
          ...acceptedBinding(),
          accepted_plan_ref: opts.planRef ?? S05_PLAN_REF,
          source_candidate_plan_ref: opts.planRef ?? S05_PLAN_REF,
          verification_result_ref: PLANNING_VERIFICATION_REF,
          plan_digest: S05_DIGEST,
          ...(opts.cycle !== undefined ? { delivery_cycle_id: opts.cycle } : {}),
        },
        git_basis: GIT_BASIS,
        result_id: 'stage-review-1',
        result_payload_digest: DIGEST,
      }) as unknown as MesFactEnvelope;

    // Same-cycle accepted stage + review result closes; both-legacy (no
    // cycle) also closes (history-only, contracts §2.2.2 / scope-role
    // closure / review-result-contract).
    assert.equal(verifyAcceptedStageReviewResultSupport(acceptedStage(CYCLE), reviewResult({ cycle: CYCLE })), undefined);
    assert.equal(verifyAcceptedStageReviewResultSupport(acceptedStage(), reviewResult()), undefined);

    // Cross-cycle / one-sided cycle relations fail closed: a legacy result
    // cannot underpin a cycle-scoped accepted stage and vice versa.
    const rejectCases: Array<{ label: string; stage: MesFactEnvelope; result: MesFactEnvelope }> = [
      { label: 'different cycles', stage: acceptedStage(CYCLE), result: reviewResult({ cycle: 'cycle-other' }) },
      { label: 'cycle stage + legacy result', stage: acceptedStage(CYCLE), result: reviewResult() },
      { label: 'legacy stage + cycle result', stage: acceptedStage(), result: reviewResult({ cycle: CYCLE }) },
    ];
    for (const { label, stage, result } of rejectCases) {
      const error = verifyAcceptedStageReviewResultSupport(stage, result);
      assert.ok(
        typeof error === 'string' && error.includes('delivery_cycle_id'),
        `${label} must fail closed with a cycle equality message`,
      );
    }

    // Execute-owned results (slice/task scope) cannot masquerade as the
    // Review result even with the SAME cycle (scope-role closure /
    // review-result-contract): NORMAL result facts are Review-owned ONLY in
    // stage-only scope.
    const executeOwned = verifyAcceptedStageReviewResultSupport(
      acceptedStage(CYCLE),
      reviewResult({ cycle: CYCLE, scope: { stage_id: 'S05', slice_id: 'S05-A', task_id: 'S05-A-T01' } }),
    );
    assert.ok(
      typeof executeOwned === 'string' && /execute-owned|masquerade|Review-owned/i.test(executeOwned),
      'execute-owned result with same cycle must fail closed (masquerade)',
    );

    // Missing / cross-kind / mismatched relation fail closed no-write.
    const missing = verifyAcceptedStageReviewResultSupport(acceptedStage(CYCLE), undefined);
    assert.ok(typeof missing === 'string' && missing.includes(STAGE_RESULT_REF), 'missing result must fail closed');
    const crossKind = verifyAcceptedStageReviewResultSupport(
      acceptedStage(CYCLE),
      { ...reviewResult({ cycle: CYCLE }), fact_kind: 'work' } as MesFactEnvelope,
    );
    assert.ok(typeof crossKind === 'string' && crossKind.includes('result'), 'cross-kind result must fail closed');
    const wrongPlan = verifyAcceptedStageReviewResultSupport(
      acceptedStage(CYCLE),
      reviewResult({ cycle: CYCLE, planRef: 'delivery/stages/S02/plan.md' }),
    );
    assert.ok(typeof wrongPlan === 'string' && wrongPlan.includes('accepted_plan_ref'), 'different accepted Plan must fail closed');
    // A different stage (scope mismatch) fails closed too.
    const wrongStage = verifyAcceptedStageReviewResultSupport(
      acceptedStage(CYCLE),
      reviewResult({ cycle: CYCLE, scope: { stage_id: 'S04' } }),
    );
    assert.ok(typeof wrongStage === 'string' && wrongStage.includes('stage'), 'different stage scope must fail closed');
  });
});
