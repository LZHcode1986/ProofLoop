/**
 * Closed TASK_RESULT_ACK generation + idempotent-replay tests (S03-B-T02).
 *
 * # PO: PO-S03-B-02, PO-S03-B-03
 *
 * Exercises packages/runtime/src/execute/task-result-ack.ts (contracts.md
 * §4.3 / E2E-19 / FR-009 / STATIC-14):
 *   - only ACCEPTED+CONTINUE / ACCEPTED+PAUSE / REJECTED+PAUSE are legal;
 *     REJECTED+CONTINUE is invalid;
 *   - acceptedResultRef only on NORMAL+ACCEPTED and must resolve to a durably
 *     written MES `result` fact; PRE_MES_BOOTSTRAP and REJECTED forbid it;
 *   - validatedGitBasis is required and equals the validated submitted basis;
 *   - reasonCode is required exactly when REJECTED or PAUSE and forbidden on
 *     ACCEPTED+CONTINUE; unknown input keys invalidate/no-write;
 *   - the ACK is closed: never carries next_task_id / next_action /
 *     recommended_action / producer instruction / Receipt / Gate;
 *   - payload decision is made over the DURABLE result keys (result_id +
 *     result_payload_digest persisted on `result` kind facts by S03-A-T01):
 *     identical digest on replay → equivalent ACCEPTED ACK (lost-ACK /
 *     restart resends from durable facts, no duplicate TASK_COMPLETE); same
 *     result_id with a different digest → RESULT_INVALID no-write; durable
 *     duplicate result_id with conflicting digests → fail closed, no winner,
 *     no ACK ambiguity (typed RESULT_INVALID + recovery), also after restart;
 *     identical digest across different fact_ids → deterministic merge;
 *   - the replay index covers ONLY is_execute_result facts; legacy S01
 *     result facts never enter the index and never cause conflicts;
 *   - stale actionToken → RESULT_BINDING_MISMATCH; the token is opaque input
 *     and is never derived from Link message id / Agent Name / pane/session.
 *
 * The module is a read-side closed mapping (MesSnapshotStore.read output +
 * submitted payload → ACCEPT|REJECT + disposition): it never writes the
 * store, never creates an ack-log / second result store (STATIC-14).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { validateWorkerTaskResult } from '../dist/execute/task-result';
import {
  buildTaskResultAck,
  TaskResultAckError,
  TASK_RESULT_ACK_KIND,
} from '../dist/execute/task-result-ack';
import type { TaskResultAck, TaskResultAckDecision } from '../dist/execute/task-result-ack';
import { createMesSnapshotStore } from '../dist/mes/store';
import { makeFixture } from './helpers';
import type { MesFactEnvelope, MesGitBasis } from '../dist/mes/types';

const LANE_TOKEN = '2fb5b7cd-550a-4b3d-b337-dae70305b903';
const HEAD_40 = 'a'.repeat(40);
const GIT_BASIS: MesGitBasis = {
  head: HEAD_40,
  branch: 'worktree/s03-b',
  worktree: '.proofloop/worktrees/S03-S03-B',
};

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** A valid submitted result envelope (validated through the S03-B-T01 seam). */
function submittedResult(overrides: Record<string, unknown> = {}) {
  return validateWorkerTaskResult({
    executionMode: 'NORMAL',
    stageId: 'S03',
    sliceId: 'S03-B',
    taskId: 'S03-B-T02',
    outcome: 'completed',
    resultRef: 'mes:result:S03:S03-B-T02:1',
    changedFiles: ['packages/runtime/src/execute/task-result-ack.ts'],
    verificationRuns: ['node --test packages/runtime/test-dist/task-result-ack.test.js'],
    summary: 'closed TASK_RESULT_ACK generation seam',
    planRef: 'delivery/stages/S03/plan.md',
    authorityRefs: ['tech-spec/contracts.md#4.3', 'tech-spec/contracts.md#7'],
    gitBasis: GIT_BASIS,
    actionToken: LANE_TOKEN,
    resultId: 's03-b-t02-result-0001',
    ...overrides,
  });
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

/** A valid durable `result` kind fact (is_execute_result: carries id+digest). */
function resultFact(
  id: string,
  overrides: Record<string, unknown> = {},
): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:result:${id}`,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#4.3'],
    scope: { stage_id: 'S03', slice_id: 'S03-B', task_id: 'S03-B-T02' },
    work_id: 'mes:work:S03:S03-B:1',
    result_ref: `mes:result:S03:${id}`,
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    result_id: `attempt-${id}`,
    result_payload_digest: sha256Hex(id),
    ...overrides,
  };
}

/** A legacy S01 result fact (is_legacy_s01_result: no result_id/digest). */
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

function decision(overrides: Record<string, unknown> = {}): TaskResultAckDecision {
  return {
    resultDisposition: 'ACCEPTED' as const,
    continuationDisposition: 'CONTINUE' as const,
    acceptedResultRef: 'mes:result:S03:s03-b-t02-result-0001',
    ...overrides,
  } as TaskResultAckDecision;
}

/** Assert the ACK carries exactly the closed field set (no producer fields). */
function assertClosedAck(ack: TaskResultAck): void {
  const keys = Object.keys(ack).sort();
  const expected = [
    'acceptedResultRef',
    'actionToken',
    'continuationDisposition',
    'executionMode',
    'kind',
    'reasonCode',
    'resultDisposition',
    'resultId',
    'sliceId',
    'stageId',
    'taskId',
    'validatedGitBasis',
  ].filter((key) => ack[key as keyof TaskResultAck] !== undefined);
  assert.deepEqual(keys, expected.sort());
  for (const forbidden of [
    'nextTaskId',
    'nextAction',
    'recommendedAction',
    'producerInstruction',
    'receipt',
    'gate',
  ]) {
    assert.ok(!(forbidden in ack), `ACK must never carry ${forbidden}`);
  }
}

describe('closed TASK_RESULT_ACK generation (S03-B-T02)', () => {
  test('builds the three legal closed combinations only', () => {
    const base = {
      laneActionToken: LANE_TOKEN,
      submitted: submittedResult(),
      durableFacts: [
        resultFact('s03-b-t02-result-0001', {
          result_id: 's03-b-t02-result-0001',
          result_payload_digest: submittedResult().resultPayloadDigest,
        }),
      ],
    };
    // ACCEPTED + CONTINUE (fresh, fact already durably written by Brain).
    const acceptedContinue = buildTaskResultAck({
      ...base,
      decision: decision(),
    });
    assert.equal(acceptedContinue.kind, TASK_RESULT_ACK_KIND);
    assert.equal(acceptedContinue.resultDisposition, 'ACCEPTED');
    assert.equal(acceptedContinue.continuationDisposition, 'CONTINUE');
    assert.equal(acceptedContinue.acceptedResultRef, 'mes:result:S03:s03-b-t02-result-0001');
    assert.equal(acceptedContinue.reasonCode, undefined);
    assert.deepEqual(acceptedContinue.validatedGitBasis, GIT_BASIS);
    assertClosedAck(acceptedContinue);

    // ACCEPTED + PAUSE requires a reasonCode.
    const acceptedPause = buildTaskResultAck({
      ...base,
      decision: decision({
        continuationDisposition: 'PAUSE',
        reasonCode: 'lane-paused',
      }),
    });
    assert.equal(acceptedPause.resultDisposition, 'ACCEPTED');
    assert.equal(acceptedPause.continuationDisposition, 'PAUSE');
    assert.equal(acceptedPause.reasonCode, 'lane-paused');
    assertClosedAck(acceptedPause);

    // REJECTED + PAUSE: no acceptedResultRef, reasonCode required.
    const rejectedPause = buildTaskResultAck({
      ...base,
      decision: decision({
        resultDisposition: 'REJECTED',
        continuationDisposition: 'PAUSE',
        reasonCode: 'binding-broken',
        acceptedResultRef: undefined,
      }),
      durableFacts: [],
    });
    assert.equal(rejectedPause.resultDisposition, 'REJECTED');
    assert.equal(rejectedPause.continuationDisposition, 'PAUSE');
    assert.equal(rejectedPause.acceptedResultRef, undefined);
    assert.equal(rejectedPause.reasonCode, 'binding-broken');
    assertClosedAck(rejectedPause);

    // PRE_MES_BOOTSTRAP + ACCEPTED + CONTINUE: no acceptedResultRef.
    const bootstrap = buildTaskResultAck({
      ...base,
      submitted: submittedResult({ executionMode: 'PRE_MES_BOOTSTRAP', resultRef: undefined }),
      decision: decision({ acceptedResultRef: undefined }),
      durableFacts: [],
    });
    assert.equal(bootstrap.executionMode, 'PRE_MES_BOOTSTRAP');
    assert.equal(bootstrap.resultDisposition, 'ACCEPTED');
    assert.equal(bootstrap.acceptedResultRef, undefined);
    assertClosedAck(bootstrap);
  });

  test('rejects REJECTED + CONTINUE and invalid field combinations', () => {
    const base = {
      laneActionToken: LANE_TOKEN,
      submitted: submittedResult(),
      durableFacts: [],
    };
    const cases: Array<[string, TaskResultAckDecision]> = [
      [
        'REJECTED + CONTINUE is invalid',
        decision({ resultDisposition: 'REJECTED', continuationDisposition: 'CONTINUE' }),
      ],
      ['reasonCode missing on REJECTED', decision({ resultDisposition: 'REJECTED', continuationDisposition: 'PAUSE' })],
      ['reasonCode missing on PAUSE', decision({ continuationDisposition: 'PAUSE' })],
      ['reasonCode forbidden on ACCEPTED+CONTINUE', decision({ reasonCode: 'why' })],
      ['acceptedResultRef forbidden on REJECTED', decision({ resultDisposition: 'REJECTED', continuationDisposition: 'PAUSE', reasonCode: 'x', acceptedResultRef: 'mes:result:S03:y' })],
      ['acceptedResultRef forbidden on bootstrap', decision({ acceptedResultRef: 'mes:result:S03:y' })],
      ['unknown decision key', { ...decision(), bogus: 1 } as TaskResultAckDecision],
    ];
    for (const [label, badDecision] of cases) {
      assert.throws(
        () =>
          buildTaskResultAck({
            ...base,
            submitted: label.includes('bootstrap')
              ? submittedResult({ executionMode: 'PRE_MES_BOOTSTRAP', resultRef: undefined })
              : submittedResult(),
            decision: badDecision as never,
          }),
        (err: unknown) => {
          assert.ok(err instanceof TaskResultAckError);
          assert.equal(err.code, 'RESULT_INVALID');
          return true;
        },
        `expected ${label} to fail closed`,
      );
    }
    // Unknown keys on the outer input and on the submitted result fail closed.
    assert.throws(
      () =>
        buildTaskResultAck({
          laneActionToken: LANE_TOKEN,
          submitted: submittedResult(),
          decision: decision(),
          durableFacts: [],
          bogus: true,
        } as never),
      (err: unknown) => {
        assert.ok(err instanceof TaskResultAckError);
        assert.equal(err.code, 'RESULT_INVALID');
        return true;
      },
    );
  });

  test('fails closed on stale actionToken with RESULT_BINDING_MISMATCH', () => {
    const stale = submittedResult({ actionToken: 'stale-lane-token' });
    assert.throws(
      () =>
        buildTaskResultAck({
          laneActionToken: LANE_TOKEN,
          submitted: stale,
          decision: decision(),
          durableFacts: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof TaskResultAckError);
        assert.equal(err.code, 'RESULT_BINDING_MISMATCH');
        return true;
      },
    );
    // A token derived from Link message id / pane / session is just another
    // token value — never the lane token.
    assert.throws(
      () =>
        buildTaskResultAck({
          laneActionToken: LANE_TOKEN,
          submitted: submittedResult({ actionToken: 'hl_mtp6uv1o_9a3mcnoz' }),
          decision: decision(),
          durableFacts: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof TaskResultAckError);
        assert.equal(err.code, 'RESULT_BINDING_MISMATCH');
        return true;
      },
    );
  });

  test('replays idempotently via the durable payload digest (lost-ACK / restart)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const fact = resultFact('s03-b-t02-result-0001', {
        result_id: 's03-b-t02-result-0001',
        result_payload_digest: submittedResult().resultPayloadDigest,
      });
      store.write([fact]);

      // Lost ACK: Brain re-submits the SAME payload (same resultId + digest)
      // against the durable facts → equivalent ACCEPTED ACK.
      const replay = buildTaskResultAck({
        laneActionToken: LANE_TOKEN,
        submitted: submittedResult(),
        decision: decision(),
        durableFacts: store.read(),
      });
      assert.equal(replay.resultDisposition, 'ACCEPTED');
      assert.equal(replay.continuationDisposition, 'CONTINUE');
      assert.equal(replay.acceptedResultRef, fact.result_ref);
      assertClosedAck(replay);

      // Restart: a FRESH store instance over the same snapshot derives the
      // same equivalent ACK (recovery basis = durable facts only).
      const restartedStore = createMesSnapshotStore(fixture.dir);
      const afterRestart = buildTaskResultAck({
        laneActionToken: LANE_TOKEN,
        submitted: submittedResult(),
        decision: decision(),
        durableFacts: restartedStore.read(),
      });
      assert.equal(afterRestart.resultDisposition, 'ACCEPTED');
      assert.equal(afterRestart.acceptedResultRef, fact.result_ref);
      assert.deepEqual(afterRestart, replay);

      // Equivalent duplicates (same result_id + identical digest across
      // different fact_ids) merge deterministically — still one ACCEPTED.
      const dup = resultFact('dup-b', {
        fact_id: 'mes:fact:result:dup-b-fact',
        result_id: 's03-b-t02-result-0001',
        result_payload_digest: submittedResult().resultPayloadDigest,
      });
      store.write([...store.read(), dup]);
      const merged = buildTaskResultAck({
        laneActionToken: LANE_TOKEN,
        submitted: submittedResult(),
        decision: decision(),
        durableFacts: store.read(),
      });
      assert.equal(merged.resultDisposition, 'ACCEPTED');
      assertClosedAck(merged);
    } finally {
      fixture.cleanup();
    }
  });

  test('fails closed on same resultId with a different payload digest', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      // Same result_id as the submission, different payload digest.
      store.write([resultFact('s03-b-t02-result-0001', { result_id: 's03-b-t02-result-0001' })]);
      const replayedWithDifferentPayload = submittedResult({
        summary: 'a completely different payload',
      });
      assert.notEqual(
        replayedWithDifferentPayload.resultPayloadDigest,
        store.read()[0].result_payload_digest,
      );
      assert.throws(
        () =>
          buildTaskResultAck({
            laneActionToken: LANE_TOKEN,
            submitted: replayedWithDifferentPayload,
            decision: decision(),
            durableFacts: store.read(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof TaskResultAckError);
          assert.equal(err.code, 'RESULT_INVALID');
          return true;
        },
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('fails closed on durable duplicate result_id conflicts after restart (no winner)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      // Two facts, different fact_ids, SAME result_id, DIFFERENT digests —
      // a durable-state conflict that must fail closed with no ACK ambiguity.
      store.write([
        resultFact('conflict-a', {
          fact_id: 'mes:fact:result:conflict-a',
          result_id: 's03-b-t02-result-0001',
          result_payload_digest: sha256Hex('payload-v1'),
        }),
        resultFact('conflict-b', {
          fact_id: 'mes:fact:result:conflict-b',
          result_id: 's03-b-t02-result-0001',
          result_payload_digest: sha256Hex('payload-v2'),
        }),
      ]);
      assert.equal(store.read().length, 2);
      for (const facts of [store.read(), createMesSnapshotStore(fixture.dir).read()]) {
        assert.throws(
          () =>
            buildTaskResultAck({
              laneActionToken: LANE_TOKEN,
              submitted: submittedResult(),
              decision: decision(),
              durableFacts: facts,
            }),
          (err: unknown) => {
            assert.ok(err instanceof TaskResultAckError);
            assert.equal(err.code, 'RESULT_INVALID');
            return true;
          },
          'duplicate result_id conflict must fail closed, before and after restart',
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('ignores legacy S01 result facts in the replay index', () => {
    const durable = [legacyS01ResultFact(), legacyS01ResultFact()];
    // Legacy facts (no result_id) never enter the replay index, so they can
    // never collide with a submission or create conflicts (REJECTED+PAUSE
    // is decided purely by the decision input here).
    const ack = buildTaskResultAck({
      laneActionToken: LANE_TOKEN,
      submitted: submittedResult(),
      decision: decision({
        resultDisposition: 'REJECTED',
        continuationDisposition: 'PAUSE',
        reasonCode: 'rejected',
        acceptedResultRef: undefined,
      }),
      durableFacts: durable,
    });
    assert.equal(ack.resultDisposition, 'REJECTED');
    assert.equal(ack.continuationDisposition, 'PAUSE');
    assertClosedAck(ack);
    // A legacy S01 fact cannot back a NORMAL+ACCEPTED acceptedResultRef for
    // this submission either — the result_id / digest binding fails closed.
    const legacyWithMatchingRef = legacyS01ResultFact();
    assert.throws(
      () =>
        buildTaskResultAck({
          laneActionToken: LANE_TOKEN,
          submitted: submittedResult(),
          decision: decision({ acceptedResultRef: legacyWithMatchingRef.result_ref }),
          durableFacts: [legacyWithMatchingRef],
        }),
      (err: unknown) => {
        assert.ok(err instanceof TaskResultAckError);
        assert.equal(err.code, 'RESULT_BINDING_MISMATCH');
        return true;
      },
    );
  });

  test('requires a durable result fact for NORMAL+ACCEPTED acceptedResultRef', () => {
    // Fresh submission whose acceptedResultRef does NOT resolve to a durable
    // result fact → no acceptance.
    assert.throws(
      () =>
        buildTaskResultAck({
          laneActionToken: LANE_TOKEN,
          submitted: submittedResult(),
          decision: decision({ acceptedResultRef: 'mes:result:S03:not-written' }),
          durableFacts: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof TaskResultAckError);
        assert.equal(err.code, 'RESULT_INVALID');
        return true;
      },
    );
    // The durable fact backing the ref must belong to THIS submission
    // (result_id + digest equality) — otherwise binding fails closed.
    const otherSubmission = resultFact('other-submission', {
      result_id: 'attempt-other',
      result_payload_digest: sha256Hex('other-payload'),
    });
    assert.throws(
      () =>
        buildTaskResultAck({
          laneActionToken: LANE_TOKEN,
          submitted: submittedResult(),
          decision: decision({ acceptedResultRef: otherSubmission.result_ref }),
          durableFacts: [otherSubmission],
        }),
      (err: unknown) => {
        assert.ok(err instanceof TaskResultAckError);
        assert.equal(err.code, 'RESULT_BINDING_MISMATCH');
        return true;
      },
    );
  test('rejects a taskless submitted Result for TASK_RESULT_ACK', () => {
    // slice-ready / repair are taskless non-ACK results: the ACK seam only
    // accepts the per-task shape with taskId.
    const taskless = validateWorkerTaskResult({
      executionMode: 'NORMAL',
      stageId: 'S03',
      sliceId: 'S03-B',
      outcome: 'completed',
      resultRef: 'mes:result:S03:S03-B:slice-ready:1',
      changedFiles: ['packages/runtime/src/execute/task-result.ts'],
      verificationRuns: ['node --test packages/runtime/test-dist/task-result.test.js'],
      summary: 'slice candidate ready',
      planRef: 'delivery/stages/S03/plan.md',
      authorityRefs: ['tech-spec/contracts.md#4.3'],
      gitBasis: GIT_BASIS,
      actionToken: LANE_TOKEN,
      resultId: 's03-b-slice-ready-0001',
    });
    assert.equal(taskless.subShape, 'taskless');
    assert.throws(
      () =>
        buildTaskResultAck({
          laneActionToken: LANE_TOKEN,
          submitted: taskless,
          decision: decision(),
          durableFacts: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof TaskResultAckError);
        assert.equal(err.code, 'RESULT_INVALID');
        return true;
      },
    );
  });
  });
});
