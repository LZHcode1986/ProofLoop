/**
 * Successor barrier / dependency-ready task selection tests (S03-B-T03).
 *
 * # PO: PO-S03-B-04
 *
 * Exercises packages/runtime/src/execute/successor-barrier.ts (contracts.md
 * §4.3 / §5.1 / E2E-19 task order):
 *   - a successor can only be selected when EVERY predecessor has a durably
 *     accepted output (durable `result` fact for the task — NORMAL result
 *     facts are only written for accepted results — or a durable `task` fact
 *     with task_status TASK_COMPLETE); a submitted-but-not-accepted
 *     predecessor blocks any successor;
 *   - selection follows the accepted Thin Plan's STABLE task order of the
 *     current slice: the first task that is incomplete AND whose dependencies
 *     all have durably accepted output is returned ([] when none);
 *   - binding/scope currentness: only facts bound to the current slice tasks
 *     (canonical scope.task_id) with an accepted Plan binding count; legacy
 *     S01 result facts never count as accepted output;
 *   - the seam is a pure deterministic function — replay / recovery recomputes
 *     the identical selection from the same durable facts + task order;
 *   - it produces no next-task directive: the selection is the pure input
 *     Brain running `proofloop-execute` consumes per Step — Brain selects the
 *     current dependency-ready Task and only projects that Task's JIT input to
 *     the same Worker, which never selects or reorders a successor and never
 *     receives a future Task body;
 *   - malformed closed input (non-canonical / duplicate task ids, malformed
 *     dependencies, invalid sliceId) fails closed with a typed error.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {
  selectNextReadyTask,
  SuccessorBarrierError,
} from '../dist/execute/successor-barrier';
import type { SliceTaskOrderEntry } from '../dist/execute/successor-barrier';
import { createMesSnapshotStore } from '../dist/mes/store';
import { makeFixture } from './helpers';
import type { MesFactEnvelope, MesTaskStatus } from '../dist/mes/types';

const HEAD_40 = 'a'.repeat(40);
const GIT_BASIS = {
  head: HEAD_40,
  branch: 'worktree/s03-b',
  worktree: '.proofloop/worktrees/S03-S03-B',
};
const BARRIER_BINDING = {
  accepted_plan_ref: 'delivery/stages/S03/plan.md',
  plan_digest: sha256Hex('s03-plan'),
  work_id: 'mes:work:S03:S03-B:1',
  git_basis: { head: HEAD_40, branch: 'worktree/s03-b', worktree: '.' },
} as const;

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function acceptedBinding() {
  return {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: 'delivery/stages/S03/plan.md',
    source_candidate_plan_ref: 'delivery/stages/S03/plan.md',
    verification_result_ref: 'mes:result:S03:planning-verification-1',
    plan_digest: sha256Hex('s03-plan'),
  };
}

/** A durable `task` kind fact (NORMAL, accepted-bound; §5.1 status). */
function taskFact(
  taskId: string,
  status: MesTaskStatus,
  dependsOn: string[] = [],
  overrides: Record<string, unknown> = {},
): MesFactEnvelope {
  const [stageId, sliceId] = [taskId.slice(0, 3), taskId.slice(0, 5)];
  return {
    schema_version: 2,
    fact_id: `mes:fact:task:${taskId}:${status}`,
    fact_kind: 'task',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.1'],
    scope: { stage_id: stageId, slice_id: sliceId, task_id: taskId },
    work_id: `mes:work:S03:${sliceId}:1`,
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    task_status: status,
    depends_on_task_ids: dependsOn,
    ...overrides,
  };
}

/** A durable accepted `result` fact for a task (is_execute_result). */
function resultFactForTask(
  taskId: string,
  overrides: Record<string, unknown> = {},
): MesFactEnvelope {
  const [stageId, sliceId] = [taskId.slice(0, 3), taskId.slice(0, 5)];
  return {
    schema_version: 2,
    fact_id: `mes:fact:result:${taskId}:accepted`,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#4.3'],
    scope: { stage_id: stageId, slice_id: sliceId, task_id: taskId },
    work_id: `mes:work:S03:${sliceId}:1`,
    result_ref: `mes:result:S03:${taskId}:1`,
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    result_id: `attempt-${taskId}`,
    result_payload_digest: sha256Hex(`payload-${taskId}`),
    ...overrides,
  };
}

/** A legacy S01 result fact (no task scope; must never count as output). */
function legacyS01ResultFact(): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:result:S01-A-review-repair-r1',
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-003'],
    scope: { stage_id: 'S01', slice_id: 'S01-A' },
    work_id: 'mes:work:S01:review',
    result_ref: 'mes:result:S01-A-review-repair-r1',
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
  };
}

function order(...entries: Array<[string, string[]]>): SliceTaskOrderEntry[] {
  return entries.map(([taskId, dependsOnTaskIds]) => ({ taskId, dependsOnTaskIds }));
}

describe('successor barrier / dependency-ready selection (S03-B-T03)', () => {
  const S03B_ORDER = order(
    ['S03-B-T01', []],
    ['S03-B-T02', ['S03-B-T01']],
    ['S03-B-T03', ['S03-B-T02']],
  );

  test('selects the first incomplete task when no facts exist yet', () => {
    assert.deepEqual(
      selectNextReadyTask({ sliceId: 'S03-B', taskOrder: S03B_ORDER, binding: BARRIER_BINDING, durableFacts: [] }),
      ['S03-B-T01'],
    );
  });

  test('gates successors on durably accepted predecessors (PO-S03-B-04)', () => {
    // T01 accepted (durable result fact) → T02 becomes ready, T03 stays blocked.
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [resultFactForTask('S03-B-T01')],
      }),
      ['S03-B-T02'],
    );
    // T01 + T02 accepted → T03 ready.
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [
          resultFactForTask('S03-B-T01'),
          resultFactForTask('S03-B-T02'),
        ],
      }),
      ['S03-B-T03'],
    );
    // A submitted-but-not-accepted T01 blocks its successor: T02 must never
    // be selected while T01 lacks a durably accepted output.
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [taskFact('S03-B-T01', 'TASK_RESULT_SUBMITTED')],
      }),
      ['S03-B-T01'],
    );
    // T01 accepted but T02 only SUBMITTED: T02 is dependency-ready for retry
    // (its own deps are all accepted), but T03 — T02's successor — stays gated.
    const retry = selectNextReadyTask({
      sliceId: 'S03-B',
      taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
      durableFacts: [
        resultFactForTask('S03-B-T01'),
        taskFact('S03-B-T02', 'TASK_RESULT_SUBMITTED'),
      ],
    });
    assert.deepEqual(retry, ['S03-B-T02']);
    assert.notDeepEqual(retry, ['S03-B-T03']);
    // All accepted → no incomplete task → empty (complete tasks are never
    // reselected).
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [
          resultFactForTask('S03-B-T01'),
          resultFactForTask('S03-B-T02'),
          resultFactForTask('S03-B-T03'),
        ],
      }),
      [],
    );

  });
  test('a submitted-but-not-accepted predecessor blocks its successor', () => {
    // T01 has only a TASK_RESULT_SUBMITTED task fact (not durably accepted):
    // T01 stays incomplete and selectable, but T02 (its successor) is gated
    // and must NOT be selected.
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [taskFact('S03-B-T01', 'TASK_RESULT_SUBMITTED')],
      }),
      ['S03-B-T01'],
    );
    // A task fact with TASK_COMPLETE IS a durably accepted output.
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [taskFact('S03-B-T01', 'TASK_COMPLETE')],
      }),
      ['S03-B-T02'],
    );
    // IN_PROGRESS / PLANNED task facts never unlock successors either —
    // the task itself remains the first incomplete candidate.
    for (const status of ['PLANNED', 'IN_PROGRESS'] as const) {
      assert.deepEqual(
        selectNextReadyTask({
          sliceId: 'S03-B',
          taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
          durableFacts: [taskFact('S03-B-T01', status)],
        }),
        ['S03-B-T01'],
        `${status} must not count as accepted output`,
      );
    }
  });

  test('keeps independent work ready while an unrelated predecessor is missing', () => {
    // T02 depends on T01; T03 depends on T02. Even though T02/T03 are
    // blocked, the first incomplete task with satisfied deps (T01) stays
    // ready — and once T01 is accepted T02 is the only candidate.
    const durable = [
      resultFactForTask('S03-B-T01'),
      // A durable fact for an unrelated task must not influence selection.
      resultFactForTask('S03-C-T01', {
        fact_id: 'mes:fact:result:S03-C-T01:accepted',
        scope: { stage_id: 'S03', slice_id: 'S03-C', task_id: 'S03-C-T01' },
        work_id: 'mes:work:S03:S03-C:1',
      }),
    ];
    assert.deepEqual(
      selectNextReadyTask({ sliceId: 'S03-B', taskOrder: S03B_ORDER, binding: BARRIER_BINDING, durableFacts: durable }),
      ['S03-B-T02'],
    );
  });

  test('handles cross-slice dependencies via durable facts only', () => {
    // T02 depends on an OUTSIDE task S03-A-T01 (not part of the slice order);
    // it becomes ready only when that dependency has durable output.
    const crossOrder = order(
      ['S03-B-T01', []],
      ['S03-B-T02', ['S03-A-T01']],
    );
    assert.deepEqual(
      selectNextReadyTask({ sliceId: 'S03-B', taskOrder: crossOrder, binding: BARRIER_BINDING, durableFacts: [] }),
      ['S03-B-T01'],
    );
    // T01 accepted but S03-A-T01 not → T02 blocked → empty.
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: crossOrder, binding: BARRIER_BINDING,
        durableFacts: [resultFactForTask('S03-B-T01')],
      }),
      [],
    );
    // S03-A-T01 accepted → T02 ready.
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: crossOrder, binding: BARRIER_BINDING,
        durableFacts: [
          resultFactForTask('S03-B-T01'),
          resultFactForTask('S03-A-T01', {
            fact_id: 'mes:fact:result:S03-A-T01:accepted',
            scope: { stage_id: 'S03', slice_id: 'S03-A', task_id: 'S03-A-T01' },
            work_id: 'mes:work:S03:S03-A:1',
          }),
        ],
      }),
      ['S03-B-T02'],
    );
  });

  test('ignores legacy S01 result facts and read-side store facts identically', () => {
    // Legacy S01 facts carry no task scope → never count as accepted output.
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [legacyS01ResultFact(), legacyS01ResultFact()],
      }),
      ['S03-B-T01'],
    );
    // A real store round-trip feeds the same seam (read-side consumption via
    // MesSnapshotStore.read, no writes from the barrier itself).
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      store.write([resultFactForTask('S03-B-T01')]);
      assert.deepEqual(
        selectNextReadyTask({
          sliceId: 'S03-B',
          taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
          durableFacts: store.read(),
        }),
        ['S03-B-T02'],
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('is a pure deterministic function (replay / recovery recomputes identically)', () => {
    const facts = [resultFactForTask('S03-B-T01')];
    const input = { sliceId: 'S03-B', taskOrder: S03B_ORDER, binding: BARRIER_BINDING, durableFacts: facts };
    const first = selectNextReadyTask(input);
    const second = selectNextReadyTask({ ...input, durableFacts: [...facts] });
    assert.deepEqual(first, ['S03-B-T02']);
    assert.deepEqual(second, first);
  });

  test('returns an empty selection without any next-task directive', () => {
    const result = selectNextReadyTask({
      sliceId: 'S03-B',
      taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
      durableFacts: [],
    });
    assert.deepEqual(result, ['S03-B-T01']);
    assert.ok(Array.isArray(result));
    assert.ok(result.every((id) => typeof id === 'string'));
  });

  test('empty task order yields no candidates', () => {
    assert.deepEqual(
      selectNextReadyTask({ sliceId: 'S03-B', taskOrder: [], binding: BARRIER_BINDING, durableFacts: [] }),
      [],
    );
  });

  test('fails closed on malformed task order input', () => {
    const base = { sliceId: 'S03-B', durableFacts: [], binding: BARRIER_BINDING };
    const badInputs: Array<[string, Record<string, unknown>]> = [
      ['duplicate task ids', { taskOrder: [...S03B_ORDER, S03B_ORDER[0]] }],
      ['non-canonical task id', { taskOrder: [{ taskId: 'S03-B', dependsOnTaskIds: [] }] }],
      ['non-canonical dependency', { taskOrder: [{ taskId: 'S03-B-T01', dependsOnTaskIds: ['../x'] }] }],
      ['malformed entry (no taskId)', { taskOrder: [{ dependsOnTaskIds: [] }] }],
      ['non-array taskOrder', { taskOrder: 'S03-B-T01' }],
      ['malformed dependsOn', { taskOrder: [{ taskId: 'S03-B-T01', dependsOnTaskIds: 'S03-B-T02' }] }],
    ];
    for (const [label, patch] of badInputs) {
      assert.throws(
        () => selectNextReadyTask({ ...base, ...patch } as never),
        (err: unknown) => {
          assert.ok(err instanceof SuccessorBarrierError);
          return true;
        },
        `expected ${label} to fail closed`,
      );
    }
    assert.throws(
      () =>
        selectNextReadyTask({
          sliceId: 'S03-B',
          taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
          durableFacts: 'not-facts',
        } as never),
      (err: unknown) => {
        assert.ok(err instanceof SuccessorBarrierError);
        return true;
      },
    );
  });
  test('rejects a foreign taskOrder entry outside the input slice', () => {
    // Every taskOrder taskId must belong to the input slice; cross-slice ids
    // are only allowed inside dependsOnTaskIds.
    assert.throws(
      () =>
        selectNextReadyTask({
          sliceId: 'S03-B',
          taskOrder: order(['S03-C-T01', []]), binding: BARRIER_BINDING,
          durableFacts: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof SuccessorBarrierError);
        return true;
      },
    );
    assert.throws(
      () =>
        selectNextReadyTask({
          sliceId: 'S03-B',
          taskOrder: order(['S03-B-T01', []], ['S02-A-T01', []]), binding: BARRIER_BINDING,
          durableFacts: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof SuccessorBarrierError);
        return true;
      },
    );
  });

  test('fails closed on null / non-object durable fact entries', () => {
    for (const bad of [null, 42, 'nope', [1, 2]]) {
      assert.throws(
        () =>
          selectNextReadyTask({
            sliceId: 'S03-B',
            taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
            durableFacts: [bad] as never,
          }),
        (err: unknown) => {
          assert.ok(err instanceof SuccessorBarrierError);
          return true;
        },
        `durable fact ${JSON.stringify(bad)} must fail closed`,
      );
    }
  });

  test('does not index accepted output facts whose scope contradicts the task-derived scope', () => {
    // A predecessor result fact whose scope.stage_id / scope.slice_id do not
    // match the task_id-derived stage/slice must NOT count as accepted output
    // → its successor stays blocked.
    const inconsistent = resultFactForTask('S03-B-T01', {
      scope: { stage_id: 'S02', slice_id: 'S02-B', task_id: 'S03-B-T01' },
    });
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [inconsistent],
      }),
      ['S03-B-T01'], // T01 itself stays selectable; T02 must stay blocked
    );
    // A scope-consistent predecessor unlocks its successor.
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [resultFactForTask('S03-B-T01')],
      }),
      ['S03-B-T02'],
    );
  });
  test('requires a closed current binding input; missing or malformed binding fails closed', () => {
    // (S03-STAGE-REVIEW-F001) The barrier NEVER runs without the closed
    // current accepted Plan/work/Git binding — a missing, non-object or
    // malformed input produces the typed SuccessorBarrierError.
    const badBindings: Array<unknown> = [
      undefined,
      null,
      'binding',
      {},
      { accepted_plan_ref: 'delivery/stages/S03/plan.md', plan_digest: sha256Hex('s03-plan'), work_id: 'mes:work:S03:S03-B:1', git_basis: { head: 'short' } },
      { accepted_plan_ref: 'delivery/stages/S03/plan.md', plan_digest: 'not-a-digest', work_id: 'mes:work:S03:S03-B:1', git_basis: { head: HEAD_40 } },
      { accepted_plan_ref: '', plan_digest: sha256Hex('s03-plan'), work_id: 'mes:work:S03:S03-B:1', git_basis: { head: HEAD_40 } },
      { accepted_plan_ref: 'delivery/stages/S03/plan.md', plan_digest: sha256Hex('s03-plan'), work_id: '', git_basis: { head: HEAD_40 } },
      { accepted_plan_ref: 'delivery/stages/S03/plan.md', plan_digest: sha256Hex('s03-plan'), work_id: 'mes:work:S03:S03-B:1' },
      { accepted_plan_ref: 'delivery/stages/S03/plan.md', plan_digest: sha256Hex('s03-plan'), work_id: 'mes:work:S03:S03-B:1', git_basis: {} },
      // (residual closure) TRULY closed binding: unknown fields and
      // non-canonical values fail closed.
      { ...BARRIER_BINDING, smuggled: 1 },
      { ...BARRIER_BINDING, git_basis: { ...BARRIER_BINDING.git_basis, extra: 'x' } },
      { ...BARRIER_BINDING, accepted_plan_ref: '/abs/plan.md' },
      { ...BARRIER_BINDING, accepted_plan_ref: '../escape/plan.md' },
      { ...BARRIER_BINDING, plan_digest: 'nope' },
      { ...BARRIER_BINDING, work_id: 'nope' },
      { ...BARRIER_BINDING, work_id: 'mes:work:S99' },
      // (recheck residual F001-recheck-1) canonical-but-FOREIGN work identity
      // fails closed: the embedded stage/slice must equal the input sliceId.
      { ...BARRIER_BINDING, work_id: 'mes:work:S02:S03-B:1' },
      { ...BARRIER_BINDING, work_id: 'mes:work:S03:S03-A:1' },
      { ...BARRIER_BINDING, work_id: 'mes:work:S03:S03-B:1 with space' },
      { ...BARRIER_BINDING, git_basis: { ...BARRIER_BINDING.git_basis, head: 'zz' } },
      { ...BARRIER_BINDING, git_basis: { ...BARRIER_BINDING.git_basis, branch: '' } },
      { ...BARRIER_BINDING, git_basis: { ...BARRIER_BINDING.git_basis, worktree: '.git' } },
      { ...BARRIER_BINDING, git_basis: { ...BARRIER_BINDING.git_basis, worktree: '.proofloop' } },
      { ...BARRIER_BINDING, git_basis: { ...BARRIER_BINDING.git_basis, worktree: '/abs' } },
      { ...BARRIER_BINDING, git_basis: { ...BARRIER_BINDING.git_basis, worktree: '../up' } },
      { ...BARRIER_BINDING, git_basis: { head: HEAD_40, branch: 'worktree/s03-b' } },
      { ...BARRIER_BINDING, git_basis: { head: HEAD_40, worktree: '.' } },
    ];
    for (const [index, binding] of badBindings.entries()) {
      assert.throws(
        () => selectNextReadyTask({ sliceId: 'S03-B', taskOrder: S03B_ORDER, durableFacts: [], binding: binding as never }),
        (err: unknown) => {
          assert.ok(err instanceof SuccessorBarrierError);
          return true;
        },
        `malformed binding input [${index}] must fail closed`,
      );
    }
    // (recheck residual F001-recheck-1 positive) a canonical CURRENT-lane work
    // identity whose embedded stage/slice equals the input sliceId stays valid.
    assert.deepEqual(
      selectNextReadyTask({ sliceId: 'S03-B', taskOrder: S03B_ORDER, durableFacts: [], binding: BARRIER_BINDING }),
      ['S03-B-T01'],
    );
  });

  test('does not unlock a successor from a predecessor bound to an old/non-current Plan', () => {
    // (S03-STAGE-REVIEW-F001) A valid predecessor whose durable fact binds an
    // OLD accepted_plan_ref or an OLD plan_digest can never unlock the current
    // successor — only facts EXACTLY matching the closed current binding index.
    const stalePlanRef = resultFactForTask('S03-B-T01', {
      plan_binding: {
        ...acceptedBinding(),
        accepted_plan_ref: 'delivery/stages/S02/plan.md',
        source_candidate_plan_ref: 'delivery/stages/S02/plan.md',
        plan_digest: sha256Hex('s02-plan'),
      },
    });
    const stalePlanDigest = resultFactForTask('S03-B-T01', {
      plan_binding: { ...acceptedBinding(), plan_digest: sha256Hex('old-s03-plan') },
    });
    for (const stale of [stalePlanRef, stalePlanDigest]) {
      const selected = selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [stale],
      });
      assert.deepEqual(selected, ['S03-B-T01'], 'T01 itself stays selectable');
      assert.notDeepEqual(selected, ['S03-B-T02'], 'T02 must stay blocked by the stale-plan predecessor');
    }
    // A CURRENT-plan predecessor still unlocks the successor (positive).
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [resultFactForTask('S03-B-T01')],
      }),
      ['S03-B-T02'],
    );
  });

  test('does not unlock a successor from a same-slice predecessor bound to a stale work identity or Git basis', () => {
    // (S03-STAGE-REVIEW-F001) Same-slice predecessors must EXACTLY match the
    // current lane work identity + Git head: a stale work_id or a stale
    // git_basis.head is never counted as durably accepted output.
    const staleWork = resultFactForTask('S03-B-T01', { work_id: 'mes:work:S03:S03-B:999' });
    const staleHead = resultFactForTask('S03-B-T01', { git_basis: { ...GIT_BASIS, head: 'f'.repeat(40) } });
    for (const stale of [staleWork, staleHead]) {
      const selected = selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [stale],
      });
      assert.deepEqual(selected, ['S03-B-T01'], 'T01 itself stays selectable');
      assert.notDeepEqual(selected, ['S03-B-T02'], 'T02 must stay blocked by the stale-binding predecessor');
    }
    // A cross-slice predecessor (legitimately bound to its OWN lane work + Git
    // basis, same accepted Plan) still unlocks the successor.
    const crossOrder = order(
      ['S03-B-T01', []],
      ['S03-B-T02', ['S03-A-T01']],
    );
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: crossOrder, binding: BARRIER_BINDING,
        durableFacts: [
          resultFactForTask('S03-B-T01'),
          resultFactForTask('S03-A-T01', {
            fact_id: 'mes:fact:result:S03-A-T01:accepted',
            scope: { stage_id: 'S03', slice_id: 'S03-A', task_id: 'S03-A-T01' },
            work_id: 'mes:work:S03:S03-A:1',
          }),
        ],
      }),
      ['S03-B-T02'],
    );
  });

  test('fails closed on malformed durable entries with the typed error', () => {
    // (S03-STAGE-REVIEW-F001) Malformed durable entries are never silently
    // ignored: a non-canonical task scope or a malformed plan_binding /
    // git_basis on a task-scoped entry produces the typed SuccessorBarrierError.
    const malformedScoped = {
      ...resultFactForTask('S03-B-T01'),
      scope: { stage_id: 'S03', slice_id: 'S03-B', task_id: 'not-a-task' },
    };
    const malformedBinding = {
      ...resultFactForTask('S03-B-T01'),
      plan_binding: 'nope',
    };
    const malformedBasis = {
      ...resultFactForTask('S03-B-T01'),
      git_basis: 'nope',
    };
    for (const bad of [malformedScoped, malformedBinding, malformedBasis]) {
      assert.throws(
        () =>
          selectNextReadyTask({
            sliceId: 'S03-B',
            taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
            durableFacts: [bad] as never,
          }),
        (err: unknown) => {
          assert.ok(err instanceof SuccessorBarrierError);
          return true;
        },
        'malformed durable entry must fail closed',
      );
    }
  });

  test('fails closed when any task-scoped durable fact fails full envelope validation (residual closure)', () => {
    // Every task-scoped durable fact must pass the FULL closed MES envelope
    // validation (validateMesFactEnvelope) — partial result/task entries fail
    // with the typed SuccessorBarrierError instead of being partially indexed
    // on selected fields.
    const barePartial = { scope: { task_id: 'S03-B-T01' } };
    const bogusKind = { ...taskFact('S03-B-T01', 'TASK_COMPLETE', []), fact_kind: 'bogus' };
    const unknownStatus = { ...taskFact('S03-B-T01', 'TASK_COMPLETE', []), task_status: 'DONE' };
    const brokenScope = { ...resultFactForTask('S03-B-T01'), scope: { task_id: 'S03-B-T01' } };
    for (const [index, bad] of [barePartial, bogusKind, unknownStatus, brokenScope].entries()) {
      assert.throws(
        () =>
          selectNextReadyTask({
            sliceId: 'S03-B',
            taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
            durableFacts: [bad as never],
          }),
        (err: unknown) => {
          assert.ok(err instanceof SuccessorBarrierError);
          return true;
        },
        `task-scoped durable entry [${index}] must fail full envelope validation`,
      );
    }
    // Unrelated non-task-scoped facts remain handled deterministically.
    assert.deepEqual(
      selectNextReadyTask({
        sliceId: 'S03-B',
        taskOrder: S03B_ORDER, binding: BARRIER_BINDING,
        durableFacts: [legacyS01ResultFact()],
      }),
      ['S03-B-T01'],
    );
  });

});
