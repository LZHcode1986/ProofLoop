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
import { type RuntimeAction, type RuntimeActionEntity, type ReconciledStageState } from './state-model';
/**
 * Canonical kernel §6 event literal sets per entity — the schema-layer closed
 * set. Values are the verbatim authority literals (Stage 8, Slice 7, CV 6,
 * Project 4). The RuntimeAction type itself still binds to the kernel
 * canonical event types (StageEvent/SliceEvent/CvEvent/ProjectEvent); this
 * table only drives the runtime schema check for JS callers.
 */
export declare const RUNTIME_ACTION_EVENTS: Readonly<Record<RuntimeActionEntity, readonly string[]>>;
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
export declare function assertRuntimeAction(value: unknown): asserts value is RuntimeAction;
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
export declare function reduceRuntimeAction(state: ReconciledStageState, action: RuntimeAction): ReconciledStageState;
//# sourceMappingURL=reducer.d.ts.map