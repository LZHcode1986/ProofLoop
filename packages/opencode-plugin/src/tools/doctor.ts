/**
 * @proofloop/opencode-plugin — proofloop_doctor tool definition (AWI-005).
 *
 * S01-C-T04: exposes `proofloop_doctor` through the real OpenCode tool seam as
 * `tool({ description, args, execute })` (OC-0 host-compatibility.md custom tool
 * registration). The tool is registered for ANY project (FR-006): active or
 * fail-closed/non-ProofLoop projects all keep the doctor as their only tool.
 *
 * Runtime zero-dependency boundary:
 *   - The host types (`ToolContext`, host `ToolResult`) are imported TYPE-ONLY
 *     through the tsconfig `paths` mapping; there is NO runtime import of
 *     `@opencode-ai/plugin` (offline repository, ADR-003). The host consumes
 *     the returned object as a `ToolDefinition`.
 *   - `args` is the empty shape `{}` (the doctor has no input parameters; the
 *     host auto-generates an empty JSON Schema).
 *   - The engine and renderer are the in-process seams from T01–T03:
 *     `runDoctor` (six canonical checks), `renderCompact` (hard budgets), and
 *     the host logger adapter. `ToolContext.abort` is passed through to the
 *     doctor's runProcess probes (cooperative cancellation — never swallowed).
 *   - `RUNTIME_LOCK_EXPECTATIONS` (S01-B live metadata seam) supplies the
 *     actual package versions for the version check.
 */

import type { ToolContext, ToolResult as HostToolResult } from '@opencode-ai/plugin';
import { runProcess } from '@proofloop/runtime';
import { renderCompact } from '../compact.js';
import type { CompactView } from '../compact.js';
import { runDoctor } from '../doctor.js';
import type { DoctorCheck, DoctorDeps, DoctorResult, HostFacts } from '../doctor.js';
import type { RuntimeContext } from '../host-context.js';
import type { LoggerAdapter } from '../adapters/logger.js';
import { RUNTIME_LOCK_EXPECTATIONS } from '../runtime-lock.js';

/** Canonical tool key registered by S1 (FR-006: doctor-only in non-ProofLoop). */
export const DOCTOR_TOOL_NAME = 'proofloop_doctor';

/**
 * Empty args shape for tools with no input parameters. The host generates an
 * empty JSON Schema from this shape (OC-0 custom tool registration).
 */
export type EmptyToolArgs = Record<string, never>;

/** Local structural shape of the registered tool (host ToolDefinition contract). */
export interface DoctorToolDefinition {
  description: string;
  args: EmptyToolArgs;
  execute: (args: EmptyToolArgs, context: ToolContext) => Promise<HostToolResult>;
}

/**
 * Doctor visibility policy (S1 semantics + S4 extension point).
 *
 * S1: `proofloop_doctor` is available to ALL roles as a diagnostic tool
 * (FR-006: in a non-ProofLoop project it is the ONLY tool). No role gating is
 * enforced in S1; the caller role is carried explicitly (`callerRole`) into the
 * doctor context and diagnostics, reserving the S4 extension point for the
 * full role×tool isolation matrix (AWI-011).
 */
export const DOCTOR_VISIBILITY_POLICY =
  'S1: proofloop_doctor is available to all roles (FR-006, non-ProofLoop ' +
  'doctor-only); callerRole is carried explicitly for diagnostics and is the ' +
  'S4 extension point for the role×tool isolation matrix (AWI-011).';

/**
 * Derive the OC-0 host capability facts for the doctor's host-api check from
 * the actual execute-time `ToolContext` and the init-time logger adapter.
 * Facts are observed, never invented: the logging capability is probed from
 * the REAL host sink (`await logger.probe()` + `logger.healthy`), never
 * hardcoded. Awaiting the probe observes BOTH a synchronous throw and an
 * asynchronous rejection of the host sink (fail-closed).
 */
export async function deriveHostFacts(
  toolContext: ToolContext,
  logger: LoggerAdapter,
): Promise<HostFacts> {
  // Observe the host logger (fail-closed): a missing/throwing/rejecting sink
  // is absorbed by the adapter and reflected as an unhealthy logging
  // capability, so the host-api check reports it as a structured failure
  // instead of hardcoding `true` or letting plugin initialization throw.
  try {
    await logger.probe();
  } catch {
    // The adapter absorbs sink errors; belt-and-braces only.
  }
  return {
    toolRegistration: true,
    agentIdentity:
      typeof toolContext.agent === 'string' && toolContext.agent.length > 0,
    cancellation: isAbortSignalLike(toolContext.abort),
    logging: logger.healthy,
    worktreeDirectory:
      typeof toolContext.directory === 'string' &&
      typeof toolContext.worktree === 'string',
  };
}

/** AbortSignal-shaped value check (structural, cross-realm safe). */
function isAbortSignalLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { aborted?: unknown }).aborted === 'boolean'
  );
}

/** Human-readable status summary derived from the doctor run. */
export function deriveDoctorStatus(result: DoctorResult): string {
  const failed = result.checks.filter((c) => c.status === 'fail');
  if (failed.length === 0) {
    return `ProofLoop doctor: all ${result.checks.length} checks passed.`;
  }
  return `ProofLoop doctor: ${failed.length} of ${result.checks.length} checks failed (${failed.map((c) => c.checkId).join(', ')}).`;
}

/** Human-readable next-action guidance derived from the doctor run. */
export function deriveDoctorNext(result: DoctorResult): string {
  if (result.result.ok) {
    return 'No action required.';
  }
  const failed = result.checks.filter((c) => c.status === 'fail');
  const targets =
    failed.length > 0 ? `: ${failed.map((c) => c.name).join('; ')}` : '';
  return `Resolve the reported findings${targets}. Full diagnostics are in the host log.`;
}

/**
 * Render the budgeted compact view into the host `output` text envelope.
 *
 * The output exposes each of the six canonical checks INDIVIDUALLY
 * (checkId/name/status/detail) plus the budgeted compact summary — so a host
 * consumer can verify every check from the public output alone (PO-S01-C-01).
 */
export function renderDoctorOutput(
  view: CompactView,
  checks: readonly DoctorCheck[],
): string {
  const lines: string[] = ['ProofLoop Doctor'];
  lines.push(`Status: ${view.status}`);
  lines.push(`Next: ${view.next}`);
  lines.push(`Checks (${checks.length}):`);
  for (const check of checks) {
    lines.push(`- [${check.checkId}] ${check.name}: ${check.status} — ${check.detail}`);
  }
  if (view.findings.length === 0) {
    lines.push('Findings: none');
  } else {
    lines.push(`Findings (${view.findings.length}):`);
    for (const finding of view.findings) {
      lines.push(`- [${finding.code}] ${finding.severity}: ${finding.message}`);
    }
  }
  if (view.refs.length > 0) {
    lines.push('Receipts:');
    for (const ref of view.refs) {
      lines.push(`- ${ref.ref} (${ref.digest})`);
    }
  }
  if (view.truncated.length > 0) {
    lines.push(
      `Truncated fields: ${view.truncated.join(', ')}; full diagnostics: ${view.logRef}`,
    );
  }
  return lines.join('\n');
}

/**
 * Build the `proofloop_doctor` ToolDefinition bound to the plugin's
 * `RuntimeContext`. Execution runs the T03 doctor engine with the canonical
 * trust root, the live version expectations, and the execute-time
 * `ToolContext.abort` passed through as the cancellation signal; the T01
 * ToolResult is projected through the T02 compact renderer into the host
 * `{ output }` envelope.
 */
export function createDoctorTool(context: RuntimeContext): DoctorToolDefinition {
  return {
    description:
      'Run the ProofLoop environment doctor: reports runtime/plugin versions, ' +
      'Git state, project commands/services, artifact root, Receipt schema ' +
      'version, and Host API compatibility. Available in any project.',
    args: {},
    async execute(_args, toolContext) {
      // S1 visibility policy: doctor is all-roles-available (FR-006); the
      // caller role is carried explicitly as the S4 extension point.
      const deps: DoctorDeps = {
        projectRoot: context.projectRoot,
        runProcess,
        expectations: RUNTIME_LOCK_EXPECTATIONS,
        hostFacts: await deriveHostFacts(toolContext, context.logger),
        logger: context.logger,
        cancellationSignal: toolContext.abort,
        callerRole: toolContext.agent,
      };

      const doctorResult = await runDoctor(deps);

      // Cooperative cancellation: a caller abort must PROPAGATE as AbortError —
      // never swallowed into a plain finding nor reported as a clean result.
      if (toolContext.abort.aborted) {
        throw createAbortError();
      }

      // Full diagnostics already went to the logger (T02 separation); the
      // compact result never carries the log body back.
      context.logger.info('doctor tool: executed', {
        callerRole: toolContext.agent,
        ok: doctorResult.result.ok,
        checkCount: doctorResult.checks.length,
      });

      const view = renderCompact(
        {
          result: doctorResult.result,
          status: deriveDoctorStatus(doctorResult),
          next: deriveDoctorNext(doctorResult),
        },
        { logger: context.logger },
      );

      return { output: renderDoctorOutput(view, doctorResult.checks) };
    },
  };
}

/** AbortError with the canonical `name` expected by hosts (cooperative cancel). */
function createAbortError(): Error {
  const error = new Error('proofloop_doctor was aborted by the caller');
  error.name = 'AbortError';
  return error;
}
