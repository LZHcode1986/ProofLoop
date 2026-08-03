/**
 * @proofloop/opencode-plugin — proofloop_stage S3 admission contract spec
 * (S03-B-T01).
 *
 * PO: PO-S03-B-01 (primary — four admit operations accepted through the REAL
 * host execute seam, mapped to the canonical runtime AdmissionRequest union;
 * outer/inner binding, identifier charset, path-valued field guard and
 * canonical worktree validation; unsupported run_gate/gate/project/unknown
 * never reach a dispatch/write branch), PO-S03-B-04 (no-write partial:
 * rejection / unsupported / abort branches never add Receipts; a successful
 * admit legitimately persists through the runtime pipeline).
 *
 * S03-B-T01 extends the S2 `proofloop_stage` tool into the S3 admission
 * contract:
 *
 *   - operation set: `status` | `next` (S2 regression) PLUS the four admit
 *     operations `admit_worker_result` | `admit_cv_result` |
 *     `admit_slice_commit` | `admit_integration`. `run_gate`,
 *     `admit_gate_result`, `admit_gate_interrupted`, `stage_plan`,
 *     `admit_stage_plan`, `compile_acceptance`, `run_e2e`,
 *     `prepare_project_review`, `finalize_project_review` and ANY unknown
 *     value are rejected through REAL execute with a canonical
 *     RUNTIME.SCHEMA_MISMATCH Finding (ok:false, no dispatch, no write).
 *   - host args shape: the vendored-zod raw-shape (`args`, NOT `inputSchema`)
 *     is extended with `slice_id` and the operation-dependent wire fields
 *     (`envelope`, `verdict`, `snapshot_digest`, `summary`, `commit_sha`,
 *     `cv_receipt_digest`, `integration_ref`). Operation-dependent
 *     requiredness is enforced in execute's fail-closed second validation
 *     (never the host schema alone).
 *   - single adapter boundary: `mapHostArgsToAdmissionRequest` maps the host
 *     snake_case wire fields to the canonical runtime camelCase
 *     `AdmissionRequest` members. `worker_result` carries ONLY type+envelope
 *     (the outer stage_id/slice_id are validated as outer binding against
 *     envelope.stageId/sliceId, never passed into the request);
 *     `integration` has NO `integrationRef` member even when the host
 *     supplies `integration_ref` (root-checked host metadata only).
 *   - outer/inner binding + identifier charset: `stage_id` matches
 *     `/^S\d+$/`, `slice_id` matches `/^S\d{2,}-[A-Z]$/`; traversal /
 *     absolute / `..` ids are rejected before any runtime call.
 *   - path-valued guard: envelope.evidenceRef / changedFiles and any
 *     path-like host field must be root-bound (HOST.PATH_OUTSIDE_PROJECT on
 *     escape); caller `project_root` is a consistency assertion only
 *     (mismatch → HOST.PROJECT_NOT_TRUSTED).
 *   - cancellation: pre-aborted → AbortError (no write); abort after
 *     completion → AbortError (never ok PASS).
 *   - no-write: every rejection / unsupported / abort call leaves
 *     `.proofloop/receipts/**` byte-identical; a SUCCESS admit legitimately
 *     persists a Receipt through the runtime pipeline (production behavior).
 *
 * The PRIMARY seam is the REAL built `createStageTool` factory + REAL
 * `execute(args, ToolContext)` host `{ output }` envelope; the mapper and
 * contract-layer functions are used for the adapter-boundary and path cases.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertAdmissionRequest,
  validateFinding,
} from '@proofloop/runtime';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { successResult } from '../tool-result.js';
import {
  STAGE_ADMIT_OPERATIONS,
  STAGE_ALL_OPERATIONS,
  STAGE_REJECTED_OPERATIONS,
  CANONICAL_SLICE_ID,
  mapHostArgsToAdmissionRequest,
} from './stage-admit-common.js';
import { createStageTool } from './stage.js';
import type { StageOperationHandlers, StageResolvedArgs, StageToolArgsShape } from './stage.js';

// ============================================================
// Known-good literals (authority excerpts — never derived)
// ============================================================

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-B';
const TASKS: readonly string[] = ['S03-B-T01', 'S03-B-T02', 'S03-B-T03'];
const BASELINE_SHA = 'a'.repeat(40);
const SNAPSHOT_DIGEST = 'b'.repeat(64);

// ============================================================
// Fixture helpers (real temp dir + real git repo + canonical layout)
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

interface StageAdmitFx {
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  write(rel: string, content: string): void;
  writeManifest(): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean): void;
  commitAll(message?: string): string;
  cleanup(): void;
}

function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID): StageAdmitFx {
  const root = mkdtempSync(path.join(tmpdir(), 's03b-t01-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03b@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03B Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });

  const sliceDef = (sid: string, taskIds: readonly string[]): ManifestSlice => ({
    slice_id: sid,
    goal: 'Executor 受理四类 Slice 结果并写入 Receipt',
    observable_outcome: 'deterministic admits with chain-verified receipts',
    public_seam: 'Hooks.tool.proofloop_stage',
    dependencies: [],
    proof_obligations: [
      {
        po_id: 'PO-S03-B-01',
        behavior: 'four admit operations mapped to the runtime AdmissionRequest union',
        public_seam: 'built stage tool execute',
        oracle_source: 'real fixture project',
        success_criteria: 'dispatch + receipt chain valid',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['persistent_state', 'core_state_machine'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/${stageId}/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  });

  const fx: StageAdmitFx = {
    root,
    stageId,
    sliceId,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: () => {
      const manifest: Manifest = {
        stage_id: stageId,
        source_path: `delivery/stages/${stageId}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'S3 admission host boundary',
        outcomes: ['admit four result kinds'],
        slices: [sliceDef(sliceId, TASKS)],
        dependencies: [],
        risk_facts: [],
      };
      fx.write(`.proofloop/manifests/${stageId}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (checkedTasks) => {
      const lines = TASKS.map(
        (t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`,
      );
      const content =
        `# Stage ${stageId} — S3 Admission\n\n` +
        `## Slice ${sliceId}\n` +
        `<!-- SLICE:${sliceId}:BEGIN -->\n\n` +
        `### Tasks\n\n${lines.join('\n')}\n\n` +
        `<!-- SLICE:${sliceId}:END -->\n`;
      fx.write(`delivery/stages/${stageId}/tasks.md`, content);
    },
    writeEvidence: (finalized) => {
      const content =
        `# Slice ${sliceId} Evidence\n\n` +
        `## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n` +
            `### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S03-B-01 | stage-admit.spec.ts | yes | yes | pass |\n\n` +
            `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
          : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| *None* | | | | |\n`);
      fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, content);
    },
    commitAll: (message = 'fixture') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
      return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf-8',
      }).trim();
    },
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/** Baseline fixture: manifest + tasks + finalized evidence, one commit. */
function fxBaseline(): StageAdmitFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  fx.commitAll();
  return fx;
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
    sessionID: 'sess-s03b-t01',
    messageID: 'msg-s03b-t01',
    agent: 'executor',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

type StageExecuteTool = {
  description: string;
  args: StageToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
};

function makeTool(
  context: RuntimeContext,
  handlers?: StageOperationHandlers,
): StageExecuteTool {
  return createStageTool(context, handlers) as StageExecuteTool;
}

// ============================================================
// Envelope / request helpers
// ============================================================

function makeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionToken: 'tok-s03b-t01',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: 'S03-B-T01',
    mode: 'finalize-slice',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    changedFiles: ['packages/opencode-plugin/src/tools/stage.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 't01 worker',
    ...overrides,
  };
}

// ============================================================
// No-write snapshot helper
// ============================================================

/** Recursively snapshot `.proofloop/receipts/**` + `.proofloop/runtime/**`. */
function snapshotProtected(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, base: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        const content = readFileSync(abs);
        map.set(rel, createHash('sha256').update(content).digest('hex'));
      }
    }
  };
  walk(path.join(root, '.proofloop', 'receipts'), '.proofloop/receipts');
  walk(path.join(root, '.proofloop', 'runtime'), '.proofloop/runtime');
  return map;
}

function expectProtectedIdentical(before: Map<string, string>, after: Map<string, string>): void {
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    expect(after.get(key) ?? null, `protected artifact changed: ${key}`).toBe(
      before.get(key) ?? null,
    );
  }
}

function receiptsCount(root: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith('.json')) count += 1;
    }
  };
  walk(path.join(root, '.proofloop', 'receipts'));
  return count;
}

// ============================================================
// Tests
// ============================================================

describe('extended stage args shape (PO-S03-B-01)', () => {
  it('registers the extended host-accepted args with the 6-operation enum', () => {
    const project = makeFx();
    try {
      const tool = makeTool(makeContext(project.root));
      const args = tool.args;
      const operationField = args.operation as { options?: readonly string[] };
      expect(operationField.options).toEqual([...STAGE_ALL_OPERATIONS]);
      for (const key of [
        'operation',
        'stage_id',
        'slice_id',
        'project_root',
        'envelope',
        'verdict',
        'snapshot_digest',
        'commit_sha',
        'cv_receipt_digest',
        'integration_ref',
        'summary',
      ]) {
        expect(args).toHaveProperty(key);
      }
    } finally {
      project.cleanup();
    }
  });

  it('exposes the canonical closed sets', () => {
    expect(STAGE_ALL_OPERATIONS).toEqual([
      'status',
      'next',
      'admit_worker_result',
      'admit_cv_result',
      'admit_slice_commit',
      'admit_integration',
    ]);
    expect(STAGE_ADMIT_OPERATIONS).toEqual([
      'admit_worker_result',
      'admit_cv_result',
      'admit_slice_commit',
      'admit_integration',
    ]);
    expect(STAGE_REJECTED_OPERATIONS).toEqual([
      'run_gate',
      'admit_gate_result',
      'admit_gate_interrupted',
      'stage_plan',
      'admit_stage_plan',
      'compile_acceptance',
      'run_e2e',
      'prepare_project_review',
      'finalize_project_review',
    ]);
    expect(CANONICAL_SLICE_ID.test('S03-B')).toBe(true);
    expect(CANONICAL_SLICE_ID.test('S3')).toBe(false);
  });
});

describe('S2 regression — status/next still work (PO-S03-B-01)', () => {
  it('dispatches status and next to their handler seams through the extended tool', async () => {
    const project = fxBaseline();
    try {
      const status = vi.fn((_input: StageResolvedArgs) =>
        successResult({ data: { op: 'status' } }),
      );
      const next = vi.fn((_input: StageResolvedArgs) =>
        successResult({ data: { op: 'next' } }),
      );
      const tool = makeTool(makeContext(project.root), { status, next });

      const s = await tool.execute(
        { operation: 'status', stage_id: STAGE_ID },
        makeToolContext(project.root),
      );
      expect(s.output).toContain('Status: ok');
      expect(status).toHaveBeenCalledTimes(1);

      const n = await tool.execute(
        { operation: 'next', stage_id: STAGE_ID },
        makeToolContext(project.root),
      );
      expect(n.output).toContain('Status: ok');
      expect(next).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalledTimes(1);
    } finally {
      project.cleanup();
    }
  });

  it('rejects a non-canonical stage_id for status before any runtime call', async () => {
    const project = fxBaseline();
    try {
      const status = vi.fn(() => successResult({ data: { op: 'status' } }));
      const tool = makeTool(makeContext(project.root), { status });
      const envelope = await tool.execute(
        { operation: 'status', stage_id: '../../etc/passwd' },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(status).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });
});

describe('admit operations accepted and dispatched (PO-S03-B-01)', () => {
  it('accepts admit_worker_result with an envelope and dispatches', async () => {
    const project = makeFx();
    try {
      const worker = vi.fn((_input: StageResolvedArgs) =>
        successResult({ data: { op: 'admit_worker_result' } }),
      );
      const tool = makeTool(makeContext(project.root), {
        admit_worker_result: worker,
      });
      const envelope = await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope(),
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('ProofLoop Stage');
      expect(envelope.output).toContain('Status: ok');
      expect(worker).toHaveBeenCalledTimes(1);
      const input = worker.mock.calls[0][0];
      expect(input.stageId).toBe(STAGE_ID);
      expect(input.admit?.sliceId).toBe(SLICE_ID);
    } finally {
      project.cleanup();
    }
  });

  it('accepts admit_cv_result with verdict + snapshot_digest + summary', async () => {
    const project = makeFx();
    try {
      const cv = vi.fn((_input: StageResolvedArgs) =>
        successResult({ data: { op: 'admit_cv_result' } }),
      );
      const tool = makeTool(makeContext(project.root), { admit_cv_result: cv });
      const envelope = await tool.execute(
        {
          operation: 'admit_cv_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          verdict: 'PASS',
          snapshot_digest: SNAPSHOT_DIGEST,
          summary: 'cv pass',
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('Status: ok');
      expect(cv).toHaveBeenCalledTimes(1);
      expect(cv.mock.calls[0][0].admit?.sliceId).toBe(SLICE_ID);
    } finally {
      project.cleanup();
    }
  });

  it('accepts admit_slice_commit with commit_sha + cv_receipt_digest', async () => {
    const project = makeFx();
    try {
      const commit = vi.fn((_input: StageResolvedArgs) =>
        successResult({ data: { op: 'admit_slice_commit' } }),
      );
      const tool = makeTool(makeContext(project.root), { admit_slice_commit: commit });
      const envelope = await tool.execute(
        {
          operation: 'admit_slice_commit',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          commit_sha: BASELINE_SHA,
          cv_receipt_digest: SNAPSHOT_DIGEST,
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('Status: ok');
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      project.cleanup();
    }
  });

  it('accepts admit_integration with commit_sha', async () => {
    const project = makeFx();
    try {
      const integration = vi.fn((_input: StageResolvedArgs) =>
        successResult({ data: { op: 'admit_integration' } }),
      );
      const tool = makeTool(makeContext(project.root), { admit_integration: integration });
      const envelope = await tool.execute(
        {
          operation: 'admit_integration',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          commit_sha: BASELINE_SHA,
          integration_ref: 'reports/integration-s03-b.txt',
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('Status: ok');
      expect(integration).toHaveBeenCalledTimes(1);
    } finally {
      project.cleanup();
    }
  });

  it('rejects missing operation-dependent required fields with no dispatch', async () => {
    const project = makeFx();
    try {
      const handlers: StageOperationHandlers = {
        admit_worker_result: vi.fn(() => successResult({})),
        admit_cv_result: vi.fn(() => successResult({})),
        admit_slice_commit: vi.fn(() => successResult({})),
        admit_integration: vi.fn(() => successResult({})),
      };
      const tool = makeTool(makeContext(project.root), handlers);
      const cases: Array<Record<string, unknown>> = [
        { operation: 'admit_worker_result', stage_id: STAGE_ID, slice_id: SLICE_ID },
        { operation: 'admit_cv_result', stage_id: STAGE_ID, slice_id: SLICE_ID },
        {
          operation: 'admit_cv_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          verdict: 'PASS',
        },
        {
          operation: 'admit_slice_commit',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
        },
        {
          operation: 'admit_slice_commit',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          commit_sha: BASELINE_SHA,
        },
        { operation: 'admit_integration', stage_id: STAGE_ID, slice_id: SLICE_ID },
      ];
      for (const raw of cases) {
        const envelope = await tool.execute(raw, makeToolContext(project.root));
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
        expect(envelope.output).toContain('Status: failed');
      }
      expect(handlers.admit_worker_result).not.toHaveBeenCalled();
      expect(handlers.admit_cv_result).not.toHaveBeenCalled();
      expect(handlers.admit_slice_commit).not.toHaveBeenCalled();
      expect(handlers.admit_integration).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it('rejects a non-object envelope at the boundary with no dispatch', async () => {
    const project = makeFx();
    try {
      const worker = vi.fn(() => successResult({}));
      const tool = makeTool(makeContext(project.root), { admit_worker_result: worker });
      const envelope = await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: 'not-an-envelope',
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(worker).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });
});

describe('unsupported operations fail closed (PO-S03-B-01)', () => {
  it.each([
    ...STAGE_REJECTED_OPERATIONS,
    'admit_spv_result',
    'prepare_stage_review',
    'finalize_stage_review',
    'anything_unknown',
  ])(
    'rejects unsupported operation %s through REAL execute with no dispatch and no write',
    async (operation) => {
      const project = fxBaseline();
      try {
        const handlers: StageOperationHandlers = {
          status: vi.fn(() => successResult({})),
          next: vi.fn(() => successResult({})),
          admit_worker_result: vi.fn(() => successResult({})),
          admit_cv_result: vi.fn(() => successResult({})),
          admit_slice_commit: vi.fn(() => successResult({})),
          admit_integration: vi.fn(() => successResult({})),
        };
        const tool = makeTool(makeContext(project.root), handlers);
        const before = snapshotProtected(project.root);
        const envelope = await tool.execute(
          { operation, stage_id: STAGE_ID, slice_id: SLICE_ID },
          makeToolContext(project.root),
        );
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
        expect(envelope.output).toContain('Status: failed');
        for (const handler of Object.values(handlers)) {
          expect(handler).not.toHaveBeenCalled();
        }
        expectProtectedIdentical(before, snapshotProtected(project.root));
      } finally {
        project.cleanup();
      }
    },
  );
});

describe('outer/inner binding + identifier charset (PO-S03-B-01)', () => {
  it('rejects an envelope whose stageId does not match the outer stage_id', async () => {
    const project = fxBaseline();
    try {
      // Default tool: the mapper runs through the real execute path and
      // rejects the binding BEFORE any runtime call (no Receipt).
      const tool = makeTool(makeContext(project.root));
      const before = snapshotProtected(project.root);
      const envelope = await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope({ stageId: 'S99' }),
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('envelope binding mismatch');
      expectProtectedIdentical(before, snapshotProtected(project.root));
    } finally {
      project.cleanup();
    }
  });

  it('rejects an envelope whose sliceId does not match the outer slice_id', async () => {
    const project = fxBaseline();
    try {
      const tool = makeTool(makeContext(project.root));
      const before = snapshotProtected(project.root);
      const envelope = await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope({ sliceId: 'S03-X' }),
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('envelope binding mismatch');
      expectProtectedIdentical(before, snapshotProtected(project.root));
    } finally {
      project.cleanup();
    }
  });

  it.each([
    'S3',
    'S03-B/../../etc',
    '../../etc/passwd',
    '/etc/passwd',
    'S03-B\\..\\..',
    's03-b',
    '..',
  ])('rejects non-canonical slice_id %s before any runtime call', async (sliceId) => {
    const project = fxBaseline();
    try {
      const handlers: StageOperationHandlers = {
        admit_worker_result: vi.fn(() => successResult({})),
        admit_cv_result: vi.fn(() => successResult({})),
      };
      const tool = makeTool(makeContext(project.root), handlers);
      const before = snapshotProtected(project.root);
      const envelope = await tool.execute(
        {
          operation: 'admit_cv_result',
          stage_id: STAGE_ID,
          slice_id: sliceId,
          verdict: 'PASS',
          snapshot_digest: SNAPSHOT_DIGEST,
          summary: 'cv pass',
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(handlers.admit_cv_result).not.toHaveBeenCalled();
      expectProtectedIdentical(before, snapshotProtected(project.root));
    } finally {
      project.cleanup();
    }
  });
});

describe('path-valued field guard (PO-S03-B-01)', () => {
  it('rejects an envelope evidenceRef outside the trust root (HOST.PATH_OUTSIDE_PROJECT)', async () => {
    const project = fxBaseline();
    try {
      // Default tool: the path guard runs through the real execute path and
      // rejects BEFORE any runtime call (no Receipt).
      const tool = makeTool(makeContext(project.root));
      const before = snapshotProtected(project.root);
      const envelope = await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope({ evidenceRef: path.join(tmpdir(), 'outside.md') }),
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(envelope.output).toContain('Status: failed');
      expectProtectedIdentical(before, snapshotProtected(project.root));
    } finally {
      project.cleanup();
    }
  });

  it('rejects an envelope changedFiles entry outside the trust root', async () => {
    const project = fxBaseline();
    try {
      const tool = makeTool(makeContext(project.root));
      const before = snapshotProtected(project.root);
      const envelope = await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope({ changedFiles: [path.join(tmpdir(), 'evil.ts')] }),
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(envelope.output).toContain('Status: failed');
      expectProtectedIdentical(before, snapshotProtected(project.root));
    } finally {
      project.cleanup();
    }
  });

  it('rejects a symlink-escape evidenceRef (HOST.PATH_OUTSIDE_PROJECT)', async () => {
    const project = fxBaseline();
    try {
      // outside file + in-root symlink pointing at it.
      const outsideDir = mkdtempSync(path.join(tmpdir(), 's03b-out-'));
      const outsideFile = path.join(outsideDir, 'outside.md');
      writeFileSync(outsideFile, 'outside', 'utf-8');
      const linkDir = path.join(project.root, 'delivery', 'stages', STAGE_ID, 'evidence');
      mkdirSync(linkDir, { recursive: true });
      const linkPath = path.join(linkDir, 'escape.md');
      symlinkSync(outsideFile, linkPath);

      const tool = makeTool(makeContext(project.root));
      const before = snapshotProtected(project.root);
      const envelope = await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope({ evidenceRef: `delivery/stages/${STAGE_ID}/evidence/escape.md` }),
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(envelope.output).toContain('Status: failed');
      expectProtectedIdentical(before, snapshotProtected(project.root));
    } finally {
      project.cleanup();
    }
  });

  it('rejects a project_root mismatch with HOST.PROJECT_NOT_TRUSTED', async () => {
    const project = fxBaseline();
    const other = makeFx();
    try {
      const worker = vi.fn(() => successResult({}));
      const tool = makeTool(makeContext(project.root), { admit_worker_result: worker });
      const envelope = await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          project_root: other.root,
          envelope: makeEnvelope(),
        },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
      expect(worker).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
      other.cleanup();
    }
  });
});

describe('cancellation (PO-S03-B-01 / PO-S03-B-04)', () => {
  it('propagates a pre-aborted caller as AbortError with no write', async () => {
    const project = fxBaseline();
    try {
      const controller = new AbortController();
      controller.abort();
      const tool = makeTool(makeContext(project.root), {
        admit_worker_result: vi.fn(() => successResult({})),
      });
      const before = snapshotProtected(project.root);
      let thrown: unknown;
      try {
        await tool.execute(
          {
            operation: 'admit_worker_result',
            stage_id: STAGE_ID,
            slice_id: SLICE_ID,
            envelope: makeEnvelope(),
          },
          makeToolContext(project.root, controller.signal),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as Error).name).toBe('AbortError');
      expectProtectedIdentical(before, snapshotProtected(project.root));
    } finally {
      project.cleanup();
    }
  });

  it('propagates abort-after-completion as AbortError (never a clean PASS)', async () => {
    const project = fxBaseline();
    try {
      const controller = new AbortController();
      const tool = makeTool(makeContext(project.root), {
        admit_worker_result: (input) => {
          // The handler aborts the caller mid-dispatch after completing.
          controller.abort();
          void input;
          return successResult({ data: { op: 'admit_worker_result' } });
        },
      });
      let thrown: unknown;
      try {
        await tool.execute(
          {
            operation: 'admit_worker_result',
            stage_id: STAGE_ID,
            slice_id: SLICE_ID,
            envelope: makeEnvelope(),
          },
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
});

describe('real dispatch — worker result writes a TASK_COMPLETE receipt (PO-S03-B-01 / PO-S03-B-04)', () => {
  it('admits a finalize-slice worker result through the runtime pipeline (production behavior)', async () => {
    const project = fxBaseline();
    try {
      const tool = makeTool(makeContext(project.root));
      const before = snapshotProtected(project.root);
      const beforeCount = receiptsCount(project.root);

      const envelope = await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope(),
        },
        makeToolContext(project.root),
      );

      expect(envelope.output).toContain('ProofLoop Stage');
      expect(envelope.output).toContain('Status: ok');
      // The only intended write: exactly one TASK_COMPLETE receipt in
      // tasks/<stage>/<slice>/.
      const afterCount = receiptsCount(project.root);
      expect(afterCount).toBe(beforeCount + 1);
      const tasksDir = path.join(
        project.root,
        '.proofloop',
        'receipts',
        'tasks',
        STAGE_ID,
        SLICE_ID,
      );
      const receipts = existsSync(tasksDir) ? readdirSync(tasksDir).filter((f) => f.endsWith('.json')) : [];
      expect(receipts).toHaveLength(1);
      const receipt = JSON.parse(readFileSync(path.join(tasksDir, receipts[0]), 'utf-8'));
      expect(receipt.type).toBe('TASK_COMPLETE');
      expect(receipt.stage_id).toBe(STAGE_ID);
      expect(receipt.slice_id).toBe(SLICE_ID);
      // The AdmitResult projection is present in the output (no Receipt body leak).
      expect(envelope.output).toContain('accepted');
    } finally {
      project.cleanup();
    }
  });

  it('refuses a worker result whose slice is not in the manifest (no receipt)', async () => {
    const project = fxBaseline();
    try {
      const tool = makeTool(makeContext(project.root));
      const before = snapshotProtected(project.root);
      const envelope = await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: 'S03-X',
          envelope: makeEnvelope({ sliceId: 'S03-X' }),
        },
        makeToolContext(project.root),
      );
      // The slice is schema-canonical but not declared in the manifest — the
      // runtime pipeline refuses with DOMAIN.STAGE_NOT_FOUND and no receipt.
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('DOMAIN.STAGE_NOT_FOUND');
      expectProtectedIdentical(before, snapshotProtected(project.root));
    } finally {
      project.cleanup();
    }
  });
});

describe('mapper — explicit snake_case → camelCase AdmissionRequest adapter (PO-S03-B-01)', () => {
  it('maps worker_result to { type, envelope } ONLY (outer ids never enter the request)', () => {
    const mapped = mapHostArgsToAdmissionRequest(
      'admit_worker_result',
      {
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        rawArgs: {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope(),
        },
      },
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.request.type).toBe('worker_result');
    if (mapped.request.type !== 'worker_result') return;
    expect(mapped.request.envelope.stageId).toBe(STAGE_ID);
    expect(mapped.request.envelope.sliceId).toBe(SLICE_ID);
    expect(Object.keys(mapped.request)).toEqual(['type', 'envelope']);
    expect(() => assertAdmissionRequest(mapped.request)).not.toThrow();
  });

  it('maps cv_result host fields to the camelCase request', () => {
    const mapped = mapHostArgsToAdmissionRequest(
      'admit_cv_result',
      {
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        rawArgs: {
          verdict: 'PASS',
          snapshot_digest: SNAPSHOT_DIGEST,
          summary: 'cv pass',
        },
      },
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.request).toEqual({
      type: 'cv_result',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      verdict: 'PASS',
      snapshotDigest: SNAPSHOT_DIGEST,
      summary: 'cv pass',
    });
    expect(() => assertAdmissionRequest(mapped.request)).not.toThrow();
  });

  it('maps slice_commit host fields to the camelCase request', () => {
    const mapped = mapHostArgsToAdmissionRequest(
      'admit_slice_commit',
      {
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        rawArgs: {
          commit_sha: BASELINE_SHA,
          cv_receipt_digest: SNAPSHOT_DIGEST,
        },
      },
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.request).toEqual({
      type: 'slice_commit',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      commitSha: BASELINE_SHA,
      cvReceiptDigest: SNAPSHOT_DIGEST,
    });
    expect(() => assertAdmissionRequest(mapped.request)).not.toThrow();
  });

  it('maps integration WITHOUT any integrationRef member even when the host supplies it', () => {
    const mapped = mapHostArgsToAdmissionRequest(
      'admit_integration',
      {
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        rawArgs: {
          commit_sha: BASELINE_SHA,
          integration_ref: 'reports/integration-s03-b.txt',
        },
      },
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.request).toEqual({
      type: 'integration',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      commitSha: BASELINE_SHA,
    });
    expect(Object.keys(mapped.request)).toEqual(['type', 'stageId', 'sliceId', 'commitSha']);
    expect(() => assertAdmissionRequest(mapped.request)).not.toThrow();
  });

  it('rejects an unknown host field set from entering the closed union (worker binding mismatch)', () => {
    const mapped = mapHostArgsToAdmissionRequest(
      'admit_worker_result',
      {
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        rawArgs: {
          envelope: makeEnvelope({ stageId: 'S99' }),
        },
      },
    );
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.result.findings[0]?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });
});

describe('every contract-layer finding is canonical (PO-S03-B-01)', () => {
  it('accepts all fail-closed findings through the kernel validateFinding oracle', async () => {
    const project = fxBaseline();
    try {
      const tool = makeTool(makeContext(project.root));
      const cases: Array<Record<string, unknown>> = [
        { operation: 'run_gate', stage_id: STAGE_ID },
        { operation: 'admit_stage_plan', stage_id: STAGE_ID },
        { operation: 'admit_worker_result', stage_id: STAGE_ID },
        { operation: 'admit_cv_result', stage_id: STAGE_ID, slice_id: SLICE_ID },
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope({ stageId: 'S99' }),
        },
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope({ evidenceRef: path.join(tmpdir(), 'outside.md') }),
        },
        { operation: 'admit_cv_result', stage_id: STAGE_ID, slice_id: 'S03-B/..' },
        { operation: 'status', stage_id: 'S3' },
      ];
      for (const raw of cases) {
        const envelope = await tool.execute(raw, makeToolContext(project.root));
        // Extract every finding line and re-parse it through the kernel oracle.
        const findingLines = envelope.output
          .split('\n')
          .filter((l) => l.startsWith('- ['));
        expect(findingLines.length).toBeGreaterThan(0);
        for (const line of findingLines) {
          const code = line.slice(3).split(']')[0];
          const severity = line.split('] ')[1]?.split(': ')[0];
          expect(() =>
            validateFinding({
              code: code as never,
              severity: severity as 'error',
              message: 'oracle check',
            }),
          ).not.toThrow();
        }
      }
    } finally {
      project.cleanup();
    }
  });
});
