/**
 * MES fact envelope schema regression tests (S01-A-T01).
 *
 * # PO: PO-S01-A-01, PO-S01-A-02, PO-S02-B-01
 *
 * Exercises the closed, versioned MES fact envelope and fact-kind binding
 * validator over the bounded S01 fact kinds:
 *   - valid bounded facts round-trip as typed values (PO-S01-A-01);
 *   - unknown fields, malformed values, invalid canonical refs, invalid
 *     digests, and fact-kind/binding-inconsistent envelopes fail closed
 *     (PO-S01-A-02).
 *
 * Imports the compiled runtime dist (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateMesFactEnvelope, SchemaValidationError } from '../dist/mes/validate';
import type { MesFactEnvelope } from '../dist/mes/validate';

const PLAN_REF = 'delivery/stages/S01/plan.md';
const DIGEST = 'a'.repeat(64);

/** A valid candidate (pre-accept) plan binding. */
function candidateBinding() {
  return {
    binding_stage: 'candidate' as const,
    candidate_plan_ref: PLAN_REF,
    accepted_plan_ref: null,
    verdict: 'PLAN_READY' as const,
    plan_digest: DIGEST,
  };
}

/** A valid accepted plan binding (same candidate promoted). */
function acceptedBinding() {
  return {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: PLAN_REF,
    source_candidate_plan_ref: PLAN_REF,
    verification_result_ref: 'mes:verification:S01:1',
    plan_digest: DIGEST,
  };
}

function base(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    fact_id: `mes:fact:${kind}:1`,
    fact_kind: kind,
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-003', 'tech-spec/contracts.md#2.2'],
    ...extra,
  };
}

describe('MES fact envelope schema (S01-A-T01)', () => {
  test('accepts the bounded fact envelope', () => {
    const cases: Record<string, unknown>[] = [
      base('project'),
      base('stage', { scope: { stage_id: 'S01' } }),
      base('plan_binding', { plan_binding: candidateBinding() }),
      base('plan_binding', {
        plan_binding: acceptedBinding(),
        result_ref: 'mes:acceptance:S01:1',
      }),
      base('work', {
        scope: { stage_id: 'S01', slice_id: 'S01-A', task_id: 'S01-A-T01' },
        work_id: 'mes:work:S01:1',
        plan_binding: acceptedBinding(),
        git_basis: { head: '42091fc', branch: 'proofloop-s01-a', worktree: '.' },
      }),
      base('result', {
        scope: { stage_id: 'S01', slice_id: 'S01-A', task_id: 'S01-A-T01' },
        work_id: 'mes:work:S01:1',
        result_ref: 'mes:result:S01:1',
        plan_binding: acceptedBinding(),
        git_basis: { head: '42091fc', branch: 'proofloop-s01-a', worktree: '.' },
      }),
      base('git', {
        scope: { stage_id: 'S01', slice_id: 'S01-A' },
        plan_binding: acceptedBinding(),
        git_basis: { head: '42091fc', branch: 'proofloop-s01-a', worktree: '.' },
      }),
    ];

    for (const input of cases) {
      const validated = validateMesFactEnvelope(input);
      // typed binding is preserved: schema version, kind, and binding survive
      assert.equal(validated.schema_version, 2);
      assert.equal(typeof validated.fact_id, 'string');
      assert.equal(validated.fact_kind, input.fact_kind);
      assert.ok(Array.isArray(validated.authority_refs));
      if (input.plan_binding !== undefined) {
        assert.ok(validated.plan_binding);
        assert.equal(validated.plan_binding!.binding_stage, (input.plan_binding as { binding_stage: string }).binding_stage);
      }
      // JSON round-trip preserves the typed envelope (durable fact re-read)
      const roundTripped = validateMesFactEnvelope(JSON.parse(JSON.stringify(validated)));
      assert.equal(roundTripped.fact_id, validated.fact_id);
    }
  });

  test('rejects unknown fields and invalid bindings', () => {
    // unknown field
    assert.throws(
      () => validateMesFactEnvelope(base('project', { next_action: 'run' })),
      SchemaValidationError,
    );
    // invalid canonical ref in authority_refs
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('project', { authority_refs: ['not a canonical ref'] }),
        ),
      SchemaValidationError,
    );
    // invalid digest shape
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('plan_binding', { plan_binding: { ...candidateBinding(), plan_digest: 'xyz' } }),
        ),
      SchemaValidationError,
    );
    // non-canonical stage id
    assert.throws(
      () => validateMesFactEnvelope(base('stage', { scope: { stage_id: 'S08B0' } })),
      SchemaValidationError,
    );
    // malformed slice/task id shape
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('work', {
            scope: { stage_id: 'S01', slice_id: 'slice', task_id: 'S01-A-T01' },
            work_id: 'mes:work:S01:1',
            plan_binding: acceptedBinding(),
          }),
        ),
      SchemaValidationError,
    );
    // work fact without an accepted plan binding is kind/binding-inconsistent
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('work', { work_id: 'mes:work:S01:1', plan_binding: candidateBinding() }),
        ),
      SchemaValidationError,
    );
    // work fact without any plan binding at all
    assert.throws(
      () => validateMesFactEnvelope(base('work', { work_id: 'mes:work:S01:1' })),
      SchemaValidationError,
    );
    // result fact without a result_ref
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('result', { work_id: 'mes:work:S01:1', plan_binding: acceptedBinding() }),
        ),
      SchemaValidationError,
    );
    // git fact without a git_basis
    assert.throws(
      () => validateMesFactEnvelope(base('git', { plan_binding: acceptedBinding() })),
      SchemaValidationError,
    );
    // canonical-ref root-escape forms in authority_refs: traversal, absolute
    // and backslash refs must never be accepted (CV-S01-A-F001).
    for (const badRef of [
      '../outside.md#FR-003',
      '/etc/passwd#FR-003',
      '..\\..\\outside.md#FR-003',
    ]) {
      assert.throws(
        () => validateMesFactEnvelope(base('project', { authority_refs: [badRef] })),
        SchemaValidationError,
        `authority ref ${JSON.stringify(badRef)} must be rejected`,
      );
    }
    // accepted Plan refs must be root-relative Git paths: traversal, absolute
    // and backslash forms fail closed.
    for (const badPlan of ['../../outside.md', '/abs/plan.md', 'a\\b.md']) {
      assert.throws(
        () =>
          validateMesFactEnvelope(
            base('plan_binding', {
              plan_binding: {
                ...acceptedBinding(),
                accepted_plan_ref: badPlan,
                source_candidate_plan_ref: badPlan,
              },
            }),
          ),
        SchemaValidationError,
        `accepted plan ref ${JSON.stringify(badPlan)} must be rejected`,
      );
    }
    // candidate Plan refs must be root-relative too.
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('plan_binding', {
            plan_binding: { ...candidateBinding(), candidate_plan_ref: '../outside.md' },
          }),
        ),
      SchemaValidationError,
      'candidate plan ref ../outside.md must be rejected',
    );
    // Complete NORMAL work/result binding: an accepted binding alone is not
    // enough — work_id and git_basis are both required.
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('work', {
            scope: { stage_id: 'S01' },
            plan_binding: acceptedBinding(),
            git_basis: { head: '42091fc', branch: 'b', worktree: '.' },
          }),
        ),
      SchemaValidationError,
      'NORMAL work without work_id must be rejected',
    );
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('work', {
            scope: { stage_id: 'S01' },
            work_id: 'mes:work:S01:1',
            plan_binding: acceptedBinding(),
          }),
        ),
      SchemaValidationError,
      'NORMAL work without git_basis must be rejected',
    );
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('result', {
            scope: { stage_id: 'S01' },
            result_ref: 'mes:result:S01:1',
            plan_binding: acceptedBinding(),
            git_basis: { head: '42091fc', branch: 'b', worktree: '.' },
          }),
        ),
      SchemaValidationError,
      'NORMAL result without work_id must be rejected',
    );
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('result', {
            scope: { stage_id: 'S01' },
            work_id: 'mes:work:S01:1',
            result_ref: 'mes:result:S01:1',
            plan_binding: acceptedBinding(),
          }),
        ),
      SchemaValidationError,
      'NORMAL result without git_basis must be rejected',
    );
    // candidate binding carrying a non-null accepted_plan_ref
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('plan_binding', {
            plan_binding: { ...candidateBinding(), accepted_plan_ref: PLAN_REF },
          }),
        ),
      SchemaValidationError,
    );
    // accepted binding whose source_candidate_plan_ref differs from accepted_plan_ref
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('plan_binding', {
            plan_binding: { ...acceptedBinding(), source_candidate_plan_ref: 'delivery/stages/S01/other.md' },
          }),
        ),
      SchemaValidationError,
    );
    // candidate binding carrying accepted-only field source_candidate_plan_ref
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('plan_binding', {
            plan_binding: { ...candidateBinding(), source_candidate_plan_ref: PLAN_REF },
          }),
        ),
      SchemaValidationError,
    );
    // candidate binding carrying accepted-only field verification_result_ref
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('plan_binding', {
            plan_binding: { ...candidateBinding(), verification_result_ref: 'mes:verification:S01:1' },
          }),
        ),
      SchemaValidationError,
    );
    // accepted binding carrying candidate-only field verdict
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('plan_binding', {
            plan_binding: { ...acceptedBinding(), verdict: 'PLAN_READY' },
          }),
        ),
      SchemaValidationError,
    );
    // accepted binding carrying candidate-only field candidate_plan_ref
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('plan_binding', {
            plan_binding: { ...acceptedBinding(), candidate_plan_ref: PLAN_REF },
          }),
        ),
      SchemaValidationError,
    );
    // wrong schema version
    assert.throws(
      () => validateMesFactEnvelope({ ...base('project'), schema_version: 1 }),
      SchemaValidationError,
    );
  });

  test('fails closed with SchemaValidationError on null/non-object scope and plan_binding (S01-STAGE-REVIEW-F001)', () => {
    // Malformed scope/plan_binding must yield the canonical SchemaValidationError
    // (RUNTIME.SCHEMA_MISMATCH) for every kind that requires them — a raw
    // TypeError (e.g. "Cannot read properties of null") must never escape.
    const gitBasis = { head: '42091fc', branch: 'proofloop-s01-a', worktree: '.' };
    const accepted = acceptedBinding();
    // null scope for stage
    assert.throws(
      () => validateMesFactEnvelope(base('stage', { scope: null })),
      SchemaValidationError,
    );
    // non-object scope for stage
    assert.throws(
      () => validateMesFactEnvelope(base('stage', { scope: 'not-an-object' })),
      SchemaValidationError,
    );
    // null scope for work
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('work', {
            scope: null,
            work_id: 'mes:work:S01:1',
            plan_binding: accepted,
            git_basis: gitBasis,
          }),
        ),
      SchemaValidationError,
    );
    // non-object plan_binding for work
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('work', {
            scope: { stage_id: 'S01' },
            work_id: 'mes:work:S01:1',
            plan_binding: null,
            git_basis: gitBasis,
          }),
        ),
      SchemaValidationError,
    );
    // non-object plan_binding for result (array form)
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('result', {
            scope: { stage_id: 'S01' },
            work_id: 'mes:work:S01:1',
            result_ref: 'mes:result:S01:1',
            plan_binding: [],
            git_basis: gitBasis,
          }),
        ),
      SchemaValidationError,
    );
    // non-object scope for git
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('git', {
            scope: 42,
            plan_binding: accepted,
            git_basis: gitBasis,
          }),
        ),
      SchemaValidationError,
    );
    // null plan_binding for git
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('git', {
            scope: { stage_id: 'S01' },
            plan_binding: null,
            git_basis: gitBasis,
          }),
        ),
      SchemaValidationError,
    );
  });
});

describe('MES planning verification envelope (S02-B-T01)', () => {
  const S02_PLAN_REF = 'delivery/stages/S02/plan.md';
  const GIT_BASIS = { head: 'b'.repeat(40), branch: 'proofloop-s02-b', worktree: '.' };

  function verificationEnvelope(
    verdict: string = 'PLAN_READY',
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return base('planning_verification_result', {
      result_ref: 'mes:verification:S02:1',
      work_id: 'mes:work:S02:planning:1',
      verifier_role: 'stage-plan-verifier',
      action_token: 'e790c08d',
      plan_binding: {
        binding_stage: 'candidate',
        candidate_plan_ref: S02_PLAN_REF,
        accepted_plan_ref: null,
        verdict,
        plan_digest: DIGEST,
      },
      git_basis: GIT_BASIS,
      ...extra,
    });
  }

  test('accepts a bounded planning verification fact envelope', () => {
    // Every closed verdict is a legal pre-accept SPV verdict at envelope
    // level; candidate_plan_ref is required, accepted_plan_ref must be
    // present and null, and the typed binding is preserved (PO-S02-B-01).
    for (const verdict of ['PLAN_READY', 'FINDINGS', 'BLOCKED'] as const) {
      const validated = validateMesFactEnvelope(verificationEnvelope(verdict));
      assert.equal(validated.fact_kind, 'planning_verification_result');
      assert.equal(validated.plan_binding!.binding_stage, 'candidate');
      assert.equal(validated.plan_binding!.candidate_plan_ref, S02_PLAN_REF);
      assert.equal(validated.plan_binding!.accepted_plan_ref, null);
      assert.equal((validated.plan_binding as { verdict: string }).verdict, verdict);
      assert.equal(validated.verifier_role, 'stage-plan-verifier');
      assert.equal(validated.action_token, 'e790c08d');
      assert.equal(validated.work_id, 'mes:work:S02:planning:1');
      assert.equal(validated.result_ref, 'mes:verification:S02:1');
      assert.equal(validated.git_basis!.head, 'b'.repeat(40));
      // JSON round-trip preserves the typed binding (durable fact re-read).
      const roundTripped = validateMesFactEnvelope(JSON.parse(JSON.stringify(validated)));
      assert.equal(roundTripped.fact_id, validated.fact_id);
      assert.equal(roundTripped.plan_binding!.binding_stage, 'candidate');
      assert.equal(roundTripped.action_token, 'e790c08d');
    }

    // Missing required machinery fields fail closed: verifier_role,
    // action_token, planning work identity, durable result_ref, git_basis.
    for (const missing of [
      { verifier_role: undefined },
      { action_token: undefined },
      { work_id: undefined },
      { result_ref: undefined },
      { git_basis: undefined },
      { plan_binding: undefined },
    ]) {
      const label = Object.keys(missing)[0];
      assert.throws(
        () => validateMesFactEnvelope(verificationEnvelope('PLAN_READY', missing)),
        SchemaValidationError,
        `missing ${label} must fail closed`,
      );
    }

    // Kind/binding mismatch: a pre-accept verification fact must bind a
    // candidate plan, never an accepted one.
    assert.throws(
      () =>
        validateMesFactEnvelope(
          verificationEnvelope('PLAN_READY', {
            plan_binding: {
              binding_stage: 'accepted',
              accepted_plan_ref: S02_PLAN_REF,
              source_candidate_plan_ref: S02_PLAN_REF,
              verification_result_ref: 'mes:verification:S02:1',
            },
          }),
        ),
      SchemaValidationError,
      'pre-accept verification fact with an accepted binding must be rejected',
    );
    // accepted_plan_ref must be present AND null on the candidate binding.
    assert.throws(
      () =>
        validateMesFactEnvelope(
          verificationEnvelope('PLAN_READY', {
            plan_binding: {
              binding_stage: 'candidate',
              candidate_plan_ref: S02_PLAN_REF,
              accepted_plan_ref: S02_PLAN_REF,
              verdict: 'PLAN_READY',
            },
          }),
        ),
      SchemaValidationError,
      'non-null accepted_plan_ref on a candidate binding must be rejected',
    );
    // verdict outside the closed set fails closed.
    assert.throws(
      () => validateMesFactEnvelope(verificationEnvelope('APPROVED')),
      SchemaValidationError,
    );
    // Unknown fields close the same way for the planning kinds.
    assert.throws(
      () => validateMesFactEnvelope(verificationEnvelope('PLAN_READY', { next_action: 'run' })),
      SchemaValidationError,
    );
    // verifier_role / action_token are planning-verification-scoped: other
    // fact kinds carrying them fail closed.
    assert.throws(
      () => validateMesFactEnvelope(base('project', { verifier_role: 'stage-plan-verifier' })),
      SchemaValidationError,
    );
    assert.throws(
      () => validateMesFactEnvelope(base('stage', { scope: { stage_id: 'S02' }, action_token: 'x' })),
      SchemaValidationError,
    );
    // verifier_role is a CLOSED value (mes.md / contracts.md §2.2.2:
    // `verifier_role: stage-plan-verifier`): any other non-empty string
    // fails closed, it is never a free-form label.
    for (const badRole of ['not-stage-plan-verifier', 'another-verifier', 'stage-plan-verifier2']) {
      assert.throws(
        () => validateMesFactEnvelope(verificationEnvelope('PLAN_READY', { verifier_role: badRole })),
        SchemaValidationError,
        `verifier_role ${JSON.stringify(badRole)} must fail closed`,
      );
    }
  });

  test('accepts a closed plan_binding.delivery_cycle_id and fails closed on invalid / half-new PVR/PA shapes (S05-A-T01 prerequisite)', () => {
    const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
    const cycleBinding = (verdict: string = 'PLAN_READY') => ({
      binding_stage: 'candidate' as const,
      candidate_plan_ref: S02_PLAN_REF,
      accepted_plan_ref: null,
      verdict,
      plan_digest: DIGEST,
      delivery_cycle_id: CYCLE,
    });

    // A cycle-scoped NORMAL PVR (stage-only scope + cycle) validates and the
    // cycle survives the JSON round trip (contracts §2.2.2 / mes.md).
    const pvr = validateMesFactEnvelope(
      verificationEnvelope('PLAN_READY', { scope: { stage_id: 'S02' }, plan_binding: cycleBinding() }),
    );
    assert.equal((pvr.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id, CYCLE);
    const roundTripped = validateMesFactEnvelope(JSON.parse(JSON.stringify(pvr)));
    assert.equal((roundTripped.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id, CYCLE);

    // A cycle-scoped plan_acceptance (accepted binding variant) validates too.
    const pa = validateMesFactEnvelope(
      base('plan_acceptance', {
        scope: { stage_id: 'S02' },
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S02_PLAN_REF,
          source_candidate_plan_ref: S02_PLAN_REF,
          verification_result_ref: 'mes:verification:S02:1',
          plan_digest: DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
      }),
    );
    assert.equal((pa.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id, CYCLE);

    // Closed value: empty / control characters fail closed.
    for (const badCycle of ['', 'cycle\nx', 'cycle\u0000']) {
      assert.throws(
        () =>
          validateMesFactEnvelope(
            verificationEnvelope('PLAN_READY', {
              scope: { stage_id: 'S02' },
              plan_binding: { ...cycleBinding(), delivery_cycle_id: badCycle },
            }),
          ),
        SchemaValidationError,
        `delivery_cycle_id ${JSON.stringify(badCycle)} must fail closed`,
      );
    }

    // Half-new shapes fail closed: cycle without stage-only scope, scope
    // without cycle, cycle with a slice/task scope.
    assert.throws(
      () => validateMesFactEnvelope(verificationEnvelope('PLAN_READY', { plan_binding: cycleBinding() })),
      SchemaValidationError,
      'cycle without scope must fail closed',
    );
    assert.throws(
      () => validateMesFactEnvelope(verificationEnvelope('PLAN_READY', { scope: { stage_id: 'S02' } })),
      SchemaValidationError,
      'scope without cycle must fail closed',
    );
    assert.throws(
      () =>
        validateMesFactEnvelope(
          verificationEnvelope('PLAN_READY', {
            scope: { stage_id: 'S02', slice_id: 'S02-A', task_id: 'S02-A-T01' },
            plan_binding: cycleBinding(),
          }),
        ),
      SchemaValidationError,
      'cycle with a slice/task scope must fail closed',
    );

    // The FULLY legacy shape (no scope, no cycle) stays legal — history-only
    // retained facts keep rehydrating without upgrade.
    assert.equal(
      (validateMesFactEnvelope(verificationEnvelope('PLAN_READY')).plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id,
      undefined,
    );
  });
});

describe('MES top-level delivery_cycle_id closure (S05-A-T01)', () => {
  const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
  const T_GIT_BASIS = { head: 'a'.repeat(40), branch: 'v2-herdr', worktree: '.' };

  function projectReadyCycleEnvelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return base('project_ready', {
      authority_refs: ['tech-spec/contracts.md#5.1'],
      planned_stage_ids: ['S01', 'S02', 'S03'],
      git_basis: T_GIT_BASIS,
      ...extra,
    });
  }

  test('project_ready accepts a closed TOP-LEVEL delivery_cycle_id and round-trips it; legacy terminal without the field stays read-only', () => {
    // New NORMAL terminal facts carry the cycle at TOP LEVEL (contracts
    // §5.1 / architecture delivery-cycle-semantics "Field placement is
    // closed"): the cycle field is a closed envelope field, and the
    // terminal still rejects scope/plan_binding/result_ref/work_id
    // inheritance (E2E-06).
    const validated = validateMesFactEnvelope(projectReadyCycleEnvelope({ delivery_cycle_id: CYCLE }));
    assert.equal((validated as { delivery_cycle_id?: string }).delivery_cycle_id, CYCLE);
    // JSON round-trip preserves the top-level cycle (durable fact re-read).
    const roundTripped = validateMesFactEnvelope(JSON.parse(JSON.stringify(validated)));
    assert.equal((roundTripped as { delivery_cycle_id?: string }).delivery_cycle_id, CYCLE);
    // Legacy seed/retained terminal facts WITHOUT the cycle field keep
    // rehydrating byte-equivalently as history-only (no backfill).
    const legacy = validateMesFactEnvelope(projectReadyCycleEnvelope());
    assert.equal((legacy as { delivery_cycle_id?: string }).delivery_cycle_id, undefined);
    // Closed value: empty / control characters fail closed at top level.
    for (const badCycle of ['', 'cycle\nx', 'cycle\u0000', 'c\u007f']) {
      assert.throws(
        () => validateMesFactEnvelope(projectReadyCycleEnvelope({ delivery_cycle_id: badCycle })),
        SchemaValidationError,
        `top-level delivery_cycle_id ${JSON.stringify(badCycle)} must fail closed`
      );
    }
  });

  test('a top-level delivery_cycle_id is legal ONLY on project_ready; every other kind rejects it as a plan-bound position violation', () => {
    // plan-bound facts (work/task/result/finding/git) and other kinds carry
    // the cycle INSIDE plan_binding; a top-level cycle on any non-terminal
    // kind fails closed with a plan-bound position message (contracts
    // §2.2.2 / architecture delivery-cycle-semantics "Field placement is
    // closed").
    const acceptedPb = { ...acceptedBinding(), delivery_cycle_id: CYCLE };
    const execCases: Array<[string, Record<string, unknown>]> = [
      [
        'work',
        {
          scope: { stage_id: 'S02', slice_id: 'S02-A', task_id: 'S02-A-T01' },
          work_id: 'mes:work:S02:1',
          plan_binding: acceptedPb,
          git_basis: T_GIT_BASIS,
        },
      ],
      [
        'result',
        {
          scope: { stage_id: 'S02', slice_id: 'S02-A', task_id: 'S02-A-T01' },
          work_id: 'mes:work:S02:1',
          result_ref: 'mes:result:S02:1',
          plan_binding: acceptedPb,
          git_basis: T_GIT_BASIS,
          result_id: 'r1',
          result_payload_digest: 'b'.repeat(64),
        },
      ],
      [
        'git',
        { scope: { stage_id: 'S02', slice_id: 'S02-A' }, plan_binding: acceptedPb, git_basis: T_GIT_BASIS },
      ],
      [
        'finding',
        {
          scope: { stage_id: 'S02' },
          work_id: 'mes:work:S02:1',
          plan_binding: acceptedPb,
          git_basis: T_GIT_BASIS,
          verifier_verdict: 'PASS',
          claimed_route_code: 'IMPLEMENTATION_DEFECT',
        },
      ],
    ];
    for (const [kind, facts] of execCases) {
      // The otherwise-valid plan-bound fact must reject a TOP-LEVEL cycle.
      assert.throws(
        () => validateMesFactEnvelope(base(kind, { delivery_cycle_id: CYCLE, ...facts })),
        SchemaValidationError,
        `top-level delivery_cycle_id on ${kind} must fail closed as a position violation`
      );
    }
    // recovery_baseline must not carry a top-level cycle either.
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('recovery_baseline', {
            delivery_cycle_id: CYCLE,
            recovery_id: 'r2',
            preimage_status: 'UNRECOVERABLE',
            source_snapshot_sha256: 'b'.repeat(64),
            source_fact_count: 0,
            forensic_ref: '.proofloop/forensics/f1',
            audit_ref: '.proofloop/forensics/a1',
            audit_sha256: 'c'.repeat(64),
            git_basis: T_GIT_BASIS,
            authority_refs: ['tech-spec/contracts.md#2.2.4a'],
          }),
        ),
      SchemaValidationError,
      'top-level delivery_cycle_id on recovery_baseline must fail closed',
    );
  });

  test('closes the cycle field set: plan_binding carries it for plan-bound kinds; the position rule distinguishes top-level vs plan-bound', () => {
    // A work fact may carry the cycle PLAN-BOUND (inside plan_binding) and
    // that shape remains legal — only the TOP-LEVEL position is terminal-only.
    const work = validateMesFactEnvelope(
      base('work', {
        scope: { stage_id: 'S02', slice_id: 'S02-A', task_id: 'S02-A-T01' },
        work_id: 'mes:work:S02:1',
        plan_binding: { ...acceptedBinding(), delivery_cycle_id: CYCLE },
        git_basis: T_GIT_BASIS,
      }),
    );
    assert.equal(
      (work.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id,
      CYCLE,
    );
    // The same fact with a top-level cycle (instead of plan-bound) rejects.
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('work', {
            delivery_cycle_id: CYCLE,
            scope: { stage_id: 'S02', slice_id: 'S02-A', task_id: 'S02-A-T01' },
            work_id: 'mes:work:S02:1',
            plan_binding: acceptedBinding(),
            git_basis: T_GIT_BASIS,
          }),
        ),
      SchemaValidationError,
      'top-level cycle on work is a position violation even with a plan-bound-less accepted binding present',
    );
  });
});

describe('MES supersedes_project_ready_ref terminal succession closure (S06-D-T01)', () => {
  const CYCLE = 'cycle-208cbbe8d8e946479bb746f318b56178';
  const PREV_CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
  const PREV_FACT_ID = 'mes:fact:project_ready:2';
  const T_GIT_BASIS = { head: 'a'.repeat(40), branch: 'v2-herdr', worktree: '.' };

  function terminalEnvelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return base('project_ready', {
      authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/contracts.md#/entities/current-terminal-currentness-oracle'],
      planned_stage_ids: ['S05'],
      git_basis: T_GIT_BASIS,
      ...extra,
    });
  }

  test('accepts a closed TOP-LEVEL supersedes_project_ready_ref (null chain root and exact predecessor fact_id) and round-trips it; legacy terminal shapes stay read-only', () => {
    // New chain root: no retained cycle-bearing terminal → null.
    const root = validateMesFactEnvelope(terminalEnvelope({ delivery_cycle_id: CYCLE, supersedes_project_ready_ref: null }));
    assert.equal(root.supersedes_project_ready_ref, null);
    assert.equal(validateMesFactEnvelope(JSON.parse(JSON.stringify(root))).supersedes_project_ready_ref, null, 'null round-trips byte-equivalently');
    // Chained successor: exact preceding chain-tip fact_id.
    const chained = validateMesFactEnvelope(terminalEnvelope({ delivery_cycle_id: CYCLE, supersedes_project_ready_ref: PREV_FACT_ID }));
    assert.equal(chained.supersedes_project_ready_ref, PREV_FACT_ID);
    assert.equal(validateMesFactEnvelope(JSON.parse(JSON.stringify(chained))).supersedes_project_ready_ref, PREV_FACT_ID, 'exact predecessor fact_id round-trips');
    // legacy_cycle_anchor (cycle, omitted supersedes) stays read-only.
    const anchor = validateMesFactEnvelope(terminalEnvelope({ delivery_cycle_id: PREV_CYCLE }));
    assert.equal(anchor.supersedes_project_ready_ref, undefined, 'retained pre-update anchor omits the predecessor field');
    // no-cycle legacy terminal omits both.
    const legacy = validateMesFactEnvelope(terminalEnvelope());
    assert.equal(legacy.delivery_cycle_id, undefined);
    assert.equal(legacy.supersedes_project_ready_ref, undefined);
    // Closed values: empty / control-char / non-string / non-null junk fails closed.
    for (const bad of ['', 'mes:\nx', 'mes:\u0000', 42, {}]) {
      assert.throws(
        () => validateMesFactEnvelope(terminalEnvelope({ delivery_cycle_id: CYCLE, supersedes_project_ready_ref: bad })),
        SchemaValidationError,
        `supersedes_project_ready_ref ${JSON.stringify(bad)} must fail closed`
      );
    }
  });

  test('a top-level supersedes_project_ready_ref is legal ONLY on project_ready; every other kind rejects it as a cross-kind payload / position violation', () => {
    const acceptedPb = { ...acceptedBinding(), delivery_cycle_id: CYCLE };
    const execCases: Array<[string, Record<string, unknown>]> = [
      ['work', { scope: { stage_id: 'S05', slice_id: 'S05-A', task_id: 'S05-A-T01' }, work_id: 'mes:work:S05:1', plan_binding: acceptedPb, git_basis: T_GIT_BASIS }],
      ['result', { scope: { stage_id: 'S05', slice_id: 'S05-A', task_id: 'S05-A-T01' }, work_id: 'mes:work:S05:1', result_ref: 'mes:result:S05:1', plan_binding: acceptedPb, git_basis: T_GIT_BASIS, result_id: 'r1', result_payload_digest: 'b'.repeat(64) }],
      ['git', { scope: { stage_id: 'S05', slice_id: 'S05-A' }, plan_binding: acceptedPb, git_basis: T_GIT_BASIS }],
      ['finding', { scope: { stage_id: 'S05' }, work_id: 'mes:work:S05:1', plan_binding: acceptedPb, git_basis: T_GIT_BASIS, verifier_verdict: 'PASS', claimed_route_code: 'IMPLEMENTATION_DEFECT' }],
      ['task', { scope: { stage_id: 'S05', slice_id: 'S05-A', task_id: 'S05-A-T01' }, work_id: 'mes:work:S05:1', plan_binding: acceptedPb, git_basis: T_GIT_BASIS, task_status: 'TASK_COMPLETE', depends_on_task_ids: [] }],
      ['stage', { scope: { stage_id: 'S05' }, plan_binding: acceptedPb, git_basis: T_GIT_BASIS, result_ref: 'mes:result:S05:1' }],
      ['project', {}],
      ['plan_binding', { plan_binding: acceptedPb }],
      ['finding_disposition', { scope: { stage_id: 'S05', slice_id: 'S05-A' }, plan_binding: acceptedPb, git_basis: T_GIT_BASIS, disposition_ref: 'mes:disposition:S05:1', finding_ref: 'mes:fact:finding:1', finding_disposition: 'ACCEPTED', claimed_route_code: 'IMPLEMENTATION_DEFECT', accepted_route_code: 'IMPLEMENTATION_DEFECT', basis_refs: ['tech-spec/contracts.md#2.2.3'], reason: 'ok', resume_target: 'producer' }],
    ];
    for (const [kind, facts] of execCases) {
      assert.throws(
        () => validateMesFactEnvelope(base(kind, { supersedes_project_ready_ref: PREV_FACT_ID, ...facts })),
        SchemaValidationError,
        `top-level supersedes_project_ready_ref on ${kind} must fail closed as a position violation`
      );
    }
    // recovery_baseline must not carry a top-level successor edge either.
    assert.throws(
      () =>
        validateMesFactEnvelope(
          base('recovery_baseline', {
            supersedes_project_ready_ref: PREV_FACT_ID,
            recovery_id: 'r2',
            preimage_status: 'UNRECOVERABLE',
            source_snapshot_sha256: 'b'.repeat(64),
            source_fact_count: 0,
            forensic_ref: '.proofloop/forensics/f1',
            audit_ref: '.proofloop/forensics/a1',
            audit_sha256: 'c'.repeat(64),
            git_basis: T_GIT_BASIS,
            authority_refs: ['tech-spec/contracts.md#2.2.4a'],
          }),
        ),
      SchemaValidationError,
      'top-level supersedes_project_ready_ref on recovery_baseline must fail closed',
    );
  });

  test('half-new shape: supersedes_project_ready_ref without a top-level delivery_cycle_id is invalid rather than guessed', () => {
    assert.throws(
      () => validateMesFactEnvelope(terminalEnvelope({ supersedes_project_ready_ref: PREV_FACT_ID })),
      SchemaValidationError,
      'supersedes without delivery_cycle_id must fail closed (half-new NORMAL terminal)'
    );
  });
});

// keep MesFactEnvelope referenced so the type export is exercised
export type { MesFactEnvelope };
