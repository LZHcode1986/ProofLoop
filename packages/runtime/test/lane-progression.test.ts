/**
 * Slice lane facts, Task progression and milestone tests (S03-C-T02).
 *
 * # PO: PO-S03-C-02, PO-S03-C-03
 *
 * The lane seam is pure: it constructs/validates Brain-owned MES facts and
 * checks barriers without writing the snapshot or introducing a coordinator.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { MesFactEnvelope, MesTaskStatus } from '../dist/mes/types';
import {
  LaneProgressionError,
  buildLaneWorkFact,
  buildTaskFact,
  isExecutionReadyForReview,
  isSliceCandidateReady,
  transitionTaskStatus,
  assertExecutionReadyForReview,
  assertSliceCandidateReady,
  validateLaneWorkFact,
  validateTaskFact,
} from '../dist/execute/lane';

const PLAN_REF = 'delivery/stages/S03/plan.md';
const HEAD = '1d54108d25ad99387dd55784dd879980d396e8ed';
const GIT_BASIS = {
  head: HEAD,
  branch: 'worktree/rapid-cloud-a54e',
  worktree: '.proofloop/worktrees/S03-S03-C',
};
const BINDING = {
  binding_stage: 'accepted' as const,
  accepted_plan_ref: PLAN_REF,
  source_candidate_plan_ref: PLAN_REF,
  verification_result_ref: 'mes:result:S03:planning-verification-1',
  plan_digest: 'a'.repeat(64),
};

function workFact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:work:S03:S03-C:1',
    fact_kind: 'work',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#4.2', 'tech-spec/contracts.md#5.1'],
    scope: { stage_id: 'S03', slice_id: 'S03-C' },
    work_id: 'mes:work:S03:S03-C:1',
    plan_binding: BINDING,
    git_basis: GIT_BASIS,
    ...overrides,
  };
}

function taskFact(taskId: string, status: MesTaskStatus, overrides: Record<string, unknown> = {}): MesFactEnvelope {
  const sliceId = taskId.slice(0, taskId.lastIndexOf('-'));
  return validateTaskFact({
    schema_version: 2,
    fact_id: `mes:fact:task:${taskId}:${status}`,
    fact_kind: 'task',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.1'],
    scope: { stage_id: 'S03', slice_id: sliceId, task_id: taskId },
    work_id: `mes:work:S03:${sliceId}:1`,
    plan_binding: BINDING,
    git_basis: GIT_BASIS,
    task_status: status,
    depends_on_task_ids: [],
    ...overrides,
  });
}


/** A fully closed durable Execute result envelope for TASK_COMPLETE proof tests. */
function executeResultEnvelope(taskId: string, resultRef: string): MesFactEnvelope {
  const sliceId = taskId.slice(0, taskId.lastIndexOf('-'));
  return {
    schema_version: 2,
    fact_id: `mes:fact:result:${taskId}:accepted`,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#4.3'],
    scope: { stage_id: 'S03', slice_id: sliceId, task_id: taskId },
    work_id: `mes:work:S03:${sliceId}:1`,
    result_ref: resultRef,
    result_id: `attempt-${taskId}`,
    result_payload_digest: 'a'.repeat(64),
    plan_binding: BINDING,
    git_basis: GIT_BASIS,
  };
}
function integrationFact(sliceId: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:git:S03:${sliceId}:integration`,
    fact_kind: 'git',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.3'],
    scope: { stage_id: 'S03', slice_id: sliceId },
    plan_binding: BINDING,
    git_basis: GIT_BASIS,
    git_subkind: 'integration',
    candidate_ref: `proofloop-${sliceId.toLowerCase()}`,
    candidate_base_ref: HEAD,
    commit_sha: 'c'.repeat(40),
    changed_files: ['packages/runtime/src/execute/lane.ts'],
  };
}

describe('Slice lane progression (S03-C-T02)', () => {
  test('constructs a scoped Work fact and never persists actionToken', () => {
    const built = buildLaneWorkFact({
      fact_id: 'mes:fact:work:S03:S03-C:1',
      stage_id: 'S03',
      slice_id: 'S03-C',
      work_id: 'mes:work:S03:S03-C:1',
      authority_refs: ['tech-spec/contracts.md#4.2'],
      plan_binding: BINDING,
      git_basis: GIT_BASIS,
      actionToken: 'dispatch-token-is-not-durable',
    });
    assert.equal(built.fact_kind, 'work');
    assert.deepEqual(built.scope, { stage_id: 'S03', slice_id: 'S03-C' });
    assert.equal('action_token' in built, false);
    assert.equal('actionToken' in built, false);
    assert.doesNotThrow(() => validateLaneWorkFact(built));

    assert.throws(() => validateLaneWorkFact(workFact({ action_token: 'lane-token' })), LaneProgressionError);
    assert.throws(() => validateLaneWorkFact(workFact({ scope: { stage_id: 'S03', slice_id: 'S03-A' } })), LaneProgressionError);
    assert.throws(() => validateLaneWorkFact(workFact({ plan_binding: { ...BINDING, binding_stage: 'candidate' } })), LaneProgressionError);
  });

  test('enforces the closed PLANNED → IN_PROGRESS → SUBMITTED → COMPLETE path', () => {
    assert.equal(transitionTaskStatus('PLANNED', 'IN_PROGRESS'), 'IN_PROGRESS');
    assert.equal(transitionTaskStatus('IN_PROGRESS', 'TASK_RESULT_SUBMITTED'), 'TASK_RESULT_SUBMITTED');
    assert.throws(() => transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE'), LaneProgressionError);
    assert.equal(
      transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
        resultDisposition: 'ACCEPTED',
        resultDurable: true,
      }),
      'TASK_COMPLETE',
    );
    for (const [from, to] of [
      ['PLANNED', 'TASK_RESULT_SUBMITTED'],
      ['IN_PROGRESS', 'TASK_COMPLETE'],
      ['TASK_COMPLETE', 'IN_PROGRESS'],
      ['TASK_RESULT_SUBMITTED', 'PLANNED'],
    ] as const) {
      assert.throws(() => transitionTaskStatus(from, to), LaneProgressionError);
    }
    assert.throws(() => transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
      resultDisposition: 'REJECTED',
      resultDurable: true,
    }), LaneProgressionError);
    assert.throws(() => transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
      resultDisposition: 'ACCEPTED',
      resultDurable: false,
    }), LaneProgressionError);
    assert.throws(() => transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
      ack: { resultDisposition: 'REJECTED' },
      resultAccepted: true,
      resultDurable: true,
    }), LaneProgressionError);
  });

  test('TASK_COMPLETE proof requires a validated durable Execute result envelope and the exact ack/result relation (S03-STAGE-REVIEW-F001)', () => {
    // Preserved legitimate completion fixtures.
    assert.equal(
      transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', { resultDisposition: 'ACCEPTED', resultDurable: true }),
      'TASK_COMPLETE',
    );
    // A fully validated durable Execute result envelope satisfies completion;
    // when the ACK names an exact accepted result ref the envelope must carry
    // exactly that ref.
    const durable = executeResultEnvelope('S03-C-T01', 'mes:result:S03:S03-C-T01:1');
    assert.equal(
      transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
        resultDisposition: 'ACCEPTED',
        durableResult: durable,
      }),
      'TASK_COMPLETE',
    );
    assert.equal(
      transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
        resultDisposition: 'ACCEPTED',
        acceptedResultRef: 'mes:result:S03:S03-C-T01:1',
        durableResult: durable,
      }),
      'TASK_COMPLETE',
    );
    assert.equal(
      transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
        ack: { resultDisposition: 'ACCEPTED', acceptedResultRef: 'mes:result:S03:S03-C-T01:1' },
        durableResult: durable,
      }),
      'TASK_COMPLETE',
    );
    // durableFacts path: fully validated envelopes AND the exact named ack ref.
    assert.equal(
      transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
        resultDisposition: 'ACCEPTED',
        acceptedResultRef: 'mes:result:S03:S03-C-T01:1',
        durableFacts: [durable],
      }),
      'TASK_COMPLETE',
    );

    // Negatives: a caller-supplied PARTIAL object can never satisfy completion;
    // the durableFacts path never matches vacuously without an exact named ref,
    // and a named ref that does not equal the durable envelope result_ref fails
    // closed (exact accepted ACK/result relation).
    assert.throws(
      () =>
        transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
          resultDisposition: 'ACCEPTED',
          durableResult: { fact_kind: 'result', result_ref: 'fake' },
        }),
      LaneProgressionError,
      'partial {fact_kind:result, result_ref:fake} pseudo-envelope must never satisfy completion',
    );
    assert.throws(
      () =>
        transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
          resultDisposition: 'ACCEPTED',
          durableResult: { fact_kind: 'result', result_ref: 'fake', work_id: 'x' },
        }),
      LaneProgressionError,
    );
    assert.throws(
      () =>
        transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
          resultDisposition: 'ACCEPTED',
          durableFacts: [{ fact_kind: 'result', result_ref: 'fake' }],
        }),
      LaneProgressionError,
      'durableFacts without an exact named ack ref must fail closed (no vacuous match)',
    );
    assert.throws(
      () =>
        transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
          resultDisposition: 'ACCEPTED',
          acceptedResultRef: 'mes:result:S03:S03-C-T01:999',
          durableFacts: [durable],
        }),
      LaneProgressionError,
      'named ack ref must exactly equal the durable envelope result_ref',
    );
    assert.throws(
      () =>
        transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
          ack: { resultDisposition: 'ACCEPTED', acceptedResultRef: 'mes:result:S03:S03-C-T01:7' },
          durableResult: durable,
        }),
      LaneProgressionError,
      'durableResult envelope ref must exactly equal the ack-named accepted ref',
    );
  });

  test('TASK_COMPLETE completion is task-scoped and rejects non-string accepted refs (residual closure)', () => {
    const durableT01 = executeResultEnvelope('S03-C-T01', 'mes:result:S03:S03-C-T01:1');
    const durableT02 = executeResultEnvelope('S03-C-T02', 'mes:result:S03:S03-C-T02:1');

    // Object-form transition closes the completion relation to the expected
    // task: a matching task id passes, a mismatching one fails closed.
    assert.equal(
      transitionTaskStatus({
        currentStatus: 'TASK_RESULT_SUBMITTED',
        nextStatus: 'TASK_COMPLETE',
        taskId: 'S03-C-T01',
        completionProof: { resultDisposition: 'ACCEPTED', acceptedResultRef: 'mes:result:S03:S03-C-T01:1', durableResult: durableT01 },
      }),
      'TASK_COMPLETE',
    );
    assert.throws(
      () =>
        transitionTaskStatus({
          currentStatus: 'TASK_RESULT_SUBMITTED',
          nextStatus: 'TASK_COMPLETE',
          taskId: 'S03-C-T02',
          completionProof: { resultDisposition: 'ACCEPTED', acceptedResultRef: 'mes:result:S03:S03-C-T01:1', durableResult: durableT01 },
        }),
      LaneProgressionError,
      'a durable envelope for S03-C-T01 must never satisfy TASK_COMPLETE for S03-C-T02',
    );
    assert.throws(
      () =>
        transitionTaskStatus({
          currentStatus: 'TASK_RESULT_SUBMITTED',
          nextStatus: 'TASK_COMPLETE',
          task_id: 'S03-C-T01',
          completionProof: { resultDisposition: 'ACCEPTED', acceptedResultRef: 'mes:result:S03:S03-C-T02:1', durableResult: durableT02 },
        }),
      LaneProgressionError,
      'snake-case task_id mismatch (T02 envelope for expected T01) fails closed',
    );

    // Durable buildTaskFact REQUIRES the exact result scope task_id.
    assert.doesNotThrow(() =>
      buildTaskFact({
        task_id: 'S03-C-T01',
        task_status: 'TASK_COMPLETE',
        work_id: 'mes:work:S03:S03-C:1',
        authority_refs: ['tech-spec/contracts.md#5.1'],
        plan_binding: BINDING,
        git_basis: GIT_BASIS,
        depends_on_task_ids: [],
        completionProof: { resultDisposition: 'ACCEPTED', acceptedResultRef: 'mes:result:S03:S03-C-T01:1', durableResult: durableT01 },
      }),
    );
    assert.throws(
      () =>
        buildTaskFact({
          task_id: 'S03-C-T02',
          task_status: 'TASK_COMPLETE',
          work_id: 'mes:work:S03:S03-C:1',
          authority_refs: ['tech-spec/contracts.md#5.1'],
          plan_binding: BINDING,
          git_basis: GIT_BASIS,
          depends_on_task_ids: [],
          completionProof: { resultDisposition: 'ACCEPTED', acceptedResultRef: 'mes:result:S03:S03-C-T01:1', durableResult: durableT01 },
        }),
      LaneProgressionError,
      'durable buildTaskFact must require the exact result scope task_id',
    );

    // A NON-string named accepted ref fails closed even in the single
    // durableResult path (never treated as absent).
    assert.throws(
      () =>
        transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
          resultDisposition: 'ACCEPTED',
          acceptedResultRef: { ref: 'mes:result:S03:S03-C-T01:1' },
          durableResult: durableT01,
        }),
      LaneProgressionError,
      'non-string acceptedResultRef must fail closed',
    );

    // No-task-id compatibility preserved for the generic transition helper.
    assert.equal(
      transitionTaskStatus('TASK_RESULT_SUBMITTED', 'TASK_COMPLETE', {
        resultDisposition: 'ACCEPTED',
        acceptedResultRef: 'mes:result:S03:S03-C-T01:1',
        durableResult: durableT01,
      }),
      'TASK_COMPLETE',
    );
  });

  test('requires all durable task completions plus self-check for SLICE_CANDIDATE_READY', () => {
    const complete = {
      plannedTaskIds: ['S03-C-T01', 'S03-C-T02'],
      taskStatuses: ['TASK_COMPLETE', 'TASK_COMPLETE'],
      selfCheckPassed: true,
    } as const;
    assert.equal(isSliceCandidateReady(complete), true);
    assert.equal(isSliceCandidateReady({ plannedTaskIds: complete.plannedTaskIds, taskStatuses: complete.taskStatuses }), false);
    assert.equal(isSliceCandidateReady({ taskStatuses: ['TASK_COMPLETE'], selfCheckPassed: true }), false);
    assert.equal(assertSliceCandidateReady(complete), 'SLICE_CANDIDATE_READY');
    assert.equal(isSliceCandidateReady({ ...complete, taskStatuses: ['TASK_COMPLETE', 'IN_PROGRESS'] }), false);
    assert.throws(() => assertSliceCandidateReady({ ...complete, selfCheckPassed: false }), LaneProgressionError);

    const facts = [taskFact('S03-C-T01', 'TASK_COMPLETE'), taskFact('S03-C-T02', 'TASK_COMPLETE')];
    assert.equal(isSliceCandidateReady({ plannedTaskIds: complete.plannedTaskIds, durableFacts: facts, selfCheckPassed: true }), true);
    assert.equal(isSliceCandidateReady({ plannedTaskIds: complete.plannedTaskIds, durableFacts: [facts[0]], selfCheckPassed: true }), false);
  });

  test('forms EXECUTION_READY_FOR_REVIEW only after every planned Slice is integrated', () => {
    const plannedSliceIds = ['S03-A', 'S03-C'] as const;
    const both = {
      plannedSliceIds,
      durableFacts: [integrationFact('S03-A'), integrationFact('S03-C')],
    } as const;
    assert.equal(isExecutionReadyForReview(both), true);
    assert.equal(assertExecutionReadyForReview(both), 'EXECUTION_READY_FOR_REVIEW');
    assert.equal(isExecutionReadyForReview({ ...both, durableFacts: [integrationFact('S03-A')] }), false);
    assert.throws(() => assertExecutionReadyForReview({ ...both, durableFacts: [integrationFact('S03-A')] }), LaneProgressionError);

    // A fact from an unrelated lane never satisfies S03-C; parallel lanes stay isolated.
    assert.equal(isExecutionReadyForReview({
      plannedSliceIds,
      durableFacts: [integrationFact('S03-A'), integrationFact('S03-B')],
    }), false);
    assert.throws(() => isExecutionReadyForReview({
      plannedSliceIds: ['S03-A', 'S03-A'],
      durableFacts: [integrationFact('S03-A')],
    }));
  });
});
