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
/**
 * Validate spawn options against TS Runner rules:
 * - No shell executables (sh, bash, cmd, powershell, etc.)
 * - No shell operators in args (|, >, <, &, ;, `, $)
 * - No shell:true (not applicable in this API but checked conceptually)
 */
export declare function validateSpawnOptions(options: SpawnOptions): SpawnValidation;
/**
 * Run a child process with strict timeout and cleanup.
 *
 * - Spawns the process directly (no shell wrapper).
 * - On timeout: sends SIGTERM, waits GRACE_PERIOD_MS, then SIGKILL.
 * - Captures stdout/stderr up to size limits.
 * - Returns structured result.
 */
export declare function runProcess(options: SpawnOptions): Promise<ProcessResult>;
export interface CleanupResult {
    cleaned: number;
    failed: string[];
    remainingPids: number[];
}
/**
 * Force-kill a list of known PIDs and their process trees.
 * Returns cleanup summary including any remaining alive PIDs.
 */
export declare function cleanupProcesses(knownPids: number[]): Promise<CleanupResult>;
/**
 * Validate all ports in a list are free after shutdown.
 * Returns those still in use.
 */
export declare function checkPortsFree(ports: number[], host?: string): Promise<number[]>;
