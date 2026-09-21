/**
 * Worker Task Result envelope closed-set validation tests (S03-B-T01).
 *
 * # PO: PO-S03-B-01
 *
 * Exercises the pure validation seam packages/runtime/src/execute/task-result.ts
 * (worker-template Result envelope schema + tech-spec/contracts.md §4.3):
 *   - closed field set: executionMode / stageId / sliceId / taskId / outcome /
 *     resultRef / changedFiles / verificationRuns / summary / planRef /
 *     authorityRefs / gitBasis / actionToken / resultId;
 *   - outcome ∈ {completed, blocked, needs-decision, failed}; NORMAL requires a
 *     root-relative resultRef, PRE_MES_BOOTSTRAP forbids it; taskless sub-shapes
 *     (slice-ready / repair) per template with taskId omitted;
 *   - unknown keys, control characters, out-of-bound paths, non-canonical
 *     authority refs and malformed gitBasis fail closed with a typed §7 outcome
 *     (RESULT_INVALID / RESULT_BINDING_MISMATCH), no partial acceptance
 *     (E2E-19 / STATIC-08 / FR-014: transport metadata is never Result content);
 *   - the submitted result_payload_digest is computed per the S03-A-T01 frozen
 *     formula: SHA-256(SPN(result_payload_fields)) over
 *     {executionMode, stageId, sliceId, taskId, outcome, resultRef,
 *      changedFiles(order), verificationRuns(order), summary, planRef,
 *      authorityRefs(canonical-only, order), gitBasis{head,branch,worktree}}
 *     with explicit omit = transport/session metadata, resultId and actionToken;
 *     the digest is delivered as part of the normalized result.
 *
 * Pure function seam: never reads MES, never writes the store.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {
  validateWorkerTaskResult,
  computeResultPayloadDigest,
  TaskResultValidationError,
  TASK_RESULT_OUTCOMES,
  TASK_RESULT_MODES,
} from '../dist/execute/task-result';
import type { WorkerTaskResultEnvelope } from '../dist/execute/task-result';

const HEAD_40 = '1111111111111111111111111111111111111111';

/** Deterministic sha256 of a UTF-8 string (independent digest oracle). */
function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Known-good canonical JSON literal for the S03-A-T01 frozen digest formula.
 * canonicalStringify sorts object keys recursively, keeps array order, drops
 * undefined; this literal is written by hand (independent source of truth) and
 * must stay byte-identical to what the formula produces.
 */
function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionMode: 'NORMAL',
    stageId: 'S03',
    sliceId: 'S03-B',
    taskId: 'S03-B-T01',
    outcome: 'completed',
    resultRef: 'mes:result:S03:S03-B-T01:1',
    changedFiles: ['packages/runtime/src/execute/task-result.ts'],
    verificationRuns: ['node --test packages/runtime/test-dist/task-result.test.js'],
    summary: 'validates a closed worker task result envelope',
    planRef: 'delivery/stages/S03/plan.md',
    authorityRefs: ['tech-spec/contracts.md#4.3', 'tech-spec/contracts.md#7'],
    gitBasis: {
      head: HEAD_40,
      branch: 'worktree/s03-b',
      worktree: '.proofloop/worktrees/S03-S03-B',
    },
    actionToken: '2fb5b7cd-550a-4b3d-b337-dae70305b903',
    resultId: 'result-0001',
    ...overrides,
  };
}

/** The expected canonical payload for the valid envelope (sorted keys, taskId present). */
const VALID_CANONICAL =
  '{"authorityRefs":["tech-spec/contracts.md#4.3","tech-spec/contracts.md#7"],' +
  '"changedFiles":["packages/runtime/src/execute/task-result.ts"],' +
  '"executionMode":"NORMAL",' +
  '"gitBasis":{"branch":"worktree/s03-b","head":"1111111111111111111111111111111111111111","worktree":".proofloop/worktrees/S03-S03-B"},' +
  '"outcome":"completed",' +
  '"planRef":"delivery/stages/S03/plan.md",' +
  '"resultRef":"mes:result:S03:S03-B-T01:1",' +
  '"sliceId":"S03-B",' +
  '"stageId":"S03",' +
  '"summary":"validates a closed worker task result envelope",' +
  '"taskId":"S03-B-T01",' +
  '"verificationRuns":["node --test packages/runtime/test-dist/task-result.test.js"]}';

/** The expected canonical payload for the taskless (slice-ready/repair) shape. */
const TASKLESS_CANONICAL =
  '{"authorityRefs":["tech-spec/contracts.md#4.3","tech-spec/contracts.md#7"],' +
  '"changedFiles":["packages/runtime/src/execute/task-result.ts"],' +
  '"executionMode":"NORMAL",' +
  '"gitBasis":{"branch":"worktree/s03-b","head":"1111111111111111111111111111111111111111","worktree":".proofloop/worktrees/S03-S03-B"},' +
  '"outcome":"completed",' +
  '"planRef":"delivery/stages/S03/plan.md",' +
  '"resultRef":"mes:result:S03:S03-B-T01:1",' +
  '"sliceId":"S03-B",' +
  '"stageId":"S03",' +
  '"summary":"validates a closed worker task result envelope",' +
  '"verificationRuns":["node --test packages/runtime/test-dist/task-result.test.js"]}';

describe('Worker Task Result envelope validation (S03-B-T01)', () => {
  test('accepts a bounded NORMAL task result envelope and computes the payload digest', () => {
    const validated = validateWorkerTaskResult(validEnvelope());
    assert.equal(validated.executionMode, 'NORMAL');
    assert.equal(validated.stageId, 'S03');
    assert.equal(validated.sliceId, 'S03-B');
    assert.equal(validated.taskId, 'S03-B-T01');
    assert.equal(validated.outcome, 'completed');
    assert.equal(validated.resultRef, 'mes:result:S03:S03-B-T01:1');
    assert.deepEqual(validated.changedFiles, ['packages/runtime/src/execute/task-result.ts']);
    assert.equal(validated.summary, 'validates a closed worker task result envelope');
    assert.equal(validated.planRef, 'delivery/stages/S03/plan.md');
    assert.deepEqual(validated.authorityRefs, [
      'tech-spec/contracts.md#4.3',
      'tech-spec/contracts.md#7',
    ]);
    assert.deepEqual(validated.gitBasis, {
      head: HEAD_40,
      branch: 'worktree/s03-b',
      worktree: '.proofloop/worktrees/S03-S03-B',
    });
    assert.equal(validated.actionToken, '2fb5b7cd-550a-4b3d-b337-dae70305b903');
    assert.equal(validated.resultId, 'result-0001');
    assert.equal(validated.subShape, 'task');
    // 64-hex digest matching the frozen S03-A-T01 formula on the hand-written
    // canonical literal (independent oracle, not recomputed from the code).
    assert.match(validated.resultPayloadDigest, /^[0-9a-f]{64}$/);
    assert.equal(validated.resultPayloadDigest, sha256Hex(VALID_CANONICAL));
    // The exported formula agrees and is deterministic.
    assert.equal(computeResultPayloadDigest(validated), sha256Hex(VALID_CANONICAL));
  });

  test('omits resultId and actionToken from the digest but includes payload changes', () => {
    const base = validateWorkerTaskResult(validEnvelope());
    // Same payload under a different resultId / actionToken → identical digest
    // (replay key and lane control token are explicitly omitted).
    const otherId = validateWorkerTaskResult(
      validEnvelope({ resultId: 'result-9999', actionToken: 'lane-token-2' }),
    );
    assert.equal(otherId.resultPayloadDigest, base.resultPayloadDigest);
    // A payload change flips the digest.
    const changed = validateWorkerTaskResult(
      validEnvelope({ summary: 'a different summary entirely' }),
    );
    assert.notEqual(changed.resultPayloadDigest, base.resultPayloadDigest);
  });

  test('accepts a PRE_MES_BOOTSTRAP envelope without resultRef', () => {
    const envelope = validEnvelope({
      executionMode: 'PRE_MES_BOOTSTRAP',
      planRef: 'delivery/stages/S03/plan.md',
    });
    delete envelope.resultRef;
    const validated = validateWorkerTaskResult(envelope);
    assert.equal(validated.executionMode, 'PRE_MES_BOOTSTRAP');
    assert.equal(validated.resultRef, undefined);
    // Digest over the payload without the resultRef key (key dropped, not null),
    // with the executionMode value swapped to PRE_MES_BOOTSTRAP.
    const canonicalNoResultRef = VALID_CANONICAL
      .replace('"executionMode":"NORMAL"', '"executionMode":"PRE_MES_BOOTSTRAP"')
      .replace('"resultRef":"mes:result:S03:S03-B-T01:1",', '');
    assert.equal(validated.resultPayloadDigest, sha256Hex(canonicalNoResultRef));
  });

  test('rejects NORMAL without resultRef and bootstrap with resultRef', () => {
    const normalMissingRef = validEnvelope();
    delete normalMissingRef.resultRef;
    assert.throws(() => validateWorkerTaskResult(normalMissingRef), (err: unknown) => {
      assert.ok(err instanceof TaskResultValidationError);
      assert.equal(err.outcome, 'RESULT_INVALID');
      return true;
    });
    assert.throws(
      () =>
        validateWorkerTaskResult(
          validEnvelope({
            executionMode: 'PRE_MES_BOOTSTRAP',
            resultRef: 'mes:result:S03:S03-B-T01:1',
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof TaskResultValidationError);
        assert.equal(err.outcome, 'RESULT_INVALID');
        return true;
      },
    );
  });

  test('fails closed on unknown keys and transport / session metadata', () => {
    for (const extra of [
      'nextTaskId',
      'nextAction',
      'recommendedAction',
      'producerInstruction',
      'linkMessageId',
      'pane',
      'session',
      'sent',
      'idle',
      'done',
      'route',
      'reasoning',
    ]) {
      assert.throws(
        () => validateWorkerTaskResult(validEnvelope({ [extra]: 'x' })),
        (err: unknown) => {
          assert.ok(err instanceof TaskResultValidationError);
          assert.equal(err.outcome, 'RESULT_INVALID');
          return true;
        },
        `expected unknown key ${extra} to fail closed`,
      );
    }
  });

  test('fails closed on control characters', () => {
    assert.throws(() => validateWorkerTaskResult(validEnvelope({ summary: 'bad\u0000summary' })));
    assert.throws(() => validateWorkerTaskResult(validEnvelope({ actionToken: 'tok\ninjection' })));
    assert.throws(() => validateWorkerTaskResult(validEnvelope({ resultId: 'id\u2028sep' })));
    assert.throws(() =>
      validateWorkerTaskResult(
        validEnvelope({ changedFiles: ['packages/runtime/src/x\u0000y.ts'] }),
      ),
    );
  });

  test('fails closed on out-of-bound and non-canonical changed files', () => {
    for (const bad of [
      '../etc/passwd',
      '/etc/passwd',
      'a\\b.ts',
      '',
      '.',
      '..',
      'packages//runtime/x.ts',
    ]) {
      assert.throws(
        () => validateWorkerTaskResult(validEnvelope({ changedFiles: [bad] })),
        (err: unknown) => {
          assert.ok(err instanceof TaskResultValidationError);
          return true;
        },
        `expected changedFiles entry ${JSON.stringify(bad)} to fail closed`,
      );
    }
    assert.throws(() =>
      validateWorkerTaskResult(
        validEnvelope({ verificationRuns: ['../escape'] }),
      ),
    );
    assert.throws(() => validateWorkerTaskResult(validEnvelope({ changedFiles: 'not-an-array' })));
    assert.throws(() =>
      validateWorkerTaskResult(validEnvelope({ verificationRuns: 42 })),
    );
  });

  test('fails closed on invalid outcome, executionMode, ids and planRef', () => {
    assert.throws(() => validateWorkerTaskResult(validEnvelope({ outcome: 'nope' })));
    assert.throws(() =>
      validateWorkerTaskResult(validEnvelope({ executionMode: 'LEGACY' })),
    );
    assert.throws(() => validateWorkerTaskResult(validEnvelope({ stageId: 'S0X' })));
    assert.throws(() => validateWorkerTaskResult(validEnvelope({ sliceId: 'S03' })));
    assert.throws(() => validateWorkerTaskResult(validEnvelope({ taskId: 'S03-B-T0X' })));
    assert.throws(() =>
      validateWorkerTaskResult(validEnvelope({ planRef: '/abs/plan.md' })),
    );
    assert.throws(() =>
      validateWorkerTaskResult(validEnvelope({ planRef: '../plan.md' })),
    );
    assert.throws(() =>
      validateWorkerTaskResult(validEnvelope({ resultRef: '../mes:result:x' })),
    );
  });

  test('fails closed on invalid authority refs and missing required fields', () => {
    assert.throws(() =>
      validateWorkerTaskResult(
        validEnvelope({ authorityRefs: ['tech-spec/contracts.md'] }),
      ),
    );
    assert.throws(() =>
      validateWorkerTaskResult(validEnvelope({ authorityRefs: ['/abs#x'] })),
    );
    assert.throws(() => validateWorkerTaskResult(validEnvelope({ authorityRefs: 'nope' })));
    const missing = validEnvelope();
    delete missing.summary;
    assert.throws(() => validateWorkerTaskResult(missing));
    const missingToken = validEnvelope();
    delete missingToken.actionToken;
    assert.throws(() => validateWorkerTaskResult(missingToken));
    const missingResultId = validEnvelope();
    delete missingResultId.resultId;
    assert.throws(() => validateWorkerTaskResult(missingResultId));
    assert.throws(() => validateWorkerTaskResult(null));
    assert.throws(() => validateWorkerTaskResult('not-an-object'));
  });

  test('fails closed on malformed gitBasis with a RESULT_BINDING_MISMATCH outcome', () => {
    assert.throws(
      () => validateWorkerTaskResult(validEnvelope({ gitBasis: { head: HEAD_40, branch: 'b' } })),
      (err: unknown) => {
        assert.ok(err instanceof TaskResultValidationError);
        assert.equal(err.outcome, 'RESULT_BINDING_MISMATCH');
        return true;
      },
    );
    assert.throws(() =>
      validateWorkerTaskResult(
        validEnvelope({ gitBasis: { head: 'short', branch: 'b', worktree: 'w' } }),
      ),
    );
    assert.throws(() =>
      validateWorkerTaskResult(
        validEnvelope({
          gitBasis: { head: HEAD_40, branch: 'b', worktree: '/abs/worktree' },
        }),
      ),
    );
    assert.throws(() =>
      validateWorkerTaskResult(
        validEnvelope({ gitBasis: { head: HEAD_40, branch: 'b', worktree: 'w', extra: 1 } }),
      ),
    );
    assert.throws(() => validateWorkerTaskResult(validEnvelope({ gitBasis: null })));
  });

  test('accepts taskless sub-shapes (slice-ready / repair) with the digest excluding taskId', () => {
    const sliceReady = validEnvelope({ taskId: undefined });
    delete sliceReady.taskId;
    const validated = validateWorkerTaskResult(sliceReady);
    assert.equal(validated.taskId, undefined);
    assert.equal(validated.subShape, 'taskless');
    assert.equal(validated.resultPayloadDigest, sha256Hex(TASKLESS_CANONICAL));

    // A repair-shaped result (taskless, closed outcome) is the same closed shape.
    const repair = validEnvelope({ outcome: 'completed', summary: 'bounded repair evidence' });
    delete repair.taskId;
    const repairValidated = validateWorkerTaskResult(repair);
    assert.equal(repairValidated.subShape, 'taskless');
    assert.equal(repairValidated.outcome, 'completed');
    assert.match(repairValidated.resultPayloadDigest, /^[0-9a-f]{64}$/);
  });


  test('rejects task ids whose stage/slice do not match the envelope scope', () => {
    // taskId must belong to the envelope stageId/sliceId (cross-scope task
    // ids fail closed); taskless shapes omit taskId but still require
    // stage/slice closure (covered by the always-required stageId/sliceId).
    for (const bad of ['S03-A-T01', 'S02-B-T01', 'S03-BB-T01', 'S04-B-T01']) {
      assert.throws(
        () => validateWorkerTaskResult(validEnvelope({ taskId: bad })),
        (err: unknown) => {
          assert.ok(err instanceof TaskResultValidationError);
          assert.equal(err.outcome, 'RESULT_INVALID');
          return true;
        },
        `taskId ${bad} must belong to S03 / S03-B`,
      );
    }
    // A valid in-scope task id still passes.
    assert.equal(validateWorkerTaskResult(validEnvelope()).taskId, 'S03-B-T01');
  });

  test('exposes the closed outcome / mode / sub-shape sets', () => {
    assert.deepEqual([...TASK_RESULT_OUTCOMES], ['completed', 'blocked', 'needs-decision', 'failed']);
    assert.deepEqual([...TASK_RESULT_MODES], ['NORMAL', 'PRE_MES_BOOTSTRAP', 'MES_MAINTENANCE']);
  });
});
