/**
 * State model & RuntimeAction — PO-S02-A-01
 *
 * Verifies the public type seam of @proofloop/runtime:
 *   - ReconciledStageState / ReconciledSliceState normalized state model,
 *     using kernel canonical enum types (StageState / SliceState / CVStatus /
 *     ProjectState) — no open strings.
 *   - Closed-set RuntimeAction union, mapping 1:1 to the kernel §6 event
 *     groups: Stage 8 + Slice 7 + CV 6 + Project 4 = 21 distinct literals,
 *     with cross-entity same-name literals (START, SUBMIT_FOR_REVIEW, REOPEN,
 *     COMPLETE) disambiguated by entity binding.
 *
 * The canonical literal sets below are the independent oracle (kernel
 * `packages/kernel/src/transitions.ts` §6 transition tables / authority
 * excerpts) — known-good literals, not derived from the implementation.
 */

import { describe, it, expect } from 'vitest';
import {
  RUNTIME_ACTION_ENTITIES,
  type RuntimeAction,
  type RuntimeActionEntity,
  type ReconciledStageState,
  type ReconciledSliceState,
  type ReconciledTaskState,
} from '@proofloop/runtime';
import {
  StageState,
  SliceState,
  CVStatus,
  ProjectState,
} from '@proofloop/kernel';

// ============================================================
// Canonical kernel §6 event literal sets (independent oracle)
// ============================================================

const CANONICAL_STAGE_EVENTS = [
  'PLAN', 'FINALIZE_PLAN', 'START', 'PROGRESS',
  'SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'REPARTITION',
] as const;

const CANONICAL_SLICE_EVENTS = [
  'START', 'FINISH_TASKS', 'RUN_CV', 'REVISE',
  'PASS_CV', 'INTEGRATE', 'FINISH_INTEGRATION',
] as const;

const CANONICAL_CV_EVENTS = [
  'MARK_READY', 'START_CV', 'PASS', 'REQUEST_REPAIR', 'FIX', 'RECHECK',
] as const;

const CANONICAL_PROJECT_EVENTS = [
  'SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'RESUME',
] as const;

/** Every canonical entity-bound action member (8 + 7 + 6 + 4 = 25). */
const ALL_CANONICAL_ACTIONS: RuntimeAction[] = [
  ...CANONICAL_STAGE_EVENTS.map(event => ({ entity: 'stage' as const, event })),
  ...CANONICAL_SLICE_EVENTS.map(event => ({ entity: 'slice' as const, event })),
  ...CANONICAL_CV_EVENTS.map(event => ({ entity: 'cv' as const, event })),
  ...CANONICAL_PROJECT_EVENTS.map(event => ({ entity: 'project' as const, event })),
];

/** Spec-local closed-set structural predicate (production schema check is T02). */
const VALID_EVENTS_BY_ENTITY: Record<string, ReadonlySet<string>> = {
  stage: new Set(CANONICAL_STAGE_EVENTS),
  slice: new Set(CANONICAL_SLICE_EVENTS),
  cv: new Set(CANONICAL_CV_EVENTS),
  project: new Set(CANONICAL_PROJECT_EVENTS),
};

function isCanonicalAction(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.entity !== 'string' || typeof v.event !== 'string') return false;
  const events = VALID_EVENTS_BY_ENTITY[v.entity];
  return events !== undefined && events.has(v.event);
}

// ============================================================
// Type-level fixture: ReconciledStageState with kernel canonical enums
// ============================================================

const SLICE_A: ReconciledSliceState = {
  slice_id: 'S02-A',
  dependencies: [],
  tasks: [
    { task_id: 'S02-A-T01', checked: true, evidence_written: true } satisfies ReconciledTaskState,
  ],
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
};

const STAGE_FIXTURE: ReconciledStageState = {
  stage_id: 'S02',
  slices: [SLICE_A],
  stage_state: StageState.EXECUTING,
  project_state: ProjectState.IN_PROGRESS,
  receipt_chain: [],
  findings: [],
};

// ============================================================
// PO-S02-A-01 tests
// ============================================================

describe('RuntimeAction closed set', () => {
  it('exports the four canonical entities as a runtime closed set', () => {
    expect([...RUNTIME_ACTION_ENTITIES]).toEqual([
      'stage', 'slice', 'cv', 'project',
    ]);
  });

  it('maps to exactly 21 distinct kernel §6 event literals (8+7+6+4)', () => {
    expect(CANONICAL_STAGE_EVENTS).toHaveLength(8);
    expect(CANONICAL_SLICE_EVENTS).toHaveLength(7);
    expect(CANONICAL_CV_EVENTS).toHaveLength(6);
    expect(CANONICAL_PROJECT_EVENTS).toHaveLength(4);
    const all = new Set([
      ...CANONICAL_STAGE_EVENTS,
      ...CANONICAL_SLICE_EVENTS,
      ...CANONICAL_CV_EVENTS,
      ...CANONICAL_PROJECT_EVENTS,
    ]);
    // 25 raw members minus 4 cross-entity duplicates (START, SUBMIT_FOR_REVIEW,
    // REOPEN, COMPLETE) = 21 distinct literals.
    expect(all.size).toBe(21);
  });

  it('accepts every canonical entity-bound member (25 members, 21 literals)', () => {
    expect(ALL_CANONICAL_ACTIONS).toHaveLength(25);
    for (const action of ALL_CANONICAL_ACTIONS) {
      expect(isCanonicalAction(action)).toBe(true);
    }
  });

  it('disambiguates cross-entity same-name literals by entity binding', () => {
    // START: stage READY→EXECUTING vs slice PLANNED→IN_PROGRESS
    const stageStart: RuntimeAction = { entity: 'stage', event: 'START' };
    const sliceStart: RuntimeAction = { entity: 'slice', event: 'START' };
    expect(stageStart.entity).toBe('stage');
    expect(sliceStart.entity).toBe('slice');
    // SUBMIT_FOR_REVIEW: stage vs project
    const stageSfr: RuntimeAction = { entity: 'stage', event: 'SUBMIT_FOR_REVIEW' };
    const projectSfr: RuntimeAction = { entity: 'project', event: 'SUBMIT_FOR_REVIEW' };
    expect(stageSfr.entity).toBe('stage');
    expect(projectSfr.entity).toBe('project');
    // REOPEN: stage vs project
    const stageReopen: RuntimeAction = { entity: 'stage', event: 'REOPEN' };
    const projectReopen: RuntimeAction = { entity: 'project', event: 'REOPEN' };
    expect(stageReopen.entity).toBe('stage');
    expect(projectReopen.entity).toBe('project');
    // COMPLETE: stage vs project
    const stageComplete: RuntimeAction = { entity: 'stage', event: 'COMPLETE' };
    const projectComplete: RuntimeAction = { entity: 'project', event: 'COMPLETE' };
    expect(stageComplete.entity).toBe('stage');
    expect(projectComplete.entity).toBe('project');
  });

  it('rejects illegal values at runtime (closed set)', () => {
    expect(isCanonicalAction({ entity: 'stage', event: 'BOGUS' })).toBe(false);
    expect(isCanonicalAction({ entity: 'host', event: 'PLAN' })).toBe(false);
    expect(isCanonicalAction({ entity: 'stage', event: 'PASS_CV' })).toBe(false);
    expect(isCanonicalAction({ entity: 'slice', event: 'PLAN' })).toBe(false);
    expect(isCanonicalAction({ entity: 'cv', event: 'COMPLETE' })).toBe(false);
    expect(isCanonicalAction({ entity: 'stage' })).toBe(false);
    expect(isCanonicalAction({ entity: 'stage', event: 42 })).toBe(false);
    expect(isCanonicalAction(null)).toBe(false);
    expect(isCanonicalAction('PLAN')).toBe(false);
  });

  it('excludes illegal values at the type level', () => {
    // Unknown event literal — not in any kernel §6 group.
    // @ts-expect-error — 'BOGUS' is not a canonical kernel §6 event literal
    const badEvent: RuntimeAction = { entity: 'stage', event: 'BOGUS' };
    // Unknown entity — RuntimeActionEntity is a closed 4-value set.
    // @ts-expect-error — 'host' is not a canonical RuntimeAction entity
    const badEntity: RuntimeAction = { entity: 'host', event: 'PLAN' };
    // Cross-entity mismatch — PASS_CV is a slice event, not a stage event.
    // @ts-expect-error — PASS_CV is not a StageEvent
    const crossEntity: RuntimeAction = { entity: 'stage', event: 'PASS_CV' };
    // Cross-entity mismatch — PLAN is a stage event, not a slice event.
    // @ts-expect-error — PLAN is not a SliceEvent
    const slicePlan: RuntimeAction = { entity: 'slice', event: 'PLAN' };
    expect([badEvent, badEntity, crossEntity, slicePlan]).toHaveLength(4);
  });
});

describe('Reconciled state model (kernel canonical types)', () => {
  it('constructs a full ReconciledStageState from the package entry', () => {
    expect(STAGE_FIXTURE.stage_id).toBe('S02');
    expect(STAGE_FIXTURE.slices).toHaveLength(1);
    expect(STAGE_FIXTURE.slices[0].slice_id).toBe('S02-A');
    expect(STAGE_FIXTURE.slices[0].tasks).toHaveLength(1);
    expect(STAGE_FIXTURE.slices[0].tasks[0].checked).toBe(true);
    expect(STAGE_FIXTURE.slices[0].tasks[0].evidence_written).toBe(true);
    expect(STAGE_FIXTURE.slices[0].slice_state).toBe(SliceState.CV_IN_PROGRESS);
    expect(STAGE_FIXTURE.slices[0].cv_status).toBe(CVStatus.IN_PROGRESS);
    expect(STAGE_FIXTURE.stage_state).toBe(StageState.EXECUTING);
    expect(STAGE_FIXTURE.project_state).toBe(ProjectState.IN_PROGRESS);
    expect(STAGE_FIXTURE.receipt_chain).toEqual([]);
    expect(STAGE_FIXTURE.findings).toEqual([]);
  });

  it('uses kernel canonical enums — raw strings are rejected at the type level', () => {
    // @ts-expect-error — StageState is a canonical enum; open strings forbidden
    const openStage: ReconciledStageState = { ...STAGE_FIXTURE, stage_state: 'EXECUTING' };
    // @ts-expect-error — SliceState is a canonical enum; open strings forbidden
    const openSlice: ReconciledSliceState = { ...SLICE_A, slice_state: 'IN_PROGRESS' };
    // @ts-expect-error — CVStatus is a canonical enum; open strings forbidden
    const openCv: ReconciledSliceState = { ...SLICE_A, cv_status: 'IN_PROGRESS' };
    // @ts-expect-error — ProjectState is a canonical enum; open strings forbidden
    const openProject: ReconciledStageState = { ...STAGE_FIXTURE, project_state: 'IN_PROGRESS' };
    expect([openStage, openSlice, openCv, openProject]).toHaveLength(4);
  });

  it('exposes the entity dimension type', () => {
    const entities: readonly RuntimeActionEntity[] = [...RUNTIME_ACTION_ENTITIES];
    for (const entity of entities) {
      expect(['stage', 'slice', 'cv', 'project']).toContain(entity);
    }
  });
});
