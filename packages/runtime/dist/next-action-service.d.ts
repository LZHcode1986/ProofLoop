/**
 * @proofloop/runtime — NextActionService: the full next-action pipeline
 * (S02-D-T02)
 *
 * `NextActionService` composes the S02-C Reconcile seam with the S02-D-T01
 * pure derivation into the single `nextAction` entry the proofloop_next tool
 * contract (§1 Tool Contracts) consumes:
 *
 *   input { projectRoot, stageId, manifestPath?, tasksPath? }
 *     → reconcileStage (three-source merge; any error-level inconsistency
 *       already lands as a canonical Finding, never a guess)
 *     → chain validation (receipt_chain_valid carried from the reconcile
 *       output — false blocks every execution action in the derive table)
 *     → NextActionExtras built from deterministic persisted facts:
 *         repartition_requested        — manifest canonical field (F-S02-08);
 *         gate_pass_present /
 *         gate_fail_present            — GATE_PASS / GATE_FAIL receipts read
 *                                        from the stage-gate category (facts
 *                                        only from a valid chain, PO-S02-C-03);
 *         evidence_file_present_by_slice — work-tree evidence-file existence
 *                                        per manifest evidence_path;
 *         pending_worker_result_envelopes — result envelopes pending admit in
 *                                        `.pi/proofloop-runtime/results/`
 *                                        (schema-validated, stage-bound);
 *     → deriveNextAction (the pure priority table — the same output the pure
 *       function produces on the same reconcile output)
 *     → wrap into the proofloop_next contract shape (findings capped at the
 *       documented 20-entry tool budget).
 *
 * Determinism (HP-003): every extra is a persisted fact read deterministically
 * (manifest file, sorted receipt dirs, sorted results dir); no timestamps, no
 * randomness, no cache, no process-internal state. The service holds no state
 * — a fresh instance reconciles from scratch, so a Session restart returns the
 * exact same action for the same fixture.
 */
import type { Finding, NextAction, RoleType } from '@proofloop/kernel';
/** Input to `NextActionService.nextAction` (path → reconcile seam). */
export interface NextActionServiceInput {
    /** Project root (must be the git root when the Git source is available). */
    readonly projectRoot: string;
    /** Stage id to reconcile. */
    readonly stageId: string;
    /** Custom manifest path (defaults to `.proofloop/manifests/<stage>.json`). */
    readonly manifestPath?: string;
    /** Custom tasks.md path (defaults to `delivery/stages/<stage>/tasks.md`). */
    readonly tasksPath?: string;
}
/**
 * proofloop_next-aligned output (§1 Tool Contracts):
 * `action` ∈ 15-value NextAction closed set, non-empty readable
 * `action_detail`, `responsible_role` ∈ 10-value RoleType closed set,
 * boolean `receipt_chain_valid`, `findings` ≤ 20 entries.
 */
export interface NextActionOutput {
    readonly action: NextAction;
    readonly action_detail: string;
    readonly responsible_role: RoleType;
    readonly receipt_chain_valid: boolean;
    readonly findings: Finding[];
}
/**
 * The full Reconcile → Validate → Reduce → Action pipeline.
 *
 * Stateless: every call re-reconciles from the persisted facts, so a fresh
 * instance (Session restart) returns the identical action for the same
 * fixture (HP-003).
 */
export declare class NextActionService {
    nextAction(input: NextActionServiceInput): NextActionOutput;
}
//# sourceMappingURL=next-action-service.d.ts.map