/**
 * @proofloop/opencode-plugin — proofloop_stage S3 full proof matrix on the
 * BUILT host seam (S03-B-T03).
 *
 * PO: PO-S03-B-04 (primary — Receipt persistence strictly through
 * `runAdmitPipeline`'s validate → reconcile → precheck → writer → post-write
 * chain verify; invalid/reject/chain-broken/abort branches produce NO new
 * Receipt; a success result never leaks the Receipt payload), plus the full
 * matrix closure of PO-S03-B-01/02/03.
 *
 * Seam: loads the BUILT plugin entry (`packages/opencode-plugin/dist/index.js`)
 * through a file URL (the same host-load seam as the S2 `test/opencode-*.spec.ts`
 * suites), assembles a REAL RuntimeContext from the built `createRuntimeContext`
 * and executes the REAL built `createStageTool(...).execute` host `{ output }`
 * envelope against real temp git worktrees. The built plugin is rebuilt in
 * beforeAll (T03 adds the reusable admission seam exports to index.ts).
 *
 * Coverage:
 *   - Built-host seam: real worker/CV/commit/integration admits through the
 *     built factory + host envelope.
 *   - PO-S03-B-04 persistence proof: (a) a runtime-layer ReceiptWriterPort spy
 *     proves the pipeline routes persistence strictly through the port (the
 *     plugin source never calls writeReceipt directly — static guard below);
 *     (b) a tampered category chain fails closed with
 *     RUNTIME.RECEIPT_CHAIN_BROKEN and writes NO new Receipt; (c) schema /
 *     path / state failures and cancellation leave `.proofloop/receipts/**`
 *     + `.proofloop/runtime/**` byte-identical; (d) a success case is
 *     locatable, chain-valid (previous_digest links), with `refs` exactly
 *     `{ ref, digest }` and no Receipt body in the output.
 *   - Duplicate / wrong-state / digest-mismatch / abort matrix across the four
 *     ops on the built seam.
 *   - CLI failure-matrix parity: a refused admit's accepted/receipt_ref/
 *     findings codes+order deep-equal the runtime CLI `admitRequest` oracle.
 *   - Static guard: production admit sources contain no child_process / spawn /
 *     exec / dist-cli invocation and no direct writeReceipt / pipeline bypass.
 *   - Reusable admission output seam: the built entry exports the mapper, the
 *     AdmitResult/ReceiptRef projection and the path-guard helpers (with type
 *     exports); the mapper + projection are pure and usable by later slices.
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
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
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyReceiptChain } from '@proofloop/kernel';
import { admitWorkerResult, reconcileStage } from '@proofloop/runtime';
import type { ReceiptWriterPort, WorkerResultEnvelope } from '@proofloop/runtime';
import { admitRequest } from '@proofloop/runtime/dist/cli/admit.js';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { createStageTool } from './stage.js';
import type { StageToolArgsShape } from './stage.js';
import {
  mapHostArgsToAdmissionRequest,
  projectAdmitResultData,
  guardAdmitPathFields,
} from './stage-admit-common.js';
import type { StageAdmitOperation, StageAdmitWireArgs } from './stage-admit-common.js';
import { projectAdmitToolResult } from './stage-admit.js';

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-B';
const TASKS: readonly string[] = ['S03-B-T01', 'S03-B-T02', 'S03-B-T03'];

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

// ============================================================
// Fixture (real temp git worktree + canonical layout)
// ============================================================

interface ProofFx {
  readonly root: string;
  write(rel: string, content: string): void;
  writeManifest(): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean): void;
  commitAll(): string;
  reconcile(): ReturnType<typeof reconcileStage>;
  cleanup(): void;
}

function makeFx(): ProofFx {
  const root = mkdtempSync(path.join(tmpdir(), 's03b-proof-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03b@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03B Proof']);
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
        po_id: 'PO-S03-B-04',
        behavior: 'receipt persistence strictly through runAdmitPipeline',
        public_seam: 'built stage tool execute',
        oracle_source: 'real fixture project',
        success_criteria: 'chain valid + no-write on reject',
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
    writeManifest: () => {
      const manifest: Manifest = {
        stage_id: STAGE_ID,
        source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'S3 admission host boundary',
        outcomes: ['admit four result kinds'],
        slices: [sliceDef(SLICE_ID, TASKS)],
        dependencies: [],
        risk_facts: [],
      };
      fx.write(`.proofloop/manifests/${STAGE_ID}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (checkedTasks) => {
      const lines = TASKS.map((t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`);
      fx.write(
        `delivery/stages/${STAGE_ID}/tasks.md`,
        `# Stage ${STAGE_ID} — S3 Admission\n\n## Slice ${SLICE_ID}\n<!-- SLICE:${SLICE_ID}:BEGIN -->\n\n### Tasks\n\n${lines.join('\n')}\n\n<!-- SLICE:${SLICE_ID}:END -->\n`,
      );
    },
    writeEvidence: (finalized) => {
      const content =
        `# Slice ${SLICE_ID} Evidence\n\n## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S03-B-04 | stage-admit-proof.spec.ts | yes | yes | pass |\n\n` +
            `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
          : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| *None* | | | | |\n`);
      fx.write(`delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`, content);
    },
    commitAll: () => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'baseline']);
      return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf-8',
      }).trim();
    },
    reconcile: () => reconcileStage({ projectRoot: root, stageId: STAGE_ID }),
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

/** Baseline fixture: manifest + all tasks checked + finalized evidence. */
function fxBaseline(): ProofFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  fx.commitAll();
  return fx;
}

// ============================================================
// Host seam helpers
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

function makeToolContext(root: string, abort: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: 'sess-s03b-t03',
    messageID: 'msg-s03b-t03',
    agent: 'executor',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

type StageExecuteTool = {
  args: StageToolArgsShape;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<{ output: string }>;
};

/** In-process factory tool (used for the direct seam + writer-spy checks). */
function makeTool(root: string, handlers?: Parameters<typeof createStageTool>[1]): StageExecuteTool {
  return createStageTool(makeContext(root), handlers) as unknown as StageExecuteTool;
}

/** Built-factory tool (the BUILT plugin entry — the primary T03 seam). */
type BuiltEntry = {
  default?: unknown;
  server?: unknown;
  [key: string]: unknown;
};

async function loadBuilt(): Promise<BuiltEntry> {
  return (await import(pathToFileURL(DIST_ENTRY).href)) as BuiltEntry;
}

function makeBuiltStageTool(plugin: BuiltEntry, root: string): StageExecuteTool {
  const createCtx = plugin['createRuntimeContext'] as (input: unknown) => RuntimeContext;
  const factory = plugin['createStageTool'] as (context: RuntimeContext) => StageExecuteTool;
  return factory(createCtx(makeInput(root)));
}

function parseData(output: string): Record<string, unknown> {
  const line = output.split('\n').find((l) => l.startsWith('Data: '));
  expect(line, `expected a Data: line in:\n${output}`).toBeDefined();
  return JSON.parse(line!.slice('Data: '.length)) as Record<string, unknown>;
}

function makeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionToken: `tok-${Math.random().toString(36).slice(2)}`,
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: 'S03-B-T01',
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    changedFiles: ['packages/opencode-plugin/src/tools/stage.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 't03 worker',
    ...overrides,
  };
}

function gitHead(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

async function workerAdmit(
  tool: StageExecuteTool,
  root: string,
  envelope: Record<string, unknown>,
): Promise<{ output: string; data: Record<string, unknown> }> {
  const result = await tool.execute(
    { operation: 'admit_worker_result', stage_id: STAGE_ID, slice_id: SLICE_ID, envelope },
    makeToolContext(root),
  );
  return { output: result.output, data: parseData(result.output) };
}

async function cvAdmit(
  tool: StageExecuteTool,
  root: string,
  verdict: 'PASS' | 'REPAIR',
  snapshotDigest: string,
): Promise<{ output: string; data: Record<string, unknown> }> {
  const result = await tool.execute(
    {
      operation: 'admit_cv_result',
      stage_id: STAGE_ID,
      slice_id: SLICE_ID,
      verdict,
      snapshot_digest: snapshotDigest,
      summary: `cv ${verdict}`,
    },
    makeToolContext(root),
  );
  return { output: result.output, data: parseData(result.output) };
}

async function commitAdmit(
  tool: StageExecuteTool,
  root: string,
  commitSha: string,
  cvReceiptDigest: string,
): Promise<{ output: string; data: Record<string, unknown> }> {
  const result = await tool.execute(
    {
      operation: 'admit_slice_commit',
      stage_id: STAGE_ID,
      slice_id: SLICE_ID,
      commit_sha: commitSha,
      cv_receipt_digest: cvReceiptDigest,
    },
    makeToolContext(root),
  );
  return { output: result.output, data: parseData(result.output) };
}

async function integrationAdmit(
  tool: StageExecuteTool,
  root: string,
  commitSha: string,
): Promise<{ output: string; data: Record<string, unknown> }> {
  const result = await tool.execute(
    { operation: 'admit_integration', stage_id: STAGE_ID, slice_id: SLICE_ID, commit_sha: commitSha },
    makeToolContext(root),
  );
  return { output: result.output, data: parseData(result.output) };
}

function receiptDir(fx: ProofFx, category: string): string {
  return path.join(fx.root, '.proofloop', 'receipts', category, STAGE_ID, SLICE_ID);
}

function receiptsIn(fx: ProofFx, category: string): any[] {
  const dir = receiptDir(fx, category);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')));
}

function receiptCount(fx: ProofFx, category: string): number {
  return receiptsIn(fx, category).length;
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

describe('built host-load seam (PO-S03-B-01/02/03 closure)', () => {
  it('loads the built plugin entry and runs a real worker admit through the host envelope', async () => {
    const plugin = await loadBuilt();
    const fx = fxBaseline();
    const tool = makeBuiltStageTool(plugin, fx.root);
    const { data, output } = await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'finalize-slice' }));

    expect(output).toContain('ProofLoop Stage');
    expect(output).toContain('Status: ok');
    expect(data.accepted).toBe(true);
    expect(receiptCount(fx, 'tasks')).toBe(1);
    const receipts = receiptsIn(fx, 'tasks');
    expect(receipts[0].type).toBe('TASK_COMPLETE');
    expect(fx.reconcile().slices[0]?.slice_state).toBe('READY_FOR_CV');
  });

  it('runs the full worker → CV → commit → integration chain through the built factory', async () => {
    const plugin = await loadBuilt();
    const fx = fxBaseline();
    const tool = makeBuiltStageTool(plugin, fx.root);
    const head = gitHead(fx.root);

    await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'finalize-slice' }));
    const cv = await cvAdmit(tool, fx.root, 'PASS', head);
    expect(cv.data.accepted).toBe(true);
    const cvDigest = (cv.data.receipt_ref as { digest: string }).digest;
    const commit = await commitAdmit(tool, fx.root, head, cvDigest);
    expect(commit.data.accepted).toBe(true);
    const integration = await integrationAdmit(tool, fx.root, head);
    expect(integration.data.accepted).toBe(true);

    const slice = fx.reconcile().slices[0];
    expect(slice?.slice_state).toBe('INTEGRATED');
    expect(slice?.integrated).toBe(true);
    expect(receiptCount(fx, 'committer')).toBe(1);
    expect(receiptCount(fx, 'integration')).toBe(1);
  });
});

describe('PO-S03-B-04 — Receipt persistence strictly through runAdmitPipeline', () => {
  it('the runtime pipeline routes persistence strictly through the ReceiptWriterPort (writer spy)', () => {
    const fx = fxBaseline();
    const writes: Array<Record<string, unknown>> = [];
    const writer: ReceiptWriterPort = {
      write: (data, options) => {
        writes.push(data as Record<string, unknown>);
        return { path: path.join(options.receiptDir, 'spy.json'), digest: 'spy-digest-123' };
      },
      verifyChain: () => ({ valid: true, receipts: [] }),
    };
    const result = admitWorkerResult(
      {
        type: 'worker_result',
        envelope: makeEnvelope() as unknown as WorkerResultEnvelope,
      },
      { projectRoot: fx.root, writer },
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBe('spy-digest-123');
    expect(writes).toHaveLength(1);
    const data = writes[0];
    // The pipeline builds the canonical receipt body (version/type/stage/
    // slice/payload) and hands it to the port — the port owns persistence.
    expect(data.type).toBe('TASK_COMPLETE');
    expect(data.stage_id).toBe(STAGE_ID);
    expect(data.slice_id).toBe(SLICE_ID);
    expect((data.payload as Record<string, unknown>).mode).toBe('implement-task');
    expect(data.digest).toBeUndefined();
    // The spy never wrote a file: the fixture has no persisted receipt.
    expect(receiptCount(fx, 'tasks')).toBe(0);
  });

  it('a success case is locatable, chain-valid with previous_digest links, and the output never leaks the Receipt payload', async () => {
    const fx = fxBaseline();
    const tool = makeTool(fx.root);
    const head = gitHead(fx.root);
    // Build a 2-link chain in the cv category: PASS then REPAIR? — REPAIR is a
    // distinct category path; instead link two worker receipts in tasks.
    const first = await workerAdmit(tool, fx.root, makeEnvelope({ actionToken: 'tok-chain-a', mode: 'implement-task' }));
    const second = await workerAdmit(tool, fx.root, makeEnvelope({ actionToken: 'tok-chain-b', mode: 'implement-task' }));

    expect(first.data.accepted).toBe(true);
    expect(second.data.accepted).toBe(true);
    const receipts = receiptsIn(fx, 'tasks');
    expect(receipts).toHaveLength(2);
    // Chain: exactly one genesis (no previous_digest) + one linked (previous
    // points to the genesis digest).
    const geneses = receipts.filter((r) => r.previous_digest === undefined);
    const linked = receipts.filter((r) => typeof r.previous_digest === 'string');
    expect(geneses).toHaveLength(1);
    expect(linked).toHaveLength(1);
    expect(linked[0].previous_digest).toBe(geneses[0].digest);
    expect(verifyReceiptChain(receiptDir(fx, 'tasks')).valid).toBe(true);
    // The compact output exposes only the { ref, digest } projection — no
    // Receipt payload/body.
    const output = first.output;
    expect(output).not.toContain('"payload"');
    expect(output).not.toContain('"verification_runs"');
    expect((first.data.receipt_ref as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a tampered category chain fails closed: RUNTIME.RECEIPT_CHAIN_BROKEN, no new Receipt, reconcile chain invalid', async () => {
    const fx = fxBaseline();
    const tool = makeTool(fx.root);
    await workerAdmit(tool, fx.root, makeEnvelope({ actionToken: 'tok-tamper-a', mode: 'implement-task' }));
    await workerAdmit(tool, fx.root, makeEnvelope({ actionToken: 'tok-tamper-b', mode: 'implement-task' }));
    expect(receiptCount(fx, 'tasks')).toBe(2);

    // Tamper the first receipt: change payload content WITHOUT updating the
    // stored digest → self-digest verification fails → chain broken.
    const dir = receiptDir(fx, 'tasks');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const firstPath = path.join(dir, files[0]);
    const receipt = JSON.parse(readFileSync(firstPath, 'utf-8'));
    receipt.payload.summary = 'tampered';
    writeFileSync(firstPath, JSON.stringify(receipt, null, 2), 'utf-8');
    expect(verifyReceiptChain(dir).valid).toBe(false);

    // A third admit through the host seam is refused BEFORE any write.
    const before = snapshotProtected(fx.root);
    const { data, output } = await workerAdmit(tool, fx.root, makeEnvelope({ actionToken: 'tok-tamper-c', mode: 'implement-task' }));
    expect(data.accepted).toBe(false);
    expect(output).toContain('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(receiptCount(fx, 'tasks')).toBe(2);
    expectProtectedIdentical(before, snapshotProtected(fx.root));
    // Fresh reconcile reports the broken chain.
    expect(fx.reconcile().receipt_chain_valid).toBe(false);
  });

  it('schema / path / state failures and cancellation leave receipts + runtime byte-identical', async () => {
    const fx = fxBaseline();
    const tool = makeTool(fx.root);
    const head = gitHead(fx.root);

    // State failure: CV before READY_FOR_CV.
    const before1 = snapshotProtected(fx.root);
    const cv = await cvAdmit(tool, fx.root, 'PASS', head);
    expect(cv.data.accepted).toBe(false);
    expectProtectedIdentical(before1, snapshotProtected(fx.root));

    // Schema failure: invalid envelope (mapper-level, no projection).
    const before2 = snapshotProtected(fx.root);
    const schema = await tool.execute(
      {
        operation: 'admit_worker_result',
        stage_id: STAGE_ID,
        slice_id: SLICE_ID,
        envelope: makeEnvelope({ actionToken: '' }),
      },
      makeToolContext(fx.root),
    );
    expect(schema.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expectProtectedIdentical(before2, snapshotProtected(fx.root));

    // Path failure: evidenceRef outside the trust root.
    const before3 = snapshotProtected(fx.root);
    const pathFail = await tool.execute(
      {
        operation: 'admit_worker_result',
        stage_id: STAGE_ID,
        slice_id: SLICE_ID,
        envelope: makeEnvelope({ evidenceRef: path.join(tmpdir(), 'outside.md') }),
      },
      makeToolContext(fx.root),
    );
    expect(pathFail.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    expectProtectedIdentical(before3, snapshotProtected(fx.root));

    // Cancellation: pre-aborted → AbortError, no write.
    const controller = new AbortController();
    controller.abort();
    const before4 = snapshotProtected(fx.root);
    let thrown: unknown;
    try {
      await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope(),
        },
        makeToolContext(fx.root, controller.signal),
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).name).toBe('AbortError');
    expectProtectedIdentical(before4, snapshotProtected(fx.root));
  });
});

describe('duplicate / wrong-state / digest-mismatch / abort matrix on the built seam (PO-S03-B-02/03/04)', () => {
  it('duplicate worker actionToken → no second TASK_COMPLETE receipt', async () => {
    const plugin = await loadBuilt();
    const fx = fxBaseline();
    const tool = makeBuiltStageTool(plugin, fx.root);
    const envelope = makeEnvelope({ actionToken: 'tok-dup', mode: 'implement-task' });
    await workerAdmit(tool, fx.root, envelope);
    const second = await workerAdmit(tool, fx.root, envelope);

    expect(second.data.accepted).toBe(false);
    expect(second.data.receipt_ref).toBeNull();
    expect(receiptCount(fx, 'tasks')).toBe(1);
  });

  it('duplicate CV (already CV_PASSED) → no second CV receipt', async () => {
    const fx = fxBaseline();
    const tool = makeTool(fx.root);
    const head = gitHead(fx.root);
    await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'finalize-slice' }));
    const first = await cvAdmit(tool, fx.root, 'PASS', head);
    expect(first.data.accepted).toBe(true);
    const second = await cvAdmit(tool, fx.root, 'PASS', head);

    expect(second.data.accepted).toBe(false);
    expect(receiptCount(fx, 'cv')).toBe(1);
  });

  it('integration before any SLICE_COMMIT (missing prerequisite) → no Receipt', async () => {
    const fx = fxBaseline();
    const tool = makeTool(fx.root);
    const head = gitHead(fx.root);
    await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'finalize-slice' }));
    await cvAdmit(tool, fx.root, 'PASS', head);

    const before = snapshotProtected(fx.root);
    const integration = await integrationAdmit(tool, fx.root, head);
    expect(integration.data.accepted).toBe(false);
    expect(receiptCount(fx, 'integration')).toBe(0);
    expectProtectedIdentical(before, snapshotProtected(fx.root));
  });

  it('digest mismatch (wrong cvReceiptDigest) → no SLICE_COMMIT receipt', async () => {
    const fx = fxBaseline();
    const tool = makeTool(fx.root);
    const head = gitHead(fx.root);
    await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'finalize-slice' }));
    await cvAdmit(tool, fx.root, 'PASS', head);

    const commit = await commitAdmit(tool, fx.root, head, 'f'.repeat(64));
    expect(commit.data.accepted).toBe(false);
    expect(receiptCount(fx, 'committer')).toBe(0);
  });

  it('abort-after-completion → AbortError, never a clean PASS', async () => {
    const fx = fxBaseline();
    const controller = new AbortController();
    const tool = makeTool(fx.root, {
      admit_worker_result: (_input: unknown) => {
        controller.abort();
        return { ok: true, findings: [], refs: [], runtime: { runtimeVersion: '0', pluginVersion: '0', schemaVersion: 0 } };
      },
    } as never);
    let thrown: unknown;
    try {
      await tool.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: makeEnvelope(),
        },
        makeToolContext(fx.root, controller.signal),
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).name).toBe('AbortError');
  });
});

describe('CLI failure-matrix parity on the built seam (PO-S03-B-04)', () => {
  it('a refused admit: accepted / receipt_ref / findings codes+order deep-equal the CLI oracle', async () => {
    const plugin = await loadBuilt();
    const fx = fxBaseline(); // slice IN_PROGRESS — CV not admissible
    const tool = makeBuiltStageTool(plugin, fx.root);
    const head = gitHead(fx.root);
    const request = {
      type: 'cv_result',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      verdict: 'PASS',
      snapshotDigest: head,
      summary: 'cv pass',
    } as const;

    const cli = admitRequest(request as never, fx.root);
    const pluginResult = await tool.execute(
      {
        operation: 'admit_cv_result',
        stage_id: STAGE_ID,
        slice_id: SLICE_ID,
        verdict: 'PASS',
        snapshot_digest: head,
        summary: 'cv pass',
      },
      makeToolContext(fx.root),
    );
    const data = parseData(pluginResult.output);

    expect(cli.accepted).toBe(false);
    expect(data.accepted).toBe(false);
    expect(cli.receipt_ref).toBeNull();
    expect(data.receipt_ref).toBeNull();
    expect(cli.findings.map((f) => f.code)).toEqual(
      (data.findings as Array<{ code: string }>).map((f) => f.code),
    );
    expect(cli.findings.map((f) => f.code)).toEqual(['DOMAIN.INVALID_TRANSITION']);
    expect(receiptCount(fx, 'cv')).toBe(0);
  });
});

describe('static guard — production admit layers never bypass the runtime pipeline (PO-S03-B-04)', () => {
  const PRODUCTION_SOURCES = [
    'stage.ts',
    'stage-admit-common.ts',
    'stage-admit.ts',
  ];

  it.each(PRODUCTION_SOURCES)(
    '%s contains no child_process / spawn / exec / CLI invocation',
    (file) => {
      const src = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), file),
        'utf8',
      );
      expect(src).not.toMatch(/node:child_process/);
      expect(src).not.toMatch(/\bchild_process\b/);
      expect(src).not.toMatch(/\bspawn\s*\(/);
      expect(src).not.toMatch(/\bexec(File|FileSync|Sync)?\s*\(/);
      expect(src).not.toMatch(/process\.execPath/);
      expect(src).not.toMatch(/dist\/cli/);
      expect(src).not.toMatch(/\bshell\s*:/);
    },
  );

  it.each(PRODUCTION_SOURCES)(
    '%s never calls writeReceipt / assembles Receipt JSON / bypasses the pipeline',
    (file) => {
      const src = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), file),
        'utf8',
      );
      expect(src).not.toMatch(/writeReceipt\s*\(/);
      expect(src).not.toMatch(/runAdmitPipeline\s*\(/);
      // Receipt creation is exclusively the runtime admit methods (the doc
      // comments may mention the forbidden names; a CALL never appears).
      expect(src).not.toMatch(/new Date\(\).*toISOString\(\).*receipt/i);
    },
  );
});

describe('reusable admission output seam (PO-S03-B-04 / S03-C/S03-D handoff)', () => {
  it('the BUILT plugin entry exports the mapper, projection and path-guard helpers', async () => {
    const plugin = await loadBuilt();
    expect(typeof plugin['mapHostArgsToAdmissionRequest']).toBe('function');
    expect(typeof plugin['projectAdmitResultData']).toBe('function');
    expect(typeof plugin['projectAdmitToolResult']).toBe('function');
    expect(typeof plugin['guardAdmitPathFields']).toBe('function');
    expect(typeof plugin['reverifyStagePaths']).toBe('function');
    expect(typeof plugin['admitReceiptRef']).toBe('function');
    expect(plugin['STAGE_ADMIT_OPERATIONS']).toEqual([
      'admit_worker_result',
      'admit_cv_result',
      'admit_slice_commit',
      'admit_integration',
    ]);
    expect(plugin['STAGE_REJECTED_OPERATIONS']).toContain('run_gate');
  });

  it('the mapper + projection + path-guard are pure and usable (S03-C/S03-D seam)', () => {
    const wire: StageAdmitWireArgs = {
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      rawArgs: {
        operation: 'admit_cv_result',
        verdict: 'PASS',
        snapshot_digest: 'd'.repeat(64),
        summary: 'seam',
      },
    };
    const mapped = mapHostArgsToAdmissionRequest('admit_cv_result', wire);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.request).toEqual({
      type: 'cv_result',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      verdict: 'PASS',
      snapshotDigest: 'd'.repeat(64),
      summary: 'seam',
    });

    const projected = projectAdmitResultData(
      { accepted: true, receipt_ref: 'aa11', new_state: null, findings: [] },
      'admit_cv_result',
      STAGE_ID,
      SLICE_ID,
    );
    expect(projected.receipt_ref).toEqual({
      ref: `.proofloop/receipts/cv/${STAGE_ID}/${SLICE_ID}/aa11.json`,
      digest: 'aa11',
    });

    // Path guard on a worker envelope: valid relative evidenceRef passes and
    // returns the ROOT-RELATIVE canonical values (REPAIR counterexample 1).
    const guarded = guardAdmitPathFields(
      '/tmp/root',
      'admit_worker_result',
      { envelope: makeEnvelope() },
    );
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;
    expect(guarded.canonical.envelope?.evidenceRef).toBe(
      `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    );

    // ToolResult projection keeps refs exactly { ref, digest }.
    const toolResult = projectAdmitToolResult(
      { accepted: true, receipt_ref: 'bb22', new_state: null, findings: [] },
      'admit_integration',
      STAGE_ID,
      SLICE_ID,
    );
    expect(toolResult.refs).toEqual([
      { ref: `.proofloop/receipts/integration/${STAGE_ID}/${SLICE_ID}/bb22.json`, digest: 'bb22' },
    ]);
  });
});

// ============================================================
// S03-B REPAIR — path canonicalization + malformed integration_ref + log order
// (CV c7a1f589… REPAIR: S03-B-PO01-PO04-RAW-PATH-AND-INTEGRATION-REF-BYPASS)
// ============================================================

function readLogs(root: string): string[] {
  const logsDir = path.join(root, '.proofloop', 'logs');
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => readFileSync(path.join(logsDir, f), 'utf-8'));
}

/** Build the chain to INTEGRATING (finalize → CV PASS → SLICE_COMMIT). */
async function chainToIntegrating(root: string): Promise<string> {
  const tool = makeTool(root);
  const head = gitHead(root);
  await workerAdmit(tool, root, makeEnvelope({ mode: 'finalize-slice' }));
  const cv = await cvAdmit(tool, root, 'PASS', head);
  const cvDigest = (cv.data.receipt_ref as { digest: string }).digest;
  const commit = await commitAdmit(tool, root, head, cvDigest);
  expect(commit.data.accepted).toBe(true);
  return head;
}

describe('S03-B REPAIR — path canonicalization propagation (CV counterexample 1)', () => {
  it('a raw evidenceRef with ./ segments is canonicalized in the persisted TASK_COMPLETE payload', async () => {
    const fx = fxBaseline();
    const tool = makeTool(fx.root);
    const rawEnvelope = makeEnvelope({
      mode: 'implement-task',
      evidenceRef: `delivery/./stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    });
    const { data } = await workerAdmit(tool, fx.root, rawEnvelope);
    expect(data.accepted).toBe(true);

    const receipts = receiptsIn(fx, 'tasks');
    expect(receipts).toHaveLength(1);
    // The persisted payload reflects the CANONICAL (normalized) evidence ref —
    // never the raw `delivery/./stages/...` string.
    expect(receipts[0].payload.evidence_ref).toBe(
      `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    );
    expect(receipts[0].payload.evidence_ref).not.toContain('/./');
    expect(receipts[0].payload.changed_files).not.toContain('/./');
  });

  it('the mapper consumes the canonicalized envelope (single-boundary canonicalization)', () => {
    const root = '/tmp/root';
    const rawEnvelope = makeEnvelope({
      evidenceRef: `delivery/./stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    });
    const guarded = guardAdmitPathFields(root, 'admit_worker_result', { envelope: rawEnvelope });
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;
    const mapped = mapHostArgsToAdmissionRequest(
      'admit_worker_result',
      { stageId: STAGE_ID, sliceId: SLICE_ID, rawArgs: { envelope: rawEnvelope } },
      guarded.canonical,
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    if (mapped.request.type !== 'worker_result') return;
    expect(mapped.request.envelope.evidenceRef).toBe(
      `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    );
    expect(mapped.request.envelope.evidenceRef).not.toContain('/./');
  });
});

describe('S03-B REPAIR — malformed integration_ref fails closed (CV counterexample 2)', () => {
  it.each([
    ['non-string number', 123],
    ['empty string', ''],
    ['object', { nested: true }],
    ['traversal', '..'],
    ['outside-root absolute', '/etc/passwd'],
    ['null', null],
  ] as const)(
    'integration_ref %s → canonical Finding, NO integration dispatch, NO INTEGRATION_PASS receipt',
    async (_label, badRef) => {
      const fx = fxBaseline();
      const tool = makeTool(fx.root);
      const head = await chainToIntegrating(fx.root);
      const before = snapshotProtected(fx.root);

      const result = await tool.execute(
        {
          operation: 'admit_integration',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          commit_sha: head,
          integration_ref: badRef,
        },
        makeToolContext(fx.root),
      );
      expect(result.output).toContain('Status: failed');
      expect(result.output).toMatch(/RUNTIME\.SCHEMA_MISMATCH|HOST\.PATH_OUTSIDE_PROJECT/);
      expect(receiptCount(fx, 'integration')).toBe(0);
      expectProtectedIdentical(before, snapshotProtected(fx.root));
    },
  );

  it('integration_ref symlink-escape → HOST.PATH_OUTSIDE_PROJECT, no Receipt', async () => {
    const fx = fxBaseline();
    const tool = makeTool(fx.root);
    const head = await chainToIntegrating(fx.root);
    // Outside file + in-root symlink pointing at it.
    const outsideDir = mkdtempSync(path.join(tmpdir(), 's03b-ref-out-'));
    const outsideFile = path.join(outsideDir, 'outside.txt');
    writeFileSync(outsideFile, 'outside', 'utf-8');
    const linkPath = path.join(fx.root, 'integration-ref.txt');
    fs.symlinkSync(outsideFile, linkPath);

    const result = await tool.execute(
      {
        operation: 'admit_integration',
        stage_id: STAGE_ID,
        slice_id: SLICE_ID,
        commit_sha: head,
        integration_ref: 'integration-ref.txt',
      },
      makeToolContext(fx.root),
    );
    expect(result.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    expect(receiptCount(fx, 'integration')).toBe(0);
  });
});

describe('S03-B REPAIR — valid integration_ref is metadata only + log ordering (CV counterexample 3)', () => {
  it('valid integration_ref inside root → admit succeeds; the value is NEVER a request member', async () => {
    const fx = fxBaseline();
    const tool = makeTool(fx.root);
    const head = await chainToIntegrating(fx.root);
    const integrationRef = 'reports/integration-s03-b.txt';

    const result = await tool.execute(
      {
        operation: 'admit_integration',
        stage_id: STAGE_ID,
        slice_id: SLICE_ID,
        commit_sha: head,
        integration_ref: integrationRef,
      },
      makeToolContext(fx.root),
    );
    const data = parseData(result.output);
    expect(data.accepted).toBe(true);

    // The runtime IntegrationAdmissionRequest has no integrationRef member:
    // the persisted INTEGRATION_PASS receipt never carries it.
    const receipts = receiptsIn(fx, 'integration');
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts[0])).not.toContain('integration_ref');
  });

  it('the metadata is logged ONLY after the guard passes; a malformed value is never logged as metadata', async () => {
    const fx = fxBaseline();
    const tool = makeTool(fx.root);
    const head = await chainToIntegrating(fx.root);
    // Malformed case first: guard fails → the metadata log never appears.
    await tool.execute(
      {
        operation: 'admit_integration',
        stage_id: STAGE_ID,
        slice_id: SLICE_ID,
        commit_sha: head,
        integration_ref: 123,
      },
      makeToolContext(fx.root),
    );
    let logs = readLogs(fx.root);
    expect(logs.some((l) => l.includes('integration host metadata'))).toBe(false);

    // Valid case: guard passes → the metadata IS logged (canonical value).
    await tool.execute(
      {
        operation: 'admit_integration',
        stage_id: STAGE_ID,
        slice_id: SLICE_ID,
        commit_sha: head,
        integration_ref: 'reports/integration-s03-b.txt',
      },
      makeToolContext(fx.root),
    );
    logs = readLogs(fx.root);
    expect(logs.some((l) => l.includes('integration host metadata'))).toBe(true);
    expect(logs.some((l) => l.includes('reports/integration-s03-b.txt'))).toBe(true);
  });
});
