export type Platform = 'win32' | 'linux' | 'darwin';
export interface PlatformInfo {
    platform: Platform;
    isWindows: boolean;
    isPosix: boolean;
}
export declare function getPlatformInfo(): PlatformInfo;
/**
 * Kill an entire process tree.
 *
 * - POSIX: sends signal to the process group (negative PID).
 * - Windows: uses `taskkill /T /F` to terminate the tree recursively.
 */
export declare function killProcessTree(pid: number, signal: NodeJS.Signals | 'SIGKILL' | 'SIGTERM'): void;
/**
 * Determine whether a process is still alive on the current platform.
 */
export declare function isProcessAlive(pid: number): boolean;
/**
 * Normalise path separators to forward slashes for cross-platform consistency.
 */
export declare function normalizePath(p: string): string;
/**
 * Resolve a path, normalising the result.
 */
export declare function resolvePath(...segments: string[]): string;
/**
 * Returns true if the executable name is a recognised shell.
 */
export declare function isShellExecutable(executable: string): boolean;
/**
 * Returns true if the argument string contains shell operators.
 */
export declare function containsShellOperator(arg: string): boolean;
/**
 * Check if a local TCP port is in use.
 */
export declare function isPortInUse(port: number, host?: string): boolean;
/**
 * Wait until a port is no longer in use, with timeout.
 * Returns true if port freed, false if timeout.
 */
export declare function waitForPortFree(port: number, host?: string, timeoutMs?: number): boolean;
