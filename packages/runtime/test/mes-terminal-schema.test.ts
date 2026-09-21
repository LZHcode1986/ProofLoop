/**
 * MES terminal fact schema tests (S04-A-T01).
 *
 * # PO: PO-S04-A-01, PO-S04-A-02
 *
 * Exercises the closed terminal fact kinds added by the Review / terminal
 * machinery seam (S04, contracts.md §2.1 / §2.1.1 / §5.1 / §7):
 *   - `project_ready` terminal fact kind joins MES_FACT_KINDS with a closed
 *     payload `planned_stage_ids` (canonical `^S\d+$` set, non-empty,
 *     de-duplicated, ascending stable) and a NORMAL-only kind binding that
 *     must NOT inherit Stage/Work/Result bindings (E2E-06): `scope` /
 *     `work_id` / `result_ref` / `plan_binding` present fail closed, as do
 *     `verifier_role` / `action_token`, missing / partial per-fact
 *     `git_basis` (head 40-hex, branch non-empty, worktree canonical
 *     root-relative) and non-canonical tech-spec `authority_refs`
 *     (PO-S04-A-01, STATIC-08/13/14);
 *   - accepted `stage` support shape is all-or-nothing (contracts.md §2.1.1 /
 *     §2.2): a `stage` fact carrying ANY of {accepted plan_binding, result_ref,
 *     git_basis} must carry the complete accepted shape — canonical Stage
 *     scope + accepted plan_binding (root-relative accepted_plan_ref,
 *     source_candidate_plan_ref equality, non-empty verification_result_ref)
 *     + git_basis + non-empty result_ref + created_by: brain. Mixed partial
 *     shapes fail closed no-write; pure scope-only `stage` facts and the
 *     existing S01/S02/S03 durable accepted stage facts rehydrate unchanged
 *     (PO-S04-A-02).
 *
 * Imports the compiled runtime dist (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateMesFactEnvelope, SchemaValidationError } from '../dist/mes/validate';
import { validateMesFactBinding, acceptedStageSupportShapeError } from '../dist/mes/binding';
import type { MesFactEnvelope } from '../dist/mes/validate';
import { verifyProjectReadySupportError, verifyProjectReadySuccessionGraphError } from '../dist/mes/terminal';

const DIGEST = 'a'.repeat(64);
const HEAD = '116c8a920240e1be14b508ccd93efc9775837a73';
const GIT_BASIS = { head: HEAD, branch: 'v2-subagent', worktree: '.' };

function base(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    fact_id: `mes:fact:${kind}:1`,
    fact_kind: kind,
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.1'],
    ...extra,
  };
}

/** A canonical tech-spec-ref-bearing project_ready terminal fact. */
function projectReadyEnvelope(
  plannedStageIds: string[] = ['S01', 'S02', 'S03'],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return base('project_ready', {
    planned_stage_ids: plannedStageIds,
    git_basis: GIT_BASIS,
    ...extra,
  });
}

/** A fully-shaped accepted `stage` support fact (S01/S02/S03 snapshot shape). */
function acceptedStageEnvelope(
  stage = 'S01',
  planRef = `delivery/stages/${stage}/plan.md`,
): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:stage:${stage}:accepted`,
    fact_kind: 'stage',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: stage },
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: planRef,
      source_candidate_plan_ref: planRef,
      verification_result_ref: 'mes:result:' + stage + ':planning-verification-1',
      plan_digest: DIGEST,
    },
    git_basis: GIT_BASIS,
    result_ref: `mes:result:${stage}:stage-review-${HEAD.slice(0, 10)}`,
  };
}

/** A scope-only (no accepted relation field) stage fact — existing fixture shape. */
function scopeOnlyStageEnvelope(stage = 'S01'): Record<string, unknown> {
  return base('stage', { scope: { stage_id: stage } });
}

describe('MES terminal fact schema (S04-A-T01)', () => {
  test('accepts a closed project_ready terminal fact and rejects inherited Stage/Work/Result bindings', () => {
    // A closed project_ready terminal fact round-trips as a typed envelope:
    // planned_stage_ids is a canonical ascending set and the per-fact
    // git_basis is the complete closed shape (PO-S04-A-01).
    const validated = validateMesFactEnvelope(projectReadyEnvelope());
    assert.equal(validated.fact_kind, 'project_ready');
    assert.deepEqual(validated.planned_stage_ids, ['S01', 'S02', 'S03']);
    assert.equal(validated.git_basis!.head, HEAD);
    // JSON round-trip preserves the durable terminal fact (restart re-read).
    const roundTripped = validateMesFactEnvelope(JSON.parse(JSON.stringify(validated)));
    assert.equal(roundTripped.fact_id, validated.fact_id);
    assert.deepEqual(roundTripped.planned_stage_ids, ['S01', 'S02', 'S03']);
    // A single-Stage planned set is legal (canonical, ascending, non-empty).
    assert.deepEqual(
      validateMesFactEnvelope(projectReadyEnvelope(['S01'])).planned_stage_ids,
      ['S01'],
    );

    // closed payload failures fail closed no-write:
    for (const bad of [
      { planned_stage_ids: undefined },
      { planned_stage_ids: [] },
      { planned_stage_ids: ['s01'] }, // non-canonical Stage ID
      { planned_stage_ids: ['S01', 'S0'] },
      { planned_stage_ids: ['S01', 'S01'] }, // duplicate
      { planned_stage_ids: ['S02', 'S01'] }, // not ascending
      { planned_stage_ids: ['S03', 'S01', 'S02'] }, // not ascending
      { planned_stage_ids: ['S01', 'S01', 'S02'] }, // duplicate + unsorted
    ]) {
      const label = Object.keys(bad)[0] + '=' + JSON.stringify((bad as never)[Object.keys(bad)[0]]);
      assert.throws(
        () => validateMesFactEnvelope(projectReadyEnvelope(undefined, bad)),
        SchemaValidationError,
        `project_ready with ${label} must fail closed`,
      );
    }

    // Terminal facts must NOT inherit Stage/Work/Result binding (E2E-06):
    // scope / work_id / result_ref / plan_binding present fail closed.
    const acceptedBinding = {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S04/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S04/plan.md',
      verification_result_ref: 'mes:result:S04:planning-verification-1',
    };
    for (const inherited of [
      { scope: { stage_id: 'S04' } },
      { work_id: 'mes:work:S04:1' },
      { result_ref: 'mes:result:S04:1' },
      { plan_binding: acceptedBinding },
    ]) {
      const label = Object.keys(inherited)[0];
      assert.throws(
        () => validateMesFactEnvelope(projectReadyEnvelope(undefined, inherited)),
        SchemaValidationError,
        `project_ready with ${label} must fail closed (no inherited binding)`,
      );
    }

    // verifier_role / action_token are planning-verification-scoped: a
    // terminal fact carrying either fails closed.
    assert.throws(
      () => validateMesFactEnvelope(projectReadyEnvelope(undefined, { verifier_role: 'stage-plan-verifier' })),
      SchemaValidationError,
    );
    assert.throws(
      () => validateMesFactEnvelope(projectReadyEnvelope(undefined, { action_token: 'tok' })),
      SchemaValidationError,
    );

    // per-fact git_basis must be the complete closed shape: head 40-hex,
    // branch non-empty, worktree canonical root-relative (missing or partial
    // basis no-write).
    for (const badBasis of [
      undefined,
      null,
      { branch: 'v2-subagent', worktree: '.' }, // missing head
      { head: 'short', branch: 'v2-subagent', worktree: '.' }, // head not 40-hex
      { head: 'Z'.repeat(40), branch: 'v2-subagent', worktree: '.' }, // uppercase hex
      { head: HEAD, worktree: '.' }, // missing branch
      { head: HEAD, branch: '' }, // empty branch
      { head: HEAD, branch: 'v2-subagent', worktree: '../outside' }, // traversal worktree
      { head: HEAD, branch: 'v2-subagent', worktree: '/abs' }, // absolute worktree
    ]) {
      assert.throws(
        () => validateMesFactEnvelope(projectReadyEnvelope(undefined, { git_basis: badBasis })),
        SchemaValidationError,
        `project_ready with git_basis ${JSON.stringify(badBasis)} must fail closed`,
      );
    }

    // authority_refs must be canonical tech-spec refs: non-tech-spec paths and
    // malformed refs fail closed.
    for (const badRefs of [
      ['PRD.md#FR-003'],
      ['tech-spec/contracts.md'], // no #section
      ['tech-spec/contracts.md#5.1', 'not-a-ref'],
    ]) {
      assert.throws(
        () => validateMesFactEnvelope(projectReadyEnvelope(undefined, { authority_refs: badRefs })),
        SchemaValidationError,
        `project_ready authority_refs ${JSON.stringify(badRefs)} must fail closed`,
      );
    }

    // unknown field / control characters / out-of-bounds path fail closed.
    assert.throws(
      () => validateMesFactEnvelope(projectReadyEnvelope(undefined, { next_action: 'run' })),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        validateMesFactEnvelope(
          projectReadyEnvelope(undefined, {
            git_basis: { head: HEAD, branch: 'v2-subagent\u0001', worktree: '.' },
          }),
        ),
      SchemaValidationError,
      'control character in git_basis.branch must fail closed',
    );
    assert.throws(
      () =>
        validateMesFactEnvelope(
          projectReadyEnvelope(undefined, {
            git_basis: { head: HEAD, branch: 'v2-subagent', worktree: '.proofloop/worktrees/S04-S04-A\n' },
          }),
        ),
      SchemaValidationError,
      'control character in git_basis.worktree must fail closed',
    );

    // project_ready is a NORMAL-only durable fact (STATIC-13/14): the binding
    // validator rejects PRE_MES_BOOTSTRAP and inherited binding fields.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'project_ready',
          execution_mode: 'PRE_MES_BOOTSTRAP',
          authority_refs: ['tech-spec/contracts.md#5.1'],
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
      'project_ready under PRE_MES_BOOTSTRAP must fail closed',
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'project_ready',
          execution_mode: 'NORMAL',
          authority_refs: ['tech-spec/contracts.md#5.1'],
          scope: { stage_id: 'S04' },
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
      'project_ready binding record with a scope must fail closed',
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'project_ready',
          execution_mode: 'NORMAL',
          authority_refs: ['tech-spec/contracts.md#5.1'],
          work_id: 'mes:work:S04:1',
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'project_ready',
          execution_mode: 'NORMAL',
          authority_refs: ['tech-spec/contracts.md#5.1'],
          result_ref: 'mes:result:S04:1',
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'project_ready',
          execution_mode: 'NORMAL',
          authority_refs: ['tech-spec/contracts.md#5.1'],
          plan_binding: acceptedBinding,
          git_basis: GIT_BASIS,
        }),
      SchemaValidationError,
    );
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'project_ready',
          execution_mode: 'NORMAL',
          authority_refs: ['tech-spec/contracts.md#5.1'],
          // no git_basis at all
        }),
      SchemaValidationError,
      'project_ready binding record without git_basis must fail closed',
    );
    // A complete NORMAL project_ready binding record validates.
    const ok = validateMesFactBinding({
      fact_kind: 'project_ready',
      execution_mode: 'NORMAL',
      authority_refs: ['tech-spec/contracts.md#5.1'],
      git_basis: GIT_BASIS,
    });
    assert.equal(ok.fact_kind, 'project_ready');
    assert.equal(ok.execution_mode, 'NORMAL');
    assert.equal(ok.scope, undefined);
    assert.equal(ok.plan_binding, undefined);
  });

  test('enforces the complete accepted stage support shape all-or-nothing and rehydrates existing accepted stage facts', () => {
    // A fully-shaped accepted stage support fact validates at both the
    // envelope and the kind-binding level (PO-S04-A-02).
    const full = acceptedStageEnvelope('S01');
    assert.equal(validateMesFactEnvelope(full).fact_kind, 'stage');
    assert.equal(
      validateMesFactBinding({
        fact_kind: 'stage',
        execution_mode: 'NORMAL',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S01' },
        plan_binding: full.plan_binding,
        git_basis: full.git_basis,
        result_ref: full.result_ref,
      }).plan_binding!.binding_stage,
      'accepted',
    );

    // Mixed/partial shapes fail closed no-write: any accepted relation field
    // (accepted plan_binding / result_ref / git_basis) without the complete
    // shape is rejected (contracts.md §2.1.1, no second Stage schema).
    const fullBinding = full.plan_binding;
    const partialCases: Array<{ label: string; extra: Record<string, unknown> }> = [
      { label: 'result_ref only', extra: { result_ref: 'mes:result:S01:1' } },
      { label: 'accepted plan_binding only', extra: { plan_binding: fullBinding } },
      { label: 'git_basis only', extra: { git_basis: GIT_BASIS } },
      {
        label: 'accepted binding + result_ref without git_basis',
        extra: { plan_binding: fullBinding, result_ref: 'mes:result:S01:1' },
      },
      {
        label: 'accepted binding + git_basis without result_ref',
        extra: { plan_binding: fullBinding, git_basis: GIT_BASIS },
      },
      {
        label: 'result_ref + git_basis without plan_binding',
        extra: { result_ref: 'mes:result:S01:1', git_basis: GIT_BASIS },
      },
      {
        label: 'accepted binding with non-root-relative accepted_plan_ref',
        extra: {
          plan_binding: { ...fullBinding, accepted_plan_ref: '../outside.md', source_candidate_plan_ref: '../outside.md' },
        },
      },
      {
        label: 'accepted binding with mismatched source_candidate_plan_ref',
        extra: {
          plan_binding: { ...fullBinding, source_candidate_plan_ref: 'delivery/stages/S01/other.md' },
        },
      },
      {
        label: 'accepted binding with empty verification_result_ref',
        extra: {
          plan_binding: { ...fullBinding, verification_result_ref: '' },
        },
      },
    ];
    for (const { label, extra } of partialCases) {
      assert.throws(
        () => validateMesFactEnvelope(base('stage', { scope: { stage_id: 'S01' }, ...extra })),
        SchemaValidationError,
        `envelope: stage fact with ${label} must fail closed`,
      );
      assert.throws(
        () =>
          validateMesFactBinding({
            fact_kind: 'stage',
            execution_mode: 'NORMAL',
            authority_refs: ['tech-spec/contracts.md#2.1.1'],
            scope: { stage_id: 'S01' },
            ...extra,
          }),
        SchemaValidationError,
        `binding: stage fact with ${label} must fail closed`,
      );
    }

    // A pure scope-only stage fact stays legal (existing mes-schema /
    // mes-store fixture baseline, machine-closed predicate).
    assert.equal(validateMesFactEnvelope(scopeOnlyStageEnvelope('S01')).fact_kind, 'stage');
    assert.equal(
      validateMesFactBinding({
        fact_kind: 'stage',
        execution_mode: 'NORMAL',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S01' },
      }).fact_kind,
      'stage',
    );

    // Existing durable S01/S02/S03 accepted stage facts (full shape from the
    // current MES snapshot) rehydrate unchanged: validation + JSON round-trip
    // keep them intact (E2E-06 snapshot replacement / restart retention).
    const snapshotShapes = [
      acceptedStageEnvelope('S01', 'delivery/stages/S01/plan.md'),
      acceptedStageEnvelope('S02', 'delivery/stages/S02/plan.md'),
      acceptedStageEnvelope('S03', 'delivery/stages/S03/plan.md'),
    ];
    for (const durable of snapshotShapes) {
      const validated = validateMesFactEnvelope(durable);
      assert.equal(validated.fact_kind, 'stage');
      assert.equal(validated.scope!.stage_id, durable.scope!.stage_id);
      assert.equal(validated.plan_binding!.binding_stage, 'accepted');
      assert.equal(validated.plan_binding!.accepted_plan_ref, durable.plan_binding!.accepted_plan_ref);
      assert.equal(validated.plan_binding!.source_candidate_plan_ref, durable.plan_binding!.accepted_plan_ref);
      assert.ok(validated.plan_binding!.verification_result_ref.length > 0);
      assert.ok(validated.result_ref !== undefined && validated.result_ref.length > 0);
      assert.ok(validated.git_basis);
      assert.equal(validated.created_by, 'brain');
      // restart re-read from the same durable JSON yields the same fact.
      const rehydrated = validateMesFactEnvelope(JSON.parse(JSON.stringify(validated)));
      assert.deepEqual(rehydrated, validated);
    }
  });

  test('closes the accepted-stage git_basis shape and project_ready tech-spec authority_refs on the binding path (CV S04-A-01)', () => {
    // The shared accepted-stage support shape predicate is the SINGLE
    // validator reused by the store write boundary: it must fail closed on
    // malformed git_basis (presence alone is not a closed shape), matching
    // closure item 4 (head/branch/worktree full set, head 40-hex, worktree
    // canonical root-relative with the trust-root `.` legal).
    const acceptedBinding = {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S01/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S01/plan.md',
      verification_result_ref: 'mes:result:S01:planning-verification-1',
      plan_digest: DIGEST,
    };
    const shape = (extra: Record<string, unknown>): string | undefined =>
      acceptedStageSupportShapeError({
        scope: { stage_id: 'S01' },
        plan_binding: acceptedBinding,
        result_ref: 'mes:result:S01:1',
        ...extra,
      });
    for (const badBasis of [
      null,
      {},
      'not-an-object',
      { head: 'short', branch: 'v2-subagent', worktree: '.' }, // head not 40-hex
      { head: HEAD, worktree: '.' }, // missing branch
      { head: HEAD, branch: 'v2-subagent' }, // missing worktree
    ]) {
      const err = shape({ git_basis: badBasis });
      assert.ok(
        typeof err === 'string' && err.length > 0,
        `acceptedStageSupportShapeError with git_basis ${JSON.stringify(badBasis)} must fail closed`,
      );
    }
    // Valid closed basis (including the trust-root `.` used by the durable
    // S01/S02/S03 accepted stage facts) closes the shape.
    assert.equal(
      shape({ git_basis: { head: HEAD, branch: 'v2-subagent', worktree: '.' } }),
      undefined,
      'a complete accepted-stage git_basis must close the support shape',
    );

    // The binding path (validateMesFactBinding) reuses the same predicate:
    // an accepted stage fact with a malformed git_basis fails closed no-write.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'stage',
          execution_mode: 'NORMAL',
          authority_refs: ['tech-spec/contracts.md#2.1.1'],
          scope: { stage_id: 'S01' },
          plan_binding: acceptedBinding,
          result_ref: 'mes:result:S01:1',
          git_basis: null,
        }),
      SchemaValidationError,
      'binding path: accepted stage with null git_basis must fail closed',
    );

    // project_ready authority_refs must be canonical tech-spec refs on the
    // binding path too (the envelope path already restricts them): a
    // non-tech-spec authority ref fails closed no-write.
    assert.throws(
      () =>
        validateMesFactBinding({
          fact_kind: 'project_ready',
          execution_mode: 'NORMAL',
          authority_refs: ['PRD.md#FR-003'],
          git_basis: { head: HEAD, branch: 'v2-subagent', worktree: '.' },
        }),
      SchemaValidationError,
      'binding path: project_ready with non-tech-spec authority_refs must fail closed',
    );
    // A tech-spec-only project_ready binding record stays legal.
    const ok = validateMesFactBinding({
      fact_kind: 'project_ready',
      execution_mode: 'NORMAL',
      authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
      git_basis: { head: HEAD, branch: 'v2-subagent', worktree: '.' },
    });
    assert.equal(ok.fact_kind, 'project_ready');
  });

  test('accepts a closed project_ready top-level delivery_cycle_id and enforces cross-fact cycle equality on accepted-stage supports (S05-D-T01 / PO-S05-D-01)', () => {
    const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
    // A new NORMAL terminal carries the opaque top-level delivery_cycle_id
    // (contracts.md §5.1 / architecture delivery-cycle-semantics): opaque
    // non-empty, round-trips byte-equivalently (restart re-read).
    const validated = validateMesFactEnvelope(projectReadyEnvelope(undefined, { delivery_cycle_id: CYCLE }));
    assert.equal(validated.delivery_cycle_id, CYCLE);
    assert.equal(
      validateMesFactEnvelope(JSON.parse(JSON.stringify(validated))).delivery_cycle_id,
      CYCLE,
    );
    // Invalid top-level cycle values fail closed no-write: empty /
    // non-string / control characters.
    for (const badCycle of ['', 42, 'cycle\u0001x']) {
      assert.throws(
        () => validateMesFactEnvelope(projectReadyEnvelope(undefined, { delivery_cycle_id: badCycle })),
        SchemaValidationError,
        `project_ready delivery_cycle_id ${JSON.stringify(badCycle)} must fail closed`
      );
    }
    // The terminal still rejects inherited Stage/Work/Result bindings even
    // with a cycle present (E2E-06).
    const inherited = [
      { scope: { stage_id: 'S04' } },
      { work_id: 'mes:work:S04:1' },
      { result_ref: 'mes:result:S04:1' },
      {
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: 'delivery/stages/S04/plan.md',
          source_candidate_plan_ref: 'delivery/stages/S04/plan.md',
          verification_result_ref: 'mes:result:S04:planning-verification-1',
        },
      },
    ];
    for (const extra of inherited) {
      assert.throws(
        () => validateMesFactEnvelope(projectReadyEnvelope(undefined, { delivery_cycle_id: CYCLE, ...extra })),
        SchemaValidationError,
        `project_ready with cycle and ${Object.keys(extra)[0]} must fail closed (no inherited binding)`
      );
    }

    // A new NORMAL accepted-stage support carries the same cycle INSIDE its
    // own plan_binding (per-kind placement: plan-bound for stage supports,
    // top-level for the terminal) and still validates.
    const supportWithCycle = (stage: string, cycle: string): MesFactEnvelope => {
      const base = acceptedStageEnvelope(stage);
      return validateMesFactEnvelope({
        ...base,
        plan_binding: { ...base.plan_binding!, delivery_cycle_id: cycle },
      });
    };
    const matching = [
      supportWithCycle('S01', CYCLE),
      supportWithCycle('S02', CYCLE),
      supportWithCycle('S03', CYCLE),
    ];
    // Cross-fact cycle equality (write invariant): a new NORMAL terminal's
    // top-level cycle ID must EXACTLY equal every accepted-stage support's
    // plan_binding.delivery_cycle_id in the SAME persisted result set.
    assert.equal(
      verifyProjectReadySupportError(validated, [...matching, validated]),
      undefined,
      'a cycle-carrying terminal with same-cycle accepted-stage supports closes',
    );
    // A mismatched support cycle fails closed no-write.
    const mismatched = [
      supportWithCycle('S01', CYCLE),
      supportWithCycle('S02', 'cycle-other'),
      supportWithCycle('S03', CYCLE),
    ];
    assert.ok(
      typeof verifyProjectReadySupportError(validated, [...mismatched, validated]) === 'string',
      'a support with a different delivery_cycle_id must fail closed',
    );
    // A legacy-shaped support (no cycle field) cannot support a
    // cycle-carrying terminal.
    const legacyShaped = [
      validateMesFactEnvelope(acceptedStageEnvelope('S01')),
      supportWithCycle('S02', CYCLE),
      supportWithCycle('S03', CYCLE),
    ];
    assert.ok(
      typeof verifyProjectReadySupportError(validated, [...legacyShaped, validated]) === 'string',
      'a support missing delivery_cycle_id must fail closed under a cycle-carrying terminal',
    );
    // Legacy terminal (no cycle field) + legacy supports (no cycle field):
    // legacy history-only read — planned-set equality still enforced, no
    // cycle check, no backfill.
    const legacyPr = validateMesFactEnvelope(projectReadyEnvelope());
    assert.equal(legacyPr.delivery_cycle_id, undefined);
    const legacySupports = [
      validateMesFactEnvelope(acceptedStageEnvelope('S01')),
      validateMesFactEnvelope(acceptedStageEnvelope('S02')),
      validateMesFactEnvelope(acceptedStageEnvelope('S03')),
    ];
    assert.equal(
      verifyProjectReadySupportError(legacyPr, [...legacySupports, legacyPr]),
      undefined,
      'a legacy terminal reads through with planned-set equality only',
    );
  });

  test('resolves each PROJECT_READY terminal to its OWN cycle-scoped accepted-stage support relation, coexisting legacy and current terminals with the same planned IDs (S05-D repair / CV S05-D-cv-1)', () => {
    const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
    // legacy supports: accepted-stage supports WITHOUT a cycle field;
    // current supports: accepted-stage supports carrying the cycle INSIDE
    // their own plan_binding (per-kind placement).
    const legacySupport = (stage: string): MesFactEnvelope =>
      validateMesFactEnvelope(acceptedStageEnvelope(stage));
    const currentSupport = (stage: string, cycle: string): MesFactEnvelope => {
      const base = acceptedStageEnvelope(stage);
      return validateMesFactEnvelope({
        ...base,
        plan_binding: { ...base.plan_binding!, delivery_cycle_id: cycle },
      });
    };
    const planned = ['S01', 'S02', 'S03'];
    const legacyPr = validateMesFactEnvelope(projectReadyEnvelope(planned));
    const currentPr = validateMesFactEnvelope(projectReadyEnvelope(planned, { delivery_cycle_id: CYCLE }));
    const legacySupports = planned.map((s) => legacySupport(s));
    const currentSupports = planned.map((s) => currentSupport(s, CYCLE));

    // Legacy + current terminals with the SAME planned Stage IDs coexist in
    // ONE persisted result set and rehydrate independently: each terminal
    // resolves its OWN relation (legacy → cycle-less supports; current →
    // same-cycle supports) — E2E-23 / STATIC-30.
    const coexisting = [...legacySupports, ...currentSupports, legacyPr, currentPr];
    assert.equal(
      verifyProjectReadySupportError(legacyPr, coexisting),
      undefined,
      'legacy terminal closes over its own cycle-less support relation',
    );
    assert.equal(
      verifyProjectReadySupportError(currentPr, coexisting),
      undefined,
      'current terminal closes over its own same-cycle support relation',
    );

    // Current terminal: a planned stage whose durable support carries a
    // DIFFERENT cycle fails closed no-write (mismatched support cycle).
    const mismatch = [
      currentSupport('S01', CYCLE),
      currentSupport('S02', 'cycle-other'),
      currentSupport('S03', CYCLE),
      legacySupport('S02'),
      legacyPr,
      currentPr,
    ];
    assert.ok(
      typeof verifyProjectReadySupportError(currentPr, mismatch) === 'string',
      'a mismatched-cycle support must fail closed for the current terminal',
    );

    // Current terminal: a planned stage whose only durable support carries a
    // MISSING cycle (legacy-shaped) fails closed no-write.
    const missingCycle = [
      currentSupport('S01', CYCLE),
      legacySupport('S02'),
      currentSupport('S03', CYCLE),
      currentPr,
    ];
    assert.ok(
      typeof verifyProjectReadySupportError(currentPr, missingCycle) === 'string',
      'a missing-cycle support must fail closed for the current terminal',
    );

    // Current terminal: EMPTY / NON-STRING support cycles fail closed
    // (defensive fail-closed on malformed shapes).
    const emptyCycle = {
      ...acceptedStageEnvelope('S02'),
      plan_binding: { ...acceptedStageEnvelope('S02').plan_binding!, delivery_cycle_id: '' },
    } as unknown as MesFactEnvelope;
    const nonStringCycle = {
      ...acceptedStageEnvelope('S02'),
      plan_binding: { ...acceptedStageEnvelope('S02').plan_binding!, delivery_cycle_id: 42 },
    } as unknown as MesFactEnvelope;
    for (const bad of [emptyCycle, nonStringCycle]) {
      assert.ok(
        typeof verifyProjectReadySupportError(currentPr, [currentSupport('S01', CYCLE), bad, currentSupport('S03', CYCLE), currentPr]) === 'string',
        'an empty/non-string support cycle must fail closed for the current terminal',
      );
    }

    // Duplicate / planned-set checks stay cycle-scoped: a duplicate
    // same-cycle support and an extra same-cycle support fail closed.
    const dup = { ...currentSupport('S01', CYCLE), fact_id: 'mes:fact:stage:S01:accepted:dup' } as MesFactEnvelope;
    assert.ok(
      typeof verifyProjectReadySupportError(currentPr, [currentSupport('S01', CYCLE), dup, currentSupport('S02', CYCLE), currentSupport('S03', CYCLE), currentPr]) === 'string',
      'a duplicate same-cycle support must fail closed',
    );
    const extra = [...currentSupports, currentSupport('S04', CYCLE), currentPr];
    assert.ok(
      typeof verifyProjectReadySupportError(currentPr, extra) === 'string',
      'an extra same-cycle support must fail closed',
    );

    // Legacy terminal: a current-cycle support can never backfill a legacy
    // terminal's relation (legacy history-only matching, no backfill).
    const legacyOnlyCurrent = [
      currentSupport('S01', CYCLE),
      currentSupport('S02', CYCLE),
      currentSupport('S03', CYCLE),
      legacyPr,
    ];
    assert.ok(
      typeof verifyProjectReadySupportError(legacyPr, legacyOnlyCurrent) === 'string',
      'a legacy terminal must not backfill cycle-carrying supports',
    );
  });

describe('MES terminal succession graph (S06-D-T01 / PO-S06-D-02)', () => {
  const CYCLE_A = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
  const CYCLE_B = 'cycle-208cbbe8d8e946479bb746f318b56178';
  const CYCLE_C = 'cycle-9f8ac4b2d1e64a01b27c3d4e5f607182';

  function terminal(
    factId: string,
    cycleId: string | undefined,
    supersedes: string | null | undefined,
  ): MesFactEnvelope {
    const extra: Record<string, unknown> = {
      fact_id: factId,
      planned_stage_ids: ['S05'],
    };
    if (cycleId !== undefined) extra.delivery_cycle_id = cycleId;
    if (supersedes !== undefined) extra.supersedes_project_ready_ref = supersedes;
    return validateMesFactEnvelope(projectReadyEnvelope(undefined, extra));
  }

  test('supersedes append: a NEW cycle-bearing terminal may chain onto the unique preceding chain tip (null root), forming ONE acyclic chain', () => {
    const root = terminal('mes:fact:project_ready:1', CYCLE_A, null);
    const successor = terminal('mes:fact:project_ready:2', CYCLE_B, root.fact_id);
    assert.equal(verifyProjectReadySuccessionGraphError([root, successor]), undefined, 'null root + exact preceding-tip ref closes');
  });

  test('legacy_cycle_anchor: a retained cycle-bearing terminal WITHOUT supersedes is a read-only compatibility root a new terminal may supersede', () => {
    // legacy_cycle_anchor: cycle present, supersedes omitted (pre-update retained).
    const anchor = terminal('mes:fact:project_ready:2', CYCLE_A, undefined);
    const successor = terminal('mes:fact:project_ready:3', CYCLE_B, anchor.fact_id);
    assert.equal(verifyProjectReadySuccessionGraphError([anchor, successor]), undefined, 'anchor root + successor closes');
    // The anchor itself stays a root: it has no predecessor edge and is never backfilled.
    assert.equal(anchor.supersedes_project_ready_ref, undefined);
  });

  test('succession graph no-write: branch (duplicate target), directed cycle, missing target, repeated cycle, cross-cycle / same-cycle edge, self-reference and multiple tips fail closed', () => {
    const root = terminal('mes:fact:project_ready:1', CYCLE_A, null);
    const s1 = terminal('mes:fact:project_ready:2', CYCLE_B, root.fact_id);

    // duplicate target (branch): two successors supersede the same predecessor.
    const s2 = terminal('mes:fact:project_ready:3', CYCLE_C, root.fact_id);
    assert.ok(
      verifyProjectReadySuccessionGraphError([root, s1, s2])?.includes('duplicate target'),
      'two successors referencing one predecessor = branch no-write',
    );

    // directed cycle: A supersedes B and B supersedes A.
    const a = terminal('mes:fact:project_ready:a', CYCLE_A, 'mes:fact:project_ready:b');
    const b = terminal('mes:fact:project_ready:b', CYCLE_B, 'mes:fact:project_ready:a');
    assert.ok(
      verifyProjectReadySuccessionGraphError([a, b])?.includes('directed cycle'),
      'mutual supersedes refs = directed cycle no-write',
    );

    // missing target: supersedes ref does not resolve to a durable terminal.
    const missing = terminal('mes:fact:project_ready:m', CYCLE_B, 'mes:fact:project_ready:ghost');
    assert.ok(
      verifyProjectReadySuccessionGraphError([root, missing])?.includes('missing target'),
      'a dangling supersedes ref = missing target no-write',
    );

    // non-terminal / no-cycle-legacy target: supersedes resolves to a legacy no-cycle terminal.
    const legacy = terminal('mes:fact:project_ready:legacy', undefined, undefined);
    const ontoLegacy = terminal('mes:fact:project_ready:n', CYCLE_B, legacy.fact_id);
    assert.ok(
      verifyProjectReadySuccessionGraphError([legacy, ontoLegacy])?.includes('non-terminal'),
      'superseding a no-cycle legacy terminal = non-terminal target no-write',
    );

    // repeated cycle: two DIFFERENT terminals share one delivery_cycle_id.
    const r1 = terminal('mes:fact:project_ready:r1', CYCLE_A, null);
    const r2 = terminal('mes:fact:project_ready:r2', CYCLE_A, null);
    assert.ok(
      verifyProjectReadySuccessionGraphError([r1, r2])?.includes('repeated delivery_cycle_id'),
      'two terminals with the same cycle = repeated cycle no-write',
    );

    // cross-cycle / same-cycle edge: a terminal supersedes a terminal of the SAME cycle.
    const c1 = terminal('mes:fact:project_ready:c1', CYCLE_A, null);
    const c2 = terminal('mes:fact:project_ready:c2', CYCLE_A, c1.fact_id);
    assert.ok(
      verifyProjectReadySuccessionGraphError([c1, c2]) !== undefined,
      'a same-cycle supersedes edge (cross-cycle required) no-write',
    );

    // self-reference.
    const self = terminal('mes:fact:project_ready:self', CYCLE_A, 'mes:fact:project_ready:self');
    assert.ok(
      verifyProjectReadySuccessionGraphError([self])?.includes('supersedes itself'),
      'self-reference no-write',
    );

    // multiple tips: two disjoint chains (two null roots).
    const t1 = terminal('mes:fact:project_ready:t1', CYCLE_A, null);
    const t2 = terminal('mes:fact:project_ready:t2', CYCLE_B, null);
    assert.ok(
      verifyProjectReadySuccessionGraphError([t1, t2])?.includes('unique tip'),
      'two roots = multiple tips no-write',
    );
  });

  test('restart-rebuilds-same-chain: revalidating the SAME durable facts after a JSON round-trip rebuilds the identical chain verdict and unique tip', () => {
    const root = terminal('mes:fact:project_ready:1', CYCLE_A, null);
    const successor = terminal('mes:fact:project_ready:2', CYCLE_B, root.fact_id);
    const facts = [root, successor];
    // Durable facts re-read after restart are re-validated byte-identically; the
    // succession graph is a pure function of the SAME durable set.
    const rehydrated = facts.map((fact) => validateMesFactEnvelope(JSON.parse(JSON.stringify(fact))));
    assert.equal(verifyProjectReadySuccessionGraphError(rehydrated), undefined, 'restart re-validates the same chain');
    // Unique tip is deterministic: exactly one cycle-bearing terminal not referenced
    // as a predecessor by any successor.
    const referenced = new Set(
      rehydrated
        .filter((f) => typeof f.supersedes_project_ready_ref === 'string')
        .map((f) => f.supersedes_project_ready_ref as string),
    );
    const tips = rehydrated.filter(
      (f) =>
        typeof f.delivery_cycle_id === 'string' &&
        f.delivery_cycle_id.length > 0 &&
        !referenced.has(f.fact_id),
    );
    assert.deepEqual(tips.map((t) => t.fact_id), [successor.fact_id], 'restart rebuilds the same unique tip');
  });
});
});
