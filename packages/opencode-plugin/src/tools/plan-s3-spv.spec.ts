/**
 * @proofloop/opencode-plugin — proofloop_plan S3-C status/SPV operation
 * contract spec (S03-C-T01).
 *
 * PO: PO-S03-C-01 (status/admit_spv_result dispatch from the REAL host seam;
 * stage_plan/gate/project/unknown rejection; closed SPV_PASS gate; unknown
 * host fields never reach the runtime request), PO-S03-C-04 (no-write/abort
 * partial: rejections/unsupported/abort add NO receipts; a successful SPV
 * admit writes exactly one SPV_PASS receipt through the runtime pipeline).
 *
 * S03-C-T01 extends the S03-A plan boundary into the S3-C contract:
 *
 *   - operation set: `validate` | `compile` | `initialize_evidence` |
 *     `status` | `admit_spv_result`; `stage_plan`, `admit_stage_plan`,
 *     gate/project operations and ANY unknown value are rejected through REAL
 *     execute with a canonical RUNTIME.SCHEMA_MISMATCH Finding (ok:false, no
 *     dispatch, no write — S3 NEVER exposes a hidden `stage_plan` /
 *     `admit_stage_plan` operation; the SPV fixture uses a PERSISTED legal
 *     STAGE_PLAN fact created in TEST setup via the runtime `admitStagePlan`
 *     method, never a hidden tool operation).
 *   - args shape: `operation` enum of the 5 S3 ops, `stage_id` (required for
 *     status/admit_spv_result, canonical `/^S\d+$/`), `manifest_digest`
 *     (admit_spv_result, 64-hex binding), `summary` (admit_spv_result,
 *     optional non-empty), `verdict` (admit_spv_result, closed `SPV_PASS`
 *     wire gate — NEVER passed into the runtime request), plus the S03-A
 *     path fields. Operation-dependent requiredness is enforced in execute's
 *     fail-closed second validation (`parsePlanArgs`).
 *   - status dispatch: reuses the S2 `reconcileStage` status projection
 *     (`runPlanStatus`) — read-only, no Receipt refs.
 *   - admit_spv_result dispatch: closed SPV_PASS adapter → runtime
 *     `admitSpvResult` IN-PROCESS (`runPlanSpvAdmit`) — the runtime request
 *     is `{ type: 'spv_result', stageId, manifestDigest, summary }` only; a
 *     valid PLANNING stage writes one SPV_PASS Receipt to `plan/<stage>/`
 *     and returns the canonical AdmitResult projection.
 *   - cancellation: pre-aborted → AbortError (no write); abort after
 *     completion → AbortError (never ok PASS).
 *   - no-write: rejections/unsupported/abort branches leave
 *     `.proofloop/receipts/**` byte-identical; a successful SPV admit writes
 *     exactly one SPV_PASS receipt through the runtime pipeline.
 *
 * The PRIMARY seam is the REAL built `createPlanTool` factory + REAL
 * `execute(args, ToolContext)` host `{ output }` envelope against a real
 * temp git worktree with real receipts.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { admitStagePlan, manifestFileDigest, reconcileStage } from '@proofloop/runtime';
import type { Manifest } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { successResult } from '../tool-result.js';
import {
  PLAN_OPERATIONS,
  PLAN_REJECTED_OPERATIONS,
  PLAN_TOOL_ARGS_FALLBACK,
  createPlanTool,
} from './plan.js';
import type { PlanOperationHandlers, PlanToolArgsShape } from './plan.js';

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

function makeWorktree(prefix = 's03c-t01-'): { root: string } {
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

function gitInit(root: string): void {
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03c@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03C Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
}

function commitAll(root: string, message = 'fixture'): void {
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
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
    sessionID: 'sess-s03c-t01',
    messageID: 'msg-s03c-t01',
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

/** Kernel-valid single-slice S03 manifest (canonical slice id / evidence). */
function stageManifest(): Manifest {
  return {
    stage_id: 'S03',
    source_path: 'delivery/stages/S03/tasks.md',
    source_digest: 'a'.repeat(64),
    stage_goal: 'Test stage goal paragraph.',
    outcomes: ['OUT-01: first outcome'],
    slices: [
      {
        slice_id: 'S03-C',
        goal: 'Slice C goal.',
        observable_outcome: 'Slice C observable outcome.',
        public_seam: 'Seam C.',
        dependencies: [],
        proof_obligations: [
          {
            po_id: 'PO-S03-C-01',
            behavior: 'SPV/status through the plan seam.',
            public_seam: 'Seam C.',
            oracle_source: 'fixture oracle.',
            success_criteria: 'SPV writes a chain-valid SPV_PASS receipt.',
            required_observation: 'observe receipt + reconcile.',
            applicable_risk_facts: ['persistent_state', 'core_state_machine'],
          },
        ],
        tasks: ['S03-C-T01'],
        risk_facts: ['persistent_state: true'],
        evidence_path: 'delivery/stages/S03/evidence/S03-C.md',
        cv_minimum_level: 'enhanced',
      },
    ],
    dependencies: [],
    risk_facts: ['public_api_change: true'],
  };
}

/** Minimal matching tasks.md at the runtime default path. */
function writeTasksMd(root: string): void {
  const p = path.join(root, 'delivery', 'stages', 'S03', 'tasks.md');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(
    p,
    `# Stage S03 — Test Stage

## Slice S03-C

<!-- SLICE:S03-C:BEGIN -->

### Tasks

- [ ] S03-C-T01: task one

<!-- SLICE:S03-C:END -->
`,
    'utf-8',
  );
}

/** Evidence skeleton at the manifest evidence_path. */
function writeEvidence(root: string): void {
  const p = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-C.md');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, '# Slice S03-C Evidence\n', 'utf-8');
}

/** Write the kernel-valid manifest at the runtime default path. */
function writeManifest(root: string): string {
  const p = path.join(root, '.proofloop', 'manifests', 'S03.json');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(stageManifest(), null, 2), 'utf-8');
  return p;
}

/**
 * Seed a legal PLANNING stage: git repo + manifest + tasks + evidence +
 * a PERSISTED STAGE_PLAN fact created in TEST setup through the runtime
 * `admitStagePlan` method (S3 NEVER exposes a hidden `stage_plan` tool
 * operation). Returns the canonical manifest digest binding.
 */
function seedPlanningStage(): { root: string; manifestDigest: string } {
  const { root } = makeWorktree('s03c-t01-plan-');
  gitInit(root);
  writeManifest(root);
  writeTasksMd(root);
  writeEvidence(root);
  commitAll(root, 'planning fixture');
  const manifestDigest = manifestFileDigest({ projectRoot: root, stageId: 'S03' });
  const plan = admitStagePlan(
    { type: 'stage_plan', stageId: 'S03', manifestDigest },
    { projectRoot: root },
  );
  expect(plan.accepted).toBe(true);
  return { root, manifestDigest };
}

/** Seed an UNINITIALIZED stage (manifest only, no STAGE_PLAN fact). */
function seedUnplannedStage(): { root: string; manifestDigest: string } {
  const { root } = makeWorktree('s03c-t01-unplanned-');
  gitInit(root);
  writeManifest(root);
  writeTasksMd(root);
  writeEvidence(root);
  commitAll(root, 'unplanned fixture');
  const manifestDigest = manifestFileDigest({ projectRoot: root, stageId: 'S03' });
  return { root, manifestDigest };
}

/** Digest map of every persisted receipt (relative path → sha256). */
function receiptState(root: string): Record<string, string> {
  const dir = path.join(root, '.proofloop', 'receipts');
  if (!existsSync(dir)) return {};
  const map: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        map[path.relative(root, abs)] = createHash('sha256')
          .update(readFileSync(abs))
          .digest('hex');
      }
    }
  };
  walk(dir);
  return map;
}

function expectReceiptStateUnchanged(
  before: Record<string, string>,
  root: string,
): void {
  expect(receiptState(root)).toEqual(before);
}

/** Read the plan/<stage>/ receipts as [{ type, digest, previous_digest }]. */
function planReceipts(root: string): Array<{
  type: string;
  digest: string;
  previous_digest?: string;
}> {
  const dir = path.join(root, '.proofloop', 'receipts', 'plan', 'S03');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) =>
      JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as {
        type: string;
        digest: string;
        previous_digest?: string;
      },
    );
}

/** Extract the canonical `Data:` payload from the execute host output. */
function extractDataLine(output: string): Record<string, unknown> {
  const match = output.match(/^Data: (.+)$/m);
  expect(match).toBeTruthy();
  return JSON.parse(match?.[1] ?? '') as Record<string, unknown>;
}

// ============================================================
// Operation set / args shape (PO-S03-C-01)
// ============================================================

describe('S3-C operation set and args shape (PO-S03-C-01)', () => {
  it('promotes status/admit_spv_result to legal operations and keeps stage_plan/gate/project rejected', () => {
    expect(PLAN_OPERATIONS).toEqual([
      'validate',
      'compile',
      'initialize_evidence',
      'status',
      'admit_spv_result',
    ]);
    expect(PLAN_REJECTED_OPERATIONS).not.toContain('status');
    expect(PLAN_REJECTED_OPERATIONS).not.toContain('admit_spv_result');
    expect(PLAN_REJECTED_OPERATIONS).toEqual(
      expect.arrayContaining([
        'stage_plan',
        'admit_stage_plan',
        'run_gate',
        'admit_gate_result',
        'admit_gate_interrupted',
        'compile_acceptance',
        'run_e2e',
        'prepare_project_review',
        'finalize_project_review',
      ]),
    );
  });

  it('registers the host args with the S3-C input fields', () => {
    const { root } = makeWorktree();
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
    expect(PLAN_TOOL_ARGS_FALLBACK.verdict.values).toEqual(['SPV_PASS']);
  });
});

// ============================================================
// status dispatch (PO-S03-C-01 / PO-S03-C-03 partial)
// ============================================================

describe('status dispatch through real execute (PO-S03-C-01)', () => {
  it('returns the reconcile-derived status projection for a PLANNING stage (read-only)', async () => {
    const { root } = seedPlanningStage();
    const before = receiptState(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'status', stage_id: 'S03' },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Operation: status');
    expect(envelope.output).toContain('Status: ok');
    expect(envelope.output).toContain('Stage status:');
    expect(envelope.output).toContain('State: PLANNING');

    const data = extractDataLine(envelope.output);
    expect(data.stage_id).toBe('S03');
    expect(data.stage_state).toBe('PLANNING');
    expect(data.receipt_chain_valid).toBe(true);
    expect(Array.isArray(data.slices)).toBe(true);
    expect((data.slices as unknown[]).length).toBe(1);

    // status is read-only: no Receipt/runtime mutation.
    expectReceiptStateUnchanged(before, root);
    expect(existsSync(path.join(root, '.proofloop', 'runtime'))).toBe(false);
  });

  it('rejects status without stage_id with a canonical Finding (no runtime read)', async () => {
    const { root } = seedPlanningStage();
    const before = receiptState(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'status' },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expectReceiptStateUnchanged(before, root);
  });

  it.each(['../S03', 'S03/../evil', 'S03-A', 'S03 '])(
    'rejects a non-canonical stage_id %j fail-closed',
    async (stageId) => {
      const { root } = seedPlanningStage();
      const before = receiptState(root);
      const tool = makeTool(makeContext(root));

      const envelope = await tool.execute(
        { operation: 'status', stage_id: stageId },
        makeToolContext(root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expectReceiptStateUnchanged(before, root);
    },
  );

  it('rejects a project_root mismatch with HOST.PROJECT_NOT_TRUSTED', async () => {
    const { root } = seedPlanningStage();
    const other = makeWorktree();
    const before = receiptState(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'status', stage_id: 'S03', project_root: other.root },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
    expect(envelope.output).toContain('Status: failed');
    expectReceiptStateUnchanged(before, root);
  });
});

// ============================================================
// admit_spv_result dispatch (PO-S03-C-01 / PO-S03-C-02 partial)
// ============================================================

describe('admit_spv_result dispatch through real execute (PO-S03-C-01)', () => {
  it('accepts a legal PLANNING stage: writes exactly one SPV_PASS Receipt via the runtime pipeline and returns the canonical AdmitResult', async () => {
    const { root, manifestDigest } = seedPlanningStage();
    const before = receiptState(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      {
        operation: 'admit_spv_result',
        stage_id: 'S03',
        manifest_digest: manifestDigest,
        verdict: 'SPV_PASS',
        summary: 'stage plan approved',
      },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Operation: admit_spv_result');
    expect(envelope.output).toContain('Status: ok');
    expect(envelope.output).toContain('SPV admit result:');
    expect(envelope.output).toContain('Accepted: true');

    const data = extractDataLine(envelope.output);
    expect(data.accepted).toBe(true);
    expect(data.receipt_ref).toMatchObject({
      ref: expect.stringMatching(/^\.proofloop\/receipts\/plan\/S03\/[0-9a-f]{64}\.json$/),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(data.new_state).toMatchObject({ stage_state: 'READY' });
    expect(Array.isArray(data.findings)).toBe(true);

    // Exactly ONE SPV_PASS receipt was added to plan/S03 (STAGE_PLAN + SPV_PASS).
    const receipts = planReceipts(root);
    expect(receipts).toHaveLength(2);
    const spv = receipts.filter((r) => r.type === 'SPV_PASS');
    expect(spv).toHaveLength(1);
    expect(spv[0].previous_digest).toBe(
      receipts.find((r) => r.type === 'STAGE_PLAN')?.digest,
    );

    // Chain valid + fresh reconcile reflects the persisted SPV fact. The
    // AdmitResult new_state carries the reducer-advanced READY state; a FRESH
    // reconcile derives EXECUTING because READY folds into EXECUTING when the
    // (non-integrated) slice carries no integration evidence yet (stage-state
    // READY folding rule — the SPV_PASS fact is the persisted signal).
    const planDir = path.join(root, '.proofloop', 'receipts', 'plan', 'S03');
    const read = JSON.parse(
      readFileSync(path.join(planDir, spv[0].digest + '.json'), 'utf-8'),
    ) as { type: string; payload: { status?: unknown } };
    expect(read.type).toBe('SPV_PASS');
    expect(read.payload.status).toBe('approved');
    const reconciled = reconcileStage({ projectRoot: root, stageId: 'S03' });
    expect(reconciled.stage_state).toBe('EXECUTING');
    expect(reconciled.receipt_chain_valid).toBe(true);

    // The write is exactly one SPV_PASS receipt — every other receipt
    // (including the STAGE_PLAN fixture fact) is byte-identical.
    const after = receiptState(root);
    const newKeys = Object.keys(after).filter((k) => !(k in before));
    expect(newKeys).toHaveLength(1);
    expect(newKeys[0]).toMatch(/receipts\/plan\/S03\/[0-9a-f]{64}\.json$/);
  });

  it('rejects a duplicate SPV admit (stage already READY) fail-closed with no new Receipt', async () => {
    const { root, manifestDigest } = seedPlanningStage();
    const tool = makeTool(makeContext(root));
    const first = await tool.execute(
      {
        operation: 'admit_spv_result',
        stage_id: 'S03',
        manifest_digest: manifestDigest,
        verdict: 'SPV_PASS',
        summary: 'first approve',
      },
      makeToolContext(root),
    );
    expect(first.output).toContain('Status: ok');
    const before = receiptState(root);

    const second = await tool.execute(
      {
        operation: 'admit_spv_result',
        stage_id: 'S03',
        manifest_digest: manifestDigest,
        verdict: 'SPV_PASS',
        summary: 'duplicate approve',
      },
      makeToolContext(root),
    );
    expect(second.output).toContain('Status: failed');
    expect(second.output).toContain('DOMAIN.INVALID_TRANSITION');
    expectReceiptStateUnchanged(before, root);
  });

  it('rejects a wrong-stage admit (UNINITIALIZED, no STAGE_PLAN) fail-closed with no Receipt', async () => {
    const { root, manifestDigest } = seedUnplannedStage();
    const before = receiptState(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      {
        operation: 'admit_spv_result',
        stage_id: 'S03',
        manifest_digest: manifestDigest,
        verdict: 'SPV_PASS',
        summary: 'approve unplanned',
      },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('DOMAIN.INVALID_TRANSITION');
    const data = extractDataLine(envelope.output);
    expect(data.accepted).toBe(false);
    expect(data.receipt_ref).toBeNull();
    expectReceiptStateUnchanged(before, root);
  });

  it('rejects a manifest_digest binding mismatch (valid hex, wrong digest) with no Receipt', async () => {
    const { root } = seedPlanningStage();
    const before = receiptState(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      {
        operation: 'admit_spv_result',
        stage_id: 'S03',
        manifest_digest: 'b'.repeat(64),
        verdict: 'SPV_PASS',
        summary: 'approve wrong digest',
      },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('DOMAIN.INVALID_TRANSITION');
    expectReceiptStateUnchanged(before, root);
  });

  it.each([undefined, 'PLANNED', 'PASS', 'SPV_PASS_EXTRA'])(
    'rejects a non-SPV_PASS verdict (%j) fail-closed with no runtime request',
    async (verdict) => {
      const { root, manifestDigest } = seedPlanningStage();
      const before = receiptState(root);
      const tool = makeTool(makeContext(root));

      const envelope = await tool.execute(
        {
          operation: 'admit_spv_result',
          stage_id: 'S03',
          manifest_digest: manifestDigest,
          ...(verdict !== undefined ? { verdict } : {}),
          summary: 'approve',
        },
        makeToolContext(root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expectReceiptStateUnchanged(before, root);
    },
  );

  it('rejects a non-64-hex manifest_digest fail-closed before any runtime call', async () => {
    const { root } = seedPlanningStage();
    const before = receiptState(root);
    const tool = makeTool(makeContext(root));

    for (const bad of ['abc', 'G'.repeat(64), 'b'.repeat(63), '']) {
      const envelope = await tool.execute(
        {
          operation: 'admit_spv_result',
          stage_id: 'S03',
          manifest_digest: bad,
          verdict: 'SPV_PASS',
          summary: 'approve',
        },
        makeToolContext(root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
    }
    expectReceiptStateUnchanged(before, root);
  });

  it('rejects a non-canonical stage_id fail-closed before any runtime call', async () => {
    const { root, manifestDigest } = seedPlanningStage();
    const before = receiptState(root);
    const tool = makeTool(makeContext(root));

    for (const bad of ['../S03', 'S03-A', 'S3/', 'S03 ']) {
      const envelope = await tool.execute(
        {
          operation: 'admit_spv_result',
          stage_id: bad,
          manifest_digest: manifestDigest,
          verdict: 'SPV_PASS',
          summary: 'approve',
        },
        makeToolContext(root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
    }
    expectReceiptStateUnchanged(before, root);
  });

  it('rejects an empty summary fail-closed', async () => {
    const { root, manifestDigest } = seedPlanningStage();
    const before = receiptState(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      {
        operation: 'admit_spv_result',
        stage_id: 'S03',
        manifest_digest: manifestDigest,
        verdict: 'SPV_PASS',
        summary: '',
      },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expectReceiptStateUnchanged(before, root);
  });

  it('rejects a project_root mismatch with HOST.PROJECT_NOT_TRUSTED and no Receipt', async () => {
    const { root, manifestDigest } = seedPlanningStage();
    const other = makeWorktree();
    const before = receiptState(root);
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      {
        operation: 'admit_spv_result',
        stage_id: 'S03',
        manifest_digest: manifestDigest,
        verdict: 'SPV_PASS',
        summary: 'approve',
        project_root: other.root,
      },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
    expect(envelope.output).toContain('Status: failed');
    expectReceiptStateUnchanged(before, root);
  });
});

// ============================================================
// Rejected operations through REAL execute (PO-S03-C-01 / PO-S03-C-04)
// ============================================================

describe('rejected operations through real execute (PO-S03-C-01)', () => {
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
      const { root, manifestDigest } = seedPlanningStage();
      const before = receiptState(root);
      const tool = makeTool(makeContext(root));

      const envelope = await tool.execute(
        {
          operation,
          stage_id: 'S03',
          manifest_digest: manifestDigest,
          verdict: 'SPV_PASS',
          summary: 'approve',
        },
        makeToolContext(root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain(`Operation: ${operation}`);
      expect(envelope.output).toContain('Status: failed');
      // No dispatch, no write: the stage stays PLANNING and no receipt changed.
      expectReceiptStateUnchanged(before, root);
      expect(
        reconcileStage({ projectRoot: root, stageId: 'S03' }).stage_state,
      ).toBe('PLANNING');
    },
  );
});

// ============================================================
// Cancellation boundary (PO-S03-C-04)
// ============================================================

describe('cancellation boundary (PO-S03-C-04)', () => {
  it('propagates a pre-aborted caller as AbortError and writes nothing', async () => {
    const { root, manifestDigest } = seedPlanningStage();
    const before = receiptState(root);
    const controller = new AbortController();
    controller.abort();
    const tool = makeTool(makeContext(root));

    let thrown: unknown;
    try {
      await tool.execute(
        {
          operation: 'admit_spv_result',
          stage_id: 'S03',
          manifest_digest: manifestDigest,
          verdict: 'SPV_PASS',
          summary: 'approve',
        },
        makeToolContext(root, controller.signal),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe('AbortError');
    expectReceiptStateUnchanged(before, root);
  });

  it('propagates AbortError when the caller aborts after status handler completion (never ok PASS)', async () => {
    const { root } = seedPlanningStage();
    const controller = new AbortController();
    const tool = makeTool(makeContext(root), {
      status: () => {
        controller.abort();
        return successResult({
          data: { stage_id: 'S03', stage_state: 'PLANNING', slices: [] },
        });
      },
    });

    let thrown: unknown;
    try {
      await tool.execute(
        { operation: 'status', stage_id: 'S03' },
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
// S03-A regression (PO-S03-C-01 keep the S2/S03-A operations)
// ============================================================

describe('S03-A regression through the extended tool (PO-S03-C-01)', () => {
  it('validate still returns the canonical { valid, stage_id, errors } payload', async () => {
    const { root } = makeWorktree();
    const tasksPath = path.join(root, 'tasks.md');
    writeFileSync(
      tasksPath,
      `# Stage S03 — Test Stage

## Stage Goal

Test stage goal paragraph.

## Observable Outcomes

- OUT-01: first outcome

## Slice S03-C — Slice C

<!-- SLICE:S03-C:BEGIN -->

### Goal

Slice C goal.

### Observable Outcome

Slice C observable outcome.

### Public Seam

Seam C.

### Risk Facts

- persistent_state: true

### Tasks

- [ ] S03-C-T01: task one

<!-- SLICE:S03-C:END -->
`,
      'utf-8',
    );
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(stageManifest(), null, 2), 'utf-8');
    const tool = makeTool(makeContext(root));

    const envelope = await tool.execute(
      { operation: 'validate', tasks_path: tasksPath, manifest_path: manifestPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Operation: validate');
    expect(envelope.output).toContain('Status: ok');
    expect(extractDataLine(envelope.output)).toEqual({
      valid: true,
      stage_id: 'S03',
      errors: [],
    });
  });
});
