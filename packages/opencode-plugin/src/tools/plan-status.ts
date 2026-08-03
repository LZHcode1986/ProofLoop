/**
 * @proofloop/opencode-plugin — proofloop_plan(status) contract layer
 * (S03-C-T01, PO-S03-C-01 primary; PO-S03-C-03).
 *
 * The `status` operation reuses the S2 `proofloop_stage(status)` read seam —
 * `stageStatusHandler` (stage.ts) — which derives the bounded stage status
 * from the runtime `reconcileStage` persisted facts (the ONLY status read
 * seam). The plan tool NEVER re-implements a stage state machine and NEVER
 * writes: status is a read-only projection with no Receipt refs.
 *
 * Fail-closed contract (PO-S03-C-01/03/04):
 *   - `stage_id` is required and must be canonical (`/^S\d+$/` — path
 *     traversal / separators / absolute segments are rejected before any
 *     runtime read);
 *   - `project_root` is a canonical-root consistency assertion ONLY (mismatch
 *     → HOST.PROJECT_NOT_TRUSTED, `plan-common.ts`);
 *   - the shared TOCTOU identity re-verify + manifest content trust-root
 *     guard (S2-F-001) run inside the reused stage handler before any runtime
 *     call;
 *   - every failure is a canonical kernel Finding via `toErrorResult`.
 *
 * The reused handler output is the S1 unified ToolResult plus the bounded
 * status summary text (≤ STATUS_BUDGET UTF-16 chars via `renderCompact`);
 * the ToolResult `data` carries the same canonical facts projection as
 * `proofloop_stage(status)` so the three status seams stay consistent
 * (PO-S03-C-03).
 */

import { toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import { CANONICAL_STAGE_ID, stageStatusHandler } from './stage.js';
import type { StageHandlerResult } from './stage.js';
import { assertPlanProjectRootArg } from './plan-common.js';

/** The `status` plan operation label (contract-state-matrix.md#§1.1). */
export const PLAN_STATUS_OPERATION = 'status' as const;

/** Build the canonical missing-stage-id failure (fail closed, no runtime read). */
function missingStageId(): ToolResult {
  return toErrorResult([
    {
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
      message:
        'proofloop_plan: `stage_id` is required for operation "status" and must ' +
        'be a non-empty string.',
    },
  ]);
}

/**
 * In-process status adapter: assert the canonical-root consistency, validate
 * the canonical `stage_id`, then delegate to the S2 `stageStatusHandler`
 * (reconcileStage read seam) — never a CLI subprocess, never a re-implemented
 * state machine, never a write.
 */
export function runPlanStatus(canonicalRoot: string, rawArgs: unknown): StageHandlerResult {
  const rootAssertion = assertPlanProjectRootArg(canonicalRoot, rawArgs);
  if (rootAssertion !== null) {
    return { result: rootAssertion };
  }
  if (typeof rawArgs !== 'object' || rawArgs === null) {
    return { result: missingStageId() };
  }
  const args = rawArgs as Record<string, unknown>;
  const stageId = args['stage_id'];
  if (typeof stageId !== 'string' || stageId.length === 0) {
    return { result: missingStageId() };
  }
  if (!CANONICAL_STAGE_ID.test(stageId)) {
    return {
      result: toErrorResult([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            `proofloop_plan: stage_id "${stageId}" is not a canonical stage id ` +
            '(expected /^S\\d+$/, e.g. S03); path traversal / absolute paths are ' +
            'rejected before any runtime read.',
        },
      ]),
    };
  }
  // The ONLY status read seam: reconcileStage via the S2 stage handler. The
  // handler performs the TOCTOU identity re-verify, the manifest content
  // trust-root guard (S2-F-001) and the canonical facts projection.
  return stageStatusHandler({ operation: 'status', stageId, projectRoot: canonicalRoot });
}
