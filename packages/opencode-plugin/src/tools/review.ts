/**
 * @proofloop/opencode-plugin — proofloop_review tool definition (AWI-009).
 *
 * S02-C-T01: host tool definition skeleton + operation contract + stage_id
 * canonical guard + path guard + unified ToolResult error boundary. This is
 * the contract layer that T02 wires to `reconcileStage` (status projection,
 * reusing S02-A) and T03 proves on the real built host seam; the layer is
 * delivered now with tests so S02-D consumes the same canonical-root / result /
 * failure seams.
 *
 * Host shape (tech-spec/host-compatibility.md #自定义工具注册与调用): the tool
 * registers as `tool({ description, args, execute })`; the host API field name
 * is `args` (Zod raw-shape), NOT `inputSchema`. `ToolContext.abort` is an
 * AbortSignal (cooperative cancellation — an abort must propagate AbortError,
 * never be reported as a clean PASS); `ToolContext.agent` is the caller role.
 *
 * Args shape / zod tradeoff (zero new runtime dependencies): identical to the
 * S02-A `STAGE_TOOL_ARGS` / S02-B `PLAN_TOOL_ARGS` scheme. The built plugin
 * must never crash when `zod` is not resolvable from its node_modules chain,
 * so the tool factory registers a real host-accepted Zod raw-shape built from
 * the vendored zod when it resolves, and THROWS (never a structural fallback)
 * when it does not (S2-F-002 fail-closed). execute never trusts the shape:
 * every input is validated defensively at the boundary (security hardening)
 * and fails closed with a canonical Finding on malformed input.
 *
 * Operation contract (tech-spec/contract-state-matrix.md#§1.3): the S2
 * `stage_status` read operation is preserved; S03-D-T01 adds
 * `prepare_stage_review` (read-only ReviewInput projection) and
 * `finalize_stage_review` (→ runtime `admitStageReview`). Project-review
 * operations (`prepare_project_review` / `finalize_project_review` /
 * `project_status`), gate operations (`run_gate` / `admit_gate_result` /
 * `admit_gate_interrupted`), plan/stage write operations and ANY unknown
 * value fail closed with a canonical Finding (RUNTIME.SCHEMA_MISMATCH) at the
 * execute boundary and are NEVER dispatched (PO-S03-D-01 — S3 registers no
 * project/gate/unknown capability).
 *
 * stage_id canonical guard: reuse S02-A `CANONICAL_STAGE_ID` (`/^S\d+$/`). A
 * non-canonical id carrying separators / `..` / absolute segments would resolve
 * the runtime's DEFAULT manifest/tasks paths OUTSIDE the trust root; a
 * canonical stage id can never traverse, so the default reads stay inside the
 * canonical worktree. Defense-in-depth reuses S02-A `checkDefaultStagePaths`
 * so the default-path boundary holds even if the id-format guard were bypassed.
 *
 * Path guard (S2 constraints): `projectRoot` always comes from the canonical
 * `RuntimeContext` root (realpath of `PluginInput.worktree`, ADR-004). A
 * caller-supplied `project_root` is a canonical-root consistency assertion
 * only — a mismatch fails closed (HOST.PROJECT_NOT_TRUSTED) instead of
 * overriding the trust root.
 *
 * Error boundary (S1 tool-result): the unified `toErrorResult` mapping wraps
 * every dispatch — a bare exception never leaks into the ToolResult or the
 * host `{ output }` envelope; cancellation (AbortError) is the one error that
 * propagates as an abort.
 *
 * S02-C-T02 wires the `stage_status` handler to the S02-A status projection:
 * `reviewStageStatusHandler` delegates to `stageStatusHandler` — the literal
 * same handler `proofloop_stage(status)` wires — so the two host tools report
 * IDENTICAL canonical data/summary/findings on the same fixture
 * (PO-S02-C-02), including the default-path identity reverify and the
 * error-level fail-closed mapping. Injected handler overrides still win for
 * tests/extension; the contract layer never guesses a status and never falls
 * through to a write branch.
 *
 * S03-D-T01 wires the two S3 operations by default: `prepare_stage_review` →
 * `runReviewPrepare` (read-only, assembles the `review_scope: stage`
 * ReviewInput projection from Manifest + git + reconcile refs with ref-only
 * `{ ref, digest }` entries — see `review-common.ts`) and
 * `finalize_stage_review` → `runReviewFinalize` (maps the closed
 * `{ACCEPTED, REPAIR}` verdict + summary to the canonical
 * `StageReviewAdmissionRequest` and dispatches IN-PROCESS to the runtime
 * `admitStageReview` — the ONLY stage-review Receipt creation path, never a
 * CLI subprocess, never direct `writeReceipt` / `runAdmitPipeline` assembly).
 * Operation-dependent requiredness (`scope` / `verdict` / `summary`) is
 * enforced in execute's fail-closed second validation.
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ToolContext, ToolResult as HostToolResult } from '@opencode-ai/plugin';
import { REVIEW_VERDICTS } from '@proofloop/runtime';
import type { ReviewVerdict } from '@proofloop/runtime';
import type { z as ZodNamespace } from 'zod';
import { renderCompact, serializeStructuredData } from '../compact.js';
import type { CompactView } from '../compact.js';
import { toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import type { RuntimeContext } from '../host-context.js';
// Shared trust-root / stage-id / status-projection helpers (S02-A): the
// canonical stage id regex, the default manifest/tasks path boundary check,
// and the `stageStatusHandler` are the SAME seams the stage tool uses — review
// consumes the literal stage status handler, so `proofloop_review(stage_status)`
// and `proofloop_stage(status)` cannot drift on the same fixture
// (PO-S02-C-02).
import {
  CANONICAL_STAGE_ID,
  checkDefaultStagePaths,
  createZodUnavailableError,
  stageStatusHandler,
} from './stage.js';
import type { StageResolvedArgs } from './stage.js';
// S03-D-T01: the prepare/finalize handlers (in-process runtime seams).
import { runReviewFinalize } from './review-finalize.js';
import type { ReviewFinalizeDeps } from './review-finalize.js';
import { runReviewPrepare } from './review-prepare.js';
import { isReviewScope, REVIEW_SCOPES } from './review-common.js';

/** Canonical tool key registered by the host (AWI-009). */
export const REVIEW_TOOL_NAME = 'proofloop_review';

/**
 * Legal S3 review operations (contract-state-matrix.md#§1.3): the S2
 * `stage_status` read op PLUS the two S3 stage-review operations.
 * `prepare_stage_review` is read-only (assembles the ReviewInput projection);
 * `finalize_stage_review` dispatches IN-PROCESS to the runtime
 * `admitStageReview` (ACCEPTED → STAGE_REVIEW_PASS Receipt; REPAIR → legal
 * no-Receipt warn branch). S3 registers/dispatches NO project-review, gate or
 * unknown operation (PO-S03-D-01).
 */
export const REVIEW_OPERATIONS = [
  'stage_status',
  'prepare_stage_review',
  'finalize_stage_review',
] as const;

/** Legal S3 review operation value. */
export type ReviewOperation = (typeof REVIEW_OPERATIONS)[number];

/**
 * Operations that are NEVER legal for `proofloop_review` (PO-S03-D-01):
 * project-review operations (`prepare_project_review` / `finalize_project_review`
 * / `project_status`), gate operations (`run_gate` / `admit_gate_result` /
 * `admit_gate_interrupted`), plan/stage write operations (`stage_plan` /
 * `admit_stage_plan` / `compile_acceptance` / `run_e2e`) and ANY unknown
 * value. The execute boundary rejects every value here with a canonical
 * RUNTIME.SCHEMA_MISMATCH Finding and NEVER dispatches a write branch — never
 * a fallthrough, never a silent alias, never a read-only downgrade of a write
 * op.
 */
export const REJECTED_REVIEW_OPERATIONS = [
  'prepare_project_review',
  'finalize_project_review',
  'project_status',
  'run_gate',
  'admit_gate_result',
  'admit_gate_interrupted',
  'stage_plan',
  'admit_stage_plan',
  'compile_acceptance',
  'run_e2e',
] as const;

/** Human-readable tool description exposed to the host. */
export const REVIEW_TOOL_DESCRIPTION =
  'Query and drive a ProofLoop stage review through the canonical worktree ' +
  'trust root: `stage_status` returns the bounded stage summary (same ' +
  'projection as proofloop_stage), `prepare_stage_review` assembles a ' +
  'read-only `review_scope: stage` ReviewInput from persisted facts and ' +
  'ref-only artifacts, and `finalize_stage_review` admits the Reviewer ' +
  'verdict (ACCEPTED | REPAIR) through the runtime admission pipeline. ' +
  'Project-review, gate and unknown operations fail closed.';

/**
 * Structural stand-in for one host Zod raw-shape field. Kept as the
 * documented structural reference shape; NEVER used as the registered `args`
 * (S2-F-002 fail-closed — see `REVIEW_TOOL_ARGS_FALLBACK`).
 */
export interface ReviewArgFieldSpec {
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
export type ReviewToolArgsField =
  | ReviewArgFieldSpec
  | {
      readonly _def: unknown;
      readonly description?: string;
      readonly options?: readonly string[];
    };

/**
 * Host-accepted `args` shape for `proofloop_review`. Field names are the
 * canonical S3 review inputs: `operation` (stage_status |
 * prepare_stage_review | finalize_stage_review), required `stage_id`,
 * optional `project_root` (canonical-root consistency assertion only),
 * `scope` (prepare: must be 'stage' — S3 only supports review_scope: stage),
 * `verdict` (finalize: closed {ACCEPTED, REPAIR}) and `summary` (finalize).
 * Requiredness is enforced in execute's fail-closed second validation
 * (`parseReviewArgs`), NEVER by the host schema alone.
 */
export interface ReviewToolArgsShape {
  operation: ReviewToolArgsField;
  stage_id: ReviewToolArgsField;
  project_root: ReviewToolArgsField;
  scope: ReviewToolArgsField;
  verdict: ReviewToolArgsField;
  summary: ReviewToolArgsField;
}

/**
 * Structural fallback `args` shape. Retained as the documented structural
 * reference shape ONLY — NEVER used as the registered `args` (S2-F-002
 * fail-closed). Fields are `ReviewArgFieldSpec` descriptors.
 */
export interface ReviewToolArgsFallbackShape {
  operation: ReviewArgFieldSpec & { values: readonly ReviewOperation[] };
  stage_id: ReviewArgFieldSpec;
  project_root: ReviewArgFieldSpec;
  scope: ReviewArgFieldSpec & { values: readonly ReviewScopeValue[] };
  verdict: ReviewArgFieldSpec & { values: readonly ReviewVerdict[] };
  summary: ReviewArgFieldSpec;
}

/** Legal `review_scope` value for the args shape (S3: `stage`). */
export type ReviewScopeValue = (typeof REVIEW_SCOPES)[number];

export const REVIEW_TOOL_ARGS_FALLBACK: ReviewToolArgsFallbackShape = {
  operation: {
    type: 'enum',
    values: [...REVIEW_OPERATIONS],
    description:
      'Operation to run: `stage_status`, `prepare_stage_review` or ' +
      '`finalize_stage_review`.',
  },
  stage_id: {
    type: 'string',
    description: 'Canonical stage id to review (e.g. S3).',
  },
  project_root: {
    type: 'string',
    optional: true,
    description:
      'Canonical project root assertion. May only assert consistency with the trusted worktree; never overrides it.',
  },
  scope: {
    type: 'enum',
    values: [...REVIEW_SCOPES],
    optional: true,
    description:
      'Review scope for `prepare_stage_review`. S3 only supports `stage`; any other value fails closed.',
  },
  verdict: {
    type: 'enum',
    values: [...REVIEW_VERDICTS],
    optional: true,
    description:
      'Reviewer verdict for `finalize_stage_review` (closed {ACCEPTED, REPAIR}).',
  },
  summary: {
    type: 'string',
    optional: true,
    description:
      'Review summary for `finalize_stage_review` (non-empty; required by the StageReviewAdmissionRequest schema).',
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
function buildReviewZodArgsShape(
  z: typeof ZodNamespace,
): ReviewToolArgsShape | undefined {
  try {
    const schema = z.object({
      operation: z
        .enum([...REVIEW_OPERATIONS])
        .describe(
          'Operation to run: `stage_status`, `prepare_stage_review` or `finalize_stage_review`.',
        ),
      stage_id: z
        .string()
        .min(1)
        .describe('Canonical stage id to review (e.g. S3).'),
      project_root: z
        .string()
        .optional()
        .describe(
          'Canonical project root assertion. May only assert consistency with the trusted worktree; never overrides it.',
        ),
      scope: z
        .enum([...REVIEW_SCOPES])
        .optional()
        .describe(
          'Review scope for `prepare_stage_review`. S3 only supports `stage`; any other value fails closed.',
        ),
      verdict: z
        .enum([...REVIEW_VERDICTS])
        .optional()
        .describe(
          'Reviewer verdict for `finalize_stage_review` (closed {ACCEPTED, REPAIR}).',
        ),
      summary: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Review summary for `finalize_stage_review` (non-empty; required by the StageReviewAdmissionRequest schema).',
        ),
    });
    return schema.shape as unknown as ReviewToolArgsShape;
  } catch {
    return undefined;
  }
}

const vendoredZod = tryLoadVendoredZod();

/**
 * The `args` the tool factory registers — a REAL host-accepted Zod raw-shape
 * built from the vendored zod (v4). Fail-closed (S2-F-002): when the vendored
 * zod is unavailable this is `undefined` and `createReviewTool` refuses to
 * register — the structural `REVIEW_TOOL_ARGS_FALLBACK` descriptor is NEVER
 * used as registration args because it has not been verified on the real host
 * seam.
 */
export const REVIEW_TOOL_ARGS: ReviewToolArgsShape | undefined =
  vendoredZod !== undefined ? buildReviewZodArgsShape(vendoredZod) : undefined;

/**
 * True when the vendored-zod host-accepted args shape is available for
 * registration (S2-F-002). The plugin entry consults this before attempting
 * to register `proofloop_review`; the factory re-checks the loader as its own
 * fail-closed boundary.
 */
export function isReviewToolArgsAvailable(): boolean {
  return REVIEW_TOOL_ARGS !== undefined;
}

/**
 * Loader for the vendored zod used by the tool factory (S2-F-002 test seam).
 * The default is the real `tryLoadVendoredZod`; tests inject a stub that
 * returns `undefined` to prove the fail-closed registration path.
 */
export type ReviewZodLoader = () => typeof ZodNamespace | undefined;

/**
 * Fully validated canonical operation input handed to the handler seam.
 * `projectRoot` is always the canonical trust root. Operation-dependent
 * fields (`scope` / `verdict` / `summary`) are present only for the
 * operations that consume them.
 */
export interface ReviewResolvedArgs {
  /** Validated operation (stage_status | prepare_stage_review | finalize_stage_review). */
  operation: ReviewOperation;
  /** Canonical stage id. */
  stageId: string;
  /** Canonical trust root (realpath of PluginInput.worktree). */
  projectRoot: string;
  /** prepare: review scope (S3 only `'stage'`; optional — defaults to `stage`). */
  scope?: ReviewScopeValue;
  /** finalize: closed {ACCEPTED, REPAIR} verdict. */
  verdict?: ReviewVerdict;
  /** finalize: non-empty review summary. */
  summary?: string;
}

/**
 * Handler outcome: the unified S1 ToolResult plus the full render text(s) fed
 * to the S1 compact renderer (FR-012 budgets) once T02 wires the status
 * handler. A plain ToolResult (T01 shape) remains valid.
 */
export interface ReviewHandlerResult {
  /** Unified S1 ToolResult. */
  result: ToolResult;
  /** Full status summary text (stage_status op) fed to renderCompact. */
  statusText?: string;
}

/**
 * Operation handler seam. The built-in handlers wire `stage_status` to the S2
 * `reviewStageStatusHandler` (→ the S02-A reconcileStage projection),
 * `prepare_stage_review` to `runReviewPrepare` (read-only ReviewInput
 * projection) and `finalize_stage_review` to `runReviewFinalize` (→ the
 * runtime `admitStageReview`); callers may still inject overrides for
 * tests/extension. Handlers return the unified S1 ToolResult (optionally with
 * compact render text) — never a bare value/throw.
 */
export interface ReviewOperationHandlers {
  stage_status?(
    input: ReviewResolvedArgs,
  ): ToolResult | ReviewHandlerResult | Promise<ToolResult | ReviewHandlerResult>;
  prepare_stage_review?(
    input: ReviewResolvedArgs,
  ): ToolResult | ReviewHandlerResult | Promise<ToolResult | ReviewHandlerResult>;
  finalize_stage_review?(
    input: ReviewResolvedArgs,
  ): ToolResult | ReviewHandlerResult | Promise<ToolResult | ReviewHandlerResult>;
}

/** Host-visible tool definition (matches the `tool(...)` return shape). */
export interface ReviewToolDefinition {
  description: string;
  args: ReviewToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<HostToolResult>;
}

/** Result of the contract-layer parse: resolved args or a fail-closed result. */
export type ReviewParseResult =
  | { ok: true; args: ReviewResolvedArgs }
  | { ok: false; result: ToolResult };

/**
 * Parse and validate the raw caller args against the canonical trust root.
 *
 * Fail-closed contract layer:
 *   - `operation` must be one of the S3 review operations (`stage_status` |
 *     `prepare_stage_review` | `finalize_stage_review`); project-review / gate
 *     / plan-stage operations and ANY unknown value are rejected with a
 *     canonical Finding and never reach a dispatch branch (PO-S03-D-01).
 *   - `stage_id` is required for every operation and must match the canonical
 *     stage id pattern (`/^S\d+$/`); traversal / absolute / slice ids fail
 *     closed before any runtime read.
 *   - the runtime's DEFAULT manifest/tasks paths for the stage stay inside the
 *     trust root (S02-A `checkDefaultStagePaths` defense-in-depth).
 *   - `project_root` is a consistency assertion only; a mismatch fails closed
 *     with HOST.PROJECT_NOT_TRUSTED.
 *   - operation-dependent fields are closed-validated: `scope` is
 *     prepare-only and must be exactly `'stage'` (S3 supports no project
 *     review); `verdict` (closed {ACCEPTED, REPAIR}) and a non-empty `summary`
 *     are finalize-only; a field supplied for the wrong operation fails closed
 *     (never silently ignored).
 *
 * Every failure is a canonical kernel Finding verified through the S1
 * `toErrorResult` boundary (never a bare exception).
 */
export function parseReviewArgs(
  rawArgs: unknown,
  canonicalRoot: string,
): ReviewParseResult {
  if (typeof rawArgs !== 'object' || rawArgs === null) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_review: args must be an object carrying an `operation` field.',
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
          'proofloop_review: `operation` is required and must be one of: ' +
          'stage_status, prepare_stage_review, finalize_stage_review.',
      },
    ]);
  }
  if (!isReviewOperation(operation)) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          `proofloop_review: operation "${operation}" is not supported (supported: ` +
          'stage_status | prepare_stage_review | finalize_stage_review). Rejected ' +
          'operations (prepare_project_review, finalize_project_review, ' +
          'project_status, run_gate, admit_gate_result, admit_gate_interrupted, ' +
          'stage_plan, admit_stage_plan, compile_acceptance, run_e2e) and unknown ' +
          'values never dispatch through this tool.',
      },
    ]);
  }

  const stageId = args['stage_id'];
  if (typeof stageId !== 'string' || stageId.length === 0) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_review: `stage_id` is required and must be a non-empty string.',
      },
    ]);
  }
  // Canonical stage id guard (same seam as S02-A CV S02-A-PO01-PO04-PATH-ARGS-
  // SCOPE). The runtime derives its DEFAULT manifest/tasks paths from `stageId`
  // via path.join; a non-canonical id carrying separators / `..` / absolute
  // segments would resolve those defaults OUTSIDE the trust root. A canonical
  // stage id (`/^S\d+$/`, e.g. S2) can never traverse.
  if (!CANONICAL_STAGE_ID.test(stageId)) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          `proofloop_review: stage_id "${stageId}" is not a canonical stage id ` +
          '(expected /^S\\d+$/, e.g. S2); path traversal / absolute paths are ' +
          'rejected before any runtime read.',
      },
    ]);
  }
  // Default-path boundary (defense-in-depth, S02-A): the runtime's default
  // manifest / tasks paths for the (now canonical) stage id are explicitly
  // verified to stay inside the trust root, so the defaulting can never escape
  // even if the id-format guard were bypassed by a future runtime change.
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
            'proofloop_review: `project_root` must be a non-empty string when provided.',
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
            `proofloop_review: project_root "${projectRootArg}" does not match ` +
            `the canonical worktree trust root (${canonicalRoot}); project_root ` +
            'can only assert consistency, never override the trust root.',
        },
      ]);
    }
  }

  // Operation-dependent fields — closed validation in execute's fail-closed
  // second validation (the host schema alone never enforces requiredness):
  //   - `scope` is prepare-only and must be exactly 'stage' (S3 has no
  //     project review — any other scope fails closed);
  //   - `verdict` / `summary` are finalize-only: verdict must be the closed
  //     {ACCEPTED, REPAIR} set and summary must be non-empty (the runtime
  //     StageReviewAdmissionRequest schema requires it);
  //   - a field supplied for the wrong operation fails closed (never silently
  //     ignored — closed validation).
  if (operation === 'stage_status') {
    if (args['scope'] !== undefined) {
      return failClosed([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'proofloop_review: `scope` is only valid for prepare_stage_review.',
        },
      ]);
    }
    if (args['verdict'] !== undefined || args['summary'] !== undefined) {
      return failClosed([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'proofloop_review: `verdict` / `summary` are only valid for ' +
            'finalize_stage_review.',
        },
      ]);
    }
    return {
      ok: true,
      args: { operation, stageId, projectRoot: canonicalRoot },
    };
  }

  if (operation === 'prepare_stage_review') {
    if (args['verdict'] !== undefined || args['summary'] !== undefined) {
      return failClosed([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'proofloop_review: `verdict` / `summary` are only valid for ' +
            'finalize_stage_review.',
        },
      ]);
    }
    const scope = args['scope'];
    if (scope !== undefined) {
      if (!isReviewScope(scope)) {
        return failClosed([
          {
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message:
              `proofloop_review: scope "${String(scope)}" is not supported ` +
              '(S3 only supports review_scope: stage). Project review is not ' +
              'available through this tool.',
          },
        ]);
      }
      return {
        ok: true,
        args: { operation, stageId, projectRoot: canonicalRoot, scope },
      };
    }
    return {
      ok: true,
      args: { operation, stageId, projectRoot: canonicalRoot },
    };
  }

  // finalize_stage_review
  if (args['scope'] !== undefined) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_review: `scope` is only valid for prepare_stage_review.',
      },
    ]);
  }
  const verdict = args['verdict'];
  if (!isReviewVerdict(verdict)) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_review: finalize_stage_review requires `verdict` — one of: ' +
          'ACCEPTED, REPAIR (closed set; any other value fails closed before ' +
          'any runtime call).',
      },
    ]);
  }
  const summary = args['summary'];
  if (typeof summary !== 'string' || summary.length === 0) {
    return failClosed([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          'proofloop_review: finalize_stage_review requires a non-empty ' +
          '`summary` (the StageReviewAdmissionRequest schema requires it).',
      },
    ]);
  }
  return {
    ok: true,
    args: { operation, stageId, projectRoot: canonicalRoot, verdict, summary },
  };
}

/** True when `value` is one of the closed REVIEW_VERDICTS values. */
function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return typeof value === 'string' && (REVIEW_VERDICTS as readonly string[]).includes(value);
}

/**
 * Render a unified ToolResult into the host `{ output }` envelope.
 *
 * T01 minimal honest projection: the operation label (when known), the overall
 * status and every canonical finding code/message. T02 extends this into the
 * bounded status compact rendering (FR-012 budget); the finding codes here are
 * always canonical kernel codes.
 */
export function renderReviewOutput(
  result: ToolResult,
  operation?: string,
): string {
  const lines: string[] = ['ProofLoop Review'];
  if (operation !== undefined) {
    lines.push(`Operation: ${operation}`);
  }
  lines.push(`Status: ${result.ok ? 'ok' : 'failed'}`);
  if (result.ok && result.data !== undefined) {
    // U+2028/U+2029 escaped for a stable single-line Data payload (same fix as
    // stage.ts / plan.ts — CV S02-B-RECHECK-PO02-DATA-LINE).
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

/**
 * Render the bounded compact view into the host `{ output }` envelope.
 *
 * The compact block is the FR-012-budgeted text (≤1000): for `stage_status`
 * it is the SAME `Stage status:` view the stage tool renders (PO-S02-C-02);
 * for `prepare_stage_review` it is the bounded ReviewInput summary; for
 * `finalize_stage_review` it is the bounded admit summary (accepted flag,
 * receipt digest, post-admit stage state). Findings are the capped canonical
 * list; truncation points back to the traceable diagnostic log ref. The
 * `Status:` line reflects the ToolResult `ok` flag so a fail-closed read is
 * never presented as a clean PASS.
 */
export function renderReviewCompactOutput(
  view: CompactView,
  result: ToolResult,
  operation: ReviewOperation,
): string {
  const lines: string[] = ['ProofLoop Review'];
  lines.push(`Operation: ${operation}`);
  lines.push(`Status: ${result.ok ? 'ok' : 'failed'}`);
  if (operation === 'stage_status') {
    lines.push('Stage status:');
  } else if (operation === 'prepare_stage_review') {
    lines.push('Review input:');
  } else {
    lines.push('Admit result:');
  }
  lines.push(view.status.length > 0 ? view.status : '(no summary)');
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
    // Structured canonical payload for parity: the same `Data:` pattern as
    // proofloop_plan / proofloop_stage. U+2028/U+2029 escaped by
    // serializeStructuredData so the line stays single-line.
    lines.push(`Data: ${serializeStructuredData(result.data)}`);
  }
  return lines.join('\n');
}

// ============================================================
// S02-C-T02 wiring: stage_status → the S02-A reconcileStage projection
// ============================================================

/**
 * `stage_status` handler — delegates to the S02-A `stageStatusHandler`.
 *
 * This is the literal SAME handler `proofloop_stage(status)` wires: it
 * reverifies the default manifest/tasks paths (identity), calls the runtime
 * public `reconcileStage({projectRoot, stageId, manifestPath?, tasksMdPath?})`
 * read seam, projects ONLY canonical scalar facts into the ToolResult `data`
 * (never Receipt bodies / full reconcile objects), and fails closed when
 * reconcile reports error-level findings. Reusing the handler (rather than a
 * parallel copy) makes review/stage output drift impossible on the same
 * fixture (PO-S02-C-02).
 */
export function reviewStageStatusHandler(
  input: ReviewResolvedArgs,
): ReviewHandlerResult {
  const stageArgs: StageResolvedArgs = {
    operation: 'status',
    stageId: input.stageId,
    projectRoot: input.projectRoot,
  };
  const outcome = stageStatusHandler(stageArgs);
  return { result: outcome.result, statusText: outcome.statusText };
}

/**
 * Built-in handlers wired by default into `createReviewTool` (S02-C-T02 +
 * S03-D-T01): stage_status → the S2 reconcileStage projection; prepare → the
 * read-only ReviewInput projection; finalize → the runtime admitStageReview
 * seam. The optional `finalizeDeps` is the CV test-only fault-injection seam
 * (S03-D-REFPATH-POSTWRITE-TOCTOU-SCOPE-001 — production never passes it; the
 * S03-C SPV admit uses the identical seam).
 */
function defaultReviewHandlers(finalizeDeps?: ReviewFinalizeDeps): ReviewOperationHandlers {
  return {
    stage_status: reviewStageStatusHandler,
    prepare_stage_review: (input) => runReviewPrepare(input),
    finalize_stage_review: (input) => runReviewFinalize(input, finalizeDeps),
  };
}

/**
 * Build the `proofloop_review` ToolDefinition bound to the plugin RuntimeContext.
 *
 * S02-C-T02 wires the built-in `reviewStageStatusHandler` (→ the S02-A
 * `reconcileStage` projection) by default; callers may still inject
 * `handlers` overrides.
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
 * The optional `finalizeDeps` is the CV test-only fault-injection seam for
 * the finalize post-write TOCTOU / concurrency proof (S03-D-REFPATH-POSTWRITE-
 * TOCTOU-SCOPE-001 — the S03-C SPV admit pattern); production callers never
 * pass it.
 *
 * Cancellation: `ToolContext.abort` is honored cooperatively — an already
 * aborted caller (or a handler completion after abort) propagates AbortError,
 * never a clean PASS or a Finding.
 */
export function createReviewTool(
  context: RuntimeContext,
  handlers?: ReviewOperationHandlers,
  zodLoader: ReviewZodLoader = tryLoadVendoredZod,
  finalizeDeps?: ReviewFinalizeDeps,
): ReviewToolDefinition {
  const z = zodLoader();
  if (z === undefined) {
    throw createZodUnavailableError('proofloop_review');
  }
  const toolArgs = buildReviewZodArgsShape(z);
  if (toolArgs === undefined) {
    throw createZodUnavailableError('proofloop_review');
  }
  const activeHandlers = handlers ?? defaultReviewHandlers(finalizeDeps);
  return {
    description: REVIEW_TOOL_DESCRIPTION,
    args: toolArgs,
    async execute(rawArgs, toolContext) {
      // Cooperative cancellation (host-compatibility #Cancellation): an
      // already-aborted caller must receive AbortError.
      if (isAborted(toolContext.abort)) {
        throw createAbortError();
      }

      const operationLabel = rawOperationLabel(rawArgs);
      const parsed = parseReviewArgs(rawArgs, context.projectRoot);
      if (!parsed.ok) {
        context.logger.warn('review tool: rejected input', {
          operation: operationLabel,
          findings: parsed.result.findings,
        });
        return { output: renderReviewOutput(parsed.result, operationLabel) };
      }

      try {
        const handler = activeHandlers[parsed.args.operation];
        if (handler === undefined) {
          // Defensive: T02 wires the real `stage_status` handler; until then
          // an unwired operation fails closed — never guess a status or fall
          // through to a write branch.
          const result = toErrorResult([
            {
              code: 'RUNTIME.SCHEMA_MISMATCH',
              severity: 'error',
              message:
                `proofloop_review: operation "${parsed.args.operation}" is not ` +
                'wired to a handler.',
            },
          ]);
          context.logger.warn('review tool: operation not wired', {
            operation: parsed.args.operation,
          });
          return { output: renderReviewOutput(result, parsed.args.operation) };
        }

        const outcome = await handler(parsed.args);

        // Post-execution cooperative cancellation check: the synchronous
        // runtime read cannot be interrupted mid-call, so the abort surfaced
        // during the read is observed here (host-compatibility #Cancellation).
        if (isAborted(toolContext.abort)) {
          throw createAbortError();
        }

        const { result, statusText } = normalizeHandlerResult(outcome);

        context.logger.info('review tool: executed', {
          operation: parsed.args.operation,
          ok: result.ok,
          findingCount: result.findings.length,
          callerRole: toolContext.agent,
        });

        // S1 compact renderer: bounded status summary (FR-012 hard budget,
        // status ≤1000), findings capped at FINDINGS_BUDGET, refs projected to
        // exactly { ref, digest }. S2 read-only review never fabricates Receipt
        // refs — the result refs stay empty.
        const view = renderCompact(
          { result, status: statusText ?? '', next: '' },
          { logger: context.logger },
        );
        return {
          output: renderReviewCompactOutput(view, result, parsed.args.operation),
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
        return { output: renderReviewOutput(result, parsed.args.operation) };
      }
    },
  };
}

/** Normalize a handler outcome (plain ToolResult or enriched handler result). */
function normalizeHandlerResult(
  outcome: ToolResult | ReviewHandlerResult,
): ReviewHandlerResult {
  if (isReviewHandlerResult(outcome)) {
    return outcome;
  }
  return { result: outcome };
}

function isReviewHandlerResult(
  value: ToolResult | ReviewHandlerResult,
): value is ReviewHandlerResult {
  return (value as ReviewHandlerResult).result !== undefined;
}

/** Build a canonical fail-closed parse result (findings validated by S1). */
function failClosed(findings: Parameters<typeof toErrorResult>[0]): ReviewParseResult {
  return { ok: false, result: toErrorResult(findings) };
}

function isReviewOperation(value: string): value is ReviewOperation {
  return (REVIEW_OPERATIONS as readonly string[]).includes(value);
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

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** AbortError with the canonical `name` hosts expect (cooperative cancel). */
function createAbortError(): Error {
  const error = new Error('proofloop_review was aborted by the caller');
  error.name = 'AbortError';
  return error;
}
