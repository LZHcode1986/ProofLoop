/**
 * prepare-gate-facts — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Reconcile + git-clean check + HEAD + all-slices-integrated → writes the
 * Slice COMPLETE Facts JSON consumed by run-gate. Legacy-compatible
 * contract:
 *
 *   node packages/runtime/dist/cli/prepare-gate-facts.js <reconcile-input.json>
 *
 * Input (path-only, old ReconcileStageStateInput shape; camelCase aliases
 * accepted):
 *   { "stage_id": "S03", "project_root": ".", "manifest_path"?, "tasks_path"? }
 *
 * Gate preconditions (fail closed — any unmet precondition produces
 * `{ success: false, error }` and NO facts file):
 *  - the working tree is git-clean (`git status --porcelain` empty);
 *  - HEAD resolves;
 *  - every manifest slice is derived INTEGRATED by reconcile.
 *
 * Output facts file: `<projectRoot>/.proofloop/runtime/<stageId>/slice-complete-facts.json`
 * (array of `{ slice_id, integrated, committed, head_sha, git_clean }`,
 * written atomically via temp + rename). CLI stdout matches the legacy
 * shape `{ success: true, path }`.
 *
 * Zero host dependencies.
 */
export interface PrepareGateFactsInput {
    readonly stage_id: string;
    readonly project_root: string;
    readonly manifest_path?: string;
    readonly tasks_path?: string;
}
export interface SliceGateFact {
    readonly slice_id: string;
    readonly integrated: boolean;
    readonly committed: boolean;
    readonly head_sha: string;
    readonly git_clean: boolean;
}
export interface PrepareGateFactsOutput {
    readonly success: boolean;
    readonly path?: string;
    readonly facts?: readonly SliceGateFact[];
    readonly error?: string;
}
/**
 * Prepare the Slice COMPLETE Facts for a Stage Gate from reconciled stage
 * state (reconcile + git clean + HEAD + all slices integrated).
 *
 * @throws Error on any unmet gate precondition (no facts file is written).
 */
export declare function prepareGateFacts(input: PrepareGateFactsInput): PrepareGateFactsOutput;
/**
 * Legacy-compatible CLI:
 *   node dist/cli/prepare-gate-facts.js <reconcile-input.json>
 */
export declare function prepareGateFactsCli(argv: readonly string[]): number;
//# sourceMappingURL=prepare-gate-facts.d.ts.map