/**
 * @proofloop/opencode-plugin — RuntimeContext host adapter boundary (ADR-002).
 *
 * S01-B-T01: assembles the RuntimeContext consumed by detection/lock
 * decisions (T02/T03) and later tools (S01-C). The trust root is the
 * canonical realpath of `PluginInput.worktree` — NEVER a bare
 * `process.cwd()` (ADR-004). The session directory, caller role, cancellation
 * signal and host logger are carried through from the real host shapes:
 *
 *   - projectRoot        = realpath(PluginInput.worktree)
 *   - currentDirectory   = PluginInput.directory
 *   - callerRole         = ToolContext.agent (tool-execute time)
 *   - cancellationSignal = ToolContext.abort (same signal object, never
 *                          replaced or swallowed)
 *   - logger             = adapter over host client.app.log
 *
 * Host types are imported type-only via the tsconfig `paths` mapping to
 * `.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`; there is no
 * runtime dependency on the host package (ADR-003 / offline repository).
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createLoggerAdapter, type LoggerAdapter } from './adapters/logger.js';
import { PROOFLOOP_DIR } from './project-detection.js';

/** Canonical service name stamped on host log entries. */
export const RUNTIME_CONTEXT_SERVICE = '@proofloop/opencode-plugin';

/**
 * Host-adapted runtime context (AWI-002 / tech-spec/ai-coding-architecture.md
 * host-context component).
 *
 * `callerRole` / `cancellationSignal` are populated from the tool-execute
 * `ToolContext` when available; during plugin initialization (no ToolContext
 * yet) they are `undefined`. They are never invented, defaulted or replaced
 * by the plugin.
 */
export interface RuntimeContext {
  /** Canonical worktree root (realpath-normalized). Never process.cwd(). */
  projectRoot: string;
  /** Session current directory (PluginInput.directory). */
  currentDirectory: string;
  /** Caller role from ToolContext.agent at tool-execute time. */
  callerRole: string | undefined;
  /** Cancellation signal from ToolContext.abort (passthrough, not replaced). */
  cancellationSignal: AbortSignal | undefined;
  /** Host logger adapter (client.app.log). */
  logger: LoggerAdapter;
}

/**
 * Assemble the RuntimeContext from host-shaped inputs.
 *
 * `input` is the plugin initialization `PluginInput` (init phase); the
 * optional `toolContext` supplies the tool-execution identity and
 * cancellation signal (tool execute phase). The worktree trust root is
 * resolved to its canonical realpath; a nonexistent worktree path fails
 * loudly rather than falling back to any guessed root (fail-closed, ADR-004).
 */
export function createRuntimeContext(
  input: PluginInput,
  toolContext?: ToolContext,
): RuntimeContext {
  const projectRoot = realpathSync(input.worktree);
  return {
    projectRoot,
    currentDirectory: input.directory,
    callerRole: toolContext?.agent,
    cancellationSignal: toolContext?.abort,
    // S1-F-002: the logger persists every structured diagnostic entry to the
    // canonical `<projectRoot>/.proofloop/logs/` directory (created lazily on
    // the first write) and exposes a traceable `.proofloop/logs/<file>` ref so
    // compact output can point at the full persisted diagnostics.
    logger: createLoggerAdapter(
      (options) => input.client.app.log(options),
      RUNTIME_CONTEXT_SERVICE,
      {
        projectRoot,
        logsDir: path.join(projectRoot, PROOFLOOP_DIR, 'logs'),
      },
    ),
  };
}
