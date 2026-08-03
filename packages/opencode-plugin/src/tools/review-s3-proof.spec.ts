/**
 * @proofloop/opencode-plugin — proofloop_review S3 full proof matrix on the
 * BUILT host seam (S03-D-T03).
 *
 * PO: PO-S03-D-01..05 closure on the REAL built host seam:
 *   - PO-S03-D-01: the built `createReviewTool(...).execute` host envelope
 *     accepts stage_status | prepare_stage_review | finalize_stage_review and
 *     rejects project/gate/unknown operations;
 *   - PO-S03-D-02: built-host prepare assembles the ref-only `review_scope:
 *     stage` ReviewInput from canonical persisted facts (each field verified
 *     against independent manifest/git/receipt reads), is read-only, and
 *     reports absent gate/CV refs honestly or fails closed on a broken chain;
 *   - PO-S03-D-03: built-host finalize ACCEPTED writes one STAGE_REVIEW_PASS
 *     to review/<stage>/ with a valid chain, fresh reconcile derives
 *     COMPLETED, CLI parity (frozen time → identical bytes), wrong-state /
 *     duplicate / missing-summary refuse with no Receipt;
 *   - PO-S03-D-04: built-host finalize REPAIR is the legal accepted no-Receipt
 *     branch (null ref, warn DOMAIN.INVALID_TRANSITION, in-memory new_state
 *     EXECUTING, review category untouched, fresh reconcile stays UNDER_REVIEW)
 *     with CLI parity;
 *   - PO-S03-D-05: invalid schema / trust-root / tampered chain / wrong state
 *     / unsupported operation / abort fail closed with
 *     `.proofloop/receipts/**` + `.proofloop/runtime/**` byte-identical (logs
 *     excepted); S2 `stage_status` output stays character-identical to
 *     `proofloop_stage(status)` with the FR-012 budget (≤1000 / ≤20).
 *
 * Seam: loads the BUILT plugin entry (`packages/opencode-plugin/dist/index.js`)
 * through a file URL (the same host-load seam as the S2 `test/opencode-*.spec.ts`
 * suites), assembles a REAL RuntimeContext from the built
 * `createRuntimeContext` and executes the REAL built
 * `createReviewTool(...).execute` host `{ output }` envelope against real temp
 * git worktrees with real receipts. The built plugin is rebuilt in beforeAll.
 *
 * UNDER_REVIEW fixture construction (minimal persisted-fact set the runtime
 * derives UNDER_REVIEW from — stage-state.ts: STAGE_PLAN + SPV_PASS + every
 * slice integrated + no STAGE_REVIEW_PASS): STAGE_PLAN → SPV_PASS →
 * worker(finalize-slice) → CV_PASS → SLICE_COMMIT → INTEGRATION_PASS. The
 * stage gate (GATE_PASS) is NOT required by deriveStageState (it is an S5
 * concern); the production tool exposes no run_gate operation.
 */

import { describe, expect, it, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  admitCVResult,
  admitIntegration,
  admitSliceCommit,
  admitSpvResult,
  admitStagePlan,
  admitWorkerResult,
  manifestFileDigest,
  readReceiptCategory,
  reconcileStage,
} from '@proofloop/runtime';
import type { AdmissionDeps, SpvGateAdmissionDeps } from '@proofloop/runtime';
import { admitRequest } from '@proofloop/runtime/dist/cli/admit.js';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-D';
const TASKS: readonly string[] = ['S03-D-T01', 'S03-D-T02', 'S03-D-T03'];
const FROZEN_NOW = new Date('2026-08-03T00:00:00.000Z');
const FIXED_ACTION_TOKEN = 'tok-proof-t03';

const DIST_ENTRY = path.join(
  process.cwd(),
  'packages',
  'opencode-plugin',
  'dist',
  'index.js',
);

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

beforeAll(() => {
  execFileSync(
    'npm',
    ['exec', '--', 'tsc', '-b', 'packages/kernel', 'packages/runtime', 'packages/opencode-plugin'],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
  expect(existsSync(DIST_ENTRY)).toBe(true);
});

/** Deterministic git commit environment (fixed dates → identical SHAs across fixtures). */
function gitCommitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_AUTHOR_DATE: '2026-08-03T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-08-03T00:00:00Z',
  };
}

// ============================================================
// Fixture (real temp git worktree + canonical layout)
// ============================================================

interface ProofFx {
  readonly root: string;
  write(rel: string, content: string): void;
  writeManifest(riskFacts?: readonly string[]): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean): void;
  commitAll(message?: string): string;
  cleanup(): void;
}

function makeFx(): ProofFx {
  const root = mkdtempSync(path.join(tmpdir(), 's03d-t03-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03d@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03D Proof']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });

  const sliceDef = (sid: string, taskIds: readonly string[]): ManifestSlice => ({
    slice_id: sid,
    goal: 'Reviewer 准备并受理 Stage Review',
    observable_outcome: 'prepare/finalize through the built review host seam',
    public_seam: 'Hooks.tool.proofloop_review',
    dependencies: [],
    proof_obligations: [
      {
        po_id: 'PO-S03-D-01',
        behavior: 'review operations accepted with closed validation',
        public_seam: 'built review tool execute',
        oracle_source: 'real fixture project',
        success_criteria: 'structured result + no write on reject',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['persistent_state', 'core_state_machine'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/${STAGE_ID}/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  });

  const fx: ProofFx = {
    root,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: (riskFacts = ['core_state_machine', 'irreversible_operation']) => {
      const manifest: Manifest = {
        stage_id: STAGE_ID,
        source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'S3 stage review via the built review tool seam',
        outcomes: [
          'prepare returns a ref-only stage ReviewInput',
          'finalize admits ACCEPTED/REPAIR',
        ],
        slices: [sliceDef(SLICE_ID, TASKS)],
        dependencies: [],
        risk_facts: [...riskFacts],
      };
      fx.write(`.proofloop/manifests/${STAGE_ID}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (checkedTasks) => {
      const lines = TASKS.map((t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`);
      const content =
        `# Stage ${STAGE_ID} — S3 Review\n\n` +
        `## Slice ${SLICE_ID}\n<!-- SLICE:${SLICE_ID}:BEGIN -->\n\n### Tasks\n\n${lines.join('\n')}\n\n` +
        `<!-- SLICE:${SLICE_ID}:END -->\n`;
      fx.write(`delivery/stages/${STAGE_ID}/tasks.md`, content);
    },
    writeEvidence: (finalized) => {
      const content =
        `# Slice ${SLICE_ID} Evidence\n\n## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S03-D-01 | review-s3-proof.spec.ts | yes | yes | pass |\n\n` +
            `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
          : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| *None* | | | | |\n`);
      fx.write(`delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`, content);
    },
    commitAll: (message = 'baseline') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message], {
        env: gitCommitEnv(),
      });
      return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
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

/** Worker envelope for fixture prerequisite admits (finalize-slice, FIXED token). */
function makeEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionToken: FIXED_ACTION_TOKEN,
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: 'S03-D-T01',
    mode: 'finalize-slice',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    changedFiles: ['packages/opencode-plugin/src/tools/review.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 't03 worker',
  };
}

/**
 * Build a stage in UNDER_REVIEW (minimal persisted-fact set the runtime
 * derives UNDER_REVIEW from): STAGE_PLAN → SPV_PASS → worker(finalize-slice)
 * → CV_PASS → SLICE_COMMIT → INTEGRATION_PASS. The stage gate is NOT required
 * by deriveStageState (GATE_PASS is an S5 concern).
 */
function buildUnderReview(fx: ProofFx): { manifestDigest: string } {
  const head = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();
  const manifestDigest = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });
  const deps: AdmissionDeps = { projectRoot: fx.root };
  const spvDeps: SpvGateAdmissionDeps = { projectRoot: fx.root };

  const plan = admitStagePlan(
    { type: 'stage_plan', stageId: STAGE_ID, manifestDigest },
    deps,
  );
  expect(plan.accepted).toBe(true);
  const spv = admitSpvResult(
    { type: 'spv_result', stageId: STAGE_ID, manifestDigest, summary: 'spv ok' },
    spvDeps,
  );
  expect(spv.accepted).toBe(true);
  const worker = admitWorkerResult(
    { type: 'worker_result', envelope: makeEnvelope() as never },
    deps,
  );
  expect(worker.accepted).toBe(true);
  const cv = admitCVResult(
    { type: 'cv_result', stageId: STAGE_ID, sliceId: SLICE_ID, verdict: 'PASS', snapshotDigest: head, summary: 'cv pass' },
    deps,
  );
  expect(cv.accepted).toBe(true);
  const cvDigest = cv.receipt_ref as string;
  const commit = admitSliceCommit(
    { type: 'slice_commit', stageId: STAGE_ID, sliceId: SLICE_ID, commitSha: head, cvReceiptDigest: cvDigest },
    deps,
  );
  expect(commit.accepted).toBe(true);
  const integration = admitIntegration(
    { type: 'integration', stageId: STAGE_ID, sliceId: SLICE_ID, commitSha: head },
    deps,
  );
  expect(integration.accepted).toBe(true);

  expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
    'UNDER_REVIEW',
  );
  return { manifestDigest };
}

/** Baseline fixture (manifest + tasks checked + evidence finalized + commit). */
function baselineFx(): ProofFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  fx.commitAll('baseline');
  return fx;
}

/** Plan-only fixture: STAGE_PLAN + SPV_PASS but no slice chain (stage EXECUTING). */
function planOnlyFx(): ProofFx {
  const fx = baselineFx();
  const manifestDigest = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });
  const deps: AdmissionDeps = { projectRoot: fx.root };
  const spvDeps: SpvGateAdmissionDeps = { projectRoot: fx.root };
  const plan = admitStagePlan(
    { type: 'stage_plan', stageId: STAGE_ID, manifestDigest },
    deps,
  );
  expect(plan.accepted).toBe(true);
  const spv = admitSpvResult(
    { type: 'spv_result', stageId: STAGE_ID, manifestDigest, summary: 'spv ok' },
    spvDeps,
  );
  expect(spv.accepted).toBe(true);
  expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
    'EXECUTING',
  );
  return fx;
}

// ============================================================
// Built host-load helpers
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

function makeToolContext(root: string, abort: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: 'sess-s03d-t03',
    messageID: 'msg-s03d-t03',
    agent: 'stage-reviewer',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

type BuiltEntry = {
  default?: unknown;
  server?: unknown;
  [key: string]: unknown;
};

type BuiltExecuteTool = {
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<{ output: string }>;
};

async function loadBuilt(): Promise<BuiltEntry> {
  return (await import(pathToFileURL(DIST_ENTRY).href)) as BuiltEntry;
}

function makeBuiltReviewTool(plugin: BuiltEntry, root: string): BuiltExecuteTool {
  const createCtx = plugin['createRuntimeContext'] as (input: unknown) => RuntimeContext;
  const factory = plugin['createReviewTool'] as (context: RuntimeContext) => BuiltExecuteTool;
  return factory(createCtx(makeInput(root)));
}

function makeBuiltStageTool(plugin: BuiltEntry, root: string): BuiltExecuteTool {
  const createCtx = plugin['createRuntimeContext'] as (input: unknown) => RuntimeContext;
  const factory = plugin['createStageTool'] as (context: RuntimeContext) => BuiltExecuteTool;
  return factory(createCtx(makeInput(root)));
}

/** Extract the canonical ToolResult `data` projection from the host output. */
function parseData(output: string): Record<string, unknown> {
  const line = output.split('\n').find((l) => l.startsWith('Data: '));
  expect(line, `expected a Data: line in:\n${output}`).toBeDefined();
  return JSON.parse(line!.slice('Data: '.length)) as Record<string, unknown>;
}

function gitHead(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

function gitBranch(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();
}

function readReceiptFiles(dir: string): any[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')));
}

function reviewReceipts(root: string): any[] {
  return readReceiptFiles(path.join(root, '.proofloop', 'receipts', 'review', STAGE_ID));
}

/** Recursively snapshot `.proofloop/receipts/**` + `.proofloop/runtime/**`. */
function snapshotProtected(root: string): Map<string, string> {
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

/** Extract the compact status block between a marker and Findings/Data. */
function extractBlock(output: string, marker: string): string {
  const idx = output.indexOf(`${marker}\n`);
  if (idx < 0) return '';
  const start = idx + marker.length + 1;
  const endMatch = output.slice(start).match(/\nFindings|\nData: /);
  const end = endMatch ? start + endMatch.index! : output.length;
  return output.slice(start, end);
}

// ============================================================
// PO-S03-D-01 — built host seam + prepare matrix (PO-S03-D-02)
// ============================================================

describe('built host seam: prepare matrix (PO-S03-D-01/02)', () => {
  it('built-host prepare assembles the ref-only ReviewInput, verifiable against independent oracles, and NEVER writes', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    const plugin = await loadBuilt();
    try {
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope: 'stage' },
        makeToolContext(fx.root),
      );
      const after = snapshotProtected(fx.root);
      expectProtectedIdentical(before, after);

      expect(envelope.output).toContain('ProofLoop Review');
      expect(envelope.output).toContain('Operation: prepare_stage_review');
      expect(envelope.output).toContain('Status: ok');
      expect(envelope.output).toContain('Review input:');
      const data = parseData(envelope.output);

      // review_scope + Manifest-sourced facts vs independent reads.
      expect(data['review_scope']).toBe('stage');
      expect(data['stage_id']).toBe(STAGE_ID);
      expect(data['stage_goal']).toBe('S3 stage review via the built review tool seam');
      expect((data['stage_outcomes'] as unknown[]).length).toBeGreaterThan(0);
      expect(data['risk_facts']).toEqual(['core_state_machine', 'irreversible_operation']);
      expect(data['manifest_digest']).toBe(
        manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID }),
      );
      // Root-bound relative paths + git facts.
      expect(data['tasks_path']).toBe(`delivery/stages/${STAGE_ID}/tasks.md`);
      expect(data['manifest_path']).toBe(`.proofloop/manifests/${STAGE_ID}.json`);
      expect(data['branch']).toBe(gitBranch(fx.root));
      expect(data['snapshot']).toBe(gitHead(fx.root));
      // Per-slice CV ref (ref-only) vs the independent cv category read.
      const cv = readReceiptCategory({
        projectRoot: fx.root,
        category: 'cv',
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
      });
      const cvRefs = data['cv_receipt_refs'] as Array<{ ref: string; digest: string }>;
      expect(cvRefs).toHaveLength(1);
      expect(cvRefs[0].digest).toBe(cv.latest?.receipt.digest);
      expect(cvRefs[0].ref).toBe(
        `.proofloop/receipts/cv/${STAGE_ID}/${SLICE_ID}/${cv.latest?.receipt.digest}.json`,
      );
      // Risk/clean-room facts.
      expect(data['risk_level']).toBe('critical');
      expect(data['clean_room']).toBe(true);
      // No verdict, no Receipt body, ref-only entries.
      const serialized = JSON.stringify(data);
      expect('verdict' in data).toBe(false);
      expect(serialized).not.toContain('"payload"');
      expect(serialized).not.toContain('"timestamp"');
      expect(serialized).not.toContain('"signature"');
    } finally {
      fx.cleanup();
    }
  });

  it('built-host prepare reports honest absence for a fixture with no gate/CV receipts (read-only)', async () => {
    const fx = planOnlyFx(); // stage EXECUTING — no CV, no gate receipts
    const plugin = await loadBuilt();
    try {
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: ok');
      const data = parseData(envelope.output);
      // Absent gate/CV refs are persisted facts — honest absence, not a guess.
      expect(data['stage_gate_receipt_ref']).toBeNull();
      expect(data['cv_receipt_refs']).toEqual([]);
      expect(data['review_scope']).toBe('stage');
    } finally {
      fx.cleanup();
    }
  });

  it('built-host prepare fails closed on a tampered stage-gate chain (no write)', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    // Add a gate receipt then tamper it so the stage-gate category chain breaks.
    const gateDir = path.join(fx.root, '.proofloop', 'receipts', 'stage-gate', STAGE_ID);
    mkdirSync(gateDir, { recursive: true });
    fs.writeFileSync(
      path.join(gateDir, `${'f'.repeat(64)}.json`),
      JSON.stringify({
        version: 1,
        type: 'GATE_PASS',
        stage_id: STAGE_ID,
        timestamp: '2026-08-03T00:00:00.000Z',
        digest: 'f'.repeat(64),
        payload: { verdict: 'PASS' },
      }),
    );
    const plugin = await loadBuilt();
    try {
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('RUNTIME.RECEIPT_CHAIN_BROKEN');
    } finally {
      fx.cleanup();
    }
  });
});

// ============================================================
// PO-S03-D-03 — built host finalize ACCEPTED matrix
// ============================================================

describe('built host seam: finalize ACCEPTED matrix (PO-S03-D-03)', () => {
  it('built-host ACCEPTED writes one STAGE_REVIEW_PASS, chain-valid, fresh reconcile COMPLETED', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    const plugin = await loadBuilt();
    try {
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: ok');
      const data = parseData(envelope.output);
      expect(data['accepted']).toBe(true);
      const receiptRef = data['receipt_ref'] as { ref: string; digest: string } | null;
      expect(receiptRef?.ref).toBe(
        `.proofloop/receipts/review/${STAGE_ID}/${receiptRef?.digest}.json`,
      );
      // Receipt type/payload in the canonical review category.
      const receipts = reviewReceipts(fx.root);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].type).toBe('STAGE_REVIEW_PASS');
      expect(receipts[0].digest).toBe(receiptRef?.digest);
      expect(receipts[0].payload).toEqual({ verdict: 'ACCEPTED', summary: 'accept' });
      // Review category chain valid + fresh reconcile derives COMPLETED.
      const review = readReceiptCategory({
        projectRoot: fx.root,
        category: 'review',
        stageId: STAGE_ID,
      });
      expect(review.chainValid).toBe(true);
      expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
        'COMPLETED',
      );
    } finally {
      fx.cleanup();
    }
  });

  it('built-host ACCEPTED is CLI-parity (frozen time → identical receipt bytes)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    try {
      const cliFx = baselineFx();
      buildUnderReview(cliFx);
      const pluginFx = baselineFx();
      buildUnderReview(pluginFx);
      const plugin = await loadBuilt();
      try {
        const cli = admitRequest(
          { type: 'stage_review', stageId: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
          cliFx.root,
        );
        const tool = makeBuiltReviewTool(plugin, pluginFx.root);
        const envelope = await tool.execute(
          { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
          makeToolContext(pluginFx.root),
        );
        const pluginData = parseData(envelope.output);
        expect(cli.accepted).toBe(true);
        expect(pluginData['accepted']).toBe(true);
        const cliDigest = cli.receipt_ref as string;
        expect((pluginData['receipt_ref'] as { digest: string }).digest).toBe(cliDigest);
        expect(pluginData['findings']).toEqual(cli.findings);
        expect(snapshotProtected(pluginFx.root)).toEqual(snapshotProtected(cliFx.root));
      } finally {
        cliFx.cleanup();
        pluginFx.cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('built-host ACCEPTED on a non-UNDER_REVIEW stage fails closed with no Receipt', async () => {
    const fx = baselineFx(); // no STAGE_PLAN → UNINITIALIZED
    const plugin = await loadBuilt();
    try {
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'x' },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('DOMAIN.INVALID_TRANSITION');
      expect(reviewReceipts(fx.root)).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  it('built-host duplicate finalize after ACCEPTED writes no second Receipt', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    const plugin = await loadBuilt();
    try {
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const first = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(fx.root),
      );
      expect(parseData(first.output)['accepted']).toBe(true);
      expect(reviewReceipts(fx.root)).toHaveLength(1);
      const before = snapshotProtected(fx.root);
      const second = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept again' },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(second.output).toContain('Status: failed');
      expect(second.output).toContain('DOMAIN.INVALID_TRANSITION');
      expect(reviewReceipts(fx.root)).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  it('built-host missing/empty summary fails closed with no Receipt', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    const plugin = await loadBuilt();
    try {
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: '' },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expect(reviewReceipts(fx.root)).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});

// ============================================================
// PO-S03-D-04 — built host finalize REPAIR matrix
// ============================================================

describe('built host seam: finalize REPAIR matrix (PO-S03-D-04)', () => {
  it('built-host REPAIR is the legal no-Receipt branch: accepted, null ref, warn finding, persisted facts unchanged', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    const plugin = await loadBuilt();
    try {
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'REPAIR', summary: 'reopen' },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: ok');
      const data = parseData(envelope.output);
      expect(data['accepted']).toBe(true);
      expect(data['receipt_ref']).toBeNull();
      const findings = data['findings'] as Array<{ code: string; severity: string }>;
      expect(findings.some((f) => f.code === 'DOMAIN.INVALID_TRANSITION' && f.severity === 'warn')).toBe(true);
      // In-memory new_state reflects the reopen target; persisted facts stay.
      expect((data['new_state'] as { stage_state?: string } | null)?.stage_state).toBe('EXECUTING');
      expect(reviewReceipts(fx.root)).toHaveLength(0);
      expect(existsSync(path.join(fx.root, '.proofloop', 'receipts', 'review'))).toBe(false);
      expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
        'UNDER_REVIEW',
      );
    } finally {
      fx.cleanup();
    }
  });

  it('built-host REPAIR is CLI-parity (frozen time)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    try {
      const cliFx = baselineFx();
      buildUnderReview(cliFx);
      const pluginFx = baselineFx();
      buildUnderReview(pluginFx);
      const plugin = await loadBuilt();
      try {
        const cli = admitRequest(
          { type: 'stage_review', stageId: STAGE_ID, verdict: 'REPAIR', summary: 'reopen' },
          cliFx.root,
        );
        const tool = makeBuiltReviewTool(plugin, pluginFx.root);
        const envelope = await tool.execute(
          { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'REPAIR', summary: 'reopen' },
          makeToolContext(pluginFx.root),
        );
        const pluginData = parseData(envelope.output);
        expect(cli.accepted).toBe(true);
        expect(pluginData['accepted']).toBe(true);
        expect(cli.receipt_ref).toBeNull();
        expect(pluginData['receipt_ref']).toBeNull();
        const cliFindings = cli.findings as unknown as Array<{ code: string; severity: string }>;
        const pluginFindings = pluginData['findings'] as Array<{ code: string; severity: string }>;
        expect(cliFindings.map((f) => f.code)).toEqual(pluginFindings.map((f) => f.code));
        expect(pluginFindings.map((f) => f.code)).toEqual(['DOMAIN.INVALID_TRANSITION']);
        expect(reviewReceipts(cliFx.root)).toHaveLength(0);
        expect(reviewReceipts(pluginFx.root)).toHaveLength(0);
      } finally {
        cliFx.cleanup();
        pluginFx.cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================
// PO-S03-D-05 — built host fail-closed matrix
// ============================================================

describe('built host seam: fail-closed matrix (PO-S03-D-05)', () => {
  it('invalid schema / unsupported operations leave receipts + state byte-identical', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    const plugin = await loadBuilt();
    try {
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const battery: Array<Record<string, unknown>> = [
        { operation: 'prepare_project_review', stage_id: STAGE_ID },
        { operation: 'finalize_project_review', stage_id: STAGE_ID },
        { operation: 'project_status', stage_id: STAGE_ID },
        { operation: 'run_gate', stage_id: STAGE_ID },
        { operation: 'admit_gate_result', stage_id: STAGE_ID },
        { operation: 'admit_gate_interrupted', stage_id: STAGE_ID },
        { operation: 'bogus_operation', stage_id: STAGE_ID },
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope: 'project' },
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'PASS', summary: 's' },
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED' },
        { operation: 'stage_status', stage_id: STAGE_ID, scope: 'stage' },
        { operation: 'stage_status', stage_id: '../../../../tmp/attacker' },
        { operation: 'stage_status', stage_id: STAGE_ID, project_root: '/tmp/not-the-root' },
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED' },
      ];
      for (const args of battery) {
        const envelope = await tool.execute(args, makeToolContext(fx.root));
        expect(envelope.output, `op ${String(args['operation'])}`).toContain('Status: failed');
        // Canonical fail-closed Finding: schema mismatch or the trust-root
        // violation (project_root mismatch → HOST.PROJECT_NOT_TRUSTED).
        expect(
          envelope.output.includes('RUNTIME.SCHEMA_MISMATCH') ||
            envelope.output.includes('HOST.PROJECT_NOT_TRUSTED'),
          `op ${String(args['operation'])} canonical Finding`,
        ).toBe(true);
      }
      expectProtectedIdentical(before, snapshotProtected(fx.root));
    } finally {
      fx.cleanup();
    }
  });

  it('a tampered CV chain fails closed for prepare and finalize with no write', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    const plugin = await loadBuilt();
    try {
      // Tamper the CV category: write a bogus self-digest receipt so the CV
      // chain breaks → reconcile blocks CV facts and reports chain-broken.
      const cvDir = path.join(fx.root, '.proofloop', 'receipts', 'cv', STAGE_ID, SLICE_ID);
      fs.writeFileSync(
        path.join(cvDir, `${'e'.repeat(64)}.json`),
        JSON.stringify({
          version: 1,
          type: 'CV_PASS',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          timestamp: '2026-08-03T00:00:00.000Z',
          digest: 'e'.repeat(64),
          payload: { verdict: 'PASS', snapshot_digest: 'c'.repeat(64), summary: 'tampered' },
        }),
      );
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);

      const prep = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expect(prep.output).toContain('Status: failed');
      expect(prep.output).toContain('RUNTIME.RECEIPT_CHAIN_BROKEN');

      const fin = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'x' },
        makeToolContext(fx.root),
      );
      expect(fin.output).toContain('Status: failed');

      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(reviewReceipts(fx.root)).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  it('a tampered review-category receipt fails closed for a subsequent finalize with no write', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    const plugin = await loadBuilt();
    try {
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const first = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(fx.root),
      );
      expect(parseData(first.output)['accepted']).toBe(true);
      expect(reviewReceipts(fx.root)).toHaveLength(1);

      // Tamper the single review receipt's content (self-digest now invalid).
      const reviewDir = path.join(fx.root, '.proofloop', 'receipts', 'review', STAGE_ID);
      const receiptFile = readdirSync(reviewDir).find((f) => f.endsWith('.json'))!;
      const receiptPath = path.join(reviewDir, receiptFile);
      const original = JSON.parse(readFileSync(receiptPath, 'utf-8')) as Record<string, unknown>;
      fs.writeFileSync(
        receiptPath,
        JSON.stringify({ ...original, payload: { verdict: 'ACCEPTED', summary: 'tampered' } }),
      );

      const before = snapshotProtected(fx.root);
      const second = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'again' },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(second.output).toContain('Status: failed');
      expect(reviewReceipts(fx.root)).toHaveLength(1);
      expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).not.toBe(
        'COMPLETED',
      );
    } finally {
      fx.cleanup();
    }
  });

  it('aborted calls propagate AbortError and never write', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    const plugin = await loadBuilt();
    try {
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      // Pre-aborted prepare.
      const controller = new AbortController();
      controller.abort();
      let thrown: unknown;
      try {
        await tool.execute(
          { operation: 'prepare_stage_review', stage_id: STAGE_ID },
          makeToolContext(fx.root, controller.signal),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as Error).name).toBe('AbortError');
      expectProtectedIdentical(before, snapshotProtected(fx.root));
    } finally {
      fx.cleanup();
    }
  });
});

// ============================================================
// PO-S03-D-05 — S2 stage_status consistency + budget on the built seam
// ============================================================

describe('built host seam: stage_status consistency + budget (PO-S03-D-05)', () => {
  it('built-host stage_status deep-equals proofloop_stage(status); summary ≤1000; findings ≤20; read-only', async () => {
    const fx = baselineFx();
    buildUnderReview(fx);
    const plugin = await loadBuilt();
    try {
      const before = snapshotProtected(fx.root);
      const reviewTool = makeBuiltReviewTool(plugin, fx.root);
      const stageTool = makeBuiltStageTool(plugin, fx.root);
      const reviewEnvelope = await reviewTool.execute(
        { operation: 'stage_status', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      const stageEnvelope = await stageTool.execute(
        { operation: 'status', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));

      // Character-identical status block (the shared stageStatusHandler).
      const reviewBlock = extractBlock(reviewEnvelope.output, 'Stage status:');
      const stageBlock = extractBlock(stageEnvelope.output, 'Stage status:');
      expect(reviewBlock).toBe(stageBlock);
      expect(reviewBlock.length).toBeGreaterThan(0);
      expect(reviewBlock.length).toBeLessThanOrEqual(1000);
      // Findings capped at the 20-entry budget.
      const findingsMatch = reviewEnvelope.output.match(/Findings \((\d+)\):/);
      const count = Number(findingsMatch?.[1] ?? 0);
      expect(count).toBeLessThanOrEqual(20);
      // Read-only review status: no Receipt payload leaks.
      expect(reviewEnvelope.output).not.toContain('latest_cv_receipt');
      expect(reviewEnvelope.output).not.toContain('"payload"');
    } finally {
      fx.cleanup();
    }
  });
});
