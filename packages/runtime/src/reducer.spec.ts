/**
 * Pure-function reducer — PO-S02-A-02 / PO-S02-A-03
 *
 * Verifies the public reducer seam of @proofloop/runtime:
 *   - PO-S02-A-02: for every legal RuntimeAction (entity-bound, 1:1 with the
 *     kernel §6 event tables), the reducer advances the corresponding
 *     Stage/Slice/CV/Project state to the canonical target and keeps the
 *     aggregate derived state consistent (composite actions such as PASS_CV =
 *     transitionSlice(PASS_CV) + transitionCv(PASS), FINISH_TASKS =
 *     transitionSlice(FINISH_TASKS) + transitionCv(MARK_READY), the repair
 *     loop REVISE ↔ REQUEST_REPAIR, and the recheck branch RECHECK/RUN_CV).
 *   - PO-S02-A-03: any action the current state does not allow is rejected
 *     with the kernel InvalidTransitionError carrying entityId/fromState/
 *     toState; unknown actions (entity/event outside the closed set) are
 *     rejected at the schema layer; never silently ignored or normalized.
 *
 * Expected values in the legal tables are the kernel §6 transition tables
 * (independent oracle — `packages/kernel/src/transitions.ts`), written as
 * known-good literals, not derived from the implementation.
 */

import { describe, it, expect } from 'vitest';
import {
  reduceRuntimeAction,
  assertRuntimeAction,
  type RuntimeAction,
  type ReconciledStageState,
  type ReconciledSliceState,
} from '@proofloop/runtime';
import {
  StageState,
  SliceState,
  CVStatus,
  ProjectState,
  InvalidTransitionError,
  SchemaValidationError,
} from '@proofloop/kernel';
import type {
  StageEvent,
  SliceEvent,
  CvEvent,
  ProjectEvent,
} from '@proofloop/kernel';

// ============================================================
// Fixtures
// ============================================================

function makeSlice(overrides: Partial<ReconciledSliceState> = {}): ReconciledSliceState {
  return {
    slice_id: 'S02-A',
    dependencies: [],
    tasks: [],
    slice_state: SliceState.CV_IN_PROGRESS,
    cv_status: CVStatus.IN_PROGRESS,
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

function makeStage(overrides: Partial<ReconciledStageState> = {}): ReconciledStageState {
  return {
    stage_id: 'S02',
    slices: [makeSlice()],
    stage_state: StageState.EXECUTING,
    project_state: ProjectState.IN_PROGRESS,
    receipt_chain: [],
    findings: [],
    ...overrides,
  };
}

// ============================================================
// Canonical kernel §6 legal transition tables (independent oracle)
// ============================================================

/** Stage legal rows: [from, event, to] — 8 rows incl. self-loop + repartition. */
const STAGE_LEGAL: Array<[StageState, StageEvent, StageState]> = [
  [StageState.UNINITIALIZED, 'PLAN', StageState.PLANNING],
  [StageState.PLANNING, 'FINALIZE_PLAN', StageState.READY],
  [StageState.READY, 'START', StageState.EXECUTING],
  [StageState.EXECUTING, 'PROGRESS', StageState.EXECUTING],
  [StageState.EXECUTING, 'SUBMIT_FOR_REVIEW', StageState.UNDER_REVIEW],
  [StageState.UNDER_REVIEW, 'REOPEN', StageState.EXECUTING],
  [StageState.UNDER_REVIEW, 'COMPLETE', StageState.COMPLETED],
  [StageState.COMPLETED, 'REPARTITION', StageState.EXECUTING],
];

/**
 * Slice legal rows: [fromSlice, fromCv, event, toSlice, toCv] — 7 rows.
 * The toCv column records the aggregate-consistent CVStatus after the action
 * (composite semantics per kernel §6; e.g. PASS_CV also advances cv PASS).
 */
const SLICE_LEGAL: Array<[SliceState, CVStatus, SliceEvent, SliceState, CVStatus]> = [
  [SliceState.PLANNED, CVStatus.NOT_STARTED, 'START', SliceState.IN_PROGRESS, CVStatus.NOT_STARTED],
  [SliceState.IN_PROGRESS, CVStatus.NOT_STARTED, 'FINISH_TASKS', SliceState.READY_FOR_CV, CVStatus.READY_FOR_CV],
  [SliceState.READY_FOR_CV, CVStatus.READY_FOR_CV, 'RUN_CV', SliceState.CV_IN_PROGRESS, CVStatus.IN_PROGRESS],
  [SliceState.CV_IN_PROGRESS, CVStatus.IN_PROGRESS, 'REVISE', SliceState.READY_FOR_CV, CVStatus.REPAIR],
  [SliceState.CV_IN_PROGRESS, CVStatus.IN_PROGRESS, 'PASS_CV', SliceState.CV_PASSED, CVStatus.PASS],
  [SliceState.CV_PASSED, CVStatus.PASS, 'INTEGRATE', SliceState.INTEGRATING, CVStatus.PASS],
  [SliceState.INTEGRATING, CVStatus.PASS, 'FINISH_INTEGRATION', SliceState.INTEGRATED, CVStatus.PASS],
];

/** CV legal rows: [fromSlice, fromCv, event, toSlice, toCv] — 6 rows. */
const CV_LEGAL: Array<[SliceState, CVStatus, CvEvent, SliceState, CVStatus]> = [
  [SliceState.IN_PROGRESS, CVStatus.NOT_STARTED, 'MARK_READY', SliceState.READY_FOR_CV, CVStatus.READY_FOR_CV],
  [SliceState.READY_FOR_CV, CVStatus.READY_FOR_CV, 'START_CV', SliceState.CV_IN_PROGRESS, CVStatus.IN_PROGRESS],
  [SliceState.CV_IN_PROGRESS, CVStatus.IN_PROGRESS, 'PASS', SliceState.CV_PASSED, CVStatus.PASS],
  [SliceState.CV_IN_PROGRESS, CVStatus.IN_PROGRESS, 'REQUEST_REPAIR', SliceState.READY_FOR_CV, CVStatus.REPAIR],
  [SliceState.READY_FOR_CV, CVStatus.REPAIR, 'FIX', SliceState.READY_FOR_CV, CVStatus.PENDING_RECHECK],
  [SliceState.READY_FOR_CV, CVStatus.PENDING_RECHECK, 'RECHECK', SliceState.CV_IN_PROGRESS, CVStatus.IN_PROGRESS],
];

/** Project legal rows: [from, event, to] — 4 rows. */
const PROJECT_LEGAL: Array<[ProjectState, ProjectEvent, ProjectState]> = [
  [ProjectState.IN_PROGRESS, 'SUBMIT_FOR_REVIEW', ProjectState.UNDER_REVIEW],
  [ProjectState.UNDER_REVIEW, 'REOPEN', ProjectState.IN_PROGRESS],
  [ProjectState.UNDER_REVIEW, 'COMPLETE', ProjectState.COMPLETED],
  [ProjectState.DEFERRED, 'RESUME', ProjectState.IN_PROGRESS],
];

// ============================================================
// PO-S02-A-02 — legal transition rows (table-driven)
// ============================================================

describe('reducer — stage legal rows (PO-S02-A-02)', () => {
  it('covers exactly the 8 canonical stage rows', () => {
    expect(STAGE_LEGAL).toHaveLength(8);
  });

  for (const [from, event, to] of STAGE_LEGAL) {
    it(`stage ${from} --${event}--> ${to}`, () => {
      const state = makeStage({ stage_state: from });
      const next = reduceRuntimeAction(state, { entity: 'stage', event });
      expect(next).not.toBe(state);
      expect(next.stage_state).toBe(to);
      // No other dimension changes; untouched arrays keep reference identity.
      expect(next.slices).toBe(state.slices);
      expect(next.project_state).toBe(state.project_state);
      expect(next.receipt_chain).toBe(state.receipt_chain);
      expect(next.findings).toBe(state.findings);
    });
  }
});

describe('reducer — slice legal rows (PO-S02-A-02)', () => {
  it('covers exactly the 7 canonical slice rows', () => {
    expect(SLICE_LEGAL).toHaveLength(7);
  });

  for (const [fromSlice, fromCv, event, toSlice, toCv] of SLICE_LEGAL) {
    it(`slice ${fromSlice} --${event}--> ${toSlice} (cv ${toCv})`, () => {
      const state = makeStage({
        slices: [makeSlice({ slice_state: fromSlice, cv_status: fromCv })],
      });
      const next = reduceRuntimeAction(state, { entity: 'slice', event });
      expect(next).not.toBe(state);
      const slice = next.slices[0];
      expect(slice.slice_state).toBe(toSlice);
      expect(slice.cv_status).toBe(toCv);
      expect(slice.slice_id).toBe('S02-A');
      // Aggregate consistency: slice_state and cv_status reach the expected
      // pair (kernel §6 tables are the oracle).
      expect(next.stage_state).toBe(state.stage_state);
    });
  }
});

describe('reducer — CV legal rows (PO-S02-A-02)', () => {
  it('covers exactly the 6 canonical CV rows', () => {
    expect(CV_LEGAL).toHaveLength(6);
  });

  for (const [fromSlice, fromCv, event, toSlice, toCv] of CV_LEGAL) {
    it(`cv ${fromCv} --${event}--> ${toCv} (slice ${toSlice})`, () => {
      const state = makeStage({
        slices: [makeSlice({ slice_state: fromSlice, cv_status: fromCv })],
      });
      const next = reduceRuntimeAction(state, { entity: 'cv', event });
      expect(next).not.toBe(state);
      const slice = next.slices[0];
      expect(slice.cv_status).toBe(toCv);
      expect(slice.slice_state).toBe(toSlice);
      expect(next.stage_state).toBe(state.stage_state);
    });
  }
});

describe('reducer — project legal rows (PO-S02-A-02)', () => {
  it('covers exactly the 4 canonical project rows', () => {
    expect(PROJECT_LEGAL).toHaveLength(4);
  });

  for (const [from, event, to] of PROJECT_LEGAL) {
    it(`project ${from} --${event}--> ${to}`, () => {
      const state = makeStage({ project_state: from });
      const next = reduceRuntimeAction(state, { entity: 'project', event });
      expect(next).not.toBe(state);
      expect(next.project_state).toBe(to);
      expect(next.slices).toBe(state.slices);
      expect(next.stage_state).toBe(state.stage_state);
    });
  }
});

// ============================================================
// PO-S02-A-02 — composite action aggregate consistency
// ============================================================

describe('reducer — composite aggregate consistency (PO-S02-A-02)', () => {
  it('FINISH_TASKS advances slice IN_PROGRESS→READY_FOR_CV and cv NOT_STARTED→READY_FOR_CV', () => {
    const state = makeStage({
      slices: [makeSlice({ slice_state: SliceState.IN_PROGRESS, cv_status: CVStatus.NOT_STARTED })],
    });
    const next = reduceRuntimeAction(state, { entity: 'slice', event: 'FINISH_TASKS' });
    expect(next.slices[0].slice_state).toBe(SliceState.READY_FOR_CV);
    expect(next.slices[0].cv_status).toBe(CVStatus.READY_FOR_CV);
  });

  it('RUN_CV advances slice READY_FOR_CV→CV_IN_PROGRESS and cv READY_FOR_CV→IN_PROGRESS (START_CV)', () => {
    const state = makeStage({
      slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.READY_FOR_CV })],
    });
    const next = reduceRuntimeAction(state, { entity: 'slice', event: 'RUN_CV' });
    expect(next.slices[0].slice_state).toBe(SliceState.CV_IN_PROGRESS);
    expect(next.slices[0].cv_status).toBe(CVStatus.IN_PROGRESS);
  });

  it('RUN_CV with cv NOT_STARTED heals the cv side via MARK_READY then START_CV (PO-S02-E-03 dispatch branch)', () => {
    const state = makeStage({
      slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.NOT_STARTED })],
    });
    const next = reduceRuntimeAction(state, { entity: 'slice', event: 'RUN_CV' });
    expect(next.slices[0].slice_state).toBe(SliceState.CV_IN_PROGRESS);
    expect(next.slices[0].cv_status).toBe(CVStatus.IN_PROGRESS);
  });

  it('RUN_CV with cv PENDING_RECHECK advances cv via RECHECK (recheck branch)', () => {
    const state = makeStage({
      slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.PENDING_RECHECK })],
    });
    const next = reduceRuntimeAction(state, { entity: 'slice', event: 'RUN_CV' });
    expect(next.slices[0].slice_state).toBe(SliceState.CV_IN_PROGRESS);
    expect(next.slices[0].cv_status).toBe(CVStatus.IN_PROGRESS);
  });

  it('PASS_CV advances slice CV_IN_PROGRESS→CV_PASSED and cv IN_PROGRESS→PASS', () => {
    const state = makeStage({
      slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })],
    });
    const next = reduceRuntimeAction(state, { entity: 'slice', event: 'PASS_CV' });
    expect(next.slices[0].slice_state).toBe(SliceState.CV_PASSED);
    expect(next.slices[0].cv_status).toBe(CVStatus.PASS);
  });

  it('REVISE advances slice CV_IN_PROGRESS→READY_FOR_CV and cv IN_PROGRESS→REPAIR (repair loop)', () => {
    const state = makeStage({
      slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })],
    });
    const next = reduceRuntimeAction(state, { entity: 'slice', event: 'REVISE' });
    expect(next.slices[0].slice_state).toBe(SliceState.READY_FOR_CV);
    expect(next.slices[0].cv_status).toBe(CVStatus.REPAIR);
  });

  it('cv REQUEST_REPAIR produces the same aggregate as slice REVISE (symmetric pairing)', () => {
    const state = makeStage({
      slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })],
    });
    const viaSlice = reduceRuntimeAction(state, { entity: 'slice', event: 'REVISE' });
    const viaCv = reduceRuntimeAction(state, { entity: 'cv', event: 'REQUEST_REPAIR' });
    expect(viaSlice.slices[0].slice_state).toBe(SliceState.READY_FOR_CV);
    expect(viaSlice.slices[0].cv_status).toBe(CVStatus.REPAIR);
    expect(viaCv.slices[0]).toEqual(viaSlice.slices[0]);
  });

  it('full repair loop closes: FINISH_TASKS→RUN_CV→REVISE→FIX→RECHECK→PASS_CV ends at CV_PASSED/PASS', () => {
    let s = makeStage({
      slices: [makeSlice({ slice_state: SliceState.IN_PROGRESS, cv_status: CVStatus.NOT_STARTED })],
    });
    const steps: Array<RuntimeAction> = [
      { entity: 'slice', event: 'FINISH_TASKS' },
      { entity: 'slice', event: 'RUN_CV' },
      { entity: 'slice', event: 'REVISE' },
      { entity: 'cv', event: 'FIX' },
      { entity: 'cv', event: 'RECHECK' },
      { entity: 'slice', event: 'PASS_CV' },
    ];
    for (const step of steps) s = reduceRuntimeAction(s, step);
    expect(s.slices[0].slice_state).toBe(SliceState.CV_PASSED);
    expect(s.slices[0].cv_status).toBe(CVStatus.PASS);
  });

  it('happy path closes: FINISH_TASKS→RUN_CV→PASS_CV→INTEGRATE→FINISH_INTEGRATION ends at INTEGRATED/PASS', () => {
    let s = makeStage({
      slices: [makeSlice({ slice_state: SliceState.IN_PROGRESS, cv_status: CVStatus.NOT_STARTED })],
    });
    const steps: Array<RuntimeAction> = [
      { entity: 'slice', event: 'FINISH_TASKS' },
      { entity: 'slice', event: 'RUN_CV' },
      { entity: 'slice', event: 'PASS_CV' },
      { entity: 'slice', event: 'INTEGRATE' },
      { entity: 'slice', event: 'FINISH_INTEGRATION' },
    ];
    for (const step of steps) s = reduceRuntimeAction(s, step);
    expect(s.slices[0].slice_state).toBe(SliceState.INTEGRATED);
    expect(s.slices[0].cv_status).toBe(CVStatus.PASS);
  });

  it('FIX keeps the slice READY_FOR_CV while cv REPAIR→PENDING_RECHECK (consistent aggregate)', () => {
    const state = makeStage({
      slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.REPAIR })],
    });
    const next = reduceRuntimeAction(state, { entity: 'cv', event: 'FIX' });
    expect(next.slices[0].slice_state).toBe(SliceState.READY_FOR_CV);
    expect(next.slices[0].cv_status).toBe(CVStatus.PENDING_RECHECK);
  });
});

// ============================================================
// PO-S02-A-03 — illegal combinations rejected with structured errors
// ============================================================

interface IllegalCase {
  name: string;
  state: ReconciledStageState;
  action: RuntimeAction;
  entityId: string;
  fromState: string;
  toState: string;
}

const ILLEGAL_CASES: IllegalCase[] = [
  // --- stage ---
  { name: 'stage PLAN at PLANNING', state: makeStage({ stage_state: StageState.PLANNING }), action: { entity: 'stage', event: 'PLAN' }, entityId: 'S02', fromState: 'PLANNING', toState: 'PLAN' },
  { name: 'stage FINALIZE_PLAN at READY', state: makeStage({ stage_state: StageState.READY }), action: { entity: 'stage', event: 'FINALIZE_PLAN' }, entityId: 'S02', fromState: 'READY', toState: 'FINALIZE_PLAN' },
  { name: 'stage START at PLANNING', state: makeStage({ stage_state: StageState.PLANNING }), action: { entity: 'stage', event: 'START' }, entityId: 'S02', fromState: 'PLANNING', toState: 'START' },
  { name: 'stage PROGRESS at READY', state: makeStage({ stage_state: StageState.READY }), action: { entity: 'stage', event: 'PROGRESS' }, entityId: 'S02', fromState: 'READY', toState: 'PROGRESS' },
  { name: 'stage SUBMIT_FOR_REVIEW at READY', state: makeStage({ stage_state: StageState.READY }), action: { entity: 'stage', event: 'SUBMIT_FOR_REVIEW' }, entityId: 'S02', fromState: 'READY', toState: 'SUBMIT_FOR_REVIEW' },
  { name: 'stage REOPEN at EXECUTING', state: makeStage({ stage_state: StageState.EXECUTING }), action: { entity: 'stage', event: 'REOPEN' }, entityId: 'S02', fromState: 'EXECUTING', toState: 'REOPEN' },
  { name: 'stage COMPLETE at EXECUTING', state: makeStage({ stage_state: StageState.EXECUTING }), action: { entity: 'stage', event: 'COMPLETE' }, entityId: 'S02', fromState: 'EXECUTING', toState: 'COMPLETE' },
  { name: 'stage REPARTITION at EXECUTING (non-COMPLETED)', state: makeStage({ stage_state: StageState.EXECUTING }), action: { entity: 'stage', event: 'REPARTITION' }, entityId: 'S02', fromState: 'EXECUTING', toState: 'REPARTITION' },
  { name: 'stage REPARTITION at UNINITIALIZED', state: makeStage({ stage_state: StageState.UNINITIALIZED }), action: { entity: 'stage', event: 'REPARTITION' }, entityId: 'S02', fromState: 'UNINITIALIZED', toState: 'REPARTITION' },
  // --- slice ---
  { name: 'slice START at IN_PROGRESS', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.IN_PROGRESS, cv_status: CVStatus.NOT_STARTED })] }), action: { entity: 'slice', event: 'START' }, entityId: 'S02-A', fromState: 'IN_PROGRESS', toState: 'START' },
  { name: 'slice FINISH_TASKS at PLANNED', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.PLANNED, cv_status: CVStatus.NOT_STARTED })] }), action: { entity: 'slice', event: 'FINISH_TASKS' }, entityId: 'S02-A', fromState: 'PLANNED', toState: 'FINISH_TASKS' },
  { name: 'slice RUN_CV at IN_PROGRESS', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.IN_PROGRESS, cv_status: CVStatus.NOT_STARTED })] }), action: { entity: 'slice', event: 'RUN_CV' }, entityId: 'S02-A', fromState: 'IN_PROGRESS', toState: 'RUN_CV' },
  { name: 'slice REVISE at READY_FOR_CV', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.READY_FOR_CV })] }), action: { entity: 'slice', event: 'REVISE' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'REVISE' },
  { name: 'slice PASS_CV at READY_FOR_CV', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.READY_FOR_CV })] }), action: { entity: 'slice', event: 'PASS_CV' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'PASS_CV' },
  { name: 'slice INTEGRATE at CV_IN_PROGRESS (before CV_PASSED)', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })] }), action: { entity: 'slice', event: 'INTEGRATE' }, entityId: 'S02-A', fromState: 'CV_IN_PROGRESS', toState: 'INTEGRATE' },
  { name: 'slice FINISH_INTEGRATION at CV_PASSED', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.CV_PASSED, cv_status: CVStatus.PASS })] }), action: { entity: 'slice', event: 'FINISH_INTEGRATION' }, entityId: 'S02-A', fromState: 'CV_PASSED', toState: 'FINISH_INTEGRATION' },
  { name: 'slice PASS_CV at CV_PASSED', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.CV_PASSED, cv_status: CVStatus.PASS })] }), action: { entity: 'slice', event: 'PASS_CV' }, entityId: 'S02-A', fromState: 'CV_PASSED', toState: 'PASS_CV' },
  { name: 'slice START at INTEGRATED (terminal)', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.INTEGRATED, cv_status: CVStatus.PASS })] }), action: { entity: 'slice', event: 'START' }, entityId: 'S02-A', fromState: 'INTEGRATED', toState: 'START' },
  { name: 'slice RUN_CV at CV_IN_PROGRESS', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })] }), action: { entity: 'slice', event: 'RUN_CV' }, entityId: 'S02-A', fromState: 'CV_IN_PROGRESS', toState: 'RUN_CV' },
  // --- cv ---
  { name: 'cv MARK_READY at READY_FOR_CV', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.READY_FOR_CV })] }), action: { entity: 'cv', event: 'MARK_READY' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'MARK_READY' },
  { name: 'cv START_CV at NOT_STARTED', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.PLANNED, cv_status: CVStatus.NOT_STARTED })] }), action: { entity: 'cv', event: 'START_CV' }, entityId: 'S02-A', fromState: 'NOT_STARTED', toState: 'START_CV' },
  { name: 'cv PASS at READY_FOR_CV', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.READY_FOR_CV })] }), action: { entity: 'cv', event: 'PASS' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'PASS' },
  { name: 'cv REQUEST_REPAIR at READY_FOR_CV', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.READY_FOR_CV })] }), action: { entity: 'cv', event: 'REQUEST_REPAIR' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'REQUEST_REPAIR' },
  { name: 'cv FIX at IN_PROGRESS', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })] }), action: { entity: 'cv', event: 'FIX' }, entityId: 'S02-A', fromState: 'IN_PROGRESS', toState: 'FIX' },
  { name: 'cv RECHECK at REPAIR', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.REPAIR })] }), action: { entity: 'cv', event: 'RECHECK' }, entityId: 'S02-A', fromState: 'REPAIR', toState: 'RECHECK' },
  { name: 'cv PASS at REPAIR', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.REPAIR })] }), action: { entity: 'cv', event: 'PASS' }, entityId: 'S02-A', fromState: 'REPAIR', toState: 'PASS' },
  // --- project ---
  { name: 'project SUBMIT_FOR_REVIEW at COMPLETED (terminal)', state: makeStage({ project_state: ProjectState.COMPLETED }), action: { entity: 'project', event: 'SUBMIT_FOR_REVIEW' }, entityId: 'S02', fromState: 'COMPLETED', toState: 'SUBMIT_FOR_REVIEW' },
  { name: 'project REOPEN at IN_PROGRESS', state: makeStage({ project_state: ProjectState.IN_PROGRESS }), action: { entity: 'project', event: 'REOPEN' }, entityId: 'S02', fromState: 'IN_PROGRESS', toState: 'REOPEN' },
  { name: 'project COMPLETE at IN_PROGRESS', state: makeStage({ project_state: ProjectState.IN_PROGRESS }), action: { entity: 'project', event: 'COMPLETE' }, entityId: 'S02', fromState: 'IN_PROGRESS', toState: 'COMPLETE' },
  { name: 'project RESUME at IN_PROGRESS', state: makeStage({ project_state: ProjectState.IN_PROGRESS }), action: { entity: 'project', event: 'RESUME' }, entityId: 'S02', fromState: 'IN_PROGRESS', toState: 'RESUME' },
  { name: 'project COMPLETE at DEFERRED', state: makeStage({ project_state: ProjectState.DEFERRED }), action: { entity: 'project', event: 'COMPLETE' }, entityId: 'S02', fromState: 'DEFERRED', toState: 'COMPLETE' },
  // --- composite failure on the cv side of a slice action (aggregate guard) ---
  { name: 'slice PASS_CV with cv NOT_STARTED (cv-side guard)', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.NOT_STARTED })] }), action: { entity: 'slice', event: 'PASS_CV' }, entityId: 'S02-A', fromState: 'NOT_STARTED', toState: 'PASS' },
  { name: 'slice RUN_CV with cv IN_PROGRESS (cv-side guard)', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.IN_PROGRESS })] }), action: { entity: 'slice', event: 'RUN_CV' }, entityId: 'S02-A', fromState: 'IN_PROGRESS', toState: 'START_CV' },
  { name: 'slice FINISH_TASKS with cv READY_FOR_CV (cv-side guard)', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.IN_PROGRESS, cv_status: CVStatus.READY_FOR_CV })] }), action: { entity: 'slice', event: 'FINISH_TASKS' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'MARK_READY' },
  // --- no active slice ---
  { name: 'slice START with all slices INTEGRATED', state: makeStage({ slices: [makeSlice({ slice_state: SliceState.INTEGRATED, cv_status: CVStatus.PASS })] }), action: { entity: 'slice', event: 'START' }, entityId: 'S02-A', fromState: 'INTEGRATED', toState: 'START' },
];

describe('reducer — illegal combinations rejected (PO-S02-A-03)', () => {
  it('covers the required illegal examples from the PO', () => {
    const names = ILLEGAL_CASES.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'slice INTEGRATE at CV_IN_PROGRESS (before CV_PASSED)',
      'slice PASS_CV at READY_FOR_CV',
      'stage COMPLETE at EXECUTING',
      'stage REPARTITION at EXECUTING (non-COMPLETED)',
    ]));
  });

  for (const c of ILLEGAL_CASES) {
    it(c.name, () => {
      expect(() => reduceRuntimeAction(c.state, c.action)).toThrow(InvalidTransitionError);
      let thrown: unknown;
      try {
        reduceRuntimeAction(c.state, c.action);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(InvalidTransitionError);
      const err = thrown as InvalidTransitionError;
      expect(err.name).toBe('InvalidTransitionError');
      expect(err.entityId).toBe(c.entityId);
      expect(err.fromState).toBe(c.fromState);
      expect(err.toState).toBe(c.toState);
      expect(err.message.length).toBeGreaterThan(0);
    });
  }

  it('never silently ignores or normalizes an illegal action (input state untouched)', () => {
    const state = makeStage({ stage_state: StageState.EXECUTING });
    const snapshot = JSON.stringify(state);
    expect(() => reduceRuntimeAction(state, { entity: 'stage', event: 'COMPLETE' })).toThrow();
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

// ============================================================
// PO-S02-A-03 — unknown actions rejected at the schema layer
// ============================================================

describe('reducer — schema-layer rejection of unknown actions (PO-S02-A-03)', () => {
  const INVALID_ACTIONS: Array<[string, unknown]> = [
    ['unknown event literal', { entity: 'stage', event: 'BOGUS' }],
    ['unknown entity', { entity: 'host', event: 'PLAN' }],
    ['cross-entity mismatch (slice event on stage)', { entity: 'stage', event: 'PASS_CV' }],
    ['cross-entity mismatch (stage event on slice)', { entity: 'slice', event: 'PLAN' }],
    ['cv-only event on project', { entity: 'project', event: 'PASS' }],
    ['non-string event', { entity: 'stage', event: 42 }],
    ['missing event field', { entity: 'stage' }],
    ['missing entity field', { event: 'PLAN' }],
    ['non-object (string)', 'PLAN' ],
    ['null', null],
  ];

  for (const [name, action] of INVALID_ACTIONS) {
    it(`rejects ${name}`, () => {
      const state = makeStage();
      expect(() => reduceRuntimeAction(state, action as unknown as RuntimeAction)).toThrow(
        SchemaValidationError,
      );
      expect(() => assertRuntimeAction(action)).toThrow(SchemaValidationError);
    });
  }

  it('schema errors carry the canonical RUNTIME.SCHEMA_MISMATCH code and field errors', () => {
    try {
      assertRuntimeAction({ entity: 'stage', event: 'BOGUS' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      const e = err as SchemaValidationError;
      expect(e.code).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(Array.isArray(e.fieldErrors)).toBe(true);
      expect(e.fieldErrors.length).toBeGreaterThan(0);
    }
  });

  it('assertRuntimeAction accepts every canonical entity-bound member', () => {
    const actions: RuntimeAction[] = [
      ...(['PLAN', 'FINALIZE_PLAN', 'START', 'PROGRESS', 'SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'REPARTITION'] as const).map(event => ({ entity: 'stage' as const, event })),
      ...(['START', 'FINISH_TASKS', 'RUN_CV', 'REVISE', 'PASS_CV', 'INTEGRATE', 'FINISH_INTEGRATION'] as const).map(event => ({ entity: 'slice' as const, event })),
      ...(['MARK_READY', 'START_CV', 'PASS', 'REQUEST_REPAIR', 'FIX', 'RECHECK'] as const).map(event => ({ entity: 'cv' as const, event })),
      ...(['SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'RESUME'] as const).map(event => ({ entity: 'project' as const, event })),
    ];
    expect(actions).toHaveLength(25);
    for (const action of actions) {
      expect(() => assertRuntimeAction(action)).not.toThrow();
    }
  });
});

// ============================================================
// Active-slice targeting & immutability
// ============================================================

describe('reducer — active slice targeting and immutability', () => {
  it('targets the first non-INTEGRATED slice in declaration order', () => {
    const sliceA = makeSlice({ slice_id: 'S02-A', slice_state: SliceState.INTEGRATED, cv_status: CVStatus.PASS });
    const sliceB = makeSlice({ slice_id: 'S02-B', slice_state: SliceState.PLANNED, cv_status: CVStatus.NOT_STARTED });
    const state = makeStage({ slices: [sliceA, sliceB] });
    const next = reduceRuntimeAction(state, { entity: 'slice', event: 'START' });
    expect(next.slices).toHaveLength(2);
    // Untouched INTEGRATED slice keeps reference identity.
    expect(next.slices[0]).toBe(sliceA);
    // The active slice is replaced with the advanced state.
    expect(next.slices[1]).not.toBe(sliceB);
    expect(next.slices[1].slice_state).toBe(SliceState.IN_PROGRESS);
    expect(next.slices[1].cv_status).toBe(CVStatus.NOT_STARTED);
  });

  it('does not mutate the input state (deep-frozen input stays intact)', () => {
    const state: ReconciledStageState = makeStage({
      slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })],
    });
    const snapshot = JSON.parse(JSON.stringify(state)) as ReconciledStageState;
    const frozen = Object.freeze(state);
    const next = reduceRuntimeAction(frozen, { entity: 'slice', event: 'PASS_CV' });
    // Input unchanged — a reducer that mutated in place would have thrown on
    // the frozen object (strict mode) or produced a different snapshot.
    expect(JSON.stringify(frozen)).toBe(JSON.stringify(snapshot));
    // Output is a fresh object graph — never the same references.
    expect(next).not.toBe(frozen);
    expect(next.slices).not.toBe(frozen.slices);
    expect(next.slices[0]).not.toBe(frozen.slices[0]);
    expect(next.slices[0].slice_state).toBe(SliceState.CV_PASSED);
    expect(next.slices[0].cv_status).toBe(CVStatus.PASS);
  });
});
