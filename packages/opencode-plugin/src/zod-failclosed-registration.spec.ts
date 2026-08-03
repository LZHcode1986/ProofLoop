/**
 * @proofloop/opencode-plugin — vendored-zod fail-closed REGISTRATION spec
 * (S2 review finding S2-F-002, plugin entry behavior).
 *
 * When the vendored zod is unavailable the S2 tool factories throw
 * (S2-F-002) and the plugin entry `index.ts` catches the throw per tool and
 * SKIPS ONLY that tool (logger.warn) — the plugin load never crashes and
 * `proofloop_doctor` (FR-006) stays registered and executable in EVERY
 * project state.
 *
 * This spec drives the REAL plugin entry function on a hermetic ACTIVE
 * ProofLoop fixture (valid `.proofloop/runtime.lock`), with the three S2 tool
 * module factories mocked to throw (the zod-unavailable scenario):
 *   - all three throw   → the registry is EXACTLY { proofloop_doctor };
 *   - only stage throws → the registry is exactly
 *     { proofloop_doctor, proofloop_plan, proofloop_review }.
 *
 * The normal zod-available path (EXACTLY the four S2 tools on an ACTIVE
 * project) is already locked by test/opencode-registration-gate.spec.ts
 * (PO-S02-D-01) and is re-verified here by the "no mock" test.
 */

import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { RUNTIME_LOCK_EXPECTATIONS } from './runtime-lock.js';

const DOCTOR_KEY = 'proofloop_doctor';
const PLAN_KEY = 'proofloop_plan';
const STAGE_KEY = 'proofloop_stage';
const REVIEW_KEY = 'proofloop_review';

/** Hermetic ACTIVE ProofLoop fixture (valid runtime.lock → S1 active). */
function makeActiveFixture(): { root: string; cleanup: () => void } {
  const e = RUNTIME_LOCK_EXPECTATIONS;
  const lock = {
    runtime_version: e.runtimeVersion.ok ? e.runtimeVersion.version : '0.1.0',
    domain_schema_version: e.schemaVersion,
    risk_policy_version: 1,
    capability_policy_version: 1,
    host_adapter: e.hostAdapter,
    plugin_package: e.pluginPackage,
    plugin_version: e.pluginVersion.ok ? e.pluginVersion.version : '0.1.0',
  };
  const root = mkdtempSync(path.join(tmpdir(), 's2f002-reg-'));
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  writeFileSync(
    path.join(root, '.proofloop', 'runtime.lock'),
    JSON.stringify(lock, null, 2),
    'utf-8',
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.proofloop/runtime.lock'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=ProofLoop Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'],
    { cwd: root },
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function pluginInput(root: string): PluginInput {
  return {
    client: { app: { log: () => undefined } },
    project: {},
    directory: root,
    worktree: root,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:5178'),
    $: {} as PluginInput['$'],
  } as unknown as PluginInput;
}

function toolContext(root: string) {
  return {
    sessionID: 'sess-s2f002-reg',
    messageID: 'msg-s2f002-reg',
    agent: 'executor',
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

type PluginFn = (input: PluginInput) => Promise<Record<string, unknown>>;

/** Build a doMock factory that throws for the given tool module. */
function throwingFactory(toolName: string) {
  return async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    return {
      ...actual,
      [`create${toolName}Tool`]: () => {
        throw new Error(
          `proofloop_${toolName.toLowerCase()} cannot register: the vendored zod runtime is unavailable`,
        );
      },
    };
  };
}

describe('S2-F-002 registration fail-closed (plugin entry)', () => {
  it('all three S2 zod factories unavailable → registry is exactly doctor (FR-006)', async () => {
    vi.resetModules();
    vi.doMock('./tools/plan.js', throwingFactory('Plan'));
    vi.doMock('./tools/stage.js', throwingFactory('Stage'));
    vi.doMock('./tools/review.js', throwingFactory('Review'));
    const plugin = (await import('./index.js')).default as PluginFn;

    const fixture = makeActiveFixture();
    try {
      const hooks = await plugin(pluginInput(fixture.root));
      const tool = hooks['tool'] as Record<string, unknown>;
      expect(Object.keys(tool).sort()).toEqual([DOCTOR_KEY]);

      // The doctor stays executable through the real host seam.
      const doctor = tool[DOCTOR_KEY] as {
        execute: (args: Record<string, unknown>, context: unknown) => Promise<{ output: string }>;
      };
      const envelope = await doctor.execute({}, toolContext(fixture.root));
      expect(typeof envelope.output).toBe('string');
      expect(envelope.output.length).toBeGreaterThan(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('only stage unavailable → plan/review still register, doctor stays (per-tool skip)', async () => {
    vi.resetModules();
    vi.doUnmock('./tools/plan.js');
    vi.doUnmock('./tools/review.js');
    vi.doMock('./tools/stage.js', throwingFactory('Stage'));
    const plugin = (await import('./index.js')).default as PluginFn;

    const fixture = makeActiveFixture();
    try {
      const hooks = await plugin(pluginInput(fixture.root));
      const tool = hooks['tool'] as Record<string, unknown>;
      expect(Object.keys(tool).sort()).toEqual([
        DOCTOR_KEY,
        PLAN_KEY,
        REVIEW_KEY,
      ]);
      expect(tool[STAGE_KEY]).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  it('normal path (no mock): ACTIVE project registers exactly the four S2 tools', async () => {
    vi.resetModules();
    vi.doUnmock('./tools/plan.js');
    vi.doUnmock('./tools/stage.js');
    vi.doUnmock('./tools/review.js');
    const plugin = (await import('./index.js')).default as PluginFn;

    const fixture = makeActiveFixture();
    try {
      const hooks = await plugin(pluginInput(fixture.root));
      const tool = hooks['tool'] as Record<string, unknown>;
      expect(Object.keys(tool).sort()).toEqual([
        DOCTOR_KEY,
        PLAN_KEY,
        REVIEW_KEY,
        STAGE_KEY,
      ]);
    } finally {
      fixture.cleanup();
    }
  });
});
