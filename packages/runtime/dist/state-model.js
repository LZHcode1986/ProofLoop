"use strict";
/**
 * @proofloop/runtime — Normalized state model & closed-set RuntimeAction
 *
 * PO-S02-A-01: normalized runtime state model (ReconciledStageState /
 * ReconciledSliceState) and the closed-set RuntimeAction union, mapping 1:1
 * to the kernel §6 event groups (Stage 8 + Slice 7 + CV 6 + Project 4 = 21
 * distinct literals), with cross-entity same-name literals disambiguated by
 * entity binding.
 *
 * Types only — no behavior. The pure-function reducer (PO-S02-A-02/03/04)
 * and the deterministic stage derivation function deriveStageState
 * (PO-S02-A-05) belong to later tasks and consume these shapes.
 *
 * All state enums use kernel canonical types (StageState / SliceState /
 * CVStatus / ProjectState) — open strings are forbidden (§5 Canonical Type
 * Registry).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUNTIME_ACTION_ENTITIES = void 0;
// ============================================================
// RuntimeAction — closed-set event union (kernel §6)
// ============================================================
/**
 * Canonical entity bound to a RuntimeAction.
 *
 * The four kernel §6 state machines. Closed set — no other values.
 */
exports.RUNTIME_ACTION_ENTITIES = ['stage', 'slice', 'cv', 'project'];
//# sourceMappingURL=state-model.js.map