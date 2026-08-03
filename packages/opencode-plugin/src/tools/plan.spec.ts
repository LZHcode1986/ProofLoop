/**
 * @proofloop/opencode-plugin — proofloop_plan host tool definition spec
 * (S02-B-T02, extended by S03-A-T01).
 *
 * PO: PO-S02-B-01 (host tool execute + operation contract + path rejection),
 * PO-S02-B-03 (ToolResult honesty), PO-S02-B-04 (no-write); S03-A-T01
 * extends the operation contract to compile / initialize_evidence.
 *
 * S03-A-T01 extends the real `proofloop_plan` host tool definition through
 * `createPlanTool`:
 *
 *   - host `tool({ description, args, execute })` structure (field name
 *     `args`, NOT `inputSchema`) carrying the canonical S3 plan inputs:
 *     `operation` (`validate` | `compile` | `initialize_evidence` | `status` |
 *     `admit_spv_result`), optional `tasks_path`, optional `manifest_path`,
 *     optional `project_root` (canonical-root consistency assertion), optional
 *     `evidence_dir`, `stage_id` (status/admit_spv_result), `manifest_digest`
 *     (admit_spv_result), `summary` (admit_spv_result) and `verdict`
 *     (admit_spv_result, closed SPV_PASS gate).
 *   - operation contract: the five S3 operations dispatch to their canonical
 *     branches; `stage_plan`, `admit_stage_plan`, gate/project operations and
 *     unknown values fail closed with a canonical Finding
 *     (RUNTIME.SCHEMA_MISMATCH) at the execute boundary and NEVER reach a
 *     dispatch/write branch.
 *   - validate dispatch: `runPlanValidate(canonicalRoot, rawArgs)` consumes
 *     the runtime `validateStage` library IN-PROCESS (no CLI subprocess, no
 *     parser copy); the unified ToolResult error boundary (`toErrorResult`)
 *     wraps every dispatch; caller abort propagates AbortError (never a clean
 *     PASS).
 *   - path boundary: out-of-bounds paths → HOST.PATH_OUTSIDE_PROJECT; missing
 *     required fields → RUNTIME.SCHEMA_MISMATCH (fail-closed, T01 seam);
 *     `project_root` mismatch → HOST.PROJECT_NOT_TRUSTED.
 *   - no-write: validate is read-only; success/failure/unsupported calls never
 *     create or modify artifacts (only `.proofloop/logs/**` may appear).
 *
 * The tool is NOT registered in the plugin Hooks (S02-D owns the registration
 * gate); `createPlanTool` is the exported factory seam.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { PLAN_TOOL_NAME, PLAN_TOOL_ARGS_FALLBACK, createPlanTool } from './plan.js';
import type { PlanToolArgsShape } from './plan.js';

/** Canonical S3-rejected plan operations (tech-spec §1.1 — never dispatch). */
const S3_REJECTED_PLAN_OPERATIONS = [
  'stage_plan',
  'admit_stage_plan',
  'run_gate',
  'admit_gate_result',
  'admit_gate_interrupted',
  'compile_acceptance',
  'run_e2e',
  'prepare_project_review',
  'finalize_project_review',
] as const;

/** Real temp worktree fixture (canonical trust root). */
function makeWorktree(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 's02b-t02-'));
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
    sessionID: 'sess-s02b-t02',
    messageID: 'msg-s02b-t02',
    agent: 'planner',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

/** Narrow execute return to the `{ output }` host envelope. */
type PlanExecuteTool = {
  description: string;
  args: PlanToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
};

function makeTool(context: RuntimeContext): PlanExecuteTool {
  return createPlanTool(context) as PlanExecuteTool;
}

/** Minimal valid S2 tasks.md (compiles through the shared compile seam). */
function validTasksMd(): string {
  return `# Stage S2 — Test Stage

## Stage Goal

Test stage goal paragraph.

## Observable Outcomes

- OUT-01: first outcome

## Dependencies

- No external stage blocking dependency.

## Stage Risk Facts

- public_api_change: true

## Slice S02-A — Slice A

<!-- SLICE:S02-A:BEGIN -->

### Goal

Slice A goal.

### Observable Outcome

Slice A observable outcome.

### Public Seam

Seam A.

### Dependencies

- 无内部依赖。

### Risk Facts

- core_state_machine: true

### Proof Obligations

- PO-S02-A-01
  - Behavior: Slice A behavior.
  - Public Seam: Seam A.
  - Oracle Source: oracle A.
  - Success / Failure: success when X; failure when Y.
  - Required Observation: observe X.

### Tasks

- [ ] S02-A-T01: task one

<!-- SLICE:S02-A:END -->
`;
}

/** Minimal valid S2 manifest matching validTasksMd(). */
function validManifest(): Record<string, unknown> {
  return {
    stage_id: 'S2',
    source_path: 'delivery/stages/S2/tasks.md',
    source_digest: 'a'.repeat(64),
    stage_goal: 'Test stage goal paragraph.',
    outcomes: ['OUT-01: first outcome'],
    slices: [
      {
        slice_id: 'S02-A',
        goal: 'Slice A goal.',
        observable_outcome: 'Slice A observable outcome.',
        public_seam: 'Seam A.',
        dependencies: [],
        proof_obligations: [
          {
            po_id: 'PO-S02-A-01',
            behavior: 'Slice A behavior.',
            public_seam: 'Seam A.',
            oracle_source: 'oracle A.',
            success_criteria: 'success when X; failure when Y.',
            required_observation: 'observe X.',
            applicable_risk_facts: [],
          },
        ],
        tasks: ['S02-A-T01'],
        risk_facts: ['core_state_machine: true'],
        evidence_path: 'delivery/stages/S2/evidence/S02-A.md',
        cv_minimum_level: 'enhanced',
      },
    ],
    dependencies: [],
    risk_facts: ['public_api_change: true'],
  };
}

/** Write a valid fixture project (tasks + manifest) into the worktree. */
function writeValidProject(root: string): { tasksPath: string; manifestPath: string } {
  const tasksPath = path.join(root, 'tasks.md');
  const manifestPath = path.join(root, 'manifest.json');
  writeFileSync(tasksPath, validTasksMd(), 'utf-8');
  writeFileSync(manifestPath, JSON.stringify(validManifest(), null, 2), 'utf-8');
  return { tasksPath, manifestPath };
}

describe('plan tool definition shape (PO-S02-B-01)', () => {
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

  it('declares the canonical S3 plan inputs in the args shape', () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      expect(Object.keys(tool.args).sort()).toEqual([
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
      expect(PLAN_TOOL_NAME).toBe('proofloop_plan');
    } finally {
      project.cleanup();
    }
  });

  it('keeps the structural descriptor ONLY as a documented reference shape (never the registered args)', () => {
    // S2-F-002 fail-closed: the structural descriptor is retained as the
    // documented reference shape but is NEVER used as the registered `args`
    // when the vendored zod is absent — the factory throws instead.
    const fallback = PLAN_TOOL_ARGS_FALLBACK;
    expect(Object.keys(fallback).sort()).toEqual([
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
    expect(fallback.operation.type).toBe('enum');
    expect(fallback.operation.values).toEqual([
      'validate',
      'compile',
      'initialize_evidence',
      'status',
      'admit_spv_result',
    ]);
    // S3 operation-dependent requiredness is enforced in execute's fail-closed
    // second validation, never by the host schema alone — so every path field
    // is structurally optional in the args shape.
    expect(fallback.tasks_path.optional).toBe(true);
    expect(fallback.manifest_path.optional).toBe(true);
    expect(fallback.project_root.optional).toBe(true);
    expect(fallback.evidence_dir.optional).toBe(true);
    expect(fallback.stage_id.optional).toBe(true);
    expect(fallback.manifest_digest.optional).toBe(true);
    expect(fallback.summary.optional).toBe(true);
    expect(fallback.verdict.optional).toBe(true);
  });

  it('fails closed when the vendored zod is unavailable (S2-F-002: no structural fallback registration)', () => {
    const project = makeWorktree();
    try {
      // The injectable zod loader is the S2-F-002 test seam: a loader that
      // returns undefined simulates the vendored-zod-unavailable path. The
      // factory must THROW instead of registering the unverified descriptor.
      expect(() =>
        createPlanTool(makeContext(project.root), undefined, () => undefined),
      ).toThrow(/vendored zod runtime is unavailable/);
    } finally {
      project.cleanup();
    }
  });
});

describe('operation contract (PO-S02-B-01 / PO-S02-B-03)', () => {
  it('validates a real valid fixture through the host execute and reports ok', async () => {
    const project = makeWorktree();
    try {
      const { tasksPath, manifestPath } = writeValidProject(project.root);
      const tool = makeTool(makeContext(project.root));
      const envelope = await tool.execute(
        { operation: 'validate', tasks_path: tasksPath, manifest_path: manifestPath },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('ProofLoop Plan');
      expect(envelope.output).toContain('Operation: validate');
      expect(envelope.output).toContain('Status: ok');
      expect(envelope.output).toContain('Valid: true');
      expect(envelope.output).toContain('Findings: none');
    } finally {
      project.cleanup();
    }
  });

  it('reports invalid fixtures fail-closed with canonical findings', async () => {
    const project = makeWorktree();
    try {
      const { tasksPath, manifestPath } = writeValidProject(project.root);
      const bad = validTasksMd().replace('<!-- SLICE:S02-A:END -->', '');
      writeFileSync(tasksPath, bad, 'utf-8');
      const tool = makeTool(makeContext(project.root));
      const envelope = await tool.execute(
        { operation: 'validate', tasks_path: tasksPath, manifest_path: manifestPath },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('ProofLoop Plan');
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    } finally {
      project.cleanup();
    }
  });

  it('rejects every S3-rejected plan operation with a canonical Finding', async () => {
    const project = makeWorktree();
    try {
      const { tasksPath, manifestPath } = writeValidProject(project.root);
      const tool = makeTool(makeContext(project.root));
      for (const op of S3_REJECTED_PLAN_OPERATIONS) {
        const envelope = await tool.execute(
          { operation: op, tasks_path: tasksPath, manifest_path: manifestPath },
          makeToolContext(project.root),
        );
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
        expect(envelope.output).toContain(`Operation: ${op}`);
        expect(envelope.output).toContain('Status: failed');
      }
    } finally {
      project.cleanup();
    }
  });

  it('rejects an unknown operation value fail-closed', async () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      const envelope = await tool.execute(
        { operation: 'frobnicate', tasks_path: 'tasks.md', manifest_path: 'manifest.json' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
    } finally {
      project.cleanup();
    }
  });
});

describe('path boundary via host execute (PO-S02-B-01)', () => {
  it('rejects an absolute tasks_path outside the trust root with HOST.PATH_OUTSIDE_PROJECT', async () => {
    const project = makeWorktree();
    try {
      const outside = path.join(tmpdir(), `s02b-t02-outside-${Date.now()}.md`);
      writeFileSync(outside, validTasksMd(), 'utf-8');
      const tool = makeTool(makeContext(project.root));
      try {
        const envelope = await tool.execute(
          { operation: 'validate', tasks_path: outside, manifest_path: 'manifest.json' },
          makeToolContext(project.root),
        );
        expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
        expect(envelope.output).toContain('Status: failed');
      } finally {
        rmSync(outside, { force: true });
      }
    } finally {
      project.cleanup();
    }
  });

  it('rejects a missing required tasks_path with RUNTIME.SCHEMA_MISMATCH', async () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      const envelope = await tool.execute(
        { operation: 'validate', manifest_path: 'manifest.json' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
    } finally {
      project.cleanup();
    }
  });

  it('rejects a missing required manifest_path with RUNTIME.SCHEMA_MISMATCH', async () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      const envelope = await tool.execute(
        { operation: 'validate', tasks_path: 'tasks.md' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
    } finally {
      project.cleanup();
    }
  });
});

describe('cancellation and error boundary (PO-S02-B-03)', () => {
  it('propagates caller abort as AbortError, never a clean PASS', async () => {
    const project = makeWorktree();
    try {
      const controller = new AbortController();
      controller.abort();
      const tool = makeTool(makeContext(project.root));
      let thrown: unknown;
      try {
        await tool.execute(
          { operation: 'validate', tasks_path: 'tasks.md', manifest_path: 'manifest.json' },
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

  it('never leaks a bare exception into the host envelope (fail-closed boundary)', async () => {
    const project = makeWorktree();
    try {
      const tool = makeTool(makeContext(project.root));
      // Missing tasks file: validateStage returns a FILE_ERROR result — the
      // envelope carries a canonical Finding, never a thrown raw error.
      const envelope = await tool.execute(
        { operation: 'validate', tasks_path: 'missing-tasks.md', manifest_path: 'manifest.json' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('ProofLoop Plan');
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    } finally {
      project.cleanup();
    }
  });
});
