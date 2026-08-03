/**
 * @proofloop/opencode-plugin — proofloop_plan tool definition (AWI-007 /
 * AWI-013).
 *
 * S02-B-T02 delivered the S2 `validate`-only host tool. S03-A-T01 extends the
 * operation contract to the S3 Planner write operations:
 *
 *   - operation set: `validate` (S2 regression), `compile`,
 *     `initialize_evidence`. `stage_plan`, `admit_stage_plan`, gate/project
 *     operations (`run_gate`, `admit_gate_result`, `admit_gate_interrupted`,
 *     `compile_acceptance`, `run_e2e`, `prepare_project_review`,
 *     `finalize_project_review`) and ANY unknown value fail closed with a
 *     canonical RUNTIME.SCHEMA_MISMATCH Finding at the execute boundary —
 *     never a fallthrough, never a silent alias, never a downgrade to
 *     read-only. S03-C-T01 adds the `status` and `admit_spv_result`
 *     dispatches (the S3 Planner read + SPV admission operations).
 *   - args shape (host field name `args`, NOT `inputSchema`): `operation`
 *     (the 5-operation closed enum), `tasks_path`, `manifest_path`,
 *     `project_root` (optional canonical-root consistency assertion), the S2
 *     `evidence_dir` (optional, validate regression), `stage_id` (required for
 *     status/admit_spv_result), `manifest_digest` (admit_spv_result),
 *     `summary` (admit_spv_result) and `verdict` (admit_spv_result, closed
 *     SPV_PASS wire gate). Same vendored-zod fail-closed tradeoff as S02-A
 *     `STAGE_TOOL_ARGS` / S2 `PLAN_TOOL_ARGS`: the tool factory registers a
 *     real host-accepted Zod raw-shape when the vendored zod resolves, and
 *     THROWS (never a structural fallback) when it does not (S2-F-002).
 *     Operation-dependent requiredness is enforced in execute's fail-closed
 *     second validation (`parsePlanArgs`), NOT by the host schema alone.
 *   - dispatch: `validate` → `runPlanValidate` (runtime `validateStage`
 *     IN-PROCESS), `compile` → `runPlanCompile` (runtime `compileManifest` +
 *     root-bound Manifest owner write), `initialize_evidence` →
 *     `runPlanInitialize` (runtime `initializeSliceEvidence` with the
 *     canonical trust root as delivery root), `status` → `runPlanStatus`
 *     (reuses the S2 `proofloop_stage(status)` reconcileStage read seam,
 *     read-only), `admit_spv_result` → `runPlanSpvAdmit` (runtime
 *     `admitSpvResult` IN-PROCESS through the closed SPV_PASS adapter). The
 *     plugin never shells the CLI and never writes Receipts directly —
 *     compile/initialize are Manifest/Evidence owner writes, not receipt
 *     admissions; SPV_PASS receipts are written ONLY by the runtime admit
 *     pipeline.
 *   - path/trust-root/TOCTOU boundary: every path is root-bound +
 *     canonicalized through the shared `path-boundary` seams; caller
 *     `project_root` is a consistency assertion only (mismatch →
 *     HOST.PROJECT_NOT_TRUSTED); out-of-root →
 *     HOST.PATH_OUTSIDE_PROJECT; TOCTOU identity re-verify before the
 *     runtime read/write. Every failure is a canonical Finding via
 *     `toErrorResult`.
 *   - cancellation: `ToolContext.abort` is honored cooperatively — an
 *     already-aborted caller (or a completion after abort) propagates
 *     AbortError, never a clean PASS or a Finding.
 *   - output: S1 `renderCompact` bounds each operation summary (FR-012) and
 *     the findings are capped at FINDINGS_BUDGET; the canonical `Data:` line
 *     carries the operation payload; refs stay empty (no Receipt refs are
 *     ever produced).
 *
 * The tool is NOT registered in the plugin Hooks (S02-D owns the active-project
 * registration gate); `createPlanTool` is the exported factory seam.
 */

import { createRequire } from 'node:module';
import type { ToolContext, ToolResult as HostToolResult } from '@opencode-ai/plugin';
import type { z as ZodNamespace } from 'zod';
import type { CompactView } from '../compact.js';
import { renderCompact, serializeStructuredData } from '../compact.js';
import { toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import type { RuntimeContext } from '../host-context.js';
import { runPlanValidate } from './plan-validate.js';
import { runPlanCompile } from './plan-compile.js';
import { runPlanInitialize } from './plan-initialize.js';
import { runPlanStatus } from './plan-status.js';
import { runPlanSpvAdmit, SPV_VERDICT_GATE, MANIFEST_DIGEST_PATTERN } from './plan-spv-admit.js';
import type { PlanSpvAdmitDeps } from './plan-spv-admit.js';
import { renderStageAdmitText } from './stage-admit-common.js';
import { CANONICAL_STAGE_ID } from './stage.js';

/** Canonical tool key registered by the host (AWI-007). */
export const PLAN_TOOL_NAME = 'proofloop_plan';

/** Legal S3 plan operations (contract-state-matrix.md#§1.1). */
export const PLAN_OPERATIONS = [
  'validate',
  'compile',
  'initialize_evidence',
  'status',
  'admit_spv_result',
] as const;

/** Legal S3 plan operation value. */
export type PlanOperation = (typeof PLAN_OPERATIONS)[number];

/**
 * Operations that are NEVER legal for `proofloop_plan` in S3
 * (contract-state-matrix.md#§1.1 / OUT-S2-05 read-only boundary):
 * `stage_plan` / `admit_stage_plan` are Stage-plan admission operations owned
 * by other tools and S3 NEVER exposes them through the plan tool; gate and
 * project operations belong to the stage-gate / project tools. The execute
 * boundary rejects every value here with a canonical Finding and NEVER
 * dispatches a write branch — in particular `admit_stage_plan` is NEVER a
 * hidden path to create a PLANNING stage (SPV fixtures must use a persisted
 * legal STAGE_PLAN fact, never a hidden tool operation).
 */
export const PLAN_REJECTED_OPERATIONS = [
  'stage_plan',
  'admit_stage_plan',
  'run_gate',
  'admit_gate_result',
  'admit_gate_interrupted',
  'compile_acceptance',
  'run_e2e',
  'prepare_project_review',
  'finalize_project_review',
] as const;

/**
 * Operation-dependent required host fields, enforced by execute's fail-closed
 * second validation (`parsePlanArgs`) — NEVER by the host schema alone
 * (S3 constraint: "operation-dependent requiredness 不能依赖宿主 schema alone").
 * `stage_id` is required for the S3-C `status` / `admit_spv_result` operations;
 * `manifest_digest` and `summary` are required for `admit_spv_result` — the
 * runtime `SpvResultAdmissionRequest` closed schema requires a non-empty
 * summary, so the wire makes it required (CV repair, CV-S03-C-POSTWRITE-TOCTOU-001
 * counterexample 2).
 */
export const REQUIRED_PLAN_FIELDS_BY_OPERATION: Record<
  PlanOperation,
  readonly string[]
> = {
  validate: ['tasks_path', 'manifest_path'],
  compile: ['tasks_path', 'manifest_path'],
  initialize_evidence: ['manifest_path'],
  status: ['stage_id'],
  admit_spv_result: ['stage_id', 'manifest_digest', 'summary'],
};

/** Human-readable tool description exposed to the host. */
export const PLAN_TOOL_DESCRIPTION =
  'Plan a ProofLoop stage through the canonical worktree trust root: ' +
  '`validate` returns the canonical { valid, stage_id, errors } payload ' +
  '(read-only); `compile` compiles a Stage tasks.md into a kernel-valid ' +
  'Manifest and writes it to the root-bound manifest_path; ' +
  '`initialize_evidence` creates Slice Evidence skeletons for a compiled ' +
  'Manifest (non-empty files are never overwritten); `status` returns the ' +
  'bounded reconcileStage-derived stage status (read-only); ' +
  '`admit_spv_result` admits a closed SPV_PASS verdict through the runtime ' +
  'admission pipeline (writes an SPV_PASS Receipt to plan/<stage>/ only when ' +
  'the stage is a legal PLANNING stage with a matching manifest digest). All ' +
  'paths resolve against the canonical trust root; unsupported operations ' +
  'fail closed.';

/**
 * Structural stand-in for one host Zod raw-shape field. Kept as the
 * documented structural reference shape; NEVER used as the registered `args`
 * (S2-F-002 fail-closed — see `PLAN_TOOL_ARGS_FALLBACK`).
 */
export interface PlanArgFieldSpec {
  /** Field kind: fixed string or closed enum. */
  type: 'string' | 'enum';
  /** Human-readable field description. */
  description: string;
  /** True for optional fields. */
  optional?: boolean;
  /** Legal values for `type: 'enum'`. */
  values?: readonly string[];
}

/**
 * One field of the host-accepted `args` shape: a REAL Zod schema (the ONLY
 * shape the tool factory registers — S2-F-002 fail-closed) or a structural
 * stand-in kept as a documented reference shape.
 */
export type PlanToolArgsField =
  | PlanArgFieldSpec
  | {
      readonly _def: unknown;
      readonly description?: string;
      readonly options?: readonly string[];
    };

/**
 * Host-accepted `args` shape for `proofloop_plan`. Field names are the
 * canonical S3 plan inputs: `operation` (validate | compile |
 * initialize_evidence | status | admit_spv_result), `tasks_path`,
 * `manifest_path`, optional `project_root` (canonical-root consistency
 * assertion), the S2 optional `evidence_dir`, `stage_id` (status /
 * admit_spv_result), `manifest_digest` (admit_spv_result), `summary`
 * (admit_spv_result, optional non-empty) and `verdict` (admit_spv_result,
 * closed SPV_PASS wire gate).
 */
export interface PlanToolArgsShape {
  operation: PlanToolArgsField;
  tasks_path: PlanToolArgsField;
  manifest_path: PlanToolArgsField;
  project_root: PlanToolArgsField;
  evidence_dir: PlanToolArgsField;
  stage_id: PlanToolArgsField;
  manifest_digest: PlanToolArgsField;
  summary: PlanToolArgsField;
  verdict: PlanToolArgsField;
}

/**
 * Structural fallback `args` shape. Retained as the documented structural
 * reference shape ONLY — NEVER used as the registered `args` (S2-F-002
 * fail-closed). Fields are `PlanArgFieldSpec` descriptors.
 */
export interface PlanToolArgsFallbackShape {
  operation: PlanArgFieldSpec & { values: readonly PlanOperation[] };
  tasks_path: PlanArgFieldSpec;
  manifest_path: PlanArgFieldSpec;
  project_root: PlanArgFieldSpec;
  evidence_dir: PlanArgFieldSpec;
  stage_id: PlanArgFieldSpec;
  manifest_digest: PlanArgFieldSpec;
  summary: PlanArgFieldSpec;
  verdict: PlanArgFieldSpec;
}

export const PLAN_TOOL_ARGS_FALLBACK: PlanToolArgsFallbackShape = {
  operation: {
    type: 'enum',
    values: [...PLAN_OPERATIONS],
    description:
      'Operation to run: `validate`, `compile`, `initialize_evidence`, `status` or `admit_spv_result`.',
  },
  tasks_path: {
    type: 'string',
    optional: true,
    description:
      'tasks.md path (required for validate/compile). Relative paths resolve against the trust root; absolute paths must stay inside it.',
  },
  manifest_path: {
    type: 'string',
    optional: true,
    description:
      'Manifest path (required for validate/compile/initialize_evidence). Relative paths resolve against the trust root; absolute paths must stay inside it.',
  },
  project_root: {
    type: 'string',
    optional: true,
    description:
      'Canonical project root assertion. May only assert consistency with the trusted worktree; never overrides it.',
  },
  evidence_dir: {
    type: 'string',
    optional: true,
    description:
      'Evidence directory for validate existence checks. Relative paths resolve against the trust root; absolute paths must stay inside it.',
  },
  stage_id: {
    type: 'string',
    optional: true,
    description:
      'Canonical stage id (e.g. S03). Required for status / admit_spv_result.',
  },
  manifest_digest: {
    type: 'string',
    optional: true,
    description:
      'Canonical Manifest digest binding (64-hex) for admit_spv_result.',
  },
  summary: {
    type: 'string',
    optional: true,
    description:
      'Summary for admit_spv_result (required non-empty at the execute boundary; the runtime closed schema requires non-empty).',
  },
  verdict: {
    type: 'enum',
    values: ['SPV_PASS'],
    optional: true,
    description:
      'SPV wire-level verdict gate for admit_spv_result (closed: only SPV_PASS).',
  },
};

/** Node require bound to this module (source and dist share the depth). */
const require = createRequire(import.meta.url);

/**
 * Load the vendored zod used by the host (`.opencode/node_modules/zod`, zod v4
 * ESM — the same package the host's `tool.schema` uses). Fail-closed (S2
 * review finding S2-F-002): when the module is absent/unresolvable the S2
 * tool factory REFUSES to register (never falls back to the unverified
 * structural descriptor); the built plugin itself still loads — `index.ts`
 * catches the factory throw and skips only the affected tool, keeping
 * `proofloop_doctor` (FR-006) always available.
 */
function tryLoadVendoredZod(): typeof ZodNamespace | undefined {
  try {
    const mod = require('../../../../.opencode/node_modules/zod/index.js') as {
      z?: typeof ZodNamespace;
    };
    return mod.z;
  } catch {
    return undefined;
  }
}

/** Build the REAL host-accepted Zod raw-shape from the vendored zod (v4). */
function buildPlanZodArgsShape(z: typeof ZodNamespace): PlanToolArgsShape | undefined {
  try {
    const schema = z.object({
      operation: z
        .enum([...PLAN_OPERATIONS])
        .describe(
          'Operation to run: `validate`, `compile` or `initialize_evidence`.',
        ),
      tasks_path: z
        .string()
        .min(1)
        .optional()
        .describe(
          'tasks.md path (required for validate/compile). Relative paths resolve against the trust root; absolute paths must stay inside it.',
        ),
      manifest_path: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Manifest path (required for validate/compile/initialize_evidence). Relative paths resolve against the trust root; absolute paths must stay inside it.',
        ),
      project_root: z
        .string()
        .optional()
        .describe(
          'Canonical project root assertion. May only assert consistency with the trusted worktree; never overrides it.',
        ),
      evidence_dir: z
        .string()
        .optional()
        .describe(
          'Evidence directory for validate existence checks. Relative paths resolve against the trust root; absolute paths must stay inside it.',
        ),
      stage_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Canonical stage id (e.g. S03). Required for status / admit_spv_result.',
        ),
      manifest_digest: z
        .string()
        .optional()
        .describe(
          'Canonical Manifest digest binding (64-hex) for admit_spv_result.',
        ),
      summary: z
        .string()
        .optional()
        .describe(
          'Summary for admit_spv_result (required non-empty at the execute boundary; the runtime closed schema requires non-empty).',
        ),
      verdict: z
        .enum(['SPV_PASS'])
        .optional()
        .describe(
          'SPV wire-level verdict gate for admit_spv_result (closed: only SPV_PASS).',
        ),
    });
    return schema.shape as unknown as PlanToolArgsShape;
  } catch {
    return undefined;
  }
}

const vendoredZod = tryLoadVendoredZod();

/**
 * The `args` the tool factory registers — a REAL host-accepted Zod raw-shape
 * built from the vendored zod (v4). Fail-closed (S2-F-002): when the vendored
 * zod is unavailable this is `undefined` and `createPlanTool` refuses to
 * register — the structural `PLAN_TOOL_ARGS_FALLBACK` descriptor is NEVER
 * used as registration args because it has not been verified on the real host
 * seam.
 */
export const PLAN_TOOL_ARGS: PlanToolArgsShape | undefined =
  vendoredZod !== undefined ? buildPlanZodArgsShape(vendoredZod) : undefined;

/**
 * True when the vendored-zod host-accepted args shape is available for
 * registration (S2-F-002). The plugin entry consults this before attempting
 * to register `proofloop_plan`; the factory re-checks the loader as its own
 * fail-closed boundary.
 */
export function isPlanToolArgsAvailable(): boolean {
  return PLAN_TOOL_ARGS !== undefined;
}

/**
 * Loader for the vendored zod used by the tool factory (S2-F-002 test seam).
 * The default is the real `tryLoadVendoredZod`; tests inject a stub that
 * returns `undefined` to prove the fail-closed registration path.
 */
export type PlanZodLoader = () => typeof ZodNamespace | undefined;

/** Fail-closed factory error when the vendored zod raw-shape is unavailable. */
function createZodUnavailableError(toolLabel: string): Error {
  return new Error(
    `${toolLabel} cannot register: the vendored zod runtime is unavailable; ` +
      'refusing to fall back to an unverified structural args descriptor (fail-closed).',
  );
}

/** Host-visible tool definition (matches the `tool(...)` return shape). */
export interface PlanToolDefinition {
  description: string;
  args: PlanToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<HostToolResult>;
}

/**
 * Render a unified ToolResult into the host `{ output }` envelope (fail-closed
 * and unhandled-path renderer): operation label, overall status, findings.
 */
export function renderPlanOutput(
  result: ToolResult,
  operation?: string,
): string {
  const lines: string[] = ['ProofLoop Plan'];
  if (operation !== undefined) {
    lines.push(`Operation: ${operation}`);
  }
  lines.push(`Status: ${result.ok ? 'ok' : 'failed'}`);
  if (result.ok && result.data !== undefined) {
    // U+2028/U+2029 escaped for a stable single-line Data payload.
    lines.push(`Data: ${serializeStructuredData(result.data)}`);
  }
  if (result.findings.length === 0) {
    lines.push('Findings: none');
  } else {
    lines.push(`Findings (${result.findings.length}):`);
    for (const finding of result.findings) {
      lines.push(`- [${finding.code}] ${finding.severity}: ${finding.message}`);
    }
  }
  return lines.join('\n');
}

/** Per-operation section label on the compact output (FR-012 block). */
const PLAN_SECTION_LABELS: Record<PlanOperation, string> = {
  validate: 'Validate result:',
  compile: 'Compile result:',
  initialize_evidence: 'Initialize evidence result:',
  status: 'Stage status:',
  admit_spv_result: 'SPV admit result:',
};

/**
 * Render the bounded compact view into the host `{ output }` envelope.
 *
 * The compact summary is the FR-012-budgeted text; findings are the capped
 * canonical list; truncation points back to the traceable diagnostic log ref.
 * The `Status:` line reflects the ToolResult `ok` flag so a fail-closed read
 * is never presented as a clean PASS.
 *
 * The output ALSO carries the full structured canonical payload on a `Data:`
 * line (operation-specific: validate `{ valid, stage_id, errors }`; compile
 * `{ stage_id, source_digest, manifest_digest, manifest_ref }`;
 * initialize_evidence `{ created, skipped, errors }` — U+2028/U+2029 escaped)
 * so a parity assertion can deep-equal the plugin payload against the CLI JSON
 * output through the REAL execute host seam.
 */
export function renderPlanCompactOutput(
  view: CompactView,
  operation: PlanOperation,
  result: ToolResult,
): string {
  const lines: string[] = ['ProofLoop Plan'];
  lines.push(`Operation: ${operation}`);
  lines.push(`Status: ${result.ok ? 'ok' : 'failed'}`);
  lines.push(PLAN_SECTION_LABELS[operation]);
  lines.push(view.status.length > 0 ? view.status : '(no summary)');
  if (result.data !== undefined) {
    lines.push(`Data: ${serializeStructuredData(result.data)}`);
  }
  if (view.findings.length === 0) {
    lines.push('Findings: none');
  } else {
    lines.push(`Findings (${view.findings.length}):`);
    for (const finding of view.findings) {
      lines.push(`- [${finding.code}] ${finding.severity}: ${finding.message}`);
    }
  }
  if (view.truncated.length > 0) {
    lines.push(`Truncated: ${view.truncated.join(', ')}`);
    lines.push(`Full diagnostics: ${view.logRef}`);
  }
  return lines.join('\n');
}

/**
 * Project the validate ToolResult into the compact summary text (fed to
 * `renderCompact` for the FR-012 budget). The canonical payload (valid,
 * stage_id, errors count) is preserved in human-readable bounded form; the
 * full canonical `data` stays available in the ToolResult for parity.
 */
export function renderPlanValidateText(result: ToolResult): string {
  const data = result.data as {
    valid?: unknown;
    stage_id?: unknown;
    errors?: unknown;
  } | undefined;
  const lines: string[] = [];
  lines.push(`Valid: ${data?.valid === true ? 'true' : 'false'}`);
  if (typeof data?.stage_id === 'string') {
    lines.push(`Stage: ${data.stage_id}`);
  }
  const errors = Array.isArray(data?.errors) ? data.errors.length : 0;
  lines.push(`Errors: ${errors}`);
  if (errors > 0 && Array.isArray(data?.errors)) {
    for (const err of data.errors as Array<{ type?: unknown; message?: unknown }>) {
      const type = typeof err?.type === 'string' ? err.type : 'UNKNOWN';
      const message = typeof err?.message === 'string' ? err.message : '';
      lines.push(`- [${type}] ${message}`);
    }
  }
  return lines.join('\n');
}

/**
 * Project the compile ToolResult into the compact summary text: the
 * traceable stage id, source digest, canonical Manifest digest and Manifest
 * artifact ref (bounded form; the full canonical `data` stays in the
 * ToolResult).
 */
export function renderPlanCompileText(result: ToolResult): string {
  const data = result.data as {
    stage_id?: unknown;
    source_digest?: unknown;
    manifest_digest?: unknown;
    manifest_ref?: unknown;
  } | undefined;
  const lines: string[] = [];
  if (typeof data?.stage_id === 'string') {
    lines.push(`Stage: ${data.stage_id}`);
  }
  if (typeof data?.source_digest === 'string') {
    lines.push(`Source digest: ${data.source_digest}`);
  }
  if (typeof data?.manifest_digest === 'string') {
    lines.push(`Manifest digest: ${data.manifest_digest}`);
  }
  if (typeof data?.manifest_ref === 'string') {
    lines.push(`Manifest ref: ${data.manifest_ref}`);
  }
  return lines.join('\n');
}

/**
 * Project the initialize_evidence ToolResult into the compact summary text:
 * created / skipped / errors counts (bounded form; the full
 * `{ created, skipped, errors }` payload stays in `data`).
 */
export function renderPlanInitializeText(result: ToolResult): string {
  const data = result.data as {
    created?: unknown[];
    skipped?: unknown[];
    errors?: unknown[];
  } | undefined;
  const lines: string[] = [];
  lines.push(`Created: ${Array.isArray(data?.created) ? data.created.length : 0}`);
  lines.push(`Skipped: ${Array.isArray(data?.skipped) ? data.skipped.length : 0}`);
  lines.push(`Errors: ${Array.isArray(data?.errors) ? data.errors.length : 0}`);
  return lines.join('\n');
}

/** Compact status text for the executed operation. */
function renderPlanOperationText(operation: PlanOperation, result: ToolResult): string {
  switch (operation) {
    case 'validate':
      return renderPlanValidateText(result);
    case 'compile':
      return renderPlanCompileText(result);
    case 'initialize_evidence':
      return renderPlanInitializeText(result);
    case 'status':
      return renderPlanStatusText(result);
    case 'admit_spv_result':
      return renderStageAdmitText(result);
  }
}

/**
 * Project the status ToolResult into the compact summary text (defensive
 * fallback when a test-injected `status` handler returns a bare ToolResult;
 * the default handler supplies the full `renderStageStatusText` through the
 * handler result). The canonical payload (stage_id, stage_state, project
 * state, chain validity, per-slice facts) is preserved in bounded form.
 */
export function renderPlanStatusText(result: ToolResult): string {
  const data = result.data as
    | {
        stage_id?: unknown;
        stage_state?: unknown;
        project_state?: unknown;
        receipt_chain_valid?: unknown;
        slices?: Array<{
          slice_id?: unknown;
          slice_state?: unknown;
          cv_status?: unknown;
          tasks_checked?: unknown;
          tasks_total?: unknown;
          slice_evidence_finalized?: unknown;
          repair_attempt?: unknown;
          complete?: unknown;
          integrated?: unknown;
          committed?: unknown;
        }>;
      }
    | undefined;
  const lines: string[] = [];
  if (typeof data?.stage_id === 'string') {
    lines.push(`Stage: ${data.stage_id}`);
  }
  if (typeof data?.stage_state === 'string') {
    lines.push(`State: ${data.stage_state}`);
  }
  if (typeof data?.project_state === 'string') {
    lines.push(`Project: ${data.project_state}`);
  }
  if (typeof data?.receipt_chain_valid === 'boolean') {
    lines.push(`Receipt chain: ${data.receipt_chain_valid ? 'valid' : 'invalid'}`);
  }
  const slices = Array.isArray(data?.slices) ? data.slices : [];
  lines.push(`Slices (${slices.length}):`);
  for (const slice of slices) {
    lines.push(
      `- ${String(slice.slice_id ?? '?')}: state=${String(slice.slice_state ?? '?')} ` +
        `cv=${String(slice.cv_status ?? '?')} ` +
        `tasks=${Number(slice.tasks_checked ?? 0)}/${Number(slice.tasks_total ?? 0)} ` +
        `evidence_finalized=${String(slice.slice_evidence_finalized ?? '?')} ` +
        `repairs=${Number(slice.repair_attempt ?? 0)} complete=${String(slice.complete ?? '?')} ` +
        `integrated=${String(slice.integrated ?? '?')} ` +
        `committed=${String(slice.committed ?? '?')}`,
    );
  }
  return lines.join('\n');
}

/**
 * Reject a non-legal plan operation at the execute boundary.
 *
 * Every rejected value (`stage_plan`, `admit_stage_plan`, gate/project
 * operations, unknown values) fails closed with a canonical
 * RUNTIME.SCHEMA_MISMATCH Finding and NEVER reaches a dispatch/write branch
 * (§1.1 / OUT-S2-05 read-only boundary). In particular `admit_stage_plan` is
 * NEVER a hidden path to create a PLANNING stage.
 */
function rejectPlanOperation(
  operation: unknown,
): { ok: false; result: ToolResult } {
  const label = typeof operation === 'string' && operation.length > 0 ? operation : '(missing)';
  return {
    ok: false,
    result: toErrorResult([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          `proofloop_plan: operation "${label}" is not supported (supported: ` +
          'validate | compile | initialize_evidence | status | ' +
          'admit_spv_result). Rejected operations (stage_plan, admit_stage_plan, ' +
          'run_gate, admit_gate_result, admit_gate_interrupted, ' +
          'compile_acceptance, run_e2e, prepare_project_review, ' +
          'finalize_project_review) and unknown values never dispatch through ' +
          'this tool.',
      },
    ]),
  };
}

/**
 * Parse and validate the caller args at the execute boundary.
 *
 * The operation contract is enforced FIRST (fail-closed, never reaches the
 * dispatch seam), then the operation-dependent requiredness is enforced by the
 * execute's second validation (never by the host schema alone). The S3-C
 * operations additionally validate the canonical `stage_id` and, for
 * admit_spv_result, the 64-hex `manifest_digest`, the optional non-empty
 * `summary` and the closed `verdict: 'SPV_PASS'` wire gate — any failure is a
 * canonical Finding BEFORE any runtime call. Path-boundary resolution for each
 * operation's inputs is delegated to the corresponding operation contract
 * layer (`runPlanValidate` / `runPlanCompile` / `runPlanInitialize` /
 * `runPlanStatus` / `runPlanSpvAdmit`).
 */
export function parsePlanArgs(
  rawArgs: unknown,
): { ok: true; operation: PlanOperation } | { ok: false; result: ToolResult } {
  if (typeof rawArgs !== 'object' || rawArgs === null) {
    return rejectPlanOperation(undefined);
  }
  const args = rawArgs as Record<string, unknown>;
  const operation = args['operation'];
  if (!isPlanOperation(operation)) {
    return rejectPlanOperation(operation);
  }
  for (const field of REQUIRED_PLAN_FIELDS_BY_OPERATION[operation]) {
    const value = args[field];
    if (typeof value !== 'string' || value.length === 0) {
      return {
        ok: false,
        result: toErrorResult([
          {
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message:
              `proofloop_plan: \`${field}\` is required for operation "${operation}" ` +
              'and must be a non-empty string.',
          },
        ]),
      };
    }
  }
  if (operation === 'status' || operation === 'admit_spv_result') {
    const stageId = args['stage_id'];
    if (typeof stageId !== 'string' || !CANONICAL_STAGE_ID.test(stageId)) {
      return {
        ok: false,
        result: toErrorResult([
          {
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message:
              `proofloop_plan: stage_id "${String(stageId)}" is not a canonical ` +
              'stage id (expected /^S\\d+$/, e.g. S03); path traversal / absolute ' +
              'paths are rejected before any runtime read.',
          },
        ]),
      };
    }
  }
  if (operation === 'admit_spv_result') {
    const manifestDigest = args['manifest_digest'];
    if (typeof manifestDigest !== 'string' || !MANIFEST_DIGEST_PATTERN.test(manifestDigest)) {
      return {
        ok: false,
        result: toErrorResult([
          {
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message:
              'proofloop_plan: `manifest_digest` is required for admit_spv_result ' +
              'and must be a 64-hex string.',
          },
        ]),
      };
    }
    const summary = args['summary'];
    if (summary !== undefined && (typeof summary !== 'string' || summary.length === 0)) {
      return {
        ok: false,
        result: toErrorResult([
          {
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message:
              'proofloop_plan: `summary` must be a non-empty string when provided ' +
              'for admit_spv_result.',
          },
        ]),
      };
    }
    if (args['verdict'] !== SPV_VERDICT_GATE) {
      const label =
        args['verdict'] === undefined ? '(missing)' : JSON.stringify(args['verdict']);
      return {
        ok: false,
        result: toErrorResult([
          {
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message:
              `proofloop_plan: verdict must be exactly "SPV_PASS" for ` +
              `admit_spv_result (closed wire gate); got ${label}. The SPV_PASS ` +
              'gate is a wire-level gate and is never passed into the runtime ' +
              'request.',
          },
        ]),
      };
    }
  }
  return { ok: true, operation };
}

/**
 * Fully validated dispatch input handed to an operation handler. `projectRoot`
 * is always the canonical trust root; path resolution happens inside each
 * operation contract layer.
 */
export interface PlanDispatchInput {
  /** Canonical trust root (realpath of PluginInput.worktree). */
  projectRoot: string;
  /** Validated operation. */
  operation: PlanOperation;
  /** Raw caller args (validated operation + requiredness). */
  rawArgs: Record<string, unknown>;
}

/** Operation handler outcome: a unified S1 ToolResult (optionally with the
 * full compact status text fed to `renderCompact`). A plain ToolResult (the
 * three S03-A operation shape) remains valid — when the text is absent the
 * renderer derives it from the operation-specific projection. */
export type PlanOperationHandlerResult = {
  /** Unified S1 ToolResult. */
  result: ToolResult;
  /** Full status/admit summary text (status / admit_spv_result). */
  statusText?: string;
};

/** Operation handler outcome (ToolResult or enriched handler result). */
export type PlanOperationHandler = (
  input: PlanDispatchInput,
) => ToolResult | PlanOperationHandlerResult | Promise<ToolResult | PlanOperationHandlerResult>;

/**
 * Operation handler seam. S03-A-T01 wires the default handlers to the three
 * operation contract layers (`runPlanValidate` / `runPlanCompile` /
 * `runPlanInitialize`); S03-C-T01 wires `status` → `runPlanStatus` (the S2
 * reconcileStage read seam, read-only) and `admit_spv_result` →
 * `runPlanSpvAdmit` (the closed SPV_PASS adapter + runtime `admitSpvResult`).
 * Callers may still inject overrides for tests/extension. Handlers return the
 * unified S1 ToolResult (optionally with compact render text) — never a bare
 * value/throw.
 */
export interface PlanOperationHandlers {
  validate?: PlanOperationHandler;
  compile?: PlanOperationHandler;
  initialize_evidence?: PlanOperationHandler;
  status?: PlanOperationHandler;
  admit_spv_result?: PlanOperationHandler;
}

/**
 * Built-in handlers wired by default into `createPlanTool` (S03-A-T01 /
 * S03-C-T01). `spvAdmitDeps` (optional, TEST-ONLY) flows into the default
 * `admit_spv_result` handler so fault injection is routed through the REAL
 * built `createPlanTool(...).execute` host envelope (CV diagnose
 * CV-S03-C-POSTWRITE-TOCTOU-001 test-seam compliance) — a test supplies
 * `beforeAdmit` / `afterAdmit` via the factory seam and then calls `execute`;
 * production callers never pass deps.
 */
function defaultPlanHandlers(spvAdmitDeps?: PlanSpvAdmitDeps): PlanOperationHandlers {
  return {
    validate: (input) => runPlanValidate(input.projectRoot, input.rawArgs),
    compile: (input) => runPlanCompile(input.projectRoot, input.rawArgs),
    initialize_evidence: (input) => runPlanInitialize(input.projectRoot, input.rawArgs),
    status: (input) => runPlanStatus(input.projectRoot, input.rawArgs),
    admit_spv_result: (input) =>
      runPlanSpvAdmit(input.projectRoot, input.rawArgs, spvAdmitDeps),
  };
}

/**
 * Build the `proofloop_plan` ToolDefinition bound to the plugin RuntimeContext.
 *
 * Fail-closed zod boundary (S2 review finding S2-F-002): the tool registers
 * ONLY with the REAL host-accepted Zod raw-shape built from the vendored zod.
 * When the zod loader returns `undefined` (vendored zod absent/unresolvable)
 * the factory THROWS — the unverified structural descriptor is never used as
 * registration args. `index.ts` catches the throw and skips only this tool
 * (logger.warn), so `proofloop_doctor` (FR-006) stays available. The optional
 * `handlers` / `zodLoader` / `spvAdmitDeps` parameters are test seams;
 * production callers never pass them.
 *
 * Cancellation: `ToolContext.abort` is honored cooperatively — an already
 * aborted caller (or a completion after abort) propagates AbortError, never a
 * clean PASS or a Finding. The runtime reads are synchronous; the pre-check
 * (before dispatch) and the post-check (after the handler returns) satisfy the
 * cooperative boundary. This is the S03-B-identical post-completion abort
 * semantic (stage.ts execute does the same): an abort observed AFTER a
 * successful synchronous admit throws AbortError while the already-persisted
 * receipt remains as the completed durable outcome — the caller's abort does
 * not retroactively un-write it, and it is never reported as cancel-as-PASS
 * (the admission itself completed before the abort was observed).
 */
export function createPlanTool(
  context: RuntimeContext,
  handlers?: PlanOperationHandlers,
  zodLoader: PlanZodLoader = tryLoadVendoredZod,
  spvAdmitDeps?: PlanSpvAdmitDeps,
): PlanToolDefinition {
  const z = zodLoader();
  if (z === undefined) {
    throw createZodUnavailableError('proofloop_plan');
  }
  const toolArgs = buildPlanZodArgsShape(z);
  if (toolArgs === undefined) {
    throw createZodUnavailableError('proofloop_plan');
  }
  const activeHandlers = handlers ?? defaultPlanHandlers(spvAdmitDeps);
  return {
    description: PLAN_TOOL_DESCRIPTION,
    args: toolArgs,
    async execute(rawArgs, toolContext) {
      // Cooperative cancellation (host-compatibility #Cancellation): an
      // already-aborted caller must receive AbortError.
      if (isAborted(toolContext.abort)) {
        throw createAbortError();
      }

      const operationLabel = rawOperationLabel(rawArgs);
      const parsed = parsePlanArgs(rawArgs);
      if (!parsed.ok) {
        context.logger.warn('plan tool: rejected input', {
          operation: operationLabel,
          findings: parsed.result.findings,
        });
        return { output: renderPlanOutput(parsed.result, operationLabel) };
      }

      try {
        const handler = activeHandlers[parsed.operation];
        if (handler === undefined) {
          // Defensive: an explicit handler set with no entry for this
          // operation fails closed — never guess a result or fall through to
          // a write branch.
          const result = toErrorResult([
            {
              code: 'RUNTIME.SCHEMA_MISMATCH',
              severity: 'error',
              message:
                `proofloop_plan: operation "${parsed.operation}" is not ` +
                'wired to a handler.',
            },
          ]);
          context.logger.warn('plan tool: operation not wired', {
            operation: parsed.operation,
          });
          return { output: renderPlanOutput(result, parsed.operation) };
        }

        // The ONLY plan dispatch: the operation contract layer consumes the
        // runtime library in-process (never a CLI subprocess).
        const outcome = await handler({
          projectRoot: context.projectRoot,
          operation: parsed.operation,
          rawArgs: rawArgs as Record<string, unknown>,
        });

        // Post-execution cooperative cancellation check: the synchronous
        // runtime read cannot be interrupted mid-call, so the abort surfaced
        // during the read is observed here (host-compatibility #Cancellation).
        if (isAborted(toolContext.abort)) {
          throw createAbortError();
        }

        const { result, statusText } = normalizePlanHandlerResult(outcome);

        context.logger.info('plan tool: executed', {
          operation: parsed.operation,
          ok: result.ok,
          findingCount: result.findings.length,
          callerRole: toolContext.agent,
        });

        // S1 compact renderer: bounded operation summary (FR-012), findings
        // capped at FINDINGS_BUDGET, refs projected to exactly { ref, digest }.
        // Plan operations never fabricate Receipt refs — refs stay empty
        // (status is read-only; SPV refs come from the runtime AdmitResult).
        const statusTextFinal = statusText ?? renderPlanOperationText(parsed.operation, result);
        const view = renderCompact(
          { result, status: statusTextFinal, next: '' },
          { logger: context.logger },
        );
        return {
          output: renderPlanCompactOutput(view, parsed.operation, result),
        };
      } catch (error) {
        // Unified ToolResult error boundary: a bare exception never leaks into
        // the host envelope. Cancellation (AbortError) is the ONE error that
        // must propagate as an abort — never mapped to a Finding or reported
        // as a clean PASS.
        if (isAbortError(error)) {
          throw error;
        }
        const result = toErrorResult(error);
        return { output: renderPlanOutput(result, operationLabel) };
      }
    },
  };
}

function isPlanOperation(value: unknown): value is PlanOperation {
  return typeof value === 'string' && (PLAN_OPERATIONS as readonly string[]).includes(value);
}

/** Normalize a handler outcome (plain ToolResult or enriched handler result). */
function normalizePlanHandlerResult(
  outcome: ToolResult | PlanOperationHandlerResult,
): PlanOperationHandlerResult {
  if ((outcome as PlanOperationHandlerResult).result !== undefined) {
    return outcome as PlanOperationHandlerResult;
  }
  return { result: outcome as ToolResult };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** AbortError with the canonical `name` hosts expect (cooperative cancel). */
function createAbortError(): Error {
  const error = new Error('proofloop_plan was aborted by the caller');
  error.name = 'AbortError';
  return error;
}

/** Extract the raw `operation` label for output diagnostics (may be invalid). */
function rawOperationLabel(rawArgs: unknown): string | undefined {
  if (typeof rawArgs === 'object' && rawArgs !== null) {
    const operation = (rawArgs as Record<string, unknown>)['operation'];
    if (typeof operation === 'string' && operation.length > 0) {
      return operation;
    }
  }
  return undefined;
}
