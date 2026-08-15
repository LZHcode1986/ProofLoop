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
 *     integrated                       → EXECUTING (READY folded: the canonical
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

import { describe, it, expect } from 'vitest';
import {
  deriveStageState,
  StageStateDerivationError,
  type StageReceiptSummary,
  type DeriveStageStateInput,
  type ReconciledSliceState,
} from '@proofloop/runtime';
import {
  StageState,
  SliceState,
  CVStatus,
} from '@proofloop/kernel';

// ============================================================
// Fixtures
// ============================================================

function makeSlice(overrides: Partial<ReconciledSliceState> = {}): ReconciledSliceState {
  return {
    slice_id: 'S02-A',
    dependencies: [],
    tasks: [],
    slice_state: SliceState.INTEGRATED,
    cv_status: CVStatus.PASS,
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
function unintegratedSlice(id = 'S02-A'): ReconciledSliceState {
  return makeSlice({
    slice_id: id,
    slice_state: SliceState.CV_IN_PROGRESS,
    cv_status: CVStatus.IN_PROGRESS,
    integrated: false,
    committed: false,
    complete: false,
  });
}

/** An integrated (fully completed) slice. */
function integratedSlice(id = 'S02-A'): ReconciledSliceState {
  return makeSlice({ slice_id: id, integrated: true });
}

const NO_RECEIPTS: StageReceiptSummary = {
  has_stage_plan: false,
  has_spv_pass: false,
  has_stage_review_pass: false,
};

const STAGE_PLAN_ONLY: StageReceiptSummary = {
  has_stage_plan: true,
  has_spv_pass: false,
  has_stage_review_pass: false,
};

const SPV_PASSED: StageReceiptSummary = {
  has_stage_plan: true,
  has_spv_pass: true,
  has_stage_review_pass: false,
};

const STAGE_REVIEWED: StageReceiptSummary = {
  has_stage_plan: true,
  has_spv_pass: true,
  has_stage_review_pass: true,
};

function derive(slices: readonly ReconciledSliceState[], receipts: StageReceiptSummary): StageState {
  return deriveStageState({ slices, receipts });
}

// ============================================================
// Deterministic mapping — table-driven over each StageState
// ============================================================

describe('deriveStageState — deterministic fact→StageState mapping (PO-S02-A-05)', () => {
  const mappingTable: ReadonlyArray<{
    readonly name: string;
    readonly slices: readonly ReconciledSliceState[];
    readonly receipts: StageReceiptSummary;
    readonly expected: StageState;
  }> = [
    {
      name: 'no receipts at all → UNINITIALIZED',
      slices: [unintegratedSlice()],
      receipts: NO_RECEIPTS,
      expected: StageState.UNINITIALIZED,
    },
    {
      name: 'no receipts and no slices → UNINITIALIZED',
      slices: [],
      receipts: NO_RECEIPTS,
      expected: StageState.UNINITIALIZED,
    },
    {
      name: 'STAGE_PLAN only → PLANNING (slice still unintegrated)',
      slices: [unintegratedSlice()],
      receipts: STAGE_PLAN_ONLY,
      expected: StageState.PLANNING,
    },
    {
      name: 'STAGE_PLAN only → PLANNING (deterministic even if a slice claims integrated)',
      slices: [integratedSlice()],
      receipts: STAGE_PLAN_ONLY,
      expected: StageState.PLANNING,
    },
    {
      name: 'SPV_PASS + slice not integrated → EXECUTING',
      slices: [unintegratedSlice()],
      receipts: SPV_PASSED,
      expected: StageState.EXECUTING,
    },
    {
      name: 'SPV_PASS + mixed integration (one integrated, one not) → EXECUTING',
      slices: [integratedSlice('S02-A'), unintegratedSlice('S02-B')],
      receipts: SPV_PASSED,
      expected: StageState.EXECUTING,
    },
    {
      name: 'SPV_PASS + zero slices → EXECUTING (no positive integration evidence)',
      slices: [],
      receipts: SPV_PASSED,
      expected: StageState.EXECUTING,
    },
    {
      name: 'all slices integrated + no STAGE_REVIEW_PASS → UNDER_REVIEW',
      slices: [integratedSlice('S02-A'), integratedSlice('S02-B')],
      receipts: SPV_PASSED,
      expected: StageState.UNDER_REVIEW,
    },
    {
      name: 'all slices integrated + STAGE_REVIEW_PASS → COMPLETED',
      slices: [integratedSlice('S02-A'), integratedSlice('S02-B')],
      receipts: STAGE_REVIEWED,
      expected: StageState.COMPLETED,
    },
  ];

  for (const row of mappingTable) {
    it(`maps "${row.name}" to ${row.expected}`, () => {
      expect(derive(row.slices, row.receipts)).toBe(row.expected);
    });
  }
});

// ============================================================
// READY folding rule (SPV_PASS → EXECUTING, never READY)
// ============================================================

describe('deriveStageState — READY folding counterexample (PO-S02-A-05)', () => {
  it('derives EXECUTING, not READY, when SPV_PASS exists with no activation receipt', () => {
    // Counterexample: the canonical receipt closed set has no `stage_activated`
    // receipt, so after SPV_PASS the slice-level facts belong to EXECUTING
    // semantics. READY is a transient state that must be folded into
    // EXECUTING — it must never be derived from any fact combination.
    const result = derive([unintegratedSlice()], SPV_PASSED);
    expect(result).toBe(StageState.EXECUTING);
    expect(result).not.toBe(StageState.READY);
  });

  it('never derives READY for any row of the mapping table', () => {
    const allInputs: readonly { slices: readonly ReconciledSliceState[]; receipts: StageReceiptSummary }[] = [
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
      expect(derive(input.slices, input.receipts)).not.toBe(StageState.READY);
    }
  });
});

// ============================================================
// Contradictory fact combinations — structured rejection
// ============================================================

describe('deriveStageState — contradictory facts are rejected, never silently chosen (PO-S02-A-05)', () => {
  it('rejects SPV_PASS without STAGE_PLAN', () => {
    const input: DeriveStageStateInput = {
      slices: [unintegratedSlice()],
      receipts: { has_stage_plan: false, has_spv_pass: true, has_stage_review_pass: false },
    };
    expect(() => deriveStageState(input)).toThrow(StageStateDerivationError);
  });

  it('rejects STAGE_REVIEW_PASS without STAGE_PLAN', () => {
    const input: DeriveStageStateInput = {
      slices: [integratedSlice()],
      receipts: { has_stage_plan: false, has_spv_pass: true, has_stage_review_pass: true },
    };
    expect(() => deriveStageState(input)).toThrow(StageStateDerivationError);
  });

  it('rejects STAGE_REVIEW_PASS without SPV_PASS', () => {
    const input: DeriveStageStateInput = {
      slices: [integratedSlice()],
      receipts: { has_stage_plan: true, has_spv_pass: false, has_stage_review_pass: true },
    };
    expect(() => deriveStageState(input)).toThrow(StageStateDerivationError);
  });

  it('rejects STAGE_REVIEW_PASS while a slice is still not integrated', () => {
    // Named contradiction case: COMPLETED (per STAGE_REVIEW_PASS) vs EXECUTING
    // (per SPV_PASS + non-integrated slice) — both defensible, neither chosen
    // silently. The error carries the conflicting facts.
    const input: DeriveStageStateInput = {
      slices: [integratedSlice('S02-A'), unintegratedSlice('S02-B')],
      receipts: STAGE_REVIEWED,
    };
    let thrown: unknown;
    try {
      deriveStageState(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StageStateDerivationError);
    const err = thrown as StageStateDerivationError;
    expect(err.code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(err.unintegratedSliceIds).toEqual(['S02-B']);
    expect(err.receipts).toEqual(STAGE_REVIEWED);
    expect(err.message).toMatch(/STAGE_REVIEW_PASS/);
  });

  it('never falls back to a silent choice: every contradictory input throws', () => {
    const contradictoryInputs: readonly DeriveStageStateInput[] = [
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
      expect(() => deriveStageState(input)).toThrow(StageStateDerivationError);
    }
  });
});

// ============================================================
// Pure function — same input always yields the same output
// ============================================================

describe('deriveStageState — pure function determinism (PO-S02-A-05 / HP-005)', () => {
  it('returns the same StageState for repeated calls with the same input', () => {
    const input: DeriveStageStateInput = {
      slices: [integratedSlice('S02-A'), unintegratedSlice('S02-B')],
      receipts: SPV_PASSED,
    };
    const first = deriveStageState(input);
    const second = deriveStageState(input);
    expect(first).toBe(second);
    expect(first).toBe(StageState.EXECUTING);
  });

  it('does not mutate the input slices or receipts', () => {
    const slice = unintegratedSlice('S02-A');
    const input: DeriveStageStateInput = { slices: [slice], receipts: SPV_PASSED };
    const before = JSON.stringify(input);
    deriveStageState(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(input.slices[0]).toBe(slice);
  });
});
