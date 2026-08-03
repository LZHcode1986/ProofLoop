/**
 * @proofloop/opencode-plugin — full-assembly integration spec (S01-B-T04)
 *
 * PO: PO-S01-B-01, PO-S01-B-02, PO-S01-B-03
 *
 * Covers the complete assembly path with REAL host-shaped fixtures:
 *
 *   PluginInput shape → createRuntimeContext → detectProject →
 *   validateRuntimeLockAt
 *
 * Every fixture is a real directory under os.tmpdir() with a real
 * `.proofloop/runtime.lock` layout; worktree, session directory and
 * process.cwd() are mutually distinct. No plugin module is mocked — the
 * fixtures exercise the true host-adapter seam:
 *   - trust-root: projectRoot is the canonical (realpath) worktree, never cwd;
 *   - context propagation: currentDirectory / callerRole / cancellationSignal /
 *     logger match the host inputs;
 *   - detection matrix: valid ProofLoop (active), non-ProofLoop, missing lock,
 *     bad lock — each with the canonical fail-closed decision;
 *   - lock matrix: checked-in lock copy (active), mutations (unknown field /
 *     version mismatch → inactive + canonical Finding);
 *   - logger/cancellation observation: one structured host log call; the
 *     cancellationSignal is the SAME AbortSignal object from the fixture.
 *
 * RED note (S01-B-T04): the assembly helper is intentionally wired with the
 * FORBIDDEN trust root (process.cwd()) in the RED revision so the spec proves
 * it detects the ADR-004 violation; the GREEN revision wires the canonical
 * `context.projectRoot`.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext, RUNTIME_CONTEXT_SERVICE } from './host-context.js';
import { detectProject } from './project-detection.js';
import { validateRuntimeLockAt } from './runtime-lock.js';
import type { HostLogBody } from './adapters/logger.js';

/** Path of the real checked-in authority lock under the workspace root. */
const CHECKED_IN_LOCK_PATH = path.join(
  process.cwd(),
  '.proofloop',
  'runtime.lock',
);

/** The checked-in lock content copied into fixtures (independent source). */
const CHECKED_IN_LOCK: string = (() => {
  if (!existsSync(CHECKED_IN_LOCK_PATH)) {
    throw new Error(`checked-in runtime.lock missing: ${CHECKED_IN_LOCK_PATH}`);
  }
  return readFileSync(CHECKED_IN_LOCK_PATH, 'utf8');
})();

type FixtureKind =
  | 'valid'
  | 'non-proofloop'
  | 'missing-lock'
  | 'bad-unknown'
  | 'bad-version';

let base: string;
let fixtureId = 0;

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 's01-b-t04-'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/**
 * Build a real worktree fixture. The `valid` kind returns a SYMLINK to the
 * real worktree so the canonicalization (realpath) of the trust root is
 * observable; the other kinds return the real directory directly.
 */
function buildWorktree(kind: FixtureKind): string {
  const realWorktree = path.join(base, `wt-${fixtureId++}`);
  mkdirSync(realWorktree, { recursive: true });

  switch (kind) {
    case 'valid':
      mkdirSync(path.join(realWorktree, '.proofloop', 'manifests'), {
        recursive: true,
      });
      mkdirSync(path.join(realWorktree, 'delivery'), { recursive: true });
      writeFileSync(
        path.join(realWorktree, '.proofloop', 'runtime.lock'),
        CHECKED_IN_LOCK,
      );
      // Host reports the worktree through a symlink; canonical root must resolve it.
      const link = path.join(base, `wt-link-${fixtureId++}`);
      symlinkSync(realWorktree, link, 'dir');
      return link;
    case 'non-proofloop':
      mkdirSync(path.join(realWorktree, 'src'), { recursive: true });
      writeFileSync(path.join(realWorktree, 'README.md'), '# ordinary\n');
      return realWorktree;
    case 'missing-lock':
      mkdirSync(path.join(realWorktree, '.proofloop'), { recursive: true });
      return realWorktree;
    case 'bad-unknown': {
      mkdirSync(path.join(realWorktree, '.proofloop'), { recursive: true });
      const lock = JSON.parse(CHECKED_IN_LOCK) as Record<string, unknown>;
      writeFileSync(
        path.join(realWorktree, '.proofloop', 'runtime.lock'),
        JSON.stringify({ ...lock, bogus_field: 1 }),
      );
      return realWorktree;
    }
    case 'bad-version': {
      mkdirSync(path.join(realWorktree, '.proofloop'), { recursive: true });
      const lock = JSON.parse(CHECKED_IN_LOCK) as Record<string, unknown>;
      writeFileSync(
        path.join(realWorktree, '.proofloop', 'runtime.lock'),
        JSON.stringify({ ...lock, plugin_version: '9.9.9' }),
      );
      return realWorktree;
    }
  }
}

/** Real session directory (always distinct from worktree and cwd). */
function buildSessionDir(): string {
  return mkdtempSync(path.join(base, 'session-'));
}

/** OC-0-shaped ToolContext fixture (real host shape). */
function makeToolContext(
  abort: AbortSignal,
  agent: string,
  directory: string,
  worktree: string,
): ToolContext {
  return {
    sessionID: 'sess-t04',
    messageID: 'msg-t04',
    agent,
    directory,
    worktree,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

/** OC-0-shaped PluginInput fixture with a real `client.app.log` spy sink. */
function makePluginInput(
  appLog: (options: { body: HostLogBody }) => unknown,
  directory: string,
  worktree: string,
): PluginInput {
  return {
    client: { app: { log: appLog } } as unknown as PluginInput['client'],
    project: { id: `proj-t04-${fixtureId++}`, worktree, time: { created: 0 } },
    directory,
    worktree,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:5178'),
    $: {} as PluginInput['$'],
  };
}

/**
 * Full-assembly wiring: the canonical worktree trust root from
 * `createRuntimeContext` (realpath of PluginInput.worktree, ADR-004) drives
 * `detectProject`, which routes lock content through the real
 * `validateRuntimeLockAt` seam. This is the exact composition the plugin
 * initialization will use (S01-C registration wires the decision).
 */
function assembleForTest(
  input: PluginInput,
  toolContext: ToolContext,
): { context: ReturnType<typeof createRuntimeContext>; decision: ReturnType<typeof detectProject> } {
  const context = createRuntimeContext(input, toolContext);
  const decision = detectProject(context.projectRoot, validateRuntimeLockAt);
  return { context, decision };
}

describe('full-assembly integration (PO-S01-B-01/02/03)', () => {
  it('keeps worktree, session directory and process.cwd() mutually distinct in the fixtures', () => {
    const worktree = buildWorktree('valid');
    const directory = buildSessionDir();
    expect(realpathSync(worktree)).not.toBe(directory);
    expect(realpathSync(worktree)).not.toBe(realpathSync(process.cwd()));
    expect(directory).not.toBe(realpathSync(process.cwd()));
  });

  it('assembles the full path with canonical worktree trust root and propagated host context (PO-S01-B-01)', () => {
    const worktree = buildWorktree('valid');
    const directory = buildSessionDir();
    const abort = new AbortController().signal;
    const appLog = vi.fn();
    const input = makePluginInput(appLog, directory, worktree);
    const toolContext = makeToolContext(abort, 'executor', directory, worktree);

    const { context } = assembleForTest(input, toolContext);

    // trust-root: canonical worktree (realpath), never cwd or session dir.
    expect(context.projectRoot).toBe(realpathSync(worktree));
    expect(context.projectRoot).toBe(realpathSync(realpathSync(worktree)));
    expect(context.projectRoot).not.toBe(realpathSync(process.cwd()));
    expect(context.projectRoot).not.toBe(directory);

    // context propagation: all fields carry the host inputs.
    expect(context.currentDirectory).toBe(directory);
    expect(context.callerRole).toBe('executor');
    expect(context.cancellationSignal).toBe(abort);
    expect(context.logger).toBeDefined();

    // logger observation through the host adapter (one structured call).
    context.logger.info('integration ready', {
      projectRoot: context.projectRoot,
    });
    expect(appLog).toHaveBeenCalledTimes(1);
    expect(appLog).toHaveBeenCalledWith({
      body: {
        service: RUNTIME_CONTEXT_SERVICE,
        level: 'info',
        message: 'integration ready',
        extra: { projectRoot: context.projectRoot },
      },
    });
  });

  it('propagates ToolContext.abort as the same signal object (PO-S01-B-01)', () => {
    const worktree = buildWorktree('valid');
    const directory = buildSessionDir();
    const abort = new AbortController().signal;
    const input = makePluginInput(() => undefined, directory, worktree);
    const toolContext = makeToolContext(abort, 'executor', directory, worktree);

    const { context } = assembleForTest(input, toolContext);
    expect(context.cancellationSignal).toBe(abort);
  });

  it('detection matrix: valid ProofLoop / non-ProofLoop / missing lock / bad lock (PO-S01-B-02)', () => {
    const cases: Array<{
      kind: FixtureKind;
      active: boolean;
      findingCodes: string[];
    }> = [
      { kind: 'valid', active: true, findingCodes: [] },
      { kind: 'non-proofloop', active: false, findingCodes: ['HOST.PROJECT_NOT_TRUSTED'] },
      { kind: 'missing-lock', active: false, findingCodes: ['HOST.PROJECT_NOT_TRUSTED'] },
      { kind: 'bad-unknown', active: false, findingCodes: ['RUNTIME.SCHEMA_MISMATCH'] },
      { kind: 'bad-version', active: false, findingCodes: ['RUNTIME.VERSION_MISMATCH'] },
    ];

    for (const fixture of cases) {
      const worktree = buildWorktree(fixture.kind);
      const directory = buildSessionDir();
      const input = makePluginInput(() => undefined, directory, worktree);
      const toolContext = makeToolContext(
        new AbortController().signal,
        'executor',
        directory,
        worktree,
      );

      const { decision } = assembleForTest(input, toolContext);

      expect(decision.lockPresent).toBe(fixture.kind !== 'non-proofloop' && fixture.kind !== 'missing-lock');
      expect(decision.active).toBe(fixture.active);
      expect(decision.registerNonDoctorCapabilities).toBe(fixture.active);
      expect(decision.findings.map((f) => f.code)).toEqual(fixture.findingCodes);
    }
  });

  it('lock matrix: checked-in lock copy active, mutations fail closed with canonical Findings (PO-S01-B-03)', () => {
    // Checked-in copy → active.
    const validRoot = buildWorktree('valid');
    const validInput = makePluginInput(
      () => undefined,
      buildSessionDir(),
      validRoot,
    );
    const validTool = makeToolContext(
      new AbortController().signal,
      'executor',
      buildSessionDir(),
      validRoot,
    );
    const validDecision = assembleForTest(validInput, validTool).decision;
    expect(validDecision.active).toBe(true);
    expect(validDecision.findings).toEqual([]);

    // Unknown field mutation → RUNTIME.SCHEMA_MISMATCH.
    const unknownRoot = buildWorktree('bad-unknown');
    const unknownVerdict = validateRuntimeLockAt(
      path.join(realpathSync(unknownRoot), '.proofloop', 'runtime.lock'),
    );
    expect(unknownVerdict.valid).toBe(false);
    expect(unknownVerdict.findings.map((f) => f.code)).toEqual([
      'RUNTIME.SCHEMA_MISMATCH',
    ]);

    // Version mutation → RUNTIME.VERSION_MISMATCH.
    const versionRoot = buildWorktree('bad-version');
    const versionVerdict = validateRuntimeLockAt(
      path.join(realpathSync(versionRoot), '.proofloop', 'runtime.lock'),
    );
    expect(versionVerdict.valid).toBe(false);
    expect(versionVerdict.findings.map((f) => f.code)).toEqual([
      'RUNTIME.VERSION_MISMATCH',
    ]);
  });
});
