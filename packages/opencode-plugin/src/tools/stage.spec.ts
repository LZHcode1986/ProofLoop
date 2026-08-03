/**
 * @proofloop/opencode-plugin — proofloop_stage tool definition contract spec
 * (S02-A-T01).
 *
 * PO: PO-S02-A-01 (contract layer), PO-S02-A-04 (fail-closed boundary)
 *
 * S02-A-T01 delivers the host tool definition skeleton for `proofloop_stage`
 * through the real `tool({ description, args, execute })` shape:
 *
 *   - args is the host-accepted Zod raw-shape (field name `args`, NOT
 *     `inputSchema`) carrying the canonical operation inputs: `operation`
 *     (`status` | `next`), `stage_id`, optional `project_root` (canonical-root
 *     consistency assertion only — never overrides the trust root), optional
 *     `manifest_path` / `tasks_path` (resolved relative to the trust root).
 *   - operation contract: only `status`/`next` are legal; every other
 *     operation (S3/S5 `admit_*`, `run_gate`, unknown values) fails closed
 *     with a canonical Finding and NEVER reaches a dispatch/write branch.
 *   - path guard: `projectRoot` always comes from the canonical
 *     `createRuntimeContext` root (realpath of PluginInput.worktree); absolute
 *     paths must stay inside the trust root — out-of-bounds →
 *     HOST.PATH_OUTSIDE_PROJECT.
 *   - error boundary: the unified ToolResult mapping (`successResult` /
 *     `toErrorResult`) wraps every dispatch; a bare exception never leaks into
 *     the host envelope, and caller abort propagates AbortError (never a clean
 *     PASS).
 *
 * T02 wires the status/next resolvers to `reconcileStage` /
 * `NextActionService.nextAction`; until then a valid operation reaches the
 * handler seam when injected, and returns a structured fail-closed result when
 * no handler is wired (the contract layer is what T01 locks).
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateFinding } from '@proofloop/runtime';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { successResult } from '../tool-result.js';
import {
  STAGE_OPERATIONS,
  STAGE_TOOL_ARGS_FALLBACK,
  STAGE_TOOL_NAME,
  checkDefaultStagePaths,
  createStageTool,
  parseStageArgs,
} from './stage.js';
import type {
  StageOperationHandlers,
  StageResolvedArgs,
  StageToolArgsShape,
} from './stage.js';

/** Operations that are NEVER legal for proofloop_stage (rejected without dispatching). */
const S2_FORBIDDEN_OPERATIONS = [
  'run_gate',
  'admit_gate_result',
  'admit_gate_interrupted',
  'stage_plan',
  'admit_stage_plan',
  'compile_acceptance',
  'run_e2e',
  'prepare_project_review',
  'finalize_project_review',
] as const;

/** Real temp worktree fixture (canonical trust root). */
function makeWorktree(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 's02a-t01-'));
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

/** Real RuntimeContext over the fixture root (canonical realpath). */
function makeContext(root: string): RuntimeContext {
  return createRuntimeContext(makeInput(root));
}

/** Real ToolContext-shaped fixture. */
function makeToolContext(root: string, abort: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: 'sess-s02a-t01',
    messageID: 'msg-s02a-t01',
    agent: 'executor',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

/** Silent handlers (all success) for dispatch tests. */
function okHandlers(): StageOperationHandlers {
  const status = vi.fn((_input: StageResolvedArgs) =>
    successResult({ data: { op: 'status' } }),
  );
  const next = vi.fn((_input: StageResolvedArgs) =>
    successResult({ data: { op: 'next' } }),
  );
  return { status, next };
}

/**
 * Narrow execute return to the `{ output }` host envelope the tool always
 * produces (the host `ToolResult` type is a string | object union; every
 * proofloop_stage execution returns the object envelope).
 */
type StageExecuteTool = {
  description: string;
  args: StageToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
};

/** Build a stage tool through the real factory with the narrowed envelope. */
function makeTool(
  context: RuntimeContext,
  handlers?: StageOperationHandlers,
): StageExecuteTool {
  return createStageTool(context, handlers) as StageExecuteTool;
}

/** First resolved-args call of a vi.fn handler (typed through the mock). */
function firstCallArgs(handler: unknown): StageResolvedArgs {
  const mock = handler as { mock: { calls: Array<[StageResolvedArgs]> } };
  return mock.mock.calls[0][0];
}

describe('stage tool definition shape (PO-S02-A-01)', () => {
  it('returns the host { description, args, execute } structure', () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      expect(typeof tool).toBe('object');
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.args).toBe('object');
      expect(typeof tool.execute).toBe('function');
    } finally {
      project.cleanup();
    }
  });

  it('uses the host field name `args` (never `inputSchema`)', () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      expect(tool).not.toHaveProperty('inputSchema');
      expect(tool).toHaveProperty('args');
    } finally {
      project.cleanup();
    }
  });

  it('declares the canonical operation inputs in the args shape (real host-accepted Zod raw-shape)', () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      const args = tool.args;
      expect(Object.keys(args).sort()).toEqual([
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
      // Real host-accepted Zod raw-shape (vendored zod v4): every field is a
      // real Zod schema, not a plain descriptor.
      const fieldCtor = (f: unknown): string =>
        (f as { constructor?: { name?: string } }).constructor?.name ?? '';
      expect(fieldCtor(args.operation)).toBe('ZodEnum');
      expect((args.operation as { options?: readonly string[] }).options).toEqual([
        'status',
        'next',
        'admit_worker_result',
        'admit_cv_result',
        'admit_slice_commit',
        'admit_integration',
      ]);
      expect(fieldCtor(args.stage_id)).toBe('ZodString');
      expect(fieldCtor(args.project_root)).toBe('ZodOptional');
      expect(fieldCtor(args.manifest_path)).toBe('ZodOptional');
      expect(fieldCtor(args.tasks_path)).toBe('ZodOptional');
      // Required fields are plain strings; optional fields wrap a string.
      const innerCtor = (f: unknown): string => {
        const inner = (f as { _def?: { innerType?: unknown } })._def?.innerType;
        return (inner as { constructor?: { name?: string } })?.constructor?.name ?? '';
      };
      expect(innerCtor(args.project_root)).toBe('ZodString');
      expect(innerCtor(args.manifest_path)).toBe('ZodString');
      expect(innerCtor(args.tasks_path)).toBe('ZodString');
      expect(innerCtor(args.slice_id)).toBe('ZodString');
      expect(innerCtor(args.summary)).toBe('ZodString');
      // Human-readable descriptions are preserved on every field.
      expect((args.operation.description ?? '').length).toBeGreaterThan(0);
      expect((args.stage_id.description ?? '').length).toBeGreaterThan(0);
    } finally {
      project.cleanup();
    }
  });

  it('keeps the structural descriptor ONLY as a documented reference shape (never the registered args)', () => {
    // S2-F-002 fail-closed: the structural descriptor is retained as the
    // documented reference shape but is NEVER used as the registered `args`
    // when the vendored zod is absent — the factory throws instead.
    const fallback = STAGE_TOOL_ARGS_FALLBACK;
    expect(Object.keys(fallback).sort()).toEqual([
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
    expect(fallback.operation.values).toEqual([
      'status',
      'next',
      'admit_worker_result',
      'admit_cv_result',
      'admit_slice_commit',
      'admit_integration',
    ]);
    expect(fallback.stage_id.optional).not.toBe(true);
    expect(fallback.project_root.optional).toBe(true);
    expect(fallback.manifest_path.optional).toBe(true);
    expect(fallback.tasks_path.optional).toBe(true);
    expect(fallback.slice_id.optional).toBe(true);
    expect(fallback.verdict.values).toEqual(['PASS', 'REPAIR']);
    expect(fallback.operation.description.length).toBeGreaterThan(0);
    // The registered args are the REAL host-accepted Zod raw-shape (never the
    // structural descriptor) — the "declares the canonical operation inputs"
    // test above already proves the registered shape uses real Zod schemas.
  });

  it('fails closed when the vendored zod is unavailable (S2-F-002: no structural fallback registration)', () => {
    const project = makeWorktree();
    try {
      // The injectable zod loader is the S2-F-002 test seam: a loader that
      // returns undefined simulates the vendored-zod-unavailable path. The
      // factory must THROW instead of registering the unverified descriptor.
      expect(() =>
        createStageTool(makeContext(project.root), undefined, () => undefined),
      ).toThrow(/vendored zod runtime is unavailable/);
    } finally {
      project.cleanup();
    }
  });
});

describe('operation contract (PO-S02-A-01 / PO-S02-A-04)', () => {
  it('accepts status and next and dispatches to the corresponding handler seam', async () => {
    const project = makeWorktree();
    try {
      const status = vi.fn((_input: StageResolvedArgs) =>
        successResult({ data: { op: 'status' } }),
      );
      const next = vi.fn((_input: StageResolvedArgs) =>
        successResult({ data: { op: 'next' } }),
      );
      const tool = makeTool(makeContext(project.root), { status, next });

      const envelope = await tool.execute(
        { operation: 'status', stage_id: 'S2' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('ProofLoop Stage');
      expect(envelope.output).toContain('Status: ok');
      expect(status).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();

      const input = status.mock.calls[0][0];
      expect(input.stageId).toBe('S2');
      expect(input.projectRoot).toBe(project.root);
    } finally {
      project.cleanup();
    }
  });

  it('resolves relative manifest_path/tasks_path against the trust root for dispatch', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      await tool.execute(
        {
          operation: 'next',
          stage_id: 'S2',
          manifest_path: '.proofloop/manifests/S2.json',
          tasks_path: 'delivery/stages/S2/tasks.md',
        },
        makeToolContext(project.root),
      );
      const input = firstCallArgs(handlers.next);
      expect(input.manifestPath).toBe(path.join(project.root, '.proofloop', 'manifests', 'S2.json'));
      expect(input.tasksPath).toBe(path.join(project.root, 'delivery', 'stages', 'S2', 'tasks.md'));
    } finally {
      project.cleanup();
    }
  });

  it('rejects a missing operation with a canonical Finding and no dispatch', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { stage_id: 'S2' } as Record<string, unknown>,
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expect(handlers.status).not.toHaveBeenCalled();
      expect(handlers.next).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it('rejects an unknown operation value with a canonical Finding and no dispatch', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'run_gate_x', stage_id: 'S2' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(handlers.status).not.toHaveBeenCalled();
      expect(handlers.next).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it.each(S2_FORBIDDEN_OPERATIONS)(
    'rejects S2-forbidden operation %s without dispatching (no write-branch downgrade)',
    async (operation) => {
      const project = makeWorktree();
      try {
        const handlers = okHandlers();
        const tool = makeTool(makeContext(project.root), handlers);
        const envelope = await tool.execute(
          { operation, stage_id: 'S2' },
          makeToolContext(project.root),
        );
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
        expect(envelope.output).toContain('Status: failed');
        expect(handlers.status).not.toHaveBeenCalled();
        expect(handlers.next).not.toHaveBeenCalled();
      } finally {
        project.cleanup();
      }
    },
  );
});

describe('path guard (PO-S02-A-04)', () => {
  it('accepts an absolute manifest_path inside the trust root', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const inside = path.join(project.root, 'delivery', 'stages', 'S2', 'manifest.json');
      const envelope = await tool.execute(
        { operation: 'status', stage_id: 'S2', manifest_path: inside },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('Status: ok');
      const input = firstCallArgs(handlers.status);
      expect(input.manifestPath).toBe(inside);
    } finally {
      project.cleanup();
    }
  });

  it('rejects an absolute manifest_path outside the trust root with HOST.PATH_OUTSIDE_PROJECT', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const outside = path.join(tmpdir(), 's02a-t01-outside-manifest.json');
      const envelope = await tool.execute(
        { operation: 'status', stage_id: 'S2', manifest_path: outside },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(envelope.output).toContain('Status: failed');
      expect(handlers.status).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it('rejects an absolute tasks_path outside the trust root with HOST.PATH_OUTSIDE_PROJECT', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const outside = path.join(tmpdir(), 's02a-t01-outside-tasks.md');
      const envelope = await tool.execute(
        { operation: 'next', stage_id: 'S2', tasks_path: outside },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(handlers.next).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it('accepts a project_root equal to the canonical root (consistency assertion)', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'status', stage_id: 'S2', project_root: project.root },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('Status: ok');
      expect(handlers.status).toHaveBeenCalledTimes(1);
    } finally {
      project.cleanup();
    }
  });

  it('rejects a project_root that does not match the canonical root (HOST.PROJECT_NOT_TRUSTED)', async () => {
    const project = makeWorktree();
    const other = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'status', stage_id: 'S2', project_root: other.root },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
      expect(envelope.output).toContain('Status: failed');
      expect(handlers.status).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
      other.cleanup();
    }
  });

  it.each([
    '../../../../tmp/attacker',
    '/etc/passwd',
    'S2/../../etc/passwd',
    'S2\\..\\..\\tmp',
    'S2:../etc',
    'S2-A',
    's2',
    'S',
    'S02-',
    '..',
  ])('rejects non-canonical stage_id %s fail-closed (no path traversal into default reads)', async (stageId) => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'status', stage_id: stageId },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expect(handlers.status).not.toHaveBeenCalled();
      expect(handlers.next).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it('default manifest/tasks paths for a canonical stage id stay inside the trust root', () => {
    const project = makeWorktree();
    try {
      expect(checkDefaultStagePaths(project.root, 'S2')).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it('default-path guard rejects a stage id whose defaults would escape the trust root (HOST.PATH_OUTSIDE_PROJECT)', () => {
    const project = makeWorktree();
    try {
      // Direct guard call (bypassing the canonical-id regex): the boundary
      // check itself must reject traversal even if the regex were bypassed.
      const result = checkDefaultStagePaths(project.root, '../../../../tmp/attacker');
      expect(result).not.toBeNull();
      expect(result?.findings[0].code).toBe('HOST.PATH_OUTSIDE_PROJECT');
    } finally {
      project.cleanup();
    }
  });
});

describe('error boundary and fail-closed behavior (PO-S02-A-04)', () => {
  it('maps a throwing handler to a canonical fail-closed result (no bare exception)', async () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root), {
        status: () => {
          throw new Error('boom');
        },
      });
      const envelope = await tool.execute(
        { operation: 'status', stage_id: 'S2' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      // message surfaced, never a stack trace (no internal detail leak)
      expect(envelope.output).toContain('boom');
      expect(envelope.output).not.toContain(' at ');
    } finally {
      project.cleanup();
    }
  });

  it('performs a real read through the default wiring and fails closed on a missing manifest', async () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      const envelope = await tool.execute(
        { operation: 'status', stage_id: 'S2' },
        makeToolContext(project.root),
      );
      // The fixture has no manifest: reconcileStage fails closed with a
      // canonical Finding — no guessed state, no bare throw, no write branch.
      expect(envelope.output).toContain('ProofLoop Stage');
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('DOMAIN.STAGE_NOT_FOUND');
    } finally {
      project.cleanup();
    }
  });

  it('propagates caller abort as AbortError, never a clean PASS', async () => {
    const project = makeWorktree();
    try {
      const controller = new AbortController();
      controller.abort();
      const tool = makeTool(makeContext(project.root), {
        status: () => successResult({ data: { op: 'status' } }),
      });
      let thrown: unknown;
      try {
        await tool.execute(
          { operation: 'status', stage_id: 'S2' },
          makeToolContext(project.root, controller.signal),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as Error).name).toBe('AbortError');
    } finally {
      project.cleanup();
    }
  });

  it('every contract-layer finding is accepted by the kernel validateFinding oracle', () => {
    const project = makeWorktree();
    const other = makeWorktree();
    try {
      const cases: unknown[] = [
        {},
        { stage_id: 'S2' },
        { operation: 'run_gate', stage_id: 'S2' },
        { operation: 'admit_worker_result', stage_id: 'S2' },
        { operation: 'next', stage_id: '' },
        {
          operation: 'next',
          stage_id: 'S2',
          manifest_path: path.join(tmpdir(), 's02a-t01-outside-m.json'),
        },
        { operation: 'next', stage_id: 'S2', project_root: other.root },
      ];
      for (const raw of cases) {
        const parsed = parseStageArgs(raw, project.root);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          expect(parsed.result.findings.length).toBeGreaterThan(0);
          for (const finding of parsed.result.findings) {
            // Kernel validator is the oracle: a Finding that fails it is not
            // canonical.
            expect(() => validateFinding(finding)).not.toThrow();
          }
        }
      }
    } finally {
      project.cleanup();
      other.cleanup();
    }
  });

  it('exposes exactly the canonical operation closed set', () => {
    expect(STAGE_OPERATIONS).toEqual([
      'status',
      'next',
      'admit_worker_result',
      'admit_cv_result',
      'admit_slice_commit',
      'admit_integration',
    ]);
    expect(STAGE_TOOL_NAME).toBe('proofloop_stage');
  });
});
