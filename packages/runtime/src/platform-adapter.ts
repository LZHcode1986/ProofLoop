/**
 * @proofloop/runtime — Platform adapter (B1a process-runner platform seam)
 *
 * Host-OS adaptation for the Process Runner: process-tree kill semantics,
 * liveness probing, port probing, path normalisation and the shell
 * prohibition predicates. Zero host dependencies — Node built-ins only
 * (`node:os` / `node:child_process`); external OS utilities (`taskkill` /
 * `tasklist` / `netstat` on Windows, `ss` / `lsof` on POSIX) are used purely
 * as process/port introspection helpers, never as command execution.
 *
 * Behaviour notes (parity with the legacy `.agents/runtime` platform-adapter
 * with one correctness fix):
 *   - `killProcessTree`: POSIX targets the process group via negative PID
 *     (children spawned `detached` live in their own group); Windows uses
 *     `taskkill /T /F`. Both swallow "already dead" errors.
 *   - `isProcessAlive`: POSIX `kill(pid, 0)` probe; Windows `tasklist /FI`.
 *   - `isPortInUse`: Windows `netstat -ano | findstr :<port>`; POSIX `ss`
 *     output is PARSED for an actual LISTEN entry (modern `ss` exits 0 even
 *     with no matches, so exit-code probing alone reports every port in use),
 *     falling back to `lsof` when `ss` is unavailable.
 *
 * The module is exported through the package index so host adapters and the
 * run-gate (B1b) can reuse the same platform semantics.
 */

import { execSync } from 'node:child_process';
import * as os from 'node:os';

// ============================================================
// Types
// ============================================================

export type Platform = 'win32' | 'linux' | 'darwin';

export interface PlatformInfo {
  readonly platform: Platform;
  readonly isWindows: boolean;
  readonly isPosix: boolean;
}

// ============================================================
// Platform detection
// ============================================================

/** Detect the current OS family (win32 / linux / darwin). */
export function getPlatformInfo(): PlatformInfo {
  const p = os.platform() as Platform;
  return {
    platform: p,
    isWindows: p === 'win32',
    isPosix: p === 'linux' || p === 'darwin',
  };
}

// ============================================================
// Process tree kill & liveness
// ============================================================

/**
 * Kill an entire process tree.
 *
 * - POSIX: sends `signal` to the process group (negative PID) — the tree
 *   because services are spawned `detached` into their own group.
 * - Windows: `taskkill /T /F` terminates the tree recursively.
 *
 * Errors are swallowed: the process may already be dead (race between
 * liveness probe and kill), which is the common expected outcome.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  const info = getPlatformInfo();

  if (info.isWindows) {
    try {
      execSync(`taskkill /PID ${pid} /T /F 2>nul`, { stdio: 'ignore' });
    } catch {
      // Process may already be dead; ignore
    }
    return;
  }

  // POSIX: negative PID targets the process group
  try {
    process.kill(-pid, signal);
  } catch {
    // If process group kill fails, try direct kill
    try {
      process.kill(pid, signal);
    } catch {
      // Process may already be dead; ignore
    }
  }
}

/**
 * Determine whether a process is still alive on the current platform.
 * POSIX: `kill(pid, 0)` probes existence without sending a signal.
 * Windows: `tasklist /FI` output match.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    if (getPlatformInfo().isPosix) {
      process.kill(pid, 0);
      return true;
    }
    const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.includes(String(pid));
  } catch {
    return false;
  }
}

// ============================================================
// Path normalisation
// ============================================================

/** Normalise path separators to forward slashes for cross-platform consistency. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Resolve a path from segments, normalising the result.
 * Mirrors the legacy runtime's dependency-free join (no `node:path` import
 * keeps the module surface minimal; segments are joined with '/').
 */
export function resolvePath(...segments: string[]): string {
  return normalizePath(
    segments.reduce((acc, s) => {
      if (acc === '') return s;
      return acc.endsWith('/') || s.startsWith('/') ? `${acc}${s}` : `${acc}/${s}`;
    }, ''),
  );
}

// ============================================================
// Shell prohibition predicates
// ============================================================

const SHELL_EXECUTABLES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'cmd', 'cmd.exe', 'powershell', 'pwsh', 'pwsh.exe',
]);

/**
 * True when the executable name is a recognised shell. Extension-agnostic:
 * `cmd`, `cmd.exe`, `powershell`, `pwsh.exe` … all match.
 */
export function isShellExecutable(executable: string): boolean {
  const base = executable.toLowerCase().replace(/\.(exe|bat|cmd)$/, '');
  return SHELL_EXECUTABLES.has(base) || SHELL_EXECUTABLES.has(executable.toLowerCase());
}

const SHELL_OPERATOR_RE = /[|><&;`$]/;

/** True when the argument string contains a shell operator (pipe / redirect / chain / substitution). */
export function containsShellOperator(arg: string): boolean {
  return SHELL_OPERATOR_RE.test(arg);
}

// ============================================================
// Port checking
// ============================================================

/**
 * Check whether a local TCP port is in use.
 *
 * POSIX: runs `ss -tlnp sport = :<port>` and parses the output for an actual
 * LISTEN entry. Parsing (not exit-code probing) is required: modern `ss`
 * exits 0 even when nothing matches, so an exit-code-only check would report
 * every port as in use. Falls back to `lsof -i :<port>` when `ss` is
 * unavailable or fails.
 *
 * Windows: `netstat -ano | findstr :<port>`.
 */
export function isPortInUse(port: number, host: string = '127.0.0.1'): boolean {
  try {
    const info = getPlatformInfo();
    if (info.isWindows) {
      const output = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      return output.includes(`:${port}`);
    }

    // POSIX: prefer `ss`, parsing the output for a real LISTEN entry.
    try {
      const output = execSync(`ss -tlnp sport = :${port} 2>/dev/null`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      if (/LISTEN/.test(output) && output.includes(`:${port}`)) return true;
    } catch {
      // ss unavailable or failed — fall through to lsof
    }

    try {
      const output = execSync(`lsof -i :${port} 2>/dev/null`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      return output.includes(`:${port}`);
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Wait until a port is no longer in use, with timeout.
 * Returns true when the port became free, false on timeout.
 * (Synchronous busy-wait — parity with the legacy runtime.)
 */
export function waitForPortFree(
  port: number,
  host: string = '127.0.0.1',
  timeoutMs: number = 15000,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPortInUse(port, host)) return true;
    // Sleep 200ms
    const start = Date.now();
    while (Date.now() - start < 200) {
      // busy-spin is acceptable for short waits
    }
  }
  return !isPortInUse(port, host);
}
