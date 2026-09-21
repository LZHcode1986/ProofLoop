/**
 * MES_MAINTENANCE evidence-only execution-mode tests (S06-R-D-T04).
 *
 * PO: worker-template / code-verifier-template canonical packet/result/ACK/CV
 * schemas + contracts §2.1.5 / §4.2 / §4.3 / §5.1.2 / §5.2 / §5.3; acceptance
 * E2E-26 / STATIC-33.
 *
 * The four canonical Execute validators accept `MES_MAINTENANCE` evidence-only
 * semantics:
 *   - Slice Work Packet / JIT Read Set carry a closed `maintenance_binding`
 *     (snake_case §4.2 tuple) REQUIRED under MES_MAINTENANCE and FORBIDDEN
 *     under NORMAL / PRE_MES_BOOTSTRAP (no second schema, no smuggling);
 *   - Worker Task Result carries a closed `maintenanceBinding` (camelCase
 *     worker-template tuple) REQUIRED under MES_MAINTENANCE and FORBIDDEN
 *     otherwise; resultRef is REQUIRED under NORMAL and FORBIDDEN under
 *     PRE_MES_BOOTSTRAP / MES_MAINTENANCE (Git-bound Link evidence only);
 *   - TASK_RESULT_ACK accepts MES_MAINTENANCE evidence: ACCEPTED never
 *     carries acceptedResultRef (Brain accepts evidence, not a MES Task
 *     completion), and the durable MES result replay index is EXEMPT (ACKs
 *     are rebuilt from recovery Plan + Git refs/commits + frozen/forensic/
 *     audit evidence — contracts §4.3), while NORMAL replay stays intact;
 *   - CV result carries a closed `maintenanceBinding` REQUIRED under
 *     MES_MAINTENANCE and FORBIDDEN otherwise; resultRef omitted; the verdict
 *     gate is unchanged (only PASS + durable candidate ref → READY_TO_INTEGRATE).
 *
 * NORMAL / PRE_MES_BOOTSTRAP behavior is preserved throughout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sha } from './helpers';
import {
  validateSliceWorkPacket,
  validateJitReadSet,
  WorkPacketValidationError,
} from '../dist/execute/work-packet';
import {
  validateWorkerTaskResult,
  TaskResultValidationError,
  computeResultPayloadDigest,
} from '../dist/execute/task-result';
import {
  buildTaskResultAck,
  TaskResultAckError,
  TASK_RESULT_ACK_KIND,
} from '../dist/execute/task-result-ack';
import { validateCvResult, gateCvResult } from '../dist/execute/cv-result';
import type { MesFactEnvelope } from '../dist/mes/types';

const HEAD_40 = 'a'.repeat(40);
const TOKEN = 'lane-token-s06-r-d';

/** Canonical §4.2 snake_case maintenance binding (packets). */
const MAINTENANCE_BINDING = {
  frozen_snapshot_ref: '.proofloop/mes/snapshot.json',
  frozen_snapshot_sha256: sha('frozen'),
  frozen_fact_count: 130,
  forensic_ref: '.proofloop/forensics/incident.json',
  forensic_sha256: sha('incident'),
  audit_ref: '.proofloop/forensics/audit.json',
  audit_sha256: sha('audit'),
};

/** Canonical worker-template camelCase maintenanceBinding (result/CV). */
const MAINTENANCE_BINDING_CAMEL = {
  frozenSnapshotRef: '.proofloop/mes/snapshot.json',
  frozenSnapshotSha256: sha('frozen'),
  frozenFactCount: 130,
  forensicRef: '.proofloop/forensics/incident.json',
  forensicSha256: sha('incident'),
  auditRef: '.proofloop/forensics/audit.json',
  auditSha256: sha('audit'),
};

function maintenanceSlicePacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution_mode: 'MES_MAINTENANCE',
    target_agent: 'worker',
    caller: 'brain',
    skill: 'proofloop-execute',
    stage_id: 'S06',
    slice_id: 'S06-R-D',
    project_root: process.cwd(),
    thin_plan_ref: 'delivery/stages/S06/recovery-plan-r9.md',
    authority_refs: ['tech-spec/contracts.md#2.1.5', 'tech-spec/acceptance.md#E2E-26'],
    actionToken: TOKEN,
    code_anchors: ['packages/runtime/src/mes/maintenance-seam.ts'],
    git_basis: { worktree: '.proofloop/worktrees/S06-S06-R-D', base_ref: HEAD_40 },
    scope: {
      allowed_paths: ['packages/runtime/src/mes/maintenance-seam.ts'],
      forbidden_paths: ['.git', '.proofloop'],
    },
    required_skills: ['worker'],
    slice_task_ids: ['S06-R-D-T01', 'S06-R-D-T03'],
    stop_conditions: ['binding is stale'],
    expected_result: 'SLICE_CANDIDATE_READY',
    maintenance_binding: MAINTENANCE_BINDING,
    ...overrides,
  };
}

function maintenanceJitReadSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution_mode: 'MES_MAINTENANCE',
    task_id: 'S06-R-D-T01',
    task_goal: 'maintenance entry seam machine verification',
    plan_ref: 'delivery/stages/S06/recovery-plan-r9.md',
    authority_refs: ['tech-spec/contracts.md#2.1.5'],
    code_anchors: ['packages/runtime/src/mes/maintenance-seam.ts'],
    allowed_scope: {
      code_paths: ['packages/runtime/src/mes/maintenance-seam.ts'],
      test_paths: ['packages/runtime/test/mes-maintenance-seam.test.ts'],
      forbidden_paths: ['.git', '.proofloop'],
    },
    dependency_outputs: ['mes:fact:plan_acceptance:S06:1'],
    done_criteria: ['exact tuple permits only matching binding'],
    stop_conditions: ['binding is stale'],
    required_skills: ['worker'],
    actionToken: TOKEN,
    maintenance_binding: MAINTENANCE_BINDING,
    ...overrides,
  };
}

function maintenanceResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionMode: 'MES_MAINTENANCE',
    stageId: 'S06',
    sliceId: 'S06-R-D',
    taskId: 'S06-R-D-T01',
    outcome: 'completed',
    changedFiles: ['packages/runtime/src/mes/maintenance-seam.ts'],
    verificationRuns: ['node --test packages/runtime/test-dist/mes-maintenance-seam.test.js'],
    summary: 'maintenance entry seam machine-verified the exact tuple',
    planRef: 'delivery/stages/S06/recovery-plan-r9.md',
    authorityRefs: ['tech-spec/contracts.md#2.1.5'],
    gitBasis: { head: HEAD_40, branch: 'HEAD', worktree: '.proofloop/worktrees/S06-S06-R-D' },
    actionToken: TOKEN,
    resultId: 'result-maintenance-1',
    maintenanceBinding: MAINTENANCE_BINDING_CAMEL,
    ...overrides,
  };
}

function normalResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionMode: 'NORMAL',
    stageId: 'S06',
    sliceId: 'S06-D',
    taskId: 'S06-D-T01',
    outcome: 'completed',
    resultRef: 'mes:result:S06:S06-R-D-T01:1',
    changedFiles: ['packages/runtime/src/mes/maintenance-seam.ts'],
    verificationRuns: ['node --test packages/runtime/test-dist/mes-maintenance-seam.test.js'],
    summary: 'normal result envelope',
    planRef: 'delivery/stages/S06/recovery-plan-r9.md',
    authorityRefs: ['tech-spec/contracts.md#2.1.5'],
    gitBasis: { head: HEAD_40, branch: 'HEAD', worktree: '.proofloop/worktrees/S06-S06-R-D' },
    actionToken: TOKEN,
    resultId: 'result-normal-1',
    ...overrides,
  };
}

function maintenanceCvResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution_mode: 'MES_MAINTENANCE',
    actionToken: TOKEN,
    verdict: 'PASS',
    stage_id: 'S06',
    slice_id: 'S06-R-D',
    verification_type: 'initial',
    planRef: 'delivery/stages/S06/recovery-plan-r9.md',
    authorityRefs: ['tech-spec/contracts.md#2.1.5'],
    gitBasis: { head: HEAD_40, candidateRef: 'proofloop-s06-r-d', diffRef: 'packages/runtime/slice-s06-r-d.diff' },
    summary: 'maintenance lane verified evidence-only',
    acceptance_refs_checked: ['tech-spec/acceptance.md#E2E-26'],
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
    claimed_route_code: null,
    maintenanceBinding: MAINTENANCE_BINDING_CAMEL,
    ...overrides,
  };
}

function expectPacketError(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof WorkPacketValidationError, `expected WorkPacketValidationError, got ${String(error)}`);
    assert.equal((error as WorkPacketValidationError).code, 'RESULT_INVALID');
    return true;
  });
}

function expectResultError(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof TaskResultValidationError, `expected TaskResultValidationError, got ${String(error)}`);
    assert.equal((error as TaskResultValidationError).outcome, 'RESULT_INVALID');
    return true;
  });
}

function expectAckError(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof TaskResultAckError, `expected TaskResultAckError, got ${String(error)}`);
    return true;
  });
}

describe('MES_MAINTENANCE execute modes (S06-R-D-T04)', () => {
  describe('Slice Work Packet + JIT Read Set (work-packet.ts)', () => {
    test('MES_MAINTENANCE slice packet with closed maintenance_binding is accepted', () => {
      const validated = validateSliceWorkPacket(maintenanceSlicePacket());
      assert.equal(validated.execution_mode, 'MES_MAINTENANCE');
      assert.deepEqual(validated.maintenance_binding, MAINTENANCE_BINDING);
    });

    test('MES_MAINTENANCE JIT read set with maintenance_binding is accepted', () => {
      const validated = validateJitReadSet(maintenanceJitReadSet());
      assert.equal(validated.execution_mode, 'MES_MAINTENANCE');
      assert.equal(validated.maintenance_binding?.frozen_fact_count, 130);
    });

    test('missing maintenance_binding under MES_MAINTENANCE fails closed', () => {
      const { maintenance_binding: _omitted, ...rest } = maintenanceSlicePacket();
      void _omitted;
      expectPacketError(() => validateSliceWorkPacket(rest));
      const { maintenance_binding: _omitted2, ...restJit } = maintenanceJitReadSet();
      void _omitted2;
      expectPacketError(() => validateJitReadSet(restJit));
    });

    test('maintenance_binding under NORMAL / PRE_MES_BOOTSTRAP fails closed', () => {
      expectPacketError(() =>
        validateSliceWorkPacket(maintenanceSlicePacket({ execution_mode: 'NORMAL' })),
      );
      expectPacketError(() =>
        validateSliceWorkPacket(maintenanceSlicePacket({ execution_mode: 'PRE_MES_BOOTSTRAP' })),
      );
    });

    test('malformed maintenance_binding shape fails closed', () => {
      expectPacketError(() =>
        validateSliceWorkPacket(
          maintenanceSlicePacket({
            maintenance_binding: { ...MAINTENANCE_BINDING, frozen_snapshot_sha256: 'not-hex' },
          }),
        ),
      );
      expectPacketError(() =>
        validateSliceWorkPacket(
          maintenanceSlicePacket({
            maintenance_binding: { ...MAINTENANCE_BINDING, frozen_fact_count: -1 },
          }),
        ),
      );
      expectPacketError(() =>
        validateSliceWorkPacket(
          maintenanceSlicePacket({
            maintenance_binding: { ...MAINTENANCE_BINDING, smuggled: 'nope' },
          }),
        ),
      );
    });

    test('MES_MAINTENANCE lane widening: non-S06 stage / stale-accepted Plan refs fail closed', () => {
      // The maintenance lane is EXACTLY S06: an S07 slice packet is rejected.
      expectPacketError(() => validateSliceWorkPacket(maintenanceSlicePacket({ stage_id: 'S07' })));
      expectPacketError(() => validateSliceWorkPacket(maintenanceSlicePacket({ slice_id: 'S07-R-D' })));
      // plan ref must EXACTLY equal the recovery candidate: the frozen
      // accepted Plan and any stale candidate are rejected.
      expectPacketError(() => validateSliceWorkPacket(maintenanceSlicePacket({ thin_plan_ref: 'delivery/stages/S06/plan.md' })));
      expectPacketError(() => validateSliceWorkPacket(maintenanceSlicePacket({ thin_plan_ref: 'delivery/stages/S06/recovery-plan-r2.md' })));
    });

    test('MES_MAINTENANCE JIT lane widening: foreign task / stale-accepted Plan refs fail closed', () => {
      expectPacketError(() => validateJitReadSet(maintenanceJitReadSet({ task_id: 'S07-R-D-T01' })));
      expectPacketError(() => validateJitReadSet(maintenanceJitReadSet({ plan_ref: 'delivery/stages/S06/plan.md' })));
      expectPacketError(() => validateJitReadSet(maintenanceJitReadSet({ plan_ref: 'delivery/stages/S06/recovery-plan-r2.md' })));
      // The canonical JIT Read Set field is `plan_ref` (worker-template); the
      // non-canonical `accepted_plan_ref` alias is an unknown field and must
      // fail closed — no schema smuggling between modes.
      expectPacketError(() => validateJitReadSet(maintenanceJitReadSet({ accepted_plan_ref: 'delivery/stages/S06/recovery-plan-r9.md' })));
    });
  });

  describe('Worker Task Result (task-result.ts)', () => {
    test('MES_MAINTENANCE result without resultRef + with maintenanceBinding is accepted', () => {
      const validated = validateWorkerTaskResult(maintenanceResult());
      assert.equal(validated.executionMode, 'MES_MAINTENANCE');
      assert.equal(validated.subShape, 'task');
      assert.equal(validated.resultRef, undefined);
      assert.equal(validated.maintenanceBinding?.frozenFactCount, 130);
      // Evidence-only digest is deterministic.
      assert.match(validated.resultPayloadDigest, /^[0-9a-f]{64}$/);
    });

    test('missing maintenanceBinding under MES_MAINTENANCE fails closed', () => {
      const { maintenanceBinding: _omitted, ...rest } = maintenanceResult();
      void _omitted;
      expectResultError(() => validateWorkerTaskResult(rest));
    });

    test('maintenanceBinding under NORMAL / PRE_MES_BOOTSTRAP fails closed', () => {
      expectResultError(() =>
        validateWorkerTaskResult(
          maintenanceResult({ executionMode: 'NORMAL', resultRef: 'mes:result:S06:1' }),
        ),
      );
      expectResultError(() =>
        validateWorkerTaskResult(maintenanceResult({ executionMode: 'PRE_MES_BOOTSTRAP' })),
      );
    });

    test('resultRef under MES_MAINTENANCE fails closed (Git-bound evidence only)', () => {
      expectResultError(() =>
        validateWorkerTaskResult(
          maintenanceResult({ resultRef: 'mes:result:S06:maintenance:1' }),
        ),
      );
    });

    test('NORMAL digest formula is unchanged (maintenanceBinding never enters)', () => {
      const normal = validateWorkerTaskResult(normalResult());
      assert.equal(normal.maintenanceBinding, undefined);
      const digest = computeResultPayloadDigest(normal);
      assert.match(digest, /^[0-9a-f]{64}$/);
      // Same NORMAL envelope still yields the identical digest on re-validation.
      const again = validateWorkerTaskResult(normalResult());
      assert.equal(computeResultPayloadDigest(again), digest);
    });

    test('MES_MAINTENANCE lane widening: non-S06 stage / foreign slice / stale-accepted Plan refs fail closed', () => {
      expectResultError(() => validateWorkerTaskResult(maintenanceResult({ stageId: 'S07' })));
      expectResultError(() => validateWorkerTaskResult(maintenanceResult({ sliceId: 'S07-R-D' })));
      expectResultError(() => validateWorkerTaskResult(maintenanceResult({ planRef: 'delivery/stages/S06/plan.md' })));
      expectResultError(() => validateWorkerTaskResult(maintenanceResult({ planRef: 'delivery/stages/S06/recovery-plan-r2.md' })));
    });
  });

  describe('TASK_RESULT_ACK (task-result-ack.ts)', () => {
    function maintenanceAck(
      decision: Parameters<typeof buildTaskResultAck>[0]['decision'],
      opts: { laneActionToken?: string; durableFacts?: readonly MesFactEnvelope[] } = {},
    ) {
      const submitted = validateWorkerTaskResult(maintenanceResult());
      return buildTaskResultAck({
        laneActionToken: opts.laneActionToken ?? TOKEN,
        submitted,
        decision,
        durableFacts: opts.durableFacts ?? [],
      });
    }

    test('MES_MAINTENANCE + ACCEPTED + CONTINUE yields an evidence-only ACK without acceptedResultRef', () => {
      const ack = maintenanceAck({ resultDisposition: 'ACCEPTED', continuationDisposition: 'CONTINUE' });
      assert.equal(ack.kind, TASK_RESULT_ACK_KIND);
      assert.equal(ack.executionMode, 'MES_MAINTENANCE');
      assert.equal(ack.taskId, 'S06-R-D-T01');
      assert.equal(ack.resultDisposition, 'ACCEPTED');
      assert.equal(ack.continuationDisposition, 'CONTINUE');
      assert.equal(ack.acceptedResultRef, undefined, 'maintenance ACK never carries a MES resultRef');
      assert.equal(ack.validatedGitBasis.head, HEAD_40);
      assert.equal(ack.reasonCode, undefined);
    });

    test('REJECTED + PAUSE requires reasonCode; REJECTED + CONTINUE is invalid', () => {
      const rejected = maintenanceAck({
        resultDisposition: 'REJECTED',
        continuationDisposition: 'PAUSE',
        reasonCode: 'RESULT_INVALID',
      });
      assert.equal(rejected.resultDisposition, 'REJECTED');
      assert.equal(rejected.reasonCode, 'RESULT_INVALID');
      expectAckError(() =>
        maintenanceAck({ resultDisposition: 'REJECTED', continuationDisposition: 'CONTINUE' }),
      );
    });

    test('acceptedResultRef under MES_MAINTENANCE fails closed', () => {
      expectAckError(() =>
        maintenanceAck({
          resultDisposition: 'ACCEPTED',
          continuationDisposition: 'CONTINUE',
          acceptedResultRef: 'mes:result:S06:maintenance:1',
        }),
      );
    });

    test('stale lane token is a typed RESULT_BINDING_MISMATCH', () => {
      try {
        maintenanceAck(
          { resultDisposition: 'ACCEPTED', continuationDisposition: 'CONTINUE' },
          { laneActionToken: 'other-lane-token' },
        );
        assert.fail('expected TaskResultAckError');
      } catch (error) {
        assert.ok(error instanceof TaskResultAckError);
        assert.equal((error as TaskResultAckError).code, 'RESULT_BINDING_MISMATCH');
      }
    });

    test('MES_MAINTENANCE ACK is exempt from the durable MES result replay index; NORMAL replay stays intact', () => {
      // A durable frozen NORMAL is_execute_result fact carrying the SAME
      // result_id with a DIFFERENT digest would be a durable-state conflict
      // for a NORMAL submission — but the maintenance ACK is rebuilt from
      // Git/Plan/forensic evidence and never consults the MES replay index.
      const conflictingDurable: MesFactEnvelope[] = [
        {
          schema_version: 2,
          fact_id: 'mes:fact:result:frozen:1',
          fact_kind: 'result',
          created_by: 'brain',
          authority_refs: [],
          result_ref: 'mes:result:frozen:1',
          result_id: 'result-maintenance-1',
          result_payload_digest: sha('different-payload'),
        },
      ];
      const ack = maintenanceAck(
        { resultDisposition: 'ACCEPTED', continuationDisposition: 'CONTINUE' },
        { durableFacts: conflictingDurable },
      );
      assert.equal(ack.resultDisposition, 'ACCEPTED');
      // NORMAL counterpart: the same durable conflict fails closed no-write.
      const normalSubmitted = validateWorkerTaskResult(
        normalResult({ resultId: 'result-maintenance-1' }),
      );
      expectAckError(() =>
        buildTaskResultAck({
          laneActionToken: TOKEN,
          submitted: normalSubmitted,
          decision: { resultDisposition: 'ACCEPTED', continuationDisposition: 'CONTINUE', acceptedResultRef: 'mes:result:S06:1' },
          durableFacts: conflictingDurable,
        }),
      );
    });
  });

  describe('CV result (cv-result.ts)', () => {
    test('MES_MAINTENANCE PASS without resultRef + with maintenanceBinding is accepted', () => {
      const validated = validateCvResult(maintenanceCvResult());
      assert.equal(validated.execution_mode, 'MES_MAINTENANCE');
      assert.equal(validated.resultRef, undefined);
      assert.equal(validated.maintenanceBinding?.frozenFactCount, 130);
      // Verdict gate unchanged: PASS + durable candidate ref → READY_TO_INTEGRATE.
      assert.equal(
        gateCvResult(validated, { candidateRefDurable: true }).state,
        'READY_TO_INTEGRATE',
      );
      assert.equal(
        gateCvResult(validated, { candidateRefDurable: false }).state,
        'PASS_PENDING_CANDIDATE_REF',
      );
    });

    test('missing maintenanceBinding under MES_MAINTENANCE fails closed', () => {
      const { maintenanceBinding: _omitted, ...rest } = maintenanceCvResult();
      void _omitted;
      assert.throws(() => validateCvResult(rest));
    });

    test('maintenanceBinding under NORMAL fails closed', () => {
      assert.throws(() =>
        validateCvResult(
          maintenanceCvResult({
            execution_mode: 'NORMAL',
            resultRef: 'mes:result:S06:cv:1',
          }),
        ),
      );
    });

    test('resultRef under MES_MAINTENANCE fails closed (Git-bound evidence only)', () => {
      assert.throws(() =>
        validateCvResult(maintenanceCvResult({ resultRef: 'mes:result:S06:cv:1' })),
      );
    });

    test('MES_MAINTENANCE lane widening: non-S06 stage / stale-accepted Plan refs fail closed', () => {
      assert.throws(() => validateCvResult(maintenanceCvResult({ stage_id: 'S07' })));
      assert.throws(() => validateCvResult(maintenanceCvResult({ planRef: 'delivery/stages/S06/plan.md' })));
      assert.throws(() => validateCvResult(maintenanceCvResult({ planRef: 'delivery/stages/S06/recovery-plan-r2.md' })));
    });

    test('CV claimed_route_code closed set excludes AUTHORITY_GAP (FINDINGS)', () => {
      const findings = {
        verdict: 'FINDINGS',
        failed_criterion: 'PO coverage',
        failure_signature: 'E2E-26-R1',
        required_recheck_scope: ['packages/runtime/src/mes/maintenance-seam.ts'],
        claimed_route_code: 'AUTHORITY_GAP',
        subtype: 'finding',
        reason: 'fixture finding',
        invalidation_scope: ['packages/runtime/src/mes/maintenance-seam.ts'],
        resume_target: 'producer',
      };
      // AUTHORITY_GAP is not a CV claimable route: the CV closed set is
      // exactly IMPLEMENTATION_DEFECT | PLAN_GAP | TECHNICAL_UNKNOWN |
      // RUNTIME_BLOCKER | USER_DECISION_REQUIRED | EVIDENCE_GAP.
      assert.throws(() => validateCvResult(maintenanceCvResult(findings)));
      // The canonical legal CV claim still passes.
      const legal = validateCvResult(maintenanceCvResult({ ...findings, claimed_route_code: 'IMPLEMENTATION_DEFECT' }));
      assert.equal(legal.verdict, 'FINDINGS');
      assert.equal(legal.claimed_route_code, 'IMPLEMENTATION_DEFECT');
    });
  });
});
