/**
 * admit — new runtime CLI entry (PO-S03-H-01, S03-H-T01; SPV/GATE kinds
 * PO-S03-H-02, S03-H-T02)
 *
 * Thin wrapper over the S02/S03 AdmissionService methods (the 7 AWI-006
 * operations + the S03 SPV/GATE kinds). Every request goes through the
 * unified admit pipeline (`runAdmitPipeline` → kernel `writeReceipt` →
 * chain verification); the CLI never writes receipts itself.
 *
 *   node packages/runtime/dist/cli/admit.js <request.json> [project-root]
 *   node packages/runtime/dist/cli/admit.js --json '<request-json>' [project-root]
 *   node packages/runtime/dist/cli/admit.js spv-result <request.json> [project-root]
 *   node packages/runtime/dist/cli/admit.js gate-result <request.json> [project-root]
 *
 * `<request.json>` holds one canonical AdmissionRequest (the 9-member union
 * incl. spv_result / gate_result). The `spv-result` / `gate-result`
 * subcommand forms inject the request `type` when the JSON omits it (and
 * reject a conflicting explicit type). project-root defaults to the current
 * working directory. Output: the `AdmitResult` JSON
 * `{ accepted, receipt_ref, new_state, findings }`. Exit 0 on acceptance,
 * 1 on structured rejection / error.
 *
 * SLICE_PLAN request kind: reserved for S04 (decision record, PO-S03-H-02)
 * — S03 does not create SLICE_PLAN receipts; an explicit slice_plan request
 * fails closed with a clear message.
 *
 * Zero host dependencies.
 */
import type { AdmissionRequest } from '../admission-request';
import type { AdmitResult } from '../admit-pipeline';
/**
 * Run one admission request through the matching admit method.
 *
 * @throws Error for request kinds not wired (SLICE_PLAN is reserved for S04
 *         by decision record PO-S03-H-02 — fail closed).
 */
export declare function admitRequest(request: AdmissionRequest, projectRoot: string): AdmitResult;
/**
 * CLI:
 *   node dist/cli/admit.js <request.json> [project-root]
 *   node dist/cli/admit.js --json '<json>' [project-root]
 *   node dist/cli/admit.js spv-result <request.json> [project-root]
 *   node dist/cli/admit.js gate-result <request.json> [project-root]
 *   node dist/cli/admit.js gate-interrupted <request.json> [project-root]
 */
export declare function admitCli(argv: readonly string[]): number;
//# sourceMappingURL=admit.d.ts.map