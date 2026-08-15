/**
 * @proofloop/runtime — Pure-function reducer
 *
 * PO-S02-A-02 / PO-S02-A-03:
 *   - For every legal RuntimeAction (entity-bound, 1:1 with the kernel §6
 *     event tables), the reducer advances the corresponding Stage/Slice/CV/
 *     Project state to the canonical target state and keeps the aggregate
 *     derived state consistent. Composite actions apply paired transitions:
 *       FINISH_TASKS        = transitionSlice(FINISH_TASKS) + transitionCv(MARK_READY)
 *       RUN_CV              = transitionSlice(RUN_CV) + cv → IN_PROGRESS
 *                            (cv side: START_CV when READY_FOR_CV; RECHECK when
 *                             PENDING_RECHECK; MARK_READY then START_CV when
 *                             NOT_STARTED — the cv_dispatched composite,
 *                             PO-S02-E-03)
 *       PASS_CV             = transitionSlice(PASS_CV) + transitionCv(PASS)
 *       REVISE              = transitionSlice(REVISE) + transitionCv(REQUEST_REPAIR)
 *       (symmetric for cv-entity actions: START_CV↔RUN_CV, PASS↔PASS_CV,
 *        REQUEST_REPAIR↔REVISE, MARK_READY↔FINISH_TASKS, RECHECK↔RUN_CV;
 *        FIX is cv-only — slice stays READY_FOR_CV, cv REPAIR→PENDING_RECHECK)
 *   - Any action the current state does not allow is rejected with the kernel
 *     InvalidTransitionError carrying the instance entityId plus fromState and
 *     toState; unknown actions (entity/event outside the closed RuntimeAction
 *     set) are rejected at the schema layer via assertRuntimeAction — never
 *     silently ignored or normalized.
 *
 * HP-005: the reducer is a pure function — no I/O, no timestamps, no
 * randomness, no global state. Only imports @proofloop/kernel and the
 * normalized state model types.
 *
 * Slice/CV actions deterministically target the **active slice**: the first
 * slice in declaration order whose slice_state is not INTEGRATED (terminal).
 * This mirrors the per-slice lifecycle progress order (HP-005 determinism);
 * all slices INTEGRATED ⇒ the action is rejected as an invalid transition.
 */

import {
  StageState,
  SliceState,
  CVStatus,
  ProjectState,
  transitionStage,
  transitionSlice,
  transitionCv,
  transitionProject,
  InvalidTransitionError,
  SchemaValidationError,
} from '@proofloop/kernel';
import type {
  StageEvent,
  SliceEvent,
  CvEvent,
  ProjectEvent,
} from '@proofloop/kernel';
import {
  RUNTIME_ACTION_ENTITIES,
  type RuntimeAction,
  type RuntimeActionEntity,
  type ReconciledSliceState,
  type ReconciledStageState,
} from './state-model';

// ============================================================
// Canonical event literal sets (kernel §6, validation table)
// ============================================================

/**
 * Canonical kernel §6 event literal sets per entity — the schema-layer closed
 * set. Values are the verbatim authority literals (Stage 8, Slice 7, CV 6,
 * Project 4). The RuntimeAction type itself still binds to the kernel
 * canonical event types (StageEvent/SliceEvent/CvEvent/ProjectEvent); this
 * table only drives the runtime schema check for JS callers.
 */
export const RUNTIME_ACTION_EVENTS: Readonly<Record<RuntimeActionEntity, readonly string[]>> = {
  stage: [
    'PLAN', 'FINALIZE_PLAN', 'START', 'PROGRESS',
    'SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'REPARTITION',
  ],
  slice: [
    'START', 'FINISH_TASKS', 'RUN_CV', 'REVISE',
    'PASS_CV', 'INTEGRATE', 'FINISH_INTEGRATION',
  ],
  cv: ['MARK_READY', 'START_CV', 'PASS', 'REQUEST_REPAIR', 'FIX', 'RECHECK'],
  project: ['SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'RESUME'],
};

// ============================================================
// Schema layer — closed-set RuntimeAction validation (PO-S02-A-03)
// ============================================================

/**
 * Reject any value that is not a canonical RuntimeAction member.
 *
 * Unknown entity / unknown event / non-object input throw
 * SchemaValidationError (canonical code RUNTIME.SCHEMA_MISMATCH) with
 * per-field errors. Unknown actions are rejected here — never silently
 * ignored or normalized.
 *
 * @throws SchemaValidationError when the value is not in the closed set.
 */
export function assertRuntimeAction(value: unknown): asserts value is RuntimeAction {
  if (typeof value !== 'object' || value === null) {
    throw new SchemaValidationError('Invalid RuntimeAction: expected a non-null object', [
      { path: 'action', message: 'RuntimeAction must be a non-null object' },
    ]);
  }
  const candidate = value as Record<string, unknown>;
  const { entity, event } = candidate;
  if (typeof entity !== 'string' || !(RUNTIME_ACTION_ENTITIES as readonly string[]).includes(entity)) {
    throw new SchemaValidationError(
      `Invalid RuntimeAction entity: ${JSON.stringify(entity)}`,
      [{ path: 'entity', message: 'entity must be one of stage | slice | cv | project' }],
    );
  }
  const entityEvents = RUNTIME_ACTION_EVENTS[entity as RuntimeActionEntity];
  if (typeof event !== 'string' || !entityEvents.includes(event)) {
    throw new SchemaValidationError(
      `Invalid ${String(entity)} RuntimeAction event: ${JSON.stringify(event)}`,
      [{ path: 'event', message: `event is not in the canonical ${String(entity)} event set` }],
    );
  }
}

// ============================================================
// Public reducer entrypoint
// ============================================================

/**
 * Apply a RuntimeAction to a ReconciledStageState, returning a new
 * ReconciledStageState (immutable update — the input is never mutated).
 *
 * @param state  - normalized stage state (Reconcile output).
 * @param action - closed-set RuntimeAction (kernel §6 event + entity binding).
 * @returns a new state with the corresponding entity advanced.
 * @throws InvalidTransitionError for actions the current state does not allow
 *         (entityId/fromState/toState populated with instance identifiers).
 * @throws SchemaValidationError for values outside the closed RuntimeAction set.
 */
export function reduceRuntimeAction(
  state: ReconciledStageState,
  action: RuntimeAction,
): ReconciledStageState {
  // Schema layer — reject unknown actions even when the caller bypassed the
  // type layer (PO-S02-A-03: never silently ignored or normalized).
  assertRuntimeAction(action);
  switch (action.entity) {
    case 'stage':
      return applyStageAction(state, action.event);
    case 'slice':
      return applySliceAction(state, action.event);
    case 'cv':
      return applyCvAction(state, action.event);
    case 'project':
      return applyProjectAction(state, action.event);
    default: {
      // Unreachable for valid RuntimeAction values (closed set); runtime guard
      // only — a JS caller bypassing the schema check never gets a silent no-op.
      throw new SchemaValidationError(
        `Unknown RuntimeAction entity: ${JSON.stringify(action)}`,
        [{ path: 'entity', message: 'entity is not in the closed RuntimeAction set' }],
      );
    }
  }
}

// ============================================================
// Per-entity application
// ============================================================

/** Stage actions advance only the stage state machine. */
function applyStageAction(state: ReconciledStageState, event: StageEvent): ReconciledStageState {
  const next = runWithEntityId(state.stage_id, () => transitionStage(state.stage_state, event));
  return { ...state, stage_state: next };
}

/**
 * Slice actions advance the active slice's slice_state and, for composite
 * events, keep the CVStatus aggregate consistent (kernel §6 tables as oracle).
 */
function applySliceAction(state: ReconciledStageState, event: SliceEvent): ReconciledStageState {
  const slice = selectActiveSlice(state, event);
  const nextSliceState = runWithEntityId(slice.slice_id, () => transitionSlice(slice.slice_state, event));
  let nextCvStatus: CVStatus = slice.cv_status;
  switch (event) {
    case 'FINISH_TASKS':
      nextCvStatus = runWithEntityId(slice.slice_id, () => transitionCv(slice.cv_status, 'MARK_READY'));
      break;
    case 'RUN_CV':
      nextCvStatus = advanceCvToInProgress(slice);
      break;
    case 'PASS_CV':
      nextCvStatus = runWithEntityId(slice.slice_id, () => transitionCv(slice.cv_status, 'PASS'));
      break;
    case 'REVISE':
      nextCvStatus = runWithEntityId(slice.slice_id, () => transitionCv(slice.cv_status, 'REQUEST_REPAIR'));
      break;
    default:
      // START / INTEGRATE / FINISH_INTEGRATION — no CV dimension change.
      break;
  }
  const updated: ReconciledSliceState = { ...slice, slice_state: nextSliceState, cv_status: nextCvStatus };
  return { ...state, slices: state.slices.map(s => (s.slice_id === slice.slice_id ? updated : s)) };
}

/**
 * CV actions advance the active slice's cv_status and, for composite events,
 * keep the slice_state aggregate consistent (symmetric pairing with the
 * slice-event composites).
 */
function applyCvAction(state: ReconciledStageState, event: CvEvent): ReconciledStageState {
  const slice = selectActiveSlice(state, event);
  const nextCvStatus = runWithEntityId(slice.slice_id, () => transitionCv(slice.cv_status, event));
  let nextSliceState: SliceState = slice.slice_state;
  switch (event) {
    case 'MARK_READY':
      nextSliceState = runWithEntityId(slice.slice_id, () => transitionSlice(slice.slice_state, 'FINISH_TASKS'));
      break;
    case 'START_CV':
      nextSliceState = runWithEntityId(slice.slice_id, () => transitionSlice(slice.slice_state, 'RUN_CV'));
      break;
    case 'PASS':
      nextSliceState = runWithEntityId(slice.slice_id, () => transitionSlice(slice.slice_state, 'PASS_CV'));
      break;
    case 'REQUEST_REPAIR':
      nextSliceState = runWithEntityId(slice.slice_id, () => transitionSlice(slice.slice_state, 'REVISE'));
      break;
    case 'RECHECK':
      // Recheck re-enters CV on the slice: cv PENDING_RECHECK→IN_PROGRESS and
      // slice READY_FOR_CV→CV_IN_PROGRESS so a later PASS_CV/REVISE is legal.
      nextSliceState = runWithEntityId(slice.slice_id, () => transitionSlice(slice.slice_state, 'RUN_CV'));
      break;
    default:
      // FIX — cv REPAIR→PENDING_RECHECK; the slice stays READY_FOR_CV
      // (READY_FOR_CV + PENDING_RECHECK is the consistent post-REVISE state).
      break;
  }
  const updated: ReconciledSliceState = { ...slice, slice_state: nextSliceState, cv_status: nextCvStatus };
  return { ...state, slices: state.slices.map(s => (s.slice_id === slice.slice_id ? updated : s)) };
}

/** Project actions advance only the project state machine. */
function applyProjectAction(state: ReconciledStageState, event: ProjectEvent): ReconciledStageState {
  // The project state is a property of the stage; the stage_id is the
  // instance identifier carried by InvalidTransitionError.
  const next = runWithEntityId(state.stage_id, () => transitionProject(state.project_state, event));
  return { ...state, project_state: next };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Run a kernel transition and rethrow InvalidTransitionError with the
 * instance entity id (stage_id / slice_id) instead of the generic entity
 * name the kernel uses internally. fromState/toState are preserved verbatim.
 */
function runWithEntityId<T>(entityId: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      throw new InvalidTransitionError(err.message, entityId, err.fromState, err.toState);
    }
    throw err;
  }
}

/**
 * The composite RUN_CV CV-side advance: cv must reach IN_PROGRESS, choosing
 * the kernel §6 path by the current CVStatus:
 *   READY_FOR_CV    → START_CV
 *   PENDING_RECHECK → RECHECK        (recheck branch, PO-S02-E-03)
 *   NOT_STARTED     → MARK_READY then START_CV
 *   IN_PROGRESS / PASS / REPAIR      → illegal (kernel throws)
 */
function advanceCvToInProgress(slice: ReconciledSliceState): CVStatus {
  const { cv_status } = slice;
  if (cv_status === CVStatus.READY_FOR_CV) {
    return runWithEntityId(slice.slice_id, () => transitionCv(cv_status, 'START_CV'));
  }
  if (cv_status === CVStatus.PENDING_RECHECK) {
    return runWithEntityId(slice.slice_id, () => transitionCv(cv_status, 'RECHECK'));
  }
  if (cv_status === CVStatus.NOT_STARTED) {
    const ready = runWithEntityId(slice.slice_id, () => transitionCv(cv_status, 'MARK_READY'));
    return runWithEntityId(slice.slice_id, () => transitionCv(ready, 'START_CV'));
  }
  // IN_PROGRESS / PASS / REPAIR — a fresh CV dispatch is illegal from here.
  return runWithEntityId(slice.slice_id, () => transitionCv(cv_status, 'START_CV'));
}

/**
 * Deterministic slice targeting: the first slice in declaration order whose
 * slice_state is not INTEGRATED (terminal). If every slice is INTEGRATED (or
 * the stage has no slices), the action is rejected as an invalid transition.
 */
function selectActiveSlice(state: ReconciledStageState, event: string): ReconciledSliceState {
  const active = state.slices.find(s => s.slice_state !== SliceState.INTEGRATED);
  if (active) return active;
  const first = state.slices[0];
  if (first) {
    throw new InvalidTransitionError(
      `Invalid Slice transition: all slices are INTEGRATED (cannot apply ${event})`,
      first.slice_id,
      first.slice_state,
      event,
    );
  }
  throw new InvalidTransitionError(
    `Invalid Slice transition: stage has no slices (cannot apply ${event})`,
    state.stage_id,
    StageState.UNINITIALIZED,
    event,
  );
}
