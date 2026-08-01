/**
 * validate-stage CLI — PO-S03-H-01 call matrix (S03-H-T01)
 *
 * Public seam: `packages/runtime/src/cli/validate-stage.ts` (+ dist script).
 * Planner mechanical gatekeeper over a Stage tasks.md (and optionally a
 * previously compiled manifest + an evidence directory), old-CLI contract:
 *
 *   node packages/runtime/dist/cli/validate-stage.js <tasks.md> <manifest.json> [evidence-dir]
 *
 * Gatekeeper checks:
 *  - the tasks.md compiles into a kernel-`validateManifest`-valid Manifest;
 *  - SLICE:BEGIN/END marker structure (unclosed / orphaned regions);
 *  - id uniqueness (slice / PO / task);
 *  - dependency DAG: no cycles AND every declared dependency exists in the
 *    Stage closure (Referencing Slices appear in the Stage Closure);
 *  - PO fields declared-but-empty (Behavior / Oracle Source / Success /
 *    Failure / Required Observation);
 *  - every task id occurrence belongs to a slice Tasks section;
 *  - optional compiled-manifest cross-check (stage_id, slice set, evidence
 *    paths) and optional evidence-dir existence checks.
 *
 * Output: JSON `{ valid, stage_id, errors: [{ type, message, sliceId? }] }`
 * on stdout; exit 0 valid / 1 invalid.
 */
export {};
//# sourceMappingURL=validate-stage.spec.d.ts.map