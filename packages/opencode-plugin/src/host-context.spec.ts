/**
 * @proofloop/opencode-plugin — RuntimeContext host adapter spec (PO-S01-B-01)
 *
 * PO: PO-S01-B-01
 *
 * Behavior: `RuntimeContext` must preserve the worktree trust root and the
 * current session context instead of deriving the artifact root from
 * `process.cwd()` (ADR-004).
 *
 * Public Seam: `PluginInput` + `ToolContext` → plugin initialization / tool
 * execution context (`createRuntimeContext`).
 *
 * The fixture makes `worktree`, `directory` and `process.cwd()` mutually
 * distinct, and passes the worktree path through a symlink so the realpath
 * canonicalization is observable. The host log observation goes through the
 * real `client.app.log` spy at the adapter seam — the abort signal and the
 * logger are NOT mocked away or replaced.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext, RUNTIME_CONTEXT_SERVICE } from './host-context.js';
import type { HostLogBody } from './adapters/logger.js';

/** Independent realpath oracle (node builtin) — not the implementation's own result. */
const realpath = realpathSync;

let base: string;
let realWorktree: string;
let sessionDir: string;
let worktreeLink: string;

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 's01-b-t01-'));
  realWorktree = path.join(base, 'worktree');
  sessionDir = path.join(base, 'session-dir');
  worktreeLink = path.join(base, 'worktree-link');
  mkdirSync(realWorktree, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  // Host reports `worktree` through a symlink; canonical root must resolve it.
  symlinkSync(realWorktree, worktreeLink, 'dir');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** OC-0-shaped ToolContext fixture (real host shape). */
function makeToolContext(
  abort: AbortSignal,
  agent = 'executor',
): ToolContext {
  return {
    sessionID: 'sess-t01',
    messageID: 'msg-t01',
    agent,
    directory: sessionDir,
    worktree: worktreeLink,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

/** OC-0-shaped PluginInput fixture with a real `client.app.log` spy sink. */
function makePluginInput(
  appLog: (options: { body: HostLogBody }) => unknown,
): PluginInput {
  return {
    client: { app: { log: appLog } } as unknown as PluginInput['client'],
    project: {
      id: 'proj-t01',
      worktree: realWorktree,
      time: { created: 0 },
    },
    directory: sessionDir,
    worktree: worktreeLink,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:5178'),
    $: {} as PluginInput['$'],
  };
}

describe('createRuntimeContext (PO-S01-B-01)', () => {
  it('keeps worktree, directory and process.cwd() mutually distinct in the fixture', () => {
    // Fixture hygiene: this is not a same-directory happy path.
    expect(realpath(worktreeLink)).not.toBe(sessionDir);
    expect(realpath(worktreeLink)).not.toBe(realpath(process.cwd()));
    expect(sessionDir).not.toBe(realpath(process.cwd()));
  });

  it('assembles all five RuntimeContext fields from the real host shapes', () => {
    const abort = new AbortController().signal;
    const appLog = () => undefined;
    const input = makePluginInput(appLog);
    const toolContext = makeToolContext(abort, 'executor');

    const context = createRuntimeContext(input, toolContext);

    // projectRoot is the canonical (realpath-resolved) worktree root.
    expect(context.projectRoot).toBe(realpath(worktreeLink));
    expect(context.projectRoot).toBe(realpath(realWorktree));
    // currentDirectory is the session directory, not the worktree.
    expect(context.currentDirectory).toBe(sessionDir);
    expect(context.currentDirectory).not.toBe(context.projectRoot);
    // callerRole comes from ToolContext.agent.
    expect(context.callerRole).toBe('executor');
    // cancellationSignal is the SAME AbortSignal object (not replaced/swallowed).
    expect(context.cancellationSignal).toBe(abort);
    // logger adapter is present and usable.
    expect(context.logger).toBeDefined();
  });

  it('never derives the artifact root from bare process.cwd() (ADR-004)', () => {
    const abort = new AbortController().signal;
    const appLog = () => undefined;
    const input = makePluginInput(appLog);
    const toolContext = makeToolContext(abort);

    const context = createRuntimeContext(input, toolContext);

    expect(context.projectRoot).toBe(realpath(worktreeLink));
    expect(context.projectRoot).not.toBe(realpath(process.cwd()));
  });

  it('propagates ToolContext.abort as the same signal object, without replacement', () => {
    const abort = new AbortController().signal;
    const appLog = () => undefined;
    const input = makePluginInput(appLog);
    const toolContext = makeToolContext(abort);

    const context = createRuntimeContext(input, toolContext);

    expect(context.cancellationSignal).toBe(abort);
  });

  it('routes structured log calls through the host client.app.log adapter', () => {
    const abort = new AbortController().signal;
    const appLog = vi.fn();
    const input = makePluginInput(appLog);
    const toolContext = makeToolContext(abort);

    const context = createRuntimeContext(input, toolContext);
    context.logger.info('context ready', {
      projectRoot: context.projectRoot,
    });

    expect(appLog).toHaveBeenCalledTimes(1);
    expect(appLog).toHaveBeenCalledWith({
      body: {
        service: RUNTIME_CONTEXT_SERVICE,
        level: 'info',
        message: 'context ready',
        extra: { projectRoot: context.projectRoot },
      },
    });
  });

  it('maps logger level methods onto the structured host body (level + optional extra)', () => {
    const abort = new AbortController().signal;
    const appLog = vi.fn();
    const input = makePluginInput(appLog);
    const toolContext = makeToolContext(abort);

    const context = createRuntimeContext(input, toolContext);
    context.logger.error('boom', { code: 'E1' });
    context.logger.warn('plain warning');

    expect(appLog).toHaveBeenNthCalledWith(1, {
      body: {
        service: RUNTIME_CONTEXT_SERVICE,
        level: 'error',
        message: 'boom',
        extra: { code: 'E1' },
      },
    });
    expect(appLog).toHaveBeenNthCalledWith(2, {
      body: {
        service: RUNTIME_CONTEXT_SERVICE,
        level: 'warn',
        message: 'plain warning',
      },
    });
  });

  it('assembles an initialization-time context from PluginInput alone', () => {
    const appLog = () => undefined;
    const input = makePluginInput(appLog);

    const context = createRuntimeContext(input);

    expect(context.projectRoot).toBe(realpath(realWorktree));
    expect(context.currentDirectory).toBe(sessionDir);
    // No ToolContext at plugin init: caller role and cancellation are not
    // invented by the plugin — they are simply absent until tool execute.
    expect(context.callerRole).toBeUndefined();
    expect(context.cancellationSignal).toBeUndefined();
    expect(context.logger).toBeDefined();
  });
});
