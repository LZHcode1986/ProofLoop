/**
 * @proofloop/opencode-plugin — proofloop_stage tool definition (AWI-006).
 *
 * S02-A-T01: host tool definition skeleton + operation contract + path guard +
 * unified ToolResult error boundary. This is the contract layer that T02 wires
 * to `reconcileStage` (status) and `NextActionService.nextAction` (next); the
 * layer is delivered now with tests so later slices (S02-B/S02-C/S02-D) consume
 * the same canonical-root / result / failure seams.
 *
 * S02-A-T02: the two operation handlers are wired to the runtime public seams
 * and injected by default into `createStageTool`:
 *   - `status` → `reconcileStage` (the ONLY status read seam) → a bounded
 *     status summary (≤1000 UTF-16 chars) whose ToolResult `data` is a compact
 *     facts projection — never the full reconcile object, never Receipt
 *     bodies; error-level reconcile findings fail closed (ok:false).
 *   - `next` → `NextActionService.nextAction` (the ONLY next-action derivation
 *     entry) → the canonical 5-key NextActionOutput preserved verbatim,
 *     compact ≤1500 UTF-16 chars, findings ≤20.
 * The plugin never reimplements `deriveNextAction`, never assembles its own
 * stage state machine, and never writes Receipts directly (OUT-S2-05 read-only
 * for the S2 ops; the S03-B admit ops write ONLY through the runtime admit
 * methods).
 *
 * S03-B-T01 (AWI-008 slice subset): the operation contract is extended with
 * the four S3 admission operations `admit_worker_result` | `admit_cv_result` |
 * `admit_slice_commit` | `admit_integration`. The admit ops dispatch
 * IN-PROCESS to the runtime public seams (`admitWorkerResult` / `admitCVResult`
 * / `admitSliceCommit` / `admitIntegration`) through the shared
 * `stage-admit-common` adapter boundary (snake_case → camelCase
 * `AdmissionRequest` mapper, outer/inner binding, path-valued field guard,
 * canonical AdmitResult projection) — never a CLI subprocess, never direct
 * `writeReceipt` / `runAdmitPipeline` assembly. `run_gate`,
 * `admit_gate_result`, `admit_gate_interrupted`, `stage_plan`,
 * `admit_stage_plan`, `compile_acceptance`, `run_e2e`, project-review ops and
 * ANY unknown value fail closed with a canonical Finding at the execute
 * boundary (never a fallthrough, never a silent alias, never a read-only
 * downgrade of a write op).
 *
 * Host shape (tech-spec/host-compatibility.md #自定义工具注册与调用): the tool
 * registers as `tool({ description, args, execute })`; the host API field name
 * is `args` (Zod raw-shape), NOT `inputSchema`, and the host exposes translated
 * `parameters`. `ToolContext.abort` is an AbortSignal (cooperative cancellation
 * — an abort must propagate AbortError, never be reported as a clean PASS);
 * `ToolContext.agent` is the caller role.
 *
 * Args shape / zod tradeoff (zero new runtime dependencies):
 *   - The built plugin lives at `packages/opencode-plugin/dist` and must never
 *     crash when `zod` is not resolvable from its node_modules chain. `zod` is
 *     only present in the host's `.opencode/node_modules`, which Node cannot
 *     resolve from the plugin dist at runtime without adding a dependency.
 *   - Therefore the tool factory registers a REAL host-accepted Zod raw-shape
 *     (`tool.args`) built from the vendored zod when it resolves. FAIL-CLOSED
 *     (S2 review finding S2-F-002): when the vendored zod is unavailable the
 *     factory THROWS — the structural `STAGE_TOOL_ARGS_FALLBACK` descriptor is
 *     never used as registration args because it has not been verified on the
 *     real host seam. `index.ts` catches the throw and skips only this tool
 *     (keeping `proofloop_doctor` available per FR-006).
 *   - execute never trusts the shape: every input is validated defensively at
 *     the boundary (security hardening) and fails closed with a canonical
 *     Finding on malformed input.
 *
 * Operation contract (tech-spec/contract-state-matrix.md#§1.2): `status` and
 * `next` are the S2 read operations; the four S3 admit operations
 * (`admit_worker_result` | `admit_cv_result` | `admit_slice_commit` |
 * `admit_integration`) map to the runtime `AdmissionRequest` members. Every
 * other operation (`run_gate`, gate/project/plan operations, unknown values)
 * fails closed with a canonical Finding and never reaches a dispatch/write
 * branch.
 *
 * Path guard (S2 constraints): `projectRoot` always comes from the canonical
 * `RuntimeContext` root (realpath of `PluginInput.worktree`, ADR-004). A
 * caller-supplied `project_root` is a canonical-root consistency assertion
 * only — a mismatch fails closed (HOST.PROJECT_NOT_TRUSTED) instead of
 * overriding the trust root. Absolute `manifest_path`/`tasks_path` must stay
 * inside the trust root; out-of-bounds → HOST.PATH_OUTSIDE_PROJECT. Admit
 * path-valued fields (envelope evidenceRef / changedFiles / integration_ref)
 * are root-bound + canonicalized through the shared `guardAdmitPathFields`
 * boundary.
 *
 * Error boundary (S1 tool-result): the unified `toErrorResult` mapping wraps
 * every dispatch — a bare exception never leaks into the ToolResult or the
 * host `{ output }` envelope; cancellation (AbortError) is the one error that
 * propagates as an abort.
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ToolContext, ToolResult as HostToolResult } from '@opencode-ai/plugin';
import {
  NextActionService,
  defaultManifestPath,
  defaultTasksMdPath,
  reconcileStage,
} from '@proofloop/runtime';
import type { NextActionOutput, ReconcileStageResult } from '@proofloop/runtime';
import type { Finding } from '@proofloop/kernel';
import type { z as ZodNamespace } from 'zod';
import { FINDINGS_BUDGET, renderCompact, serializeStructuredData } from '../compact.js';
import type { CompactView } from '../compact.js';
import { successResult, toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import type { RuntimeContext } from '../host-context.js';
import type { LoggerAdapter } from '../adapters/logger.js';
// Shared trust-root boundary helpers (CV S02-B-INITIAL-PO01-SYMLINK): every
// existing ancestor component is realpath-checked, not just the final target,
// so a symlink-parent escape is rejected even when the target does not exist.
import { isWithinRoot, resolveWithinRoot } from '../path-boundary.js';
// Manifest content trust-root guard (S2 review finding S2-F-001): the runtime
// derives read paths from manifest CONTENT fields (slice.evidence_path /
// slice_id) that a schema-valid malicious manifest can point outside the
// worktree. The guard fails closed BEFORE the runtime is called, the post-read
// TOCTOU closure re-verifies the manifest content after the runtime call
// (round 2), and `reverifyManifestPathIdentity` re-verifies the manifest PATH
// identity before the baseline and after the post-check (round 3).
import {
  CANONICAL_SLICE_ID,
  checkManifestContentBaseline,
  reverifyManifestContentAfterRead,
  reverifyManifestPathIdentity,
} from '../manifest-guard.js';
// S03-B-T01 shared admission contract layer: the extended operation set, the
// snake_case → camelCase AdmissionRequest mapper, the path-valued field guard,
// the shared TOCTOU identity re-verify and the canonical AdmitResult
// projection. The default admit handlers live in `stage-admit.ts`.
import {
  REQUIRED_ADMIT_FIELDS_BY_OPERATION,
  STAGE_ALL_OPERATIONS,
  isStageAdmitOperation,
  isStageOperation,
  rejectStageOperation,
  reverifyStagePaths,
} from './stage-admit-common.js';
import type { StageAdmitOperation, StageAdmitWireArgs } from './stage-admit-common.js';
import {
  runStageAdmitCvResult,
  runStageAdmitIntegration,
  runStageAdmitSliceCommit,
  runStageAdmitWorkerResult,
} from './stage-admit.js';
import type { StageAdmitDeps } from './stage-admit.js';

/** Canonical tool key registered by the host (AWI-006). */
export const STAGE_TOOL_NAME = 'proofloop_stage';

/**
 * Legal operations (contract-state-matrix.md#§1.2): S2 `status`/`next` plus
 * the S03-B admit operations. The closed set and the `StageOperation` type are
 * owned by the shared `stage-admit-common` contract layer.
 */
export const STAGE_OPERATIONS = STAGE_ALL_OPERATIONS;

/** Legal operation value. */
export type StageOperation = (typeof STAGE_OPERATIONS)[number];

/** Human-readable tool description exposed to the host. */
export const STAGE_TOOL_DESCRIPTION =
  'Query and drive a ProofLoop stage through the canonical worktree trust ' +
  'root: `status` returns a bounded stage summary derived from reconcileStage, ' +
  '`next` returns the single canonical NextAction derived by ' +
  'NextActionService, and the four admit operations (admit_worker_result, ' +
  'admit_cv_result, admit_slice_commit, admit_integration) admit Executor ' +
  'results through the runtime admission pipeline. Unsupported operations ' +
  '(run_gate, gate/project/plan operations, unknown values) fail closed.';

/**
 * Structural stand-in for one host Zod raw-shape field. Kept as the
 * documented structural reference shape; NEVER used as the registered `args`
 * (S2-F-002 fail-closed — see `STAGE_TOOL_ARGS_FALLBACK`).
 */
export interface StageArgFieldSpec {
  /** Field kind: fixed string or closed enum. */
  type: 'string' | 'enum';
  /** Human-readable field description. */
  description: string;
  /** True for optional fields (all S2 optional inputs). */
  optional?: boolean;
  /** Legal values for `type: 'enum'`. */
  values?: readonly string[];
}

/**
 * One field of the host-accepted `args` shape: a REAL Zod schema (the ONLY
 * shape the tool factory registers — S2-F-002 fail-closed) or a structural
 * stand-in kept as a documented reference shape. The host
 * `tool<Args extends z.ZodRawShape>` contract accepts the real schema; the
 * structural stand-in is never substituted for a missing zod.
 */
export type StageToolArgsField =
  | StageArgFieldSpec
  | {
      readonly _def: unknown;
      readonly description?: string;
      readonly options?: readonly string[];
    };

/**
 * Host-accepted `args` shape for `proofloop_stage`. Field names are the
 * canonical operation inputs: `operation`, `stage_id`, optional `slice_id`
 * (required for the four admit operations), optional `project_root`
 * (canonical-root consistency assertion), optional `manifest_path` /
 * `tasks_path` (status/next) and the operation-dependent admit wire fields
 * (`envelope` for admit_worker_result, `verdict` / `snapshot_digest` /
 * `summary` for admit_cv_result, `commit_sha` / `cv_receipt_digest` for
 * admit_slice_commit, `commit_sha` / `integration_ref` for admit_integration).
 * Requiredness is enforced in execute's fail-closed second validation
 * (`parseStageArgs`), NEVER by the host schema alone.
 */
export interface StageToolArgsShape {
  operation: StageToolArgsField;
  stage_id: StageToolArgsField;
  slice_id: StageToolArgsField;
  project_root: StageToolArgsField;
  manifest_path: StageToolArgsField;
  tasks_path: StageToolArgsField;
  envelope: StageToolArgsField;
  verdict: StageToolArgsField;
  snapshot_digest: StageToolArgsField;
  commit_sha: StageToolArgsField;
  cv_receipt_digest: StageToolArgsField;
  integration_ref: StageToolArgsField;
  summary: StageToolArgsField;
}

/**
 * Structural fallback `args` shape. Retained as the documented structural
 * reference shape ONLY — NEVER used as the registered `args` (S2-F-002
 * fail-closed: the unverified structural descriptor must not be substituted
 * for the vendored-zod raw-shape). Fields are `StageArgFieldSpec` descriptors
 * — the shape is a subtype of `StageToolArgsShape` (each field satisfies the
 * `StageToolArgsField` union).
 */
export interface StageToolArgsFallbackShape {
  operation: StageArgFieldSpec & { values: readonly StageOperation[] };
  stage_id: StageArgFieldSpec;
  slice_id: StageArgFieldSpec;
  project_root: StageArgFieldSpec;
  manifest_path: StageArgFieldSpec;
  tasks_path: StageArgFieldSpec;
  envelope: StageArgFieldSpec;
  verdict: StageArgFieldSpec;
  snapshot_digest: StageArgFieldSpec;
  commit_sha: StageArgFieldSpec;
  cv_receipt_digest: StageArgFieldSpec;
  integration_ref: StageArgFieldSpec;
  summary: StageArgFieldSpec;
}

export const STAGE_TOOL_ARGS_FALLBACK: StageToolArgsFallbackShape = {
  operation: {
    type: 'enum',
    values: [...STAGE_OPERATIONS],
    description:
      'Operation to run: `status`, `next`, `admit_worker_result`, `admit_cv_result`, `admit_slice_commit` or `admit_integration`.',
  },
  stage_id: {
    type: 'string',
    description: 'Canonical stage id to reconcile or admit against (e.g. S3).',
  },
  slice_id: {
    type: 'string',
    optional: true,
    description:
      'Canonical slice id (e.g. S03-B). Required for the four admit operations.',
  },
  project_root: {
    type: 'string',
    optional: true,
    description:
      'Canonical project root assertion. May only assert consistency with the trusted worktree; never overrides it.',
  },
  manifest_path: {
    type: 'string',
    optional: true,
    description:
      'Manifest path. Relative paths resolve against the trust root; absolute paths must stay inside it.',
  },
  tasks_path: {
    type: 'string',
    optional: true,
    description:
      'tasks.md path. Relative paths resolve against the trust root; absolute paths must stay inside it.',
  },
  envelope: {
    type: 'string',
    optional: true,
    description:
      'WorkerResultEnvelope raw object for admit_worker_result (closed schema validated in execute).',
  },
  verdict: {
    type: 'enum',
    values: ['PASS', 'REPAIR'],
    optional: true,
    description: 'CV verdict for admit_cv_result (closed {PASS, REPAIR}).',
  },
  snapshot_digest: {
    type: 'string',
    optional: true,
    description: 'Snapshot digest binding for admit_cv_result.',
  },
  commit_sha: {
    type: 'string',
    optional: true,
    description: 'Commit SHA for admit_slice_commit / admit_integration.',
  },
  cv_receipt_digest: {
    type: 'string',
    optional: true,
    description: 'CV_PASS receipt digest binding for admit_slice_commit.',
  },
  integration_ref: {
    type: 'string',
    optional: true,
    description:
      'Non-authoritative host metadata for admit_integration (root-checked; never a request member).',
  },
  summary: {
    type: 'string',
    optional: true,
    description: 'Summary for admit_cv_result.',
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
function buildZodArgsShape(z: typeof ZodNamespace): StageToolArgsShape | undefined {
  try {
    const schema = z.object({
      operation: z
        .enum([...STAGE_OPERATIONS])
        .describe(
          'Operation to run: `status`, `next`, `admit_worker_result`, `admit_cv_result`, `admit_slice_commit` or `admit_integration`.',
        ),
      stage_id: z
        .string()
        .min(1)
        .describe('Canonical stage id to reconcile or admit against (e.g. S3).'),
      slice_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Canonical slice id (e.g. S03-B). Required for the four admit operations.',
        ),
      project_root: z
        .string()
        .optional()
        .describe(
          'Canonical project root assertion. May only assert consistency with the trusted worktree; never overrides it.',
        ),
      manifest_path: z
        .string()
        .optional()
        .describe(
          'Manifest path. Relative paths resolve against the trust root; absolute paths must stay inside it.',
        ),
      tasks_path: z
        .string()
        .optional()
        .describe(
          'tasks.md path. Relative paths resolve against the trust root; absolute paths must stay inside it.',
        ),
      envelope: z
        .any()
        .optional()
        .describe(
          'WorkerResultEnvelope raw object for admit_worker_result (closed schema validated in execute).',
        ),
      verdict: z
        .enum(['PASS', 'REPAIR'])
        .optional()
        .describe('CV verdict for admit_cv_result (closed {PASS, REPAIR}).'),
      snapshot_digest: z
        .string()
        .optional()
        .describe('Snapshot digest binding for admit_cv_result.'),
      commit_sha: z
        .string()
        .optional()
        .describe('Commit SHA for admit_slice_commit / admit_integration.'),
      cv_receipt_digest: z
        .string()
        .optional()
        .describe('CV_PASS receipt digest binding for admit_slice_commit.'),
      integration_ref: z
        .string()
        .optional()
        .describe(
          'Non-authoritative host metadata for admit_integration (root-checked; never a request member).',
        ),
      summary: z
        .string()
        .optional()
        .describe('Summary for admit_cv_result.'),
    });
    return schema.shape as unknown as StageToolArgsShape;
  } catch {
    return undefined;
  }
}

const vendoredZod = tryLoadVendoredZod();

/**
 * The `args` the tool factory registers — a REAL host-accepted Zod raw-shape
 * built from the vendored zod (v4). Fail-closed (S2-F-002): when the vendored
 * zod is unavailable this is `undefined` and `createStageTool` refuses to
 * register — the structural `STAGE_TOOL_ARGS_FALLBACK` descriptor is NEVER
 * used as registration args because it has not been verified on the real host
 * seam.
 */
export const STAGE_TOOL_ARGS: StageToolArgsShape | undefined =
  vendoredZod !== undefined ? buildZodArgsShape(vendoredZod) : undefined;

/**
 * True when the vendored-zod host-accepted args shape is available for
 * registration (S2-F-002). The plugin entry consults this before attempting
 * to register `proofloop_stage`; the factory re-checks the loader as its own
 * fail-closed boundary.
 */
export function isStageToolArgsAvailable(): boolean {
  return STAGE_TOOL_ARGS !== undefined;
}

/**
 * Loader for the vendored zod used by the tool factory (S2-F-002 test seam).
 * The default is the real `tryLoadVendoredZod`; tests inject a stub that
 * returns `undefined` to prove the fail-closed registration path.
 */
export type StageZodLoader = () => typeof ZodNamespace | undefined;

/** Fail-closed factory error when the vendored zod raw-shape is unavailable. */
export function createZodUnavailableError(toolLabel: string): Error {
  return new Error(
    `${toolLabel} cannot register: the vendored zod runtime is unavailable; ` +
      'refusing to fall back to an unverified structural args descriptor (fail-closed).',
  );
}

/**
 * Fully validated canonical operation input handed to the T02 handler seam.
 * `projectRoot` is always the canonical trust root; optional paths are absolute
 * and proven inside the root.
 */
export interface StageResolvedArgs {
  /** Validated operation. */
  operation: StageOperation;
  /** Canonical stage id. */
  stageId: string;
  /** Canonical trust root (realpath of PluginInput.worktree). */
  projectRoot: string;
  /** Resolved absolute manifest path inside the trust root. */
  manifestPath?: string;
  /** Resolved absolute tasks.md path inside the trust root. */
  tasksPath?: string;
  /**
   * Admit-operation wire args (canonical slice id + raw host args). Present
   * only for the four admit operations; the mapper consumes it as the single
   * snake_case → camelCase adapter boundary.
   */
  admit?: StageAdmitWireArgs;
}

/**
 * Handler outcome: the unified S1 ToolResult plus the full render text(s) fed
 * to the S1 compact renderer (FR-012 budgets). A plain ToolResult (T01 shape)
 * remains valid — when the text is absent the compact view renders empty and
 * the output carries the status/findings envelope only.
 */
export interface StageHandlerResult {
  /** Unified S1 ToolResult. */
  result: ToolResult;
  /** Full status summary text (status op) fed to renderCompact. */
  statusText?: string;
  /** Full next-action text (next op) fed to renderCompact. */
  nextText?: string;
}

/**
 * Operation handler seam. T02 wires `status` to `reconcileStage` and `next` to
 * `NextActionService.nextAction`; S03-B-T01 wires the four admit operations to
 * the runtime admit methods (the built-in `defaultStageHandlers`); callers may
 * still inject overrides for tests/extension. Handlers return the unified S1
 * ToolResult (optionally with compact render text) — never a bare
 * value/throw.
 *
 * The optional `logger` is the host logger adapter (from `ToolContext`).
 * S03-B REPAIR: the admit handlers receive it so host metadata (e.g. the
 * integration `integration_ref`) is logged ONLY after the path guard passes
 * (validate → guard → log → dispatch) — never before root validation.
 */
export interface StageOperationHandlers {
  status?(
    input: StageResolvedArgs,
    logger?: LoggerAdapter,
  ): ToolResult | StageHandlerResult | Promise<ToolResult | StageHandlerResult>;
  next?(
    input: StageResolvedArgs,
    logger?: LoggerAdapter,
  ): ToolResult | StageHandlerResult | Promise<ToolResult | StageHandlerResult>;
  admit_worker_result?(
    input: StageResolvedArgs,
    logger?: LoggerAdapter,
  ): ToolResult | StageHandlerResult | Promise<ToolResult | StageHandlerResult>;
  admit_cv_result?(
    input: StageResolvedArgs,
    logger?: LoggerAdapter,
  ): ToolResult | StageHandlerResult | Promise<ToolResult | StageHandlerResult>;
  admit_slice_commit?(
    input: StageResolvedArgs,
    logger?: LoggerAdapter,
  ): ToolResult | StageHandlerResult | Promise<ToolResult | StageHandlerResult>;
  admit_integration?(
    input: StageResolvedArgs,
    logger?: LoggerAdapter,
  ): ToolResult | StageHandlerResult | Promise<ToolResult | StageHandlerResult>;
}

/** Host-visible tool definition (matches the `tool(...)` return shape). */
export interface StageToolDefinition {
  description: string;
  args: StageToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<HostToolResult>;
}

/** Result of the contract-layer parse: resolved args or a fail-closed result. */
export type StageParseResult =
  | { ok: true; args: StageResolvedArgs }
  | { ok: false; result: ToolResult };

/**
 * Parse and validate the raw caller args against the canonical trust root.
 *
 * Fail-closed contract layer:
 *   - `operation` must be one of the 6 legal operations (status | next | the
 *     four admit operations); every other value (run_gate, gate/project/plan
 *     operations, unknown values) is rejected with a canonical Finding via
 *     `rejectStageOperation` and never reaches a dispatch branch.
 *   - `stage_id` is required for every operation.
 *   - For the four admit operations: `slice_id` is required and must match the
 *     canonical slice charset (`/^S\d{2,}-[A-Z]$/`, e.g. S03-B) — a
 *     non-canonical id carrying separators / `..` / absolute segments is
 *     rejected before any runtime call; the operation-dependent required host
 *     fields (`REQUIRED_ADMIT_FIELDS_BY_OPERATION`) must be present and
 *     well-typed.
 *   - `project_root` is a consistency assertion only; a mismatch fails closed
 *     with HOST.PROJECT_NOT_TRUSTED.
 *   - absolute `manifest_path` / `tasks_path` (status/next only) must stay
 *     inside the trust root; out-of-bounds → HOST.PATH_OUTSIDE_PROJECT;
 *     relative paths resolve inside the root.
 *
 * Every failure is a canonical kernel Finding verified through the S1
 * `toErrorResult` boundary (never a bare exception).
 */
export function parseStageArgs(
  rawArgs: unknown,
  canonicalRoot: string,
): StageParseResult {
  if (typeof rawArgs !== 'object' || rawArgs === null) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_stage: args must be an object carrying an `operation` field.',
      },
    ]);
  }
  const args = rawArgs as Record<string, unknown>;

  const operation = args['operation'];
  if (typeof operation !== 'string' || operation.length === 0) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_stage: `operation` is required and must be one of: status, ' +
          'next, admit_worker_result, admit_cv_result, admit_slice_commit, ' +
          'admit_integration.',
      },
    ]);
  }
  if (!isStageOperation(operation)) {
    return rejectStageOperation(operation);
  }

  const stageId = args['stage_id'];
  if (typeof stageId !== 'string' || stageId.length === 0) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_stage: `stage_id` is required and must be a non-empty string.',
      },
    ]);
  }
  // Canonical stage id guard (CV S02-A-PO01-PO04-PATH-ARGS-SCOPE). The runtime
  // derives its DEFAULT manifest/tasks/receipt paths from `stageId`
  // (defaultManifestPath / defaultTasksMdPath / receiptCategoryDir all
  // path.join(stageId)); a non-canonical id carrying separators / `..` /
  // absolute segments would resolve those defaults OUTSIDE the trust root
  // without ever reaching the optional-path guard. A canonical stage id
  // (`/^S\d+$/`, e.g. S2) can never traverse, so the default reads stay inside
  // the canonical worktree.
  if (!CANONICAL_STAGE_ID.test(stageId)) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          `proofloop_stage: stage_id "${stageId}" is not a canonical stage id ` +
          '(expected /^S\\d+$/, e.g. S2); path traversal / absolute paths are ' +
          'rejected before any runtime read.',
      },
    ]);
  }
  // Default-path boundary (defense-in-depth): the runtime's default manifest /
  // tasks paths for the (now canonical) stage id are explicitly verified to
  // stay inside the trust root, so the defaulting can never escape even if the
  // id-format guard were bypassed by a future runtime change.
  const defaultBoundary = checkDefaultStagePaths(canonicalRoot, stageId);
  if (defaultBoundary !== null) {
    return { ok: false, result: defaultBoundary };
  }

  // `project_root` — canonical-root consistency assertion only (never overrides
  // the trust root, ADR-004). A mismatch is a trust-boundary violation.
  const projectRootArg = args['project_root'];
  if (projectRootArg !== undefined) {
    if (typeof projectRootArg !== 'string' || projectRootArg.length === 0) {
      return failClosed([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'proofloop_stage: `project_root` must be a non-empty string when provided.',
        },
      ]);
    }
    const assertedRoot = canonicalizeRoot(projectRootArg);
    if (assertedRoot !== canonicalRoot) {
      return failClosed([
        {
          code: 'HOST.PROJECT_NOT_TRUSTED',
          severity: 'error',
          message:
            `proofloop_stage: project_root "${projectRootArg}" does not match ` +
            `the canonical worktree trust root (${canonicalRoot}); project_root ` +
            'can only assert consistency, never override the trust root.',
        },
      ]);
    }
  }

  // Admit operations: canonical slice id + operation-dependent requiredness.
  if (isStageAdmitOperation(operation)) {
    return parseStageAdmitArgs(operation, args, stageId, canonicalRoot);
  }
  const manifestArg = args['manifest_path'];
  let manifestPath: string | undefined;
  if (manifestArg !== undefined) {
    if (typeof manifestArg !== 'string' || manifestArg.length === 0) {
      return failClosed([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'proofloop_stage: `manifest_path` must be a non-empty string when provided.',
        },
      ]);
    }
    const resolved = resolveWithinRoot(canonicalRoot, manifestArg);
    if (resolved === null) {
      return failClosed([
        {
          code: 'HOST.PATH_OUTSIDE_PROJECT',
          severity: 'error',
          message:
            `proofloop_stage: manifest_path "${manifestArg}" resolves outside ` +
            `the trust root (${canonicalRoot}).`,
        },
      ]);
    }
    manifestPath = resolved;
  }

  const tasksArg = args['tasks_path'];
  let tasksPath: string | undefined;
  if (tasksArg !== undefined) {
    if (typeof tasksArg !== 'string' || tasksArg.length === 0) {
      return failClosed([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'proofloop_stage: `tasks_path` must be a non-empty string when provided.',
        },
      ]);
    }
    const resolved = resolveWithinRoot(canonicalRoot, tasksArg);
    if (resolved === null) {
      return failClosed([
        {
          code: 'HOST.PATH_OUTSIDE_PROJECT',
          severity: 'error',
          message:
            `proofloop_stage: tasks_path "${tasksArg}" resolves outside the ` +
            `trust root (${canonicalRoot}).`,
        },
      ]);
    }
    tasksPath = resolved;
  }

  return {
    ok: true,
    args: {
      operation,
      stageId,
      projectRoot: canonicalRoot,
      ...(manifestPath !== undefined ? { manifestPath } : {}),
      ...(tasksPath !== undefined ? { tasksPath } : {}),
    },
  };
}

/**
 * Admit-operation parse: canonical `slice_id` (identifier charset guard) +
 * operation-dependent required field presence/type (enforced by execute's
 * fail-closed second validation — NEVER by the host schema alone).
 *
 * The `slice_id` charset (`/^S\d{2,}-[A-Z]$/`, e.g. S03-B) is the same guard
 * the manifest-content boundary uses: a non-canonical id carrying separators /
 * `..` / absolute segments would resolve the runtime `receiptCategoryDir`
 * joins OUTSIDE the trust root, so it is rejected before any runtime call.
 */
function parseStageAdmitArgs(
  operation: StageAdmitOperation,
  args: Record<string, unknown>,
  stageId: string,
  canonicalRoot: string,
): StageParseResult {
  const sliceId = args['slice_id'];
  if (typeof sliceId !== 'string' || sliceId.length === 0) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          `proofloop_stage: \`slice_id\` is required for operation "${operation}" ` +
          'and must be a non-empty string.',
      },
    ]);
  }
  if (!CANONICAL_SLICE_ID.test(sliceId)) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          `proofloop_stage: slice_id "${sliceId}" is not a canonical slice id ` +
          '(expected /^S\\d{2,}-[A-Z]$/, e.g. S03-B); path traversal / absolute ' +
          'paths are rejected before any runtime call.',
      },
    ]);
  }

  for (const field of REQUIRED_ADMIT_FIELDS_BY_OPERATION[operation]) {
    const value = args[field];
    if (field === 'envelope') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return failClosed([
          {
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message:
              `proofloop_stage: \`envelope\` is required for operation "${operation}" ` +
              'and must be a non-null, non-array object.',
          },
        ]);
      }
    } else if (typeof value !== 'string' || value.length === 0) {
      return failClosed([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            `proofloop_stage: \`${field}\` is required for operation "${operation}" ` +
            'and must be a non-empty string.',
        },
      ]);
    }
  }

  return {
    ok: true,
    args: {
      operation,
      stageId,
      projectRoot: canonicalRoot,
      admit: { stageId, sliceId, rawArgs: args },
    },
  };
}

/**
 * Render a unified ToolResult into the host `{ output }` envelope.
 *
 * T01 minimal honest projection: the operation label (when known), the overall
 * status and every canonical finding code/message. T02 extends this into the
 * bounded status/next compact rendering (FR-012 budgets); the finding codes
 * here are always canonical kernel codes.
 */
export function renderStageOutput(
  result: ToolResult,
  operation?: string,
): string {
  const lines: string[] = ['ProofLoop Stage'];
  if (operation !== undefined) {
    lines.push(`Operation: ${operation}`);
  }
  lines.push(`Status: ${result.ok ? 'ok' : 'failed'}`);
  if (result.ok && result.data !== undefined) {
    // U+2028/U+2029 escaped for a stable single-line Data payload (same fix as
    // plan.ts — CV S02-B-RECHECK-PO02-DATA-LINE).
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

// ============================================================
// S02-A-T02 wiring: status → reconcileStage, next → NextActionService
// ============================================================

/** Stateless runtime seam instance (NextActionService holds no state, HP-003). */
const nextActionService = new NextActionService();

/**
 * Project the `ReconcileStageResult` into the status ToolResult `data`.
 *
 * Only canonical scalar facts are exposed: stage id/state, project state,
 * chain validity and a per-slice summary (state, cv, task counts, flags).
 * NEVER the full reconcile object, NEVER `receipt_chain` digests and NEVER
 * Receipt bodies (`latest_cv_receipt` / `latest_commit_receipt` stay out).
 */
export function projectStageStatusData(
  reconciled: ReconcileStageResult,
): Record<string, unknown> {
  return {
    stage_id: reconciled.stage_id,
    stage_state: reconciled.stage_state,
    project_state: reconciled.project_state,
    receipt_chain_valid: reconciled.receipt_chain_valid,
    slices: reconciled.slices.map((s) => ({
      slice_id: s.slice_id,
      slice_state: s.slice_state,
      cv_status: s.cv_status,
      tasks_checked: s.tasks.filter((t) => t.checked).length,
      tasks_total: s.tasks.length,
      slice_evidence_finalized: s.slice_evidence_finalized,
      repair_attempt: s.repair_attempt,
      complete: s.complete,
      integrated: s.integrated,
      committed: s.committed,
    })),
  };
}

/**
 * Project the canonical `NextActionOutput` into the next ToolResult `data`.
 * The full 5-key payload is preserved verbatim — never reordered, simplified
 * or re-derived (the runtime's `deriveNextAction` priority table stays the
 * single authority).
 */
export function projectStageNextData(output: NextActionOutput): Record<string, unknown> {
  return {
    action: output.action,
    action_detail: output.action_detail,
    responsible_role: output.responsible_role,
    receipt_chain_valid: output.receipt_chain_valid,
    findings: output.findings,
  };
}

/**
 * Full status summary text derived from the reconciled facts. The S1 compact
 * renderer caps this to STATUS_BUDGET (≤1000 UTF-16 chars, FR-012). The text
 * carries only canonical scalar facts — no Receipt payloads.
 */
export function renderStageStatusText(reconciled: ReconcileStageResult): string {
  const lines: string[] = [];
  lines.push(`Stage: ${reconciled.stage_id}`);
  lines.push(`State: ${reconciled.stage_state}`);
  lines.push(`Project: ${reconciled.project_state}`);
  lines.push(
    `Receipt chain: ${reconciled.receipt_chain_valid ? 'valid' : 'invalid'}`,
  );
  lines.push(`Slices (${reconciled.slices.length}):`);
  for (const slice of reconciled.slices) {
    const checked = slice.tasks.filter((t) => t.checked).length;
    lines.push(
      `- ${slice.slice_id}: state=${slice.slice_state} cv=${slice.cv_status} ` +
        `tasks=${checked}/${slice.tasks.length} ` +
        `evidence_finalized=${slice.slice_evidence_finalized} ` +
        `repairs=${slice.repair_attempt} complete=${slice.complete} ` +
        `integrated=${slice.integrated} committed=${slice.committed}`,
    );
  }
  return lines.join('\n');
}

/**
 * Full next-action text derived from the canonical NextActionOutput. The S1
 * compact renderer caps this to NEXT_BUDGET (≤1500 UTF-16 chars, FR-012).
 */
export function renderStageNextText(output: NextActionOutput): string {
  const lines: string[] = [];
  lines.push(`Action: ${output.action}`);
  lines.push(`Detail: ${output.action_detail}`);
  lines.push(`Role: ${output.responsible_role}`);
  lines.push(`Chain valid: ${output.receipt_chain_valid}`);
  return lines.join('\n');
}

/**
 * `status` handler — the real wiring to the runtime `reconcileStage` read
 * seam. The plugin never assembles its own state machine: status is derived
 * only from the persisted-facts reconcile output. The reconcile field name for
 * the tasks.md path is `tasksMdPath` (NextActionService uses `tasksPath`).
 *
 * Fail-closed: when reconcile reports error-level findings (e.g. missing
 * manifest → DOMAIN.STAGE_NOT_FOUND) the ToolResult is `ok:false` with the
 * canonical findings — never a guessed state, never a fake PASS. Warn-level
 * findings keep `ok:true` (recoverable, surfaced as findings).
 */
export function stageStatusHandler(input: StageResolvedArgs): StageHandlerResult {
  const reverified = reverifyStagePaths(input);
  if (reverified !== null) {
    return { result: reverified };
  }
  // Manifest content trust-root guard (S2-F-001): the runtime derives its
  // read paths from manifest content fields, so a schema-valid malicious
  // manifest must be rejected BEFORE reconcileStage is called. The guard
  // re-reads the canonical manifest path (explicit or the stage default) and
  // captures the pre-read baseline for the post-read TOCTOU closure below.
  const manifestPath =
    input.manifestPath ?? defaultManifestPath(input.projectRoot, input.stageId);
  // Path identity re-verify BEFORE the baseline read (S2-F-001 round 3): a
  // manifest path swapped to an external symlink between reverifyStagePaths
  // and the baseline would otherwise make baseline/runtime/post-check all read
  // the SAME external manifest (identical digest) and pass the content checks.
  const identity = reverifyManifestPathIdentity(input.projectRoot, manifestPath);
  if (!identity.ok) {
    return { result: identity.result };
  }
  const pre = checkManifestContentBaseline(input.projectRoot, identity.path);
  if (!pre.ok) {
    return { result: pre.result };
  }
  const reconciled = reconcileStage({
    projectRoot: input.projectRoot,
    stageId: input.stageId,
    manifestPath: input.manifestPath,
    tasksMdPath: input.tasksPath,
  });
  // Post-read TOCTOU closure (S2-F-001 round 2): the runtime re-read the
  // manifest / evidence files after the pre-check. Re-verify the manifest
  // content is UNCHANGED; a swap during the call discards the runtime result.
  const toctou = reverifyManifestContentAfterRead(
    input.projectRoot,
    identity.path,
    pre.baseline,
  );
  if (toctou !== null) {
    return { result: toctou };
  }
  // Final path identity re-verify AFTER the post-check (S2-F-001 round 3): a
  // manifest path swapped after the post-check read must discard the result.
  const finalIdentity = reverifyManifestPathIdentity(
    input.projectRoot,
    identity.path,
  );
  if (!finalIdentity.ok) {
    return { result: finalIdentity.result };
  }
  const data = projectStageStatusData(reconciled);
  const findings = capFindings(reconciled.findings);
  const base = successResult({ data, findings });
  const result: ToolResult = hasErrorFindings(base.findings)
    ? { ...base, ok: false }
    : base;
  return { result, statusText: renderStageStatusText(reconciled) };
}

/**
 * `next` handler — the real wiring to `NextActionService.nextAction`, the
 * ONLY next-action derivation entry (§1.2). The canonical 5-key payload is
 * preserved verbatim; findings are capped at FINDINGS_BUDGET. `ok` is true
 * whenever the runtime produced an action (even a chain-invalid VALIDATE) —
 * the canonical payload IS the deliverable; a thrown runtime error is mapped
 * by the execute error boundary instead.
 */
export function stageNextHandler(input: StageResolvedArgs): StageHandlerResult {
  const reverified = reverifyStagePaths(input);
  if (reverified !== null) {
    return { result: reverified };
  }
  // Manifest content trust-root guard (S2-F-001): same fail-closed check as
  // the status handler — a malicious manifest content field must never reach
  // NextActionService (evidence-path / slice-id reads derive from it). The
  // pre-read baseline feeds the post-read TOCTOU closure below.
  const manifestPath =
    input.manifestPath ?? defaultManifestPath(input.projectRoot, input.stageId);
  // Path identity re-verify BEFORE the baseline read (S2-F-001 round 3).
  const identity = reverifyManifestPathIdentity(input.projectRoot, manifestPath);
  if (!identity.ok) {
    return { result: identity.result };
  }
  const pre = checkManifestContentBaseline(input.projectRoot, identity.path);
  if (!pre.ok) {
    return { result: pre.result };
  }
  const output = nextActionService.nextAction({
    projectRoot: input.projectRoot,
    stageId: input.stageId,
    manifestPath: input.manifestPath,
    tasksPath: input.tasksPath,
  });
  // Post-read TOCTOU closure (S2-F-001 round 2): a manifest / evidence-path
  // swap during the runtime call must discard the derived next action.
  const toctou = reverifyManifestContentAfterRead(
    input.projectRoot,
    identity.path,
    pre.baseline,
  );
  if (toctou !== null) {
    return { result: toctou };
  }
  // Final path identity re-verify AFTER the post-check (S2-F-001 round 3).
  const finalIdentity = reverifyManifestPathIdentity(
    input.projectRoot,
    identity.path,
  );
  if (!finalIdentity.ok) {
    return { result: finalIdentity.result };
  }
  const result = successResult({
    data: projectStageNextData(output),
    findings: capFindings(output.findings),
  });
  return { result, nextText: renderStageNextText(output) };
}

/**
 * Built-in handlers wired by default into `createStageTool` (S02-A-T02 /
 * S03-B-T01). The optional `admitDeps` (TEST-ONLY) flows into the default
 * admit handlers so fault injection is routed through the REAL built
 * `createStageTool(...).execute` host envelope (CV diagnose
 * STAGE_ADMIT_POSTWRITE_TOCTOU_FAILURE_WITH_PERSISTED_RECEIPT test-seam
 * compliance) — a test supplies `beforeAdmit` / `afterAdmit` via the factory
 * seam and then calls `execute`; production callers never pass deps.
 */
function defaultStageHandlers(admitDeps?: StageAdmitDeps): StageOperationHandlers {
  return {
    status: stageStatusHandler,
    next: stageNextHandler,
    admit_worker_result: (input, logger) => runStageAdmitWorkerResult(input, logger, admitDeps),
    admit_cv_result: (input, logger) => runStageAdmitCvResult(input, logger, admitDeps),
    admit_slice_commit: (input, logger) =>
      runStageAdmitSliceCommit(input, logger, admitDeps),
    admit_integration: (input, logger) =>
      runStageAdmitIntegration(input, logger, admitDeps),
  };
}

/**
 * Render the bounded compact view into the host `{ output }` envelope.
 *
 * The compact status/next block is the FR-012-budgeted text (≤1000 / ≤1500);
 * findings are the capped canonical list; truncation points back to the
 * traceable diagnostic log ref. The `Status:` line reflects the ToolResult
 * `ok` flag so a fail-closed read is never presented as a clean PASS.
 */
export function renderStageCompactOutput(
  view: CompactView,
  operation: StageOperation,
  result: ToolResult,
): string {
  const lines: string[] = ['ProofLoop Stage'];
  lines.push(`Operation: ${operation}`);
  lines.push(`Status: ${result.ok ? 'ok' : 'failed'}`);
  if (operation === 'status') {
    lines.push('Stage status:');
    lines.push(view.status.length > 0 ? view.status : '(no summary)');
  } else if (isStageAdmitOperation(operation)) {
    lines.push('Admit result:');
    lines.push(view.status.length > 0 ? view.status : '(no summary)');
  } else {
    lines.push('Next action:');
    lines.push(view.next.length > 0 ? view.next : '(no summary)');
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
  if (result.data !== undefined) {
    // Structured canonical payload for parity (S02-D-T02): the same `Data:`
    // pattern as proofloop_plan — a deep-equal parity assertion can compare
    // the canonical status/next payload (projectStageStatusData /
    // projectStageNextData) against the CLI next-action oracle or the direct
    // reconcileStage oracle through the REAL host execute seam. U+2028/U+2029
    // escaped by serializeStructuredData so the line stays single-line.
    lines.push(`Data: ${serializeStructuredData(result.data)}`);
  }
  return lines.join('\n');
}

/**
 * Build the `proofloop_stage` ToolDefinition bound to the plugin RuntimeContext.
 *
 * S02-A-T02 wires the built-in `reconcileStage` / `NextActionService`
 * handlers by default; callers may still inject `handlers` overrides.
 *
 * Fail-closed zod boundary (S2 review finding S2-F-002): the tool registers
 * ONLY with the REAL host-accepted Zod raw-shape built from the vendored zod.
 * When the zod loader returns `undefined` (vendored zod absent/unresolvable)
 * the factory THROWS — the unverified structural descriptor is never used as
 * registration args. `index.ts` catches the throw and skips only this tool
 * (logger.warn), so `proofloop_doctor` (FR-006) stays available. The optional
 * `zodLoader` is the test seam for the fail-closed path; production callers
 * never pass it.
 *
 * Cancellation: `ToolContext.abort` is honored cooperatively — an already
 * aborted caller (or a handler completion after abort) propagates AbortError,
 * never a clean PASS or a Finding. The runtime read itself is synchronous and
 * cannot be interrupted mid-call; the pre-check (before dispatch) and the
 * post-check (after the handler returns) satisfy the cooperative boundary.
 */
export function createStageTool(
  context: RuntimeContext,
  handlers?: StageOperationHandlers,
  zodLoader: StageZodLoader = tryLoadVendoredZod,
  admitDeps?: StageAdmitDeps,
): StageToolDefinition {
  const z = zodLoader();
  if (z === undefined) {
    throw createZodUnavailableError('proofloop_stage');
  }
  const toolArgs = buildZodArgsShape(z);
  if (toolArgs === undefined) {
    throw createZodUnavailableError('proofloop_stage');
  }
  const activeHandlers = handlers ?? defaultStageHandlers(admitDeps);
  return {
    description: STAGE_TOOL_DESCRIPTION,
    args: toolArgs,
    async execute(rawArgs, toolContext) {
      // Cooperative cancellation (host-compatibility #Cancellation): an
      // already-aborted caller must receive AbortError.
      if (isAborted(toolContext.abort)) {
        throw createAbortError();
      }

      const operationLabel = rawOperationLabel(rawArgs);
      const parsed = parseStageArgs(rawArgs, context.projectRoot);
      if (!parsed.ok) {
        context.logger.warn('stage tool: rejected input', {
          operation: operationLabel,
          findings: parsed.result.findings,
        });
        return { output: renderStageOutput(parsed.result, operationLabel) };
      }

      try {
        const handler = activeHandlers[parsed.args.operation];
        if (handler === undefined) {
          // Defensive: an explicit handler set with no entry for this
          // operation fails closed — never guess a status/action or fall
          // through to a write branch.
          const result = toErrorResult([
            {
              code: 'RUNTIME.SCHEMA_MISMATCH',
              severity: 'error',
              message:
                `proofloop_stage: operation "${parsed.args.operation}" is not ` +
                'wired to a handler.',
            },
          ]);
          context.logger.warn('stage tool: operation not wired', {
            operation: parsed.args.operation,
          });
          return { output: renderStageOutput(result, parsed.args.operation) };
        }

        // S03-B REPAIR (counterexample 3): host metadata is observed ONLY after
        // the admit handler's parse + path guard pass. The `integration_ref`
        // host metadata log now lives inside `runStageAdmit` AFTER
        // `guardAdmitPathFields` succeeds (validate → guard → log → dispatch);
        // it is root-checked host metadata ONLY, never a runtime request
        // member (the integration binding stays commitSha equality).
        const outcome = await handler(parsed.args, context.logger);

        // Post-execution cooperative cancellation check: the synchronous
        // runtime read cannot be interrupted mid-call, so the abort surfaced
        // during the read is observed here (host-compatibility #Cancellation).
        if (isAborted(toolContext.abort)) {
          throw createAbortError();
        }

        const { result, statusText, nextText } = normalizeHandlerResult(outcome);

        context.logger.info('stage tool: executed', {
          operation: parsed.args.operation,
          ok: result.ok,
          findingCount: result.findings.length,
          callerRole: toolContext.agent,
        });

        // S1 compact renderer: bounded status/next (FR-012 hard budgets),
        // findings capped at FINDINGS_BUDGET, refs projected to exactly
        // { ref, digest }. S2 read-only results never fabricate Receipt refs —
        // the result refs stay empty.
        const view = renderCompact(
          { result, status: statusText ?? '', next: nextText ?? '' },
          { logger: context.logger },
        );
        return {
          output: renderStageCompactOutput(view, parsed.args.operation, result),
        };
      } catch (error) {
        // Unified ToolResult error boundary: a bare exception never leaks into
        // the host envelope. Cancellation (AbortError) is the ONE error that
        // must propagate as an abort — it is never mapped to a Finding or
        // reported as a clean PASS.
        if (isAbortError(error)) {
          throw error;
        }
        const result = toErrorResult(error);
        return { output: renderStageOutput(result, parsed.args.operation) };
      }
    },
  };
}

/** Normalize a handler outcome (plain ToolResult or enriched handler result). */
function normalizeHandlerResult(
  outcome: ToolResult | StageHandlerResult,
): StageHandlerResult {
  if (isStageHandlerResult(outcome)) {
    return outcome;
  }
  return { result: outcome };
}

function isStageHandlerResult(
  value: ToolResult | StageHandlerResult,
): value is StageHandlerResult {
  return (value as StageHandlerResult).result !== undefined;
}

/** Cap findings at the S1 compact budget (FR-012: ≤ 20). */
function capFindings(findings: readonly Finding[]): Finding[] {
  return findings.length > FINDINGS_BUDGET
    ? findings.slice(0, FINDINGS_BUDGET)
    : [...findings];
}

/** True when any canonical Finding is error-level (fail-closed signal). */
function hasErrorFindings(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

/** Build a canonical fail-closed parse result (findings validated by S1). */
function failClosed(findings: Parameters<typeof toErrorResult>[0]): StageParseResult {
  return { ok: false, result: toErrorResult(findings) };
}

/**
 * Canonical stage id pattern (stages are S1/S2/…). This is the primary guard
 * against stage_id path traversal: the runtime derives default
 * manifest/tasks/receipt paths from `stageId` via `path.join`, so only a
 * canonical id keeps the default reads inside the canonical worktree. The
 * canonical slice-id charset (S03-B/…) is enforced separately for the admit
 * operations via `CANONICAL_SLICE_ID` (manifest-guard).
 */
export const CANONICAL_STAGE_ID = /^S\d+$/;

/**
 * Trust-root boundary check for the runtime's DEFAULT manifest and tasks.md
 * paths of a stage. Returns `null` when both defaults stay inside the root,
 * else a fail-closed `HOST.PATH_OUTSIDE_PROJECT` ToolResult. Defense-in-depth:
 * with a canonical stage id the defaults can never escape, but the resolved
 * defaults are explicitly verified so the boundary holds regardless of how the
 * id is derived (CV S02-A-PO01-PO04-PATH-ARGS-SCOPE).
 */
export function checkDefaultStagePaths(
  root: string,
  stageId: string,
): ToolResult | null {
  const manifest = defaultManifestPath(root, stageId);
  if (!isWithinRoot(root, manifest)) {
    return toErrorResult([
      {
        code: 'HOST.PATH_OUTSIDE_PROJECT',
        severity: 'error',
        message:
          `proofloop_stage: default manifest path for stage "${stageId}" ` +
          `resolves outside the trust root (${root}).`,
      },
    ]);
  }
  const tasks = defaultTasksMdPath(root, stageId);
  if (!isWithinRoot(root, tasks)) {
    return toErrorResult([
      {
        code: 'HOST.PATH_OUTSIDE_PROJECT',
        severity: 'error',
        message:
          `proofloop_stage: default tasks.md path for stage "${stageId}" ` +
          `resolves outside the trust root (${root}).`,
      },
    ]);
  }
  return null;
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

/** Canonical root normalization: realpath when possible, else resolved path. */
function canonicalizeRoot(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Resolve `p` against the trust root and enforce the root boundary.
 *
 * Shared helper in `path-boundary.ts` (CV S02-B-INITIAL-PO01-SYMLINK): every
 * existing ancestor component is realpath-checked — a symlink parent pointing
 * outside the root is rejected even when the final target does not exist.
 */

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** AbortError with the canonical `name` hosts expect (cooperative cancel). */
function createAbortError(): Error {
  const error = new Error('proofloop_stage was aborted by the caller');
  error.name = 'AbortError';
  return error;
}
