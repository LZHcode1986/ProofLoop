"use strict";
/**
 * deriveStageState — PO-S02-A-05
 *
 * Verifies the public `deriveStageState` seam of @proofloop/runtime: the
 * deterministic stage state derivation function (slice aggregate facts +
 * receipt presence summary → unique StageState).
 *
 * Mapping rules (authority — kernel §6 Stage State Machine + Slice PO-S02-A-05):
 *   - no STAGE_PLAN receipt            → UNINITIALIZED
 *   - STAGE_PLAN, no SPV_PASS          → PLANNING
 *   - SPV_PASS, some slice not
 *     integrated                       → EXECUTING (READY folded: the 12-type
 *                                        receipt closed set has no
 *                                        `stage_activated` receipt, so READY
 *                                        is a transient state that collapses
 *                                        into EXECUTING and is never derived)
 *   - all slices integrated, no
 *     STAGE_REVIEW_PASS                → UNDER_REVIEW
 *   - all slices integrated +
 *     STAGE_REVIEW_PASS                → COMPLETED
 *
 * Contradictory fact combinations (a receipt implies an upstream receipt
 * that is absent, or a receipt claims a stage state the slice facts cannot
 * support) are rejected with a structured `StageStateDerivationError`
 * carrying the conflicting facts (canonical §7 code DOMAIN.INVALID_TRANSITION)
 * — never a silent choice between two defensible states.
 *
 * Expected values are the authority mapping rules written as known-good
 * literals — not derived from the implementation.
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
        slice_state: kernel_1.SliceState.INTEGRATED,
        cv_status: kernel_1.CVStatus.PASS,
        slice_evidence_finalized: true,
        repair_attempt: 0,
        scope_check_passed: true,
        committed: true,
        integrated: true,
        complete: true,
        latest_cv_receipt: null,
        latest_commit_receipt: null,
        ...overrides,
    };
}
/** A slice that is NOT integrated (still executing). */
function unintegratedSlice(id = 'S02-A') {
    return makeSlice({
        slice_id: id,
        slice_state: kernel_1.SliceState.CV_IN_PROGRESS,
        cv_status: kernel_1.CVStatus.IN_PROGRESS,
        integrated: false,
        committed: false,
        complete: false,
    });
}
/** An integrated (fully completed) slice. */
function integratedSlice(id = 'S02-A') {
    return makeSlice({ slice_id: id, integrated: true });
}
const NO_RECEIPTS = {
    has_stage_plan: false,
    has_spv_pass: false,
    has_stage_review_pass: false,
};
const STAGE_PLAN_ONLY = {
    has_stage_plan: true,
    has_spv_pass: false,
    has_stage_review_pass: false,
};
const SPV_PASSED = {
    has_stage_plan: true,
    has_spv_pass: true,
    has_stage_review_pass: false,
};
const STAGE_REVIEWED = {
    has_stage_plan: true,
    has_spv_pass: true,
    has_stage_review_pass: true,
};
function derive(slices, receipts) {
    return (0, runtime_1.deriveStageState)({ slices, receipts });
}
// ============================================================
// Deterministic mapping — table-driven over each StageState
// ============================================================
(0, vitest_1.describe)('deriveStageState — deterministic fact→StageState mapping (PO-S02-A-05)', () => {
    const mappingTable = [
        {
            name: 'no receipts at all → UNINITIALIZED',
            slices: [unintegratedSlice()],
            receipts: NO_RECEIPTS,
            expected: kernel_1.StageState.UNINITIALIZED,
        },
        {
            name: 'no receipts and no slices → UNINITIALIZED',
            slices: [],
            receipts: NO_RECEIPTS,
            expected: kernel_1.StageState.UNINITIALIZED,
        },
        {
            name: 'STAGE_PLAN only → PLANNING (slice still unintegrated)',
            slices: [unintegratedSlice()],
            receipts: STAGE_PLAN_ONLY,
            expected: kernel_1.StageState.PLANNING,
        },
        {
            name: 'STAGE_PLAN only → PLANNING (deterministic even if a slice claims integrated)',
            slices: [integratedSlice()],
            receipts: STAGE_PLAN_ONLY,
            expected: kernel_1.StageState.PLANNING,
        },
        {
            name: 'SPV_PASS + slice not integrated → EXECUTING',
            slices: [unintegratedSlice()],
            receipts: SPV_PASSED,
            expected: kernel_1.StageState.EXECUTING,
        },
        {
            name: 'SPV_PASS + mixed integration (one integrated, one not) → EXECUTING',
            slices: [integratedSlice('S02-A'), unintegratedSlice('S02-B')],
            receipts: SPV_PASSED,
            expected: kernel_1.StageState.EXECUTING,
        },
        {
            name: 'SPV_PASS + zero slices → EXECUTING (no positive integration evidence)',
            slices: [],
            receipts: SPV_PASSED,
            expected: kernel_1.StageState.EXECUTING,
        },
        {
            name: 'all slices integrated + no STAGE_REVIEW_PASS → UNDER_REVIEW',
            slices: [integratedSlice('S02-A'), integratedSlice('S02-B')],
            receipts: SPV_PASSED,
            expected: kernel_1.StageState.UNDER_REVIEW,
        },
        {
            name: 'all slices integrated + STAGE_REVIEW_PASS → COMPLETED',
            slices: [integratedSlice('S02-A'), integratedSlice('S02-B')],
            receipts: STAGE_REVIEWED,
            expected: kernel_1.StageState.COMPLETED,
        },
    ];
    for (const row of mappingTable) {
        (0, vitest_1.it)(`maps "${row.name}" to ${row.expected}`, () => {
            (0, vitest_1.expect)(derive(row.slices, row.receipts)).toBe(row.expected);
        });
    }
});
// ============================================================
// READY folding rule (SPV_PASS → EXECUTING, never READY)
// ============================================================
(0, vitest_1.describe)('deriveStageState — READY folding counterexample (PO-S02-A-05)', () => {
    (0, vitest_1.it)('derives EXECUTING, not READY, when SPV_PASS exists with no activation receipt', () => {
        // Counterexample: the 12-type receipt closed set has no `stage_activated`
        // receipt, so after SPV_PASS the slice-level facts belong to EXECUTING
        // semantics. READY is a transient state that must be folded into
        // EXECUTING — it must never be derived from any fact combination.
        const result = derive([unintegratedSlice()], SPV_PASSED);
        (0, vitest_1.expect)(result).toBe(kernel_1.StageState.EXECUTING);
        (0, vitest_1.expect)(result).not.toBe(kernel_1.StageState.READY);
    });
    (0, vitest_1.it)('never derives READY for any row of the mapping table', () => {
        const allInputs = [
            { slices: [], receipts: NO_RECEIPTS },
            { slices: [unintegratedSlice()], receipts: NO_RECEIPTS },
            { slices: [unintegratedSlice()], receipts: STAGE_PLAN_ONLY },
            { slices: [integratedSlice()], receipts: STAGE_PLAN_ONLY },
            { slices: [unintegratedSlice()], receipts: SPV_PASSED },
            { slices: [integratedSlice(), unintegratedSlice('S02-B')], receipts: SPV_PASSED },
            { slices: [], receipts: SPV_PASSED },
            { slices: [integratedSlice(), integratedSlice('S02-B')], receipts: SPV_PASSED },
            { slices: [integratedSlice(), integratedSlice('S02-B')], receipts: STAGE_REVIEWED },
        ];
        for (const input of allInputs) {
            (0, vitest_1.expect)(derive(input.slices, input.receipts)).not.toBe(kernel_1.StageState.READY);
        }
    });
});
// ============================================================
// Contradictory fact combinations — structured rejection
// ============================================================
(0, vitest_1.describe)('deriveStageState — contradictory facts are rejected, never silently chosen (PO-S02-A-05)', () => {
    (0, vitest_1.it)('rejects SPV_PASS without STAGE_PLAN', () => {
        const input = {
            slices: [unintegratedSlice()],
            receipts: { has_stage_plan: false, has_spv_pass: true, has_stage_review_pass: false },
        };
        (0, vitest_1.expect)(() => (0, runtime_1.deriveStageState)(input)).toThrow(runtime_1.StageStateDerivationError);
    });
    (0, vitest_1.it)('rejects STAGE_REVIEW_PASS without STAGE_PLAN', () => {
        const input = {
            slices: [integratedSlice()],
            receipts: { has_stage_plan: false, has_spv_pass: true, has_stage_review_pass: true },
        };
        (0, vitest_1.expect)(() => (0, runtime_1.deriveStageState)(input)).toThrow(runtime_1.StageStateDerivationError);
    });
    (0, vitest_1.it)('rejects STAGE_REVIEW_PASS without SPV_PASS', () => {
        const input = {
            slices: [integratedSlice()],
            receipts: { has_stage_plan: true, has_spv_pass: false, has_stage_review_pass: true },
        };
        (0, vitest_1.expect)(() => (0, runtime_1.deriveStageState)(input)).toThrow(runtime_1.StageStateDerivationError);
    });
    (0, vitest_1.it)('rejects STAGE_REVIEW_PASS while a slice is still not integrated', () => {
        // Named contradiction case: COMPLETED (per STAGE_REVIEW_PASS) vs EXECUTING
        // (per SPV_PASS + non-integrated slice) — both defensible, neither chosen
        // silently. The error carries the conflicting facts.
        const input = {
            slices: [integratedSlice('S02-A'), unintegratedSlice('S02-B')],
            receipts: STAGE_REVIEWED,
        };
        let thrown;
        try {
            (0, runtime_1.deriveStageState)(input);
        }
        catch (err) {
            thrown = err;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(runtime_1.StageStateDerivationError);
        const err = thrown;
        (0, vitest_1.expect)(err.code).toBe('DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(err.unintegratedSliceIds).toEqual(['S02-B']);
        (0, vitest_1.expect)(err.receipts).toEqual(STAGE_REVIEWED);
        (0, vitest_1.expect)(err.message).toMatch(/STAGE_REVIEW_PASS/);
    });
    (0, vitest_1.it)('never falls back to a silent choice: every contradictory input throws', () => {
        const contradictoryInputs = [
            {
                slices: [],
                receipts: { has_stage_plan: false, has_spv_pass: true, has_stage_review_pass: false },
            },
            {
                slices: [],
                receipts: { has_stage_plan: false, has_spv_pass: false, has_stage_review_pass: true },
            },
            {
                slices: [],
                receipts: { has_stage_plan: true, has_spv_pass: false, has_stage_review_pass: true },
            },
            {
                slices: [unintegratedSlice('S02-B')],
                receipts: STAGE_REVIEWED,
            },
        ];
        for (const input of contradictoryInputs) {
            (0, vitest_1.expect)(() => (0, runtime_1.deriveStageState)(input)).toThrow(runtime_1.StageStateDerivationError);
        }
    });
});
// ============================================================
// Pure function — same input always yields the same output
// ============================================================
(0, vitest_1.describe)('deriveStageState — pure function determinism (PO-S02-A-05 / HP-005)', () => {
    (0, vitest_1.it)('returns the same StageState for repeated calls with the same input', () => {
        const input = {
            slices: [integratedSlice('S02-A'), unintegratedSlice('S02-B')],
            receipts: SPV_PASSED,
        };
        const first = (0, runtime_1.deriveStageState)(input);
        const second = (0, runtime_1.deriveStageState)(input);
        (0, vitest_1.expect)(first).toBe(second);
        (0, vitest_1.expect)(first).toBe(kernel_1.StageState.EXECUTING);
    });
    (0, vitest_1.it)('does not mutate the input slices or receipts', () => {
        const slice = unintegratedSlice('S02-A');
        const input = { slices: [slice], receipts: SPV_PASSED };
        const before = JSON.stringify(input);
        (0, runtime_1.deriveStageState)(input);
        (0, vitest_1.expect)(JSON.stringify(input)).toBe(before);
        (0, vitest_1.expect)(input.slices[0]).toBe(slice);
    });
});
//# sourceMappingURL=stage-state.spec.js.map