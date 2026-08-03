/**
 * @proofloop/opencode-plugin — vendored-zod fail-closed spec
 * (S2 review finding S2-F-002).
 *
 * When the vendored zod cannot be loaded the three S2 flow tools
 * (`proofloop_plan` / `proofloop_stage` / `proofloop_review`) must FAIL
 * CLOSED at the factory boundary: the unverified structural args descriptor is
 * NEVER used as the registered `args` (it was not verified on a real host).
 * The tool factory throws; `index.ts` catches the throw and skips only the
 * affected tool. `proofloop_doctor` (FR-006) never depends on zod and stays
 * available.
 *
 * The factory accepts an injectable `zodLoader` (the S2-F-002 test seam —
 * production callers never pass it). A loader returning `undefined` simulates
 * the vendored-zod-unavailable path.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { createDoctorTool } from './doctor.js';
import { createPlanTool, isPlanToolArgsAvailable } from './plan.js';
import { createStageTool, isStageToolArgsAvailable } from './stage.js';
import { createReviewTool, isReviewToolArgsAvailable } from './review.js';

/** Real temp worktree fixture (canonical trust root). */
function makeWorktree(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 's2f002-zod-'));
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Real PluginInput-shaped fixture. */
function makeInput(root: string): PluginInput {
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

function makeContext(root: string): RuntimeContext {
  return createRuntimeContext(makeInput(root));
}

/** Real ToolContext-shaped fixture. */
function makeToolContext(root: string): ToolContext {
  return {
    sessionID: 'sess-s2f002',
    messageID: 'msg-s2f002',
    agent: 'executor',
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

describe('S2-F-002 vendored-zod fail-closed (factory boundary)', () => {
  it('in this repo the vendored zod IS available (the normal registration path)', () => {
    // The repository ships the host's `.opencode/node_modules/zod`, so the
    // availability markers must be true — PO-S02-D-01 keeps the exact-4-tool
    // set on the normal path.
    expect(isStageToolArgsAvailable()).toBe(true);
    expect(isPlanToolArgsAvailable()).toBe(true);
    expect(isReviewToolArgsAvailable()).toBe(true);
  });

  it('createStageTool throws when the zod loader returns undefined (never the structural fallback)', () => {
    const project = makeWorktree();
    try {
      expect(() => createStageTool(makeContext(project.root), undefined, () => undefined)).toThrow(
        /vendored zod runtime is unavailable/,
      );
    } finally {
      project.cleanup();
    }
  });

  it('createPlanTool throws when the zod loader returns undefined', () => {
    const project = makeWorktree();
    try {
      expect(() =>
        createPlanTool(makeContext(project.root), undefined, () => undefined),
      ).toThrow(/vendored zod runtime is unavailable/);
    } finally {
      project.cleanup();
    }
  });

  it('createReviewTool throws when the zod loader returns undefined', () => {
    const project = makeWorktree();
    try {
      expect(() => createReviewTool(makeContext(project.root), undefined, () => undefined)).toThrow(
        /vendored zod runtime is unavailable/,
      );
    } finally {
      project.cleanup();
    }
  });

  it('the S2 factories still build real host-accepted args with the default zod loader', () => {
    const project = makeWorktree();
    try {
      const context = makeContext(project.root);
      const stage = createStageTool(context);
      const plan = createPlanTool(context);
      const review = createReviewTool(context);
      expect(Object.keys(stage.args).sort()).toEqual([
        'commit_sha',
        'cv_receipt_digest',
        'envelope',
        'integration_ref',
        'manifest_path',
        'operation',
        'project_root',
        'slice_id',
        'snapshot_digest',
        'stage_id',
        'summary',
        'tasks_path',
        'verdict',
      ]);
      expect(Object.keys(plan.args).sort()).toEqual([
        'evidence_dir',
        'manifest_digest',
        'manifest_path',
        'operation',
        'project_root',
        'stage_id',
        'summary',
        'tasks_path',
        'verdict',
      ]);
      expect(Object.keys(review.args).sort()).toEqual([
        'operation',
        'project_root',
        'scope',
        'stage_id',
        'summary',
        'verdict',
      ]);
      // Real host-accepted Zod raw-shape (not the structural descriptor).
      expect(
        (stage.args.operation as { constructor?: { name?: string } }).constructor?.name,
      ).toBe('ZodEnum');
    } finally {
      project.cleanup();
    }
  });

  it('proofloop_doctor never depends on zod and stays constructible (FR-006)', () => {
    const project = makeWorktree();
    try {
      const context = makeContext(project.root);
      const doctor = createDoctorTool(context);
      expect(typeof doctor.description).toBe('string');
      expect(doctor.args).toEqual({});
      // The doctor execute does not need a ToolContext zod shape; it is a
      // plain zero-arg tool.
      expect(typeof doctor.execute).toBe('function');
      void makeToolContext(project.root);
    } finally {
      project.cleanup();
    }
  });
});
