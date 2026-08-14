/**
 * @proofloop/runtime — deriveNextAction table-driven priority tests
 * (PO-S02-D-01 / PO-S02-D-02 pure-function side, S02-D-T01)
 *
 * The S02-D priority table (rows 0–13, from the Slice Proof Obligations) is
 * the independent oracle. Every row has at least one fixture asserting the
 * unique canonical action and a non-empty readable action_detail; priority
 * counterexamples assert that an earlier row wins over a later one
 * (pending worker envelope beats dispatching the next task; pending CV
 * envelope beats RUN_CV; stage gates beat slice dispatch; admit classes beat
 * dispatch classes). Dependency-blocked slices are skipped in the per-slice
 * scan, and the all-blocked state falls back to VALIDATE with a blocking
 * finding.
 *
 * PO-S02-D-02 (pure-function side): an error-level inconsistency fixture
 * yields VALIDATE with all findings and never an execution action.
 *
 * HP-003: double invocation on the same frozen state deep-equals (no
 * process-internal state, no cache, no randomness).
 */

import { describe, it, expect } from 'vitest';
import {
  deriveNextAction,
  type DeriveNextActionInput,
} from '@proofloop/runtime';
import { StageState, SliceState, CVStatus, ProjectState } from '@proofloop/kernel';
import type { Finding, NextAction, RoleType } from '@proofloop/kernel';
import type { ReconciledSliceState } from '@proofloop/runtime';

// ============================================================
// Closed value sets (kernel §5 — independent literals)
// ============================================================

const NEXT_ACTION_CLOSED_SET: readonly NextAction[] = [
  'DISPATCH_WORKER',
  'RUN_CV',
  'RUN_GATE',
  'ADMIT_WORKER_RESULT',
  'ADMIT_CV_RESULT',
  'ADMIT_SLICE_COMMIT',
  'ADMIT_INTEGRATION',
  'PREPARE_STAGE_REVIEW',
  'FINALIZE_STAGE_REVIEW',
  'COMPILE_ACCEPTANCE',
  'RUN_E2E',
  'INITIALIZE_EVIDENCE',
  'VALIDATE',
  'ADMIT_SPV_RESULT',
  'REPARTITION',
];

const ROLE_CLOSED_SET: readonly RoleType[] = [
  'brain',
  'planner',
  'executor',
  'worker',
  'code-verifier',
  'stage-reviewer',
  'researcher',
  'prototype',
  'committer',
  'general',
];

// ============================================================
// Fixture builders
// ============================================================

function makeSlice(overrides: Partial<ReconciledSliceState> = {}): ReconciledSliceState {
  return {
    slice_id: 'S02-A',
    dependencies: [],
    tasks: [],
    slice_state: SliceState.PLANNED,
    cv_status: CVStatus.NOT_STARTED,
    slice_evidence_finalized: false,
    repair_attempt: 0,
    scope_check_passed: false,
    committed: false,
    integrated: false,
    complete: false,
    latest_cv_receipt: null,
    latest_commit_receipt: null,
    ...overrides,
  };
}

/**
 * Base stage fixture. Defaults to a consistent EXECUTING stage (STAGE_PLAN +
 * SPV_PASS facts implied) with no slices, so tests opt into exactly the rows
 * they exercise and rows 1–3 never fire accidentally.
 */
function makeState(overrides: Partial<DeriveNextActionInput> = {}): DeriveNextActionInput {
  return {
    stage_id: 'S02',
    slices: [],
    stage_state: StageState.EXECUTING,
    project_state: ProjectState.IN_PROGRESS,
    receipt_chain: [],
    findings: [],
    ...overrides,
  };
}

function workerEnvelope(sliceId = 'S02-A', taskId?: string) {
  return {
    schemaVersion: 1 as const,
    actionToken: 'token-1',
    stageId: 'S02',
    sliceId,
    taskId,
    mode: 'implement-task' as const,
    outcome: 'completed' as const,
    evidenceRef: 'delivery/stages/S02/evidence/S02-A.md',
    changedFiles: ['packages/runtime/src/a.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 'done',
  };
}

// ============================================================
// Row 0 — any error-level inconsistency → VALIDATE (all findings)
// ============================================================

describe('row 0: error-level inconsistency → VALIDATE with all findings', () => {
  it('error finding present → VALIDATE, every finding returned, no execution action', () => {
    const findings: Finding[] = [
      { code: 'RUNTIME.RECEIPT_CHAIN_BROKEN', severity: 'error', message: 'chain broken' },
      { code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'warn', message: 'recoverable warn' },
    ];
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
      ],
      findings,
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('VALIDATE');
    expect(r.findings).toEqual(findings);
    expect(r.action_detail.length).toBeGreaterThan(0);
    expect(r.responsible_role).toBe('executor');
  });

  it('GATE_FAIL receipt present → VALIDATE with synthesized DOMAIN.INVALID_TRANSITION blocking finding', () => {
    const state = makeState({
      gate_fail_present: true,
      slices: [
        makeSlice({
          slice_state: SliceState.READY_FOR_CV,
          cv_status: CVStatus.NOT_STARTED,
          slice_evidence_finalized: true,
          tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('VALIDATE');
    expect(r.findings).toContainEqual(
      expect.objectContaining({ code: 'DOMAIN.INVALID_TRANSITION', severity: 'error' }),
    );
    expect(r.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(true);
  });

  it('GATE_FAIL + GATE_PASS both present → NOT VALIDATE (GATE_PASS post-supplants GATE_FAIL)', () => {
    const state = makeState({
      gate_fail_present: true,
      gate_pass_present: true,
      slices: [
        makeSlice({
          slice_state: SliceState.READY_FOR_CV,
          cv_status: CVStatus.NOT_STARTED,
          slice_evidence_finalized: true,
          tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    // GATE_PASS presence post-supplants GATE_FAIL — no longer a blocking gate.
    expect(r.action).not.toBe('VALIDATE');
    expect(r.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(false);
  });

  it('receipt_chain_valid=false → VALIDATE and output reflects the broken chain', () => {
    const state = makeState({ receipt_chain_valid: false });
    const r = deriveNextAction(state);
    expect(r.action).toBe('VALIDATE');
    expect(r.receipt_chain_valid).toBe(false);
  });
});

// ============================================================
// Row 1 — stage UNINITIALIZED → VALIDATE fallback (stage unplanned)
// ============================================================

describe('row 1: stage UNINITIALIZED → VALIDATE fallback', () => {
  it('no STAGE_PLAN receipt (UNINITIALIZED) → VALIDATE with blocking stage-unplanned finding', () => {
    const state = makeState({
      stage_state: StageState.UNINITIALIZED,
      slices: [
        makeSlice({
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('VALIDATE');
    expect(r.findings).toContainEqual(
      expect.objectContaining({ code: 'DOMAIN.INVALID_TRANSITION', severity: 'error' }),
    );
  });
});

// ============================================================
// Row 2 — stage PLANNING → ADMIT_SPV_RESULT (gate before slice dispatch)
// ============================================================

describe('row 2: stage PLANNING → ADMIT_SPV_RESULT', () => {
  it('PLANNING with dispatchable slices → ADMIT_SPV_RESULT wins over implement', () => {
    const state = makeState({
      stage_state: StageState.PLANNING,
      slices: [
        makeSlice({
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('ADMIT_SPV_RESULT');
    expect(r.responsible_role).toBe('planner');
    expect(r.action_detail.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Row 3 — stage COMPLETED → REPARTITION (3a) / COMPILE_ACCEPTANCE (3b)
// ============================================================

describe('row 3: stage COMPLETED → REPARTITION / COMPILE_ACCEPTANCE', () => {
  const completedSlices = [
    makeSlice({
      slice_id: 'S02-A',
      slice_state: SliceState.INTEGRATED,
      cv_status: CVStatus.PASS,
      slice_evidence_finalized: true,
      committed: true,
      integrated: true,
      complete: true,
      tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
    }),
  ];

  it('3a: COMPLETED + manifest repartition_requested=true → REPARTITION', () => {
    const state = makeState({
      stage_state: StageState.COMPLETED,
      repartition_requested: true,
      slices: completedSlices,
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('REPARTITION');
    expect(r.responsible_role).toBe('planner');
  });

  it('3b: COMPLETED without repartition request → COMPILE_ACCEPTANCE', () => {
    const state = makeState({ stage_state: StageState.COMPLETED, slices: completedSlices });
    const r = deriveNextAction(state);
    expect(r.action).toBe('COMPILE_ACCEPTANCE');
  });
});

// ============================================================
// Row 4 — pending worker result envelope → ADMIT_WORKER_RESULT
// ============================================================

describe('row 4: pending worker result envelope → ADMIT_WORKER_RESULT', () => {
  it('envelope pending while the next task is unchecked → ADMIT_WORKER_RESULT beats implement', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.IN_PROGRESS,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
      ],
      pending_worker_result_envelopes: [workerEnvelope('S02-A', 'S02-A-T01')],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('ADMIT_WORKER_RESULT');
    expect(r.slice_id).toBe('S02-A');
    expect(r.task_id).toBe('S02-A-T01');
  });

  it('envelope bound to another stage is ignored', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
      ],
      pending_worker_result_envelopes: [{ ...workerEnvelope(), stageId: 'S01' }],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.mode).toBe('implement-task');
  });
});

// ============================================================
// Row 5 — pending CV result envelope → ADMIT_CV_RESULT (not RUN_CV)
// ============================================================

describe('row 5: pending CV result envelope → ADMIT_CV_RESULT', () => {
  it('CV envelope pending for a READY_FOR_CV slice → ADMIT_CV_RESULT instead of RUN_CV', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.READY_FOR_CV,
          cv_status: CVStatus.NOT_STARTED,
          slice_evidence_finalized: true,
          tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
        }),
      ],
      pending_cv_result_envelopes: [{ stageId: 'S02', sliceId: 'S02-A' }],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('ADMIT_CV_RESULT');
    expect(r.action).not.toBe('RUN_CV');
  });
});

// ============================================================
// Row 6 — READY_FOR_CV + latest CV fact CV_REPAIR (repair/recheck)
// ============================================================

describe('row 6: CV_REPAIR branch (repair / recheck)', () => {
  const repairSlice = (overrides: Partial<ReconciledSliceState> = {}) =>
    makeSlice({
      slice_state: SliceState.READY_FOR_CV,
      slice_evidence_finalized: true,
      tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
      ...overrides,
    });

  it('6b: PENDING_RECHECK (repair result admitted after last CV_REPAIR) → RUN_CV recheck', () => {
    const state = makeState({
      slices: [repairSlice({ cv_status: CVStatus.PENDING_RECHECK, repair_attempt: 0 })],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('RUN_CV');
    expect(r.action_detail).toContain('recheck');
    expect(r.responsible_role).toBe('code-verifier');
  });

  it('6c: REPAIR + repair_attempt 0 (CV_REPAIR count 1) → DISPATCH_WORKER mode=repair', () => {
    const state = makeState({
      slices: [repairSlice({ cv_status: CVStatus.REPAIR, repair_attempt: 0 })],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.mode).toBe('repair');
    expect(r.slice_id).toBe('S02-A');
  });

  it('6d: REPAIR + repair_attempt 1 (CV_REPAIR count 2) → DISPATCH_WORKER mode=repair (second repair)', () => {
    const state = makeState({
      slices: [repairSlice({ cv_status: CVStatus.REPAIR, repair_attempt: 1 })],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.mode).toBe('repair');
  });

  it('6e: REPAIR + repair_attempt >= 2 (CV_REPAIR count >= 3) → VALIDATE fallback UNRESOLVED_CV_FAILURE', () => {
    const state = makeState({
      slices: [repairSlice({ cv_status: CVStatus.REPAIR, repair_attempt: 2 })],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('VALIDATE');
    expect(r.findings.some((f) => /UNRESOLVED_CV_FAILURE/.test(f.message))).toBe(true);
    expect(r.findings.some((f) => f.severity === 'error')).toBe(true);
  });
});

// ============================================================
// Row 7 — READY_FOR_CV with no CV receipt → RUN_CV initial
// ============================================================

describe('row 7: READY_FOR_CV with no CV receipt → RUN_CV initial', () => {
  it('initial CV dispatch with action_detail=initial', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.READY_FOR_CV,
          cv_status: CVStatus.NOT_STARTED,
          slice_evidence_finalized: true,
          tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('RUN_CV');
    expect(r.action_detail).toContain('initial');
    expect(r.responsible_role).toBe('code-verifier');
    expect(r.slice_id).toBe('S02-A');
  });

  it('priority: a READY_FOR_CV slice beats dispatching an implement for an earlier unstarted slice', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_id: 'S02-A',
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
        makeSlice({
          slice_id: 'S02-B',
          slice_state: SliceState.READY_FOR_CV,
          cv_status: CVStatus.NOT_STARTED,
          slice_evidence_finalized: true,
          tasks: [{ task_id: 'S02-B-T01', checked: true, evidence_written: true }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('RUN_CV');
    expect(r.slice_id).toBe('S02-B');
  });
});

// ============================================================
// Row 8 — slice CV_PASSED without SLICE_COMMIT → ADMIT_SLICE_COMMIT
// ============================================================

describe('row 8: slice CV_PASSED without commit → ADMIT_SLICE_COMMIT', () => {
  it('committer boundary: CV_PASSED, not committed → ADMIT_SLICE_COMMIT', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.CV_PASSED,
          cv_status: CVStatus.PASS,
          slice_evidence_finalized: true,
          committed: false,
          integrated: false,
          tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('ADMIT_SLICE_COMMIT');
    expect(r.responsible_role).toBe('committer');
    expect(r.slice_id).toBe('S02-A');
  });
});

// ============================================================
// Row 9 — slice committed without INTEGRATION_PASS → ADMIT_INTEGRATION
// ============================================================

describe('row 9: slice committed without integration → ADMIT_INTEGRATION', () => {
  it('integration boundary: INTEGRATING (committed, not integrated) → ADMIT_INTEGRATION', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.INTEGRATING,
          cv_status: CVStatus.PASS,
          slice_evidence_finalized: true,
          committed: true,
          integrated: false,
          tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('ADMIT_INTEGRATION');
    expect(r.slice_id).toBe('S02-A');
  });
});

// ============================================================
// Row 10 — per-slice execution branch (manifest order, dep-blocked skipped)
// ============================================================

describe('row 10a: unstarted slice with missing evidence file → INITIALIZE_EVIDENCE', () => {
  it('PLANNED slice + evidence file missing → INITIALIZE_EVIDENCE', () => {
    const state = makeState({
      evidence_file_present_by_slice: { 'S02-A': false },
      slices: [
        makeSlice({
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('INITIALIZE_EVIDENCE');
    expect(r.slice_id).toBe('S02-A');
  });

  it('PLANNED slice with evidence file present → implement (10a does not fire)', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.mode).toBe('implement-task');
  });
});

describe('row 10b: checked ≠ evidence_written → DISPATCH_WORKER mode=recover-task', () => {
  it('checked without evidence → recover-task for that task', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.IN_PROGRESS,
          tasks: [
            { task_id: 'S02-A-T01', checked: true, evidence_written: false },
            { task_id: 'S02-A-T02', checked: false, evidence_written: false },
          ],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.mode).toBe('recover-task');
    expect(r.task_id).toBe('S02-A-T01');
  });

  it('first inconsistency in declaration order wins (unchecked with evidence beats later implement)', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.IN_PROGRESS,
          tasks: [
            { task_id: 'S02-A-T01', checked: false, evidence_written: true },
            { task_id: 'S02-A-T02', checked: false, evidence_written: false },
          ],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.mode).toBe('recover-task');
    expect(r.task_id).toBe('S02-A-T01');
  });
});

describe('row 10c: first unchecked task → DISPATCH_WORKER mode=implement-task', () => {
  it('exactly one implement task, in manifest order', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.IN_PROGRESS,
          tasks: [
            { task_id: 'S02-A-T01', checked: true, evidence_written: true },
            { task_id: 'S02-A-T02', checked: false, evidence_written: false },
            { task_id: 'S02-A-T03', checked: false, evidence_written: false },
          ],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.mode).toBe('implement-task');
    expect(r.task_id).toBe('S02-A-T02');
  });
});

describe('row 10d: all tasks checked but slice not READY_FOR_CV → DISPATCH_WORKER mode=finalize-slice', () => {
  it('all checked + evidence finalized but no finalize-slice TASK_COMPLETE → finalize-slice', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.IN_PROGRESS,
          cv_status: CVStatus.NOT_STARTED,
          slice_evidence_finalized: true,
          tasks: [
            { task_id: 'S02-A-T01', checked: true, evidence_written: true },
            { task_id: 'S02-A-T02', checked: true, evidence_written: true },
          ],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.mode).toBe('finalize-slice');
    expect(r.slice_id).toBe('S02-A');
  });

  it('all checked + evidence not yet finalized → finalize-slice (no deadlock, no READY_FOR_CV receipt)', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.IN_PROGRESS,
          cv_status: CVStatus.NOT_STARTED,
          slice_evidence_finalized: false,
          tasks: [
            { task_id: 'S02-A-T01', checked: true, evidence_written: true },
            { task_id: 'S02-A-T02', checked: true, evidence_written: true },
          ],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.mode).toBe('finalize-slice');
  });
});

describe('row 10 dependency handling: skip dependency-blocked slices, jump to the first runnable one', () => {
  it('first slice depends on the second (not complete) → second slice dispatched', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_id: 'S02-A',
          dependencies: ['S02-B'],
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
        makeSlice({
          slice_id: 'S02-B',
          dependencies: [],
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-B-T01', checked: false, evidence_written: false }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.mode).toBe('implement-task');
    expect(r.slice_id).toBe('S02-B');
  });

  it('dependency satisfied by a complete slice → the dependent slice is runnable', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_id: 'S02-A',
          dependencies: ['S02-B'],
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
        makeSlice({
          slice_id: 'S02-B',
          dependencies: [],
          slice_state: SliceState.INTEGRATED,
          cv_status: CVStatus.PASS,
          slice_evidence_finalized: true,
          committed: true,
          integrated: true,
          complete: true,
          tasks: [{ task_id: 'S02-B-T01', checked: true, evidence_written: true }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('DISPATCH_WORKER');
    expect(r.slice_id).toBe('S02-A');
    expect(r.mode).toBe('implement-task');
  });
});

// ============================================================
// Row 11 — all slices integrated, no GATE_PASS → RUN_GATE
// ============================================================

describe('row 11: all slices integrated without GATE_PASS → RUN_GATE', () => {
  const integratedSlices = [
    makeSlice({
      slice_id: 'S02-A',
      slice_state: SliceState.INTEGRATED,
      cv_status: CVStatus.PASS,
      slice_evidence_finalized: true,
      committed: true,
      integrated: true,
      complete: true,
      tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
    }),
    makeSlice({
      slice_id: 'S02-B',
      slice_state: SliceState.INTEGRATED,
      cv_status: CVStatus.PASS,
      slice_evidence_finalized: true,
      committed: true,
      integrated: true,
      complete: true,
      tasks: [{ task_id: 'S02-B-T01', checked: true, evidence_written: true }],
    }),
  ];

  it('all integrated, no gate pass receipt → RUN_GATE', () => {
    const state = makeState({ stage_state: StageState.UNDER_REVIEW, slices: integratedSlices });
    const r = deriveNextAction(state);
    expect(r.action).toBe('RUN_GATE');
    expect(r.responsible_role).toBe('executor');
  });

  it('GATE_PASS already present → not RUN_GATE (row 12 branch instead)', () => {
    const state = makeState({
      stage_state: StageState.UNDER_REVIEW,
      gate_pass_present: true,
      slices: integratedSlices,
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('FINALIZE_STAGE_REVIEW');
  });
});

// ============================================================
// Row 12 — UNDER_REVIEW + GATE_PASS without STAGE_REVIEW_PASS
//           → FINALIZE_STAGE_REVIEW
// ============================================================

describe('row 12: UNDER_REVIEW + GATE_PASS → FINALIZE_STAGE_REVIEW', () => {
  it('review finalize after a passed gate (no PREPARE/RUN_GATE loop)', () => {
    const state = makeState({
      stage_state: StageState.UNDER_REVIEW,
      gate_pass_present: true,
      slices: [
        makeSlice({
          slice_state: SliceState.INTEGRATED,
          cv_status: CVStatus.PASS,
          slice_evidence_finalized: true,
          committed: true,
          integrated: true,
          complete: true,
          tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('FINALIZE_STAGE_REVIEW');
    expect(r.responsible_role).toBe('stage-reviewer');
    expect(r.action).not.toBe('RUN_GATE');
    expect(r.action).not.toBe('PREPARE_STAGE_REVIEW');
  });
});

// ============================================================
// Row 13 — all-blocked fallback → VALIDATE + blocking finding
// ============================================================

describe('row 13: all rows missed (all blocked) → VALIDATE fallback', () => {
  it('mutually dependency-blocked slices → VALIDATE with DOMAIN.INVALID_TRANSITION blocking finding', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_id: 'S02-A',
          dependencies: ['S02-B'],
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
        makeSlice({
          slice_id: 'S02-B',
          dependencies: ['S02-A'],
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-B-T01', checked: false, evidence_written: false }],
        }),
      ],
    });
    const r = deriveNextAction(state);
    expect(r.action).toBe('VALIDATE');
    expect(r.findings).toContainEqual(
      expect.objectContaining({ code: 'DOMAIN.INVALID_TRANSITION', severity: 'error' }),
    );
    expect(r.action_detail.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Output structure / value domain (PO-S02-D-05 foundation) + determinism
// ============================================================

describe('output structure and value domain', () => {
  const fixtures: DeriveNextActionInput[] = [
    makeState({ gate_fail_present: true }),
    makeState({ stage_state: StageState.UNINITIALIZED }),
    makeState({ stage_state: StageState.PLANNING }),
    makeState({
      stage_state: StageState.COMPLETED,
      repartition_requested: true,
      slices: [
        makeSlice({
          slice_state: SliceState.INTEGRATED,
          cv_status: CVStatus.PASS,
          slice_evidence_finalized: true,
          committed: true,
          integrated: true,
          complete: true,
          tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
        }),
      ],
    }),
    makeState({
      pending_worker_result_envelopes: [workerEnvelope()],
      slices: [makeSlice({ slice_state: SliceState.PLANNED })],
    }),
    makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.READY_FOR_CV,
          cv_status: CVStatus.REPAIR,
          repair_attempt: 0,
          slice_evidence_finalized: true,
          tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
        }),
      ],
    }),
    makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.PLANNED,
          tasks: [{ task_id: 'S02-A-T01', checked: false, evidence_written: false }],
        }),
      ],
    }),
  ];

  for (const fixture of fixtures) {
    it(`fixture → canonical action, non-empty detail, closed-set role, boolean chain, findings array`, () => {
      const r = deriveNextAction(fixture);
      expect(NEXT_ACTION_CLOSED_SET).toContain(r.action);
      expect(r.action_detail.length).toBeGreaterThan(0);
      expect(ROLE_CLOSED_SET).toContain(r.responsible_role);
      expect(typeof r.receipt_chain_valid).toBe('boolean');
      expect(Array.isArray(r.findings)).toBe(true);
    });
  }
});

describe('determinism (HP-003): same state twice → deep-equal output', () => {
  it('double invocation deep-equals on a representative fixture', () => {
    const state = makeState({
      slices: [
        makeSlice({
          slice_state: SliceState.READY_FOR_CV,
          cv_status: CVStatus.PENDING_RECHECK,
          slice_evidence_finalized: true,
          tasks: [{ task_id: 'S02-A-T01', checked: true, evidence_written: true }],
        }),
      ],
    });
    expect(deriveNextAction(state)).toEqual(deriveNextAction(state));
  });
});
