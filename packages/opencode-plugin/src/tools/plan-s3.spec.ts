/**
 * @proofloop/opencode-plugin — proofloop_plan S3 operation contract spec
 * (S03-A-T01).
 *
 * PO: PO-S03-A-01 (operation/args/path acceptance through the REAL host
 * execute seam), PO-S03-A-04 (no-write partial: invalid / unsupported / path
 * violation / abort branches never write Receipt/runtime-state; validate stays
 * read-only and keeps the canonical `{ valid, stage_id, errors }` parity).
 *
 * S03-A-T01 extends the S2 `validate`-only plan tool into the S3 operation
 * contract:
 *
 *   - operation set: `validate` | `compile` | `initialize_evidence` |
 *     `status` | `admit_spv_result`; `stage_plan`, `admit_stage_plan`,
 *     gate/project operations and ANY unknown value are rejected through REAL
 *     execute with a canonical RUNTIME.SCHEMA_MISMATCH Finding (ok:false, no
 *     dispatch, no write). (S03-C-T01 promotes `status` / `admit_spv_result`
 *     to legal operations; the S03-A rejection matrix keeps the remaining
 *     rejected values — `stage_plan`/`admit_stage_plan`/gate/project/unknown.)
 *   - args shape: `operation` enum of the 5 S3 ops, `tasks_path`,
 *     `manifest_path`, `project_root` (optional consistency assertion), the
 *     S2 `evidence_dir` (optional), `stage_id`, `manifest_digest`, `summary`
 *     and `verdict` (closed SPV_PASS gate). Operation-dependent requiredness
 *     is enforced in execute's fail-closed second validation
 *     (`parsePlanArgs`), never by the host schema alone.
 *   - compile: `runPlanCompile` consumes the runtime `compileManifest` library
 *     IN-PROCESS and writes the kernel-valid Manifest to a root-bound path;
 *     invalid tasks / path violations fail closed with NO manifest write.
 *   - initialize_evidence: `runPlanInitialize` consumes the runtime
 *     `initializeSliceEvidence` library with the canonical trust root as the
 *     delivery root; non-empty evidence files are never overwritten.
 *   - path/trust-root/TOCTOU boundary: out-of-root → HOST.PATH_OUTSIDE_PROJECT
 *     (including symlink escapes); `project_root` mismatch →
 *     HOST.PROJECT_NOT_TRUSTED; TOCTOU identity re-verify before read/write.
 *   - cancellation: pre-aborted → AbortError (no write); abort after
 *     completion → AbortError (never ok PASS).
 *   - no-write: `.proofloop/receipts/**` and `.proofloop/runtime/**` are never
 *     created or mutated by any plan call.
 *
 * The PRIMARY seam is the REAL built `createPlanTool` factory + REAL
 * `execute(args, ToolContext)` host `{ output }` envelope; the contract-layer
 * functions are used only for refs assertions and path-boundary cases.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalManifestDigest,
  compileManifest,
  initializeSliceEvidence,
} from '@proofloop/runtime';
import type { Manifest } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { successResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import {
  PLAN_OPERATIONS,
  PLAN_TOOL_ARGS_FALLBACK,
  createPlanTool,
} from './plan.js';
import type { PlanOperationHandlers, PlanToolArgsShape } from './plan.js';
import { runPlanCompile } from './plan-compile.js';
import { runPlanInitialize } from './plan-initialize.js';

// ============================================================
// Fixture helpers
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function makeWorktree(prefix = 's03a-t01-'): { root: string } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  cleanups.push(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  return { root };
}

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

function makeToolContext(
  root: string,
  abort: AbortSignal = new AbortController().signal,
): ToolContext {
  return {
    sessionID: 'sess-s03a-t01',
    messageID: 'msg-s03a-t01',
    agent: 'planner',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

type PlanExecuteTool = {
  description: string;
  args: PlanToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
};

function makeTool(
  context: RuntimeContext,
  handlers?: PlanOperationHandlers,
): PlanExecuteTool {
  return createPlanTool(context, handlers) as PlanExecuteTool;
}

/** Acyclic 2-slice S03 stage (mirrors the runtime CLI fixtures). */
function validTasksMd(): string {
  return `# Stage S03 — Test Stage

## Stage Goal

Test stage goal paragraph.

## Observable Outcomes

- OUT-01: first outcome

## Dependencies

- No external stage blocking dependency.

## Stage Risk Facts

- public_api_change: true

## Slice S03-A — Slice A

<!-- SLICE:S03-A:BEGIN -->

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

- PO-S03-A-01
  - Behavior: Slice A behavior.
  - Public Seam: Seam A.
  - Oracle Source: oracle A.
  - Success / Failure: success when X; failure when Y.
  - Required Observation: observe X.

### Tasks

- [ ] S03-A-T01: task one

<!-- SLICE:S03-A:END -->

## Slice S03-B — Slice B

<!-- SLICE:S03-B:BEGIN -->

### Goal

Slice B goal.

### Observable Outcome

Slice B observable outcome.

### Public Seam

Seam B.

### Dependencies

- S03-A

### Risk Facts

- persistent_state: true

### Proof Obligations

- PO-S03-B-01
  - Behavior: Slice B behavior.
  - Public Seam: Seam B.
  - Oracle Source: oracle B.
  - Success / Failure: success when Z.
  - Required Observation: observe Z.

### Tasks

- [ ] S03-B-T01: task one
- [x] S03-B-T02: task two

<!-- SLICE:S03-B:END -->
`;
}

function compiledManifest(): Manifest {
  return {
    stage_id: 'S03',
    source_path: 'delivery/stages/S03/tasks.md',
    source_digest: 'a'.repeat(64),
    stage_goal: 'Test stage goal paragraph.',
    outcomes: ['OUT-01: first outcome'],
    slices: [
      {
        slice_id: 'S03-A',
        goal: 'Slice A goal.',
        observable_outcome: 'Slice A observable outcome.',
        public_seam: 'Seam A.',
        dependencies: [],
        proof_obligations: [
          {
            po_id: 'PO-S03-A-01',
            behavior: 'Slice A behavior.',
            public_seam: 'Seam A.',
            oracle_source: 'oracle A.',
            success_criteria: 'success when X; failure when Y.',
            required_observation: 'observe X.',
            applicable_risk_facts: [],
          },
        ],
        tasks: ['S03-A-T01'],
        risk_facts: ['core_state_machine: true'],
        evidence_path: 'delivery/stages/S03/evidence/S03-A.md',
        cv_minimum_level: 'enhanced',
      },
      {
        slice_id: 'S03-B',
        goal: 'Slice B goal.',
        observable_outcome: 'Slice B observable outcome.',
        public_seam: 'Seam B.',
        dependencies: ['S03-A'],
        proof_obligations: [
          {
            po_id: 'PO-S03-B-01',
            behavior: 'Slice B behavior.',
            public_seam: 'Seam B.',
            oracle_source: 'oracle B.',
            success_criteria: 'success when Z.',
            required_observation: 'observe Z.',
            applicable_risk_facts: [],
          },
        ],
        tasks: ['S03-B-T01', 'S03-B-T02'],
        risk_facts: ['persistent_state: true'],
        evidence_path: 'delivery/stages/S03/evidence/S03-B.md',
        cv_minimum_level: 'standard',
      },
    ],
    dependencies: [],
    risk_facts: ['public_api_change: true'],
  };
}

/** Write the valid tasks fixture at `<root>/tasks.md`. */
function writeTasks(root: string): string {
  const tasksPath = path.join(root, 'tasks.md');
  writeFileSync(tasksPath, validTasksMd(), 'utf-8');
  return tasksPath;
}

/** Write the matching compiled manifest at `<root>/manifest.json`. */
function writeManifest(root: string, manifest: Manifest = compiledManifest()): string {
  const manifestPath = path.join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return manifestPath;
}

/** Default canonical compile output path under the root. */
function manifestOutputPath(root: string): string {
  return path.join(root, '.proofloop', 'manifests', 'S03.json');
}

/** sha256 over a file's bytes for byte-identity assertions. */
function fileDigest(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** Snapshot protected paths that must never change across plan calls. */
function protectedSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const candidates = [
    path.join(root, '.proofloop', 'receipts'),
    path.join(root, '.proofloop', 'runtime'),
    path.join(root, 'tasks.md'),
    path.join(root, 'manifest.json'),
    path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-A.md'),
    path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-B.md'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      snapshot[candidate] = fs.statSync(candidate).isDirectory()
        ? 'dir:' + JSON.stringify(fs.readdirSync(candidate).sort())
        : 'file:' + fileDigest(candidate);
    }
  }
  return snapshot;
}

/** Assert no protected Receipt/runtime-state artifact exists in the worktree. */
function expectNoReceiptOrRuntime(root: string): void {
  expect(existsSync(path.join(root, '.proofloop', 'receipts'))).toBe(false);
  expect(existsSync(path.join(root, '.proofloop', 'runtime'))).toBe(false);
}

/** Assert the protected snapshot is byte-identical after a call. */
function expectProtectedUnchanged(
  before: Record<string, string>,
  root: string,
): void {
  const after = protectedSnapshot(root);
  for (const [rel, digest] of Object.entries(before)) {
    expect(after[rel], `protected path changed: ${rel}`).toBe(digest);
  }
}

/** Extract the canonical `Data:` payload from the execute host output. */
function extractDataLine(output: string): Record<string, unknown> {
  const match = output.match(/^Data: (.+)$/m);
  expect(match).toBeTruthy();
  return JSON.parse(match?.[1] ?? '') as Record<string, unknown>;
}

// ============================================================
// Runtime public seam — compile/initialize library re-exports
// ============================================================

describe('runtime public seam (PO-S03-A-01/02/03)', () => {
  it('re-exports compileManifest and initializeSliceEvidence from @proofloop/runtime', () => {
    expect(typeof compileManifest).toBe('function');
    expect(typeof initializeSliceEvidence).toBe('function');
  });

  it('compiles the valid S03 fixture into a kernel-valid Manifest in-process', () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const manifest = compileManifest(tasksPath);
    expect(manifest.stage_id).toBe('S03');
    expect(manifest.slices.map((s) => s.slice_id)).toEqual(['S03-A', 'S03-B']);
    expect(manifest.source_digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================
// Args shape / operation set (PO-S03-A-01)
// ============================================================

describe('S3 args shape and operation set (PO-S03-A-01 / PO-S03-C-01)', () => {
  it('declares the 5-operation closed set and the canonical input fields', () => {
    expect(PLAN_OPERATIONS).toEqual([
      'validate',
      'compile',
      'initialize_evidence',
      'status',
      'admit_spv_result',
    ]);
    const { root } = makeWorktree();
    try {
      const tool = makeTool(makeContext(root));
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
      expect(
        (tool.args.operation as { options?: readonly string[] }).options,
      ).toEqual([
        'validate',
        'compile',
        'initialize_evidence',
        'status',
        'admit_spv_result',
      ]);
    } finally {
      // cleanup handled by afterEach
    }
  });

  it('keeps the structural descriptor in sync (documented reference only)', () => {
    expect(PLAN_TOOL_ARGS_FALLBACK.operation.values).toEqual([
      'validate',
      'compile',
      'initialize_evidence',
      'status',
      'admit_spv_result',
    ]);
    expect(PLAN_TOOL_ARGS_FALLBACK.project_root.optional).toBe(true);
    expect(PLAN_TOOL_ARGS_FALLBACK.tasks_path.optional).toBe(true);
    expect(PLAN_TOOL_ARGS_FALLBACK.manifest_path.optional).toBe(true);
    expect(PLAN_TOOL_ARGS_FALLBACK.stage_id.optional).toBe(true);
    expect(PLAN_TOOL_ARGS_FALLBACK.manifest_digest.optional).toBe(true);
    expect(PLAN_TOOL_ARGS_FALLBACK.summary.optional).toBe(true);
    expect(PLAN_TOOL_ARGS_FALLBACK.verdict.optional).toBe(true);
    expect(PLAN_TOOL_ARGS_FALLBACK.verdict.values).toEqual(['SPV_PASS']);
  });
});

// ============================================================
// validate regression through the extended tool (PO-S03-A-01/04)
// ============================================================

describe('validate regression through the extended tool (PO-S03-A-01/04)', () => {
  it('validates a valid fixture with the canonical { valid, stage_id, errors } payload', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const manifestPath = writeManifest(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'validate', tasks_path: tasksPath, manifest_path: manifestPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('ProofLoop Plan');
    expect(envelope.output).toContain('Operation: validate');
    expect(envelope.output).toContain('Status: ok');
    expect(envelope.output).toContain('Valid: true');
    expect(envelope.output).toContain('Findings: none');
    expect(extractDataLine(envelope.output)).toEqual({
      valid: true,
      stage_id: 'S03',
      errors: [],
    });
  });

  it('reports an invalid fixture fail-closed with canonical findings (read-only)', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const manifestPath = writeManifest(root);
    writeFileSync(
      tasksPath,
      validTasksMd().replace('<!-- SLICE:S03-A:END -->', ''),
      'utf-8',
    );
    const before = protectedSnapshot(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'validate', tasks_path: tasksPath, manifest_path: manifestPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(extractDataLine(envelope.output)).toMatchObject({ valid: false, stage_id: 'S03' });
    expectProtectedUnchanged(before, root);
    expectNoReceiptOrRuntime(root);
  });

  it('rejects a missing required tasks_path for validate with RUNTIME.SCHEMA_MISMATCH', async () => {
    const { root } = makeWorktree();
    const tool = makeTool(makeContext(root));
    const envelope = await tool.execute(
      { operation: 'validate', manifest_path: 'manifest.json' },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expectNoReceiptOrRuntime(root);
  });
});

// ============================================================
// compile dispatch (PO-S03-A-01 / PO-S03-A-04 partial)
// ============================================================

describe('compile dispatch through real execute (PO-S03-A-01)', () => {
  it('compiles a valid fixture, writes the kernel-valid Manifest and returns canonical stage/digest/ref data', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const outputPath = manifestOutputPath(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      {
        operation: 'compile',
        tasks_path: tasksPath,
        manifest_path: outputPath,
      },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Operation: compile');
    expect(envelope.output).toContain('Status: ok');
    expect(envelope.output).toContain('Compile result:');
    expect(envelope.output).toContain('Stage: S03');

    // The Manifest was actually written at the root-bound output path and is
    // kernel-valid (parses, stage_id matches, slices intact).
    expect(existsSync(outputPath)).toBe(true);
    const written = JSON.parse(readFileSync(outputPath, 'utf-8')) as Manifest;
    expect(written.stage_id).toBe('S03');
    expect(written.slices.map((s) => s.slice_id)).toEqual(['S03-A', 'S03-B']);

    // The canonical Data payload carries traceable stage/digest/ref; the
    // manifest digest equals the canonical content digest of the written file
    // (identical to the runtime manifestFileDigest seam), and the ref is the
    // ROOT-BOUND RELATIVE artifact path.
    const data = extractDataLine(envelope.output);
    expect(data.stage_id).toBe('S03');
    expect(data.source_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(data.manifest_digest).toBe(canonicalManifestDigest(written));
    expect(data.manifest_ref).toBe(path.relative(root, outputPath));

    // compile is a Manifest owner write — no Receipt/runtime-state artifacts.
    expectNoReceiptOrRuntime(root);
  });

  it('fails closed on an invalid tasks fixture and never writes a Manifest', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    writeFileSync(
      tasksPath,
      validTasksMd().replace('<!-- SLICE:S03-A:END -->', ''),
      'utf-8',
    );
    const outputPath = manifestOutputPath(root);
    const before = protectedSnapshot(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: outputPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(existsSync(outputPath)).toBe(false);
    expectProtectedUnchanged(before, root);
    expectNoReceiptOrRuntime(root);
  });

  it('rejects a missing tasks_path for compile fail-closed', async () => {
    const { root } = makeWorktree();
    const tool = makeTool(makeContext(root));
    const envelope = await tool.execute(
      { operation: 'compile', manifest_path: 'manifest.json' },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expectNoReceiptOrRuntime(root);
  });

  it('rejects a missing manifest_path for compile fail-closed', async () => {
    const { root } = makeWorktree();
    const tool = makeTool(makeContext(root));
    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: 'tasks.md' },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expectNoReceiptOrRuntime(root);
  });

  it('rejects an out-of-root tasks_path for compile with HOST.PATH_OUTSIDE_PROJECT', async () => {
    const { root } = makeWorktree();
    const outside = path.join(tmpdir(), `s03a-t01-outside-${Date.now()}.md`);
    writeFileSync(outside, validTasksMd(), 'utf-8');
    const outputPath = manifestOutputPath(root);
    const tool = makeTool(makeContext(root));
    try {
      const envelope = await tool.execute(
        { operation: 'compile', tasks_path: outside, manifest_path: outputPath },
        makeToolContext(root),
      );
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(envelope.output).toContain('Status: failed');
      expect(existsSync(outputPath)).toBe(false);
      expectNoReceiptOrRuntime(root);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('rejects an out-of-root manifest_path for compile with HOST.PATH_OUTSIDE_PROJECT', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const outside = path.join(tmpdir(), `s03a-t01-outside-${Date.now()}.json`);
    const tool = makeTool(makeContext(root));
    try {
      const envelope = await tool.execute(
        { operation: 'compile', tasks_path: tasksPath, manifest_path: outside },
        makeToolContext(root),
      );
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(envelope.output).toContain('Status: failed');
      expect(existsSync(outside)).toBe(false);
      expectNoReceiptOrRuntime(root);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('rejects a symlink-escape tasks_path for compile with HOST.PATH_OUTSIDE_PROJECT', async () => {
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-t01-outside-link-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    symlinkSync(outside, path.join(root, 'link'));
    writeFileSync(path.join(outside, 'tasks.md'), validTasksMd(), 'utf-8');
    const outputPath = manifestOutputPath(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: path.join('link', 'tasks.md'), manifest_path: outputPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    expect(envelope.output).toContain('Status: failed');
    expect(existsSync(outputPath)).toBe(false);
    expectNoReceiptOrRuntime(root);
  });

  it('rejects a project_root mismatch for compile with HOST.PROJECT_NOT_TRUSTED', async () => {
    const { root } = makeWorktree();
    const other = makeWorktree();
    const tasksPath = writeTasks(root);
    const outputPath = manifestOutputPath(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      {
        operation: 'compile',
        tasks_path: tasksPath,
        manifest_path: outputPath,
        project_root: other.root,
      },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
    expect(envelope.output).toContain('Status: failed');
    expect(existsSync(outputPath)).toBe(false);
    expectNoReceiptOrRuntime(root);
  });

  it('keeps ToolResult refs empty (compile produces no Receipt refs)', () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const outputPath = manifestOutputPath(root);
    const result = runPlanCompile(root, {
      operation: 'compile',
      tasks_path: tasksPath,
      manifest_path: outputPath,
    });
    expect(result.ok).toBe(true);
    expect(result.refs).toEqual([]);
    expect(existsSync(outputPath)).toBe(true);
  });
});

// ============================================================
// initialize_evidence dispatch (PO-S03-A-01 / PO-S03-A-04 partial)
// ============================================================

describe('initialize_evidence dispatch through real execute (PO-S03-A-01)', () => {
  /** Compile a manifest at the canonical output path, then return it. */
  async function compileManifestFor(root: string): Promise<string> {
    const tasksPath = writeTasks(root);
    const outputPath = manifestOutputPath(root);
    const tool = makeTool(makeContext(root));
    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: outputPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: ok');
    expect(existsSync(outputPath)).toBe(true);
    return outputPath;
  }

  it('creates Evidence skeletons for every declared slice and returns { created, skipped, errors }', async () => {
    const { root } = makeWorktree();
    const manifestPath = await compileManifestFor(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Operation: initialize_evidence');
    expect(envelope.output).toContain('Status: ok');
    expect(envelope.output).toContain('Created: 2');

    const data = extractDataLine(envelope.output);
    expect(data.created).toHaveLength(2);
    expect(data.skipped).toEqual([]);
    expect(data.errors).toEqual([]);

    const evidenceA = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-A.md');
    const evidenceB = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-B.md');
    expect(existsSync(evidenceA)).toBe(true);
    expect(existsSync(evidenceB)).toBe(true);
    expect(readFileSync(evidenceA, 'utf-8')).toContain('# Slice S03-A Evidence');

    // initialize_evidence is an Evidence owner write — no Receipt/runtime-state.
    expectNoReceiptOrRuntime(root);
  });

  it('skips existing non-empty Evidence files and never overwrites them', async () => {
    const { root } = makeWorktree();
    const manifestPath = await compileManifestFor(root);
    const evidenceA = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-A.md');
    mkdirSync(path.dirname(evidenceA), { recursive: true });
    const original = '# Slice S03-A Evidence\n\n## Task Evidence\n\n### S03-A-T01\n\n- Status: COMPLETE\n';
    writeFileSync(evidenceA, original, 'utf-8');
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: ok');
    const data = extractDataLine(envelope.output);
    expect((data.created as string[]).length).toBe(1);
    expect((data.skipped as string[]).length).toBe(1);
    expect(data.errors).toEqual([]);
    // The non-empty file bytes are untouched (no overwrite).
    expect(readFileSync(evidenceA, 'utf-8')).toBe(original);
  });

  it('rejects a missing manifest_path for initialize_evidence fail-closed', async () => {
    const { root } = makeWorktree();
    const tool = makeTool(makeContext(root));
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', project_root: root },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expectNoReceiptOrRuntime(root);
  });

  it('rejects a project_root mismatch for initialize_evidence with HOST.PROJECT_NOT_TRUSTED', async () => {
    const { root } = makeWorktree();
    const other = makeWorktree();
    const manifestPath = writeManifest(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      {
        operation: 'initialize_evidence',
        manifest_path: manifestPath,
        project_root: other.root,
      },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
    expect(envelope.output).toContain('Status: failed');
    expectNoReceiptOrRuntime(root);
  });

  it('rejects a schema-invalid manifest fail-closed with no evidence write', async () => {
    const { root } = makeWorktree();
    const manifestPath = path.join(root, 'bad-manifest.json');
    writeFileSync(manifestPath, '{"stage_id": 42}', 'utf-8');
    const before = protectedSnapshot(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expect(existsSync(path.join(root, 'delivery'))).toBe(false);
    expectProtectedUnchanged(before, root);
    expectNoReceiptOrRuntime(root);
  });

  it('rejects an out-of-root manifest_path for initialize_evidence with HOST.PATH_OUTSIDE_PROJECT', async () => {
    const { root } = makeWorktree();
    const outside = path.join(tmpdir(), `s03a-t01-outside-${Date.now()}.json`);
    writeFileSync(outside, JSON.stringify(compiledManifest(), null, 2), 'utf-8');
    const tool = makeTool(makeContext(root));
    try {
      const envelope = await tool.execute(
        { operation: 'initialize_evidence', manifest_path: outside },
        makeToolContext(root),
      );
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(envelope.output).toContain('Status: failed');
      expect(existsSync(path.join(root, 'delivery'))).toBe(false);
      expectNoReceiptOrRuntime(root);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('keeps ToolResult refs empty (initialize_evidence produces no Receipt refs)', () => {
    const { root } = makeWorktree();
    const manifestPath = writeManifest(root);
    const result = runPlanInitialize(root, {
      operation: 'initialize_evidence',
      manifest_path: manifestPath,
    });
    expect(result.ok).toBe(true);
    expect(result.refs).toEqual([]);
  });

  it('rejects a symlinked evidence PARENT directory (outside root) BEFORE any write (PO-S03-A-03 repair)', () => {
    // CV S03-A|PO-S03-A-03|EVIDENCE_PARENT_SYMLINK_ESCAPE: the runtime
    // initializer's canonicalEvidenceDir/resolvedPath checks are lexical, so a
    // symlinked `delivery/stages/S03` parent pointing OUTSIDE the root would
    // pass them and mkdir/write would follow the symlink. The plugin boundary
    // must reject BEFORE any mkdir/write and never create anything through the
    // symlink.
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-repair-outside-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    const manifestPath = writeManifest(root);
    mkdirSync(path.join(root, 'delivery', 'stages'), { recursive: true });
    symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03'));

    const result = runPlanInitialize(root, {
      operation: 'initialize_evidence',
      manifest_path: manifestPath,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
    // Nothing was written outside the root through the symlinked parent.
    expect(fs.readdirSync(outside)).toEqual([]);
    // No evidence skeleton was created through the symlink.
    expect(existsSync(path.join(outside, 'evidence'))).toBe(false);
    expectNoReceiptOrRuntime(root);
  });

  it('rejects an in-root symlink redirect of an evidence parent directory (identity) (PO-S03-A-03 repair)', () => {
    // Consistent with the S2 TOCTOU identity semantics: a parent symlink that
    // redirects to a DIFFERENT inside-root canonical path is rejected — the
    // runtime would otherwise write through the redirect to the alternate path.
    const { root } = makeWorktree();
    const manifestPath = writeManifest(root);
    mkdirSync(path.join(root, 'delivery', 'stages'), { recursive: true });
    const altTarget = path.join(root, 'alt-evidence-target');
    mkdirSync(altTarget, { recursive: true });
    symlinkSync(altTarget, path.join(root, 'delivery', 'stages', 'S03'));

    const result = runPlanInitialize(root, {
      operation: 'initialize_evidence',
      manifest_path: manifestPath,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
    // Nothing was written to the redirect target through the symlink.
    expect(fs.readdirSync(altTarget)).toEqual([]);
    expectNoReceiptOrRuntime(root);
  });

  it('post-write re-verify + rollback catches an OUTSIDE parent swap injected between the pre-check and the runtime write (diagnose TOCTOU race)', () => {
    // CV recheck (5b7a0dcb): the static pre-check passes (real parent), then a
    // concurrent swap replaces the parent with an outside symlink BEFORE the
    // runtime initializer runs. The documented test-only `beforeInitialize`
    // seam deterministically simulates that race. The post-write re-verify
    // must detect the escape, roll back the skeleton this run created through
    // the symlink, and fail closed with HOST.PATH_OUTSIDE_PROJECT.
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-diagnose-outside-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    const manifestPath = writeManifest(root);
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });

    let swapped = false;
    const result = runPlanInitialize(
      root,
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      {
        beforeInitialize: () => {
          rmSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
          symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03'));
          swapped = true;
        },
      },
    );
    expect(swapped).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
    // The skeleton written through the outside symlink was rolled back — no
    // outside file or evidence dir remains.
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(existsSync(path.join(outside, 'evidence'))).toBe(false);
    expectNoReceiptOrRuntime(root);
  });

  it('post-write re-verify + rollback catches an IN-ROOT parent redirect swap injected between the pre-check and the write (diagnose)', () => {
    const { root } = makeWorktree();
    const manifestPath = writeManifest(root);
    const alt = path.join(root, 'alt-target');
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });
    mkdirSync(alt, { recursive: true });

    const result = runPlanInitialize(
      root,
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      {
        beforeInitialize: () => {
          rmSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
          symlinkSync(alt, path.join(root, 'delivery', 'stages', 'S03'));
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
    // The redirect target received nothing that survives the rollback.
    const altEvidence = path.join(alt, 'evidence');
    if (existsSync(altEvidence)) {
      expect(fs.readdirSync(altEvidence)).toEqual([]);
    }
    expectNoReceiptOrRuntime(root);
  });
});

// ============================================================
// Rejected operations through REAL execute (PO-S03-A-01/04)
// ============================================================

describe('rejected operations through real execute (PO-S03-A-01/04 / PO-S03-C-01)', () => {
  const REJECTED = [
    'stage_plan',
    'admit_stage_plan',
    'run_gate',
    'admit_gate_result',
    'admit_gate_interrupted',
    'compile_acceptance',
    'run_e2e',
    'prepare_project_review',
    'finalize_project_review',
    'unknown-op',
  ] as const;

  it.each(REJECTED)(
    'rejects operation %s with a canonical RUNTIME.SCHEMA_MISMATCH Finding, no dispatch, no write',
    async (operation) => {
      const { root } = makeWorktree();
      const tasksPath = writeTasks(root);
      const manifestPath = writeManifest(root);
      const outputPath = manifestOutputPath(root);
      const before = protectedSnapshot(root);
      const tool = makeTool(makeContext(root));

      const envelope = await tool.execute(
        { operation, tasks_path: tasksPath, manifest_path: manifestPath },
        makeToolContext(root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain(`Operation: ${operation}`);
      expect(envelope.output).toContain('Status: failed');
      // No dispatch, no write: no manifest published, no evidence/receipt/runtime-state.
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(path.join(root, 'delivery'))).toBe(false);
      expectProtectedUnchanged(before, root);
      expectNoReceiptOrRuntime(root);
    },
  );

  it('rejects a missing operation with a canonical Finding', async () => {
    const { root } = makeWorktree();
    const tool = makeTool(makeContext(root));
    const envelope = await tool.execute(
      { tasks_path: 'tasks.md', manifest_path: 'manifest.json' } as Record<string, unknown>,
      makeToolContext(root),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expectNoReceiptOrRuntime(root);
  });
});

// ============================================================
// Cancellation boundary (PO-S03-A-04)
// ============================================================

describe('cancellation boundary (PO-S03-A-04)', () => {
  it('propagates a pre-aborted caller as AbortError and writes nothing', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const outputPath = manifestOutputPath(root);
    const controller = new AbortController();
    controller.abort();
    const tool = makeTool(makeContext(root));

    let thrown: unknown;
    try {
      await tool.execute(
        { operation: 'compile', tasks_path: tasksPath, manifest_path: outputPath },
        makeToolContext(root, controller.signal),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe('AbortError');
    expect(existsSync(outputPath)).toBe(false);
    expectNoReceiptOrRuntime(root);
  });

  it('propagates AbortError when the caller aborts after handler completion (never ok PASS)', async () => {
    const { root } = makeWorktree();
    const controller = new AbortController();
    const tool = makeTool(makeContext(root), {
      validate: () => {
        controller.abort();
        return successResult({ data: { valid: true, stage_id: 'S03', errors: [] } });
      },
    });

    let thrown: unknown;
    try {
      await tool.execute(
        { operation: 'validate', tasks_path: 'tasks.md', manifest_path: 'manifest.json' },
        makeToolContext(root, controller.signal),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe('AbortError');
  });
});

// ============================================================
// No-write / validate read-only regression (PO-S03-A-04)
// ============================================================

describe('no-write and validate read-only regression (PO-S03-A-04)', () => {
  it('validate stays read-only: protected artifacts byte-identical, only logs may appear', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const manifestPath = writeManifest(root);
    const before = protectedSnapshot(root);
    const tool = makeTool(makeContext(root));

    await tool.execute(
      { operation: 'validate', tasks_path: tasksPath, manifest_path: manifestPath },
      makeToolContext(root),
    );
    expectProtectedUnchanged(before, root);
    expectNoReceiptOrRuntime(root);
  });

  it('compile failure / rejection / abort leave Receipt and state byte-absent', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    writeFileSync(
      tasksPath,
      validTasksMd().replace('<!-- SLICE:S03-A:END -->', ''),
      'utf-8',
    );
    const outputPath = manifestOutputPath(root);
    const tool = makeTool(makeContext(root));

    // Failure (invalid tasks).
    await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: outputPath },
      makeToolContext(root),
    );
    expect(existsSync(outputPath)).toBe(false);
    expectNoReceiptOrRuntime(root);

    // Rejected operation.
    await tool.execute(
      { operation: 'run_gate', tasks_path: tasksPath, manifest_path: outputPath },
      makeToolContext(root),
    );
    expect(existsSync(outputPath)).toBe(false);
    expectNoReceiptOrRuntime(root);

    // Abort (pre-aborted caller).
    const controller = new AbortController();
    controller.abort();
    try {
      await tool.execute(
        { operation: 'compile', tasks_path: tasksPath, manifest_path: outputPath },
        makeToolContext(root, controller.signal),
      );
    } catch (error) {
      expect((error as Error).name).toBe('AbortError');
    }
    expect(existsSync(outputPath)).toBe(false);
    expectNoReceiptOrRuntime(root);
  });

  it('compile success publishes ONLY the Manifest artifact (never Receipt/runtime-state)', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const outputPath = manifestOutputPath(root);
    const tool = makeTool(makeContext(root));

    await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: outputPath },
      makeToolContext(root),
    );
    expect(existsSync(outputPath)).toBe(true);
    expectNoReceiptOrRuntime(root);
  });
});
