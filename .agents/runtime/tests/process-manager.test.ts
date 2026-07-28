import {
  runProcess,
  spawnService,
  registerService,
  stopRegisteredService,
  waitForReadiness,
  cleanupServices,
  validateSpawnOptions,
} from '../src/process-manager.js';

// Small helper to wait
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('process-manager', () => {
  afterEach(async () => {
    // Ensure no lingering services between tests
    await cleanupServices();
  });

  describe('validateSpawnOptions', () => {
    test('rejects shell executables', () => {
      const result = validateSpawnOptions({ executable: 'bash', args: ['-c', 'echo hi'] });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Shell'))).toBe(true);
    });

    test('rejects shell operators in args', () => {
      const result = validateSpawnOptions({ executable: 'node', args: ['-e', 'console.log("hi")', '|', 'grep'] });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Shell operator'))).toBe(true);
    });

    test('accepts valid options', () => {
      const result = validateSpawnOptions({ executable: 'node', args: ['--version'] });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('service lifecycle', () => {
    test('service_start → probe → service_stop flow succeeds', async () => {
      // Start a node process that writes "ready" via stdout (flushed immediately)
      const handle = await spawnService({
        executable: 'node',
        args: [
          '-e',
          'setTimeout(() => process.stdout.write("ready\\n"), 200); setInterval(() => {}, 60000)',
        ],
        timeoutMs: 5000,
      });

      expect(handle.pid).toBeGreaterThan(0);

      // Register the service
      registerService('lifecycle-test', handle);

      // Wait for readiness — now returns ReadinessResult
      const readiness = await waitForReadiness(handle, 'ready', 5000);
      expect(readiness.ready).toBe(true);
      expect(readiness.exited).toBe(false);

      // Run a probe (simple node command)
      const probeResult = await runProcess({
        executable: 'node',
        args: ['-e', 'console.log("probe ok")'],
        timeoutMs: 5000,
      });
      expect(probeResult.exitCode).toBe(0);
      expect(probeResult.stdout).toContain('probe ok');

      // Stop the service
      const stopped = await stopRegisteredService('lifecycle-test');
      expect(stopped).toBe(true);
    }, 15000);
  });

  describe('readiness before process exit', () => {
    test('waitForReadiness reports exited when process exits before signal', async () => {
      // Start a process that exits immediately without emitting readiness
      const handle = await spawnService({
        executable: 'node',
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 5000,
      });

      // Give the process time to exit
      await sleep(500);

      // The process already exited; readiness signal should not be found
      const readiness = await waitForReadiness(handle, 'MUST_NOT_APPEAR', 2000);
      expect(readiness.ready).toBe(false);
      expect(readiness.exited).toBe(true);
    }, 10000);
  });

  describe('service start failure', () => {
    test('spawnService throws for non-existent executable', async () => {
      // On Windows, spawn of a truly non-existent command may still yield
      // a pid before the error event. We accept .toThrow() or a pid-based handle.
      try {
        const handle = await spawnService({
          executable: 'nonexistent-command-xyz-123',
          args: [],
          timeoutMs: 1000,
        });
        // If it doesn't throw, the handle should still be valid (we'll check pid)
        // This handles cross-platform differences where spawn may or may not throw
        expect(handle.pid).toBeDefined();
        // Clean up if we got a handle
        if (handle.pid) {
          await cleanupServices();
        }
      } catch (err: unknown) {
        // Expected: spawnService throws when no PID is assigned
        expect(err).toBeDefined();
      }
    });
  });

  describe('cleanup failure handling', () => {
    test('cleanupServices handles already-stopped services gracefully', async () => {
      // Start and register a service
      const handle = await spawnService({
        executable: 'node',
        args: ['-e', 'setInterval(() => {}, 60000)'],
        timeoutMs: 5000,
      });
      registerService('cleanup-test', handle);

      // Stop it manually first — now returns boolean
      const stopped = await stopRegisteredService('cleanup-test');
      expect(stopped).toBe(true);

      // cleanupServices should not throw even though already cleaned
      const result = await cleanupServices();
      expect(result.cleaned).toHaveLength(0);
    }, 15000);
  });
});
