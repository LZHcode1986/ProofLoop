/**
 * @proofloop/opencode-plugin — proofloop_plan S3-C SPV CLI-admit parity and
 * three-tool status consistency spec (S03-C-T02).
 *
 * PO: PO-S03-C-02 (valid PLANNING stage → chain-valid SPV_PASS Receipt to
 * plan/<stage>/ with canonical accepted/receipt_ref/new_state/findings; plugin
 * and CLI `admit spv-result` oracle agree on canonical fields, Receipt
 * type/digest/chain and fresh reconcile readback; wrong digest / wrong state /
 * duplicate / missing manifest / unknown stage refuse with zero Receipts),
 * PO-S03-C-03 (proofloop_plan(status) derives from reconcileStage persisted
 * facts and is consistent with proofloop_stage(status) /
 * proofloop_review(stage_status) on the same fixture — canonical
 * data/summary/findings deep-equal; status is read-only: ≤1000 UTF-16 summary,
 * findings ≤20, no Receipt body/ref leak).
 *
 * The production plugin never shells the CLI — the runtime CLI `admitRequest`
 * (`@proofloop/runtime/dist/cli/admit.js`) is consumed ONLY inside this TEST
 * process as the parity oracle, on a byte-identical parallel fixture with time
 * frozen (vi.useFakeTimers) so the runtime receipt timestamps/digests/bytes
 * are IDENTICAL between the CLI oracle and the plugin.
 *
 * Fixture preconditions: the legal STAGE_PLAN persisted fact is created in
 * TEST setup via the runtime `admitStagePlan` method (never a hidden tool
 * operation); EXECUTING fixtures advance via the runtime `admitSpvResult`;
 * broken-chain fixtures tamper a persisted receipt (stored digest no longer
 * matches the content → chain invalid).
 */

import { describe, expect, it, afterEach, beforeEach, vi, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { admitRequest } from '@proofloop/runtime/dist/cli/admit.js';
import {
  admitStagePlan,
  admitSpvResult,
  manifestFileDigest,
  reconcileStage,
} from '@proofloop/runtime';
import { verifyReceiptChain } from '@proofloop/kernel';
import type { Manifest } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { createPlanTool } from './plan.js';
import type { PlanToolArgsShape } from './plan.js';
import { createStageTool } from './stage.js';
import { createReviewTool } from './review.js';

const STAGE_ID = 'S03';
const FROZEN_NOW = new Date('2026-08-03T00:00:00.000Z');
const DIST_ADMIT_CLI = path.join(
  process.cwd(),
  'packages',
  'runtime',
  'dist',
  'cli',
  'admit.js',
);

const cleanups: Array<() => void> = [];

beforeAll(() => {
  // Build the dist so the CLI parity oracle is current (test-only).
  execFileSync(
    'npm',
    ['exec', '--', 'tsc', '-b', 'packages/kernel', 'packages/runtime', 'packages/opencode-plugin'],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
  expect(existsSync(DIST_ADMIT_CLI)).toBe(true);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

// ============================================================
// Fixture helpers (real temp git worktree + canonical layout)
// ============================================================

function makeWorktree(prefix = 's03c-t02-'): { root: string } {
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

/** Kernel-valid single-slice S03 manifest (canonical slice id / evidence). */
function stageManifest(): Manifest {
  return {
    stage_id: STAGE_ID,
    source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
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
            po_id: 'PO-S03-C-02',
            behavior: 'SPV admit through the runtime pipeline with CLI parity.',
            public_seam: 'Seam C.',
            oracle_source: 'fixture oracle.',
            success_criteria: 'SPV writes a chain-valid SPV_PASS receipt.',
            required_observation: 'observe receipt + reconcile.',
            applicable_risk_facts: ['persistent_state', 'core_state_machine'],
          },
        ],
        tasks: ['S03-C-T01'],
        risk_facts: ['persistent_state: true'],
        evidence_path: `delivery/stages/${STAGE_ID}/evidence/S03-C.md`,
        cv_minimum_level: 'enhanced',
      },
    ],
    dependencies: [],
    risk_facts: ['public_api_change: true'],
  };
}

function writeTasksMd(root: string): void {
  const p = path.join(root, 'delivery', 'stages', STAGE_ID, 'tasks.md');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(
    p,
    `# Stage ${STAGE_ID} — Test Stage

## Slice S03-C

<!-- SLICE:S03-C:BEGIN -->

### Tasks

- [ ] S03-C-T01: task one

<!-- SLICE:S03-C:END -->
`,
    'utf-8',
  );
}

function writeEvidence(root: string): void {
  const p = path.join(root, 'delivery', 'stages', STAGE_ID, 'evidence', 'S03-C.md');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, '# Slice S03-C Evidence\n', 'utf-8');
}

function writeManifest(root: string): string {
  const p = path.join(root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(stageManifest(), null, 2), 'utf-8');
  return p;
}

function manifestDigestOf(root: string): string {
  return manifestFileDigest({ projectRoot: root, stageId: STAGE_ID });
}

/** Seed a legal PLANNING stage (git + manifest + tasks + evidence + STAGE_PLAN). */
function seedPlanning(root: string): string {
  gitInit(root);
  writeManifest(root);
  writeTasksMd(root);
  writeEvidence(root);
  commitAll(root, 'planning fixture');
  const digest = manifestDigestOf(root);
  const plan = admitStagePlan(
    { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: digest },
    { projectRoot: root },
  );
  expect(plan.accepted).toBe(true);
  return digest;
}

/** Seed an UNINITIALIZED stage (manifest only, no STAGE_PLAN fact). */
function seedUnplanned(root: string): string {
  gitInit(root);
  writeManifest(root);
  writeTasksMd(root);
  writeEvidence(root);
  commitAll(root, 'unplanned fixture');
  return manifestDigestOf(root);
}

/** Seed EXECUTING (PLANNING advanced by a persisted SPV_PASS fact). */
function seedExecuting(root: string): string {
  const digest = seedPlanning(root);
  const spv = admitSpvResult(
    { type: 'spv_result', stageId: STAGE_ID, manifestDigest: digest, summary: 'approved' },
    { projectRoot: root },
  );
  expect(spv.accepted).toBe(true);
  return digest;
}

/** Seed a broken plan chain: PLANNING then tamper the STAGE_PLAN receipt. */
function seedBrokenChain(root: string): string {
  const digest = seedPlanning(root);
  const dir = path.join(root, '.proofloop', 'receipts', 'plan', STAGE_ID);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const firstPath = path.join(dir, files[0]);
  const receipt = JSON.parse(readFileSync(firstPath, 'utf-8'));
  receipt.payload.status = 'tampered';
  writeFileSync(firstPath, JSON.stringify(receipt, null, 2), 'utf-8');
  expect(verifyReceiptChain(dir).valid).toBe(false);
  return digest;
}

/** Seed a fixture with NO manifest (missing-manifest refusal). */
function seedMissingManifest(root: string): void {
  gitInit(root);
  writeTasksMd(root);
  writeEvidence(root);
  commitAll(root, 'missing manifest fixture');
}

// ============================================================
// Host execute helpers
// ============================================================

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

function makeToolContext(root: string): ToolContext {
  return {
    sessionID: 'sess-s03c-t02',
    messageID: 'msg-s03c-t02',
    agent: 'planner',
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

type ExecuteTool = {
  description: string;
  args: PlanToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
};

function makePlanTool(root: string): ExecuteTool {
  return createPlanTool(makeContext(root)) as ExecuteTool;
}

function makeStageTool(root: string): ExecuteTool {
  return createStageTool(makeContext(root)) as unknown as ExecuteTool;
}

function makeReviewTool(root: string): ExecuteTool {
  return createReviewTool(makeContext(root)) as unknown as ExecuteTool;
}

/** Extract the canonical `Data:` payload from the execute host output. */
function extractDataLine(output: string): Record<string, unknown> {
  const match = output.match(/^Data: (.+)$/m);
  expect(match).toBeTruthy();
  return JSON.parse(match?.[1] ?? '') as Record<string, unknown>;
}

/** Extract the status summary block (between the label and Data/Findings). */
function extractStatusBlock(output: string): string {
  const lines = output.split('\n');
  const labelIdx = lines.findIndex((l) => l === 'Stage status:');
  expect(labelIdx, `expected Stage status: in\n${output}`).toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (let i = labelIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('Data: ') || line.startsWith('Findings')) break;
    block.push(line);
  }
  return block.join('\n');
}

/** Recursively snapshot `.proofloop/receipts/**` (rel path → sha256). */
function snapshotReceipts(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, base: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        const content = readFileSync(abs);
        map.set(rel, createHash('sha256').update(content).digest('hex'));
      }
    }
  };
  walk(path.join(root, '.proofloop', 'receipts'), '.proofloop/receipts');
  return map;
}

/** Same bounded new_state projection the plugin exposes (projectAdmitNewState). */
function projectCliNewState(state: unknown): unknown {
  if (state === null || state === undefined) return state;
  const s = state as Record<string, unknown>;
  const slices = (s.slices as Array<Record<string, unknown>>).map((sl) => ({
    slice_id: sl.slice_id,
    slice_state: sl.slice_state,
    cv_status: sl.cv_status,
    complete: sl.complete,
    integrated: sl.integrated,
    committed: sl.committed,
  }));
  return {
    stage_id: s.stage_id,
    stage_state: s.stage_state,
    project_state: s.project_state,
    receipt_chain_valid: s.receipt_chain_valid,
    slices,
  };
}

// ============================================================
// SPV CLI-admit parity (PO-S03-C-02)
// ============================================================

describe('SPV CLI-admit parity (PO-S03-C-02)', () => {
  async function pluginSpvAdmit(
    root: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const tool = makePlanTool(root);
    const envelope = await tool.execute({ operation: 'admit_spv_result', ...args }, makeToolContext(root));
    return extractDataLine(envelope.output);
  }

  it('valid PLANNING stage: plugin projection + receipt bytes equal the CLI admitRequest oracle', async () => {
    const cliFx = makeWorktree('s03c-t02-cli-');
    const pluginFx = makeWorktree('s03c-t02-plugin-');
    const cliDigest = seedPlanning(cliFx.root);
    const pluginDigest = seedPlanning(pluginFx.root);
    expect(pluginDigest).toBe(cliDigest);
    const summary = 'stage plan approved';

    // CLI oracle on fixture A.
    const cli = admitRequest(
      { type: 'spv_result', stageId: STAGE_ID, manifestDigest: cliDigest, summary },
      cliFx.root,
    );
    // Plugin on the byte-identical fixture B (production path).
    const plugin = await pluginSpvAdmit(pluginFx.root, {
      stage_id: STAGE_ID,
      manifest_digest: pluginDigest,
      verdict: 'SPV_PASS',
      summary,
    });

    expect(cli.accepted).toBe(true);
    expect(plugin.accepted).toBe(true);
    const cliReceipt = cli.receipt_ref as string;
    expect(cliReceipt).toMatch(/^[0-9a-f]{64}$/);
    expect((plugin.receipt_ref as { digest: string }).digest).toBe(cliReceipt);
    expect((plugin.receipt_ref as { ref: string }).ref).toBe(
      `.proofloop/receipts/plan/${STAGE_ID}/${cliReceipt}.json`,
    );
    // new_state canonical-fields parity (bounded projection).
    expect(plugin.new_state).toEqual(projectCliNewState(cli.new_state));
    // findings parity.
    expect(plugin.findings).toEqual(cli.findings);
    // Receipt type/chain: the SPV_PASS receipt links to the STAGE_PLAN receipt.
    const planDir = path.join(cliFx.root, '.proofloop', 'receipts', 'plan', STAGE_ID);
    expect(verifyReceiptChain(planDir).valid).toBe(true);
    // Receipt file bytes are IDENTICAL (same runtime, same frozen timestamp).
    expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
    // Fresh reconcile reflects the persisted SPV fact identically on both.
    expect(reconcileStage({ projectRoot: cliFx.root, stageId: STAGE_ID }).stage_state).toBe(
      reconcileStage({ projectRoot: pluginFx.root, stageId: STAGE_ID }).stage_state,
    );
  });

  it('wrong manifest_digest: refusal finding codes/order parity, zero receipts', async () => {
    const cliFx = makeWorktree('s03c-t02-cli-');
    const pluginFx = makeWorktree('s03c-t02-plugin-');
    seedPlanning(cliFx.root);
    seedPlanning(pluginFx.root);
    const wrongDigest = 'b'.repeat(64);

    const cli = admitRequest(
      { type: 'spv_result', stageId: STAGE_ID, manifestDigest: wrongDigest, summary: 'approve' },
      cliFx.root,
    );
    const plugin = await pluginSpvAdmit(pluginFx.root, {
      stage_id: STAGE_ID,
      manifest_digest: wrongDigest,
      verdict: 'SPV_PASS',
      summary: 'approve',
    });

    expect(cli.accepted).toBe(false);
    expect(plugin.accepted).toBe(false);
    expect(cli.receipt_ref).toBeNull();
    expect(plugin.receipt_ref).toBeNull();
    expect((plugin.findings as Array<{ code: string }>).map((f) => f.code)).toEqual(
      cli.findings.map((f) => f.code),
    );
    expect(cli.findings.map((f) => f.code)).toEqual(['DOMAIN.INVALID_TRANSITION']);
    // Zero receipts written by the refusal on either side (only the STAGE_PLAN
    // fixture fact remains, byte-identical).
    expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
    expect(
      readdirSync(path.join(cliFx.root, '.proofloop', 'receipts', 'plan', STAGE_ID)).filter((f) =>
        f.endsWith('.json'),
      ),
    ).toHaveLength(1);
  });

  it('wrong state (UNINITIALIZED): refusal parity, zero receipts', async () => {
    const cliFx = makeWorktree('s03c-t02-cli-');
    const pluginFx = makeWorktree('s03c-t02-plugin-');
    const cliDigest = seedUnplanned(cliFx.root);
    const pluginDigest = seedUnplanned(pluginFx.root);
    expect(pluginDigest).toBe(cliDigest);

    const cli = admitRequest(
      { type: 'spv_result', stageId: STAGE_ID, manifestDigest: cliDigest, summary: 'approve' },
      cliFx.root,
    );
    const plugin = await pluginSpvAdmit(pluginFx.root, {
      stage_id: STAGE_ID,
      manifest_digest: pluginDigest,
      verdict: 'SPV_PASS',
      summary: 'approve',
    });

    expect(cli.accepted).toBe(false);
    expect(plugin.accepted).toBe(false);
    expect(cli.receipt_ref).toBeNull();
    expect(plugin.receipt_ref).toBeNull();
    expect((plugin.findings as Array<{ code: string }>).map((f) => f.code)).toEqual(
      cli.findings.map((f) => f.code),
    );
    expect(cli.findings.map((f) => f.code)).toEqual(['DOMAIN.INVALID_TRANSITION']);
    expect(snapshotReceipts(pluginFx.root).size).toBe(0);
    expect(snapshotReceipts(cliFx.root).size).toBe(0);
  });

  it('duplicate (stage already SPV-admitted): refusal parity, zero NEW receipts', async () => {
    const cliFx = makeWorktree('s03c-t02-cli-');
    const pluginFx = makeWorktree('s03c-t02-plugin-');
    seedPlanning(cliFx.root);
    seedPlanning(pluginFx.root);
    // Advance both to SPV-admitted via the runtime (identical chain).
    const cliBefore = snapshotReceipts(cliFx.root);
    admitSpvResult(
      { type: 'spv_result', stageId: STAGE_ID, manifestDigest: manifestDigestOf(cliFx.root), summary: 'first' },
      { projectRoot: cliFx.root },
    );
    admitSpvResult(
      { type: 'spv_result', stageId: STAGE_ID, manifestDigest: manifestDigestOf(pluginFx.root), summary: 'first' },
      { projectRoot: pluginFx.root },
    );
    expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
    const cliState = snapshotReceipts(cliFx.root);

    // Duplicate SPV admit: both refuse (stage no longer PLANNING).
    const cli = admitRequest(
      { type: 'spv_result', stageId: STAGE_ID, manifestDigest: manifestDigestOf(cliFx.root), summary: 'duplicate' },
      cliFx.root,
    );
    const plugin = await pluginSpvAdmit(pluginFx.root, {
      stage_id: STAGE_ID,
      manifest_digest: manifestDigestOf(pluginFx.root),
      verdict: 'SPV_PASS',
      summary: 'duplicate',
    });

    expect(cli.accepted).toBe(false);
    expect(plugin.accepted).toBe(false);
    expect(cli.receipt_ref).toBeNull();
    expect(plugin.receipt_ref).toBeNull();
    expect((plugin.findings as Array<{ code: string }>).map((f) => f.code)).toEqual(
      cli.findings.map((f) => f.code),
    );
    expect(cli.findings.map((f) => f.code)).toEqual(['DOMAIN.INVALID_TRANSITION']);
    // No NEW receipts on either side; the existing chain is byte-identical.
    expect(snapshotReceipts(cliFx.root)).toEqual(cliState);
    expect(snapshotReceipts(pluginFx.root)).toEqual(cliState);
    expect(cliState.size).toBe(cliBefore.size + 1);
  });

  it('missing manifest: refusal code parity (DOMAIN.STAGE_NOT_FOUND), zero receipts', async () => {
    const cliFx = makeWorktree('s03c-t02-cli-');
    const pluginFx = makeWorktree('s03c-t02-plugin-');
    seedMissingManifest(cliFx.root);
    seedMissingManifest(pluginFx.root);
    const digest = 'c'.repeat(64);

    const cli = admitRequest(
      { type: 'spv_result', stageId: STAGE_ID, manifestDigest: digest, summary: 'approve' },
      cliFx.root,
    );
    const plugin = await pluginSpvAdmit(pluginFx.root, {
      stage_id: STAGE_ID,
      manifest_digest: digest,
      verdict: 'SPV_PASS',
      summary: 'approve',
    });

    expect(cli.accepted).toBe(false);
    expect(plugin.accepted).toBe(false);
    expect(cli.receipt_ref).toBeNull();
    expect(plugin.receipt_ref).toBeNull();
    // Canonical finding CODE parity. (The plugin's manifest content guard and
    // the runtime manifest source phrase the DOMAIN.STAGE_NOT_FOUND message
    // differently; the code/order is the canonical contract.)
    expect((plugin.findings as Array<{ code: string }>).map((f) => f.code)).toEqual(
      cli.findings.map((f) => f.code),
    );
    expect(cli.findings.map((f) => f.code)).toEqual(['DOMAIN.STAGE_NOT_FOUND']);
    expect(snapshotReceipts(pluginFx.root).size).toBe(0);
    expect(snapshotReceipts(cliFx.root).size).toBe(0);
  });

  it('unknown stage: refusal code parity (DOMAIN.STAGE_NOT_FOUND), zero receipts', async () => {
    const cliFx = makeWorktree('s03c-t02-cli-');
    const pluginFx = makeWorktree('s03c-t02-plugin-');
    seedMissingManifest(cliFx.root);
    seedMissingManifest(pluginFx.root);
    const digest = 'd'.repeat(64);

    const cli = admitRequest(
      { type: 'spv_result', stageId: 'S99', manifestDigest: digest, summary: 'approve' },
      cliFx.root,
    );
    const plugin = await pluginSpvAdmit(pluginFx.root, {
      stage_id: 'S99',
      manifest_digest: digest,
      verdict: 'SPV_PASS',
      summary: 'approve',
    });

    expect(cli.accepted).toBe(false);
    expect(plugin.accepted).toBe(false);
    expect(cli.receipt_ref).toBeNull();
    expect(plugin.receipt_ref).toBeNull();
    expect((plugin.findings as Array<{ code: string }>).map((f) => f.code)).toEqual(
      cli.findings.map((f) => f.code),
    );
    expect(cli.findings.map((f) => f.code)).toEqual(['DOMAIN.STAGE_NOT_FOUND']);
    expect(snapshotReceipts(pluginFx.root).size).toBe(0);
    expect(snapshotReceipts(cliFx.root).size).toBe(0);
  });
});

// ============================================================
// Three-tool status consistency (PO-S03-C-03)
// ============================================================

describe('plan status consistency across tools (PO-S03-C-03)', () => {
  interface ToolStatus {
    data: Record<string, unknown>;
    statusBlock: string;
    output: string;
  }

  async function statusFrom(tool: ExecuteTool, root: string, args: Record<string, unknown>): Promise<ToolStatus> {
    const envelope = await tool.execute(args, makeToolContext(root));
    return {
      data: extractDataLine(envelope.output),
      statusBlock: extractStatusBlock(envelope.output),
      output: envelope.output,
    };
  }

  async function threeToolStatus(root: string): Promise<{
    plan: ToolStatus;
    stage: ToolStatus;
    review: ToolStatus;
  }> {
    const plan = await statusFrom(makePlanTool(root), root, { operation: 'status', stage_id: STAGE_ID });
    const stage = await statusFrom(makeStageTool(root), root, { operation: 'status', stage_id: STAGE_ID });
    const review = await statusFrom(makeReviewTool(root), root, { operation: 'stage_status', stage_id: STAGE_ID });
    return { plan, stage, review };
  }

  it('PLANNING fixture: plan/stage/review data, summary and findings deep-equal', async () => {
    const { root } = makeWorktree('s03c-t02-st-plann-');
    seedPlanning(root);
    const { plan, stage, review } = await threeToolStatus(root);

    expect(plan.data.stage_id).toBe(STAGE_ID);
    expect(plan.data.stage_state).toBe('PLANNING');
    expect(plan.data.receipt_chain_valid).toBe(true);
    // Canonical projection deep-equal across the three status seams.
    expect(plan.data).toEqual(stage.data);
    expect(plan.data).toEqual(review.data);
    // Bounded summary deep-equal.
    expect(plan.statusBlock).toBe(stage.statusBlock);
    expect(plan.statusBlock).toBe(review.statusBlock);
    // Summary is bounded ≤1000 UTF-16 chars and no Receipt body/ref leak.
    expect(plan.statusBlock.length).toBeLessThanOrEqual(1000);
    expect(plan.output).not.toContain('"payload"');
    expect(plan.output).not.toMatch(/receipts\/plan/);
  });

  it('EXECUTING fixture (SPV admitted): plan/stage/review data, summary and findings deep-equal', async () => {
    const { root } = makeWorktree('s03c-t02-st-exec-');
    seedExecuting(root);
    const { plan, stage, review } = await threeToolStatus(root);

    expect(plan.data.stage_id).toBe(STAGE_ID);
    expect(plan.data.stage_state).toBe('EXECUTING');
    expect(plan.data.receipt_chain_valid).toBe(true);
    expect(plan.data).toEqual(stage.data);
    expect(plan.data).toEqual(review.data);
    expect(plan.statusBlock).toBe(stage.statusBlock);
    expect(plan.statusBlock).toBe(review.statusBlock);
    expect(plan.statusBlock.length).toBeLessThanOrEqual(1000);
    expect(plan.output).not.toContain('"payload"');
  });

  it('invalid-chain fixture: plan/stage/review data, summary and findings deep-equal (chain invalid)', async () => {
    const { root } = makeWorktree('s03c-t02-st-chain-');
    seedBrokenChain(root);
    const { plan, stage, review } = await threeToolStatus(root);

    expect(plan.data.stage_id).toBe(STAGE_ID);
    expect(plan.data.receipt_chain_valid).toBe(false);
    expect(plan.data).toEqual(stage.data);
    expect(plan.data).toEqual(review.data);
    expect(plan.statusBlock).toBe(stage.statusBlock);
    expect(plan.statusBlock).toBe(review.statusBlock);
    expect(plan.statusBlock.length).toBeLessThanOrEqual(1000);
    expect(plan.output).not.toContain('"payload"');
  });

  it('status is fully read-only: no Receipt refs and no runtime/receipt mutation', async () => {
    const { root } = makeWorktree('s03c-t02-st-ro-');
    seedPlanning(root);
    const before = snapshotReceipts(root);
    const tool = makePlanTool(root);

    const envelope = await tool.execute(
      { operation: 'status', stage_id: STAGE_ID },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: ok');
    expect(envelope.output).not.toContain('receipt_ref');
    expect(envelope.output).not.toContain('"payload"');
    expect(snapshotReceipts(root)).toEqual(before);
    expect(existsSync(path.join(root, '.proofloop', 'runtime'))).toBe(false);
  });

  it('findings stay bounded (≤20) even on a findings-heavy invalid fixture', async () => {
    const { root } = makeWorktree('s03c-t02-st-find-');
    seedBrokenChain(root);
    const tool = makePlanTool(root);
    const envelope = await tool.execute(
      { operation: 'status', stage_id: STAGE_ID },
      makeToolContext(root),
    );
    const findingsMatch = envelope.output.match(/^Findings \((\d+)\):/m);
    if (findingsMatch) {
      expect(Number(findingsMatch[1])).toBeLessThanOrEqual(20);
    }
    expect(envelope.output).not.toContain('"payload"');
  });
});
