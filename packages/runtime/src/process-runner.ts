/**
 * @proofloop/runtime — Process Runner (B1a, blueprint §11)
 *
 * The runtime's process execution seam, ported from the legacy
 * `.agents/runtime/src/process-manager.ts` (behavior authority) with the
 * new-runtime hardening and zero host dependencies (Node built-ins only):
 *
 *   runProcess(options)        — one-shot execution: spawn → bounded output →
 *                                timeout → process-tree cleanup → structured
 *                                ProcessResult. `shell: false` always; shell
 *                                executables and shell operators are REJECTED
 *                                (validateSpawnOptions enforced inside, throws
 *                                SpawnValidationError before any process is
 *                                spawned). Optional AbortSignal cancellation
 *                                (blueprint §10 cancellationSignal) runs the
 *                                same SIGTERM → grace → SIGKILL cleanup and is
 *                                surfaced via the additive `canceled` field.
 *
 *   spawnService / registerService / getRegisteredService / stopService /
 *   stopRegisteredService / cleanupServices
 *                                — long-running service lifecycle. A service
 *                                is spawned detached (own process group on
 *                                POSIX), registered under a logical name,
 *                                stopped via SIGTERM → grace → SIGKILL with
 *                                tree kill, and the registry is emptied by
 *                                cleanupServices().
 *
 *   waitForReadiness(handle, signal, timeoutMs)
 *                                — readiness primitive: poll accumulated
 *                                stdout+stderr for the signal; fast-fail when
 *                                the process exits first; ready=false on
 *                                timeout (parity with the legacy
 *                                run-stage.ts service_start semantics).
 *
 *   cleanupProcesses / checkPortsFree
 *                                — teardown helpers over the platform seam.
 *
 * Platform adaptation (killProcessTree / isProcessAlive / isPortInUse /
 * waitForPortFree / normalizePath / resolvePath / shell prohibition
 * predicates) lives in ./platform-adapter and is re-exported at the index.
 *
 * Deviation notes vs. the legacy implementation (deliberate, see report):
 *   - runProcess ENFORCES validateSpawnOptions (legacy left validation to the
 *     caller) and throws SpawnValidationError;
 *   - ProcessResult gains `canceled: boolean` (legacy had no cancellation);
 *   - SpawnOptions gains `cancellationSignal?: AbortSignal` and
 *     `graceMs?: number` (SIGTERM→SIGKILL grace tuning, default 5000);
 *   - stopService takes `string | ServiceHandle` (name or live reference)
 *     and returns boolean (false = unknown name), throwing only when the
 *     process survives SIGTERM + SIGKILL;
 *   - cleanupServices() clears the registry after the stop pass.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  getPlatformInfo,
  killProcessTree,
  isProcessAlive,
  isPortInUse,
  isShellExecutable,
  containsShellOperator,
} from './platform-adapter';

// ============================================================
// Constants
// ============================================================

/** stdout capture cap — 1 MiB. */
export const MAX_STDOUT_BYTES = 1_048_576;
/** stderr capture cap — 512 KiB. */
export const MAX_STDERR_BYTES = 524_288;
/** Grace period between SIGTERM and SIGKILL during forced termination. */
export const GRACE_PERIOD_MS = 5_000;
/** Default command timeout. */
export const DEFAULT_TIMEOUT_MS = 300_000;
/** Readiness poll interval. */
export const READINESS_POLL_MS = 200;
/** stopService / stopRegisteredService liveness poll interval. */
export const STOP_POLL_MS = 100;
/** Time allowed for SIGKILL to take effect before reporting failure. */
export const KILL_CONFIRM_MS = 2_000;

// ============================================================
// Types
// ============================================================

export interface ProcessResult {
  /** Exit code, or null when the process was killed by a signal or failed to spawn. */
  exitCode: number | null;
  /** Signal that terminated the process (e.g. 'SIGTERM'), or null. */
  signal: string | null;
  /** Captured stdout, truncated at MAX_STDOUT_BYTES. */
  stdout: string;
  /** Captured stderr, truncated at MAX_STDERR_BYTES (spawn errors land here). */
  stderr: string;
  /** True when the run was terminated by the timeout path. */
  timedOut: boolean;
  /**
   * True when the run was terminated by the caller's AbortSignal
   * (new-runtime enhancement; the legacy shape had no cancellation).
   */
  canceled: boolean;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
}

export interface SpawnOptions {
  /** Executable to run (resolved through PATH; never through a shell). */
  executable: string;
  /** Structured argument list — shell operators are rejected. */
  args: string[];
  /** Working directory (defaults to process.cwd()). */
  cwd?: string;
  /** Hard timeout in ms (default DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * SIGTERM→SIGKILL grace in ms (default GRACE_PERIOD_MS). A tuning knob for
   * hosts that need faster escalation (and for deterministic tests).
   */
  graceMs?: number;
  /** Environment overrides (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /**
   * Optional AbortSignal (blueprint §10 cancellationSignal): abort runs the
   * same SIGTERM → grace → SIGKILL cleanup as timeout and the result is
   * marked `canceled: true`.
   */
  cancellationSignal?: AbortSignal;
}

export interface SpawnValidation {
  valid: boolean;
  errors: string[];
}

export interface ServiceHandle {
  pid: number;
  process: ChildProcess;
  /** Accumulated stdout since spawn (unbounded). */
  getStdout(): string;
  /** Accumulated stderr since spawn (unbounded). */
  getStderr(): string;
}

export interface ReadinessResult {
  /** Whether the readiness signal was found. */
  ready: boolean;
  /** Whether the process exited before readiness was determined. */
  exited: boolean;
  /** The process exit code, if the process exited. */
  exitCode: number | null;
}

export interface ServiceCleanupResult {
  /** Names of services that were successfully stopped. */
  cleaned: string[];
  /** Details of services that failed to stop. */
  failed: Array<{ service: string; pid: number; reason: string }>;
  /** PIDs that were still alive after the stop attempt. */
  remainingPids: number[];
}

export interface CleanupResult {
  cleaned: number;
  failed: string[];
  remainingPids: number[];
}

/**
 * Platform adapter seam for stopService — lets tests inject mock
 * kill/liveness implementations without global module mocks.
 */
export interface StopServicePlatform {
  killProcessTree(pid: number, signal: string): void;
  isProcessAlive(pid: number): boolean;
}

// ============================================================
// Spawn validation
// ============================================================

/**
 * Error thrown by runProcess when the spawn options violate the shell
 * prohibition rules. Carries the human-readable validation errors.
 */
export class SpawnValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(
      `Spawn options rejected by shell prohibition rules:\n- ${errors.join('\n- ')}`,
    );
    this.name = 'SpawnValidationError';
    this.errors = [...errors];
  }
}

/**
 * Validate spawn options against the shell prohibition rules:
 * - No shell executables (sh, bash, zsh, dash, ksh, fish, cmd, powershell, pwsh);
 * - No shell operators in any arg (|, >, <, &, ;, `, $);
 * - shell:true is impossible by construction (spawn always uses shell:false).
 */
export function validateSpawnOptions(options: SpawnOptions): SpawnValidation {
  const errors: string[] = [];

  if (isShellExecutable(options.executable)) {
    errors.push(
      `Shell execution is prohibited: executable "${options.executable}" is a recognised shell. ` +
      `Use a direct binary instead of a shell command string.`,
    );
  }

  for (let i = 0; i < options.args.length; i++) {
    if (containsShellOperator(options.args[i])) {
      errors.push(
        `Shell operator detected in args[${i}]: "${options.args[i]}". ` +
        `Pipes, redirects, chains, and command substitution are prohibited.`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================
// One-shot process execution
// ============================================================

/**
 * Run a child process with strict timeout and cleanup.
 *
 * - Spawns directly (`shell: false`, no shell wrapper); shell executables /
 *   shell operators are rejected up front (SpawnValidationError).
 * - On timeout or AbortSignal abort: SIGTERM to the process tree (POSIX
 *   negative-PID group kill) → GRACE_PERIOD_MS → SIGKILL when still alive.
 * - Captures stdout (≤ 1 MiB) / stderr (≤ 512 KiB) with truncation.
 * - Spawn failure (e.g. ENOENT) resolves with exitCode null and the error
 *   message in stderr — never throws for process-level failures.
 *
 * @throws {SpawnValidationError} when the executable is a recognised shell or
 *   an arg contains a shell operator (validated before spawning).
 */
export async function runProcess(options: SpawnOptions): Promise<ProcessResult> {
  // Enforce the shell prohibition rules BEFORE any process is spawned
  // (hardening over the legacy runtime, which left validation to the caller).
  const validation = validateSpawnOptions(options);
  if (!validation.valid) {
    throw new SpawnValidationError(validation.errors);
  }

  const {
    executable,
    args,
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    graceMs = GRACE_PERIOD_MS,
    env = process.env as Record<string, string | undefined>,
    cancellationSignal,
  } = options;

  const platform = getPlatformInfo();
  const startTime = Date.now();

  const child: ChildProcess = spawn(executable, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: detached → own process group so tree kill via negative PID works.
    ...(platform.isPosix ? { detached: true } : {}),
    shell: false,
  });

  let timedOut = false;
  let canceled = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  // ── Forced termination (shared by timeout and cancellation) ──
  // SIGTERM to the tree, then SIGKILL after the grace period if still alive.
  const terminate = (): void => {
    if (child.pid === undefined) return; // spawn failure path ('error' resolves)
    killProcessTree(child.pid, 'SIGTERM');
    graceTimer = setTimeout(() => {
      if (child.pid !== undefined && isProcessAlive(child.pid)) {
        killProcessTree(child.pid, 'SIGKILL');
      }
    }, graceMs);
  };

  // ── Timeout path ──
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);

  // ── Cancellation path (new-runtime enhancement) ──
  if (cancellationSignal !== undefined) {
    if (cancellationSignal.aborted) {
      canceled = true;
      terminate();
    } else {
      abortListener = () => {
        canceled = true;
        terminate();
      };
      cancellationSignal.addEventListener('abort', abortListener, { once: true });
    }
  }

  // ── Output collection with size caps ──
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_STDOUT_BYTES) {
        const remaining = MAX_STDOUT_BYTES - stdoutBytes;
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += Math.min(chunk.length, remaining);
      }
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_BYTES) {
        const remaining = MAX_STDERR_BYTES - stderrBytes;
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += Math.min(chunk.length, remaining);
      }
    });
  }

  // ── Result promise ──
  return new Promise<ProcessResult>((resolve) => {
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (cancellationSignal !== undefined && abortListener !== undefined) {
        cancellationSignal.removeEventListener('abort', abortListener);
      }
    };

    child.on('close', (exitCode, signal) => {
      cleanup();
      resolve({
        exitCode,
        signal: signal ?? null,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut,
        canceled,
        durationMs: Date.now() - startTime,
      });
    });

    child.on('error', (err) => {
      cleanup();
      resolve({
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: err.message,
        timedOut,
        canceled,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// ============================================================
// Long-running service management
// ============================================================

// Module-level service registry (keyed by logical service name / step id).
const serviceRegistry = new Map<string, ServiceHandle>();

/**
 * Spawn a long-running service process.
 *
 * Unlike runProcess(), this does NOT wait for close — it spawns and returns
 * immediately with a handle exposing the child process and its accumulated
 * stdout/stderr. The 'error' event is swallowed (spawn failures surface via
 * the pid check or caller logic). The caller must eventually call
 * stopService() or cleanupServices().
 *
 * The executable/args are NOT shell-prohibited-validated here (parity with
 * the legacy runtime): spawnService is the service-lifecycle seam and the
 * caller is responsible for validated command specs.
 *
 * @throws {Error} when the process was not assigned a PID (spawn failure).
 */
export async function spawnService(options: SpawnOptions): Promise<ServiceHandle> {
  const {
    executable,
    args,
    cwd = process.cwd(),
    env = process.env as Record<string, string | undefined>,
  } = options;

  const platform = getPlatformInfo();

  const child: ChildProcess = spawn(executable, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(platform.isPosix ? { detached: true } : {}),
    shell: false,
  });

  // Suppress unhandled 'error' events (e.g. ENOENT) — the pid check below
  // handles the failure and prevents Node.js process crashes.
  child.on('error', () => {
    /* swallowed — handled via pid check or caller logic */
  });

  let stdout = '';
  let stderr = '';

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
  }

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`Failed to spawn service: ${executable} ${args.join(' ')} — no PID assigned`);
  }

  return {
    pid,
    process: child,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

/**
 * Register a running service under a logical name (typically the step id
 * from the manifest — the service_start/service_stop wiring of run-gate).
 */
export function registerService(name: string, handle: ServiceHandle): void {
  serviceRegistry.set(name, handle);
}

/**
 * Look up a registered service by name.
 * Returns undefined when no service is registered under that name.
 */
export function getRegisteredService(name: string): ServiceHandle | undefined {
  return serviceRegistry.get(name);
}

/** Remove every registry entry bound to the given PID. */
function removeServiceFromRegistry(pid: number): void {
  for (const [name, entry] of serviceRegistry) {
    if (entry.pid === pid) {
      serviceRegistry.delete(name);
    }
  }
}

/**
 * Stop a service process gracefully:
 *   1. SIGTERM to the process tree;
 *   2. wait up to `graceMs` for a clean exit (100ms polls);
 *   3. SIGKILL to the tree when still alive;
 *   4. wait up to KILL_CONFIRM_MS for the kill to take effect.
 *
 * After stopping, the service is removed from the registry.
 *
 * @param target  logical registry name, or a live ServiceHandle reference.
 * @returns true when the service was found and stopped; false when a NAME
 *   target is not registered (a handle target is always "found").
 * @throws {Error} when the process remains alive after SIGTERM + SIGKILL
 *   (message: `Process <pid> remained alive after SIGTERM + SIGKILL`).
 */
export async function stopService(
  target: string | ServiceHandle,
  graceMs: number = GRACE_PERIOD_MS,
  platform?: StopServicePlatform,
): Promise<boolean> {
  let pid: number;
  if (typeof target === 'string') {
    const entry = serviceRegistry.get(target);
    if (entry === undefined) return false;
    pid = entry.pid;
  } else {
    pid = target.pid;
  }

  const kill = platform?.killProcessTree ?? killProcessTree;
  const alive = platform?.isProcessAlive ?? isProcessAlive;

  // Stage 1: SIGTERM, then wait for graceful shutdown.
  kill(pid, 'SIGTERM');

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      removeServiceFromRegistry(pid);
      return true;
    }
    await sleep(STOP_POLL_MS);
  }

  // Final liveness check before escalating.
  if (!alive(pid)) {
    removeServiceFromRegistry(pid);
    return true;
  }

  // Stage 2: SIGKILL, then wait for the kill to take effect.
  kill(pid, 'SIGKILL');

  const killDeadline = Date.now() + KILL_CONFIRM_MS;
  while (Date.now() < killDeadline) {
    if (!alive(pid)) {
      removeServiceFromRegistry(pid);
      return true;
    }
    await sleep(STOP_POLL_MS);
  }

  // Process refused to die even after SIGKILL.
  throw new Error(`Process ${pid} remained alive after SIGTERM + SIGKILL`);
}

/**
 * Stop a registered service by logical name.
 * Convenience wrapper over stopService(name) — returns false when no service
 * is registered under that name (parity with the legacy run-stage
 * service_stop wiring).
 */
export async function stopRegisteredService(
  name: string,
  graceMs: number = GRACE_PERIOD_MS,
): Promise<boolean> {
  return stopService(name, graceMs);
}

// ============================================================
// Readiness primitive
// ============================================================

/**
 * Wait for a service's output to contain the readiness signal.
 *
 * Polls accumulated stdout+stderr every READINESS_POLL_MS until the signal
 * is found, the process exits first (fast-fail, `exited: true` with the exit
 * code), or the timeout expires (`ready: false`).
 */
export async function waitForReadiness(
  handle: ServiceHandle,
  signal: string,
  timeoutMs: number,
): Promise<ReadinessResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Fast-fail when the process exited before emitting the signal.
    if (handle.process.exitCode !== null) {
      return { ready: false, exited: true, exitCode: handle.process.exitCode };
    }

    const stdout = handle.getStdout();
    const stderr = handle.getStderr();
    if (stdout.includes(signal) || stderr.includes(signal)) {
      return { ready: true, exited: false, exitCode: null };
    }

    await sleep(READINESS_POLL_MS);
  }

  // One last check before giving up.
  if (handle.process.exitCode !== null) {
    return { ready: false, exited: true, exitCode: handle.process.exitCode };
  }

  const stdout = handle.getStdout();
  const stderr = handle.getStderr();
  if (stdout.includes(signal) || stderr.includes(signal)) {
    return { ready: true, exited: false, exitCode: null };
  }

  return { ready: false, exited: false, exitCode: null };
}

// ============================================================
// Registry cleanup
// ============================================================

/**
 * Stop and remove ALL registered services.
 *
 * Each service receives SIGTERM with a GRACE_PERIOD_MS grace before SIGKILL.
 * After the stop pass the registry is fully cleared (new-runtime semantics:
 * cleanup means cleanup). Returns a structured result with success/failure
 * details.
 */
export async function cleanupServices(): Promise<ServiceCleanupResult> {
  const cleaned: string[] = [];
  const failed: Array<{ service: string; pid: number; reason: string }> = [];
  const remainingPids: number[] = [];

  const names = Array.from(serviceRegistry.keys());
  for (const name of names) {
    const entry = serviceRegistry.get(name);
    if (entry === undefined) continue;

    try {
      await stopService(name);
      cleaned.push(name);
    } catch (err) {
      failed.push({
        service: name,
        pid: entry.pid,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    // Check whether the service is still alive after the stop attempt.
    try {
      if (isProcessAlive(entry.pid)) {
        remainingPids.push(entry.pid);
      }
    } catch {
      // Process gone; good
    }
  }

  // Cleanup means cleanup: the registry is emptied regardless of outcome.
  serviceRegistry.clear();

  return { cleaned, failed, remainingPids };
}

/**
 * Force-kill a list of known PIDs and their process trees (SIGKILL).
 * Returns a cleanup summary including any remaining alive PIDs.
 */
export async function cleanupProcesses(knownPids: number[]): Promise<CleanupResult> {
  let cleaned = 0;
  const failed: string[] = [];
  const remainingPids: number[] = [];

  for (const pid of knownPids) {
    try {
      killProcessTree(pid, 'SIGKILL');
      cleaned++;
    } catch (err) {
      failed.push(`PID ${pid}: ${err}`);
    }

    try {
      if (isProcessAlive(pid)) {
        remainingPids.push(pid);
      }
    } catch {
      // Process gone; good
    }
  }

  return { cleaned, failed, remainingPids };
}

/**
 * Validate that all ports in a list are free after shutdown.
 * Returns the ports still in use.
 */
export async function checkPortsFree(ports: number[], host: string = '127.0.0.1'): Promise<number[]> {
  const inUse: number[] = [];
  for (const port of ports) {
    if (isPortInUse(port, host)) {
      inUse.push(port);
    }
  }
  return inUse;
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
