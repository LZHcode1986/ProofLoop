import fs from 'node:fs';
import path from 'node:path';
import {
  deriveNextAction,
  cvVerdictToStatus,
  cvVerdictToLifecycleState,
  derivePostRecheckStatus,
  type DeriveNextActionInput,
  type SliceDeriveState,
  type TaskCheckboxState,
  type NextActionType,
} from '../src/derive-next-action.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTask(taskId: string, overrides?: Partial<TaskCheckboxState>): TaskCheckboxState {
  return {
    task_id: taskId,
    checked: false,
    evidence_written: false,
    ...overrides,
  };
}

function makeSlice(sliceId: string, overrides?: Partial<SliceDeriveState>): SliceDeriveState {
  return {
    slice_id: sliceId,
    dependencies: [],
    tasks: [],
    slice_evidence_finalized: false,
    cv_status: 'NOT_RUN',
    repair_attempt: 0,
    scope_check_passed: false,
    committed: false,
    integrated: false,
    complete: false,
    ...overrides,
  };
}

function makeInput(overrides?: Partial<DeriveNextActionInput>): DeriveNextActionInput {
  return {
    stage_gate: { gate_run: false, gate_passed: false },
    slices: [],
    stage_committed: false,
    stage_integrated: false,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('deriveNextAction', () => {

  // ── Scenario 1: Stage Gate already passed ──
  test('STAGE_GATE_PASSED when gate already passed', () => {
    const input = makeInput({
      stage_gate: { gate_run: true, gate_passed: true },
      slices: [makeSlice('S01-A')],
    });

    const result = deriveNextAction(input);

    // Caller booleans are never authorization facts; a persisted receipt is required.
    expect(result.action_type).toBe('blocked');
    expect(result.action).toBe('blocked');
  });

  test('STAGE_GATE_PASSED requires persisted receipt matching stage and manifest', () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.derive-gate-'));
    try {
      const receiptPath = path.join(dir, 'gate.json');
      fs.writeFileSync(receiptPath, JSON.stringify({
        stage_id: 'S01', snapshot: 'a'.repeat(16), manifest_digest: 'b'.repeat(16),
        completed_slice_ids: ['S01-A'],
        slice_complete_facts: [{ slice_id: 'S01-A', cv: { verdict: 'PASS', receipt_ref: 'cv/initial-001.json' }, commit: { commit_sha: 'a'.repeat(40) }, integration: { integration_ref: 'integration-001' } }],
        platform: 'test', verdict: 'PASS',
        steps: [{ id: 'proof', exit_code: 0 }],
        service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
        timestamps: { started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
      }));
      const result = deriveNextAction(makeInput({
        stage_id: 'S01', manifest_digest: 'b'.repeat(16),
        manifest: { stage_id: 'S01', source_digest: 'source', slices: [{ slice_id: 'S01-A' }] } as any,
        stage_gate: { gate_passed: true, receipt_path: receiptPath },
        slices: [makeSlice('S01-A', { complete: true, slice_complete_facts: { slice_id: 'S01-A', cv: { verdict: 'PASS', receipt_ref: 'cv/initial-001.json' }, commit: { commit_sha: 'a'.repeat(40) }, integration: { integration_ref: 'integration-001' } } })],
      }));
      expect(result.action).toBe('stage_gate_passed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Scenario 2: All slices complete → Stage Gate ──
  test('STAGE_GATE when all slices complete', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', { complete: true }),
        makeSlice('S01-B', { complete: true }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('stage_gate');
    expect(result.reason).toContain('slices complete');
  });

  test('BRAIN_ESCALATION when all slices complete but gate did not pass', () => {
    const input = makeInput({
      stage_gate: { gate_run: true, gate_passed: false },
      slices: [makeSlice('S01-A', { complete: true })],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('stage_gate');
    expect(result.reason).toContain('persist its receipt');
  });

  // ── Scenario 3: Dependency not satisfied → skip and try later slices ──
  test('BLOCKED when all slices have unmet dependencies', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', { dependencies: ['S01-B'], cv_status: 'READY_FOR_CV' }),
        makeSlice('S01-B', { dependencies: ['S01-A'], cv_status: 'READY_FOR_CV' }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('blocked');
    expect(result.reason).toContain('unmet dependencies');
  });

  test('skips dependency-blocked slice and advances to next runnable slice', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', { dependencies: ['S01-B'], cv_status: 'READY_FOR_CV', tasks: [] }),
        makeSlice('S01-B', {
          complete: false,
          tasks: [makeTask('S01-B-T1', { checked: false, evidence_written: false })],
        }),
      ],
    });

    const result = deriveNextAction(input);

    // S01-A is blocked by dependency on S01-B, so we skip to S01-B
    expect(result.action_type).toBe('implement');
    expect(result.slice_id).toBe('S01-B');
    expect(result.task_id).toBe('S01-B-T1');
  });

  // ── Scenario 4: Task evidence written but not checked → recover (consistency) ──
  test('RECOVER when task evidence written but checkbox unchecked', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          tasks: [
            makeTask('S01-A-T1', { checked: false, evidence_written: true }),
          ],
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('recover');
    expect(result.slice_id).toBe('S01-A');
    expect(result.task_id).toBe('S01-A-T1');
    expect(result.contract_ref).toBe('worker');
  });

  // ── Scenario 4b: Task checked but no evidence written → recover (inconsistency) ──
  test('RECOVER when task checkbox checked but no evidence written', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          tasks: [
            makeTask('S01-A-T1', { checked: true, evidence_written: false }),
          ],
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('recover');
    expect(result.slice_id).toBe('S01-A');
    expect(result.task_id).toBe('S01-A-T1');
    expect(result.reason).toContain('inconsistency');
  });

  // ── Scenario 4c: Task-order reconciliation — earlier unchecked task beats later inconsistency ──
  test('IMPLEMENT when earlier task is empty (task-order check beats later inconsistency)', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          tasks: [
            makeTask('S01-A-T1', { checked: false, evidence_written: false }), // first empty task
            makeTask('S01-A-T2', { checked: true, evidence_written: false }),  // inconsistency: checked but no evidence
          ],
        }),
      ],
    });

    const result = deriveNextAction(input);

    // Task-order check runs first: T1 is empty → IMPLEMENT (beats T2 inconsistency)
    expect(result.action_type).toBe('implement');
    expect(result.task_id).toBe('S01-A-T1');
  });

  test('IMPLEMENT when earlier task is empty beats later evidence-inconsistency', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          tasks: [
            makeTask('S01-A-T1', { checked: false, evidence_written: false }), // first empty task
            makeTask('S01-A-T2', { checked: false, evidence_written: true }),  // evidence but unchecked
          ],
        }),
      ],
    });

    const result = deriveNextAction(input);

    // Task-order check runs first: T1 is empty → IMPLEMENT
    expect(result.action_type).toBe('implement');
    expect(result.task_id).toBe('S01-A-T1');
  });

  test('RECOVER first unchecked task with evidence before dispatching any later task', () => {
    const result = deriveNextAction(makeInput({
      slices: [makeSlice('S01-A', {
        tasks: [
          makeTask('S01-A-T1', { checked: true, evidence_written: true }),
          makeTask('S01-A-T2', { checked: false, evidence_written: true }),
          makeTask('S01-A-T3', { checked: false, evidence_written: false }),
        ],
      })],
    }));
    expect(result.action).toBe('recover');
    expect(result.task_id).toBe('S01-A-T2');
    expect(result.mode).toBe('recover-task');
  });

  test('RECOVER flagged when all earlier tasks are consistent and a later task has inconsistency', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          tasks: [
            makeTask('S01-A-T1', { checked: true, evidence_written: true }),    // consistent
            makeTask('S01-A-T2', { checked: true, evidence_written: false }),   // inconsistency (no earlier empty task)
            makeTask('S01-A-T3', { checked: false, evidence_written: true }),   // recover-able
          ],
        }),
      ],
    });

    const result = deriveNextAction(input);

    // No early empty tasks (T1 is done). Task reconciliation finds T2 first
    expect(result.action_type).toBe('recover');
    expect(result.task_id).toBe('S01-A-T2');
    expect(result.reason).toContain('inconsistency');
  });

  // ── Scenario 5: First empty task → implement ──
  test('IMPLEMENT for first empty task', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          tasks: [
            makeTask('S01-A-T1', { checked: true, evidence_written: true }),
            makeTask('S01-A-T2', { checked: false, evidence_written: false }),
            makeTask('S01-A-T3', { checked: false, evidence_written: false }),
          ],
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('implement');
    expect(result.slice_id).toBe('S01-A');
    expect(result.task_id).toBe('S01-A-T2'); // first unexecuted
    expect(result.contract_ref).toBe('worker');
  });

  // ── Scenario 6: All tasks checked, not finalized → finalize ──
  test('FINALIZE when all tasks checked but evidence not finalized', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          tasks: [
            makeTask('S01-A-T1', { checked: true, evidence_written: true }),
          ],
          slice_evidence_finalized: false,
          cv_status: 'NOT_RUN',
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('finalize');
    expect(result.slice_id).toBe('S01-A');
    expect(result.contract_ref).toBe('worker');
  });

  // ── Scenario 7: READY_FOR_CV, no receipt → initial_cv ──
  test('INITIAL_CV when READY_FOR_CV with no receipt', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          tasks: [makeTask('S01-A-T1', { checked: true, evidence_written: true })],
          slice_evidence_finalized: true,
          cv_status: 'READY_FOR_CV',
          latest_cv_receipt: null,
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('initial_cv');
    expect(result.slice_id).toBe('S01-A');
    expect(result.contract_ref).toBe('code-verifier');
  });

  // ── Scenario 8: PENDING_RECHECK → recheck_cv ──
  test('RECHECK_CV when PENDING_RECHECK', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          cv_status: 'PENDING_RECHECK',
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('recheck_cv');
    expect(result.slice_id).toBe('S01-A');
    expect(result.contract_ref).toBe('code-verifier');
  });

  // ── Scenario 9a: REPAIR, attempt 0 → repair ──
  test('REPAIR when CV status REPAIR and attempt 0', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          cv_status: 'REPAIR',
          repair_attempt: 0,
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('repair');
    expect(result.slice_id).toBe('S01-A');
    expect(result.contract_ref).toBe('worker');
  });

  // ── Scenario 9b: REPAIR, attempt 1 → diagnose ──
  test('DIAGNOSE when CV status REPAIR and attempt 1', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          cv_status: 'REPAIR',
          repair_attempt: 1,
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('diagnose');
    expect(result.slice_id).toBe('S01-A');
    expect(result.contract_ref).toBe('worker');
  });

  // ── Scenario 9c: REPAIR, attempt >= 2 → unresolved_cv_failure ──
  test('UNRESOLVED_CV_FAILURE when CV status REPAIR and attempt 2', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          cv_status: 'REPAIR',
          repair_attempt: 2,
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('unresolved_cv_failure');
    expect(result.slice_id).toBe('S01-A');
    expect(result.contract_ref).toBe('brain');
    expect(result.reason).toContain('2 attempts');
  });

  test('UNRESOLVED_CV_FAILURE when CV status REPAIR and attempt 3', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          cv_status: 'REPAIR',
          repair_attempt: 3,
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('unresolved_cv_failure');
    expect(result.reason).toContain('3 attempts');
  });

  test('ignores mutable repair_attempt when stage facts are present', () => {
    const result = deriveNextAction(makeInput({
      stage_id: 'S01',
      slices: [makeSlice('S01-A', { cv_status: 'REPAIR', repair_attempt: 9, latest_cv_receipt: {
        stage_id: 'S01', slice_id: 'S01-A', snapshot: 'a'.repeat(16), cv_level: 'standard',
        verification_type: 'initial', verdict: 'REPAIR',
        failed_criterion: 'requirement not met',
        failure_signature: 'sig-001',
        failed_po_ids: ['PO-1'],
        required_recheck_scope: ['full'],
      } as any })],
    }));
    expect(result.action).toBe('repair');
  });

  // ── Scenario 10: legacy routed statuses fail closed ──
  test.each(['REPLAN', 'BLOCKED', 'ESCALATION_REQUIRED'])('legacy status %s cannot emit a lifecycle route', (status) => {
    const input = makeInput({
      slices: [makeSlice('S01-A', { cv_status: status as any })],
    });
    const result = deriveNextAction(input);
    expect(result.action_type).toBe('blocked');
    expect(result.reason).toContain('unsupported');
  });

  test('canonical routed status still requires an identity-bound receipt', () => {
    const result = deriveNextAction(makeInput({
      stage_id: 'S01',
      slices: [makeSlice('S01-A', { cv_status: 'CV_REPLAN_REQUIRED' })],
    }));
    expect(result.action).toBe('brain_escalation');
    expect(result.reason).toContain('receipt');
  });

  // ── Scenario 11a: PASS, scope_check not passed → scope_check ──
  test('SCOPE_CHECK when CV PASS but scope_check not passed', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          cv_status: 'PASS',
          scope_check_passed: false,
          committed: false,
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('brain_escalation');
    expect(result.slice_id).toBe('S01-A');
    expect(result.contract_ref).toBe('brain');
  });

  // ── Scenario 11b: PASS, scope_check passed, not committed → committer ──
  test('COMMITTER when CV PASS with scope_check passed but not committed', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          cv_status: 'PASS',
          scope_check_passed: true,
          committed: false,
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('committer');
    expect(result.slice_id).toBe('S01-A');
    expect(result.contract_ref).toBe('committer');
  });

  test('folds persisted scope outcome into Committer without a standalone scope action', () => {
    const receipt = {
      stage_id: 'S01', slice_id: 'S01-A', snapshot: 'a'.repeat(16), cv_level: 'standard',
      verification_type: 'initial', verdict: 'PASS', scope_violations: [],
    };
    const result = deriveNextAction(makeInput({
      stage_id: 'S01', manifest_digest: 'b'.repeat(16),
      slices: [makeSlice('S01-A', {
        cv_status: 'PASS', scope_check_passed: false, latest_cv_receipt: receipt as any,
      })],
    }));
    expect(result.action).toBe('committer');
    expect(result.action).not.toBe('scope_check');
  });

  test('INTEGRATION when CV PASS with scope_check passed, committed but not integrated', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          cv_status: 'PASS',
          scope_check_passed: true,
          committed: true,
          integrated: false,
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('integration');
    expect(result.slice_id).toBe('S01-A');
    expect(result.contract_ref).toBe('integration');
  });

  test('SLICE_COMPLETE when CV PASS with scope_check passed, committed and integrated', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          cv_status: 'PASS',
          scope_check_passed: true,
          committed: true,
          integrated: true,
          complete: false,
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('slice_complete');
    expect(result.slice_id).toBe('S01-A');
  });

  // ── Edge cases ──
  test('BLOCKED when no tasks and CV NOT_RUN', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          tasks: [],
          cv_status: 'NOT_RUN',
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('blocked');
    expect(result.slice_id).toBe('S01-A');
  });

  test('SLICE_COMPLETE when status SLICE_COMPLETE', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          cv_status: 'SLICE_COMPLETE',
          complete: false,
        }),
      ],
    });

    const result = deriveNextAction(input);

    expect(result.action_type).toBe('slice_complete');
    expect(result.slice_id).toBe('S01-A');
  });

  // ── Multi-slice ordering ──
  test('processes incomplete slices in order, first actionable gets the action', () => {
    const input = makeInput({
      slices: [
        makeSlice('S01-A', {
          complete: true, // already complete
        }),
        makeSlice('S01-B', {
          tasks: [makeTask('S01-B-T1', { checked: false, evidence_written: true })],
        }),
        makeSlice('S01-C', {
          tasks: [makeTask('S01-C-T1', { checked: false, evidence_written: false })],
        }),
      ],
    });

    const result = deriveNextAction(input);

    // S01-A is complete, so we skip to S01-B which has an unchecked task with evidence
    expect(result.action_type).toBe('recover');
    expect(result.slice_id).toBe('S01-B');
  });

  // ── Complex: full happy path through all states ──
  test('full lifecycle derive sequence with scope_check gate', () => {
    // Simulate the sequence of actions as state progresses for a single-slice stage
    const baseSlice = () => makeSlice('S01-A', {
      tasks: [makeTask('S01-A-T1')],
    });

    // Phase 1: No tasks done → implement
    const s1 = deriveNextAction(makeInput({ slices: [baseSlice()] }));
    expect(s1.action_type).toBe('implement');
    expect(s1.task_id).toBe('S01-A-T1');

    // Phase 2: Task evidence+checked consistent → finalize
    const s2 = deriveNextAction(makeInput({
      slices: [makeSlice('S01-A', {
        tasks: [makeTask('S01-A-T1', { evidence_written: true, checked: true })],
        slice_evidence_finalized: false,
      })],
    }));
    expect(s2.action_type).toBe('finalize');

    // Phase 3: Finalized, READY_FOR_CV → initial_cv
    const s3 = deriveNextAction(makeInput({
      slices: [makeSlice('S01-A', {
        tasks: [makeTask('S01-A-T1', { evidence_written: true, checked: true })],
        slice_evidence_finalized: true,
        cv_status: 'READY_FOR_CV',
        latest_cv_receipt: null,
      })],
    }));
    expect(s3.action_type).toBe('initial_cv');

    // Phase 4: CV PASS, scope_check not passed → scope_check
    const s4 = deriveNextAction(makeInput({
      slices: [makeSlice('S01-A', {
        tasks: [makeTask('S01-A-T1', { evidence_written: true, checked: true })],
        slice_evidence_finalized: true,
        cv_status: 'PASS',
        scope_check_passed: false,
        committed: false,
      })],
    }));
    expect(s4.action_type).toBe('brain_escalation');

    // Phase 5: scope_check passed, not committed → committer
    const s5 = deriveNextAction(makeInput({
      slices: [makeSlice('S01-A', {
        tasks: [makeTask('S01-A-T1', { evidence_written: true, checked: true })],
        slice_evidence_finalized: true,
        cv_status: 'PASS',
        scope_check_passed: true,
        committed: false,
      })],
    }));
    expect(s5.action_type).toBe('committer');

    // Phase 6: Committed → integration
    const s6 = deriveNextAction(makeInput({
      slices: [makeSlice('S01-A', {
        tasks: [makeTask('S01-A-T1', { evidence_written: true, checked: true })],
        slice_evidence_finalized: true,
        cv_status: 'PASS',
        scope_check_passed: true,
        committed: true,
        integrated: false,
      })],
    }));
    expect(s6.action_type).toBe('integration');

    // Phase 7: Integrated → slice_complete
    const s7 = deriveNextAction(makeInput({
      slices: [makeSlice('S01-A', {
        tasks: [makeTask('S01-A-T1', { evidence_written: true, checked: true })],
        slice_evidence_finalized: true,
        cv_status: 'PASS',
        scope_check_passed: true,
        committed: true,
        integrated: true,
        complete: false,
      })],
    }));
    expect(s7.action_type).toBe('slice_complete');

    // Phase 8: All complete → stage_gate
    const s8 = deriveNextAction(makeInput({
      slices: [makeSlice('S01-A', { complete: true })],
    }));
    expect(s8.action_type).toBe('stage_gate');
  });
});

// ── Helper function tests ──

describe('canonical CV lifecycle states', () => {
  test('verdicts map to distinct CV lifecycle states', () => {
    expect(cvVerdictToLifecycleState('PASS')).toBe('CV_PASS');
    expect(cvVerdictToLifecycleState('REPAIR')).toBe('CV_REPAIR_REQUIRED');
    expect(cvVerdictToLifecycleState('REPLAN')).toBe('CV_REPLAN_REQUIRED');
    expect(cvVerdictToLifecycleState('BLOCKED')).toBe('CV_BLOCKED');
    expect(cvVerdictToLifecycleState('ESCALATION_REQUIRED')).toBe('CV_ESCALATION_REQUIRED');
  });

  test('canonical CV_PASS without a matching immutable receipt escalates', () => {
    const result = deriveNextAction(makeInput({
      stage_id: 'S01',
      slices: [makeSlice('S01-A', { cv_status: 'CV_PASS' })],
    }));
    expect(result.action).toBe('brain_escalation');
    expect(result.reason).toMatch(/latest immutable CV receipt/i);
  });

  test('canonical CV_PASS receipt enables Committer regardless of mutable scope boolean', () => {
    const result = deriveNextAction(makeInput({
      stage_id: 'S01',
      slices: [makeSlice('S01-A', {
        cv_status: 'CV_PASS', scope_check_passed: false,
        latest_cv_receipt: { stage_id: 'S01', slice_id: 'S01-A', snapshot: 'a'.repeat(16), cv_level: 'standard', verdict: 'PASS', scope_violations: [] } as any,
      })],
    }));
    expect(result.action).toBe('committer');
  });
});

describe('cvVerdictToStatus', () => {
  test('emits canonical lifecycle states for every verdict', () => {
    expect(cvVerdictToStatus('PASS')).toBe('CV_PASS');
    expect(cvVerdictToStatus('REPAIR')).toBe('CV_REPAIR_REQUIRED');
    expect(cvVerdictToStatus('REPLAN')).toBe('CV_REPLAN_REQUIRED');
    expect(cvVerdictToStatus('BLOCKED')).toBe('CV_BLOCKED');
    expect(cvVerdictToStatus('ESCALATION_REQUIRED')).toBe('CV_ESCALATION_REQUIRED');
  });
});

describe('derivePostRecheckStatus', () => {
  test('REPAIR → PENDING_RECHECK', () => {
    expect(derivePostRecheckStatus('REPAIR')).toBe('PENDING_RECHECK');
  });
  test('other status returns same', () => {
    expect(derivePostRecheckStatus('PASS')).toBe('PASS');
    expect(derivePostRecheckStatus('NOT_RUN')).toBe('NOT_RUN');
  });
});
