/**
 * validate-stage — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Planner mechanical gatekeeper over a Stage tasks.md (optionally against a
 * previously compiled manifest and an evidence directory). Legacy-compatible
 * contract:
 *
 *   node packages/runtime/dist/cli/validate-stage.js <tasks.md> <manifest.json> [evidence-dir]
 *
 * Checks (all fail closed — a stage is valid only when every check passes):
 *  1. the tasks.md compiles into a kernel-`validateManifest`-valid Manifest
 *     (the compile seam is the shared compile-manifest logic);
 *  2. SLICE:BEGIN/END marker structure (unclosed / orphaned regions);
 *  3. id uniqueness — slice ids, PO ids (in PO sections), task ids (in
 *     Tasks sections);
 *  4. dependency DAG — no cycles AND every declared dependency references a
 *     slice declared in the same Stage (Referencing Slices appear in the
 *     Stage Closure);
 *  5. PO fields declared-but-empty (Behavior / Oracle Source / Success /
 *     Failure / Required Observation);
 *  6. every task id occurrence in the file belongs to a slice Tasks section;
 *  7. optional provided-manifest cross-check: stage_id match, bidirectional
 *     slice-set equality, duplicate slice_id / evidence_path, canonical
 *     evidence_path pattern;
 *  8. optional evidence-dir existence check (missing / orphaned files).
 *
 * Output: JSON `{ valid, stage_id, errors }` on stdout; exit 0 / 1.
 *
 * Zero host dependencies: Node builtins + `@proofloop/kernel` +
 * package-internal modules only.
 */
export interface ValidationError {
    readonly type: string;
    readonly message: string;
    readonly sliceId?: string;
}
export interface ValidateStageResult {
    readonly valid: boolean;
    readonly stage_id: string;
    readonly errors: readonly ValidationError[];
}
/**
 * Run the Planner mechanical gatekeeper over a Stage tasks.md.
 *
 * @param tasksPath    tasks.md of the stage.
 * @param manifestPath optional previously compiled manifest to cross-check.
 * @param evidenceDir  optional evidence directory for existence checks.
 */
export declare function validateStage(tasksPath: string, manifestPath?: string, evidenceDir?: string): ValidateStageResult;
/**
 * Legacy-compatible CLI:
 *   node dist/cli/validate-stage.js <tasks.md> <manifest.json> [evidence-dir]
 */
export declare function validateStageCli(argv: readonly string[]): number;
//# sourceMappingURL=validate-stage.d.ts.map