/**
 * @proofloop/opencode-plugin — OpenCode host plugin entry package.
 *
 * S01-A-T02 delivered the host-loadable entry shape (`m.default ?? m.server`
 * is a function; named `server` and `default` ESM exports are loadable).
 * S01-C-T04 wires the entry: on plugin load it assembles the RuntimeContext
 * (S01-B host-context), runs ProofLoop detection + runtime.lock validation
 * (S01-B detectProject + validateRuntimeLockAt seam), and registers
 * `proofloop_doctor` for ANY project (FR-006). S1 registers NO other tools
 * (`proofloop_plan`/`proofloop_stage`/`proofloop_review`/`proofloop_project` are
 * S2/S3/S5) and NO hooks (S4).
 *
 * Host types (`Plugin`, `PluginInput`, `Hooks`, `PluginOptions`) are imported
 * type-only through the tsconfig `paths` mapping to
 * `.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`. The package has
 * no runtime dependency on `@opencode-ai/plugin` (offline repository, ADR-003).
 */

import type {
  Hooks,
  Plugin,
  PluginInput,
  PluginOptions,
  ToolDefinition,
} from '@opencode-ai/plugin';
import { createRuntimeContext } from './host-context.js';
import { detectProject } from './project-detection.js';
import { validateRuntimeLockAt } from './runtime-lock.js';
import { DOCTOR_TOOL_NAME, createDoctorTool } from './tools/doctor.js';
import { PLAN_TOOL_NAME, createPlanTool } from './tools/plan.js';
import { REVIEW_TOOL_NAME, createReviewTool } from './tools/review.js';
import { STAGE_TOOL_NAME, createStageTool } from './tools/stage.js';

// S02-A-T01: `proofloop_stage` factory is EXPORTED for S02-B/S02-C/S02-D and
// the host-load seam, but NOT registered here — S02-D owns the active-project
// registration gate. The Hooks returned by the plugin stay doctor-only in S2
// until S02-D (S2 Constraints: no flow tool may register before the gate).
export { createStageTool, STAGE_TOOL_NAME } from './tools/stage.js';
export type {
  StageOperation,
  StageOperationHandlers,
  StageResolvedArgs,
  StageToolArgsShape,
  StageToolDefinition,
} from './tools/stage.js';
// S02-B-T02: `proofloop_plan` factory is EXPORTED for the S02-D registration
// gate and the host-load seam, but NOT registered here — S02-D owns the
// active-project registration gate (S2 Constraints: no flow tool may register
// before the gate). The plan tool validates stages through the runtime
// validate-stage library seam in-process; compile / initialize_evidence /
// admit_spv_result are rejected at the execute boundary and never dispatch.
export { createPlanTool, PLAN_TOOL_NAME } from './tools/plan.js';
export type { PlanToolDefinition, PlanToolArgsShape } from './tools/plan.js';
// S02-B-T03: `runPlanValidate` is re-exported as the in-process validate seam
// so parity fixtures can compare the plugin's canonical data payload
// ({ valid, stage_id, errors }) against the CLI validate-stage JSON from the
// BUILT entry — the CLI stays a test-only oracle, production never shells it.
export { runPlanValidate } from './tools/plan-validate.js';
// S02-C-T01: `proofloop_review` factory is EXPORTED for S02-D and the
// host-load seam, but NOT registered here — S02-D owns the active-project
// registration gate (S2 Constraints: no flow tool may register before the
// gate). The review tool accepts ONLY `stage_status`; prepare_stage_review /
// finalize_stage_review fail closed at the execute boundary and are never
// exposed as writable capabilities (AWI-009 / OUT-S2-05 read-only boundary).
export { createReviewTool, REVIEW_TOOL_NAME } from './tools/review.js';
export type {
  ReviewOperation,
  ReviewOperationHandlers,
  ReviewResolvedArgs,
  ReviewToolArgsShape,
  ReviewToolDefinition,
} from './tools/review.js';
export { createRuntimeContext } from './host-context.js';
// S03-B-T03: reusable admission output seam (S03-C/S03-D consume the shared
// operation→AdmissionRequest mapper, the AdmitResult/ReceiptRef projection and
// the path-guard helpers — the same adapter boundary the stage tool uses).
export {
  STAGE_ADMIT_OPERATIONS,
  STAGE_ALL_OPERATIONS,
  STAGE_REJECTED_OPERATIONS,
  REQUIRED_ADMIT_FIELDS_BY_OPERATION,
  mapHostArgsToAdmissionRequest,
  guardAdmitPathFields,
  reverifyStagePaths,
  projectAdmitResultData,
  projectAdmitNewState,
  admitReceiptRef,
  isStageAdmitOperation,
} from './tools/stage-admit-common.js';
export type {
  StageAdmitOperation,
  StageAdmitWireArgs,
  StageAdmitMapResult,
} from './tools/stage-admit-common.js';
// The unified ToolResult projection (ok = accepted && no error-level Finding;
// ToolResult refs exactly { ref, digest } — never a Receipt payload/body).
export { projectAdmitToolResult } from './tools/stage-admit.js';

export const PLUGIN_PACKAGE_NAME = '@proofloop/opencode-plugin';

export const PLUGIN_VERSION = '0.1.0';

const plugin: Plugin = async (
  input: PluginInput,
  _options?: PluginOptions,
): Promise<Hooks> => {
  // Canonical worktree trust root (ADR-004: never a bare process.cwd()).
  const context = createRuntimeContext(input);

  // S01-B detection + lock gate: the project decision gates non-doctor
  // capabilities. The doctor is registered in EVERY project state (FR-006).
  // S02-D-T01: when the decision is ACTIVE (`registerNonDoctorCapabilities`)
  // the plugin additionally registers the three S2 read-only tools
  // (`proofloop_plan` → createPlanTool, `proofloop_stage` → createStageTool,
  // `proofloop_review` → createReviewTool) — each factory uses its built-in
  // default handlers (S02-A/B/C default wiring). For every inactive / non-
  // ProofLoop project (ordinary / missing lock / invalid lock / version-
  // incompatible lock) ONLY `proofloop_doctor` registers (fail-closed). S2
  // registers NO hooks, NO `proofloop_project` and NO write tool (S2 read-only
  // boundary, OUT-S2-04 / OUT-S2-05).
  const decision = detectProject(context.projectRoot, validateRuntimeLockAt);

  context.logger.info('plugin init: project decision', {
    projectRoot: context.projectRoot,
    projectDetected: decision.projectDetected,
    lockPresent: decision.lockPresent,
    active: decision.active,
    registerNonDoctorCapabilities: decision.registerNonDoctorCapabilities,
    findings: decision.findings,
  });

  // The S2 factories (S02-A/B/C) deliberately return a REAL host-accepted Zod
  // raw-shape `args` (built from the vendored zod) and FAIL CLOSED when the
  // vendored zod is unavailable (S2 review finding S2-F-002): a factory throw
  // must never crash the plugin load — it is caught below and only the
  // affected S2 tool is skipped (logger.warn). `proofloop_doctor` (FR-006)
  // never depends on zod and is always registered.
  const toolRegistry: Record<string, ToolDefinition> = {
    [DOCTOR_TOOL_NAME]: createDoctorTool(context),
    ...(decision.registerNonDoctorCapabilities
      ? buildS2ToolRegistry(context)
      : {}),
  };

  return {
    tool: toolRegistry,
  };
}

/**
 * Register the three S2 read-only tools, skipping any tool whose factory
 * fails closed (S2-F-002: vendored zod unavailable). The doctor is never part
 * of this set — it is always registered separately (FR-006).
 *
 * A missing tool is an explicit fail-closed condition: the unverified
 * structural args descriptor is never registered in place of the real
 * host-accepted Zod raw-shape. When zod is available (the normal path) all
 * three tools register, preserving the PO-S02-D-01 exact-4-tool set.
 */
function buildS2ToolRegistry(context: ReturnType<typeof createRuntimeContext>): Record<string, ToolDefinition> {
  const registry: Record<string, ToolDefinition> = {};
  const factories: ReadonlyArray<readonly [string, () => unknown]> = [
    [PLAN_TOOL_NAME, () => createPlanTool(context)],
    [STAGE_TOOL_NAME, () => createStageTool(context)],
    [REVIEW_TOOL_NAME, () => createReviewTool(context)],
  ];
  for (const [name, factory] of factories) {
    try {
      registry[name] = factory() as unknown as ToolDefinition;
    } catch (error) {
      context.logger.warn(
        `plugin init: ${name} registration skipped (fail-closed)`,
        {
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  return registry;
};

export default plugin;

export const server: Plugin = plugin;
