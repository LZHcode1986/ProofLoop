/**
 * next-action — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Path-only input → `NextActionService` (the S02-D full Reconcile →
 * Validate → Reduce → Action pipeline). Legacy-compatible argument shape
 * (file path or inline `--json`):
 *
 *   node packages/runtime/dist/cli/next-action.js <input.json>
 *   node packages/runtime/dist/cli/next-action.js --json '<json>'
 *
 * Input (path-only; camelCase aliases accepted):
 *   { "stage_id": "S03", "project_root": ".", "manifest_path"?, "tasks_path"? }
 *
 * Output: the proofloop_next contract JSON
 *   { action, action_detail, responsible_role, receipt_chain_valid, findings }
 *
 * The CLI is a thin wrapper: it never reads the filesystem itself to derive
 * the action — derivation is exclusively the `NextActionService` (HP-003,
 * PO-S02-D-02/04). Zero host dependencies.
 */
import type { NextActionOutput } from '../next-action-service';
export interface NextActionCliInput {
    readonly stage_id?: string;
    readonly project_root?: string;
    readonly manifest_path?: string;
    readonly tasks_path?: string;
    readonly stageId?: string;
    readonly projectRoot?: string;
    readonly manifestPath?: string;
    readonly tasksPath?: string;
}
/**
 * Run the next-action pipeline from a path-only input JSON object.
 *
 * @throws TypeError when the required identity fields are missing.
 */
export declare function nextActionFromInput(raw: unknown): NextActionOutput;
/**
 * Legacy-compatible CLI:
 *   node dist/cli/next-action.js <input.json>
 *   node dist/cli/next-action.js --json '<json>'
 */
export declare function nextActionCli(argv: readonly string[]): number;
//# sourceMappingURL=next-action.d.ts.map