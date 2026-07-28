import { platform } from 'node:os';
import { spawn, ChildProcess } from 'node:child_process';
import { killProcessTree, isProcessAlive, isPortInUse, isShellExecutable, containsShellOperator, getPlatformInfo } from './platform-adapter.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_STDOUT_BYTES = 1_048_576;   // 1 MiB
const MAX_STDERR_BYTES = 524_288;     // 512 KiB
const GRACE_PERIOD_MS = 5_000;        // 5 seconds between SIGTERM and SIGKILL

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface SpawnOptions {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface SpawnValidation {
  valid: boolean;
  errors: string[];
}

// ── Validation ─────────────────────────────────────────────────────────────────

/**
 * Validate spawn options against TS Runner rules:
 * - No shell executables (sh, bash, cmd, powershell, etc.)
 * - No shell operators in args (|, >, <, &, ;, `, $)
 * - No shell:true (not applicable in this API but checked conceptually)
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

// ── Executable resolution ─────────────────────────────────────────────────────

/**
 * Resolve executable path for the current platform.
 *
 * On Windows, Node.js `spawn()` resolves executables via PATHEXT automatically
 * (e.g., `npm` → `npm.cmd`). This function serves as documentation that on
 * Windows we would try `.cmd` suffix first; no explicit suffix addition is needed
 * because the underlying `spawn()` already handles it via PATHEXT.
 */
function resolveExecutable(exec: string): string {
  if (platform() === 'win32' && !exec.endsWith('.exe') && !exec.endsWith('.cmd')) {
    // Node.js spawn() on Windows uses PATHEXT to find the correct executable,
    // so `npm`, `node`, `npx` etc. are resolved to `.cmd` or `.exe` automatically.
    // No suffix change needed here.
  }
  return exec;
}

// ── Process runner ─────────────────────────────────────────────────────────────

/**
 * Run a child process with strict timeout and cleanup.
 *
 * - Spawns the process directly (no shell wrapper).
 * - On timeout: sends SIGTERM, waits GRACE_PERIOD_MS, then SIGKILL.
 * - Captures stdout/stderr up to size limits.
 * - Returns structured result.
 */
export async function runProcess(options: SpawnOptions): Promise<ProcessResult> {
  const {
    executable,
    args,
    cwd = process.cwd(),
    timeoutMs = 300_000,
    env = process.env as Record<string, string | undefined>,
  } = options;

  const platform = getPlatformInfo();
  const startTime = Date.now();

  // Resolve executable (Windows PATHEXT handles .cmd/.exe resolution automatically)
  const resolvedExec = resolveExecutable(executable);

  // Spawn the process
  const child: ChildProcess = spawn(resolvedExec, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // On POSIX, use detached to create a new process group for tree kill
    ...(platform.isPosix ? { detached: true } : {}),
    // On Windows, do NOT use shell
    shell: false,
  });

  let timedOut = false;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  // Collect stdout with size cap
  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_STDOUT_BYTES) {
        const remaining = MAX_STDOUT_BYTES - stdoutBytes;
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += Math.min(chunk.length, remaining);
      }
    });
  }

  // Collect stderr with size cap
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_BYTES) {
        const remaining = MAX_STDERR_BYTES - stderrBytes;
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += Math.min(chunk.length, remaining);
      }
    });
  }

  // ── Timeout handling ──
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;

    if (child.pid === undefined) return;

    // Stage 1: SIGTERM (or equivalent)
    killProcessTree(child.pid, 'SIGTERM');

    // Stage 2: after grace period, SIGKILL if still alive
    graceTimer = setTimeout(() => {
      if (child.pid !== undefined && isProcessAlive(child.pid)) {
        killProcessTree(child.pid, 'SIGKILL');
      }
    }, GRACE_PERIOD_MS);
  }, timeoutMs);

  // ── Result promise ──
  return new Promise<ProcessResult>((resolve) => {
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };

    child.on('close', (exitCode, signal) => {
      cleanup();

      const durationMs = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      resolve({
        exitCode,
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
        durationMs,
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
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// ── Service management ─────────────────────────────────────────────────────────

export interface ServiceHandle {
  pid: number;
  process: ChildProcess;
  getStdout(): string;
  getStderr(): string;
}

export interface SpawnServiceResult {
  handle: ServiceHandle;
}

interface ServiceEntry {
  pid: number;
  process: ChildProcess;
  getStdout(): string;
  getStderr(): string;
}

// Module-level service registry (keyed by service name / step id)
const serviceRegistry = new Map<string, ServiceEntry>();

/**
 * Spawn a long-running service process.
 *
 * Unlike runProcess(), this does NOT wait for close — it spawns and returns
 * immediately with a handle that provides access to the child process and its
 * accumulated stdout/stderr.
 *
 * The caller must eventually call stopService() or cleanupServices().
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
 * Register a running service under a logical name.
 * The name is typically the step id from the manifest.
 */
export function registerService(name: string, handle: ServiceHandle): void {
  serviceRegistry.set(name, {
    pid: handle.pid,
    process: handle.process,
    getStdout: handle.getStdout,
    getStderr: handle.getStderr,
  });
}

/**
 * Look up a registered service by name.
 * Returns undefined if no service is registered under that name.
 */
export function getRegisteredService(name: string): ServiceHandle | undefined {
  const entry = serviceRegistry.get(name);
  if (!entry) return undefined;
  return {
    pid: entry.pid,
    process: entry.process,
    getStdout: entry.getStdout,
    getStderr: entry.getStderr,
  };
}

/**
 * Stop a service process gracefully:
 * 1. Send SIGTERM
 * 2. Wait up to `graceMs` for clean exit
 * 3. If still alive, send SIGKILL
 *
 * After stopping, the service is removed from the registry.
 */
export async function stopService(pid: number, graceMs: number = 5000): Promise<void> {
  // Remove from registry first (prevent double-stop from another code path)
  for (const [name, entry] of serviceRegistry) {
    if (entry.pid === pid) {
      serviceRegistry.delete(name);
      break;
    }
  }

  // Send SIGTERM
  killProcessTree(pid, 'SIGTERM');

  // Wait for graceful shutdown
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(100);
  }

  // Timeout — force kill
  if (isProcessAlive(pid)) {
    killProcessTree(pid, 'SIGKILL');
  }
}

/**
 * Stop a registered service by its logical name.
 * Convenience wrapper around stopService(pid).
 */
export async function stopRegisteredService(name: string, graceMs: number = 5000): Promise<boolean> {
  const entry = serviceRegistry.get(name);
  if (!entry) return false;
  await stopService(entry.pid, graceMs);
  return true;
}

/**
 * Wait for a service's output to contain the readiness signal.
 *
 * Polls accumulated stdout+stderr every 200ms until the signal is found
 * or the timeout expires.
 *
 * Returns true if the signal was found, false on timeout.
 */
export async function waitForReadiness(
  handle: ServiceHandle,
  signal: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const stdout = handle.getStdout();
    const stderr = handle.getStderr();

    if (stdout.includes(signal) || stderr.includes(signal)) {
      return true;
    }

    await sleep(200);
  }

  // One last check before giving up
  const stdout = handle.getStdout();
  const stderr = handle.getStderr();
  return stdout.includes(signal) || stderr.includes(signal);
}

/**
 * Stop and remove all registered services.
 * Each service receives SIGTERM with a 5s grace period before SIGKILL.
 */
export async function cleanupServices(): Promise<void> {
  const names = Array.from(serviceRegistry.keys());
  for (const name of names) {
    const entry = serviceRegistry.get(name);
    if (!entry) continue;
    try {
      await stopService(entry.pid);
    } catch {
      // Best-effort cleanup; ignore individual failures
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

export interface CleanupResult {
  cleaned: number;
  failed: string[];
  remainingPids: number[];
}

/**
 * Force-kill a list of known PIDs and their process trees.
 * Returns cleanup summary including any remaining alive PIDs.
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

    // Check if still alive after kill
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
 * Validate all ports in a list are free after shutdown.
 * Returns those still in use.
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
