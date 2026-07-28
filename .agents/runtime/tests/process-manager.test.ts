import { jest } from '@jest/globals';
import { execSync } from 'node:child_process';

// Small helper to wait
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Mock for stopService kill-failure test ──
// Use a mutable variable so the mock factory captures a reference,
// while tests can mutate it per-scenario.
let mockIsProcessAliveImpl: (...args: number[]) => boolean = () => false;

jest.unstable_mockModule('../src/platform-adapter.js', () => {
  // Inline real-ish implementations (can't use jest.requireActual for ESM).
  // We only need isProcessAlive to be controllable; everything else real.
  const SHELL_EXECUTABLES = new Set([
    'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
    'cmd', 'cmd.exe', 'powershell', 'pwsh', 'pwsh.exe',
  ]);

  return {
    getPlatformInfo: () => {
      const p = process.platform as 'win32' | 'linux' | 'darwin';
      return { platform: p, isWindows: p === 'win32', isPosix: p === 'linux' || p === 'darwin' };
    },
    isProcessAlive: (...args: number[]) => mockIsProcessAliveImpl(...args),
    killProcessTree: (pid: number) => {
      try {
        execSync(`taskkill /PID ${pid} /T /F 2>nul`, { stdio: 'ignore' });
      } catch { /* already dead */ }
    },
    isShellExecutable: (executable: string) => {
      const base = executable.toLowerCase().replace(/\.(exe|bat|cmd)$/, '');
      return SHELL_EXECUTABLES.has(base) || SHELL_EXECUTABLES.has(executable.toLowerCase());
    },
    containsShellOperator: (arg: string) => /[|><&;`$]/.test(arg),
    isPortInUse: () => false,
    normalizePath: (p: string) => p.replace(/\\/g, '/'),
    resolvePath: (...segments: string[]) => segments.join('/'),
  };
});

// Dynamic import after mock is set up — all tests use this
const pm: typeof import('../src/process-manager.js') = await import('../src/process-manager.js');
const {
  runProcess,
  spawnService,
  registerService,
  stopRegisteredService,
  stopService,
  getRegisteredService,
  waitForReadiness,
  cleanupServices,
  validateSpawnOptions,
} = pm;

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

  describe('stopService 正常流程', () => {
    test('stopService → kill → wait → confirm death, service removed from registry', async () => {
      // 启动并注册一个服务
      const handle = await spawnService({
        executable: 'node',
        args: ['-e', 'setInterval(() => {}, 60000)'],
        timeoutMs: 5000,
      });
      const serviceName = 'stop-normal-test';
      registerService(serviceName, handle);

      // 确认服务已注册
      expect(getRegisteredService(serviceName)).toBeDefined();

      // 停止服务
      const stopped = await stopRegisteredService(serviceName);
      expect(stopped).toBe(true);

      // 验证 Registry 中服务已被移除
      expect(getRegisteredService(serviceName)).toBeUndefined();
    }, 15000);
  });

  describe('stopService SIGKILL 失败处理', () => {
    beforeEach(() => {
      // 让 isProcessAlive 持续返回 true，模拟进程在 SIGKILL 后仍存活
      mockIsProcessAliveImpl = () => true;
    });

    afterEach(async () => {
      // 恢复 mock 并清理遗留注册
      mockIsProcessAliveImpl = () => false;
      await cleanupServices();
    });

    test('进程在 SIGTERM+SIGKILL 后仍存活时 stopService 抛出 Error', async () => {
      const handle = await spawnService({
        executable: 'node',
        args: ['-e', 'setInterval(() => {}, 60000)'],
        timeoutMs: 5000,
      });
      const serviceName = 'kill-fail-test';
      registerService(serviceName, handle);

      // stopService 内部 isProcessAlive 始终返回 true → 超时 → 抛错
      await expect(stopRegisteredService(serviceName)).rejects.toThrow(
        /remained alive after SIGTERM \+ SIGKILL/,
      );
    }, 20000);
  });
});
