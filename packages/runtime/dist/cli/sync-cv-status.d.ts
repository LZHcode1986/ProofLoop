/**
 * sync-cv-status — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Reconcile → derive the current CV status of a slice (READ-ONLY — the CLI
 * never writes the evidence file; the Executor is the sole writer of
 * `## Current CV Status`). Legacy-compatible argument shape (file path or
 * inline `--json`):
 *
 *   node packages/runtime/dist/cli/sync-cv-status.js <options.json>
 *   node packages/runtime/dist/cli/sync-cv-status.js --json '<json>'
 *
 * Options (old field names `deliveryRoot`/`evidencePath` accepted as
 * aliases):
 *   { "stageId": "S03", "sliceId": "S03-H", "projectRoot": ".",
 *     "manifestPath"?, "tasksPath"? }
 *
 * Output JSON:
 *   { success, stage_id, slice_id, slice_state, cv_status, cv_level,
 *     latest_cv_receipt, repair_attempt, slice_evidence_finalized,
 *     evidence_file_present, open_finding, findings }
 *
 * Zero host dependencies.
 */
import type { Finding } from '@proofloop/kernel';
export interface SyncCvStatusOptions {
    readonly stageId: string;
    readonly sliceId: string;
    readonly projectRoot: string;
    readonly manifestPath?: string;
    readonly tasksPath?: string;
}
export interface SyncCvStatusOutput {
    readonly success: boolean;
    readonly error?: string;
    readonly stage_id?: string;
    readonly slice_id?: string;
    readonly slice_state?: string;
    readonly cv_status?: string;
    readonly cv_level?: string;
    readonly latest_cv_receipt?: {
        readonly type: string;
        readonly digest: string;
        readonly timestamp: string;
    } | null;
    readonly repair_attempt?: number;
    readonly slice_evidence_finalized?: boolean;
    readonly evidence_file_present?: boolean;
    readonly open_finding?: string | null;
    readonly findings?: readonly Finding[];
}
/**
 * Derive the CV status snapshot of a slice from reconciled persisted facts
 * (read-only — HP-003: every fact comes from the deterministic three-source
 * merge, never a guess).
 */
export declare function syncCvStatus(options: SyncCvStatusOptions): SyncCvStatusOutput;
/**
 * Legacy-compatible CLI:
 *   node dist/cli/sync-cv-status.js <options.json>
 *   node dist/cli/sync-cv-status.js --json '<json>'
 */
export declare function syncCvStatusCli(argv: readonly string[]): number;
//# sourceMappingURL=sync-cv-status.d.ts.map