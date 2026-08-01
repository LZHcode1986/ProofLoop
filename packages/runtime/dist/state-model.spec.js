"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runtime_1 = require("@proofloop/runtime");
const kernel_1 = require("@proofloop/kernel");
// ============================================================
// Canonical kernel §6 event literal sets (independent oracle)
// ============================================================
const CANONICAL_STAGE_EVENTS = [
    'PLAN', 'FINALIZE_PLAN', 'START', 'PROGRESS',
    'SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'REPARTITION',
];
const CANONICAL_SLICE_EVENTS = [
    'START', 'FINISH_TASKS', 'RUN_CV', 'REVISE',
    'PASS_CV', 'INTEGRATE', 'FINISH_INTEGRATION',
];
const CANONICAL_CV_EVENTS = [
    'MARK_READY', 'START_CV', 'PASS', 'REQUEST_REPAIR', 'FIX', 'RECHECK',
];
const CANONICAL_PROJECT_EVENTS = [
    'SUBMIT_FOR_REVIEW', 'REOPEN', 'COMPLETE', 'RESUME',
];
/** Every canonical entity-bound action member (8 + 7 + 6 + 4 = 25). */
const ALL_CANONICAL_ACTIONS = [
    ...CANONICAL_STAGE_EVENTS.map(event => ({ entity: 'stage', event })),
    ...CANONICAL_SLICE_EVENTS.map(event => ({ entity: 'slice', event })),
    ...CANONICAL_CV_EVENTS.map(event => ({ entity: 'cv', event })),
    ...CANONICAL_PROJECT_EVENTS.map(event => ({ entity: 'project', event })),
];
/** Spec-local closed-set structural predicate (production schema check is T02). */
const VALID_EVENTS_BY_ENTITY = {
    stage: new Set(CANONICAL_STAGE_EVENTS),
    slice: new Set(CANONICAL_SLICE_EVENTS),
    cv: new Set(CANONICAL_CV_EVENTS),
    project: new Set(CANONICAL_PROJECT_EVENTS),
};
function isCanonicalAction(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    if (typeof v.entity !== 'string' || typeof v.event !== 'string')
        return false;
    const events = VALID_EVENTS_BY_ENTITY[v.entity];
    return events !== undefined && events.has(v.event);
}
// ============================================================
// Type-level fixture: ReconciledStageState with kernel canonical enums
// ============================================================
const SLICE_A = {
    slice_id: 'S02-A',
    dependencies: [],
    tasks: [
        { task_id: 'S02-A-T01', checked: true, evidence_written: true },
    ],
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
};
const STAGE_FIXTURE = {
    stage_id: 'S02',
    slices: [SLICE_A],
    stage_state: kernel_1.StageState.EXECUTING,
    project_state: kernel_1.ProjectState.IN_PROGRESS,
    receipt_chain: [],
    findings: [],
};
// ============================================================
// PO-S02-A-01 tests
// ============================================================
(0, vitest_1.describe)('RuntimeAction closed set', () => {
    (0, vitest_1.it)('exports the four canonical entities as a runtime closed set', () => {
        (0, vitest_1.expect)([...runtime_1.RUNTIME_ACTION_ENTITIES]).toEqual([
            'stage', 'slice', 'cv', 'project',
        ]);
    });
    (0, vitest_1.it)('maps to exactly 21 distinct kernel §6 event literals (8+7+6+4)', () => {
        (0, vitest_1.expect)(CANONICAL_STAGE_EVENTS).toHaveLength(8);
        (0, vitest_1.expect)(CANONICAL_SLICE_EVENTS).toHaveLength(7);
        (0, vitest_1.expect)(CANONICAL_CV_EVENTS).toHaveLength(6);
        (0, vitest_1.expect)(CANONICAL_PROJECT_EVENTS).toHaveLength(4);
        const all = new Set([
            ...CANONICAL_STAGE_EVENTS,
            ...CANONICAL_SLICE_EVENTS,
            ...CANONICAL_CV_EVENTS,
            ...CANONICAL_PROJECT_EVENTS,
        ]);
        // 25 raw members minus 4 cross-entity duplicates (START, SUBMIT_FOR_REVIEW,
        // REOPEN, COMPLETE) = 21 distinct literals.
        (0, vitest_1.expect)(all.size).toBe(21);
    });
    (0, vitest_1.it)('accepts every canonical entity-bound member (25 members, 21 literals)', () => {
        (0, vitest_1.expect)(ALL_CANONICAL_ACTIONS).toHaveLength(25);
        for (const action of ALL_CANONICAL_ACTIONS) {
            (0, vitest_1.expect)(isCanonicalAction(action)).toBe(true);
        }
    });
    (0, vitest_1.it)('disambiguates cross-entity same-name literals by entity binding', () => {
        // START: stage READY→EXECUTING vs slice PLANNED→IN_PROGRESS
        const stageStart = { entity: 'stage', event: 'START' };
        const sliceStart = { entity: 'slice', event: 'START' };
        (0, vitest_1.expect)(stageStart.entity).toBe('stage');
        (0, vitest_1.expect)(sliceStart.entity).toBe('slice');
        // SUBMIT_FOR_REVIEW: stage vs project
        const stageSfr = { entity: 'stage', event: 'SUBMIT_FOR_REVIEW' };
        const projectSfr = { entity: 'project', event: 'SUBMIT_FOR_REVIEW' };
        (0, vitest_1.expect)(stageSfr.entity).toBe('stage');
        (0, vitest_1.expect)(projectSfr.entity).toBe('project');
        // REOPEN: stage vs project
        const stageReopen = { entity: 'stage', event: 'REOPEN' };
        const projectReopen = { entity: 'project', event: 'REOPEN' };
        (0, vitest_1.expect)(stageReopen.entity).toBe('stage');
        (0, vitest_1.expect)(projectReopen.entity).toBe('project');
        // COMPLETE: stage vs project
        const stageComplete = { entity: 'stage', event: 'COMPLETE' };
        const projectComplete = { entity: 'project', event: 'COMPLETE' };
        (0, vitest_1.expect)(stageComplete.entity).toBe('stage');
        (0, vitest_1.expect)(projectComplete.entity).toBe('project');
    });
    (0, vitest_1.it)('rejects illegal values at runtime (closed set)', () => {
        (0, vitest_1.expect)(isCanonicalAction({ entity: 'stage', event: 'BOGUS' })).toBe(false);
        (0, vitest_1.expect)(isCanonicalAction({ entity: 'host', event: 'PLAN' })).toBe(false);
        (0, vitest_1.expect)(isCanonicalAction({ entity: 'stage', event: 'PASS_CV' })).toBe(false);
        (0, vitest_1.expect)(isCanonicalAction({ entity: 'slice', event: 'PLAN' })).toBe(false);
        (0, vitest_1.expect)(isCanonicalAction({ entity: 'cv', event: 'COMPLETE' })).toBe(false);
        (0, vitest_1.expect)(isCanonicalAction({ entity: 'stage' })).toBe(false);
        (0, vitest_1.expect)(isCanonicalAction({ entity: 'stage', event: 42 })).toBe(false);
        (0, vitest_1.expect)(isCanonicalAction(null)).toBe(false);
        (0, vitest_1.expect)(isCanonicalAction('PLAN')).toBe(false);
    });
    (0, vitest_1.it)('excludes illegal values at the type level', () => {
        // Unknown event literal — not in any kernel §6 group.
        // @ts-expect-error — 'BOGUS' is not a canonical kernel §6 event literal
        const badEvent = { entity: 'stage', event: 'BOGUS' };
        // Unknown entity — RuntimeActionEntity is a closed 4-value set.
        // @ts-expect-error — 'host' is not a canonical RuntimeAction entity
        const badEntity = { entity: 'host', event: 'PLAN' };
        // Cross-entity mismatch — PASS_CV is a slice event, not a stage event.
        // @ts-expect-error — PASS_CV is not a StageEvent
        const crossEntity = { entity: 'stage', event: 'PASS_CV' };
        // Cross-entity mismatch — PLAN is a stage event, not a slice event.
        // @ts-expect-error — PLAN is not a SliceEvent
        const slicePlan = { entity: 'slice', event: 'PLAN' };
        (0, vitest_1.expect)([badEvent, badEntity, crossEntity, slicePlan]).toHaveLength(4);
    });
});
(0, vitest_1.describe)('Reconciled state model (kernel canonical types)', () => {
    (0, vitest_1.it)('constructs a full ReconciledStageState from the package entry', () => {
        (0, vitest_1.expect)(STAGE_FIXTURE.stage_id).toBe('S02');
        (0, vitest_1.expect)(STAGE_FIXTURE.slices).toHaveLength(1);
        (0, vitest_1.expect)(STAGE_FIXTURE.slices[0].slice_id).toBe('S02-A');
        (0, vitest_1.expect)(STAGE_FIXTURE.slices[0].tasks).toHaveLength(1);
        (0, vitest_1.expect)(STAGE_FIXTURE.slices[0].tasks[0].checked).toBe(true);
        (0, vitest_1.expect)(STAGE_FIXTURE.slices[0].tasks[0].evidence_written).toBe(true);
        (0, vitest_1.expect)(STAGE_FIXTURE.slices[0].slice_state).toBe(kernel_1.SliceState.CV_IN_PROGRESS);
        (0, vitest_1.expect)(STAGE_FIXTURE.slices[0].cv_status).toBe(kernel_1.CVStatus.IN_PROGRESS);
        (0, vitest_1.expect)(STAGE_FIXTURE.stage_state).toBe(kernel_1.StageState.EXECUTING);
        (0, vitest_1.expect)(STAGE_FIXTURE.project_state).toBe(kernel_1.ProjectState.IN_PROGRESS);
        (0, vitest_1.expect)(STAGE_FIXTURE.receipt_chain).toEqual([]);
        (0, vitest_1.expect)(STAGE_FIXTURE.findings).toEqual([]);
    });
    (0, vitest_1.it)('uses kernel canonical enums — raw strings are rejected at the type level', () => {
        // @ts-expect-error — StageState is a canonical enum; open strings forbidden
        const openStage = { ...STAGE_FIXTURE, stage_state: 'EXECUTING' };
        // @ts-expect-error — SliceState is a canonical enum; open strings forbidden
        const openSlice = { ...SLICE_A, slice_state: 'IN_PROGRESS' };
        // @ts-expect-error — CVStatus is a canonical enum; open strings forbidden
        const openCv = { ...SLICE_A, cv_status: 'IN_PROGRESS' };
        // @ts-expect-error — ProjectState is a canonical enum; open strings forbidden
        const openProject = { ...STAGE_FIXTURE, project_state: 'IN_PROGRESS' };
        (0, vitest_1.expect)([openStage, openSlice, openCv, openProject]).toHaveLength(4);
    });
    (0, vitest_1.it)('exposes the entity dimension type', () => {
        const entities = [...runtime_1.RUNTIME_ACTION_ENTITIES];
        for (const entity of entities) {
            (0, vitest_1.expect)(['stage', 'slice', 'cv', 'project']).toContain(entity);
        }
    });
});
//# sourceMappingURL=state-model.spec.js.map