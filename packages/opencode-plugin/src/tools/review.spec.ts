/**
 * @proofloop/opencode-plugin — proofloop_review tool definition contract spec
 * (S02-C-T01).
 *
 * PO: PO-S02-C-01 (host definition + stage_status operation contract),
 * PO-S02-C-03 (fail-closed boundary at the contract layer).
 *
 * S02-C-T01 delivers the host tool definition skeleton for `proofloop_review`
 * through the real `tool({ description, args, execute })` shape:
 *
 *   - args shape (host field name `args`, NOT `inputSchema`): `operation`
 *     (S2 accepts ONLY `stage_status`), required `stage_id`, optional
 *     `project_root` (canonical-root consistency assertion only — never
 *     overrides the trust root). Same vendored-zod / structural-fallback
 *     tradeoff as S02-A `STAGE_TOOL_ARGS` (zero mandatory zod dependency).
 *   - operation contract: only `stage_status` is legal in S2;
 *     `prepare_stage_review` / `finalize_stage_review` / unknown values fail
 *     closed with a canonical Finding (RUNTIME.SCHEMA_MISMATCH) at the execute
 *     boundary and NEVER reach a dispatch/write branch (AWI-009 post boundary).
 *   - stage_id canonical guard: reuse S02-A `CANONICAL_STAGE_ID`
 *     (`/^S\d+$/`); traversal / absolute / slice ids fail closed before any
 *     runtime read (defense-in-depth default-path check included).
 *   - path guard: `project_root` is a canonical-root consistency assertion
 *     (HOST.PROJECT_NOT_TRUSTED on mismatch) — it never overrides the trust
 *     root.
 *   - error boundary: the unified `toErrorResult` mapping wraps every dispatch;
 *     a bare exception never leaks into the host envelope, and caller abort
 *     propagates AbortError (never a clean PASS).
 *
 * T02 wires the `stage_status` handler to `reconcileStage` (S02-A status
 * projection) by default; the handler seam remains injectable for
 * tests/extension. On a fixture with no manifest the DEFAULT wiring fails
 * closed with a canonical Finding (DOMAIN.STAGE_NOT_FOUND) — never a guessed
 * status, never a bare throw, never a write branch.
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
  REJECTED_REVIEW_OPERATIONS,
  REVIEW_OPERATIONS,
  REVIEW_TOOL_ARGS_FALLBACK,
  REVIEW_TOOL_NAME,
  createReviewTool,
  parseReviewArgs,
} from './review.js';
import type {
  ReviewOperationHandlers,
  ReviewResolvedArgs,
  ReviewToolArgsShape,
} from './review.js';

/** Canonical S3-rejected review operations (§1.3 — project/gate/unknown). */
const REJECTED_OPERATIONS = [
  'prepare_project_review',
  'finalize_project_review',
  'project_status',
  'run_gate',
  'admit_gate_result',
  'admit_gate_interrupted',
] as const;

/** Non-canonical stage ids (traversal / absolute / slice ids). */
const NON_CANONICAL_STAGE_IDS = [
  '../../../../tmp/attacker',
  '/etc/passwd',
  'S2/../../etc/passwd',
  'S2\\..\\..\\tmp',
  'S2:../etc',
  'S02-A',
  's2',
  'S',
  'S02-',
  '..',
] as const;

/** Real temp worktree fixture (canonical trust root). */
function makeWorktree(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 's02c-t01-'));
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

/** Real ToolContext-shaped fixture (review is visible to stage-reviewer/brain). */
function makeToolContext(root: string, abort: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: 'sess-s02c-t01',
    messageID: 'msg-s02c-t01',
    agent: 'stage-reviewer',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

/** Silent stage_status handler (success) for dispatch tests. */
function okHandlers(): ReviewOperationHandlers {
  const stageStatus = vi.fn((_input: ReviewResolvedArgs) =>
    successResult({ data: { op: 'stage_status' } }),
  );
  return { stage_status: stageStatus };
}

/**
 * Narrow execute return to the `{ output }` host envelope the tool always
 * produces (the host `ToolResult` type is a string | object union; every
 * proofloop_review execution returns the object envelope).
 */
type ReviewExecuteTool = {
  description: string;
  args: ReviewToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
};

/** Build a review tool through the real factory with the narrowed envelope. */
function makeTool(
  context: RuntimeContext,
  handlers?: ReviewOperationHandlers,
): ReviewExecuteTool {
  return createReviewTool(context, handlers) as ReviewExecuteTool;
}

/** First resolved-args call of a vi.fn handler (typed through the mock). */
function firstCallArgs(handler: unknown): ReviewResolvedArgs {
  const mock = handler as { mock: { calls: Array<[ReviewResolvedArgs]> } };
  return mock.mock.calls[0][0];
}

describe('review tool definition shape (PO-S02-C-01)', () => {
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

  it('declares the canonical review operation inputs in the args shape (real host-accepted Zod raw-shape)', () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      const args = tool.args;
      expect(Object.keys(args).sort()).toEqual([
        'operation',
        'project_root',
        'scope',
        'stage_id',
        'summary',
        'verdict',
      ]);
      // Real host-accepted Zod raw-shape (vendored zod v4): every field is a
      // real Zod schema, not a plain descriptor.
      const fieldCtor = (f: unknown): string =>
        (f as { constructor?: { name?: string } }).constructor?.name ?? '';
      expect(fieldCtor(args.operation)).toBe('ZodEnum');
      expect((args.operation as { options?: readonly string[] }).options).toEqual([
        'stage_status',
        'prepare_stage_review',
        'finalize_stage_review',
      ]);
      expect(fieldCtor(args.stage_id)).toBe('ZodString');
      expect(fieldCtor(args.project_root)).toBe('ZodOptional');
      // Optional enum fields: the closed options live on the inner ZodEnum.
      const innerOptions = (f: unknown): readonly string[] =>
        ((f as { _def?: { innerType?: { options?: readonly string[] } } })._def?.innerType
          ?.options ?? []) as readonly string[];
      expect(fieldCtor(args.scope)).toBe('ZodOptional');
      expect(innerOptions(args.scope)).toEqual(['stage']);
      expect(fieldCtor(args.verdict)).toBe('ZodOptional');
      expect(innerOptions(args.verdict)).toEqual(['ACCEPTED', 'REPAIR']);
      expect(fieldCtor(args.summary)).toBe('ZodOptional');
      // Optional field wraps a string.
      const innerCtor = (f: unknown): string => {
        const inner = (f as { _def?: { innerType?: unknown } })._def?.innerType;
        return (inner as { constructor?: { name?: string } })?.constructor?.name ?? '';
      };
      expect(innerCtor(args.project_root)).toBe('ZodString');
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
    const fallback = REVIEW_TOOL_ARGS_FALLBACK;
    expect(Object.keys(fallback).sort()).toEqual([
      'operation',
      'project_root',
      'scope',
      'stage_id',
      'summary',
      'verdict',
    ]);
    expect(fallback.operation.type).toBe('enum');
    expect(fallback.operation.values).toEqual([
      'stage_status',
      'prepare_stage_review',
      'finalize_stage_review',
    ]);
    expect(fallback.stage_id.optional).not.toBe(true);
    expect(fallback.project_root.optional).toBe(true);
    expect(fallback.scope.values).toEqual(['stage']);
    expect(fallback.verdict.values).toEqual(['ACCEPTED', 'REPAIR']);
    expect(fallback.summary.optional).toBe(true);
    expect(fallback.operation.description.length).toBeGreaterThan(0);
  });

  it('fails closed when the vendored zod is unavailable (S2-F-002: no structural fallback registration)', () => {
    const project = makeWorktree();
    try {
      // The injectable zod loader is the S2-F-002 test seam: a loader that
      // returns undefined simulates the vendored-zod-unavailable path. The
      // factory must THROW instead of registering the unverified descriptor.
      expect(() =>
        createReviewTool(makeContext(project.root), undefined, () => undefined),
      ).toThrow(/vendored zod runtime is unavailable/);
    } finally {
      project.cleanup();
    }
  });
});

describe('operation contract (PO-S02-C-01 / PO-S02-C-03)', () => {
  it('accepts stage_status and dispatches to the handler seam with resolved args', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'stage_status', stage_id: 'S2' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('ProofLoop Review');
      expect(envelope.output).toContain('Status: ok');
      expect(handlers.stage_status).toHaveBeenCalledTimes(1);
      const input = firstCallArgs(handlers.stage_status);
      expect(input.operation).toBe('stage_status');
      expect(input.stageId).toBe('S2');
      expect(input.projectRoot).toBe(project.root);
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
      expect(handlers.stage_status).not.toHaveBeenCalled();
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
        { operation: 'frobnicate', stage_id: 'S2' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expect(handlers.stage_status).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it.each(REJECTED_OPERATIONS)(
    'rejects review operation %s without dispatching (no write-branch downgrade)',
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
        expect(envelope.output).toContain(`Operation: ${operation}`);
        expect(envelope.output).toContain('Status: failed');
        expect(handlers.stage_status).not.toHaveBeenCalled();
      } finally {
        project.cleanup();
      }
    },
  );

  it('performs a real read through the default wiring and fails closed on a missing manifest', async () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      const envelope = await tool.execute(
        { operation: 'stage_status', stage_id: 'S2' },
        makeToolContext(project.root),
      );
      // The fixture has no manifest: the default wiring calls reconcileStage
      // and fails closed with a canonical Finding — no guessed state, no bare
      // throw, no write branch.
      expect(envelope.output).toContain('ProofLoop Review');
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('DOMAIN.STAGE_NOT_FOUND');
    } finally {
      project.cleanup();
    }
  });
});

describe('stage_id canonical guard (PO-S02-C-03)', () => {
  it.each(NON_CANONICAL_STAGE_IDS)(
    'rejects non-canonical stage_id %s fail-closed (no path traversal into default reads)',
    async (stageId) => {
      const project = makeWorktree();
      try {
        const handlers = okHandlers();
        const tool = makeTool(makeContext(project.root), handlers);
        const envelope = await tool.execute(
          { operation: 'stage_status', stage_id: stageId },
          makeToolContext(project.root),
        );
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
        expect(envelope.output).toContain('Status: failed');
        expect(handlers.stage_status).not.toHaveBeenCalled();
      } finally {
        project.cleanup();
      }
    },
  );

  it('rejects a missing/empty stage_id with a canonical Finding', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'stage_status', stage_id: '' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expect(handlers.stage_status).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });
});

describe('project_root assertion (PO-S02-C-03)', () => {
  it('accepts a project_root equal to the canonical root (consistency assertion)', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'stage_status', stage_id: 'S2', project_root: project.root },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('Status: ok');
      expect(handlers.stage_status).toHaveBeenCalledTimes(1);
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
        { operation: 'stage_status', stage_id: 'S2', project_root: other.root },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
      expect(envelope.output).toContain('Status: failed');
      expect(handlers.stage_status).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
      other.cleanup();
    }
  });

  it('rejects an empty project_root with RUNTIME.SCHEMA_MISMATCH', async () => {
    const project = makeWorktree();
    try {
      const handlers = okHandlers();
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'stage_status', stage_id: 'S2', project_root: '' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expect(handlers.stage_status).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });
});

describe('error boundary and fail-closed behavior (PO-S02-C-03)', () => {
  it('maps a throwing handler to a canonical fail-closed result (no bare exception)', async () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root), {
        stage_status: () => {
          throw new Error('boom');
        },
      });
      const envelope = await tool.execute(
        { operation: 'stage_status', stage_id: 'S2' },
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

  it('propagates caller abort as AbortError, never a clean PASS', async () => {
    const project = makeWorktree();
    try {
      const controller = new AbortController();
      controller.abort();
      const tool = makeTool(makeContext(project.root), {
        stage_status: () => successResult({ data: { op: 'stage_status' } }),
      });
      let thrown: unknown;
      try {
        await tool.execute(
          { operation: 'stage_status', stage_id: 'S2' },
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
        { operation: 'finalize_stage_review', stage_id: 'S2' },
        { operation: 'prepare_stage_review', stage_id: 'S2', scope: 'project' },
        { operation: 'prepare_stage_review', stage_id: 'S2', scope: 'banana' },
        {
          operation: 'finalize_stage_review',
          stage_id: 'S2',
          verdict: 'PASS',
          summary: 'x',
        },
        {
          operation: 'finalize_stage_review',
          stage_id: 'S2',
          verdict: 'ACCEPTED',
        },
        {
          operation: 'stage_status',
          stage_id: 'S2',
          scope: 'stage',
        },
        {
          operation: 'prepare_stage_review',
          stage_id: 'S2',
          verdict: 'ACCEPTED',
        },
        { operation: 'run_gate', stage_id: 'S2' },
        { operation: 'stage_status', stage_id: '' },
        { operation: 'stage_status', stage_id: 'S2-A' },
        { operation: 'stage_status', stage_id: '../../../../tmp/attacker' },
        { operation: 'stage_status', stage_id: 'S2', project_root: '' },
        { operation: 'stage_status', stage_id: 'S2', project_root: other.root },
      ];
      for (const raw of cases) {
        const parsed = parseReviewArgs(raw, project.root);
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

  it('accepts a canonical stage_status parse through the contract seam', () => {
    const project = makeWorktree();
    try {
      const parsed = parseReviewArgs(
        { operation: 'stage_status', stage_id: 'S2' },
        project.root,
      );
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.args.operation).toBe('stage_status');
        expect(parsed.args.stageId).toBe('S2');
        expect(parsed.args.projectRoot).toBe(project.root);
      }
    } finally {
      project.cleanup();
    }
  });

  it('exposes exactly the canonical operation closed set', () => {
    expect(REVIEW_OPERATIONS).toEqual([
      'stage_status',
      'prepare_stage_review',
      'finalize_stage_review',
    ]);
    expect(REJECTED_REVIEW_OPERATIONS).toEqual([
      'prepare_project_review',
      'finalize_project_review',
      'project_status',
      'run_gate',
      'admit_gate_result',
      'admit_gate_interrupted',
      'stage_plan',
      'admit_stage_plan',
      'compile_acceptance',
      'run_e2e',
    ]);
    expect(REVIEW_TOOL_NAME).toBe('proofloop_review');
  });
});
