/**
 * Process Runner — B1a (blueprint §11)
 *
 * Verifies the new-runtime process execution seam against REAL child
 * processes (node subprocesses — no mocks for the execution paths):
 *
 *   - validateSpawnOptions / SpawnValidationError: shell executable &
 *     shell-operator prohibition; runProcess ENFORCES the rules (throws
 *     before spawning) — hardening over the legacy runtime.
 *   - runProcess: normal / non-zero / stderr capture / ENOENT (exitCode null
 *     + error message in stderr) / timeout (SIGTERM → SIGKILL escalation) /
 *     output truncation (stdout 1 MiB, stderr 512 KiB) / AbortSignal
 *     cancellation (`canceled` field, same tree-kill cleanup).
 *   - services: spawnService (immediate handle, ENOENT throws) /
 *     registerService / getRegisteredService / stopService (name | handle,
 *     registry removal, DI kill-failure path) / stopRegisteredService /
 *     cleanupServices (registry fully cleared after the stop pass).
 *   - waitForReadiness: success / process-exit fast-fail / timeout.
 *   - platform adapter: killProcessTree / isProcessAlive / normalizePath /
 *     resolvePath / isShellExecutable / containsShellOperator / isPortInUse
 *     (real LISTEN probe via `ss`) / waitForPortFree; teardown helpers
 *     cleanupProcesses / checkPortsFree.
 *
 * Every spawned child is terminated (timeout/abort kill paths, explicit
 * stop, or afterEach cleanupServices) — the suite must not leave dangling
 * processes.
 *
 * POSIX note: SIGTERM/SIGKILL signal assertions are POSIX behavior; the
 * suite runs on the Linux CI environment.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import {
  runProcess,
  spawnService,
  registerService,
  getRegisteredService,
  stopService,
  stopRegisteredService,
  waitForReadiness,
  cleanupServices,
  cleanupProcesses,
  checkPortsFree,
  validateSpawnOptions,
  SpawnValidationError,
  MAX_STDOUT_BYTES,
  MAX_STDERR_BYTES,
  isProcessAlive,
  normalizePath,
  resolvePath,
  isShellExecutable,
  containsShellOperator,
  isPortInUse,
  waitForPortFree,
} from '@proofloop/runtime';
import type {
  ProcessResult,
  SpawnOptions,
  ServiceHandle,
  ReadinessResult,
} from '@proofloop/runtime';

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Long-running node child script (stays alive until killed). */
// Note: `function () {}` (not arrow functions) — `=>` contains `>`, a shell
// operator that validateSpawnOptions rightly rejects.
const LONG_RUNNING = 'setInterval(function () {}, 60000)';

function runNode(args: string[], overrides: Partial<SpawnOptions> = {}): Promise<ProcessResult> {
  return runProcess({ executable: 'node', args, timeoutMs: 10_000, ...overrides });
}

function listenOnFreePort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('listenOnFreePort: no numeric port assigned'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ============================================================
// Suite
// ============================================================

describe('process-runner', () => {
  afterEach(async () => {
    // No lingering services between tests.
    await cleanupServices();
  });

  // ── validateSpawnOptions & runProcess enforcement ──────────────────────────

  describe('validateSpawnOptions', () => {
    it('rejects shell executables', () => {
      for (const shell of ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'pwsh.exe']) {
        const result = validateSpawnOptions({ executable: shell, args: ['-c', 'echo hi'] });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Shell'))).toBe(true);
      }
    });

    it('rejects shell operators in args', () => {
      for (const op of ['|', '>', '<', '&', ';', '`', '$']) {
        const result = validateSpawnOptions({ executable: 'node', args: ['-e', `console.log(${op})`] });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Shell operator'))).toBe(true);
      }
    });

    it('accepts valid options', () => {
      const result = validateSpawnOptions({ executable: 'node', args: ['--version'] });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('runProcess shell prohibition enforcement', () => {
    it('throws SpawnValidationError for a shell executable (before spawning)', async () => {
      await expect(
        runProcess({ executable: 'bash', args: ['-c', 'echo hi'] }),
      ).rejects.toThrow(SpawnValidationError);
    });

    it('throws SpawnValidationError for shell operators in args', async () => {
      await expect(
        runProcess({ executable: 'node', args: ['-e', 'x', '|', 'grep'] }),
      ).rejects.toThrow(SpawnValidationError);
    });
  });

  // ── runProcess basics ──────────────────────────────────────────────────────

  describe('runProcess basics', () => {
    it('returns stdout and exit code 0 for a normal exit', async () => {
      const result = await runNode(['-e', 'console.log("ok")']);
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toContain('ok');
      expect(result.stderr).toBe('');
      expect(result.timedOut).toBe(false);
      expect(result.canceled).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns the non-zero exit code', async () => {
      const result = await runNode(['-e', 'process.exit(3)']);
      expect(result.exitCode).toBe(3);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
    });

    it('captures stderr separately', async () => {
      const result = await runNode(['-e', 'console.error("boom")']);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('boom');
    });

    it('resolves with exitCode null and the error message in stderr on ENOENT', async () => {
      const result = await runProcess({
        executable: 'nonexistent-cmd-xyz-123',
        args: [],
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain('ENOENT');
      expect(result.timedOut).toBe(false);
      expect(result.canceled).toBe(false);
    });
  });

  // ── runProcess timeout & kill escalation ───────────────────────────────────

  describe('runProcess timeout', () => {
    it('marks timedOut and SIGTERMs a long-running child (SIGTERM path)', async () => {
      const started = Date.now();
      const result = await runNode(['-e', LONG_RUNNING], { timeoutMs: 300 });
      expect(result.timedOut).toBe(true);
      expect(result.canceled).toBe(false);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe('SIGTERM');
      expect(result.durationMs).toBeGreaterThanOrEqual(250);
      expect(Date.now() - started).toBeLessThan(5000);
    }, 10000);

    it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
      // Child installs a SIGTERM no-op handler → only SIGKILL can end it.
      const result = await runNode(
        // No `;` / `>` — both are shell operator characters that
        // validateSpawnOptions rightly rejects; newline separates statements.
        ['-e', 'process.on("SIGTERM", function () {})\nsetInterval(function () {}, 1000)'],
        { timeoutMs: 300, graceMs: 200 },
      );
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe('SIGKILL');
    }, 10000);
  });

  // ── runProcess output truncation ───────────────────────────────────────────

  describe('runProcess output bounds', () => {
    it('truncates stdout at 1 MiB', async () => {
      const result = await runNode(['-e', `process.stdout.write("x".repeat(${MAX_STDOUT_BYTES * 2}))`]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(MAX_STDOUT_BYTES);
      expect(result.stdout).toBe('x'.repeat(MAX_STDOUT_BYTES));
    }, 15000);

    it('truncates stderr at 512 KiB', async () => {
      const result = await runNode(['-e', `process.stderr.write("y".repeat(${MAX_STDERR_BYTES * 2}))`]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.length).toBe(MAX_STDERR_BYTES);
      expect(result.stderr).toBe('y'.repeat(MAX_STDERR_BYTES));
    }, 15000);
  });

  // ── runProcess AbortSignal cancellation (new-runtime enhancement) ─────────

  describe('runProcess AbortSignal cancellation', () => {
    it('terminates a running child when the signal aborts mid-run (canceled)', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const runPromise = runNode(['-e', LONG_RUNNING], {
        cancellationSignal: controller.signal,
      });
      setTimeout(() => controller.abort(), 150);
      const result = await runPromise;
      expect(result.canceled).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe('SIGTERM');
      expect(Date.now() - started).toBeLessThan(5000);
    }, 10000);

    it('terminates immediately when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await runNode(['-e', LONG_RUNNING], {
        cancellationSignal: controller.signal,
      });
      expect(result.canceled).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBeNull();
    }, 10000);
  });

  // ── spawnService & registry ────────────────────────────────────────────────

  describe('spawnService & registry', () => {
    it('spawns immediately, accumulates stdout, and round-trips the registry', async () => {
      const handle = await spawnService({
        executable: 'node',
        args: ['-e', 'process.stdout.write("hello-service"); setInterval(function () {}, 60000)'],
      });
      expect(handle.pid).toBeGreaterThan(0);

      registerService('roundtrip', handle);
      expect(getRegisteredService('roundtrip')).toBeDefined();
      expect(getRegisteredService('roundtrip')!.pid).toBe(handle.pid);

      await sleep(300);
      expect(handle.getStdout()).toContain('hello-service');

      const stopped = await stopRegisteredService('roundtrip');
      expect(stopped).toBe(true);
      expect(getRegisteredService('roundtrip')).toBeUndefined();
      expect(isProcessAlive(handle.pid)).toBe(false);
    }, 15000);

    it('throws when the executable does not exist (no PID assigned)', async () => {
      await expect(
        spawnService({ executable: 'nonexistent-cmd-xyz-123', args: [] }),
      ).rejects.toThrow('no PID assigned');
    }, 10000);

    it('stopService accepts a live handle reference (unregistered)', async () => {
      const handle = await spawnService({
        executable: 'node',
        args: ['-e', LONG_RUNNING],
      });
      const stopped = await stopService(handle);
      expect(stopped).toBe(true);
      expect(isProcessAlive(handle.pid)).toBe(false);
    }, 15000);

    it('stopService by handle removes a registered entry', async () => {
      const handle = await spawnService({
        executable: 'node',
        args: ['-e', LONG_RUNNING],
      });
      registerService('by-handle', handle);
      const stopped = await stopService(handle);
      expect(stopped).toBe(true);
      expect(getRegisteredService('by-handle')).toBeUndefined();
    }, 15000);

    it('stopService returns false for an unknown name', async () => {
      const stopped = await stopService('never-registered');
      expect(stopped).toBe(false);
    });

    it('stopRegisteredService returns false for an unknown name', async () => {
      const stopped = await stopRegisteredService('never-registered');
      expect(stopped).toBe(false);
    });

    it('throws when the process remains alive after SIGTERM + SIGKILL (DI seam)', async () => {
      const fakeHandle: ServiceHandle = {
        pid: 99999,
        process: {} as ChildProcess,
        getStdout: () => '',
        getStderr: () => '',
      };
      await expect(
        stopService(fakeHandle, 300, {
          killProcessTree: () => {},
          isProcessAlive: () => true,
        }),
      ).rejects.toThrow('remained alive after SIGTERM + SIGKILL');
    }, 10000);
  });

  // ── cleanupServices ────────────────────────────────────────────────────────

  describe('cleanupServices', () => {
    it('stops all registered services and clears the registry', async () => {
      const handleA = await spawnService({ executable: 'node', args: ['-e', LONG_RUNNING] });
      const handleB = await spawnService({ executable: 'node', args: ['-e', LONG_RUNNING] });
      registerService('svc-a', handleA);
      registerService('svc-b', handleB);

      const result = await cleanupServices();
      expect(result.cleaned).toEqual(expect.arrayContaining(['svc-a', 'svc-b']));
      expect(result.failed).toHaveLength(0);
      expect(result.remainingPids).toHaveLength(0);
      expect(getRegisteredService('svc-a')).toBeUndefined();
      expect(getRegisteredService('svc-b')).toBeUndefined();
      expect(isProcessAlive(handleA.pid)).toBe(false);
      expect(isProcessAlive(handleB.pid)).toBe(false);
    }, 15000);

    it('handles already-stopped services gracefully', async () => {
      const handle = await spawnService({ executable: 'node', args: ['-e', LONG_RUNNING] });
      registerService('already-stopped', handle);
      expect(await stopRegisteredService('already-stopped')).toBe(true);

      const result = await cleanupServices();
      expect(result.cleaned).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    }, 15000);
  });

  // ── waitForReadiness ───────────────────────────────────────────────────────

  describe('waitForReadiness', () => {
    it('reports ready when the signal appears in accumulated output', async () => {
      const handle = await spawnService({
        executable: 'node',
        args: ['-e', 'setTimeout(function () { process.stdout.write("READY\\n"); }, 200); setInterval(function () {}, 60000)'],
      });
      // Register so afterEach cleanupServices() terminates the service — a
      // spawned-but-unregistered service would leak (detached child).
      registerService('readiness-success', handle);
      const readiness: ReadinessResult = await waitForReadiness(handle, 'READY', 5000);
      expect(readiness.ready).toBe(true);
      expect(readiness.exited).toBe(false);
      expect(readiness.exitCode).toBeNull();
    }, 15000);

    it('fast-fails with exited=true when the process exits before the signal', async () => {
      const handle = await spawnService({
        executable: 'node',
        args: ['-e', 'process.exit(0)'],
      });
      registerService('readiness-exited', handle);
      await sleep(400); // let the process exit
      const readiness: ReadinessResult = await waitForReadiness(handle, 'MUST_NOT_APPEAR', 2000);
      expect(readiness.ready).toBe(false);
      expect(readiness.exited).toBe(true);
      expect(readiness.exitCode).toBe(0);
    }, 10000);

    it('times out with ready=false for a silent service', async () => {
      const handle = await spawnService({
        executable: 'node',
        args: ['-e', LONG_RUNNING],
      });
      registerService('readiness-silent', handle);
      const readiness: ReadinessResult = await waitForReadiness(handle, 'NEVER', 300);
      expect(readiness.ready).toBe(false);
      expect(readiness.exited).toBe(false);
      expect(readiness.exitCode).toBeNull();
    }, 10000);
  });

  // ── Platform adapter ───────────────────────────────────────────────────────

  describe('platform adapter', () => {
    it('normalizePath converts backslashes', () => {
      expect(normalizePath('a\\b\\c')).toBe('a/b/c');
      expect(normalizePath('a/b/c')).toBe('a/b/c');
    });

    it('resolvePath joins segments with forward slashes', () => {
      expect(resolvePath('a', 'b')).toBe('a/b');
      expect(resolvePath('/a', '/b')).toBe('/a/b');
      expect(resolvePath('a/')).toBe('a/');
      expect(resolvePath()).toBe('');
    });

    it('isShellExecutable recognises shells, extension-agnostic', () => {
      for (const shell of ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'pwsh.exe']) {
        expect(isShellExecutable(shell)).toBe(true);
      }
      expect(isShellExecutable('node')).toBe(false);
      expect(isShellExecutable('npm')).toBe(false);
    });

    it('containsShellOperator detects pipe/redirect/chain/substitution operators', () => {
      for (const op of ['|', '>', '<', '&', ';', '`', '$']) {
        expect(containsShellOperator(op)).toBe(true);
      }
      expect(containsShellOperator('plain-arg')).toBe(false);
    });

    it('isPortInUse detects a real LISTEN socket and a free port', async () => {
      const { server, port } = await listenOnFreePort();
      try {
        expect(isPortInUse(port, '127.0.0.1')).toBe(true);
      } finally {
        await closeServer(server);
      }
      // After close the port is free again.
      expect(isPortInUse(port, '127.0.0.1')).toBe(false);
    }, 10000);

    it('waitForPortFree returns true for a free port', async () => {
      const { server, port } = await listenOnFreePort();
      await closeServer(server);
      expect(waitForPortFree(port, '127.0.0.1', 3000)).toBe(true);
    }, 10000);

    it('cleanupProcesses reports dead PIDs as cleaned', async () => {
      const result = await cleanupProcesses([999999999]);
      expect(result.cleaned).toBe(1);
      expect(result.failed).toHaveLength(0);
      expect(result.remainingPids).toHaveLength(0);
    });

    it('checkPortsFree returns an empty list for free ports', async () => {
      const { server, port } = await listenOnFreePort();
      await closeServer(server);
      const inUse = await checkPortsFree([port], '127.0.0.1');
      expect(inUse).toHaveLength(0);
    }, 10000);
  });
});
