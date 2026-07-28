import { ChildProcess } from 'node:child_process';
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
export interface ServiceHandle {
    pid: number;
    process: ChildProcess;
    getStdout(): string;
    getStderr(): string;
}
export interface SpawnServiceResult {
    handle: ServiceHandle;
}
/**
 * Spawn a long-running service process.
 *
 * Unlike runProcess(), this does NOT wait for close — it spawns and returns
 * immediately with a handle that provides access to the child process and its
 * accumulated stdout/stderr.
 *
 * The caller must eventually call stopService() or cleanupServices().
 */
export declare function spawnService(options: SpawnOptions): Promise<ServiceHandle>;
/**
 * Register a running service under a logical name.
 * The name is typically the step id from the manifest.
 */
export declare function registerService(name: string, handle: ServiceHandle): void;
/**
 * Look up a registered service by name.
 * Returns undefined if no service is registered under that name.
 */
export declare function getRegisteredService(name: string): ServiceHandle | undefined;
/**
 * Stop a service process gracefully:
 * 1. Send SIGTERM
 * 2. Wait up to `graceMs` for clean exit
 * 3. If still alive, send SIGKILL
 *
 * After stopping, the service is removed from the registry.
 */
export declare function stopService(pid: number, graceMs?: number): Promise<void>;
/**
 * Stop a registered service by its logical name.
 * Convenience wrapper around stopService(pid).
 */
export declare function stopRegisteredService(name: string, graceMs?: number): Promise<boolean>;
export interface ReadinessResult {
    /** Whether the readiness signal was found. */
    ready: boolean;
    /** Whether the process exited before readiness was determined. */
    exited: boolean;
    /** The process exit code, if the process exited. */
    exitCode: number | null;
}
/**
 * Wait for a service's output to contain the readiness signal.
 *
 * Polls accumulated stdout+stderr every 200ms until the signal is found,
 * the process exits, or the timeout expires.
 *
 * Returns a structured ReadinessResult.
 */
export declare function waitForReadiness(handle: ServiceHandle, signal: string, timeoutMs: number): Promise<ReadinessResult>;
export interface ServiceCleanupResult {
    /** Names of services that were successfully stopped. */
    cleaned: string[];
    /** Details of services that failed to stop. */
    failed: Array<{
        service: string;
        pid: number;
        reason: string;
    }>;
    /** PIDs that were still alive after the stop attempt. */
    remainingPids: number[];
}
/**
 * Stop and remove all registered services.
 * Each service receives SIGTERM with a 5s grace period before SIGKILL.
 *
 * Returns a structured result with success/failure details.
 */
export declare function cleanupServices(): Promise<ServiceCleanupResult>;
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
