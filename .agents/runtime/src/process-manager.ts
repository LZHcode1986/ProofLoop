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

  // Spawn the process
  const child: ChildProcess = spawn(executable, args, {
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
