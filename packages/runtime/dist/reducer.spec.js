"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runtime_1 = require("@proofloop/runtime");
const kernel_1 = require("@proofloop/kernel");
// ============================================================
// Fixtures
// ============================================================
function makeSlice(overrides = {}) {
    return {
        slice_id: 'S02-A',
        dependencies: [],
        tasks: [],
        slice_state: kernel_1.SliceState.CV_IN_PROGRESS,
        cv_status: kernel_1.CVStatus.IN_PROGRESS,
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
function makeStage(overrides = {}) {
    return {
        stage_id: 'S02',
        slices: [makeSlice()],
        stage_state: kernel_1.StageState.EXECUTING,
        project_state: kernel_1.ProjectState.IN_PROGRESS,
        receipt_chain: [],
        findings: [],
        ...overrides,
    };
}
// ============================================================
// Canonical kernel §6 legal transition tables (independent oracle)
// ============================================================
/** Stage legal rows: [from, event, to] — 8 rows incl. self-loop + repartition. */
const STAGE_LEGAL = [
    [kernel_1.StageState.UNINITIALIZED, 'PLAN', kernel_1.StageState.PLANNING],
    [kernel_1.StageState.PLANNING, 'FINALIZE_PLAN', kernel_1.StageState.READY],
    [kernel_1.StageState.READY, 'START', kernel_1.StageState.EXECUTING],
    [kernel_1.StageState.EXECUTING, 'PROGRESS', kernel_1.StageState.EXECUTING],
    [kernel_1.StageState.EXECUTING, 'SUBMIT_FOR_REVIEW', kernel_1.StageState.UNDER_REVIEW],
    [kernel_1.StageState.UNDER_REVIEW, 'REOPEN', kernel_1.StageState.EXECUTING],
    [kernel_1.StageState.UNDER_REVIEW, 'COMPLETE', kernel_1.StageState.COMPLETED],
    [kernel_1.StageState.COMPLETED, 'REPARTITION', kernel_1.StageState.EXECUTING],
];
/**
 * Slice legal rows: [fromSlice, fromCv, event, toSlice, toCv] — 7 rows.
 * The toCv column records the aggregate-consistent CVStatus after the action
 * (composite semantics per kernel §6; e.g. PASS_CV also advances cv PASS).
 */
const SLICE_LEGAL = [
    [kernel_1.SliceState.PLANNED, kernel_1.CVStatus.NOT_STARTED, 'START', kernel_1.SliceState.IN_PROGRESS, kernel_1.CVStatus.NOT_STARTED],
    [kernel_1.SliceState.IN_PROGRESS, kernel_1.CVStatus.NOT_STARTED, 'FINISH_TASKS', kernel_1.SliceState.READY_FOR_CV, kernel_1.CVStatus.READY_FOR_CV],
    [kernel_1.SliceState.READY_FOR_CV, kernel_1.CVStatus.READY_FOR_CV, 'RUN_CV', kernel_1.SliceState.CV_IN_PROGRESS, kernel_1.CVStatus.IN_PROGRESS],
    [kernel_1.SliceState.CV_IN_PROGRESS, kernel_1.CVStatus.IN_PROGRESS, 'REVISE', kernel_1.SliceState.READY_FOR_CV, kernel_1.CVStatus.REPAIR],
    [kernel_1.SliceState.CV_IN_PROGRESS, kernel_1.CVStatus.IN_PROGRESS, 'PASS_CV', kernel_1.SliceState.CV_PASSED, kernel_1.CVStatus.PASS],
    [kernel_1.SliceState.CV_PASSED, kernel_1.CVStatus.PASS, 'INTEGRATE', kernel_1.SliceState.INTEGRATING, kernel_1.CVStatus.PASS],
    [kernel_1.SliceState.INTEGRATING, kernel_1.CVStatus.PASS, 'FINISH_INTEGRATION', kernel_1.SliceState.INTEGRATED, kernel_1.CVStatus.PASS],
];
/** CV legal rows: [fromSlice, fromCv, event, toSlice, toCv] — 6 rows. */
const CV_LEGAL = [
    [kernel_1.SliceState.IN_PROGRESS, kernel_1.CVStatus.NOT_STARTED, 'MARK_READY', kernel_1.SliceState.READY_FOR_CV, kernel_1.CVStatus.READY_FOR_CV],
    [kernel_1.SliceState.READY_FOR_CV, kernel_1.CVStatus.READY_FOR_CV, 'START_CV', kernel_1.SliceState.CV_IN_PROGRESS, kernel_1.CVStatus.IN_PROGRESS],
    [kernel_1.SliceState.CV_IN_PROGRESS, kernel_1.CVStatus.IN_PROGRESS, 'PASS', kernel_1.SliceState.CV_PASSED, kernel_1.CVStatus.PASS],
    [kernel_1.SliceState.CV_IN_PROGRESS, kernel_1.CVStatus.IN_PROGRESS, 'REQUEST_REPAIR', kernel_1.SliceState.READY_FOR_CV, kernel_1.CVStatus.REPAIR],
    [kernel_1.SliceState.READY_FOR_CV, kernel_1.CVStatus.REPAIR, 'FIX', kernel_1.SliceState.READY_FOR_CV, kernel_1.CVStatus.PENDING_RECHECK],
    [kernel_1.SliceState.READY_FOR_CV, kernel_1.CVStatus.PENDING_RECHECK, 'RECHECK', kernel_1.SliceState.CV_IN_PROGRESS, kernel_1.CVStatus.IN_PROGRESS],
];
/** Project legal rows: [from, event, to] — 4 rows. */
const PROJECT_LEGAL = [
    [kernel_1.ProjectState.IN_PROGRESS, 'SUBMIT_FOR_REVIEW', kernel_1.ProjectState.UNDER_REVIEW],
    [kernel_1.ProjectState.UNDER_REVIEW, 'REOPEN', kernel_1.ProjectState.IN_PROGRESS],
    [kernel_1.ProjectState.UNDER_REVIEW, 'COMPLETE', kernel_1.ProjectState.COMPLETED],
    [kernel_1.ProjectState.DEFERRED, 'RESUME', kernel_1.ProjectState.IN_PROGRESS],
];
// ============================================================
// PO-S02-A-02 — legal transition rows (table-driven)
// ============================================================
(0, vitest_1.describe)('reducer — stage legal rows (PO-S02-A-02)', () => {
    (0, vitest_1.it)('covers exactly the 8 canonical stage rows', () => {
        (0, vitest_1.expect)(STAGE_LEGAL).toHaveLength(8);
    });
    for (const [from, event, to] of STAGE_LEGAL) {
        (0, vitest_1.it)(`stage ${from} --${event}--> ${to}`, () => {
            const state = makeStage({ stage_state: from });
            const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'stage', event });
            (0, vitest_1.expect)(next).not.toBe(state);
            (0, vitest_1.expect)(next.stage_state).toBe(to);
            // No other dimension changes; untouched arrays keep reference identity.
            (0, vitest_1.expect)(next.slices).toBe(state.slices);
            (0, vitest_1.expect)(next.project_state).toBe(state.project_state);
            (0, vitest_1.expect)(next.receipt_chain).toBe(state.receipt_chain);
            (0, vitest_1.expect)(next.findings).toBe(state.findings);
        });
    }
});
(0, vitest_1.describe)('reducer — slice legal rows (PO-S02-A-02)', () => {
    (0, vitest_1.it)('covers exactly the 7 canonical slice rows', () => {
        (0, vitest_1.expect)(SLICE_LEGAL).toHaveLength(7);
    });
    for (const [fromSlice, fromCv, event, toSlice, toCv] of SLICE_LEGAL) {
        (0, vitest_1.it)(`slice ${fromSlice} --${event}--> ${toSlice} (cv ${toCv})`, () => {
            const state = makeStage({
                slices: [makeSlice({ slice_state: fromSlice, cv_status: fromCv })],
            });
            const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'slice', event });
            (0, vitest_1.expect)(next).not.toBe(state);
            const slice = next.slices[0];
            (0, vitest_1.expect)(slice.slice_state).toBe(toSlice);
            (0, vitest_1.expect)(slice.cv_status).toBe(toCv);
            (0, vitest_1.expect)(slice.slice_id).toBe('S02-A');
            // Aggregate consistency: slice_state and cv_status reach the expected
            // pair (kernel §6 tables are the oracle).
            (0, vitest_1.expect)(next.stage_state).toBe(state.stage_state);
        });
    }
});
(0, vitest_1.describe)('reducer — CV legal rows (PO-S02-A-02)', () => {
    (0, vitest_1.it)('covers exactly the 6 canonical CV rows', () => {
        (0, vitest_1.expect)(CV_LEGAL).toHaveLength(6);
    });
    for (const [fromSlice, fromCv, event, toSlice, toCv] of CV_LEGAL) {
        (0, vitest_1.it)(`cv ${fromCv} --${event}--> ${toCv} (slice ${toSlice})`, () => {
            const state = makeStage({
                slices: [makeSlice({ slice_state: fromSlice, cv_status: fromCv })],
            });
            const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'cv', event });
            (0, vitest_1.expect)(next).not.toBe(state);
            const slice = next.slices[0];
            (0, vitest_1.expect)(slice.cv_status).toBe(toCv);
            (0, vitest_1.expect)(slice.slice_state).toBe(toSlice);
            (0, vitest_1.expect)(next.stage_state).toBe(state.stage_state);
        });
    }
});
(0, vitest_1.describe)('reducer — project legal rows (PO-S02-A-02)', () => {
    (0, vitest_1.it)('covers exactly the 4 canonical project rows', () => {
        (0, vitest_1.expect)(PROJECT_LEGAL).toHaveLength(4);
    });
    for (const [from, event, to] of PROJECT_LEGAL) {
        (0, vitest_1.it)(`project ${from} --${event}--> ${to}`, () => {
            const state = makeStage({ project_state: from });
            const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'project', event });
            (0, vitest_1.expect)(next).not.toBe(state);
            (0, vitest_1.expect)(next.project_state).toBe(to);
            (0, vitest_1.expect)(next.slices).toBe(state.slices);
            (0, vitest_1.expect)(next.stage_state).toBe(state.stage_state);
        });
    }
});
// ============================================================
// PO-S02-A-02 — composite action aggregate consistency
// ============================================================
(0, vitest_1.describe)('reducer — composite aggregate consistency (PO-S02-A-02)', () => {
    (0, vitest_1.it)('FINISH_TASKS advances slice IN_PROGRESS→READY_FOR_CV and cv NOT_STARTED→READY_FOR_CV', () => {
        const state = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.IN_PROGRESS, cv_status: kernel_1.CVStatus.NOT_STARTED })],
        });
        const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'slice', event: 'FINISH_TASKS' });
        (0, vitest_1.expect)(next.slices[0].slice_state).toBe(kernel_1.SliceState.READY_FOR_CV);
        (0, vitest_1.expect)(next.slices[0].cv_status).toBe(kernel_1.CVStatus.READY_FOR_CV);
    });
    (0, vitest_1.it)('RUN_CV advances slice READY_FOR_CV→CV_IN_PROGRESS and cv READY_FOR_CV→IN_PROGRESS (START_CV)', () => {
        const state = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.READY_FOR_CV })],
        });
        const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'slice', event: 'RUN_CV' });
        (0, vitest_1.expect)(next.slices[0].slice_state).toBe(kernel_1.SliceState.CV_IN_PROGRESS);
        (0, vitest_1.expect)(next.slices[0].cv_status).toBe(kernel_1.CVStatus.IN_PROGRESS);
    });
    (0, vitest_1.it)('RUN_CV with cv NOT_STARTED heals the cv side via MARK_READY then START_CV (PO-S02-E-03 dispatch branch)', () => {
        const state = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.NOT_STARTED })],
        });
        const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'slice', event: 'RUN_CV' });
        (0, vitest_1.expect)(next.slices[0].slice_state).toBe(kernel_1.SliceState.CV_IN_PROGRESS);
        (0, vitest_1.expect)(next.slices[0].cv_status).toBe(kernel_1.CVStatus.IN_PROGRESS);
    });
    (0, vitest_1.it)('RUN_CV with cv PENDING_RECHECK advances cv via RECHECK (recheck branch)', () => {
        const state = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.PENDING_RECHECK })],
        });
        const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'slice', event: 'RUN_CV' });
        (0, vitest_1.expect)(next.slices[0].slice_state).toBe(kernel_1.SliceState.CV_IN_PROGRESS);
        (0, vitest_1.expect)(next.slices[0].cv_status).toBe(kernel_1.CVStatus.IN_PROGRESS);
    });
    (0, vitest_1.it)('PASS_CV advances slice CV_IN_PROGRESS→CV_PASSED and cv IN_PROGRESS→PASS', () => {
        const state = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.CV_IN_PROGRESS, cv_status: kernel_1.CVStatus.IN_PROGRESS })],
        });
        const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'slice', event: 'PASS_CV' });
        (0, vitest_1.expect)(next.slices[0].slice_state).toBe(kernel_1.SliceState.CV_PASSED);
        (0, vitest_1.expect)(next.slices[0].cv_status).toBe(kernel_1.CVStatus.PASS);
    });
    (0, vitest_1.it)('REVISE advances slice CV_IN_PROGRESS→READY_FOR_CV and cv IN_PROGRESS→REPAIR (repair loop)', () => {
        const state = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.CV_IN_PROGRESS, cv_status: kernel_1.CVStatus.IN_PROGRESS })],
        });
        const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'slice', event: 'REVISE' });
        (0, vitest_1.expect)(next.slices[0].slice_state).toBe(kernel_1.SliceState.READY_FOR_CV);
        (0, vitest_1.expect)(next.slices[0].cv_status).toBe(kernel_1.CVStatus.REPAIR);
    });
    (0, vitest_1.it)('cv REQUEST_REPAIR produces the same aggregate as slice REVISE (symmetric pairing)', () => {
        const state = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.CV_IN_PROGRESS, cv_status: kernel_1.CVStatus.IN_PROGRESS })],
        });
        const viaSlice = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'slice', event: 'REVISE' });
        const viaCv = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'cv', event: 'REQUEST_REPAIR' });
        (0, vitest_1.expect)(viaSlice.slices[0].slice_state).toBe(kernel_1.SliceState.READY_FOR_CV);
        (0, vitest_1.expect)(viaSlice.slices[0].cv_status).toBe(kernel_1.CVStatus.REPAIR);
        (0, vitest_1.expect)(viaCv.slices[0]).toEqual(viaSlice.slices[0]);
    });
    (0, vitest_1.it)('full repair loop closes: FINISH_TASKS→RUN_CV→REVISE→FIX→RECHECK→PASS_CV ends at CV_PASSED/PASS', () => {
        let s = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.IN_PROGRESS, cv_status: kernel_1.CVStatus.NOT_STARTED })],
        });
        const steps = [
            { entity: 'slice', event: 'FINISH_TASKS' },
            { entity: 'slice', event: 'RUN_CV' },
            { entity: 'slice', event: 'REVISE' },
            { entity: 'cv', event: 'FIX' },
            { entity: 'cv', event: 'RECHECK' },
            { entity: 'slice', event: 'PASS_CV' },
        ];
        for (const step of steps)
            s = (0, runtime_1.reduceRuntimeAction)(s, step);
        (0, vitest_1.expect)(s.slices[0].slice_state).toBe(kernel_1.SliceState.CV_PASSED);
        (0, vitest_1.expect)(s.slices[0].cv_status).toBe(kernel_1.CVStatus.PASS);
    });
    (0, vitest_1.it)('happy path closes: FINISH_TASKS→RUN_CV→PASS_CV→INTEGRATE→FINISH_INTEGRATION ends at INTEGRATED/PASS', () => {
        let s = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.IN_PROGRESS, cv_status: kernel_1.CVStatus.NOT_STARTED })],
        });
        const steps = [
            { entity: 'slice', event: 'FINISH_TASKS' },
            { entity: 'slice', event: 'RUN_CV' },
            { entity: 'slice', event: 'PASS_CV' },
            { entity: 'slice', event: 'INTEGRATE' },
            { entity: 'slice', event: 'FINISH_INTEGRATION' },
        ];
        for (const step of steps)
            s = (0, runtime_1.reduceRuntimeAction)(s, step);
        (0, vitest_1.expect)(s.slices[0].slice_state).toBe(kernel_1.SliceState.INTEGRATED);
        (0, vitest_1.expect)(s.slices[0].cv_status).toBe(kernel_1.CVStatus.PASS);
    });
    (0, vitest_1.it)('FIX keeps the slice READY_FOR_CV while cv REPAIR→PENDING_RECHECK (consistent aggregate)', () => {
        const state = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.REPAIR })],
        });
        const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'cv', event: 'FIX' });
        (0, vitest_1.expect)(next.slices[0].slice_state).toBe(kernel_1.SliceState.READY_FOR_CV);
        (0, vitest_1.expect)(next.slices[0].cv_status).toBe(kernel_1.CVStatus.PENDING_RECHECK);
    });
});
const ILLEGAL_CASES = [
    // --- stage ---
    { name: 'stage PLAN at PLANNING', state: makeStage({ stage_state: kernel_1.StageState.PLANNING }), action: { entity: 'stage', event: 'PLAN' }, entityId: 'S02', fromState: 'PLANNING', toState: 'PLAN' },
    { name: 'stage FINALIZE_PLAN at READY', state: makeStage({ stage_state: kernel_1.StageState.READY }), action: { entity: 'stage', event: 'FINALIZE_PLAN' }, entityId: 'S02', fromState: 'READY', toState: 'FINALIZE_PLAN' },
    { name: 'stage START at PLANNING', state: makeStage({ stage_state: kernel_1.StageState.PLANNING }), action: { entity: 'stage', event: 'START' }, entityId: 'S02', fromState: 'PLANNING', toState: 'START' },
    { name: 'stage PROGRESS at READY', state: makeStage({ stage_state: kernel_1.StageState.READY }), action: { entity: 'stage', event: 'PROGRESS' }, entityId: 'S02', fromState: 'READY', toState: 'PROGRESS' },
    { name: 'stage SUBMIT_FOR_REVIEW at READY', state: makeStage({ stage_state: kernel_1.StageState.READY }), action: { entity: 'stage', event: 'SUBMIT_FOR_REVIEW' }, entityId: 'S02', fromState: 'READY', toState: 'SUBMIT_FOR_REVIEW' },
    { name: 'stage REOPEN at EXECUTING', state: makeStage({ stage_state: kernel_1.StageState.EXECUTING }), action: { entity: 'stage', event: 'REOPEN' }, entityId: 'S02', fromState: 'EXECUTING', toState: 'REOPEN' },
    { name: 'stage COMPLETE at EXECUTING', state: makeStage({ stage_state: kernel_1.StageState.EXECUTING }), action: { entity: 'stage', event: 'COMPLETE' }, entityId: 'S02', fromState: 'EXECUTING', toState: 'COMPLETE' },
    { name: 'stage REPARTITION at EXECUTING (non-COMPLETED)', state: makeStage({ stage_state: kernel_1.StageState.EXECUTING }), action: { entity: 'stage', event: 'REPARTITION' }, entityId: 'S02', fromState: 'EXECUTING', toState: 'REPARTITION' },
    { name: 'stage REPARTITION at UNINITIALIZED', state: makeStage({ stage_state: kernel_1.StageState.UNINITIALIZED }), action: { entity: 'stage', event: 'REPARTITION' }, entityId: 'S02', fromState: 'UNINITIALIZED', toState: 'REPARTITION' },
    // --- slice ---
    { name: 'slice START at IN_PROGRESS', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.IN_PROGRESS, cv_status: kernel_1.CVStatus.NOT_STARTED })] }), action: { entity: 'slice', event: 'START' }, entityId: 'S02-A', fromState: 'IN_PROGRESS', toState: 'START' },
    { name: 'slice FINISH_TASKS at PLANNED', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.PLANNED, cv_status: kernel_1.CVStatus.NOT_STARTED })] }), action: { entity: 'slice', event: 'FINISH_TASKS' }, entityId: 'S02-A', fromState: 'PLANNED', toState: 'FINISH_TASKS' },
    { name: 'slice RUN_CV at IN_PROGRESS', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.IN_PROGRESS, cv_status: kernel_1.CVStatus.NOT_STARTED })] }), action: { entity: 'slice', event: 'RUN_CV' }, entityId: 'S02-A', fromState: 'IN_PROGRESS', toState: 'RUN_CV' },
    { name: 'slice REVISE at READY_FOR_CV', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.READY_FOR_CV })] }), action: { entity: 'slice', event: 'REVISE' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'REVISE' },
    { name: 'slice PASS_CV at READY_FOR_CV', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.READY_FOR_CV })] }), action: { entity: 'slice', event: 'PASS_CV' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'PASS_CV' },
    { name: 'slice INTEGRATE at CV_IN_PROGRESS (before CV_PASSED)', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.CV_IN_PROGRESS, cv_status: kernel_1.CVStatus.IN_PROGRESS })] }), action: { entity: 'slice', event: 'INTEGRATE' }, entityId: 'S02-A', fromState: 'CV_IN_PROGRESS', toState: 'INTEGRATE' },
    { name: 'slice FINISH_INTEGRATION at CV_PASSED', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.CV_PASSED, cv_status: kernel_1.CVStatus.PASS })] }), action: { entity: 'slice', event: 'FINISH_INTEGRATION' }, entityId: 'S02-A', fromState: 'CV_PASSED', toState: 'FINISH_INTEGRATION' },
    { name: 'slice PASS_CV at CV_PASSED', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.CV_PASSED, cv_status: kernel_1.CVStatus.PASS })] }), action: { entity: 'slice', event: 'PASS_CV' }, entityId: 'S02-A', fromState: 'CV_PASSED', toState: 'PASS_CV' },
    { name: 'slice START at INTEGRATED (terminal)', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.INTEGRATED, cv_status: kernel_1.CVStatus.PASS })] }), action: { entity: 'slice', event: 'START' }, entityId: 'S02-A', fromState: 'INTEGRATED', toState: 'START' },
    { name: 'slice RUN_CV at CV_IN_PROGRESS', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.CV_IN_PROGRESS, cv_status: kernel_1.CVStatus.IN_PROGRESS })] }), action: { entity: 'slice', event: 'RUN_CV' }, entityId: 'S02-A', fromState: 'CV_IN_PROGRESS', toState: 'RUN_CV' },
    // --- cv ---
    { name: 'cv MARK_READY at READY_FOR_CV', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.READY_FOR_CV })] }), action: { entity: 'cv', event: 'MARK_READY' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'MARK_READY' },
    { name: 'cv START_CV at NOT_STARTED', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.PLANNED, cv_status: kernel_1.CVStatus.NOT_STARTED })] }), action: { entity: 'cv', event: 'START_CV' }, entityId: 'S02-A', fromState: 'NOT_STARTED', toState: 'START_CV' },
    { name: 'cv PASS at READY_FOR_CV', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.READY_FOR_CV })] }), action: { entity: 'cv', event: 'PASS' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'PASS' },
    { name: 'cv REQUEST_REPAIR at READY_FOR_CV', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.READY_FOR_CV })] }), action: { entity: 'cv', event: 'REQUEST_REPAIR' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'REQUEST_REPAIR' },
    { name: 'cv FIX at IN_PROGRESS', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.CV_IN_PROGRESS, cv_status: kernel_1.CVStatus.IN_PROGRESS })] }), action: { entity: 'cv', event: 'FIX' }, entityId: 'S02-A', fromState: 'IN_PROGRESS', toState: 'FIX' },
    { name: 'cv RECHECK at REPAIR', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.REPAIR })] }), action: { entity: 'cv', event: 'RECHECK' }, entityId: 'S02-A', fromState: 'REPAIR', toState: 'RECHECK' },
    { name: 'cv PASS at REPAIR', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.REPAIR })] }), action: { entity: 'cv', event: 'PASS' }, entityId: 'S02-A', fromState: 'REPAIR', toState: 'PASS' },
    // --- project ---
    { name: 'project SUBMIT_FOR_REVIEW at COMPLETED (terminal)', state: makeStage({ project_state: kernel_1.ProjectState.COMPLETED }), action: { entity: 'project', event: 'SUBMIT_FOR_REVIEW' }, entityId: 'S02', fromState: 'COMPLETED', toState: 'SUBMIT_FOR_REVIEW' },
    { name: 'project REOPEN at IN_PROGRESS', state: makeStage({ project_state: kernel_1.ProjectState.IN_PROGRESS }), action: { entity: 'project', event: 'REOPEN' }, entityId: 'S02', fromState: 'IN_PROGRESS', toState: 'REOPEN' },
    { name: 'project COMPLETE at IN_PROGRESS', state: makeStage({ project_state: kernel_1.ProjectState.IN_PROGRESS }), action: { entity: 'project', event: 'COMPLETE' }, entityId: 'S02', fromState: 'IN_PROGRESS', toState: 'COMPLETE' },
    { name: 'project RESUME at IN_PROGRESS', state: makeStage({ project_state: kernel_1.ProjectState.IN_PROGRESS }), action: { entity: 'project', event: 'RESUME' }, entityId: 'S02', fromState: 'IN_PROGRESS', toState: 'RESUME' },
    { name: 'project COMPLETE at DEFERRED', state: makeStage({ project_state: kernel_1.ProjectState.DEFERRED }), action: { entity: 'project', event: 'COMPLETE' }, entityId: 'S02', fromState: 'DEFERRED', toState: 'COMPLETE' },
    // --- composite failure on the cv side of a slice action (aggregate guard) ---
    { name: 'slice PASS_CV with cv NOT_STARTED (cv-side guard)', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.CV_IN_PROGRESS, cv_status: kernel_1.CVStatus.NOT_STARTED })] }), action: { entity: 'slice', event: 'PASS_CV' }, entityId: 'S02-A', fromState: 'NOT_STARTED', toState: 'PASS' },
    { name: 'slice RUN_CV with cv IN_PROGRESS (cv-side guard)', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.READY_FOR_CV, cv_status: kernel_1.CVStatus.IN_PROGRESS })] }), action: { entity: 'slice', event: 'RUN_CV' }, entityId: 'S02-A', fromState: 'IN_PROGRESS', toState: 'START_CV' },
    { name: 'slice FINISH_TASKS with cv READY_FOR_CV (cv-side guard)', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.IN_PROGRESS, cv_status: kernel_1.CVStatus.READY_FOR_CV })] }), action: { entity: 'slice', event: 'FINISH_TASKS' }, entityId: 'S02-A', fromState: 'READY_FOR_CV', toState: 'MARK_READY' },
    // --- no active slice ---
    { name: 'slice START with all slices INTEGRATED', state: makeStage({ slices: [makeSlice({ slice_state: kernel_1.SliceState.INTEGRATED, cv_status: kernel_1.CVStatus.PASS })] }), action: { entity: 'slice', event: 'START' }, entityId: 'S02-A', fromState: 'INTEGRATED', toState: 'START' },
];
(0, vitest_1.describe)('reducer — illegal combinations rejected (PO-S02-A-03)', () => {
    (0, vitest_1.it)('covers the required illegal examples from the PO', () => {
        const names = ILLEGAL_CASES.map(c => c.name);
        (0, vitest_1.expect)(names).toEqual(vitest_1.expect.arrayContaining([
            'slice INTEGRATE at CV_IN_PROGRESS (before CV_PASSED)',
            'slice PASS_CV at READY_FOR_CV',
            'stage COMPLETE at EXECUTING',
            'stage REPARTITION at EXECUTING (non-COMPLETED)',
        ]));
    });
    for (const c of ILLEGAL_CASES) {
        (0, vitest_1.it)(c.name, () => {
            (0, vitest_1.expect)(() => (0, runtime_1.reduceRuntimeAction)(c.state, c.action)).toThrow(kernel_1.InvalidTransitionError);
            let thrown;
            try {
                (0, runtime_1.reduceRuntimeAction)(c.state, c.action);
            }
            catch (err) {
                thrown = err;
            }
            (0, vitest_1.expect)(thrown).toBeInstanceOf(kernel_1.InvalidTransitionError);
            const err = thrown;
            (0, vitest_1.expect)(err.name).toBe('InvalidTransitionError');
            (0, vitest_1.expect)(err.entityId).toBe(c.entityId);
            (0, vitest_1.expect)(err.fromState).toBe(c.fromState);
            (0, vitest_1.expect)(err.toState).toBe(c.toState);
            (0, vitest_1.expect)(err.message.length).toBeGreaterThan(0);
        });
    }
    (0, vitest_1.it)('never silently ignores or normalizes an illegal action (input state untouched)', () => {
        const state = makeStage({ stage_state: kernel_1.StageState.EXECUTING });
        const snapshot = JSON.stringify(state);
        (0, vitest_1.expect)(() => (0, runtime_1.reduceRuntimeAction)(state, { entity: 'stage', event: 'COMPLETE' })).toThrow();
        (0, vitest_1.expect)(JSON.stringify(state)).toBe(snapshot);
    });
});
// ============================================================
// PO-S02-A-03 — unknown actions rejected at the schema layer
// ============================================================
(0, vitest_1.describe)('reducer — schema-layer rejection of unknown actions (PO-S02-A-03)', () => {
    const INVALID_ACTIONS = [
        ['unknown event literal', { entity: 'stage', event: 'BOGUS' }],
        ['unknown entity', { entity: 'host', event: 'PLAN' }],
        ['cross-entity mismatch (slice event on stage)', { entity: 'stage', event: 'PASS_CV' }],
        ['cross-entity mismatch (stage event on slice)', { entity: 'slice', event: 'PLAN' }],
        ['cv-only event on project', { entity: 'project', event: 'PASS' }],
        ['non-string event', { entity: 'stage', event: 42 }],
        ['missing event field', { entity: 'stage' }],
        ['missing entity field', { event: 'PLAN' }],
        ['non-object (string)', 'PLAN'],
        ['null', null],
    ];
    for (const [name, action] of INVALID_ACTIONS) {
        (0, vitest_1.it)(`rejects ${name}`, () => {
            const state = makeStage();
            (0, vitest_1.expect)(() => (0, runtime_1.reduceRuntimeAction)(state, action)).toThrow(kernel_1.SchemaValidationError);
            (0, vitest_1.expect)(() => (0, runtime_1.assertRuntimeAction)(action)).toThrow(kernel_1.SchemaValidationError);
        });
    }
    (0, vitest_1.it)('schema errors carry the canonical RUNTIME.SCHEMA_MISMATCH code and field errors', () => {
        try {
            (0, runtime_1.assertRuntimeAction)({ entity: 'stage', event: 'BOGUS' });
            vitest_1.expect.unreachable('should have thrown');
        }
        catch (err) {
            (0, vitest_1.expect)(err).toBeInstanceOf(kernel_1.SchemaValidationError);
            const e = err;
            (0, vitest_1.expect)(e.code).toBe('RUNTIME.SCHEMA_MISMATCH');
            (0, vitest_1.expect)(Array.isArray(e.fieldErrors)).toBe(true);
            (0, vitest_1.expect)(e.fieldErrors.length).toBeGreaterThan(0);
        }
    });
    (0, vitest_1.it)('assertRuntimeAction accepts every canonical entity-bound member', () => {
        const actions = [
            ...['PLAN', 'FINALIZE_PLAN', 'START', 'PROGRESS', 'SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'REPARTITION'].map(event => ({ entity: 'stage', event })),
            ...['START', 'FINISH_TASKS', 'RUN_CV', 'REVISE', 'PASS_CV', 'INTEGRATE', 'FINISH_INTEGRATION'].map(event => ({ entity: 'slice', event })),
            ...['MARK_READY', 'START_CV', 'PASS', 'REQUEST_REPAIR', 'FIX', 'RECHECK'].map(event => ({ entity: 'cv', event })),
            ...['SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'RESUME'].map(event => ({ entity: 'project', event })),
        ];
        (0, vitest_1.expect)(actions).toHaveLength(25);
        for (const action of actions) {
            (0, vitest_1.expect)(() => (0, runtime_1.assertRuntimeAction)(action)).not.toThrow();
        }
    });
});
// ============================================================
// Active-slice targeting & immutability
// ============================================================
(0, vitest_1.describe)('reducer — active slice targeting and immutability', () => {
    (0, vitest_1.it)('targets the first non-INTEGRATED slice in declaration order', () => {
        const sliceA = makeSlice({ slice_id: 'S02-A', slice_state: kernel_1.SliceState.INTEGRATED, cv_status: kernel_1.CVStatus.PASS });
        const sliceB = makeSlice({ slice_id: 'S02-B', slice_state: kernel_1.SliceState.PLANNED, cv_status: kernel_1.CVStatus.NOT_STARTED });
        const state = makeStage({ slices: [sliceA, sliceB] });
        const next = (0, runtime_1.reduceRuntimeAction)(state, { entity: 'slice', event: 'START' });
        (0, vitest_1.expect)(next.slices).toHaveLength(2);
        // Untouched INTEGRATED slice keeps reference identity.
        (0, vitest_1.expect)(next.slices[0]).toBe(sliceA);
        // The active slice is replaced with the advanced state.
        (0, vitest_1.expect)(next.slices[1]).not.toBe(sliceB);
        (0, vitest_1.expect)(next.slices[1].slice_state).toBe(kernel_1.SliceState.IN_PROGRESS);
        (0, vitest_1.expect)(next.slices[1].cv_status).toBe(kernel_1.CVStatus.NOT_STARTED);
    });
    (0, vitest_1.it)('does not mutate the input state (deep-frozen input stays intact)', () => {
        const state = makeStage({
            slices: [makeSlice({ slice_state: kernel_1.SliceState.CV_IN_PROGRESS, cv_status: kernel_1.CVStatus.IN_PROGRESS })],
        });
        const snapshot = JSON.parse(JSON.stringify(state));
        const frozen = Object.freeze(state);
        const next = (0, runtime_1.reduceRuntimeAction)(frozen, { entity: 'slice', event: 'PASS_CV' });
        // Input unchanged — a reducer that mutated in place would have thrown on
        // the frozen object (strict mode) or produced a different snapshot.
        (0, vitest_1.expect)(JSON.stringify(frozen)).toBe(JSON.stringify(snapshot));
        // Output is a fresh object graph — never the same references.
        (0, vitest_1.expect)(next).not.toBe(frozen);
        (0, vitest_1.expect)(next.slices).not.toBe(frozen.slices);
        (0, vitest_1.expect)(next.slices[0]).not.toBe(frozen.slices[0]);
        (0, vitest_1.expect)(next.slices[0].slice_state).toBe(kernel_1.SliceState.CV_PASSED);
        (0, vitest_1.expect)(next.slices[0].cv_status).toBe(kernel_1.CVStatus.PASS);
    });
});
//# sourceMappingURL=reducer.spec.js.map