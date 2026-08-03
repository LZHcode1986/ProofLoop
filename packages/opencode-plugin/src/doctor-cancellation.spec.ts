/**
 * @proofloop/opencode-plugin — doctor cancellation & logging separation
 * (PO-S01-C-05).
 *
 * AWI-005 / host-compatibility.md #Cancellation / #Logging: `ToolContext.abort`
 * must be cooperatively observed and propagated through the doctor's runtime
 * probes, and the logger must record the full diagnostics without stuffing the
 * log body back into the compact result.
 *
 * S01-C Repair #5/#6: the engine reports canceled probes as fail-closed
 * Findings, while the TOOL propagates a caller abort as an AbortError (never
 * swallowed into a plain finding, never reported as a clean PASS). The logging
 * capability is OBSERVED from the real host sink (`logger.healthy`), so a
 * missing/throwing host logger is a structured host-api failure — never an
 * init-time throw and never a hardcoded `true`.
 *
 * S01-C Diagnose (CV_REPAIR #2 / 36349b09…): the host `client.app.log` sink is
 * ASYNC — a rejected Promise must be ABSORBED (no unhandled rejection) and must
 * mark the adapter unhealthy, so the host-api check reports a structured
 * failure instead of a false PASS. Sync throw and async rejection paths are
 * handled consistently.
 *
 * This spec uses the REAL runtime `runProcess` seam and REAL AbortSignals —
 * nothing is mocked.
 */

import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess, validateFinding } from '@proofloop/runtime';
import type { ProcessResult, SpawnOptions } from '@proofloop/runtime';
import { runDoctor } from './doctor.js';
import type { DoctorDeps } from './doctor.js';
import { RUNTIME_LOCK_EXPECTATIONS } from './runtime-lock.js';
import { createRuntimeContext } from './host-context.js';
import { createDoctorTool } from './tools/doctor.js';
import { renderCompact } from './compact.js';
import { createLoggerAdapter } from './adapters/logger.js';
import type { HostLogBody, LoggerAdapter } from './adapters/logger.js';

const ALL_TRUE_HOST_FACTS = {
  toolRegistration: true,
  agentIdentity: true,
  cancellation: true,
  logging: true,
  worktreeDirectory: true,
};

function spyLogger() {
  const bodies: HostLogBody[] = [];
  const logger = createLoggerAdapter((options) => {
    bodies.push(options.body);
    return undefined;
  }, 'test-service');
  return { logger, bodies };
}

/** Temp project root (no lock/no git keeps the run focused on cancellation). */
function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 's01c-t05-ct-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('doctor cancellation through the real runProcess seam (PO-S01-C-05)', () => {
  it('cancels a real long-running probe via AbortSignal and cleans up (runProcess.canceled)', async () => {
    const controller = new AbortController();
    const promise = runProcess({
      executable: 'node',
      args: ['-e', 'setTimeout(function(){}, 30000)'],
      cancellationSignal: controller.signal,
    });

    setTimeout(() => controller.abort(), 150);
    const result = await promise;

    expect(result.canceled).toBe(true);
    // Terminated by the abort, not a normal exit-0 completion.
    expect(result.exitCode).not.toBe(0);
    expect(result.signal).not.toBeNull();
  });

  it('propagates abort into the doctor engine as a fail-closed Finding (never PASS, no AbortError leak)', async () => {
    const controller = new AbortController();
    const { logger, bodies } = spyLogger();
    const fixture = makeRoot();
    try {
      const deps: DoctorDeps = {
        projectRoot: fixture.root,
        runProcess,
        expectations: RUNTIME_LOCK_EXPECTATIONS,
        hostFacts: ALL_TRUE_HOST_FACTS,
        logger,
        cancellationSignal: controller.signal,
        commandProbes: [
          {
            id: 'slow',
            name: 'slow probe',
            executable: 'node',
            args: ['-e', 'setTimeout(function(){}, 30000)'],
          },
        ],
      };

      const run = runDoctor(deps);
      setTimeout(() => controller.abort(), 150);
      // runDoctor must resolve with a structured result — the AbortSignal is
      // never swallowed and never leaks as a thrown AbortError.
      const { result, checks } = await run;

      const commands = checks.find((c) => c.checkId === 'commands');
      expect(result.ok).toBe(false);
      expect(commands?.status).toBe('fail');

      // Target the commands check's own finding (the probe that was canceled).
      const canceledFinding = commands?.finding;
      expect(canceledFinding).toBeDefined();
      expect(() => validateFinding(canceledFinding)).not.toThrow();
      expect(canceledFinding?.message).toMatch(/AbortSignal/i);

      // Host logger received the full structured diagnostics.
      expect(bodies.some((b) => b.message.includes('doctor'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('propagates ToolContext.abort as AbortError through the registered tool (never swallowed)', async () => {
    const fixture = makeRoot();
    const { bodies } = spyLogger();
    try {
      mkdirSync(path.join(fixture.root, '.proofloop'), { recursive: true });
      writeFileSync(
        path.join(fixture.root, '.proofloop', 'runtime.lock'),
        JSON.stringify({
          runtime_version: '0.1.0',
          domain_schema_version: 1,
          risk_policy_version: 1,
          capability_policy_version: 1,
          host_adapter: 'opencode',
          plugin_package: '@proofloop/opencode-plugin',
          plugin_version: '0.1.0',
        }),
      );

      const context = createRuntimeContext({
        client: { app: { log: (o: { body: HostLogBody }) => bodies.push(o.body) } },
        project: {},
        directory: fixture.root,
        worktree: fixture.root,
        experimental_workspace: { register: () => undefined },
        serverUrl: new URL('http://127.0.0.1:5178'),
        $: {},
      } as never);

      const tool = createDoctorTool(context);

      const controller = new AbortController();
      controller.abort(); // already aborted before execution

      // The tool must PROPAGATE the cancellation as an AbortError — it must not
      // swallow it into a plain finding or return a clean result.
      await expect(
        tool.execute(
          {},
          {
            sessionID: 'test-session',
            messageID: 'test-message',
            agent: 'executor',
            directory: fixture.root,
            worktree: fixture.root,
            abort: controller.signal,
            metadata: () => undefined,
            ask: async () => undefined,
          } as never,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });

      // The host logger still received the structured doctor diagnostics
      // (observed before the abort was propagated).
      expect(bodies.some((b) => b.message.includes('doctor'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('observes a broken host logger as a host-api failure (no init throw, no hardcoded true)', async () => {
    const fixture = makeRoot();
    try {
      mkdirSync(path.join(fixture.root, '.proofloop'), { recursive: true });
      writeFileSync(
        path.join(fixture.root, '.proofloop', 'runtime.lock'),
        JSON.stringify({
          runtime_version: '0.1.0',
          domain_schema_version: 1,
          risk_policy_version: 1,
          capability_policy_version: 1,
          host_adapter: 'opencode',
          plugin_package: '@proofloop/opencode-plugin',
          plugin_version: '0.1.0',
        }),
      );

      // Host log sink that THROWS — the doctor must not throw on init or
      // execute; the logging capability must be observed as unhealthy and
      // reported as a structured host-api check failure.
      const context = createRuntimeContext({
        client: {
          app: {
            log: () => {
              throw new Error('host log sink is down');
            },
          },
        },
        project: {},
        directory: fixture.root,
        worktree: fixture.root,
        experimental_workspace: { register: () => undefined },
        serverUrl: new URL('http://127.0.0.1:5178'),
        $: {},
      } as never);

      const tool = createDoctorTool(context);

      let envelope: unknown;
      try {
        envelope = await tool.execute(
          {},
          {
            sessionID: 'test-session',
            messageID: 'test-message',
            agent: 'executor',
            directory: fixture.root,
            worktree: fixture.root,
            abort: new AbortController().signal,
            metadata: () => undefined,
            ask: async () => undefined,
          } as never,
        );
      } catch (error) {
        throw new Error(`tool execute threw on a broken logger: ${String(error)}`);
      }

      expect(typeof envelope).toBe('object');
      const output = (envelope as { output?: string }).output;
      expect(typeof output).toBe('string');

      // The host-api check reports the broken logging capability structurally.
      const hostApiLine =
        output
          ?.split('\n')
          .find((l) => l.startsWith('- [host-api]')) ?? '';
      expect(hostApiLine).toContain(': fail');
      expect(hostApiLine).toContain('client.app.log');
    } finally {
      fixture.cleanup();
    }
  });

  it('absorbs an ASYNC logger rejection — no unhandled rejection, healthy=false (diagnose root cause)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const logger: LoggerAdapter = createLoggerAdapter(
        () => Promise.reject(new Error('host log sink rejected asynchronously')),
        'test-service',
      );

      await logger.probe();
      // Flush the microtask/macrotask queue so any escaped rejection fires.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The rejection must have been ABSORBED — no process-level unhandled
      // rejection, and the adapter must reflect the async failure.
      expect(unhandled).toEqual([]);
      expect(logger.healthy).toBe(false);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('absorbs async log() rejections too (fire-and-forget path, no unhandled rejection, healthy=false)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const logger: LoggerAdapter = createLoggerAdapter(
        () => Promise.reject(new Error('host log sink rejected asynchronously')),
        'test-service',
      );

      logger.info('fire-and-forget message');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
      expect(logger.healthy).toBe(false);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('reports an async-rejecting host logger as a host-api failure (no false PASS)', async () => {
    const fixture = makeRoot();
    try {
      mkdirSync(path.join(fixture.root, '.proofloop'), { recursive: true });
      writeFileSync(
        path.join(fixture.root, '.proofloop', 'runtime.lock'),
        JSON.stringify({
          runtime_version: '0.1.0',
          domain_schema_version: 1,
          risk_policy_version: 1,
          capability_policy_version: 1,
          host_adapter: 'opencode',
          plugin_package: '@proofloop/opencode-plugin',
          plugin_version: '0.1.0',
        }),
      );

      const context = createRuntimeContext({
        client: {
          app: {
            log: () => Promise.reject(new Error('host log sink rejected asynchronously')),
          },
        },
        project: {},
        directory: fixture.root,
        worktree: fixture.root,
        experimental_workspace: { register: () => undefined },
        serverUrl: new URL('http://127.0.0.1:5178'),
        $: {},
      } as never);

      const tool = createDoctorTool(context);

      let envelope: unknown;
      try {
        envelope = await tool.execute(
          {},
          {
            sessionID: 'test-session',
            messageID: 'test-message',
            agent: 'executor',
            directory: fixture.root,
            worktree: fixture.root,
            abort: new AbortController().signal,
            metadata: () => undefined,
            ask: async () => undefined,
          } as never,
        );
      } catch (error) {
        throw new Error(`tool execute threw on an async-rejecting logger: ${String(error)}`);
      }

      expect(typeof envelope).toBe('object');
      const output = (envelope as { output?: string }).output;
      expect(typeof output).toBe('string');

      // The host-api check must report the async logger failure structurally —
      // never a false PASS.
      const hostApiLine =
        output
          ?.split('\n')
          .find((l) => l.startsWith('- [host-api]')) ?? '';
      expect(hostApiLine).toContain(': fail');
      expect(hostApiLine).toContain('client.app.log');
    } finally {
      fixture.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// S1-F-002 — logger file persistence (OUT-S1-05 compact_log_not_persisted)
// ---------------------------------------------------------------------------

type PersistRunHandler = (opts: SpawnOptions) => ProcessResult;

const persistOkResult: ProcessResult = {
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  canceled: false,
  durationMs: 1,
};

function persistRunStub(
  handlers: Record<string, PersistRunHandler> = {},
): DoctorDeps['runProcess'] {
  return async (opts) => {
    const key = `${opts.executable} ${opts.args.join(' ')}`;
    const handler = handlers[key];
    return handler ? handler(opts) : persistOkResult;
  };
}

const persistGitHandlers: Record<string, PersistRunHandler> = {
  'git rev-parse --abbrev-ref HEAD': () => ({ ...persistOkResult, stdout: 'main\n' }),
  'git rev-parse HEAD': () => ({
    ...persistOkResult,
    stdout: 'a1b2c3d4e5f67890abcdef1234567890\n',
  }),
  'git status --porcelain --untracked-files=no': () => ({ ...persistOkResult, stdout: '' }),
};

/** Temp ProofLoop fixture with a valid lock (all other checks stay healthy). */
function persistProject(lock: Record<string, unknown> | null): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), 's01c-t05-persist-'));
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  if (lock !== null) {
    writeFileSync(
      path.join(root, '.proofloop', 'runtime.lock'),
      JSON.stringify(lock, null, 2),
    );
  }
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    },
  };
}

const persistValidLock = {
  runtime_version: '0.1.0',
  domain_schema_version: 1,
  risk_policy_version: 1,
  capability_policy_version: 1,
  host_adapter: 'opencode',
  plugin_package: '@proofloop/opencode-plugin',
  plugin_version: '0.1.0',
};

describe('logger file persistence to .proofloop/logs (S1-F-002)', () => {
  it('persists the full doctor diagnostics and exposes a traceable .proofloop/logs ref', async () => {
    const project = persistProject(persistValidLock);
    try {
      const logger = createLoggerAdapter(
        () => undefined,
        'test-service',
        {
          projectRoot: project.root,
          logsDir: path.join(project.root, '.proofloop', 'logs'),
        },
      );
      const deps: DoctorDeps = {
        projectRoot: project.root,
        runProcess: persistRunStub(persistGitHandlers),
        expectations: RUNTIME_LOCK_EXPECTATIONS,
        hostFacts: ALL_TRUE_HOST_FACTS,
        logger,
      };

      const { result } = await runDoctor(deps);

      // The persisted diagnostic file exists under `.proofloop/logs/` and
      // contains the full six-check diagnostics.
      const logsDir = path.join(project.root, '.proofloop', 'logs');
      const files = readdirSync(logsDir);
      const diagFile = files.find((f) => /^doctor-.*\.log$/.test(f));
      expect(diagFile).toBeDefined();
      const content = readFileSync(path.join(logsDir, diagFile as string), 'utf8');
      expect(content).toContain('doctor: full diagnostics');
      for (const checkId of [
        'versions',
        'git',
        'commands',
        'artifacts',
        'receipt-schema',
        'host-api',
      ]) {
        expect(content).toContain(checkId);
      }

      // Compact output carries the traceable FILE ref — not a bare host log id.
      const view = renderCompact(
        { result, status: 'status', next: 'next' },
        { logger },
      );
      expect(view.logRef).toMatch(/^\.proofloop\/logs\/doctor-.*\.log$/);
      expect(view.logRef).not.toMatch(/^log:/);
    } finally {
      project.cleanup();
    }
  });

  it('an unwritable .proofloop/logs directory fails closed with a structured Finding (no fake persisted)', async () => {
    const project = persistProject(persistValidLock);
    try {
      // Block the canonical logs path with a regular FILE so the lazy mkdir
      // fails deterministically (permission chmod is unreliable under root).
      writeFileSync(path.join(project.root, '.proofloop', 'logs'), 'blocking file\n');

      const logger = createLoggerAdapter(
        () => undefined,
        'test-service',
        {
          projectRoot: project.root,
          logsDir: path.join(project.root, '.proofloop', 'logs'),
        },
      );
      const deps: DoctorDeps = {
        projectRoot: project.root,
        runProcess: persistRunStub(persistGitHandlers),
        expectations: RUNTIME_LOCK_EXPECTATIONS,
        hostFacts: ALL_TRUE_HOST_FACTS,
        logger,
      };

      const { result } = await runDoctor(deps);

      expect(logger.persisted).toBe(true);
      expect(logger.fileHealthy).toBe(false);
      // The doctor reports the persistence failure structurally — never a
      // silent "persisted" claim and never a fake file ref.
      const finding = result.findings.find((f) =>
        f.message.includes('persistence failed'),
      );
      expect(finding).toBeDefined();
      expect(() => validateFinding(finding)).not.toThrow();
      expect(result.data?.logRef).not.toMatch(/^\.proofloop\/logs\//);
    } finally {
      project.cleanup();
    }
  });

  it('an append-stage failure (mkdir ok, append fails) clears the stale logRef (S1-F-002 CV REPAIR)', async () => {
    const project = persistProject(persistValidLock);
    try {
      // Deterministic append-stage failure: pre-create the logs directory
      // (ensureFile's lazy mkdir becomes a successful no-op) and then make it
      // read-only so appendFileSync CANNOT create the log file → EACCES.
      // This exercises the SECOND phase (append) after the FIRST phase
      // (mkdir/ensureFile) has already succeeded and exposed a logRef.
      const logsDir = path.join(project.root, '.proofloop', 'logs');
      mkdirSync(logsDir, { recursive: true });
      chmodSync(logsDir, 0o555);

      const logger = createLoggerAdapter(
        () => undefined,
        'test-service',
        { projectRoot: project.root, logsDir },
      );
      const deps: DoctorDeps = {
        projectRoot: project.root,
        runProcess: persistRunStub(persistGitHandlers),
        expectations: RUNTIME_LOCK_EXPECTATIONS,
        hostFacts: ALL_TRUE_HOST_FACTS,
        logger,
      };

      const { result } = await runDoctor(deps);

      // The append failure is fail-closed AND must NOT leave a stale
      // `.proofloop/logs/...` ref — a traceable ref to an unwritten file is a
      // FAKE ref (S01-F-002-APPEND-FAILURE-STALE-LOGREF).
      expect(logger.persisted).toBe(true);
      expect(logger.fileHealthy).toBe(false);
      expect(logger.logRef).toBeUndefined();
      const finding = result.findings.find((f) =>
        f.message.includes('persistence failed'),
      );
      expect(finding).toBeDefined();
      expect(() => validateFinding(finding)).not.toThrow();
      expect(result.data?.logRef).not.toMatch(/^\.proofloop\/logs\//);

      // Compact output must also fall back to the host log channel — never a
      // fake file ref.
      const view = renderCompact(
        { result, status: 'status', next: 'next' },
        { logger },
      );
      expect(view.logRef).not.toMatch(/^\.proofloop\/logs\//);
    } finally {
      project.cleanup();
    }
  });
});
