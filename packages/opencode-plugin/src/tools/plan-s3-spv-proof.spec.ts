/**
 * @proofloop/opencode-plugin — plan-s3-spv-proof: full S03-C proof matrix on
 * the BUILT host seam (S03-C-T03).
 *
 * PO: PO-S03-C-01..04 closure —
 *   - PO-S03-C-02: valid PLANNING stage → chain-valid SPV_PASS Receipt to
 *     plan/<stage>/ (previous_digest → STAGE_PLAN digest), fresh reconcile
 *     readback; refusals (wrong digest / wrong state UNINITIALIZED / after
 *     SPV_PASS / duplicate / missing manifest / unknown stage) → zero
 *     receipts, byte-identical `.proofloop/receipts/**` + `.proofloop/runtime/**`,
 *     canonical Finding codes, CLI `admitRequest` parity on each refusal;
 *   - PO-S03-C-03: proofloop_plan(status) Data + summary + findings
 *     deep-equal proofloop_stage(status) / proofloop_review(stage_status) on
 *     PLANNING / EXECUTING / invalid-chain fixtures; summary ≤1000 UTF-16,
 *     findings ≤20, no Receipt body/ref leak (read-only);
 *   - PO-S03-C-04: path (project_root mismatch / non-canonical stage_id /
 *     outside-root validate path), schema (missing fields / bad
 *     manifest_digest / bad verdict), broken-chain, unsupported-op, duplicate
 *     and abort branches fail closed with before/after artifact snapshots
 *     (receipts/runtime byte-identical; logs excepted);
 *   - PO-S03-C-01: status/admit_spv_result dispatch + stage_plan/gate/project/
 *     unknown rejection on the BUILT seam; S2 validate regression.
 *
 * Seam: loads the BUILT plugin entry (`packages/opencode-plugin/dist/index.js`)
 * through a file URL (the same host-load seam as `test/opencode-*.spec.ts`)
 * and executes the REAL built `createPlanTool(...).execute(args, ToolContext)`
 * host `{ output }` envelope against real temp git worktrees with persisted
 * legal STAGE_PLAN preconditions (seeded in TEST setup via the runtime
 * `admitStagePlan` method — never a hidden `stage_plan` tool operation).
 *
 * The CLI dist entries (`validate-stage.js` / `admit.js` via the in-process
 * `admitRequest`) are used ONLY inside this TEST process as parity oracles —
 * the production plugin never spawns them (static no-CLI guard in
 * plan-s3-parity.spec.ts).
 */

import { describe, expect, it, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
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
import { pathToFileURL } from 'node:url';
import { admitRequest } from '@proofloop/runtime/dist/cli/admit.js';
import { admitStagePlan, admitSpvResult, defaultReceiptWriter, manifestFileDigest, reconcileStage } from '@proofloop/runtime';
import type { ReceiptWriterPort } from '@proofloop/runtime';
import { verifyReceiptChain } from '@proofloop/kernel';
import type { Manifest } from '@proofloop/kernel';
import type { RuntimeContext } from '../host-context.js';
import { successResult } from '../tool-result.js';
import { projectPlanSpvAdmitToolResult } from './plan-spv-admit.js';

const DIST_ENTRY = path.join(
  process.cwd(),
  'packages',
  'opencode-plugin',
  'dist',
  'index.js',
);
const DIST_VALIDATE_CLI = path.join(
  process.cwd(),
  'packages',
  'runtime',
  'dist',
  'cli',
  'validate-stage.js',
);
const DIST_ADMIT_CLI = path.join(
  process.cwd(),
  'packages',
  'runtime',
  'dist',
  'cli',
  'admit.js',
);

const STAGE_ID = 'S03';
const FROZEN_NOW = new Date('2026-08-03T00:00:00.000Z');

type BuiltEntry = {
  default?: unknown;
  server?: unknown;
  [key: string]: unknown;
};

type ToolContextShape = {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
  ask(input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

type BuiltPlanTool = {
  description: string;
  args: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: ToolContextShape,
  ) => Promise<{ output: string }>;
};

const cleanups: Array<() => void> = [];

beforeAll(() => {
  execFileSync(
    'npm',
    ['exec', '--', 'tsc', '-b', 'packages/kernel', 'packages/runtime', 'packages/opencode-plugin'],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
  expect(existsSync(DIST_ENTRY)).toBe(true);
  expect(existsSync(DIST_VALIDATE_CLI)).toBe(true);
  expect(existsSync(DIST_ADMIT_CLI)).toBe(true);
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

function makeWorktree(prefix = 's03c-t03-'): { root: string } {
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
            po_id: 'PO-S03-C-01',
            behavior: 'SPV/status through the built plan seam.',
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

function writeTasksMd(root: string): string {
  const p = path.join(root, 'delivery', 'stages', STAGE_ID, 'tasks.md');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(
    p,
    `# Stage ${STAGE_ID} — Test Stage

## Stage Goal

Test stage goal paragraph.

## Observable Outcomes

- OUT-01: first outcome

## Dependencies

- No external stage blocking dependency.

## Stage Risk Facts

- public_api_change: true

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

### Proof Obligations

- PO-S03-C-01
  - Behavior: SPV/status through the built plan seam.
  - Public Seam: Seam C.
  - Oracle Source: fixture oracle.
  - Success / Failure: SPV writes a chain-valid SPV_PASS receipt.
  - Required Observation: observe receipt + reconcile.

### Tasks

- [ ] S03-C-T01: task one

<!-- SLICE:S03-C:END -->
`,
    'utf-8',
  );
  return p;
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
// Built-host seam helpers
// ============================================================

async function loadBuilt(): Promise<BuiltEntry> {
  return (await import(pathToFileURL(DIST_ENTRY).href)) as BuiltEntry;
}

function makeContext(plugin: BuiltEntry, root: string): RuntimeContext {
  const createCtx = plugin['createRuntimeContext'] as (input: unknown) => RuntimeContext;
  const input = {
    client: { app: { log: () => undefined } },
    project: {},
    directory: root,
    worktree: root,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:5178'),
    $: {},
  };
  return createCtx(input);
}

function makeToolContext(
  root: string,
  agent = 'planner',
  abort: AbortSignal = new AbortController().signal,
): ToolContextShape {
  return {
    sessionID: 'sess-s03c-t03-proof',
    messageID: 'msg-s03c-t03-proof',
    agent,
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

function makePlanTool(plugin: BuiltEntry, context: RuntimeContext, handlers?: unknown): BuiltPlanTool {
  return (plugin['createPlanTool'] as (ctx: RuntimeContext, h?: unknown) => BuiltPlanTool)(
    context,
    handlers,
  );
}

/**
 * Build the plan tool with the documented TEST-ONLY SPV admit deps routed
 * through the REAL built `createPlanTool` factory (CV diagnose test-seam
 * compliance): the fault-injection `beforeAdmit` / `afterAdmit` hooks flow
 * into the BUILT default `admit_spv_result` handler and the CALL is the real
 * `execute` host envelope — never a direct `runPlanSpvAdmit(...)` invocation.
 */
function makePlanToolWithSpvDeps(
  plugin: BuiltEntry,
  context: RuntimeContext,
  deps: { beforeAdmit?: () => void; afterAdmit?: () => void },
): BuiltPlanTool {
  return (plugin['createPlanTool'] as (
    ctx: RuntimeContext,
    h?: unknown,
    z?: unknown,
    spvDeps?: { beforeAdmit?: () => void; afterAdmit?: () => void },
  ) => BuiltPlanTool)(context, undefined, undefined, deps);
}

function makeStageTool(plugin: BuiltEntry, context: RuntimeContext): BuiltPlanTool {
  return (plugin['createStageTool'] as (ctx: RuntimeContext) => BuiltPlanTool)(context);
}

function makeReviewTool(plugin: BuiltEntry, context: RuntimeContext): BuiltPlanTool {
  return (plugin['createReviewTool'] as (ctx: RuntimeContext) => BuiltPlanTool)(context);
}

// ============================================================
// Snapshot / extraction helpers
// ============================================================

function fileDigest(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Digest map of every file in the tree (relative path → sha256). */
function snapshotTree(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        map.set(path.relative(root, abs), fileDigest(readFileSync(abs)));
      } else if (entry.isSymbolicLink()) {
        map.set(path.relative(root, abs), `link:${fileDigest(readFileSync(abs))}`);
      }
    }
  };
  walk(root);
  return map;
}

/**
 * Assert the tree is byte-identical to `before` except `.proofloop/logs/**`
 * (diagnostics may append) and the operation's own intended writes
 * (`allowedChangeRel`). Every other business artifact (receipts/runtime/
 * manifests/tasks/evidence) must be byte-identical.
 */
function assertTreeIdenticalExcept(
  root: string,
  before: Map<string, string>,
  allowedChangeRel: readonly string[],
): void {
  const after = snapshotTree(root);
  for (const [rel, digest] of before) {
    if (allowedChangeRel.includes(rel) || rel.startsWith('.proofloop/logs/')) {
      continue;
    }
    expect(after.has(rel), `file deleted: ${rel}`).toBe(true);
    expect(after.get(rel), `file changed: ${rel}`).toBe(digest);
  }
  for (const rel of after.keys()) {
    if (before.has(rel)) continue;
    const allowed =
      rel.startsWith('.proofloop/logs/') || allowedChangeRel.includes(rel);
    expect(allowed, `new file outside allowed set: ${rel}`).toBe(true);
  }
}

/** Read the plan/<stage>/ receipts as [{ type, digest, previous_digest }]. */
function planReceipts(root: string): Array<{
  type: string;
  digest: string;
  previous_digest?: string;
}> {
  const dir = path.join(root, '.proofloop', 'receipts', 'plan', STAGE_ID);
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

/** Assert no `.proofloop/runtime/**` directory exists in the worktree. */
function expectNoRuntimeDir(root: string): void {
  expect(existsSync(path.join(root, '.proofloop', 'runtime'))).toBe(false);
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

/** Parse the CLI validate-stage stdout (the CLI prints only the JSON result). */
function cliValidateJson(stdout: string): { valid: boolean; stage_id: string; errors: unknown[] } {
  expect(stdout.length).toBeGreaterThan(0);
  return JSON.parse(stdout) as { valid: boolean; stage_id: string; errors: unknown[] };
}

// ============================================================
// SPV success/refusal matrix on the BUILT seam (PO-S03-C-02)
// ============================================================

describe('built seam: SPV success/refusal matrix (PO-S03-C-02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });

  async function pluginSpvAdmit(
    plugin: BuiltEntry,
    root: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'admit_spv_result', ...args },
      makeToolContext(root),
    );
    return extractDataLine(envelope.output);
  }

  it('valid PLANNING: chain-valid SPV_PASS Receipt, fresh reconcile readback, artifact snapshot allows exactly the receipt', async () => {
    const plugin = await loadBuilt();
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-t03-spv-');
      const d = seedPlanning(r.root);
      return { root: r.root, digest: d };
    })();
    const before = snapshotTree(root);
    const data = await pluginSpvAdmit(plugin, root, {
      stage_id: STAGE_ID,
      manifest_digest: digest,
      verdict: 'SPV_PASS',
      summary: 'stage plan approved',
    });

    expect(data.accepted).toBe(true);
    const receiptRef = data.receipt_ref as { ref: string; digest: string };
    expect(receiptRef.ref).toMatch(
      new RegExp(`^\\.proofloop\\/receipts\\/plan\\/${STAGE_ID}\\/[0-9a-f]{64}\\.json$`),
    );
    expect(receiptRef.digest).toMatch(/^[0-9a-f]{64}$/);

    // Exactly one SPV_PASS receipt; chain valid; previous_digest → STAGE_PLAN.
    const receipts = planReceipts(root);
    expect(receipts).toHaveLength(2);
    const spv = receipts.filter((r) => r.type === 'SPV_PASS');
    const plan = receipts.filter((r) => r.type === 'STAGE_PLAN');
    expect(spv).toHaveLength(1);
    expect(plan).toHaveLength(1);
    expect(spv[0].previous_digest).toBe(plan[0].digest);
    expect(verifyReceiptChain(path.join(root, '.proofloop', 'receipts', 'plan', STAGE_ID)).valid).toBe(
      true,
    );

    // Fresh reconcile readback derives the runtime state (READY folds to
    // EXECUTING while the slice is not integrated).
    const reconciled = reconcileStage({ projectRoot: root, stageId: STAGE_ID });
    expect(reconciled.stage_state).toBe('EXECUTING');
    expect(reconciled.receipt_chain_valid).toBe(true);

    // Artifact snapshot: exactly the one SPV_PASS receipt may appear new.
    const after = snapshotTree(root);
    const newFiles = [...after.keys()].filter(
      (rel) => !before.has(rel) && !rel.startsWith('.proofloop/logs/'),
    );
    expect(newFiles).toHaveLength(1);
    expect(newFiles[0]).toBe(path.posix.relative('.', receiptRef.ref));
    assertTreeIdenticalExcept(root, before, [newFiles[0]]);
    expectNoRuntimeDir(root);
  });

  it('refusal matrix: wrong digest / wrong state / duplicate / missing manifest / unknown stage → zero receipts, canonical codes, CLI parity', async () => {
    const plugin = await loadBuilt();

    const refusalCases: Array<{
      name: string;
      seed: (root: string) => string | void;
      stageId: string;
      digest: string;
      expectedCode: string;
    }> = [
      {
        name: 'wrong manifest_digest',
        seed: (r) => seedPlanning(r),
        stageId: STAGE_ID,
        digest: 'b'.repeat(64),
        expectedCode: 'DOMAIN.INVALID_TRANSITION',
      },
      {
        name: 'wrong state (UNINITIALIZED)',
        seed: (r) => seedUnplanned(r),
        stageId: STAGE_ID,
        digest: 'unused',
        expectedCode: 'DOMAIN.INVALID_TRANSITION',
      },
      {
        name: 'duplicate (after SPV_PASS)',
        seed: (r) => seedExecuting(r),
        stageId: STAGE_ID,
        digest: 'unused',
        expectedCode: 'DOMAIN.INVALID_TRANSITION',
      },
      {
        name: 'missing manifest',
        seed: (r) => {
          seedMissingManifest(r);
          return undefined;
        },
        stageId: STAGE_ID,
        digest: 'c'.repeat(64),
        expectedCode: 'DOMAIN.STAGE_NOT_FOUND',
      },
      {
        name: 'unknown stage id',
        seed: (r) => {
          seedMissingManifest(r);
          return undefined;
        },
        stageId: 'S99',
        digest: 'd'.repeat(64),
        expectedCode: 'DOMAIN.STAGE_NOT_FOUND',
      },
    ];

    for (const c of refusalCases) {
      const pluginFx = makeWorktree(`s03c-t03-ref-${c.name.replace(/[^a-z0-9]/gi, '-')}-`);
      const cliFx = makeWorktree(`s03c-t03-cli-${c.name.replace(/[^a-z0-9]/gi, '-')}-`);
      let pluginDigest: string | undefined;
      const seedPlugin = c.seed(pluginFx.root);
      if (typeof seedPlugin === 'string') pluginDigest = seedPlugin;
      let cliDigest: string | undefined;
      const seedCli = c.seed(cliFx.root);
      if (typeof seedCli === 'string') cliDigest = seedCli;
      // When the case names an explicit digest (wrong digest / missing
      // manifest / unknown stage) use it; otherwise ('unused') use the fixture
      // seed digest so the refusal isolates the intended condition.
      const effectivePluginDigest =
        c.digest === 'unused' ? pluginDigest ?? c.digest : c.digest;
      const effectiveCliDigest =
        c.digest === 'unused' ? cliDigest ?? c.digest : c.digest;

      const before = snapshotTree(pluginFx.root);
      const data = await pluginSpvAdmit(plugin, pluginFx.root, {
        stage_id: c.stageId,
        manifest_digest: effectivePluginDigest,
        verdict: 'SPV_PASS',
        summary: 'approve',
      });

      // Canonical refusal shape: accepted:false, receipt_ref:null.
      expect(data.accepted, c.name).toBe(false);
      expect(data.receipt_ref, c.name).toBeNull();
      const codes = (data.findings as Array<{ code: string }>).map((f) => f.code);
      expect(codes, c.name).toEqual([c.expectedCode]);

      // CLI parity: the runtime oracle refuses identically (codes/order).
      const cli = admitRequest(
        {
          type: 'spv_result',
          stageId: c.stageId,
          manifestDigest: effectiveCliDigest,
          summary: 'approve',
        },
        cliFx.root,
      );
      expect(cli.accepted, c.name).toBe(false);
      expect(cli.receipt_ref, c.name).toBeNull();
      expect(cli.findings.map((f) => f.code), c.name).toEqual(codes);

      // Zero NEW receipts written by the refusal on the plugin side; tree
      // byte-identical (only logs may append). The duplicate case legitimately
      // starts with the seeded SPV_PASS — the count must be unchanged.
      const beforeSpvCount = planReceipts(pluginFx.root).filter((r) => r.type === 'SPV_PASS').length;
      const afterSpvCount = planReceipts(pluginFx.root).filter((r) => r.type === 'SPV_PASS').length;
      expect(afterSpvCount, c.name).toBe(beforeSpvCount);
      assertTreeIdenticalExcept(pluginFx.root, before, []);
      expectNoRuntimeDir(pluginFx.root);
    }
  });

  it('valid SPV parity: plugin receipt digest equals the CLI admitRequest oracle (frozen time → identical bytes)', async () => {
    const plugin = await loadBuilt();
    const pluginFx = makeWorktree('s03c-t03-par-plugin-');
    const cliFx = makeWorktree('s03c-t03-par-cli-');
    const pluginDigest = seedPlanning(pluginFx.root);
    const cliDigest = seedPlanning(cliFx.root);
    expect(cliDigest).toBe(pluginDigest);
    const summary = 'stage plan approved';

    const cli = admitRequest(
      { type: 'spv_result', stageId: STAGE_ID, manifestDigest: cliDigest, summary },
      cliFx.root,
    );
    const data = await pluginSpvAdmit(plugin, pluginFx.root, {
      stage_id: STAGE_ID,
      manifest_digest: pluginDigest,
      verdict: 'SPV_PASS',
      summary,
    });

    expect(cli.accepted).toBe(true);
    expect(data.accepted).toBe(true);
    expect((data.receipt_ref as { digest: string }).digest).toBe(cli.receipt_ref);
    expect((data.receipt_ref as { ref: string }).ref).toBe(
      `.proofloop/receipts/plan/${STAGE_ID}/${cli.receipt_ref}.json`,
    );
    // Receipt file bytes are IDENTICAL (same runtime, same frozen timestamp).
    // Compare BUSINESS artifacts only — `.git/**` internals (index stat-cache
    // mtimes) legitimately differ across two independent fixtures.
    const diff: string[] = [];
    const a = new Map<string, string>();
    const b = new Map<string, string>();
    for (const [rel, d] of snapshotTree(pluginFx.root)) {
      if (rel.startsWith('.proofloop/logs/') || rel.startsWith('.git/')) continue;
      a.set(rel, d);
    }
    for (const [rel, d] of snapshotTree(cliFx.root)) {
      if (rel.startsWith('.proofloop/logs/') || rel.startsWith('.git/')) continue;
      b.set(rel, d);
    }
    for (const rel of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(rel) !== b.get(rel)) diff.push(rel);
    }
    expect(diff).toEqual([]);
  });
});

/** Best-effort manifest digest for a fixture (undefined when absent). */
function manifestDigestIfPresent(root: string): string | undefined {
  try {
    return manifestFileDigest({ projectRoot: root, stageId: STAGE_ID });
  } catch {
    return undefined;
  }
}

// ============================================================
// Three-tool status consistency on the BUILT seam (PO-S03-C-03)
// ============================================================

describe('built seam: three-tool status consistency (PO-S03-C-03)', () => {
  interface ToolStatus {
    data: Record<string, unknown>;
    statusBlock: string;
    output: string;
  }

  async function threeToolStatus(
    plugin: BuiltEntry,
    root: string,
  ): Promise<{ plan: ToolStatus; stage: ToolStatus; review: ToolStatus }> {
    const context = makeContext(plugin, root);
    const planTool = makePlanTool(plugin, context);
    const stageTool = makeStageTool(plugin, context);
    const reviewTool = makeReviewTool(plugin, context);

    const run = async (tool: BuiltPlanTool, args: Record<string, unknown>): Promise<ToolStatus> => {
      const envelope = await tool.execute(args, makeToolContext(root));
      return {
        data: extractDataLine(envelope.output),
        statusBlock: extractStatusBlock(envelope.output),
        output: envelope.output,
      };
    };

    return {
      plan: await run(planTool, { operation: 'status', stage_id: STAGE_ID }),
      stage: await run(stageTool, { operation: 'status', stage_id: STAGE_ID }),
      review: await run(reviewTool, { operation: 'stage_status', stage_id: STAGE_ID }),
    };
  }

  it('PLANNING / EXECUTING / invalid-chain: data + summary + findings deep-equal across plan/stage/review, bounded, no Receipt leak', async () => {
    const plugin = await loadBuilt();

    const fixtures: Array<{ name: string; seed: (r: string) => string | void; state: string }> = [
      { name: 'PLANNING', seed: (r) => seedPlanning(r), state: 'PLANNING' },
      { name: 'EXECUTING', seed: (r) => seedExecuting(r), state: 'EXECUTING' },
      { name: 'invalid-chain', seed: (r) => seedBrokenChain(r), state: 'UNINITIALIZED' },
    ];

    for (const f of fixtures) {
      const { root } = makeWorktree(`s03c-t03-st-${f.name}-`);
      f.seed(root);
      const before = snapshotTree(root);
      const { plan, stage, review } = await threeToolStatus(plugin, root);

      // The runtime-derived state fact is surfaced identically.
      expect(plan.data.stage_id, f.name).toBe(STAGE_ID);
      if (f.name === 'invalid-chain') {
        expect(plan.data.receipt_chain_valid, f.name).toBe(false);
      } else {
        expect(plan.data.stage_state, f.name).toBe(f.state);
      }
      // Canonical projection deep-equal across the three status seams.
      expect(plan.data, f.name).toEqual(stage.data);
      expect(plan.data, f.name).toEqual(review.data);
      // Bounded summary deep-equal.
      expect(plan.statusBlock, f.name).toBe(stage.statusBlock);
      expect(plan.statusBlock, f.name).toBe(review.statusBlock);
      expect(plan.statusBlock.length, `${f.name} summary budget`).toBeLessThanOrEqual(1000);
      // No Receipt BODY leak and no Receipt refs in the read-only status Data
      // (the ToolResult refs stay empty; a chain-broken Finding may still name
      // the offending receipt PATH as a diagnostic — that is not a body leak).
      for (const t of [plan, stage, review]) {
        expect(t.output, `${f.name} payload leak`).not.toContain('"payload"');
        expect(t.data, `${f.name} ref leak`).not.toHaveProperty('receipt_ref');
        expect(t.data, `${f.name} refs leak`).not.toHaveProperty('refs');
        const findingsMatch = t.output.match(/^Findings \((\d+)\):/m);
        if (findingsMatch) {
          expect(Number(findingsMatch[1]), `${f.name} findings budget`).toBeLessThanOrEqual(20);
        }
      }
      // Status is read-only: the tree is byte-identical (logs excepted).
      assertTreeIdenticalExcept(root, before, []);
      expectNoRuntimeDir(root);
    }
  });
});

// ============================================================
// Path/abort/no-write matrix on the BUILT seam (PO-S03-C-04)
// ============================================================

describe('built seam: path/abort/no-write matrix (PO-S03-C-04)', () => {
  async function executePlan(
    plugin: BuiltEntry,
    root: string,
    args: Record<string, unknown>,
    abort: AbortSignal = new AbortController().signal,
  ): Promise<string> {
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(args, makeToolContext(root, 'planner', abort));
    return envelope.output;
  }

  it('SPV path/schema rejections fail closed with zero receipts and byte-identical trees', async () => {
    const plugin = await loadBuilt();
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-t03-path-');
      const d = seedPlanning(r.root);
      return { root: r.root, digest: d };
    })();
    const other = makeWorktree('s03c-t03-other-');

    const cases: Array<{ name: string; args: Record<string, unknown>; code: string }> = [
      {
        name: 'project_root mismatch',
        args: {
          operation: 'admit_spv_result',
          stage_id: STAGE_ID,
          manifest_digest: digest,
          verdict: 'SPV_PASS',
          summary: 'approve',
          project_root: other.root,
        },
        code: 'HOST.PROJECT_NOT_TRUSTED',
      },
      {
        name: 'non-canonical stage_id',
        args: {
          operation: 'admit_spv_result',
          stage_id: '../S03',
          manifest_digest: digest,
          verdict: 'SPV_PASS',
          summary: 'approve',
        },
        code: 'RUNTIME.SCHEMA_MISMATCH',
      },
      {
        name: 'missing stage_id',
        args: { operation: 'admit_spv_result', manifest_digest: digest, verdict: 'SPV_PASS', summary: 'approve' },
        code: 'RUNTIME.SCHEMA_MISMATCH',
      },
      {
        name: 'missing manifest_digest',
        args: { operation: 'admit_spv_result', stage_id: STAGE_ID, verdict: 'SPV_PASS', summary: 'approve' },
        code: 'RUNTIME.SCHEMA_MISMATCH',
      },
      {
        name: 'bad verdict (PASS)',
        args: {
          operation: 'admit_spv_result',
          stage_id: STAGE_ID,
          manifest_digest: digest,
          verdict: 'PASS',
          summary: 'approve',
        },
        code: 'RUNTIME.SCHEMA_MISMATCH',
      },
      {
        name: 'bad manifest_digest (not hex)',
        args: {
          operation: 'admit_spv_result',
          stage_id: STAGE_ID,
          manifest_digest: 'not-a-hex-digest',
          verdict: 'SPV_PASS',
          summary: 'approve',
        },
        code: 'RUNTIME.SCHEMA_MISMATCH',
      },
      {
        name: 'unsupported operation stage_plan',
        args: { operation: 'stage_plan', stage_id: STAGE_ID, manifest_digest: digest, verdict: 'SPV_PASS', summary: 'approve' },
        code: 'RUNTIME.SCHEMA_MISMATCH',
      },
      {
        name: 'unsupported operation admit_stage_plan',
        args: { operation: 'admit_stage_plan', stage_id: STAGE_ID, manifest_digest: digest, verdict: 'SPV_PASS', summary: 'approve' },
        code: 'RUNTIME.SCHEMA_MISMATCH',
      },
      {
        name: 'unsupported operation run_gate',
        args: { operation: 'run_gate', stage_id: STAGE_ID, manifest_digest: digest, verdict: 'SPV_PASS', summary: 'approve' },
        code: 'RUNTIME.SCHEMA_MISMATCH',
      },
      {
        name: 'unknown operation',
        args: { operation: 'frobnicate', stage_id: STAGE_ID, manifest_digest: digest, verdict: 'SPV_PASS', summary: 'approve' },
        code: 'RUNTIME.SCHEMA_MISMATCH',
      },
    ];

    for (const c of cases) {
      const before = snapshotTree(root);
      const output = await executePlan(plugin, root, c.args);
      expect(output, c.name).toContain('Status: failed');
      expect(output, c.name).toContain(c.code);
      expect(planReceipts(root).filter((r) => r.type === 'SPV_PASS'), c.name).toHaveLength(0);
      assertTreeIdenticalExcept(root, before, []);
      expectNoRuntimeDir(root);
    }
  });

  it('broken-chain: SPV admit fails closed with zero new receipts; status reports receipt_chain_valid:false', async () => {
    const plugin = await loadBuilt();
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-t03-broken-');
      const d = seedBrokenChain(r.root);
      return { root: r.root, digest: d };
    })();
    const before = snapshotTree(root);

    // A tampered STAGE_PLAN receipt fails self-digest verification, so it is
    // excluded from the valid reads and the stage is no longer derived
    // PLANNING — the SPV precheck refuses fail-closed (no receipt, no chain
    // access). This is the canonical broken-chain SPV refusal on S3.
    const spvOutput = await executePlan(plugin, root, {
      operation: 'admit_spv_result',
      stage_id: STAGE_ID,
      manifest_digest: digest,
      verdict: 'SPV_PASS',
      summary: 'approve',
    });
    expect(spvOutput).toContain('Status: failed');
    expect(spvOutput).toContain('DOMAIN.INVALID_TRANSITION');
    expect(spvOutput).toContain('expected PLANNING for SPV admit');
    // No new receipt on the broken chain.
    expect(planReceipts(root).filter((r) => r.type === 'SPV_PASS')).toHaveLength(0);
    assertTreeIdenticalExcept(root, before, []);
    expectNoRuntimeDir(root);

    // Status on the broken chain: bounded, receipt_chain_valid:false.
    const statusOutput = await executePlan(plugin, root, {
      operation: 'status',
      stage_id: STAGE_ID,
    });
    const data = extractDataLine(statusOutput);
    expect(data.receipt_chain_valid).toBe(false);
    expect(statusOutput).not.toContain('"payload"');
    assertTreeIdenticalExcept(root, before, []);
  });

  it('abort: pre-aborted → AbortError no write; post-completion → AbortError never ok PASS', async () => {
    const plugin = await loadBuilt();
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-t03-abort-');
      const d = seedPlanning(r.root);
      return { root: r.root, digest: d };
    })();
    const before = snapshotTree(root);

    // Pre-aborted caller → AbortError, no write.
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      await executePlan(
        plugin,
        root,
        {
          operation: 'admit_spv_result',
          stage_id: STAGE_ID,
          manifest_digest: digest,
          verdict: 'SPV_PASS',
          summary: 'approve',
        },
        controller.signal,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe('AbortError');
    expect(planReceipts(root).filter((r) => r.type === 'SPV_PASS')).toHaveLength(0);
    assertTreeIdenticalExcept(root, before, []);

    // Abort after handler completion → AbortError (never cancel-as-PASS).
    const postController = new AbortController();
    const tool = makePlanTool(plugin, makeContext(plugin, root), {
      status: () => {
        postController.abort();
        return successResult({
          data: { stage_id: STAGE_ID, stage_state: 'PLANNING', slices: [] },
        });
      },
    });
    let postThrown: unknown;
    try {
      await tool.execute(
        { operation: 'status', stage_id: STAGE_ID },
        makeToolContext(root, 'planner', postController.signal),
      );
    } catch (error) {
      postThrown = error;
    }
    expect(postThrown).toBeDefined();
    expect((postThrown as Error).name).toBe('AbortError');
    assertTreeIdenticalExcept(root, before, []);
  });

  it('validate outside-root path: HOST.PATH_OUTSIDE_PROJECT, no write', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree('s03c-t03-outside-');
    const tasksPath = writeTasksMd(root);
    const manifestPath = writeManifest(root);
    const outside = path.join(tmpdir(), `s03c-t03-outside-${Date.now()}.md`);
    writeFileSync(outside, '# outside\n', 'utf-8');
    const before = snapshotTree(root);
    try {
      const output = await executePlan(plugin, root, {
        operation: 'validate',
        tasks_path: outside,
        manifest_path: manifestPath,
      });
      expect(output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(output).toContain('Status: failed');
      assertTreeIdenticalExcept(root, before, []);
    } finally {
      rmSync(outside, { force: true });
    }
    void tasksPath;
  });
});

// ============================================================
// S2 validate regression on the BUILT seam (PO-S03-C-01 regression)
// ============================================================

describe('built seam: S2 validate regression vs CLI oracle (PO-S03-C-01 regression)', () => {
  it('valid fixture: plugin validate data deep-equals the CLI validate-stage JSON', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree('s03c-t03-val-ok-');
    const tasksPath = writeTasksMd(root);
    const manifestPath = writeManifest(root);
    const evidenceDir = path.join(root, 'delivery', 'stages', STAGE_ID, 'evidence');
    writeEvidence(root);

    const cliRes = spawnSync(
      process.execPath,
      [DIST_VALIDATE_CLI, tasksPath, manifestPath, evidenceDir],
      { encoding: 'utf-8', timeout: 30000 },
    );
    expect(cliRes.status).toBe(0);
    const cli = cliValidateJson(cliRes.stdout);

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'validate', tasks_path: tasksPath, manifest_path: manifestPath, evidence_dir: evidenceDir },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: ok');
    expect(extractDataLine(envelope.output)).toEqual(cli);
    assertTreeIdenticalExcept(root, before, []);
  });

  it('invalid fixture (unclosed marker): plugin validate data deep-equals the CLI validate-stage JSON', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree('s03c-t03-val-bad-');
    const tasksPath = writeTasksMd(root);
    writeFileSync(
      tasksPath,
      readFileSync(tasksPath, 'utf-8').replace('<!-- SLICE:S03-C:END -->', ''),
      'utf-8',
    );
    const manifestPath = writeManifest(root);

    const cliRes = spawnSync(
      process.execPath,
      [DIST_VALIDATE_CLI, tasksPath, manifestPath],
      { encoding: 'utf-8', timeout: 30000 },
    );
    expect(cliRes.status).toBe(1);
    const cli = cliValidateJson(cliRes.stdout);

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'validate', tasks_path: tasksPath, manifest_path: manifestPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(extractDataLine(envelope.output)).toEqual(cli);
    assertTreeIdenticalExcept(root, before, []);
  });
});

// ============================================================
// CV repair: SPV atomicity + summary contract
// (CV-S03-C-POSTWRITE-TOCTOU-001, repair_attempt 0)
// ============================================================

describe('CV repair: SPV atomicity + summary contract (CV-S03-C-POSTWRITE-TOCTOU-001)', () => {
  async function executePlan(
    plugin: BuiltEntry,
    root: string,
    args: Record<string, unknown>,
    abort: AbortSignal = new AbortController().signal,
  ): Promise<string> {
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(args, makeToolContext(root, 'planner', abort));
    return envelope.output;
  }

  it('summary is REQUIRED non-empty (CV counterexample 2): missing summary → wire RUNTIME.SCHEMA_MISMATCH, no receipt, CLI parity', async () => {
    const plugin = await loadBuilt();
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-repair-sum-');
      const d = seedPlanning(r.root);
      return { root: r.root, digest: d };
    })();
    const before = snapshotTree(root);

    const output = await executePlan(plugin, root, {
      operation: 'admit_spv_result',
      stage_id: STAGE_ID,
      manifest_digest: digest,
      verdict: 'SPV_PASS',
      // summary deliberately omitted — the wire must reject before the runtime.
    });
    expect(output).toContain('Status: failed');
    expect(output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(output).toContain('`summary` is required for operation "admit_spv_result"');
    expect(planReceipts(root).filter((r) => r.type === 'SPV_PASS')).toHaveLength(0);
    assertTreeIdenticalExcept(root, before, []);
    expectNoRuntimeDir(root);

    // CLI parity: the runtime oracle also refuses a request with an empty
    // summary (the runtime closed schema requires non-empty).
    const cli = admitRequest(
      { type: 'spv_result', stageId: STAGE_ID, manifestDigest: digest, summary: '' },
      root,
    );
    expect(cli.accepted).toBe(false);
    expect(cli.receipt_ref).toBeNull();
    expect(cli.findings.map((f) => f.code)).toEqual(['RUNTIME.SCHEMA_MISMATCH']);
  });

  it('concurrent duplicate admit: at most one SPV_PASS receipt (CV recheck item 2)', async () => {
    const plugin = await loadBuilt();
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-repair-race-');
      const d = seedPlanning(r.root);
      return { root: r.root, digest: d };
    })();
    const tool = makePlanTool(plugin, makeContext(plugin, root));

    // Two parallel admits on the SAME PLANNING fixture. The runtime admit
    // pipeline is synchronous, so the calls run sequentially; the second must
    // be refused by the duplicate/state precondition (stage no longer
    // PLANNING) → at most ONE SPV_PASS receipt.
    const results = await Promise.all([
      tool.execute(
        {
          operation: 'admit_spv_result',
          stage_id: STAGE_ID,
          manifest_digest: digest,
          verdict: 'SPV_PASS',
          summary: 'first',
        },
        makeToolContext(root),
      ),
      tool.execute(
        {
          operation: 'admit_spv_result',
          stage_id: STAGE_ID,
          manifest_digest: digest,
          verdict: 'SPV_PASS',
          summary: 'second',
        },
        makeToolContext(root),
      ),
    ]);
    const datas = results.map((r) => extractDataLine(r.output));
    expect(datas.filter((d) => d.accepted === true)).toHaveLength(1);
    expect(datas.filter((d) => d.accepted === false)).toHaveLength(1);
    expect(planReceipts(root).filter((r) => r.type === 'SPV_PASS')).toHaveLength(1);
    const refused = datas.find((d) => d.accepted === false);
    expect(refused?.receipt_ref).toBeNull();
    expect(
      verifyReceiptChain(path.join(root, '.proofloop', 'receipts', 'plan', STAGE_ID)).valid,
    ).toBe(true);
  });

  it('manifest swap before the runtime call: no write (pre-admission / digest-binding closure)', async () => {
    const plugin = await loadBuilt();
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-repair-preadmit-');
      const d = seedPlanning(r.root);
      return { root: r.root, digest: d };
    })();
    const manifestPath = path.join(root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
    const swapped = stageManifest();
    swapped.stage_goal = 'SWAPPED stage goal — content change → different digest';
    writeFileSync(manifestPath, JSON.stringify(swapped, null, 2), 'utf-8');
    const before = snapshotTree(root);

    const output = await executePlan(plugin, root, {
      operation: 'admit_spv_result',
      stage_id: STAGE_ID,
      manifest_digest: digest,
      verdict: 'SPV_PASS',
      summary: 'approve',
    });
    // A manifest change before/at the runtime call is refused (the runtime
    // digest binding is snapshot-at-admission) and NEVER writes a receipt.
    expect(output).toContain('Status: failed');
    expect(planReceipts(root).filter((r) => r.type === 'SPV_PASS')).toHaveLength(0);
    assertTreeIdenticalExcept(root, before, []);
    expectNoRuntimeDir(root);
  });

  it('manifest swap BETWEEN pre-admission verification and the runtime call: fails BEFORE any write (CV recheck item 1)', async () => {
    const plugin = await loadBuilt();
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-repair-between-');
      const d = seedPlanning(r.root);
      return { root: r.root, digest: d };
    })();
    const manifestPath = path.join(root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
    const swapped = stageManifest();
    swapped.stage_goal = 'SWAPPED between the pre-admission check and the admit';
    const before = snapshotTree(root);

    // Inject a swap AFTER the plugin's pre-admission verification and BEFORE
    // `admitSpvResult` via the documented test-only `beforeAdmit` seam, routed
    // through the REAL built factory + execute envelope (test-seam compliance).
    // The runtime's admission-time digest binding (snapshot semantics) refuses
    // the mismatched request digest and NEVER writes a receipt.
    const tool = makePlanToolWithSpvDeps(plugin, makeContext(plugin, root), {
      beforeAdmit: () => {
        writeFileSync(manifestPath, JSON.stringify(swapped, null, 2), 'utf-8');
      },
    });
    const envelope = await tool.execute(
      {
        operation: 'admit_spv_result',
        stage_id: STAGE_ID,
        manifest_digest: digest,
        verdict: 'SPV_PASS',
        summary: 'approve',
      },
      makeToolContext(root),
    );
    const data = extractDataLine(envelope.output);
    expect(data.accepted).toBe(false);
    expect(data.receipt_ref).toBeNull();
    expect(planReceipts(root).filter((r) => r.type === 'SPV_PASS')).toHaveLength(0);
    // The ONLY change is the injected manifest swap — no receipt, no state.
    assertTreeIdenticalExcept(root, before, [path.relative(root, manifestPath)]);
    expectNoRuntimeDir(root);
  });

  it('post-admission manifest swap: DIAGNOSTIC-ONLY warn, never accepted:false with a persisted receipt (CV counterexample 1)', async () => {
    const plugin = await loadBuilt();
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-repair-postadmit-');
      const d = seedPlanning(r.root);
      return { root: r.root, digest: d };
    })();
    const manifestPath = path.join(root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
    const swapped = stageManifest();
    swapped.stage_goal = 'SWAPPED after the runtime wrote the receipt';
    let swappedAfter = false;

    // Inject a swap AFTER `admitSpvResult` persisted the SPV_PASS receipt and
    // BEFORE the post-admission diagnostic re-verify via the documented
    // test-only `afterAdmit` seam, routed through the REAL built factory +
    // execute envelope. The admitted result must NOT flip to accepted:false (a
    // receipt was already persisted); the manifest change surfaces as a warn
    // diagnostic only.
    const tool = makePlanToolWithSpvDeps(plugin, makeContext(plugin, root), {
      afterAdmit: () => {
        writeFileSync(manifestPath, JSON.stringify(swapped, null, 2), 'utf-8');
        swappedAfter = true;
      },
    });
    const envelope = await tool.execute(
      {
        operation: 'admit_spv_result',
        stage_id: STAGE_ID,
        manifest_digest: digest,
        verdict: 'SPV_PASS',
        summary: 'approve',
      },
      makeToolContext(root),
    );
    expect(swappedAfter).toBe(true);
    const data = extractDataLine(envelope.output);
    // The admitted result is NEVER flipped and the receipt stays persisted.
    expect(data.accepted).toBe(true);
    expect(data.receipt_ref).toMatchObject({
      ref: expect.stringMatching(/^\.proofloop\/receipts\/plan\/S03\/[0-9a-f]{64}\.json$/),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(planReceipts(root).filter((r) => r.type === 'SPV_PASS')).toHaveLength(1);
    // The manifest change is a warn diagnostic — never an error-level flip.
    const findings = data.findings as Array<{ severity: string; code: string }>;
    const warns = findings.filter((f) => f.severity === 'warn');
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('abort observed AFTER the synchronous admit completed: AbortError propagates and the SPV_PASS receipt REMAINS as the completed durable outcome (S03-B-identical semantics)', async () => {
    const plugin = await loadBuilt();
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-diagnose-abort-');
      const d = seedPlanning(r.root);
      return { root: r.root, digest: d };
    })();
    const controller = new AbortController();
    const before = snapshotTree(root);

    // The `afterAdmit` TEST-ONLY seam aborts AFTER `admitSpvResult` persisted
    // the receipt but BEFORE the execute post-check. Node's single-threaded
    // synchronous execution means an AbortSignal callback can NEVER fire
    // mid-call in production — the abort is only observable at the execute
    // pre-check (before any write) or post-check (after the synchronous admit
    // completed). The post-completion abort → AbortError is the EXACT
    // S03-B-consistent semantics (stage.ts execute does the same): the
    // already-persisted receipt is the completed durable outcome and the
    // caller's abort does NOT retroactively un-write it (never cancel-as-PASS
    // — the admission itself completed before the abort was observed).
    const tool = makePlanToolWithSpvDeps(plugin, makeContext(plugin, root), {
      afterAdmit: () => {
        controller.abort();
      },
    });

    let thrown: unknown;
    try {
      await tool.execute(
        {
          operation: 'admit_spv_result',
          stage_id: STAGE_ID,
          manifest_digest: digest,
          verdict: 'SPV_PASS',
          summary: 'approve',
        },
        makeToolContext(root, 'planner', controller.signal),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe('AbortError');
    // The receipt is the completed durable outcome of the synchronous admit.
    expect(planReceipts(root).filter((r) => r.type === 'SPV_PASS')).toHaveLength(1);
    expect(
      verifyReceiptChain(path.join(root, '.proofloop', 'receipts', 'plan', STAGE_ID)).valid,
    ).toBe(true);
    // Only the SPV_PASS receipt appeared (the admit completed and persisted it).
    const after = snapshotTree(root);
    const newFiles = [...after.keys()].filter(
      (rel) => !before.has(rel) && !rel.startsWith('.proofloop/logs/'),
    );
    expect(newFiles).toHaveLength(1);
    expect(newFiles[0]).toMatch(/receipts\/plan\/S03\/[0-9a-f]{64}\.json$/);
    expectNoRuntimeDir(root);
  });

  it('runtime post-write failure: the plugin FAITHFULLY projects accepted:false + receipt_ref:null + findings (the runtime rolls the receipt back; no fabricated ref)', async () => {
    // The runtime `runAdmitPipeline` writes the receipt through the writer
    // port then verifies the chain; a post-write chain-verify failure returns
    // accepted:false / receipt_ref:null AND rolls the just-written receipt
    // back (S3-REVIEW-002 / OUT-S3-04 — chain failure → 不写 Receipt). This is
    // RUNTIME semantics — the plugin MUST NOT itself roll back a
    // runtime-written receipt (no direct receipt manipulation) and MUST
    // surface the runtime's canonical AdmitResult faithfully. Reproduce the
    // exact scenario at the runtime level with a writer whose PRE-write
    // verify passes and POST-write verify fails (the write itself is the real
    // kernel writer).
    const { root, digest } = (() => {
      const r = makeWorktree('s03c-diagnose-postwrite-');
      const d = seedPlanning(r.root);
      return { root: r.root, digest: d };
    })();

    let verifyCalls = 0;
    const flakyWriter: ReceiptWriterPort = {
      write: (data, options) => defaultReceiptWriter.write(data, options),
      verifyChain: (receiptDir) => {
        verifyCalls += 1;
        if (verifyCalls === 1) {
          // Pre-write chain verification passes — the pipeline proceeds.
          return { valid: true, receipts: [] };
        }
        // Post-write chain verification fails — the runtime reports the
        // integrity failure and rolls back the just-written receipt.
        return {
          valid: false,
          receipts: [],
          brokenLink: { index: 0, expected: 'pre-write-tip', actual: 'post-write-tip' },
        };
      },
    };

    const admit = admitSpvResult(
      { type: 'spv_result', stageId: STAGE_ID, manifestDigest: digest, summary: 'approve' },
      { projectRoot: root, writer: flakyWriter },
    );
    expect(verifyCalls).toBe(2);
    expect(admit.accepted).toBe(false);
    expect(admit.receipt_ref).toBeNull();
    // Rollback succeeded → the ORIGINAL reject with a single finding.
    expect(admit.findings.map((f) => f.code)).toEqual(['RUNTIME.RECEIPT_CHAIN_BROKEN']);

    // The PLUGIN's projection of this runtime failure is faithful: ok:false,
    // data.receipt_ref null, refs empty, findings present — no fabricated
    // receipt_ref; the plugin itself performs no receipt manipulation.
    const projected = projectPlanSpvAdmitToolResult(admit, STAGE_ID);
    expect(projected.ok).toBe(false);
    expect((projected.data as { receipt_ref: unknown }).receipt_ref).toBeNull();
    expect(projected.refs).toEqual([]);
    expect(projected.findings.map((f) => f.code)).toEqual(['RUNTIME.RECEIPT_CHAIN_BROKEN']);
    expect((projected.data as { findings: Array<{ code: string }> }).findings[0].code).toBe(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
    );
    // The runtime wrote the receipt (real writer) then rolled it back after
    // the integrity failure (S3-REVIEW-002) — no SPV_PASS receipt remains,
    // and the plugin did NOT perform the removal itself (no direct receipt
    // access in the plugin sources).
    expect(planReceipts(root).filter((r) => r.type === 'SPV_PASS')).toHaveLength(0);
  });
});
