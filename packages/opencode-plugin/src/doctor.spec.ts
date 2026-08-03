/**
 * @proofloop/opencode-plugin — doctor checks engine spec (AWI-005).
 *
 * PO: PO-S01-C-01, PO-S01-C-03
 *
 * S01-C-T03 locks the six canonical doctor checks (tech-spec/
 * contract-state-matrix.md §1.5):
 *   1. versions       — lock runtime_version / plugin_package+plugin_version
 *                       vs actual package versions (S01-B metadata seam)
 *   2. git            — branch/HEAD/dirty via structured git read-only commands
 *                       through the runtime runProcess seam
 *   3. commands       — structured CommandSpec probes (e.g. node --version)
 *                       through runProcess
 *   4. artifacts      — .proofloop existence and permissions under the
 *                       canonical projectRoot
 *   5. receipt-schema — kernel Receipt schema version (version=1 baseline)
 *   6. host-api       — OC-0 host capability matrix (host-compatibility.md)
 *
 * Every check yields { checkId, name, status, detail, finding? }; the overall
 * ToolResult (T01 shape) is ok:false whenever any check reports a Finding, and
 * every Finding is verified against the REAL kernel `validateFinding` oracle —
 * never against the implementation's own expected-code list. Failures never
 * produce empty findings, never swallow errors, and never fake a PASS.
 *
 * S1-F-001 (OUT-S1-04 doctor_lock_failure_not_propagated): the doctor carries
 * the S01-B detection/lock fail-closed decision. An INCOMPATIBLE lock
 * (host_adapter / domain_schema_version / version mismatch) fails the versions
 * check with the seam's canonical Finding and drives ok:false even when every
 * other check is healthy — never a fake all-pass. A NON-ProofLoop project (no
 * lock) is the opposite: an expected diagnostic, ok:true but annotated
 * (projectDetected=false + "not a ProofLoop project" details).
 */

import { describe, expect, it } from 'vitest';
import { validateFinding } from '@proofloop/runtime';
import type { ProcessResult, SpawnOptions } from '@proofloop/runtime';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDoctor } from './doctor.js';
import type { DoctorCheck, DoctorDeps, HostFacts } from './doctor.js';
import { createLoggerAdapter } from './adapters/logger.js';
import type { HostLogBody } from './adapters/logger.js';
import type { RuntimeLockMetadata } from './runtime-lock.js';

const okResult: ProcessResult = {
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  canceled: false,
  durationMs: 1,
};

type RunHandler = (opts: SpawnOptions) => ProcessResult;

function runStub(handlers: Record<string, RunHandler> = {}): DoctorDeps['runProcess'] {
  return async (opts) => {
    const key = `${opts.executable} ${opts.args.join(' ')}`;
    const handler = handlers[key];
    return handler ? handler(opts) : okResult;
  };
}

const matchingExpectations: RuntimeLockMetadata = {
  pluginPackage: '@proofloop/opencode-plugin',
  pluginVersion: { ok: true, version: '0.1.0' },
  runtimeVersion: { ok: true, version: '0.1.0' },
  schemaVersion: 1,
  hostAdapter: 'opencode',
};

const allHostFacts: HostFacts = {
  toolRegistration: true,
  agentIdentity: true,
  cancellation: true,
  logging: true,
  worktreeDirectory: true,
};

const validLock = {
  runtime_version: '0.1.0',
  domain_schema_version: 1,
  risk_policy_version: 1,
  capability_policy_version: 1,
  host_adapter: 'opencode',
  plugin_package: '@proofloop/opencode-plugin',
  plugin_version: '0.1.0',
};

/** Create a temp project fixture; `lock` null means no .proofloop at all. */
function makeProject(lock: Record<string, unknown> | null): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 's01c-t03-'));
  if (lock !== null) {
    mkdirSync(path.join(root, '.proofloop'), { recursive: true });
    writeFileSync(path.join(root, '.proofloop', 'runtime.lock'), JSON.stringify(lock));
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

function spyLogger() {
  const bodies: HostLogBody[] = [];
  const logger = createLoggerAdapter((options) => {
    bodies.push(options.body);
    return undefined;
  }, 'test-service');
  return { logger, bodies };
}

function baseDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    projectRoot: '/tmp/nonexistent-doctor-fixture',
    runProcess: runStub(),
    expectations: matchingExpectations,
    hostFacts: allHostFacts,
    logger: createLoggerAdapter(() => undefined, 'test-service'),
    ...overrides,
  };
}

const successRunHandlers: Record<string, RunHandler> = {
  'git rev-parse --abbrev-ref HEAD': () => ({ ...okResult, stdout: 'main\n' }),
  'git rev-parse HEAD': () => ({ ...okResult, stdout: 'a1b2c3d4e5f67890abcdef1234567890\n' }),
  'git status --porcelain --untracked-files=no': () => ({ ...okResult, stdout: '' }),
  'node --version': () => ({ ...okResult, stdout: 'v25.9.0\n' }),
};

describe('doctor success fixture (PO-S01-C-01)', () => {
  it('reports all six canonical checks PASS with ok:true and no findings', async () => {
    const project = makeProject(validLock);
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
      });

      const { checks, result } = await runDoctor(deps);

      expect(result.ok).toBe(true);
      expect(result.findings).toHaveLength(0);
      expect(checks).toHaveLength(6);
      for (const check of checks) {
        expect(check.status).toBe('pass');
        expect(check.finding).toBeUndefined();
        expect(check.detail.length).toBeGreaterThan(0);
      }
      expect(checks.map((c) => c.checkId)).toEqual([
        'versions',
        'git',
        'commands',
        'artifacts',
        'receipt-schema',
        'host-api',
      ]);
    } finally {
      project.cleanup();
    }
  });

  it('exposes the six checks inside the ToolResult data', async () => {
    const project = makeProject(validLock);
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
      });

      const { result } = await runDoctor(deps);
      const dataChecks = result.data?.checks as DoctorCheck[] | undefined;

      expect(Array.isArray(dataChecks)).toBe(true);
      expect(dataChecks).toHaveLength(6);
      expect(dataChecks?.every((c) => c.status === 'pass')).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it('fills the runtime metadata projection from the version expectations', async () => {
    const project = makeProject(validLock);
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
      });

      const { result } = await runDoctor(deps);

      expect(result.runtime).toEqual({
        runtimeVersion: '0.1.0',
        pluginVersion: '0.1.0',
        schemaVersion: 1,
      });
    } finally {
      project.cleanup();
    }
  });
});

describe('doctor failure fixtures (PO-S01-C-03)', () => {
  it('version mismatch → ok:false + canonical RUNTIME.VERSION_MISMATCH Finding', async () => {
    const project = makeProject({ ...validLock, runtime_version: '9.9.9' });
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
      });

      const { result, checks } = await runDoctor(deps);
      const versions = checks.find((c) => c.checkId === 'versions');

      expect(result.ok).toBe(false);
      expect(result.findings.length).toBeGreaterThan(0);
      const finding = result.findings.find((f) => f.code === 'RUNTIME.VERSION_MISMATCH');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.message.length).toBeGreaterThan(0);
      expect(() => validateFinding(finding)).not.toThrow();
      expect(versions?.status).toBe('fail');
      expect(versions?.ref?.length).toBeGreaterThan(0);
    } finally {
      project.cleanup();
    }
  });

  it('broken command probe → ok:false + canonical Finding', async () => {
    const project = makeProject(validLock);
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub({
          ...successRunHandlers,
          'node --version': () => ({
            ...okResult,
            exitCode: null,
            stderr: 'node: command not found',
          }),
        }),
      });

      const { result, checks } = await runDoctor(deps);
      const commands = checks.find((c) => c.checkId === 'commands');

      expect(result.ok).toBe(false);
      const finding = result.findings.find((f) => f.message.includes('node'));
      expect(finding).toBeDefined();
      expect(finding?.message.length).toBeGreaterThan(0);
      expect(() => validateFinding(finding)).not.toThrow();
      expect(commands?.status).toBe('fail');
      expect(commands?.ref).toBe('node --version');
    } finally {
      project.cleanup();
    }
  });

  it('non-git project → ok:false + RUNTIME.SCHEMA_MISMATCH Finding', async () => {
    const project = makeProject(validLock);
    try {
      const gitFailure = (): ProcessResult => ({
        ...okResult,
        exitCode: 128,
        stderr: 'fatal: not a git repository',
      });
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub({
          'git rev-parse --abbrev-ref HEAD': gitFailure,
          'git rev-parse HEAD': gitFailure,
          'git status --porcelain --untracked-files=no': gitFailure,
        }),
      });

      const { result, checks } = await runDoctor(deps);
      const git = checks.find((c) => c.checkId === 'git');

      expect(result.ok).toBe(false);
      const finding = result.findings.find((f) => f.message.includes('git'));
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(() => validateFinding(finding)).not.toThrow();
      expect(git?.status).toBe('fail');
      expect(git?.ref?.length).toBeGreaterThan(0);
    } finally {
      project.cleanup();
    }
  });

  it('dirty git worktree → ok:false with a warn canonical Finding', async () => {
    const project = makeProject(validLock);
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub({
          ...successRunHandlers,
          'git status --porcelain --untracked-files=no': () => ({ ...okResult, stdout: ' M uncommitted.txt\n' }),
        }),
      });

      const { result, checks } = await runDoctor(deps);
      const git = checks.find((c) => c.checkId === 'git');

      expect(result.ok).toBe(false);
      const finding = result.findings.find((f) => f.message.includes('dirty'));
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warn');
      expect(() => validateFinding(finding)).not.toThrow();
      expect(git?.status).toBe('fail');
    } finally {
      project.cleanup();
    }
  });

  it('non-ProofLoop project (no .proofloop) → usable: ok:true, annotated, no fail-closed Finding (S1-F-001)', async () => {
    const project = makeProject(null); // no .proofloop at all
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
      });

      const { result, checks } = await runDoctor(deps);
      const artifacts = checks.find((c) => c.checkId === 'artifacts');
      const versions = checks.find((c) => c.checkId === 'versions');

      // S1-F-001: a non-ProofLoop project (no lock) is an EXPECTED diagnostic,
      // not a fail-closed failure — the doctor stays usable (ok:true) but the
      // result is annotated (projectDetected=false; checks note the absence).
      expect(result.ok).toBe(true);
      expect(result.findings).toHaveLength(0);
      expect(result.data?.projectDetected).toBe(false);
      expect(versions?.status).toBe('pass');
      expect(versions?.detail).toContain('not a ProofLoop project');
      expect(artifacts?.status).toBe('pass');
      expect(artifacts?.detail).toContain('not a ProofLoop project');
    } finally {
      project.cleanup();
    }
  });

  it('lock host_adapter=pi-extension → ok:false + HOST.PROJECT_NOT_TRUSTED (S1-F-001)', async () => {
    const project = makeProject({ ...validLock, host_adapter: 'pi-extension' });
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
      });

      const { result, checks } = await runDoctor(deps);
      const versions = checks.find((c) => c.checkId === 'versions');

      // The detection/lock fail-closed decision is propagated into the doctor:
      // an unsupported host adapter fails the versions check with the seam's
      // canonical HOST.PROJECT_NOT_TRUSTED Finding.
      expect(result.ok).toBe(false);
      const finding = result.findings.find(
        (f) => f.code === 'HOST.PROJECT_NOT_TRUSTED',
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.message).toContain('pi-extension');
      expect(() => validateFinding(finding)).not.toThrow();
      expect(versions?.status).toBe('fail');
      expect(versions?.ref).toContain('runtime.lock');
    } finally {
      project.cleanup();
    }
  });

  it('lock domain_schema_version=2 → ok:false + RUNTIME.SCHEMA_MISMATCH (S1-F-001)', async () => {
    const project = makeProject({ ...validLock, domain_schema_version: 2 });
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
      });

      const { result, checks } = await runDoctor(deps);
      const versions = checks.find((c) => c.checkId === 'versions');

      expect(result.ok).toBe(false);
      const finding = result.findings.find(
        (f) => f.code === 'RUNTIME.SCHEMA_MISMATCH',
      );
      expect(finding).toBeDefined();
      expect(finding?.message).toContain('domain_schema_version');
      expect(() => validateFinding(finding)).not.toThrow();
      expect(versions?.status).toBe('fail');
    } finally {
      project.cleanup();
    }
  });

  it('incompatible lock is NOT hidden by other healthy checks (no fake all-pass, S1-F-001)', async () => {
    const project = makeProject({ ...validLock, host_adapter: 'pi-extension' });
    try {
      // Every OTHER check is healthy (git/commands/artifacts/receipt-schema/
      // host-api all pass); only the versions check fails. The lock decision
      // must still drive ok:false — a fail-closed lock is never swallowed by
      // otherwise-healthy checks.
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
      });

      const { result, checks } = await runDoctor(deps);
      const healthyOthers = checks.filter((c) => c.checkId !== 'versions');
      expect(healthyOthers).toHaveLength(5);
      expect(healthyOthers.every((c) => c.status === 'pass')).toBe(true);
      expect(checks.find((c) => c.checkId === 'versions')?.status).toBe('fail');
      expect(result.ok).toBe(false);
      expect(
        result.findings.some((f) => f.code === 'HOST.PROJECT_NOT_TRUSTED'),
      ).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it('receipt schema mismatch → ok:false + RUNTIME.SCHEMA_MISMATCH Finding', async () => {
    const project = makeProject(validLock);
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
        observedSchemaVersion: 2,
      });

      const { result, checks } = await runDoctor(deps);
      const schema = checks.find((c) => c.checkId === 'receipt-schema');

      expect(result.ok).toBe(false);
      const finding = result.findings.find((f) => f.message.includes('schema'));
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(() => validateFinding(finding)).not.toThrow();
      expect(schema?.status).toBe('fail');
    } finally {
      project.cleanup();
    }
  });

  it('host API incompatibility → ok:false + RUNTIME.SCHEMA_MISMATCH Finding', async () => {
    const project = makeProject(validLock);
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
        hostFacts: { ...allHostFacts, cancellation: false },
      });

      const { result, checks } = await runDoctor(deps);
      const hostApi = checks.find((c) => c.checkId === 'host-api');

      expect(result.ok).toBe(false);
      const finding = result.findings.find((f) => f.message.includes('cancellation'));
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(() => validateFinding(finding)).not.toThrow();
      expect(hostApi?.status).toBe('fail');
      expect(hostApi?.ref).toContain('cancellation');
    } finally {
      project.cleanup();
    }
  });
});

describe('doctor oracle & structure (PO-S01-C-03)', () => {
  it('every finding passes the REAL kernel validateFinding oracle', async () => {
    const project = makeProject({ ...validLock, runtime_version: '9.9.9' });
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
        hostFacts: { ...allHostFacts, logging: false },
        observedSchemaVersion: 2,
      });

      const { result } = await runDoctor(deps);

      expect(result.findings.length).toBeGreaterThan(0);
      for (const finding of result.findings) {
        // Kernel validator is the oracle: a Finding that fails it is not canonical.
        expect(() => validateFinding(finding)).not.toThrow();
        expect(finding.message.length).toBeGreaterThan(0);
      }
    } finally {
      project.cleanup();
    }
  });

  it('failure fixtures never produce empty findings (no catch-and-drop)', async () => {
    const fixtures: Array<Partial<DoctorDeps>> = [
      { observedSchemaVersion: 2 },
      { hostFacts: { ...allHostFacts, toolRegistration: false } },
      { expectations: { ...matchingExpectations, runtimeVersion: { ok: false, reason: 'read failed' } } },
    ];
    const project = makeProject(validLock);
    try {
      for (const fixture of fixtures) {
        const deps = baseDeps({ projectRoot: project.root, runProcess: runStub(successRunHandlers), ...fixture });
        const { result } = await runDoctor(deps);
        expect(result.ok).toBe(false);
        expect(result.findings.length).toBeGreaterThan(0);
      }
    } finally {
      project.cleanup();
    }
  });

  it('emits full diagnostics to the logger', async () => {
    const project = makeProject({ ...validLock, runtime_version: '9.9.9' });
    const { logger, bodies } = spyLogger();
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
        logger,
      });

      await runDoctor(deps);

      const logCall = bodies.find((b) => b.message.includes('doctor'));
      expect(logCall).toBeDefined();
      expect(logCall?.extra?.projectRoot).toBe(project.root);
    } finally {
      project.cleanup();
    }
  });

  it('contains a single check throw inside that check (six records stay complete, status honest)', async () => {
    const project = makeProject(validLock);
    try {
      // The git check's process seam THROWS (e.g. SpawnValidationError-like):
      // this must NOT blank the whole check list or fake "all 0 checks passed".
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub({
          'git rev-parse --abbrev-ref HEAD': () => {
            throw new Error('SpawnValidationError: shell operator rejected');
          },
        }),
      });

      const { result, checks } = await runDoctor(deps);

      // The six-check record stays complete.
      expect(checks).toHaveLength(6);
      const git = checks.find((c) => c.checkId === 'git');
      expect(git?.status).toBe('fail');
      expect(git?.finding).toBeDefined();
      expect(git?.finding?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(() => validateFinding(git?.finding)).not.toThrow();
      expect((git?.ref ?? '').length).toBeGreaterThan(0);

      // Status is honest: the failing check is counted, never 0/6 all-pass.
      const failCount = checks.filter((c) => c.status === 'fail').length;
      expect(failCount).toBeGreaterThan(0);
      expect(result.ok).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it('carries the caller role into the result context and diagnostics', async () => {
    const project = makeProject(validLock);
    const { logger, bodies } = spyLogger();
    try {
      const deps = baseDeps({
        projectRoot: project.root,
        runProcess: runStub(successRunHandlers),
        logger,
        callerRole: 'executor',
      });

      const { result } = await runDoctor(deps);

      expect(result.data?.callerRole).toBe('executor');
      const logCall = bodies.find((b) => b.message.includes('doctor'));
      expect(logCall?.extra?.callerRole).toBe('executor');
    } finally {
      project.cleanup();
    }
  });
});
