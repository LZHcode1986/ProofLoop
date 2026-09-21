/**
 * MES status projection tests (S01-C-T01).
 *
 * # PO: PO-S01-C-01, PO-S01-C-02, PO-S01-C-05, PO-S02-B-04, PO-S02-B-05
 *
 * Exercises the pure status/detail projections on
 * packages/runtime/src/mes/status.ts:
 *   - the sparse primary projection exposes ONLY scope / phase /
 *     required_skill and the non-zero anomaly counters; zero counters are
 *     omitted and the counters field is absent when nothing is non-zero
 *     (PO-S01-C-01);
 *   - the bounded detail projection is read-only (never mutates its input
 *     or the durable facts) and deterministic, emits no next_action / route /
 *     reasoning, and rejects any input that carries such routing fields
 *     (PO-S01-C-02);
 *   - the first `NORMAL READ STATUS` deterministically rebuilds the
 *     seed-provided scope / phase / required_skill tuple (and sparse
 *     counters) from the durable bootstrap seed facts without inference
 *     (PO-S01-C-05).
 *
 * All tests use only temporary Git fixtures (helpers.ts#makeFixture) and
 * never the work clone's Git state. Imports the compiled runtime dist
 * (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectSparseStatus,
  projectDetailStatus,
  formatSparseStatus,
  formatDetailStatus,
  MesStatusError,
  projectCycleFilteredStatus,
  projectCycleFilteredDetail,
  projectTerminalAdjunct,
  formatProjectTerminalAdjunct,
} from '../dist/mes/status';
import type { MesSparseStatus, MesDetailStatus, MesProjectTerminalAdjunct } from '../dist/mes/status';
import type { MesFactEnvelope } from '../dist/mes/types';
import { seedMesBootstrap, readMesSeedRecord, MesBootstrapError, MES_STATUS_PHASES } from '../dist/mes/bootstrap';
import type { MesBootstrapSeedInput } from '../dist/mes/bootstrap';
import { makeFixture, commitAll, sha } from './helpers';

const PLAN_REF = 'delivery/stages/S01/plan.md';
const DIGEST = sha('plan-v1');

/** A full seed-record-shaped input (as persisted by the bootstrap seed). */
function seedRecordInput(): {
  readonly schema_version: 2;
  readonly seed_id: string;
  readonly authority_refs: readonly string[];
  readonly accepted_plan_ref: string;
  readonly plan_digest: string;
  readonly git_basis: { head: string; branch: string; worktree: string };
  readonly status: {
    scope: string;
    phase: string;
    required_skill: string;
    counters: { replan: number; blocked: number; finding: number };
  };
} {
  return {
    schema_version: 2,
    seed_id: 'seed-1',
    authority_refs: ['PRD.md#FR-003', 'tech-spec/contracts.md#2.2.1'],
    accepted_plan_ref: PLAN_REF,
    plan_digest: DIGEST,
    git_basis: {
      head: 'a'.repeat(40),
      branch: 'proofloop-s01-c',
      worktree: '.',
    },
    status: {
      scope: 'S01',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
      counters: { replan: 0, blocked: 1, finding: 2 },
    },
  };
}

function seedInput(
  fixture: { head: string; branch: string },
  overrides: Partial<MesBootstrapSeedInput> = {},
): MesBootstrapSeedInput {
  return {
    authority_refs: ['PRD.md#FR-003', 'tech-spec/contracts.md#2.2.1'],
    accepted_plan_ref: PLAN_REF,
    plan_digest: DIGEST,
    git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
    status: {
      scope: 'S01',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
      counters: { replan: 0, blocked: 1, finding: 2 },
    },
    ...overrides,
  };
}

describe('MES status projection (S01-C-T01)', () => {
  test('omits zero anomaly counters from sparse status', () => {
    const status = projectSparseStatus({
      scope: 'S01',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
      counters: {
        replan: 0,
        blocked: 1,
        finding: 2,
        repair: 0,
        recovery: 0,
        human_required: 0,
        cleanup: 0,
      },
    });
    assert.equal(status.scope, 'S01');
    assert.equal(status.phase, 'EXECUTE');
    assert.equal(status.required_skill, 'proofloop-execute');
    // Zero counters are omitted; only the non-zero ones surface.
    assert.deepEqual(status.counters, { blocked: 1, finding: 2 });
    assert.deepEqual(
      Object.keys(status.counters!),
      ['blocked', 'finding'],
      'counters must follow the canonical MES_ANOMALY_COUNTERS order',
    );

    // A zero-only counter set yields NO counters field at all.
    const zeroOnly = projectSparseStatus({
      scope: 'S02',
      phase: 'REVIEW',
      required_skill: 'stage-reviewer',
      counters: { replan: 0, blocked: 0 },
    });
    assert.equal(zeroOnly.counters, undefined, 'zero-only counters field must be omitted');

    // Absent counters are equally omitted.
    const noCounters = projectSparseStatus({
      scope: 'S01',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
    });
    assert.equal(noCounters.counters, undefined);
  });

  test('projects deterministic detail without mutation or next action', () => {
    const input = seedRecordInput();
    const snapshot = JSON.parse(JSON.stringify(input));

    const first: MesDetailStatus = projectDetailStatus(input);
    const second: MesDetailStatus = projectDetailStatus(input);

    // Deterministic: the same input always yields the same bounded detail.
    assert.deepEqual(first, second);
    assert.equal(formatDetailStatus(first), formatDetailStatus(second));

    // Read-only: the projection never mutates its input / durable facts.
    assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot, 'detail projection must not mutate its input');

    // Bounded L2 fields: scope/phase/required_skill + sparse counters + the
    // allowed Git/Plan detail that the durable seed facts actually carry.
    assert.equal(first.scope, 'S01');
    assert.equal(first.phase, 'EXECUTE');
    assert.equal(first.required_skill, 'proofloop-execute');
    assert.deepEqual(first.counters, { blocked: 1, finding: 2 });
    assert.equal(first.git_basis?.head, 'a'.repeat(40));
    assert.equal(first.git_basis?.branch, 'proofloop-s01-c');
    assert.equal(first.git_basis?.worktree, '.');
    assert.equal(first.accepted_plan_ref, PLAN_REF);
    assert.equal(first.plan_digest, DIGEST);

    // No next_action / route / reasoning anywhere in the output.
    const keys = (value: unknown, path = ''): string[] => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
      return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
        path ? `${path}.${key}` : key,
        ...keys(entry, path ? `${path}.${key}` : key),
      ]);
    };
    const allKeys = keys(first);
    for (const forbidden of ['next_action', 'route', 'reasoning']) {
      assert.equal(
        allKeys.includes(forbidden),
        false,
        `detail output must not contain "${forbidden}"`,
      );
    }

    // Fail closed: input carrying routing/decision fields is rejected.
    assert.throws(() => projectDetailStatus({ ...input, next_action: 'run' }), MesStatusError);
    assert.throws(
      () =>
        projectDetailStatus({
          ...input,
          status: { ...input.status, route: 'somewhere' },
        }),
      MesStatusError,
    );
    assert.throws(
      () =>
        projectDetailStatus({
          ...input,
          status: { ...input.status, reasoning: 'because' },
        }),
      MesStatusError,
    );
    assert.throws(
      () =>
        projectDetailStatus({
          ...input,
          git_basis: { ...input.git_basis, extra: 1 },
        }),
      MesStatusError,
    );
  });

  test('rejects control characters / newline injection in status text fields', () => {
    // S01-STAGE-REVIEW-F001: status tuple fields must fail closed on control
    // characters / newline injection so human/JSON output can never emit
    // routing or next-action content. Each of these would otherwise render a
    // fabricated `next_action=...` / `route=...` line in the human view.
    const payloads: Array<[string, Record<string, unknown>]> = [
      ['phase newline', { scope: 'S01', phase: 'EXECUTE\nnext_action=run', required_skill: 'proofloop-execute' }],
      ['phase CRLF', { scope: 'S01', phase: 'EXECUTE\r\nroute=somewhere', required_skill: 'proofloop-execute' }],
      ['phase LINE SEPARATOR U+2028', { scope: 'S01', phase: 'EXECUTE\u2028next_action=run', required_skill: 'proofloop-execute' }],
      ['phase PARAGRAPH SEPARATOR U+2029', { scope: 'S01', phase: 'EXECUTE\u2029route=somewhere', required_skill: 'proofloop-execute' }],
      ['required_skill DEL', { scope: 'S01', phase: 'EXECUTE', required_skill: 'sk\x7fkill' }],
      ['required_skill tab', { scope: 'S01', phase: 'EXECUTE', required_skill: 'proofloop-\texecute' }],
    ];
    for (const [label, payload] of payloads) {
      assert.throws(() => projectSparseStatus(payload), MesStatusError, `${label} must be rejected`);
    }

    // Detail fields (Git basis / accepted plan ref / plan digest) share the
    // same fail-closed text boundary.
    const detailBase = {
      schema_version: 2,
      seed_id: 'seed-1',
      authority_refs: ['PRD.md#FR-003'],
      accepted_plan_ref: PLAN_REF,
      plan_digest: DIGEST,
      git_basis: { head: 'a'.repeat(40), branch: 'main', worktree: '.' },
      status: { scope: 'S01', phase: 'EXECUTE', required_skill: 'proofloop-execute' },
    };
    assert.throws(
      () =>
        projectDetailStatus({
          ...detailBase,
          git_basis: { ...detailBase.git_basis, worktree: '.\nroute=evil' },
        }),
      MesStatusError,
      'git_basis.worktree newline must be rejected',
    );
    assert.throws(
      () => projectDetailStatus({ ...detailBase, git_basis: { ...detailBase.git_basis, worktree: '.\u2028route=evil' } }),
      MesStatusError,
      'git_basis.worktree U+2028 must be rejected',
    );
    assert.throws(
      () => projectDetailStatus({ ...detailBase, git_basis: { ...detailBase.git_basis, worktree: '.\u2029route=evil' } }),
      MesStatusError,
      'git_basis.worktree U+2029 must be rejected',
    );
    assert.throws(
      () => projectDetailStatus({ ...detailBase, accepted_plan_ref: 'plan.md\nnext_action=x' }),
      MesStatusError,
      'accepted_plan_ref newline must be rejected',
    );
    assert.throws(
      () => projectDetailStatus({ ...detailBase, plan_digest: 'digest\nroute=y' }),
      MesStatusError,
      'plan_digest newline must be rejected',
    );
    assert.throws(
      () => projectDetailStatus({ ...detailBase, git_basis: { ...detailBase.git_basis, head: 'a\tb' } }),
      MesStatusError,
      'git_basis.head control character must be rejected',
    );

    // No false positives: ordinary printable text (including spaces) is fine.
    const ok = projectDetailStatus({
      ...detailBase,
      git_basis: { head: 'b'.repeat(40), branch: 'feature/topic', worktree: 'packages/runtime/src' },
    });
    assert.equal(ok.git_basis?.worktree, 'packages/runtime/src');
    assert.equal(ok.git_basis?.branch, 'feature/topic');
  });

  test('projects the seeded tuple for the first NORMAL READ STATUS', () => {
    const fixture = makeFixture();
    try {
      const commit = commitAll(fixture, 'baseline');
      seedMesBootstrap(fixture.dir, seedInput({ head: commit, branch: 'master' }));

      // The first NORMAL READ STATUS rebuilds the Brain-supplied tuple from
      // the durable seed facts — no inference, no pre-seed MES prerequisites.
      const record = readMesSeedRecord(fixture.dir)!;
      const sparse: MesSparseStatus = projectSparseStatus(record.status);
      assert.equal(sparse.scope, 'S01');
      assert.equal(sparse.phase, 'EXECUTE');
      assert.equal(sparse.required_skill, 'proofloop-execute');
      assert.deepEqual(sparse.counters, { blocked: 1, finding: 2 }, 'zero counters hidden in first status');

      const detail: MesDetailStatus = projectDetailStatus(record);
      assert.equal(detail.git_basis?.head, commit);
      assert.equal(detail.accepted_plan_ref, PLAN_REF);
      assert.equal(detail.plan_digest, DIGEST);
      assert.deepEqual(detail.counters, { blocked: 1, finding: 2 }, 'zero counters stay hidden');
      void detail;

      // The human-readable projection is deterministic and carries the same
      // sparse facts (no route/next-action/reasoning text).
      const human = formatSparseStatus(sparse);
      assert.equal(human.split('\n')[0], 'S01 / EXECUTE');
      assert.equal(human.includes('skill=proofloop-execute'), true);
      assert.equal(human.includes('blocked=1'), true);
      assert.equal(human.includes('finding=2'), true);
      assert.equal(human.includes('replan=0'), false, 'zero counters never render');
      assert.equal(human.includes('next_action'), false);
      assert.equal(human.includes('route='), false);
    } finally {
      fixture.cleanup();
    }
  });

  test('accepts only the closed per-stage phase set', () => {
    // PO-S02-B-04: the status tuple phase is closed over contracts.md §5.1
    // (PROPOSE / PLANNING / EXECUTE / REVIEW / STAGE_ACCEPTED). The
    // projection only VALIDATES the Brain-supplied tuple — it never derives
    // or migrates a phase.
    for (const phase of ['PROPOSE', 'PLANNING', 'EXECUTE', 'REVIEW', 'STAGE_ACCEPTED']) {
      const sparse = projectSparseStatus({ scope: 'S01', phase, required_skill: 'proofloop-plan' });
      assert.equal(sparse.phase, phase);
    }
    for (const bad of ['BOGUS', '', 'COOKING', 'exECUTE', 'STAGE_READY', undefined]) {
      assert.throws(
        () => projectSparseStatus({ scope: 'S01', phase: bad as string, required_skill: 'proofloop-plan' }),
        MesStatusError,
        `phase ${JSON.stringify(bad)} must fail closed`,
      );
    }
    // The durable seed path shares the closure: seeding with an unknown
    // phase fails closed before anything is persisted.
    const fixture = makeFixture();
    try {
      const commit = commitAll(fixture, 'baseline');
      assert.throws(
        () =>
          seedMesBootstrap(
            fixture.dir,
            seedInput(
              { head: commit, branch: 'master' },
              { status: { scope: 'S01', phase: 'BOGUS', required_skill: 'proofloop-plan' } },
            ),
          ),
        MesBootstrapError,
        'seed with unknown phase must fail closed',
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('projects planning binding detail without routing fields or mutation', () => {
    // PO-S02-B-05: the bounded detail view may carry the candidate/accepted
    // Plan refs and the planning verification result ref, stays read-only,
    // deterministic and fail-closed, and never emits route / next-action /
    // reasoning.
    const input = {
      schema_version: 2,
      seed_id: 'seed-planning-1',
      authority_refs: ['PRD.md#FR-005', 'tech-spec/contracts.md#2.2.2'],
      accepted_plan_ref: PLAN_REF,
      candidate_plan_ref: 'delivery/stages/S02/plan.md',
      planning_verification_result_ref: 'mes:verification:S02:1',
      plan_digest: DIGEST,
      git_basis: { head: 'a'.repeat(40), branch: 'proofloop-s02-b', worktree: '.' },
      status: { scope: 'S02', phase: 'PLANNING', required_skill: 'proofloop-plan' },
    };
    const snapshot = JSON.parse(JSON.stringify(input));

    const first: MesDetailStatus = projectDetailStatus(input);
    const second: MesDetailStatus = projectDetailStatus(input);
    assert.deepEqual(first, second, 'deterministic detail projection');
    assert.equal(formatDetailStatus(first), formatDetailStatus(second));
    assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot, 'detail projection must not mutate its input');

    assert.equal(first.phase, 'PLANNING');
    assert.equal(first.accepted_plan_ref, PLAN_REF);
    assert.equal(first.candidate_plan_ref, 'delivery/stages/S02/plan.md');
    assert.equal(first.planning_verification_result_ref, 'mes:verification:S02:1');
    assert.equal(first.plan_digest, DIGEST);
    assert.equal(first.git_basis?.head, 'a'.repeat(40));

    const rendered = formatDetailStatus(first);
    assert.ok(rendered.includes('candidate_plan_ref=delivery/stages/S02/plan.md'), rendered);
    assert.ok(rendered.includes('planning_verification_result_ref=mes:verification:S02:1'), rendered);
    for (const forbidden of ['next_action', 'route', 'reasoning']) {
      assert.equal(rendered.includes(forbidden), false, `rendered detail must not contain ${forbidden}`);
    }

    // Seed durable round-trip: the seed record can durably carry the
    // planning binding and the detail projection re-exposes it without
    // writing anything.
    const fixture = makeFixture();
    try {
      const commit = commitAll(fixture, 'baseline');
      const seeded = seedMesBootstrap(fixture.dir, {
        authority_refs: ['PRD.md#FR-005'],
        accepted_plan_ref: PLAN_REF,
        candidate_plan_ref: 'delivery/stages/S02/plan.md',
        planning_verification_result_ref: 'mes:verification:S02:1',
        plan_digest: DIGEST,
        git_basis: { head: commit, branch: 'master', worktree: '.' },
        status: { scope: 'S02', phase: 'PLANNING', required_skill: 'proofloop-plan' },
      });
      assert.equal(seeded.candidate_plan_ref, 'delivery/stages/S02/plan.md');
      const detail = projectDetailStatus(readMesSeedRecord(fixture.dir)!);
      assert.equal(detail.candidate_plan_ref, 'delivery/stages/S02/plan.md');
      assert.equal(detail.planning_verification_result_ref, 'mes:verification:S02:1');
    } finally {
      fixture.cleanup();
    }

    // Unknown / routing fields fail closed, including inside the new detail
    // fields and the status tuple.
    assert.throws(() => projectDetailStatus({ ...input, candidate_plan_ref: 'plan.md\nroute=evil' }), MesStatusError);
    assert.throws(() => projectDetailStatus({ ...input, planning_verification_result_ref: 'x\u2028route=evil' }), MesStatusError);
    assert.throws(() => projectDetailStatus({ ...input, unknown_thing: 1 }), MesStatusError);
    assert.throws(() => projectDetailStatus({ ...input, status: { ...input.status, route: 'x' } }), MesStatusError);
  });
});

describe('MES cycle-filtered status currentness (S05-C-T01)', () => {
  // PO-S05-C-01 / PO-S05-C-02 (status layer currentness): status selects
  // the current Stage from the UNIQUE in-flight candidate/accepted Plan
  // binding's delivery_cycle_id + stage-only scope.stage_id, then filters
  // same-cycle facts by scope shape — stage-only Review work/result/finding
  // → REVIEW; task or slice/task-scoped execution facts → EXECUTE; else the
  // current planning binding → PLANNING (mes.md / contracts §2.3,
  // architecture delivery-cycle-semantics). Missing / duplicate /
  // cross-cycle / no stage provenance fail closed typed AUTHORITY_GAP; the
  // `task` fact participates in the current-scope candidate.
  const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
  const S05_PLAN = 'delivery/stages/S05/plan.md';
  const S05_DIGEST = sha('s05-plan-v1');
  const BASIS = { head: 'a'.repeat(40), branch: 'v2-subagent', worktree: '.' };
  const ACCEPTED = {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: S05_PLAN,
    source_candidate_plan_ref: S05_PLAN,
    verification_result_ref: 'mes:result:S05:planning-verification-1',
    plan_digest: S05_DIGEST,
    delivery_cycle_id: CYCLE,
  };
  const CANDIDATE = {
    binding_stage: 'candidate' as const,
    candidate_plan_ref: S05_PLAN,
    accepted_plan_ref: null,
    verdict: 'PLAN_READY' as const,
    plan_digest: S05_DIGEST,
    delivery_cycle_id: CYCLE,
  };

  function pvr(overrides: Record<string, unknown> = {}): MesFactEnvelope {
    return {
      schema_version: 2,
      fact_id: 'mes:fact:planning_verification_result:S05:1',
      fact_kind: 'planning_verification_result',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: 'S05' },
      work_id: 'mes:work:S05:planning:1',
      result_ref: 'mes:result:S05:planning-verification-1',
      verifier_role: 'stage-plan-verifier',
      action_token: 's05-spv-1',
      plan_binding: CANDIDATE,
      git_basis: BASIS,
      ...overrides,
    };
  }
  function pa(overrides: Record<string, unknown> = {}): MesFactEnvelope {
    return {
      schema_version: 2,
      fact_id: 'mes:fact:plan_acceptance:S05:1',
      fact_kind: 'plan_acceptance',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: 'S05' },
      plan_binding: ACCEPTED,
      git_basis: BASIS,
      ...overrides,
    };
  }
  function workFact(scope: Record<string, unknown> = { stage_id: 'S05', slice_id: 'S05-C' }): MesFactEnvelope {
    return {
      schema_version: 2,
      fact_id: 'mes:fact:work:S05:S05-C:1',
      fact_kind: 'work',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: scope as unknown as MesFactEnvelope['scope'],
      work_id: 'mes:work:S05:S05-C:1',
      plan_binding: ACCEPTED,
      git_basis: BASIS,
    };
  }
  function taskFact(): MesFactEnvelope {
    return {
      schema_version: 2,
      fact_id: 'mes:fact:task:S05:S05-C-T01:1',
      fact_kind: 'task',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#5.1'],
      scope: { stage_id: 'S05', slice_id: 'S05-C', task_id: 'S05-C-T01' },
      work_id: 'mes:work:S05:S05-C:1',
      plan_binding: ACCEPTED,
      git_basis: BASIS,
      task_status: 'TASK_COMPLETE' as const,
      depends_on_task_ids: [],
    };
  }
  function reviewResult(): MesFactEnvelope {
    return {
      schema_version: 2,
      fact_id: 'mes:fact:result:S05:stage-review-1',
      fact_kind: 'result',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.1.1'],
      scope: { stage_id: 'S05' },
      work_id: 'mes:work:S05:review:1',
      result_ref: 'mes:result:S05:stage-review-1',
      plan_binding: ACCEPTED,
      git_basis: BASIS,
      result_id: 'stage-review-1',
      result_payload_digest: DIGEST,
    };
  }
  function acceptedStageFact(): MesFactEnvelope {
    return {
      schema_version: 2,
      fact_id: 'mes:fact:stage:S05:accepted',
      fact_kind: 'stage',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.1.1'],
      scope: { stage_id: 'S05' },
      plan_binding: ACCEPTED,
      git_basis: BASIS,
      result_ref: 'mes:result:S05:stage-review-1',
    };
  }
  function legacyStageSupport(stage: string): MesFactEnvelope {
    return {
      schema_version: 2,
      fact_id: `mes:fact:stage:${stage}:accepted`,
      fact_kind: 'stage',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.1.1'],
      scope: { stage_id: stage },
      plan_binding: {
        binding_stage: 'accepted' as const,
        accepted_plan_ref: `delivery/stages/${stage}/plan.md`,
        source_candidate_plan_ref: `delivery/stages/${stage}/plan.md`,
        verification_result_ref: `mes:result:${stage}:planning-verification-1`,
        plan_digest: DIGEST,
      },
      git_basis: BASIS,
      result_ref: `mes:result:${stage}:stage-review`,
    };
  }

  test('projects the unique in-flight cycle-filtered phase from durable facts', () => {
    // PLANNING: candidate/accepted planning binding only.
    const planning = projectCycleFilteredStatus([pvr(), pa()]);
    assert.deepEqual(planning, {
      cycle_id: CYCLE,
      scope: 'S05',
      phase: 'PLANNING',
      required_skill: 'proofloop-plan',
    });

    // EXECUTE: slice/task-scoped execution facts (work + task).
    const execute = projectCycleFilteredStatus([pvr(), pa(), workFact(), taskFact()]);
    assert.deepEqual(execute, {
      cycle_id: CYCLE,
      scope: 'S05',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
    });

    // The `task` fact must participate in the current-scope candidate:
    // a task fact alone shifts the phase to EXECUTE.
    const taskOnly = projectCycleFilteredStatus([pvr(), pa(), taskFact()]);
    assert.equal(taskOnly.phase, 'EXECUTE');
    assert.equal(taskOnly.scope, 'S05');


    // (EC-3 positive / CV S05-C-cv-1) The legal promotion lifecycle is
    // exactly ONE plan identity: one candidate PVR + one accepted PA of the
    // SAME plan — and a same-plan SPV retry (duplicate PVR, same digest) is
    // the same binding, never duplicate provenance.
    const retryPvr = pvr({ fact_id: 'mes:fact:planning_verification_result:S05:2' });
    const retried = projectCycleFilteredStatus([pvr(), retryPvr, pa()]);
    assert.deepEqual(retried, { cycle_id: CYCLE, scope: 'S05', phase: 'PLANNING', required_skill: 'proofloop-plan' });
    // REVIEW: stage-only Review work/result/finding — REVIEW wins over the
    // coexisting slice-scoped execute facts (mes.md current-phase ordering).
    const review = projectCycleFilteredStatus([pvr(), pa(), workFact(), taskFact(), reviewResult()]);
    assert.deepEqual(review, {
      cycle_id: CYCLE,
      scope: 'S05',
      phase: 'REVIEW',
      required_skill: 'stage-reviewer',
    });

    // STAGE_ACCEPTED: the unique in-flight stage now carries a same-cycle
    // accepted-stage support.
    const accepted = projectCycleFilteredStatus([pvr(), pa(), workFact(), taskFact(), reviewResult(), acceptedStageFact()]);
    assert.deepEqual(accepted, {
      cycle_id: CYCLE,
      scope: 'S05',
      phase: 'STAGE_ACCEPTED',
      required_skill: 'stage-reviewer',
    });

    // Deterministic + read-only: same input → same view, input never mutated.
    assert.deepEqual(projectCycleFilteredStatus([pvr(), pa()]), planning);
    const snapshot = JSON.parse(JSON.stringify([pvr(), pa(), taskFact()]));
    projectCycleFilteredStatus(snapshot);
    assert.deepEqual(snapshot, JSON.parse(JSON.stringify([pvr(), pa(), taskFact()])), 'projection must not mutate its input');

    // No route / next-action / reasoning anywhere in the output.
    for (const forbidden of ['next_action', 'route', 'reasoning']) {
      assert.equal(JSON.stringify(planning).includes(forbidden), false, `output must not contain ${forbidden}`);
    }
  });

  test('fails closed AUTHORITY_GAP on missing, duplicate, cross-cycle or no-provenance currentness', () => {
    // Missing: no current-cycle fact at all (empty set / legacy history only).
    assert.throws(
      () => projectCycleFilteredStatus([]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
    );
    assert.throws(
      () => projectCycleFilteredStatus([legacyStageSupport('S01'), legacyStageSupport('S02')]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'legacy history-only facts must not fabricate a current cycle',
    );

    // Duplicate in-flight candidates: two same-cycle stages without accepted
    // support (S05 + S06) — never picked silently.
    const s06Pa = pa({
      fact_id: 'mes:fact:plan_acceptance:S06:1',
      scope: { stage_id: 'S06' },
      plan_binding: { ...ACCEPTED, accepted_plan_ref: 'delivery/stages/S06/plan.md', source_candidate_plan_ref: 'delivery/stages/S06/plan.md' },
    });
    assert.throws(
      () => projectCycleFilteredStatus([pvr(), pa(), s06Pa]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'multiple in-flight stages must fail closed',
    );

    // (EC-3 / CV S05-C-cv-1) Distinct same-stage/same-cycle in-flight
    // planning bindings are duplicate provenance: a second accepted
    // binding for the SAME stage + cycle with a DIFFERENT plan identity
    // must fail typed AUTHORITY_GAP — never Set-deduped by stage ID.
    const secondDigestPa = pa({
      fact_id: 'mes:fact:plan_acceptance:S05:2',
      plan_binding: { ...ACCEPTED, plan_digest: sha('s05-plan-v2') },
    });
    assert.throws(
      () => projectCycleFilteredStatus([pvr(), pa(), secondDigestPa]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'distinct same-stage/same-cycle in-flight planning bindings must fail closed',
    );

    // Cross-cycle: a same-cycle binding plus a foreign-cycle fact.
    const crossCyclePa = pa({ plan_binding: { ...ACCEPTED, delivery_cycle_id: 'cycle-other' } });
    assert.throws(
      () => projectCycleFilteredStatus([pvr(), crossCyclePa]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'cross-cycle durable facts must fail closed',
    );

    // No stage provenance: a same-cycle `plan_binding`-kind fact carries a
    // cycle but NO stage scope — it can never supply the current Stage
    // identity (the envelope accepts the shape, the projection fails closed).
    const provenanceLessBinding: MesFactEnvelope = {
      schema_version: 2,
      fact_id: 'mes:fact:plan_binding:S05:cycle',
      fact_kind: 'plan_binding',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      plan_binding: {
        binding_stage: 'accepted',
        accepted_plan_ref: S05_PLAN,
        source_candidate_plan_ref: S05_PLAN,
        verification_result_ref: 'mes:result:S05:planning-verification-1',
        plan_digest: S05_DIGEST,
        delivery_cycle_id: CYCLE,
      },
    };
    assert.throws(
      () => projectCycleFilteredStatus([pvr(), pa(), provenanceLessBinding]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'no stage provenance must fail closed',
    );
  });
});

describe('MES cycle-filtered currentness oracle (S06-A-T01)', () => {
  // PO-S06-A-01: cycle-filtered status/detail currentness follows the
  // current-terminal-currentness-oracle (contracts §2.3 +
  // /entities/current-terminal-currentness-oracle): terminal validation precedes
  // selection; open_cycle_ids = cycle-bearing PVR/PA with NO legal matching
  // PROJECT_READY terminal (open determination depends ONLY on "no legal matching
  // terminal", never on accepted-stage support completeness); exactly one open
  // cycle → current; zero open cycles → validated chain tip; no chain → legacy
  // history only; multi-open / multi-tip / broken chain → typed AUTHORITY_GAP.
  // PO-S06-A-02: the projection-only project_terminal adjunct
  // (CURRENT_PROJECT_READY / HISTORICAL_PROJECT_READY / PRE_TERMINAL closed
  // shape) is observable in human/JSON/detail (T9).
  const CYCLE_OLD = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
  const CYCLE_NEW = 'cycle-208cbbe8d8e946479bb746f318b56178';
  const PLAN_OLD = 'delivery/stages/S05/plan.md';
  const PLAN_NEW = 'delivery/stages/S06/plan.md';
  const DIGEST_NEW = sha('s06-plan-v1');
  const BASIS = { head: 'a'.repeat(40), branch: 'v2-subagent', worktree: '.' };

  function pvr(cycle: string, stage: string, tag: string): MesFactEnvelope {
    const plan = stage === 'S05' ? PLAN_OLD : PLAN_NEW;
    return {
      schema_version: 2,
      fact_id: `mes:fact:planning_verification_result:${stage}:${tag}`,
      fact_kind: 'planning_verification_result',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: stage },
      work_id: `mes:work:${stage}:planning:${tag}`,
      result_ref: `mes:result:${stage}:planning-verification-${tag}`,
      verifier_role: 'stage-plan-verifier',
      action_token: `s06-spv-${tag}`,
      plan_binding: {
        binding_stage: 'candidate' as const,
        candidate_plan_ref: plan,
        accepted_plan_ref: null,
        verdict: 'PLAN_READY' as const,
        plan_digest: DIGEST_NEW,
        delivery_cycle_id: cycle,
      },
      git_basis: BASIS,
    };
  }
  function pa(cycle: string, stage: string, tag: string): MesFactEnvelope {
    const plan = stage === 'S05' ? PLAN_OLD : PLAN_NEW;
    return {
      schema_version: 2,
      fact_id: `mes:fact:plan_acceptance:${stage}:${tag}`,
      fact_kind: 'plan_acceptance',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: stage },
      supersedes_plan_acceptance_ref: null,
      plan_binding: {
        binding_stage: 'accepted' as const,
        accepted_plan_ref: plan,
        source_candidate_plan_ref: plan,
        verification_result_ref: `mes:result:${stage}:planning-verification-${tag}`,
        plan_digest: DIGEST_NEW,
        delivery_cycle_id: cycle,
      },
      git_basis: BASIS,
    };
  }
  function acceptedStage(cycle: string, stage: string, tag: string): MesFactEnvelope {
    const plan = stage === 'S05' ? PLAN_OLD : PLAN_NEW;
    return {
      schema_version: 2,
      fact_id: `mes:fact:stage:${stage}:accepted:${tag}`,
      fact_kind: 'stage',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.1.1'],
      scope: { stage_id: stage },
      plan_binding: {
        binding_stage: 'accepted' as const,
        accepted_plan_ref: plan,
        source_candidate_plan_ref: plan,
        verification_result_ref: `mes:result:${stage}:planning-verification-${tag}`,
        plan_digest: DIGEST_NEW,
        delivery_cycle_id: cycle,
      },
      git_basis: BASIS,
      result_ref: `mes:result:${stage}:stage-review-${tag}`,
    };
  }
  function terminal(cycle: string, planned: string[], factId: string, supersedes?: string | null): MesFactEnvelope {
    const extra: Record<string, unknown> = {};
    if (supersedes !== undefined) extra.supersedes_project_ready_ref = supersedes;
    return {
      schema_version: 2,
      fact_id: factId,
      fact_kind: 'project_ready',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
      planned_stage_ids: planned,
      delivery_cycle_id: cycle,
      git_basis: BASIS,
      ...extra,
    };
  }

  test('open-cycle precedence: a unique open cycle is current even when retained closed-cycle facts coexist (E2E-23 / T10)', () => {
    // Retained closed cycle (cycle OLD has a legal matching terminal) + new open
    // cycle (cycle NEW PVR/PA, no terminal). Closed-cycle facts are history-only
    // and never poison currentness: exactly one open cycle (NEW) is current.
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_OLD, 'S05', 'a'), pa(CYCLE_OLD, 'S05', 'a'), acceptedStage(CYCLE_OLD, 'S05', 'a'),
      terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old', null),
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'),
    ];
    const current = projectCycleFilteredStatus(facts);
    assert.deepEqual(current, {
      cycle_id: CYCLE_NEW,
      scope: 'S06',
      phase: 'PLANNING',
      required_skill: 'proofloop-plan',
    });
    // The detail projection follows the same currentness.
    const detail = projectCycleFilteredDetail(facts);
    assert.equal(detail.scope, 'S06');
    assert.equal(detail.phase, 'PLANNING');
  });

  test('a cycle with ALL accepted-stage supports but no terminal stays open (distinguishable pre-terminal STAGE_ACCEPTED)', () => {
    // Open determination depends ONLY on "no legal matching terminal", NOT on
    // accepted-stage support completeness: all supports exist, still no terminal
    // → the cycle is OPEN; per-Stage phase stays the distinguishable
    // pre-terminal STAGE_ACCEPTED and the adjunct is PRE_TERMINAL.
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), acceptedStage(CYCLE_NEW, 'S06', 'b'),
    ];
    const current = projectCycleFilteredStatus(facts);
    assert.deepEqual(current, {
      cycle_id: CYCLE_NEW,
      scope: 'S06',
      phase: 'STAGE_ACCEPTED',
      required_skill: 'stage-reviewer',
    });
    const adjunct = projectTerminalAdjunct(facts);
    assert.deepEqual(adjunct, {
      state: 'PRE_TERMINAL',
      project_ready: false,
      delivery_cycle_id: CYCLE_NEW,
      planned_stage_ids: [],
      accepted_stage_support_ids: ['S06'],
      exact_closure: false,
    });
    assert.equal('project_ready_ref' in (adjunct as object), false, 'PRE_TERMINAL omits project_ready_ref');
  });

  test('chain-tip selection: zero open cycles resolves the unique validated chain tip', () => {
    const root = terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old', null);
    const tip = terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', 'mes:fact:project_ready:old');
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_OLD, 'S05', 'a'), pa(CYCLE_OLD, 'S05', 'a'), acceptedStage(CYCLE_OLD, 'S05', 'a'), root,
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), acceptedStage(CYCLE_NEW, 'S06', 'b'), tip,
    ];
    const current = projectCycleFilteredStatus(facts);
    assert.deepEqual(current, {
      cycle_id: CYCLE_NEW,
      scope: 'S06',
      phase: 'STAGE_ACCEPTED',
      required_skill: 'stage-reviewer',
    });
    const adjunct = projectTerminalAdjunct(facts);
    assert.deepEqual(adjunct, {
      state: 'CURRENT_PROJECT_READY',
      project_ready: true,
      project_ready_ref: 'mes:fact:project_ready:new',
      delivery_cycle_id: CYCLE_NEW,
      planned_stage_ids: ['S06'],
      accepted_stage_support_ids: ['S06'],
      exact_closure: true,
    });
  });

  test('multi-tip fail closed AUTHORITY_GAP: two cycle-bearing terminals with no successor edge', () => {
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_OLD, 'S05', 'a'), pa(CYCLE_OLD, 'S05', 'a'), acceptedStage(CYCLE_OLD, 'S05', 'a'),
      terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old', null),
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), acceptedStage(CYCLE_NEW, 'S06', 'b'),
      terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', null),
    ];
    assert.throws(
      () => projectCycleFilteredStatus(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'multiple chain tips must fail closed AUTHORITY_GAP',
    );
    assert.throws(
      () => projectTerminalAdjunct(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'multiple chain tips fail closed for the adjunct too',
    );
  });

  test('T9: legal PROJECT_READY stays distinguishable — per-Stage STAGE_ACCEPTED plus CURRENT_PROJECT_READY adjunct in human/JSON/detail', () => {
    // T9: the current cycle has a legal PROJECT_READY terminal but the per-Stage
    // phase remains STAGE_ACCEPTED (PROJECT_READY never enters MES_STATUS_PHASES);
    // the projection-only project_terminal adjunct distinguishes the current
    // terminal (CURRENT_PROJECT_READY) in human/JSON/detail.
    const tip = terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old', null);
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_OLD, 'S05', 'a'), pa(CYCLE_OLD, 'S05', 'a'), acceptedStage(CYCLE_OLD, 'S05', 'a'), tip,
    ];
    const current = projectCycleFilteredStatus(facts);
    assert.equal(current.phase, 'STAGE_ACCEPTED');
    assert.equal(current.scope, 'S05');
    assert.equal((MES_STATUS_PHASES as readonly string[]).includes('PROJECT_READY'), false, 'PROJECT_READY is not a per-Stage phase');
    const adjunct = projectTerminalAdjunct(facts);
    assert.deepEqual(adjunct, {
      state: 'CURRENT_PROJECT_READY',
      project_ready: true,
      project_ready_ref: 'mes:fact:project_ready:old',
      delivery_cycle_id: CYCLE_OLD,
      planned_stage_ids: ['S05'],
      accepted_stage_support_ids: ['S05'],
      exact_closure: true,
    });
    // Human output renders project_terminal=<state>.
    assert.equal(formatProjectTerminalAdjunct(adjunct!), 'project_terminal=CURRENT_PROJECT_READY');
    // JSON exposes the adjunct object (stable round-trip).
    assert.deepEqual(JSON.parse(JSON.stringify(adjunct)), adjunct);
    // --detail carries the same adjunct plus the bounded Git/Plan detail.
    const detail = projectCycleFilteredDetail(facts);
    assert.deepEqual(detail.project_terminal, adjunct);
    assert.equal(detail.scope, 'S05');
    assert.equal(detail.phase, 'STAGE_ACCEPTED');
    // No routing / next-action / reasoning in the adjunct.
    for (const forbidden of ['next_action', 'route', 'reasoning']) {
      assert.equal(JSON.stringify(adjunct).includes(forbidden), false, `adjunct must not contain ${forbidden}`);
    }
  });

  test('duplicate same-cycle accepted-stage supports fail closed typed AUTHORITY_GAP before currentness selection (repair CV S06-A-restart-cv-1)', () => {
    // Two schema-valid `stage` facts carrying the SAME stage_id in the SAME
    // cycle make the durable support set ambiguous: status must fail closed
    // typed AUTHORITY_GAP instead of projecting STAGE_ACCEPTED / PRE_TERMINAL
    // with a duplicate Stage ID (contracts §2.3 / currentness oracle;
    // CV S06-A-restart-cv-1).
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'),
      acceptedStage(CYCLE_NEW, 'S06', 'b'), acceptedStage(CYCLE_NEW, 'S06', 'b-dup'),
    ];
    assert.throws(
      () => projectCycleFilteredStatus(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'duplicate same-cycle accepted-stage supports must fail closed AUTHORITY_GAP in status',
    );
    assert.throws(
      () => projectCycleFilteredDetail(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'duplicate same-cycle accepted-stage supports must fail closed AUTHORITY_GAP in detail',
    );
  });
});