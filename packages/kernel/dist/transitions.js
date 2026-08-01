"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.transitionStage = transitionStage;
exports.transitionSlice = transitionSlice;
exports.transitionCv = transitionCv;
exports.transitionProject = transitionProject;
const types_1 = require("./types");
const errors_1 = require("./errors");
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
const STAGE_TRANSITIONS = {
    [types_1.StageState.UNINITIALIZED]: { PLAN: types_1.StageState.PLANNING },
    [types_1.StageState.PLANNING]: { FINALIZE_PLAN: types_1.StageState.READY },
    [types_1.StageState.READY]: { START: types_1.StageState.EXECUTING },
    [types_1.StageState.EXECUTING]: {
        PROGRESS: types_1.StageState.EXECUTING,
        SUBMIT_FOR_REVIEW: types_1.StageState.UNDER_REVIEW,
    },
    [types_1.StageState.UNDER_REVIEW]: {
        REOPEN: types_1.StageState.EXECUTING,
        COMPLETE: types_1.StageState.COMPLETED,
    },
    [types_1.StageState.COMPLETED]: { REPARTITION: types_1.StageState.EXECUTING },
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
const SLICE_TRANSITIONS = {
    [types_1.SliceState.PLANNED]: { START: types_1.SliceState.IN_PROGRESS },
    [types_1.SliceState.IN_PROGRESS]: { FINISH_TASKS: types_1.SliceState.READY_FOR_CV },
    [types_1.SliceState.READY_FOR_CV]: { RUN_CV: types_1.SliceState.CV_IN_PROGRESS },
    [types_1.SliceState.CV_IN_PROGRESS]: {
        REVISE: types_1.SliceState.READY_FOR_CV,
        PASS_CV: types_1.SliceState.CV_PASSED,
    },
    [types_1.SliceState.CV_PASSED]: { INTEGRATE: types_1.SliceState.INTEGRATING },
    [types_1.SliceState.INTEGRATING]: { FINISH_INTEGRATION: types_1.SliceState.INTEGRATED },
    [types_1.SliceState.INTEGRATED]: {}, // terminal — no outgoing transitions
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
const CV_TRANSITIONS = {
    [types_1.CVStatus.NOT_STARTED]: { MARK_READY: types_1.CVStatus.READY_FOR_CV },
    [types_1.CVStatus.READY_FOR_CV]: { START_CV: types_1.CVStatus.IN_PROGRESS },
    [types_1.CVStatus.IN_PROGRESS]: {
        PASS: types_1.CVStatus.PASS,
        REQUEST_REPAIR: types_1.CVStatus.REPAIR,
    },
    [types_1.CVStatus.PASS]: {}, // terminal — no outgoing transitions
    [types_1.CVStatus.REPAIR]: { FIX: types_1.CVStatus.PENDING_RECHECK },
    [types_1.CVStatus.PENDING_RECHECK]: { RECHECK: types_1.CVStatus.IN_PROGRESS },
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
const PROJECT_TRANSITIONS = {
    [types_1.ProjectState.IN_PROGRESS]: { SUBMIT_FOR_REVIEW: types_1.ProjectState.UNDER_REVIEW },
    [types_1.ProjectState.UNDER_REVIEW]: {
        REOPEN: types_1.ProjectState.IN_PROGRESS,
        COMPLETE: types_1.ProjectState.COMPLETED,
    },
    [types_1.ProjectState.COMPLETED]: {}, // terminal — no outgoing transitions
    [types_1.ProjectState.DEFERRED]: { RESUME: types_1.ProjectState.IN_PROGRESS },
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
function transitionStage(current, event) {
    // Guard against non-string runtime values (objects with custom toString,
    // Symbols, null-prototype objects, undefined, numbers, etc.)
    if (typeof current !== 'string' || typeof event !== 'string') {
        throw new errors_1.InvalidTransitionError(`Invalid Stage transition: arguments must be strings (got ${typeof current}, ${typeof event})`, 'stage', typeof current, typeof event);
    }
    // Guard against Object.prototype property injection on source state
    if (!Object.hasOwn(STAGE_TRANSITIONS, current)) {
        throw new errors_1.InvalidTransitionError(`Invalid Stage transition from ${current} via ${event}`, 'stage', current, event);
    }
    const row = STAGE_TRANSITIONS[current];
    if (Object.hasOwn(row, event)) {
        return row[event];
    }
    throw new errors_1.InvalidTransitionError(`Invalid Stage transition from ${current} via ${event}`, 'stage', current, event);
}
/**
 * Transition the Slice state machine.
 *
 * @param current - The current SliceState value.
 * @param event   - The SliceEvent triggering the transition.
 * @returns The resulting SliceState for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
function transitionSlice(current, event) {
    // Guard against non-string runtime values
    if (typeof current !== 'string' || typeof event !== 'string') {
        throw new errors_1.InvalidTransitionError(`Invalid Slice transition: arguments must be strings (got ${typeof current}, ${typeof event})`, 'slice', typeof current, typeof event);
    }
    // Guard against Object.prototype property injection on source state
    if (!Object.hasOwn(SLICE_TRANSITIONS, current)) {
        throw new errors_1.InvalidTransitionError(`Invalid Slice transition from ${current} via ${event}`, 'slice', current, event);
    }
    const row = SLICE_TRANSITIONS[current];
    if (Object.hasOwn(row, event)) {
        return row[event];
    }
    throw new errors_1.InvalidTransitionError(`Invalid Slice transition from ${current} via ${event}`, 'slice', current, event);
}
/**
 * Transition the CV status machine.
 *
 * @param current - The current CVStatus value.
 * @param event   - The CvEvent triggering the transition.
 * @returns The resulting CVStatus for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
function transitionCv(current, event) {
    // Guard against non-string runtime values
    if (typeof current !== 'string' || typeof event !== 'string') {
        throw new errors_1.InvalidTransitionError(`Invalid CV transition: arguments must be strings (got ${typeof current}, ${typeof event})`, 'cv', typeof current, typeof event);
    }
    // Guard against Object.prototype property injection on source state
    if (!Object.hasOwn(CV_TRANSITIONS, current)) {
        throw new errors_1.InvalidTransitionError(`Invalid CV transition from ${current} via ${event}`, 'cv', current, event);
    }
    const row = CV_TRANSITIONS[current];
    if (Object.hasOwn(row, event)) {
        return row[event];
    }
    throw new errors_1.InvalidTransitionError(`Invalid CV transition from ${current} via ${event}`, 'cv', current, event);
}
/**
 * Transition the Project state machine.
 *
 * @param current - The current ProjectState value.
 * @param event   - The ProjectEvent triggering the transition.
 * @returns The resulting ProjectState for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
function transitionProject(current, event) {
    // Guard against non-string runtime values
    if (typeof current !== 'string' || typeof event !== 'string') {
        throw new errors_1.InvalidTransitionError(`Invalid Project transition: arguments must be strings (got ${typeof current}, ${typeof event})`, 'project', typeof current, typeof event);
    }
    // Guard against Object.prototype property injection on source state
    if (!Object.hasOwn(PROJECT_TRANSITIONS, current)) {
        throw new errors_1.InvalidTransitionError(`Invalid Project transition from ${current} via ${event}`, 'project', current, event);
    }
    const row = PROJECT_TRANSITIONS[current];
    if (Object.hasOwn(row, event)) {
        return row[event];
    }
    throw new errors_1.InvalidTransitionError(`Invalid Project transition from ${current} via ${event}`, 'project', current, event);
}
//# sourceMappingURL=transitions.js.map