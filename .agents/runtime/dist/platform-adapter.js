import { execSync } from 'node:child_process';
import * as os from 'node:os';
// ── Platform detection ─────────────────────────────────────────────────────────
export function getPlatformInfo() {
    const p = os.platform();
    return {
        platform: p,
        isWindows: p === 'win32',
        isPosix: p === 'linux' || p === 'darwin',
    };
}
// ── Process tree kill ──────────────────────────────────────────────────────────
/**
 * Kill an entire process tree.
 *
 * - POSIX: sends signal to the process group (negative PID).
 * - Windows: uses `taskkill /T /F` to terminate the tree recursively.
 */
export function killProcessTree(pid, signal) {
    const info = getPlatformInfo();
    if (info.isWindows) {
        try {
            execSync(`taskkill /PID ${pid} /T /F 2>nul`, { stdio: 'ignore' });
        }
        catch {
            // Process may already be dead; ignore
        }
        return;
    }
    // POSIX: negative PID targets the process group
    try {
        process.kill(-pid, signal);
    }
    catch {
        // If process group kill fails, try direct kill
        try {
            process.kill(pid, signal);
        }
        catch {
            // Process may already be dead; ignore
        }
    }
}
/**
 * Determine whether a process is still alive on the current platform.
 */
export function isProcessAlive(pid) {
    try {
        // POSIX: kill 0 probes existence without sending a signal
        if (getPlatformInfo().isPosix) {
            process.kill(pid, 0);
            return true;
        }
        // Windows: use tasklist /FI
        const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return output.includes(String(pid));
    }
    catch {
        return false;
    }
}
// ── Path normalisation ─────────────────────────────────────────────────────────
/**
 * Normalise path separators to forward slashes for cross-platform consistency.
 */
export function normalizePath(p) {
    return p.replace(/\\/g, '/');
}
/**
 * Resolve a path, normalising the result.
 */
export function resolvePath(...segments) {
    return normalizePath(segments.reduce((acc, s) => {
        // Simple path join without node:path to keep it isolated
        if (acc === '')
            return s;
        return acc.endsWith('/') || s.startsWith('/') ? `${acc}${s}` : `${acc}/${s}`;
    }, ''));
}
// ── Shell prohibition helpers ──────────────────────────────────────────────────
const SHELL_EXECUTABLES = new Set([
    'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
    'cmd', 'cmd.exe', 'powershell', 'pwsh', 'pwsh.exe',
]);
/**
 * Returns true if the executable name is a recognised shell.
 */
export function isShellExecutable(executable) {
    const base = executable.toLowerCase().replace(/\.(exe|bat|cmd)$/, '');
    return SHELL_EXECUTABLES.has(base) || SHELL_EXECUTABLES.has(executable.toLowerCase());
}
const SHELL_OPERATOR_RE = /[|><&;`$]/;
/**
 * Returns true if the argument string contains shell operators.
 */
export function containsShellOperator(arg) {
    return SHELL_OPERATOR_RE.test(arg);
}
// ── Port checking ──────────────────────────────────────────────────────────────
/**
 * Check if a local TCP port is in use.
 */
export function isPortInUse(port, host = '127.0.0.1') {
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
        // POSIX: use ss or lsof
        try {
            execSync(`ss -tlnp sport = :${port} 2>/dev/null`, {
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 5000,
            });
            return true;
        }
        catch {
            try {
                execSync(`lsof -i :${port} 2>/dev/null`, {
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 5000,
                });
                return true;
            }
            catch {
                return false;
            }
        }
    }
    catch {
        return false;
    }
}
/**
 * Wait until a port is no longer in use, with timeout.
 * Returns true if port freed, false if timeout.
 */
export function waitForPortFree(port, host = '127.0.0.1', timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isPortInUse(port, host))
            return true;
        // Sleep 200ms
        const start = Date.now();
        while (Date.now() - start < 200) {
            // busy-spin is acceptable for short waits
        }
    }
    return !isPortInUse(port, host);
}
//# sourceMappingURL=platform-adapter.js.map