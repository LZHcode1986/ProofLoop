/**
 * run-gate — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Stage Gate execution, minimal version (HP-004: per-step timeout +
 * exit-code checks; no cancellation / process-tree cleanup /
 * GATE_INTERRUPTED — those are S04/AWI-015). Legacy-compatible contract:
 *
 *   node packages/runtime/dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]
 *
 * Flow:
 *  1. load + kernel-validate the manifest;
 *  2. load the Slice COMPLETE Facts (JSON array) — every manifest slice must
 *     carry a fact with `integrated: true`; facts for undeclared slices are
 *     refused (stale-fact guard);
 *  3. execute the manifest `runtime_proof` steps: `command`/`probe` steps run
 *     synchronously with per-step timeout and `expected.exit_code` check
 *     (absent expected → 0; `exit_code: null` → any exit accepted);
 *     `not_applicable` steps are skipped; `service_start`/`service_stop`
 *     steps that are NOT marked not_applicable fail the gate (service
 *     lifecycle execution is deferred to S04 — honest fail-closed);
 *  4. write the gate result JSON to `<output-dir>/gate-result.json`
 *     (default `<projectRoot>/.proofloop/runtime/<stageId>/`).
 *
 * Output: JSON `{ success, gate, stage_id, steps, errors, output_path }`;
 * exit 0 on PASS / 1 on FAIL. The GATE_PASS/GATE_FAIL Receipt is written by
 * the unified admit pipeline (S03-H-T02 `admitGateResult`) — run-gate never
 * writes receipts itself.
 *
 * Zero host dependencies.
 */
export interface RunGateInput {
    readonly manifestPath: string;
    readonly factsPath: string;
    readonly outputDir?: string;
    readonly projectRoot?: string;
}
export interface GateStepResult {
    readonly id: string;
    readonly type: string;
    readonly exit_code: number | null;
    readonly passed: boolean;
    readonly skipped?: boolean;
    readonly error?: string;
}
export interface RunGateResult {
    readonly success: boolean;
    readonly gate: 'PASS' | 'FAIL';
    readonly stage_id: string;
    readonly steps: readonly GateStepResult[];
    readonly errors: readonly string[];
    readonly output_path?: string;
}
/**
 * Run the Stage Gate (minimal version) over a manifest + Slice COMPLETE
 * facts, executing the manifest runtime_proof steps with per-step timeout
 * and exit-code checks.
 */
export declare function runGate(input: RunGateInput): RunGateResult;
/**
 * Legacy-compatible CLI:
 *   node dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]
 */
export declare function runGateCli(argv: readonly string[]): number;
//# sourceMappingURL=run-gate.d.ts.map