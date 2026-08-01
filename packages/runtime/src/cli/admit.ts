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

import * as fs from 'node:fs';
import {
  admitWorkerResult,
  admitCVResult,
  admitSliceCommit,
  admitIntegration,
  admitStageReview,
  admitProjectReview,
  admitStagePlan,
} from '../admission';
import { admitSpvResult, admitGateResult, admitGateInterrupted } from '../admit-pipeline';
import type { SpvGateAdmissionDeps } from '../admit-pipeline';
import type { AdmissionDeps } from '../admission';
import type { AdmissionRequest } from '../admission-request';
import type { AdmitResult } from '../admit-pipeline';

// ============================================================
// Dispatch — thin wrapper over the S02/S03 admit methods
// ============================================================

/**
 * Run one admission request through the matching admit method.
 *
 * @throws Error for request kinds not wired (SLICE_PLAN is reserved for S04
 *         by decision record PO-S03-H-02 — fail closed).
 */
export function admitRequest(request: AdmissionRequest, projectRoot: string): AdmitResult {
  const deps: AdmissionDeps = { projectRoot };
  const gateDeps: SpvGateAdmissionDeps = { projectRoot };
  switch (request.type) {
    case 'worker_result':
      return admitWorkerResult(request, deps);
    case 'cv_result':
      return admitCVResult(request, deps);
    case 'slice_commit':
      return admitSliceCommit(request, deps);
    case 'integration':
      return admitIntegration(request, deps);
    case 'stage_review':
      return admitStageReview(request, deps);
    case 'project_review':
      return admitProjectReview(request, deps);
    case 'stage_plan':
      return admitStagePlan(request, deps);
    case 'spv_result':
      return admitSpvResult(request, gateDeps);
    case 'gate_result':
      return admitGateResult(request, gateDeps);
    case 'gate_interrupted':
      return admitGateInterrupted(request, gateDeps);
    default: {
      // Type-level unreachable for the closed 10-member union; runtime guard
      // for JSON input carrying an unknown discriminant (SLICE_PLAN is
      // reserved for S04 — never a silent pass).
      const exhaustive: never = request;
      void exhaustive;
      throw new Error(
        `admit: unsupported request type "${String((request as { type?: unknown }).type)}" ` +
          `(SLICE_PLAN receipt creation is reserved for S04 — S03 creates no SLICE_PLAN receipts)`,
      );
    }
  }
}

// ============================================================
// CLI entry
// ============================================================

/**
 * Subcommand → request-type mapping (`admit.js spv-result` /
 * `admit.js gate-result` / `admit.js gate-interrupted`, PO-S03-H-02 +
 * S05-A-T05).
 */
const SUBCOMMAND_TYPES: Record<
  string,
  'spv_result' | 'gate_result' | 'gate_interrupted'
> = {
  'spv-result': 'spv_result',
  'gate-result': 'gate_result',
  'gate-interrupted': 'gate_interrupted',
};

/** Read the request JSON (file or --json) + project-root; apply subcommand. */
function readRequestArg(
  argv: readonly string[],
): { raw: string; projectRoot: string } {
  const [arg1, arg2, arg3, arg4] = argv;
  // subcommand form: admit.js spv-result <request.json> [project-root]
  const subType = arg1 !== undefined ? SUBCOMMAND_TYPES[arg1] : undefined;
  if (subType !== undefined) {
    if (arg2 === '--json') {
      return { raw: arg3 ?? '', projectRoot: arg4 ?? process.cwd() };
    }
    return { raw: arg2 !== undefined ? fs.readFileSync(arg2, 'utf-8') : '', projectRoot: arg3 ?? process.cwd() };
  }
  if (arg1 === '--json') {
    return { raw: arg2 ?? '', projectRoot: arg3 ?? process.cwd() };
  }
  if (arg1 !== undefined) {
    return { raw: fs.readFileSync(arg1, 'utf-8'), projectRoot: arg2 ?? process.cwd() };
  }
  return { raw: '', projectRoot: arg2 ?? process.cwd() };
}

/** Apply the subcommand type selector, rejecting explicit conflicts. */
function applySubcommandType(
  data: Record<string, unknown>,
  subType: 'spv_result' | 'gate_result' | 'gate_interrupted' | undefined,
): unknown {
  if (subType === undefined) return data;
  if (data['type'] === undefined) {
    return { ...data, type: subType };
  }
  if (data['type'] !== subType) {
    throw new Error(
      `admit: subcommand "${subType}" conflicts with request type "${String(data['type'])}"`,
    );
  }
  return data;
}

/**
 * CLI:
 *   node dist/cli/admit.js <request.json> [project-root]
 *   node dist/cli/admit.js --json '<json>' [project-root]
 *   node dist/cli/admit.js spv-result <request.json> [project-root]
 *   node dist/cli/admit.js gate-result <request.json> [project-root]
 *   node dist/cli/admit.js gate-interrupted <request.json> [project-root]
 */
export function admitCli(argv: readonly string[]): number {
  const subType = argv[0] !== undefined ? SUBCOMMAND_TYPES[argv[0]] : undefined;
  let raw: string;
  let projectRoot: string;
  try {
    ({ raw, projectRoot } = readRequestArg(argv));
  } catch (err) {
    console.error(`Error: Cannot read request file: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!raw) {
    console.error('Usage: node dist/cli/admit.js <request.json> [project-root]');
    console.error('       node dist/cli/admit.js --json \'<json>\' [project-root]');
    console.error('       node dist/cli/admit.js spv-result <request.json> [project-root]');
    console.error('       node dist/cli/admit.js gate-result <request.json> [project-root]');
    console.error('       node dist/cli/admit.js gate-interrupted <request.json> [project-root]');
    console.error('');
    console.error('Admits one AdmissionRequest through the unified admit pipeline');
    console.error('(7 S02 operations + S03 spv_result/gate_result + S05 gate_interrupted).');
    console.error('Outputs the AdmitResult JSON to stdout.');
    return 1;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  try {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('admit request must be a JSON object');
    }
    const request = applySubcommandType(data as Record<string, unknown>, subType);
    const result = admitRequest(request as AdmissionRequest, projectRoot);
    console.log(JSON.stringify(result, null, 2));
    return result.accepted ? 0 : 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = admitCli(process.argv.slice(2));
}
