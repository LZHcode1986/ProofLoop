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
import { StageState, SliceState, CVStatus, ProjectState } from './types';
import type { StageEvent, SliceEvent, CvEvent, ProjectEvent } from './types';
/**
 * Transition the Stage state machine.
 *
 * @param current - The current StageState value.
 * @param event   - The StageEvent triggering the transition.
 * @returns The resulting StageState for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
export declare function transitionStage(current: StageState, event: StageEvent): StageState;
/**
 * Transition the Slice state machine.
 *
 * @param current - The current SliceState value.
 * @param event   - The SliceEvent triggering the transition.
 * @returns The resulting SliceState for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
export declare function transitionSlice(current: SliceState, event: SliceEvent): SliceState;
/**
 * Transition the CV status machine.
 *
 * @param current - The current CVStatus value.
 * @param event   - The CvEvent triggering the transition.
 * @returns The resulting CVStatus for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
export declare function transitionCv(current: CVStatus, event: CvEvent): CVStatus;
/**
 * Transition the Project state machine.
 *
 * @param current - The current ProjectState value.
 * @param event   - The ProjectEvent triggering the transition.
 * @returns The resulting ProjectState for legal transitions.
 * @throws InvalidTransitionError if the transition is not in the legal table.
 */
export declare function transitionProject(current: ProjectState, event: ProjectEvent): ProjectState;
//# sourceMappingURL=transitions.d.ts.map