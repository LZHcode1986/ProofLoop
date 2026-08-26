/**
 * S13-S17 remediation Phase 4 — vNext public route table (CV repair R2 #2).
 *
 * Single acyclic fact source mapping every derived Stage-composition chain
 * step's `public_operation` onto the closed public CLI route that serves it:
 * the domain dispatcher (handler), the Runtime admission consumer seam and
 * the consumer's request/payload schema seam.
 *
 * This module is DATA ONLY — it imports no dispatcher, so both the Stage
 * Composition Closure Audit (which runs inside the next.ts dependency graph
 * via Stage Plan admission) and the top-level `proofloopCli` wiring tests can
 * consume the SAME table without closing a load cycle.  Its truthfulness is
 * proven behaviourally by the top-level CLI smoke matrix: for every row, a
 * real `proofloop <domain> <operation>` invocation must reach the mapped
 * handler/consumer schema seam (never RUNTIME.NOT_IMPLEMENTED/USAGE).
 */

/** One closed public-route wiring row. */
export interface VNextRouteTableEntry {
  /** `<domain> <operation>` exactly as registered in DOMAIN_REGISTRY. */
  readonly operation: string;
  /** Exported domain dispatcher that owns this operation. */
  readonly handler: string;
  /** Runtime admission/dispatch consumer seam the producer reaches. */
  readonly consumer: string;
  /** Closed request/payload schema seam enforced before admission. */
  readonly schema_seam: string;
}

/**
 * The derived per-Slice + Stage-tail chain covers exactly these operations.
 * Rows are keyed by `operation`; unknown operations fail closed in the audit.
 */
export const VNEXT_ROUTE_TABLE: readonly VNextRouteTableEntry[] = [
  {
    operation: 'stage next',
    handler: 'runStage',
    consumer: 'VNextNextActionService.nextAction (read-only decision)',
    schema_seam: 'vNext NextActionOutput (read-only decision)',
  },
  {
    operation: 'context prepare',
    handler: 'runContext',
    consumer: 'persistVNextWorkerContext | persistVNextRoleContext',
    schema_seam: 'Context schema_version 2 (persistence seam)',
  },
  {
    operation: 'stage admit-worker',
    handler: 'runStage',
    consumer: 'admitVNextWorkerResult',
    schema_seam: 'validateVNextWorkerResultEnvelope (closed v2 WorkerResultEnvelope)',
  },
  {
    operation: 'stage admit-cv',
    handler: 'runStage',
    consumer: 'admitVNextCVResult',
    schema_seam: 'validateVNextCvResultEnvelope (closed CV_RESULT envelope)',
  },
  {
    operation: 'stage admit-slice-commit',
    handler: 'runStage',
    consumer: 'admitVNextSliceCommit',
    schema_seam: 'validateVNextSliceCommitRequest (slice + commit_sha + cv_receipt_digest)',
  },
  {
    operation: 'stage admit-integration',
    handler: 'runStage',
    consumer: 'admitVNextIntegration',
    schema_seam: 'validateVNextIntegrationRequest (slice + commit_sha)',
  },
  {
    operation: 'stage close',
    handler: 'runStage',
    consumer: 'admitVNextStageClose',
    schema_seam: 'validateVNextStageCloseRequest (close_type full|restricted + reason)',
  },
  {
    operation: 'gate run',
    handler: 'runGateDomain',
    consumer: 'runGateVNext + admitVNextGateResult',
    schema_seam: 'validateVNextGateResultRequest (gate_result request contract)',
  },
  {
    operation: 'review prepare-stage',
    handler: 'runReview',
    consumer: 'persistVNextStageReviewPreparation',
    schema_seam: 'VNextStageReviewPreparation schema_version 2 (persisted prepared fact)',
  },
  {
    operation: 'review finalize-stage',
    handler: 'runReview',
    consumer: 'admitVNextStageReview',
    schema_seam: 'validateVNextStageReviewRequest (verdict ACCEPTED|REPAIR + summary)',
  },
];
