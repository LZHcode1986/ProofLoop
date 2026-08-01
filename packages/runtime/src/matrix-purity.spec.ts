/**
 * Independent proof supplement — PO-S02-A-02 / PO-S02-A-03 / PO-S02-A-04
 * (S02-A-T04)
 *
 * Complements reducer.spec.ts (T02), state-model.spec.ts (T01) and
 * stage-state.spec.ts (T03) with the Slice's independent proofs:
 *
 *   1. Exhaustive legal/illegal matrix (kernel §6 transition tables as the
 *      independent oracle): every (fromState × event) combination of the
 *      four machines is classified legal (advances to the canonical target,
 *      aggregates consistent) or illegal (InvalidTransitionError with exact
 *      entityId / fromState / toState).
 *        Stage   6 states × 8 events = 48 combos (8 legal / 40 illegal)
 *        Slice   7 states × 7 events = 49 combos (7 legal / 42 illegal)
 *        CV      6 states × 6 events = 36 combos (6 legal / 30 illegal)
 *        Project 4 states × 4 events = 16 combos (4 legal / 12 illegal)
 *      This proves PO-S02-A-02 (legal rows incl. the EXECUTING→EXECUTING
 *      self-loop, COMPLETED→EXECUTING repartition, the cv repair loop and
 *      the INTEGRATED terminal state) and PO-S02-A-03 (every non-table
 *      combination throws with structured fields — incl. INTEGRATE before
 *      CV_PASSED, PASS_CV at READY_FOR_CV, COMPLETE at EXECUTING,
 *      REPARTITION at non-COMPLETED) exhaustively, with explicit
 *      matrix-completeness markers.
 *
 *   2. Pure-function proof (PO-S02-A-04 / HP-005): double invocation of the
 *      reducer on the same (state, action) input produces deep-equal
 *      outputs; invocation order does not affect the result; a deep-frozen
 *      input is never mutated (no in-place writes); a static source scan of
 *      the four production modules finds no I/O, timestamp, randomness or
 *      global-state constructs.
 *
 *   3. Module-level dependency scan (PO-S02-A-04): static import analysis of
 *      state-model.ts / reducer.ts / stage-state.ts / index.ts — only
 *      @proofloop/kernel and intra-package relative imports; no
 *      @earendil-works/*, no .agents/runtime, no relative cross-package
 *      imports.
 *
 * Expected values are the kernel §6 transition tables (independent oracle —
 * `packages/kernel/src/transitions.ts`) written as known-good literals,
 * never derived from the reducer implementation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  reduceRuntimeAction,
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
// Kernel §6 transition tables — independent oracle (known-good literals)
// ============================================================

/** Canonical Stage states and events (kernel §6). */
const STAGE_STATES: readonly StageState[] = [
  StageState.UNINITIALIZED, StageState.PLANNING, StageState.READY,
  StageState.EXECUTING, StageState.UNDER_REVIEW, StageState.COMPLETED,
];
const STAGE_EVENTS: readonly StageEvent[] = [
  'PLAN', 'FINALIZE_PLAN', 'START', 'PROGRESS',
  'SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'REPARTITION',
];

/**
 * Stage legal table — exactly the 8 kernel §6 rows (incl. the EXECUTING→
 * EXECUTING self-loop and the COMPLETED→EXECUTING repartition row).
 * [from, event] → to.
 */
const STAGE_LEGAL: Readonly<Record<StageState, Partial<Record<StageEvent, StageState>>>> = {
  [StageState.UNINITIALIZED]: { PLAN: StageState.PLANNING },
  [StageState.PLANNING]: { FINALIZE_PLAN: StageState.READY },
  [StageState.READY]: { START: StageState.EXECUTING },
  [StageState.EXECUTING]: {
    PROGRESS: StageState.EXECUTING,
    SUBMIT_FOR_REVIEW: StageState.UNDER_REVIEW,
  },
  [StageState.UNDER_REVIEW]: {
    REOPEN: StageState.EXECUTING,
    COMPLETE: StageState.COMPLETED,
  },
  [StageState.COMPLETED]: { REPARTITION: StageState.EXECUTING },
};

/** Canonical Slice states and events (kernel §6). */
const SLICE_STATES: readonly SliceState[] = [
  SliceState.PLANNED, SliceState.IN_PROGRESS, SliceState.READY_FOR_CV,
  SliceState.CV_IN_PROGRESS, SliceState.CV_PASSED,
  SliceState.INTEGRATING, SliceState.INTEGRATED,
];
const SLICE_EVENTS: readonly SliceEvent[] = [
  'START', 'FINISH_TASKS', 'RUN_CV', 'REVISE',
  'PASS_CV', 'INTEGRATE', 'FINISH_INTEGRATION',
];

/**
 * Canonical slice ↔ cv aggregate pairing per slice state (the consistent
 * aggregate the reducer maintains in the happy path — used to build the
 * exhaustive matrix so that every row is a well-formed aggregate).
 */
const SLICE_CV_PAIRING: Readonly<Record<SliceState, CVStatus>> = {
  [SliceState.PLANNED]: CVStatus.NOT_STARTED,
  [SliceState.IN_PROGRESS]: CVStatus.NOT_STARTED,
  [SliceState.READY_FOR_CV]: CVStatus.READY_FOR_CV,
  [SliceState.CV_IN_PROGRESS]: CVStatus.IN_PROGRESS,
  [SliceState.CV_PASSED]: CVStatus.PASS,
  [SliceState.INTEGRATING]: CVStatus.PASS,
  [SliceState.INTEGRATED]: CVStatus.PASS,
};

/**
 * Slice legal table — exactly the 7 kernel §6 rows. [from, event] →
 * [toSlice, toCv] (toCv is the aggregate-consistent CVStatus after the
 * action; the repair loop REVISE↔REQUEST_REPAIR and the INTEGRATED terminal
 * are explicit rows).
 */
const SLICE_LEGAL: Readonly<Record<SliceState, Partial<Record<SliceEvent, [SliceState, CVStatus]>>>> = {
  [SliceState.PLANNED]: { START: [SliceState.IN_PROGRESS, CVStatus.NOT_STARTED] },
  [SliceState.IN_PROGRESS]: { FINISH_TASKS: [SliceState.READY_FOR_CV, CVStatus.READY_FOR_CV] },
  [SliceState.READY_FOR_CV]: { RUN_CV: [SliceState.CV_IN_PROGRESS, CVStatus.IN_PROGRESS] },
  [SliceState.CV_IN_PROGRESS]: {
    REVISE: [SliceState.READY_FOR_CV, CVStatus.REPAIR],
    PASS_CV: [SliceState.CV_PASSED, CVStatus.PASS],
  },
  [SliceState.CV_PASSED]: { INTEGRATE: [SliceState.INTEGRATING, CVStatus.PASS] },
  [SliceState.INTEGRATING]: { FINISH_INTEGRATION: [SliceState.INTEGRATED, CVStatus.PASS] },
  [SliceState.INTEGRATED]: {},
};

/** Canonical CV statuses and events (kernel §6). */
const CV_STATES: readonly CVStatus[] = [
  CVStatus.NOT_STARTED, CVStatus.READY_FOR_CV, CVStatus.IN_PROGRESS,
  CVStatus.PASS, CVStatus.REPAIR, CVStatus.PENDING_RECHECK,
];
const CV_EVENTS: readonly CvEvent[] = [
  'MARK_READY', 'START_CV', 'PASS', 'REQUEST_REPAIR', 'FIX', 'RECHECK',
];

/**
 * Canonical cv ↔ slice aggregate pairing per cv status (used to build the
 * exhaustive cv matrix with well-formed aggregates; NOT_STARTED pairs with
 * the slice IN_PROGRESS that MARK_READY requires via FINISH_TASKS).
 */
const CV_SLICE_PAIRING: Readonly<Record<CVStatus, SliceState>> = {
  [CVStatus.NOT_STARTED]: SliceState.IN_PROGRESS,
  [CVStatus.READY_FOR_CV]: SliceState.READY_FOR_CV,
  [CVStatus.IN_PROGRESS]: SliceState.CV_IN_PROGRESS,
  [CVStatus.PASS]: SliceState.CV_PASSED,
  [CVStatus.REPAIR]: SliceState.READY_FOR_CV,
  [CVStatus.PENDING_RECHECK]: SliceState.READY_FOR_CV,
};

/**
 * CV legal table — exactly the 6 kernel §6 rows. [from, event] →
 * [toCv, toSlice] (toSlice is the aggregate-consistent SliceState after the
 * action; FIX is cv-only — the slice stays READY_FOR_CV).
 */
const CV_LEGAL: Readonly<Record<CVStatus, Partial<Record<CvEvent, [CVStatus, SliceState]>>>> = {
  [CVStatus.NOT_STARTED]: { MARK_READY: [CVStatus.READY_FOR_CV, SliceState.READY_FOR_CV] },
  [CVStatus.READY_FOR_CV]: { START_CV: [CVStatus.IN_PROGRESS, SliceState.CV_IN_PROGRESS] },
  [CVStatus.IN_PROGRESS]: {
    PASS: [CVStatus.PASS, SliceState.CV_PASSED],
    REQUEST_REPAIR: [CVStatus.REPAIR, SliceState.READY_FOR_CV],
  },
  [CVStatus.PASS]: {},
  [CVStatus.REPAIR]: { FIX: [CVStatus.PENDING_RECHECK, SliceState.READY_FOR_CV] },
  [CVStatus.PENDING_RECHECK]: { RECHECK: [CVStatus.IN_PROGRESS, SliceState.CV_IN_PROGRESS] },
};

/** Canonical Project states and events (kernel §6). */
const PROJECT_STATES: readonly ProjectState[] = [
  ProjectState.IN_PROGRESS, ProjectState.UNDER_REVIEW,
  ProjectState.COMPLETED, ProjectState.DEFERRED,
];
const PROJECT_EVENTS: readonly ProjectEvent[] = [
  'SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'RESUME',
];

/**
 * Project legal table — exactly the 4 kernel §6 rows. COMPLETED is
 * terminal — no outgoing transitions.
 */
const PROJECT_LEGAL: Readonly<Record<ProjectState, Partial<Record<ProjectEvent, ProjectState>>>> = {
  [ProjectState.IN_PROGRESS]: { SUBMIT_FOR_REVIEW: ProjectState.UNDER_REVIEW },
  [ProjectState.UNDER_REVIEW]: {
    REOPEN: ProjectState.IN_PROGRESS,
    COMPLETE: ProjectState.COMPLETED,
  },
  [ProjectState.COMPLETED]: {},
  [ProjectState.DEFERRED]: { RESUME: ProjectState.IN_PROGRESS },
};

/** Number of legal rows per entity (kernel §6 row counts). */
const LEGAL_ROW_COUNTS = { stage: 8, slice: 7, cv: 6, project: 4 } as const;

// ============================================================
// Exhaustive matrix builders (full fromState × event cross product)
// ============================================================

interface StageMatrixRow {
  from: StageState;
  event: StageEvent;
  legal: boolean;
  to: StageState | null;
}

function stageMatrixRows(): StageMatrixRow[] {
  const rows: StageMatrixRow[] = [];
  for (const from of STAGE_STATES) {
    for (const event of STAGE_EVENTS) {
      const to = STAGE_LEGAL[from]?.[event];
      rows.push({ from, event, legal: to !== undefined, to: to ?? null });
    }
  }
  return rows;
}

interface SliceMatrixRow {
  fromSlice: SliceState;
  fromCv: CVStatus;
  event: SliceEvent;
  legal: boolean;
  toSlice: SliceState | null;
  toCv: CVStatus | null;
}

function sliceMatrixRows(): SliceMatrixRow[] {
  const rows: SliceMatrixRow[] = [];
  for (const fromSlice of SLICE_STATES) {
    for (const event of SLICE_EVENTS) {
      const target = SLICE_LEGAL[fromSlice]?.[event];
      rows.push({
        fromSlice,
        fromCv: SLICE_CV_PAIRING[fromSlice],
        event,
        legal: target !== undefined,
        toSlice: target?.[0] ?? null,
        toCv: target?.[1] ?? null,
      });
    }
  }
  return rows;
}

interface CvMatrixRow {
  fromCv: CVStatus;
  fromSlice: SliceState;
  event: CvEvent;
  legal: boolean;
  toCv: CVStatus | null;
  toSlice: SliceState | null;
}

function cvMatrixRows(): CvMatrixRow[] {
  const rows: CvMatrixRow[] = [];
  for (const fromCv of CV_STATES) {
    for (const event of CV_EVENTS) {
      const target = CV_LEGAL[fromCv]?.[event];
      rows.push({
        fromCv,
        fromSlice: CV_SLICE_PAIRING[fromCv],
        event,
        legal: target !== undefined,
        toCv: target?.[0] ?? null,
        toSlice: target?.[1] ?? null,
      });
    }
  }
  return rows;
}

interface ProjectMatrixRow {
  from: ProjectState;
  event: ProjectEvent;
  legal: boolean;
  to: ProjectState | null;
}

function projectMatrixRows(): ProjectMatrixRow[] {
  const rows: ProjectMatrixRow[] = [];
  for (const from of PROJECT_STATES) {
    for (const event of PROJECT_EVENTS) {
      const to = PROJECT_LEGAL[from]?.[event];
      rows.push({ from, event, legal: to !== undefined, to: to ?? null });
    }
  }
  return rows;
}

// ============================================================
// Shared illegal-assertion helper (structured error fields, PO-S02-A-03)
// ============================================================

function expectInvalidTransition(
  state: ReconciledStageState,
  action: RuntimeAction,
  entityId: string,
  fromState: string,
  toState: string,
): void {
  expect(() => reduceRuntimeAction(state, action)).toThrow(InvalidTransitionError);
  let thrown: unknown;
  try {
    reduceRuntimeAction(state, action);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(InvalidTransitionError);
  const err = thrown as InvalidTransitionError;
  expect(err.name).toBe('InvalidTransitionError');
  expect(err.entityId).toBe(entityId);
  expect(err.fromState).toBe(fromState);
  expect(err.toState).toBe(toState);
  expect(err.message.length).toBeGreaterThan(0);
}

// ============================================================
// PO-S02-A-02 / PO-S02-A-03 — exhaustive legal/illegal matrix
// ============================================================

describe('exhaustive matrix — stage (PO-S02-A-02/03)', () => {
  const rows = stageMatrixRows();

  it('matrix completeness: 6 states × 8 events = 48 combos, 8 legal / 40 illegal', () => {
    expect(rows).toHaveLength(STAGE_STATES.length * STAGE_EVENTS.length);
    expect(rows).toHaveLength(48);
    expect(rows.filter(r => r.legal)).toHaveLength(LEGAL_ROW_COUNTS.stage);
    expect(rows.filter(r => !r.legal)).toHaveLength(48 - LEGAL_ROW_COUNTS.stage);
    // Named kernel §6 rows are explicitly present: the EXECUTING→EXECUTING
    // self-loop and the COMPLETED→EXECUTING repartition row.
    expect(STAGE_LEGAL[StageState.EXECUTING]?.['PROGRESS']).toBe(StageState.EXECUTING);
    expect(STAGE_LEGAL[StageState.COMPLETED]?.['REPARTITION']).toBe(StageState.EXECUTING);
    // Total legal rows across the table equal the kernel §6 count.
    const totalRows = Object.values(STAGE_LEGAL).reduce(
      (n, row) => n + Object.keys(row).length, 0,
    );
    expect(totalRows).toBe(LEGAL_ROW_COUNTS.stage);
  });

  for (const { from, event, legal, to } of rows) {
    it(`stage ${from} --${event}--> ${legal ? String(to) : 'rejected'}`, () => {
      const state = makeStage({ stage_state: from });
      if (legal) {
        const next = reduceRuntimeAction(state, { entity: 'stage', event });
        expect(next).not.toBe(state);
        expect(next.stage_state).toBe(to);
      } else {
        expectInvalidTransition(
          state,
          { entity: 'stage', event },
          'S02', // stage_id
          from,
          event,
        );
      }
    });
  }

  it('required PO examples are covered: stage COMPLETE at EXECUTING, REPARTITION at non-COMPLETED', () => {
    const names = rows.filter(r => !r.legal && r.from === StageState.EXECUTING && r.event === 'COMPLETE');
    expect(names).toHaveLength(1);
    expectInvalidTransition(
      makeStage({ stage_state: StageState.EXECUTING }),
      { entity: 'stage', event: 'COMPLETE' },
      'S02', StageState.EXECUTING, 'COMPLETE',
    );
    // REPARTITION is legal only from COMPLETED — every other stage state rejects it.
    for (const from of STAGE_STATES) {
      if (from === StageState.COMPLETED) continue;
      expectInvalidTransition(
        makeStage({ stage_state: from }),
        { entity: 'stage', event: 'REPARTITION' },
        'S02', from, 'REPARTITION',
      );
    }
  });
});

describe('exhaustive matrix — slice (PO-S02-A-02/03)', () => {
  const rows = sliceMatrixRows();

  it('matrix completeness: 7 states × 7 events = 49 combos, 7 legal / 42 illegal', () => {
    expect(rows).toHaveLength(SLICE_STATES.length * SLICE_EVENTS.length);
    expect(rows).toHaveLength(49);
    expect(rows.filter(r => r.legal)).toHaveLength(LEGAL_ROW_COUNTS.slice);
    expect(rows.filter(r => !r.legal)).toHaveLength(49 - LEGAL_ROW_COUNTS.slice);
    // Named kernel §6 rows are explicitly present: the cv repair loop row
    // (CV_IN_PROGRESS --REVISE--> READY_FOR_CV) and the INTEGRATED terminal
    // (no outgoing transitions).
    expect(SLICE_LEGAL[SliceState.CV_IN_PROGRESS]?.['REVISE']?.[0]).toBe(SliceState.READY_FOR_CV);
    expect(SLICE_LEGAL[SliceState.INTEGRATED]).toEqual({});
    const totalRows = Object.values(SLICE_LEGAL).reduce(
      (n, row) => n + Object.keys(row).length, 0,
    );
    expect(totalRows).toBe(LEGAL_ROW_COUNTS.slice);
  });

  for (const { fromSlice, fromCv, event, legal, toSlice, toCv } of rows) {
    it(`slice ${fromSlice} --${event}--> ${legal ? `${String(toSlice)} (cv ${String(toCv)})` : 'rejected'}`, () => {
      const state = makeStage({
        slices: [makeSlice({ slice_state: fromSlice, cv_status: fromCv })],
      });
      if (legal) {
        const next = reduceRuntimeAction(state, { entity: 'slice', event });
        expect(next).not.toBe(state);
        const slice = next.slices[0];
        expect(slice.slice_state).toBe(toSlice);
        expect(slice.cv_status).toBe(toCv);
        // Aggregate consistency — the derived stage state is untouched.
        expect(next.stage_state).toBe(state.stage_state);
      } else {
        // With the canonical aggregate pairing every illegal row is rejected
        // by the slice machine first: fromState = slice state, toState = event.
        expectInvalidTransition(
          state,
          { entity: 'slice', event },
          'S02-A', // active slice_id
          fromSlice,
          event,
        );
      }
    });
  }

  it('required PO examples are covered: slice INTEGRATE before CV_PASSED, PASS_CV at READY_FOR_CV', () => {
    expectInvalidTransition(
      makeStage({ slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })] }),
      { entity: 'slice', event: 'INTEGRATE' },
      'S02-A', SliceState.CV_IN_PROGRESS, 'INTEGRATE',
    );
    expectInvalidTransition(
      makeStage({ slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.READY_FOR_CV })] }),
      { entity: 'slice', event: 'PASS_CV' },
      'S02-A', SliceState.READY_FOR_CV, 'PASS_CV',
    );
  });
});

describe('exhaustive matrix — cv (PO-S02-A-02/03)', () => {
  const rows = cvMatrixRows();

  it('matrix completeness: 6 states × 6 events = 36 combos, 6 legal / 30 illegal', () => {
    expect(rows).toHaveLength(CV_STATES.length * CV_EVENTS.length);
    expect(rows).toHaveLength(36);
    expect(rows.filter(r => r.legal)).toHaveLength(LEGAL_ROW_COUNTS.cv);
    expect(rows.filter(r => !r.legal)).toHaveLength(36 - LEGAL_ROW_COUNTS.cv);
    // Named kernel §6 rows: FIX (cv-only, REPAIR→PENDING_RECHECK) and the
    // PENDING_RECHECK→IN_PROGRESS recheck row.
    expect(CV_LEGAL[CVStatus.REPAIR]?.['FIX']?.[0]).toBe(CVStatus.PENDING_RECHECK);
    expect(CV_LEGAL[CVStatus.PENDING_RECHECK]?.['RECHECK']?.[0]).toBe(CVStatus.IN_PROGRESS);
    const totalRows = Object.values(CV_LEGAL).reduce(
      (n, row) => n + Object.keys(row).length, 0,
    );
    expect(totalRows).toBe(LEGAL_ROW_COUNTS.cv);
  });

  for (const { fromCv, fromSlice, event, legal, toCv, toSlice } of rows) {
    it(`cv ${fromCv} --${event}--> ${legal ? `${String(toCv)} (slice ${String(toSlice)})` : 'rejected'}`, () => {
      const state = makeStage({
        slices: [makeSlice({ slice_state: fromSlice, cv_status: fromCv })],
      });
      if (legal) {
        const next = reduceRuntimeAction(state, { entity: 'cv', event });
        expect(next).not.toBe(state);
        const slice = next.slices[0];
        expect(slice.cv_status).toBe(toCv);
        expect(slice.slice_state).toBe(toSlice);
        expect(next.stage_state).toBe(state.stage_state);
      } else {
        // With the canonical aggregate pairing every illegal row is rejected
        // by the cv machine first (the reducer transitions cv before the
        // slice composite): fromState = cv status, toState = event.
        expectInvalidTransition(
          state,
          { entity: 'cv', event },
          'S02-A', // active slice_id
          fromCv,
          event,
        );
      }
    });
  }
});

describe('exhaustive matrix — project (PO-S02-A-02/03)', () => {
  const rows = projectMatrixRows();

  it('matrix completeness: 4 states × 4 events = 16 combos, 4 legal / 12 illegal', () => {
    expect(rows).toHaveLength(PROJECT_STATES.length * PROJECT_EVENTS.length);
    expect(rows).toHaveLength(16);
    expect(rows.filter(r => r.legal)).toHaveLength(LEGAL_ROW_COUNTS.project);
    expect(rows.filter(r => !r.legal)).toHaveLength(16 - LEGAL_ROW_COUNTS.project);
    // COMPLETED is terminal — no outgoing transitions.
    expect(PROJECT_LEGAL[ProjectState.COMPLETED]).toEqual({});
    const totalRows = Object.values(PROJECT_LEGAL).reduce(
      (n, row) => n + Object.keys(row).length, 0,
    );
    expect(totalRows).toBe(LEGAL_ROW_COUNTS.project);
  });

  for (const { from, event, legal, to } of rows) {
    it(`project ${from} --${event}--> ${legal ? String(to) : 'rejected'}`, () => {
      const state = makeStage({ project_state: from });
      if (legal) {
        const next = reduceRuntimeAction(state, { entity: 'project', event });
        expect(next).not.toBe(state);
        expect(next.project_state).toBe(to);
      } else {
        expectInvalidTransition(
          state,
          { entity: 'project', event },
          'S02', // stage_id — the project state is a stage property
          from,
          event,
        );
      }
    });
  }
});

// ============================================================
// PO-S02-A-04 — pure function: double invocation, order independence,
// no mutation, no side channels
// ============================================================

describe('pure function — double invocation deep-equal (PO-S02-A-04)', () => {
  // One representative legal action per entity plus a composite slice action.
  const purityFixtures: ReadonlyArray<readonly [string, ReconciledStageState, RuntimeAction]> = [
    ['stage (self-loop PROGRESS)', makeStage({ stage_state: StageState.EXECUTING }), { entity: 'stage', event: 'PROGRESS' }],
    ['stage (repartition)', makeStage({ stage_state: StageState.COMPLETED }), { entity: 'stage', event: 'REPARTITION' }],
    ['slice (composite PASS_CV)', makeStage({ slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })] }), { entity: 'slice', event: 'PASS_CV' }],
    ['slice (repair loop REVISE)', makeStage({ slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })] }), { entity: 'slice', event: 'REVISE' }],
    ['cv (FIX)', makeStage({ slices: [makeSlice({ slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.REPAIR })] }), { entity: 'cv', event: 'FIX' }],
    ['project (SUBMIT_FOR_REVIEW)', makeStage({ project_state: ProjectState.IN_PROGRESS }), { entity: 'project', event: 'SUBMIT_FOR_REVIEW' }],
  ];

  for (const [name, state, action] of purityFixtures) {
    it(`double invocation ${name}: outputs are deep-equal`, () => {
      const first = reduceRuntimeAction(state, action);
      const second = reduceRuntimeAction(state, action);
      // Fresh object graph each call (immutability) …
      expect(second).not.toBe(first);
      // … yet deep-equal: same input ⇒ same output (HP-005 determinism).
      expect(second).toEqual(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });
  }

  it('double invocation on a rich fixture with multiple slices is deep-equal', () => {
    const state = makeStage({
      slices: [
        makeSlice({ slice_id: 'S02-A', slice_state: SliceState.INTEGRATED, cv_status: CVStatus.PASS, integrated: true }),
        makeSlice({ slice_id: 'S02-B', slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS }),
      ],
      receipt_chain: ['r1', 'r2'],
      findings: [{ code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'warn', message: 'fixture' }],
    });
    const action: RuntimeAction = { entity: 'slice', event: 'PASS_CV' };
    expect(reduceRuntimeAction(state, action)).toEqual(reduceRuntimeAction(state, action));
  });

  it('invocation order does not affect the result', () => {
    const base = makeStage({
      slices: [makeSlice({ slice_state: SliceState.CV_IN_PROGRESS, cv_status: CVStatus.IN_PROGRESS })],
    });
    const a: RuntimeAction = { entity: 'slice', event: 'PASS_CV' };
    const b: RuntimeAction = { entity: 'stage', event: 'PROGRESS' };
    const isolated = reduceRuntimeAction(base, a);
    // Interleave unrelated calls — the result of (base, a) must not depend
    // on calls that happened in between.
    reduceRuntimeAction(base, b);
    reduceRuntimeAction(base, a);
    reduceRuntimeAction(base, b);
    const after = reduceRuntimeAction(base, a);
    expect(after).toEqual(isolated);
  });
});

describe('pure function — no mutation of the input (PO-S02-A-04)', () => {
  function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
      Object.freeze(value);
      for (const key of Object.keys(value)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
    }
    return value;
  }

  it('deep-frozen input is never written (legal and illegal actions)', () => {
    const state = makeStage({
      slices: [
        makeSlice({ slice_id: 'S02-A', slice_state: SliceState.INTEGRATED, cv_status: CVStatus.PASS, integrated: true }),
        makeSlice({ slice_id: 'S02-B', slice_state: SliceState.READY_FOR_CV, cv_status: CVStatus.READY_FOR_CV }),
      ],
      receipt_chain: ['r1'],
      findings: [{ code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'warn', message: 'fixture' }],
    });
    const snapshot = JSON.stringify(state);
    const frozen = deepFreeze(state);

    // Legal actions across every entity — a reducer that mutated in place
    // would throw a TypeError on the frozen object (strict mode).
    const legal = reduceRuntimeAction(frozen, { entity: 'slice', event: 'RUN_CV' });
    expect(legal.slices[1].slice_state).toBe(SliceState.CV_IN_PROGRESS);
    expect(legal.slices[1].cv_status).toBe(CVStatus.IN_PROGRESS);
    expect(reduceRuntimeAction(frozen, { entity: 'stage', event: 'PROGRESS' }).stage_state).toBe(StageState.EXECUTING);
    expect(reduceRuntimeAction(frozen, { entity: 'project', event: 'SUBMIT_FOR_REVIEW' }).project_state).toBe(ProjectState.UNDER_REVIEW);

    // Illegal action — throws the structured error, not a mutation TypeError.
    expect(() => reduceRuntimeAction(frozen, { entity: 'slice', event: 'INTEGRATE' })).toThrow(InvalidTransitionError);

    // The frozen input is byte-for-byte unchanged.
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });

  it('untouched structure keeps reference identity (no hidden copy-on-write mutation)', () => {
    const sliceA = makeSlice({ slice_id: 'S02-A', slice_state: SliceState.INTEGRATED, cv_status: CVStatus.PASS, integrated: true });
    const state = makeStage({ slices: [sliceA], stage_state: StageState.COMPLETED });
    const next = reduceRuntimeAction(state, { entity: 'stage', event: 'REPARTITION' });
    expect(next.slices).toBe(state.slices); // untouched arrays keep identity
    expect(next.slices[0]).toBe(sliceA);
    expect(next.stage_state).toBe(StageState.EXECUTING);
  });
});

describe('pure function — static source scan for side channels (PO-S02-A-04 / HP-005)', () => {
  const PRODUCTION_MODULES = ['state-model.ts', 'reducer.ts', 'stage-state.ts', 'index.ts'];

  const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
    ['timestamps (Date)', /\bDate\b/],
    ['randomness (Math.random)', /\bMath\s*\.\s*random\b/],
    ['process access (process.*)', /\bprocess\s*\./],
    ['global state (globalThis)', /\bglobalThis\b/],
    ['console I/O', /\bconsole\s*\./],
    ['node fs require', /\brequire\s*\(\s*['"](?:node:)?fs/],
    ['node net/http require', /\brequire\s*\(\s*['"](?:node:)?(?:net|http|https)/],
    ['network fetch', /\bfetch\s*\(/],
    ['dynamic import', /\bimport\s*\(/],
  ];

  for (const file of PRODUCTION_MODULES) {
    it(`${file} contains no I/O, timestamp, randomness or global-state construct`, () => {
      const src = readFileSync(path.join(__dirname, file), 'utf8');
      for (const [label, re] of FORBIDDEN_PATTERNS) {
        expect(re.test(src), `${file} contains ${label}`).toBe(false);
      }
    });
  }
});

// ============================================================
// PO-S02-A-04 — module-level dependency scan (only kernel + intra-package)
// ============================================================

describe('module-level dependency scan (PO-S02-A-04)', () => {
  const PRODUCTION_MODULES = ['state-model.ts', 'reducer.ts', 'stage-state.ts', 'index.ts'];

  /**
   * Expected import specifier sets per production module (known-good
   * literals — the task's dependency contract). state-model.ts imports only
   * kernel types; reducer.ts / stage-state.ts add the intra-package
   * state-model import; index.ts is the aggregation entrypoint (grew with
   * ./relay-contract when S02-B added the WorkerRelayPort contract exports,
   * with ./worker-step-service when S02-B-T02 added WorkerStepService, and
   * with ./receipt-layout + ./receipt-reader when S02-C-T01 added the
   * canonical receipt category layout policy and the receipt reader, and
   * with ./derive-next-action when S02-D-T01 added the pure next-action
   * derivation, and with ./next-action-service when S02-D-T02 added the
   * NextActionService full pipeline, and with ./admission-request +
   * ./admit-pipeline when S02-E-T01 added the 7 AdmissionRequest types and
   * the unified admit pipeline, and with ./admission when S02-E-T02 added
   * the admitWorkerResult / admitCVResult slice-boundary admit methods).
   */
  const EXPECTED_IMPORT_SETS: Readonly<Record<string, ReadonlySet<string>>> = {
    'state-model.ts': new Set(['@proofloop/kernel']),
    'reducer.ts': new Set(['@proofloop/kernel', './state-model']),
    'stage-state.ts': new Set(['@proofloop/kernel', './state-model']),
    'index.ts': new Set(['@proofloop/kernel', './state-model', './reducer', './stage-state', './relay-contract', './worker-step-service', './receipt-layout', './receipt-reader', './git-source', './manifest-source', './reconcile', './derive-next-action', './next-action-service', './admission-request', './admit-pipeline', './admission']),
  };

  /** Extract all `import … from '…'` / `export … from '…'` / `import '…'` specifiers. */
  function extractImportSpecifiers(src: string): string[] {
    const out: string[] = [];
    const fromRe = /(?:^|[\n;])\s*(?:import|export)\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(src)) !== null) out.push(m[1]);
    const sideEffectRe = /(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]/g;
    while ((m = sideEffectRe.exec(src)) !== null) out.push(m[1]);
    return out;
  }

  for (const file of PRODUCTION_MODULES) {
    it(`${file} imports exactly the expected specifiers (kernel + intra-package only)`, () => {
      const src = readFileSync(path.join(__dirname, file), 'utf8');
      const specifiers = extractImportSpecifiers(src);
      expect(specifiers.length).toBeGreaterThan(0);
      expect(new Set(specifiers)).toEqual(EXPECTED_IMPORT_SETS[file]);

      for (const spec of specifiers) {
        // Allowlist: @proofloop/kernel (the single package dependency) or an
        // intra-package relative import. No third-party / workspace packages.
        const allowed = spec === '@proofloop/kernel' || spec.startsWith('./');
        expect(allowed, `${file} imports forbidden specifier '${spec}'`).toBe(true);
        // Explicit forbidden markers (task scope):
        expect(spec.startsWith('@earendil-works')).toBe(false);
        expect(spec.includes('.agents/')).toBe(false);
        expect(spec.startsWith('../')).toBe(false);
      }
    });
  }
});
