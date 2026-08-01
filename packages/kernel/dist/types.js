"use strict";
/**
 * @proofloop/kernel — Canonical Domain Type Definitions
 *
 * This file defines the canonical type surface exported by @proofloop/kernel.
 * Every type name, enum value, union literal, and interface field is specified
 * in the Contract & State Matrix (tech-spec/contract-state-matrix.md).
 *
 * §5 Canonical Type Registry — exact type names and ownership.
 * §6 State Machines — exact state enum values.
 * §4 File / Artifact Contracts — Receipt and Manifest shapes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectState = exports.CVStatus = exports.SliceState = exports.StageState = void 0;
// ============================================================
// 6. State Machines — Stage State
// ============================================================
/**
 * Stage lifecycle states.
 * See §6 Stage State Machine.
 */
var StageState;
(function (StageState) {
    StageState["UNINITIALIZED"] = "UNINITIALIZED";
    StageState["PLANNING"] = "PLANNING";
    StageState["READY"] = "READY";
    StageState["EXECUTING"] = "EXECUTING";
    StageState["UNDER_REVIEW"] = "UNDER_REVIEW";
    StageState["COMPLETED"] = "COMPLETED";
})(StageState || (exports.StageState = StageState = {}));
// ============================================================
// 6. State Machines — Slice State
// ============================================================
/**
 * Slice lifecycle states.
 * See §6 Slice State Machine.
 */
var SliceState;
(function (SliceState) {
    SliceState["PLANNED"] = "PLANNED";
    SliceState["IN_PROGRESS"] = "IN_PROGRESS";
    SliceState["READY_FOR_CV"] = "READY_FOR_CV";
    SliceState["CV_IN_PROGRESS"] = "CV_IN_PROGRESS";
    SliceState["CV_PASSED"] = "CV_PASSED";
    SliceState["INTEGRATING"] = "INTEGRATING";
    SliceState["INTEGRATED"] = "INTEGRATED";
})(SliceState || (exports.SliceState = SliceState = {}));
// ============================================================
// 6. State Machines — CV Status
// ============================================================
/**
 * Code Verification lifecycle status.
 * See §6 CV Status.
 */
var CVStatus;
(function (CVStatus) {
    CVStatus["NOT_STARTED"] = "NOT_STARTED";
    CVStatus["READY_FOR_CV"] = "READY_FOR_CV";
    CVStatus["IN_PROGRESS"] = "IN_PROGRESS";
    CVStatus["PASS"] = "PASS";
    CVStatus["REPAIR"] = "REPAIR";
    CVStatus["PENDING_RECHECK"] = "PENDING_RECHECK";
})(CVStatus || (exports.CVStatus = CVStatus = {}));
// ============================================================
// 6. State Machines — Project State (not in §5 but required by §6)
// ============================================================
/**
 * Project lifecycle states.
 * See §6 Project State Machine.
 */
var ProjectState;
(function (ProjectState) {
    ProjectState["IN_PROGRESS"] = "IN_PROGRESS";
    ProjectState["UNDER_REVIEW"] = "UNDER_REVIEW";
    ProjectState["COMPLETED"] = "COMPLETED";
    ProjectState["DEFERRED"] = "DEFERRED";
})(ProjectState || (exports.ProjectState = ProjectState = {}));
//# sourceMappingURL=types.js.map