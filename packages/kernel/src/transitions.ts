/**
 * @proofloop/kernel — State Machine Transition Functions
 *
 * Pure transition functions for Stage, Slice, CV, and Project state machines.
 * Each function accepts the current state and a typed event literal, returning
 * the resulting state for legal transitions and throwing InvalidTransitionError
 * for illegal transitions.
 *
 * §6 State Machines — transition tables are the exclusive oracle.
 */

import {
  StageState,
  SliceState,
  CVStatus,
  ProjectState,
} from './types';
import type {
  StageEvent,
  SliceEvent,
  CvEvent,
  ProjectEvent,
} from './types';
import { InvalidTransitionError } from './errors';

// ============================================================
// Private transition lookup tables
// ============================================================

/**
 * Stage transition map.
 *
 * Legal transitions (§6):
 *   UNINITIALIZED → PLAN                  → PLANNING
 *   PLANNING       → FINALIZE_PLAN        → READY
 *   READY          → START                → EXECUTING
 *   EXECUTING      → PROGRESS             → EXECUTING        (self-loop)
 *   EXECUTING      → SUBMIT_FOR_REVIEW    → UNDER_REVIEW
 *   UNDER_REVIEW   → REOPEN               → EXECUTING
 *   UNDER_REVIEW   → COMPLETE             → COMPLETED
 *   COMPLETED      → REPARTITION          → EXECUTING
 */
const STAGE_TRANSITIONS: Record<StageState, Partial<Record<StageEvent, StageState>>> = {
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

/**
 * Slice transition map.
 *
 * Legal transitions (§6):
 *   PLANNED          → START               → IN_PROGRESS
 *   IN_PROGRESS      → FINISH_TASKS        → READY_FOR_CV
 *   READY_FOR_CV     → RUN_CV              → CV_IN_PROGRESS
 *   CV_IN_PROGRESS   → REVISE              → READY_FOR_CV    (repair loop)
 *   CV_IN_PROGRESS   → PASS_CV             → CV_PASSED
 *   CV_PASSED        → INTEGRATE           → INTEGRATING
 *   INTEGRATING      → FINISH_INTEGRATION  → INTEGRATED      (terminal)
 */
const SLICE_TRANSITIONS: Record<SliceState, Partial<Record<SliceEvent, SliceState>>> = {
  [SliceState.PLANNED]: { START: SliceState.IN_PROGRESS },
  [SliceState.IN_PROGRESS]: { FINISH_TASKS: SliceState.READY_FOR_CV },
  [SliceState.READY_FOR_CV]: { RUN_CV: SliceState.CV_IN_PROGRESS },
  [SliceState.CV_IN_PROGRESS]: {
    REVISE: SliceState.READY_FOR_CV,
    PASS_CV: SliceState.CV_PASSED,
  },
  [SliceState.CV_PASSED]: { INTEGRATE: SliceState.INTEGRATING },
  [SliceState.INTEGRATING]: { FINISH_INTEGRATION: SliceState.INTEGRATED },
  [SliceState.INTEGRATED]: {}, // terminal — no outgoing transitions
};

/**
 * CV transition map.
 *
 * Legal transitions (§6):
 *   NOT_STARTED     → MARK_READY      → READY_FOR_CV
 *   READY_FOR_CV    → START_CV        → IN_PROGRESS
 *   IN_PROGRESS     → PASS            → PASS
 *   IN_PROGRESS     → REQUEST_REPAIR  → REPAIR
 *   REPAIR          → FIX             → PENDING_RECHECK
 *   PENDING_RECHECK → RECHECK         → IN_PROGRESS
 */
const CV_TRANSITIONS: Record<CVStatus, Partial<Record<CvEvent, CVStatus>>> = {
  [CVStatus.NOT_STARTED]: { MARK_READY: CVStatus.READY_FOR_CV },
  [CVStatus.READY_FOR_CV]: { START_CV: CVStatus.IN_PROGRESS },
  [CVStatus.IN_PROGRESS]: {
    PASS: CVStatus.PASS,
    REQUEST_REPAIR: CVStatus.REPAIR,
  },
  [CVStatus.PASS]: {}, // terminal — no outgoing transitions
  [CVStatus.REPAIR]: { FIX: CVStatus.PENDING_RECHECK },
  [CVStatus.PENDING_RECHECK]: { RECHECK: CVStatus.IN_PROGRESS },
};

/**
 * Project transition map.
 *
 * Legal transitions (§6):
 *   IN_PROGRESS    → SUBMIT_FOR_REVIEW → UNDER_REVIEW
 *   UNDER_REVIEW   → REOPEN            → IN_PROGRESS
 *   UNDER_REVIEW   → COMPLETE          → COMPLETED
 *   DEFERRED       → RESUME            → IN_PROGRESS
 *   COMPLETED is terminal — no outgoing transitions.
 */
const PROJECT_TRANSITIONS: Record<ProjectState, Partial<Record<ProjectEvent, ProjectState>>> = {
  [ProjectState.IN_PROGRESS]: { SUBMIT_FOR_REVIEW: ProjectState.UNDER_REVIEW },
  [ProjectState.UNDER_REVIEW]: {
    REOPEN: ProjectState.IN_PROGRESS,
    COMPLETE: ProjectState.COMPLETED,
  },
  [ProjectState.COMPLETED]: {}, // terminal — no outgoing transitions
  [ProjectState.DEFERRED]: { RESUME: ProjectState.IN_PROGRESS },
};

// ============================================================
// Public transition functions
// ============================================================

/**
 * Transition the Stage state machine.
 *
 * @param current - The current StageState value.
 * @param event   - The StageEvent triggering the transition.
 * @returns The resulting StageState for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
export function transitionStage(current: StageState, event: StageEvent): StageState {
  // Guard against non-string runtime values (objects with custom toString,
  // Symbols, null-prototype objects, undefined, numbers, etc.)
  if (typeof current !== 'string' || typeof event !== 'string') {
    throw new InvalidTransitionError(
      `Invalid Stage transition: arguments must be strings (got ${typeof current}, ${typeof event})`,
      'stage',
      typeof current,
      typeof event,
    );
  }
  // Guard against Object.prototype property injection on source state
  if (!Object.hasOwn(STAGE_TRANSITIONS, current)) {
    throw new InvalidTransitionError(
      `Invalid Stage transition from ${current} via ${event}`,
      'stage',
      current,
      event,
    );
  }
  const row = STAGE_TRANSITIONS[current];
  if (Object.hasOwn(row, event)) {
    return row[event as keyof typeof row]!;
  }
  throw new InvalidTransitionError(
    `Invalid Stage transition from ${current} via ${event}`,
    'stage',
    current,
    event,
  );
}

/**
 * Transition the Slice state machine.
 *
 * @param current - The current SliceState value.
 * @param event   - The SliceEvent triggering the transition.
 * @returns The resulting SliceState for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
export function transitionSlice(current: SliceState, event: SliceEvent): SliceState {
  // Guard against non-string runtime values
  if (typeof current !== 'string' || typeof event !== 'string') {
    throw new InvalidTransitionError(
      `Invalid Slice transition: arguments must be strings (got ${typeof current}, ${typeof event})`,
      'slice',
      typeof current,
      typeof event,
    );
  }
  // Guard against Object.prototype property injection on source state
  if (!Object.hasOwn(SLICE_TRANSITIONS, current)) {
    throw new InvalidTransitionError(
      `Invalid Slice transition from ${current} via ${event}`,
      'slice',
      current,
      event,
    );
  }
  const row = SLICE_TRANSITIONS[current];
  if (Object.hasOwn(row, event)) {
    return row[event as keyof typeof row]!;
  }
  throw new InvalidTransitionError(
    `Invalid Slice transition from ${current} via ${event}`,
    'slice',
    current,
    event,
  );
}

/**
 * Transition the CV status machine.
 *
 * @param current - The current CVStatus value.
 * @param event   - The CvEvent triggering the transition.
 * @returns The resulting CVStatus for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
export function transitionCv(current: CVStatus, event: CvEvent): CVStatus {
  // Guard against non-string runtime values
  if (typeof current !== 'string' || typeof event !== 'string') {
    throw new InvalidTransitionError(
      `Invalid CV transition: arguments must be strings (got ${typeof current}, ${typeof event})`,
      'cv',
      typeof current,
      typeof event,
    );
  }
  // Guard against Object.prototype property injection on source state
  if (!Object.hasOwn(CV_TRANSITIONS, current)) {
    throw new InvalidTransitionError(
      `Invalid CV transition from ${current} via ${event}`,
      'cv',
      current,
      event,
    );
  }
  const row = CV_TRANSITIONS[current];
  if (Object.hasOwn(row, event)) {
    return row[event as keyof typeof row]!;
  }
  throw new InvalidTransitionError(
    `Invalid CV transition from ${current} via ${event}`,
    'cv',
    current,
    event,
  );
}

/**
 * Transition the Project state machine.
 *
 * @param current - The current ProjectState value.
 * @param event   - The ProjectEvent triggering the transition.
 * @returns The resulting ProjectState for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
export function transitionProject(current: ProjectState, event: ProjectEvent): ProjectState {
  // Guard against non-string runtime values
  if (typeof current !== 'string' || typeof event !== 'string') {
    throw new InvalidTransitionError(
      `Invalid Project transition: arguments must be strings (got ${typeof current}, ${typeof event})`,
      'project',
      typeof current,
      typeof event,
    );
  }
  // Guard against Object.prototype property injection on source state
  if (!Object.hasOwn(PROJECT_TRANSITIONS, current)) {
    throw new InvalidTransitionError(
      `Invalid Project transition from ${current} via ${event}`,
      'project',
      current,
      event,
    );
  }
  const row = PROJECT_TRANSITIONS[current];
  if (Object.hasOwn(row, event)) {
    return row[event as keyof typeof row]!;
  }
  throw new InvalidTransitionError(
    `Invalid Project transition from ${current} via ${event}`,
    'project',
    current,
    event,
  );
}
