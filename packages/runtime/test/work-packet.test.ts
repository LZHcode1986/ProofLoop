/**
 * Slice Work Packet / JIT Read Set / bounded Repair Work Packet tests (S03-C-T01).
 *
 * # PO: PO-S03-C-01
 *
 * These tests exercise the closed, pure machine-check seam required by
 * tech-spec/contracts.md §4.2 and the canonical worker template.  Plan fields
 * are deliberately not part of a Work Packet shape.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkPacketValidationError,
  validateBoundedRepairWorkPacket,
  validateJitReadSet,
  validateSliceWorkPacket,
  getWorkPacketShape,
} from '../dist/execute/work-packet';

const HEAD = '1d54108d25ad99387dd55784dd879980d396e8ed';

function slicePacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution_mode: 'NORMAL',
    target_agent: 'worker',
    caller: 'brain',
    skill: 'proofloop-execute',
    stage_id: 'S03',
    slice_id: 'S03-C',
    project_root: process.cwd(),
    thin_plan_ref: 'delivery/stages/S03/plan.md',
    authority_refs: ['tech-spec/contracts.md#4.2', 'tech-spec/acceptance.md#STATIC-25'],
    actionToken: 'lane-token-s03-c',
    code_anchors: ['packages/runtime/src/execute/work-packet.ts'],
    git_basis: {
      worktree: '.proofloop/worktrees/S03-S03-C',
      base_ref: HEAD,
    },
    scope: {
      allowed_paths: ['packages/runtime/src/execute/work-packet.ts'],
      forbidden_paths: ['.git', '.proofloop'],
    },
    required_skills: ['test-driven-development'],
    slice_task_ids: ['S03-C-T01', 'S03-C-T02'],
    stop_conditions: ['scope or binding is stale'],
    expected_result: 'SLICE_CANDIDATE_READY',
    ...overrides,
  };
}

function jitReadSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution_mode: 'NORMAL',
    task_id: 'S03-C-T01',
    task_goal: 'closed Work Packet validation',
    plan_ref: 'delivery/stages/S03/plan.md',
    authority_refs: ['tech-spec/contracts.md#4.2'],
    code_anchors: ['packages/runtime/src/execute/work-packet.ts'],
    allowed_scope: {
      code_paths: ['packages/runtime/src/execute/work-packet.ts'],
      test_paths: ['packages/runtime/test/work-packet.test.ts'],
      forbidden_paths: ['.git', '.proofloop'],
    },
    dependency_outputs: ['mes:fact:plan_acceptance:S03:1'],
    done_criteria: ['all three packet shapes fail closed on malformed input'],
    stop_conditions: ['schema ownership would move to the Plan'],
    required_skills: ['test-driven-development'],
    actionToken: 'lane-token-s03-c',
    ...overrides,
  };
}

function repairPacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repair_scope: ['packages/runtime/src/execute/work-packet.ts'],
    failed_criterion: 'unknown packet fields are rejected',
    concrete_counterexample: 'a project_stage_map_ref key was accepted by the candidate',
    required_recheck_scope: ['packages/runtime/test/work-packet.test.ts'],
    repair_diff_basis: HEAD,
    ...overrides,
  };
}

describe('closed Worker Work Packet schemas (S03-C-T01)', () => {
  test('validates projected Work Packet, JIT Read Set and bounded repair shapes', () => {
    const packet = validateSliceWorkPacket(slicePacket());
    assert.equal(packet.execution_mode, 'NORMAL');
    assert.equal(packet.expected_result, 'SLICE_CANDIDATE_READY');
    assert.deepEqual(packet.slice_task_ids, ['S03-C-T01', 'S03-C-T02']);

    const jit = validateJitReadSet(jitReadSet());
    assert.equal(jit.task_id, 'S03-C-T01');
    assert.deepEqual(jit.allowed_scope.test_paths, ['packages/runtime/test/work-packet.test.ts']);

    const repair = validateBoundedRepairWorkPacket(repairPacket());
    assert.deepEqual(repair.repair_scope, ['packages/runtime/src/execute/work-packet.ts']);

    assert.equal(getWorkPacketShape(slicePacket()), 'slice');
    assert.equal(getWorkPacketShape(jitReadSet()), 'jit');
    assert.equal(getWorkPacketShape(repairPacket()), 'repair');
  });

  test('rejects missing and unknown fields without copying Plan schema', () => {
    const missing = slicePacket();
    delete missing.actionToken;
    assert.throws(() => validateSliceWorkPacket(missing), (error: unknown) => {
      assert.ok(error instanceof WorkPacketValidationError);
      assert.equal(error.code, 'RESULT_INVALID');
      return true;
    });

    assert.throws(() => validateSliceWorkPacket(slicePacket({ project_stage_map_ref: 'delivery/project-stage-map.md#S03' })), WorkPacketValidationError);
    assert.throws(() => validateJitReadSet(jitReadSet({ slice_id: 'S03-C' })), WorkPacketValidationError);
    assert.throws(() => validateJitReadSet(jitReadSet({ accepted_plan_ref: 'delivery/stages/S03/plan.md' })), WorkPacketValidationError, 'non-canonical accepted_plan_ref alias is an unknown JIT field');
    const repairWithTask = repairPacket({ task_id: 'S03-C-T01' });
    assert.throws(() => validateBoundedRepairWorkPacket(repairWithTask), WorkPacketValidationError);
  });

  test('fails closed on empty, protected, traversing and overlapping scopes', () => {
    assert.throws(() => validateSliceWorkPacket(slicePacket({
      scope: { allowed_paths: [], forbidden_paths: ['.git', '.proofloop'] },
    })), WorkPacketValidationError);
    assert.throws(() => validateSliceWorkPacket(slicePacket({
      scope: { allowed_paths: ['../outside'], forbidden_paths: ['.git', '.proofloop'] },
    })), WorkPacketValidationError);
    assert.throws(() => validateSliceWorkPacket(slicePacket({
      scope: { allowed_paths: ['.proofloop/mes/snapshot.json'], forbidden_paths: ['.git', '.proofloop'] },
    })), WorkPacketValidationError);
    assert.throws(() => validateJitReadSet(jitReadSet({
      allowed_scope: {
        code_paths: ['packages/runtime/src/execute/work-packet.ts'],
        test_paths: ['packages/runtime/test/work-packet.test.ts'],
        forbidden_paths: ['packages/runtime'],
      },
    })), WorkPacketValidationError);
    assert.throws(() => validateBoundedRepairWorkPacket(repairPacket({ repair_scope: ['packages/runtime//src/x.ts'] })), WorkPacketValidationError);
  });

  test('keeps bootstrap mode Git-bound and rejects MES-only result fields', () => {
    const bootstrap = slicePacket({ execution_mode: 'PRE_MES_BOOTSTRAP' });
    assert.equal(validateSliceWorkPacket(bootstrap).execution_mode, 'PRE_MES_BOOTSTRAP');
    assert.equal(validateJitReadSet({ ...jitReadSet(), execution_mode: 'PRE_MES_BOOTSTRAP' }).execution_mode, 'PRE_MES_BOOTSTRAP');
    assert.throws(() => validateSliceWorkPacket(slicePacket({ resultRef: 'mes:result:S03:S03-C:1' })), WorkPacketValidationError);
    assert.throws(() => validateJitReadSet(jitReadSet({ result_ref: 'mes:result:S03:S03-C:1' })), WorkPacketValidationError);
  });
});
