/**
 * @proofloop/opencode-plugin — proofloop_stage S3 admission semantics matrix
 * (S03-B-T02).
 *
 * PO: PO-S03-B-02 (Worker/CV admission semantics: closed schema, mode/verdict
 * semantics, state precondition, snapshot binding, deterministic AdmitResult),
 * PO-S03-B-03 (Slice Commit / Integration binding: CV_PASS digest + same
 * commitSha, INTEGRATING/INTEGRATED transitions), PO-S03-B-04 (projection
 * parts: the ToolResult `refs` stay `{ ref, digest }`, never a Receipt
 * payload).
 *
 * Every matrix case runs through the REAL built `createStageTool(...).execute`
 * host seam against a real temp worktree (git repo + canonical `.proofloop`
 * manifest/tasks/evidence layout). The runtime is the ORACLE: after each
 * admit, a fresh `reconcileStage` readback and a receipt-file read verify the
 * state advance and the canonical Receipt type / category / payload / chain
 * binding. Fixture setup MAY use the runtime admit methods in the TEST process
 * to build prerequisite receipts (e.g. the CV_REPAIR state for repair/diagnose
 * modes) — production code never writes receipts outside the runtime pipeline.
 */

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reconcileStage } from '@proofloop/runtime';
import type { ReconcileStageResult, WorkerResultEnvelope } from '@proofloop/runtime';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { createStageTool } from './stage.js';
import type { StageToolArgsShape } from './stage.js';

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-B';
const TASKS: readonly string[] = ['S03-B-T01', 'S03-B-T02', 'S03-B-T03'];

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

interface MatrixFx {
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  write(rel: string, content: string): void;
  writeManifest(): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean): void;
  commitAll(message?: string): string;
  reconcile(): ReconcileStageResult;
  cleanup(): void;
}

function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID): MatrixFx {
  const root = mkdtempSync(path.join(tmpdir(), 's03b-matrix-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03b@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03B Matrix']);
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
        po_id: 'PO-S03-B-02',
        behavior: 'worker/cv admissions preserve runtime mode/verdict semantics',
        public_seam: 'built stage tool execute',
        oracle_source: 'real fixture project',
        success_criteria: 'receipt chain valid + reconcile readback',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['persistent_state', 'core_state_machine'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/${stageId}/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  });

  const fx: MatrixFx = {
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
      const lines = TASKS.map((t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`);
      const content =
        `# Stage ${stageId} — S3 Admission\n\n` +
        `## Slice ${sliceId}\n<!-- SLICE:${sliceId}:BEGIN -->\n\n### Tasks\n\n${lines.join('\n')}\n\n` +
        `<!-- SLICE:${sliceId}:END -->\n`;
      fx.write(`delivery/stages/${stageId}/tasks.md`, content);
    },
    writeEvidence: (finalized) => {
      const content =
        `# Slice ${sliceId} Evidence\n\n## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S03-B-02 | stage-admit-matrix.spec.ts | yes | yes | pass |\n\n` +
            `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
          : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| *None* | | | | |\n`);
      fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, content);
    },
    commitAll: (message = 'fixture') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
      return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    },
    reconcile: () => reconcileStage({ projectRoot: root, stageId }),
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

/** Baseline fixture: manifest + tasks (optionally checked) + evidence. */
function fxBaseline(checked: boolean, finalized: boolean): MatrixFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd(checked ? [...TASKS] : []);
  fx.writeEvidence(finalized);
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

function makeToolContext(root: string, abort: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: 'sess-s03b-t02',
    messageID: 'msg-s03b-t02',
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

function makeTool(root: string): StageExecuteTool {
  return createStageTool(makeContext(root)) as unknown as StageExecuteTool;
}

/** Extract the canonical ToolResult `data` projection from the host output. */
function parseData(output: string): Record<string, unknown> {
  const line = output.split('\n').find((l) => l.startsWith('Data: '));
  expect(line, `expected a Data: line in:\n${output}`).toBeDefined();
  return JSON.parse(line!.slice('Data: '.length)) as Record<string, unknown>;
}

function receiptsIn(root: string, category: string, stageId: string, sliceId: string): any[] {
  const dir = path.join(root, '.proofloop', 'receipts', category, stageId, sliceId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')));
}

function receiptCount(root: string, category: string, stageId: string, sliceId: string): number {
  return receiptsIn(root, category, stageId, sliceId).length;
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
    summary: 't02 worker',
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

function sliceStateOf(
  fx: MatrixFx,
): { slice_state?: string; cv_status?: string; integrated?: boolean } | undefined {
  return fx.reconcile().slices.find((s) => s.slice_id === SLICE_ID);
}

describe('worker-mode matrix (PO-S03-B-02)', () => {
  it('implement-task -> TASK_COMPLETE receipt, slice stays IN_PROGRESS', async () => {
    const fx = fxBaseline(false, false);
    const tool = makeTool(fx.root);
    const { data } = await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'implement-task' }));

    expect(data.accepted).toBe(true);
    const digest = (data.receipt_ref as { digest: string }).digest;
    const receipts = receiptsIn(fx.root, 'tasks', STAGE_ID, SLICE_ID);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].type).toBe('TASK_COMPLETE');
    expect(receipts[0].digest).toBe(digest);
    expect(receipts[0].payload.mode).toBe('implement-task');
    expect(sliceStateOf(fx)?.slice_state).toBe('IN_PROGRESS');
  });

  it('recover-task -> TASK_COMPLETE receipt, slice stays IN_PROGRESS', async () => {
    const fx = fxBaseline(false, false);
    const tool = makeTool(fx.root);
    const { data } = await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'recover-task' }));

    expect(data.accepted).toBe(true);
    const receipts = receiptsIn(fx.root, 'tasks', STAGE_ID, SLICE_ID);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].type).toBe('TASK_COMPLETE');
    expect(receipts[0].payload.mode).toBe('recover-task');
    expect(sliceStateOf(fx)?.slice_state).toBe('IN_PROGRESS');
  });

  it('finalize-slice -> TASK_COMPLETE receipt, slice READY_FOR_CV', async () => {
    const fx = fxBaseline(true, true);
    const tool = makeTool(fx.root);
    const { data } = await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'finalize-slice' }));

    expect(data.accepted).toBe(true);
    expect(
      (data.new_state as { slices?: Array<{ slice_state?: string }> }).slices?.[0]?.slice_state,
    ).toBe('READY_FOR_CV');
    const receipts = receiptsIn(fx.root, 'tasks', STAGE_ID, SLICE_ID);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].type).toBe('TASK_COMPLETE');
    expect(receipts[0].payload.mode).toBe('finalize-slice');
    expect(sliceStateOf(fx)?.slice_state).toBe('READY_FOR_CV');
  });

  it.each(['repair', 'diagnose'])(
    '%s (after a CV_REPAIR) -> TASK_COMPLETE receipt, cv PENDING_RECHECK',
    async (mode) => {
      const fx = fxBaseline(true, true);
      const tool = makeTool(fx.root);
      // Prerequisite chain: finalize-slice -> READY_FOR_CV; CV REPAIR -> cv REPAIR.
      await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'finalize-slice' }));
      await cvAdmit(tool, fx.root, 'REPAIR', gitHead(fx.root));

      const { data } = await workerAdmit(tool, fx.root, makeEnvelope({ mode }));
      expect(data.accepted).toBe(true);
      const receipts = receiptsIn(fx.root, 'tasks', STAGE_ID, SLICE_ID);
      expect(receipts).toHaveLength(2);
      // Receipt filenames are content-addressed digests (not chronological);
      // locate the repair/diagnose receipt by its payload mode.
      const modeReceipt = receipts.find((r) => r.payload.mode === mode);
      expect(modeReceipt).toBeDefined();
      expect(modeReceipt.type).toBe('TASK_COMPLETE');
      // The repair/diagnose TASK_COMPLETE binds the CV_REPAIR digest (recheck branch).
      const cvReceipts = receiptsIn(fx.root, 'cv', STAGE_ID, SLICE_ID);
      expect(modeReceipt.payload.cv_receipt_digest).toBe(cvReceipts[0].digest);
      const slice = sliceStateOf(fx);
      expect(slice?.slice_state).toBe('READY_FOR_CV');
      expect(slice?.cv_status).toBe('PENDING_RECHECK');
    },
  );

  it.each(['blocked', 'needs-decision', 'failed'])(
    'outcome %s -> no success Receipt (fail closed)',
    async (outcome) => {
      const fx = fxBaseline(false, false);
      const tool = makeTool(fx.root);
      const { data, output } = await workerAdmit(
        tool,
        fx.root,
        makeEnvelope({ mode: 'implement-task', outcome }),
      );

      expect(data.accepted).toBe(false);
      expect(output).toContain('Status: failed');
      expect(data.receipt_ref).toBeNull();
      expect(receiptCount(fx.root, 'tasks', STAGE_ID, SLICE_ID)).toBe(0);
    },
  );

  it('duplicate actionToken -> no second TASK_COMPLETE receipt', async () => {
    const fx = fxBaseline(false, false);
    const tool = makeTool(fx.root);
    const envelope = makeEnvelope({ mode: 'implement-task' });
    await workerAdmit(tool, fx.root, envelope);
    const second = await workerAdmit(tool, fx.root, envelope);

    expect(second.data.accepted).toBe(false);
    expect(receiptCount(fx.root, 'tasks', STAGE_ID, SLICE_ID)).toBe(1);
  });

  it('invalid envelope fields -> canonical Finding, no Receipt', async () => {
    const fx = fxBaseline(false, false);
    const tool = makeTool(fx.root);
    // Mapper-level failure: the runtime envelope schema rejects before any
    // dispatch, so the output carries findings but no AdmitResult projection.
    const result = await tool.execute(
      {
        operation: 'admit_worker_result',
        stage_id: STAGE_ID,
        slice_id: SLICE_ID,
        envelope: makeEnvelope({ actionToken: '' }),
      },
      makeToolContext(fx.root),
    );
    expect(result.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(result.output).toContain('Status: failed');
    expect(receiptCount(fx.root, 'tasks', STAGE_ID, SLICE_ID)).toBe(0);
  });
});

describe('CV PASS/REPAIR (PO-S03-B-02)', () => {
  async function readyForCvFx(): Promise<MatrixFx> {
    const fx = fxBaseline(true, true);
    const tool = makeTool(fx.root);
    await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'finalize-slice' }));
    return fx;
  }

  it('PASS on READY_FOR_CV -> CV_PASS receipt + slice CV_PASSED (snapshot bound)', async () => {
    const fx = await readyForCvFx();
    const tool = makeTool(fx.root);
    const head = gitHead(fx.root);
    const { data } = await cvAdmit(tool, fx.root, 'PASS', head);

    expect(data.accepted).toBe(true);
    const receipts = receiptsIn(fx.root, 'cv', STAGE_ID, SLICE_ID);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].type).toBe('CV_PASS');
    expect(receipts[0].payload.snapshot_digest).toBe(head);
    const slice = sliceStateOf(fx);
    expect(slice?.slice_state).toBe('CV_PASSED');
    expect(slice?.cv_status).toBe('PASS');
  });

  it('REPAIR on READY_FOR_CV -> CV_REPAIR receipt, slice stays READY_FOR_CV, cv REPAIR', async () => {
    const fx = await readyForCvFx();
    const tool = makeTool(fx.root);
    const { data } = await cvAdmit(tool, fx.root, 'REPAIR', gitHead(fx.root));

    expect(data.accepted).toBe(true);
    const receipts = receiptsIn(fx.root, 'cv', STAGE_ID, SLICE_ID);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].type).toBe('CV_REPAIR');
    const slice = sliceStateOf(fx);
    expect(slice?.slice_state).toBe('READY_FOR_CV');
    expect(slice?.cv_status).toBe('REPAIR');
  });

  it('CV on a non-READY_FOR_CV slice -> no Receipt', async () => {
    const fx = fxBaseline(false, false); // slice IN_PROGRESS, no finalize yet
    const tool = makeTool(fx.root);
    const { data, output } = await cvAdmit(tool, fx.root, 'PASS', gitHead(fx.root));

    expect(data.accepted).toBe(false);
    expect(output).toContain('Status: failed');
    expect(receiptCount(fx.root, 'cv', STAGE_ID, SLICE_ID)).toBe(0);
  });

  it('missing snapshot_digest -> canonical Finding, no Receipt', async () => {
    const fx = await readyForCvFx();
    const tool = makeTool(fx.root);
    const result = await tool.execute(
      {
        operation: 'admit_cv_result',
        stage_id: STAGE_ID,
        slice_id: SLICE_ID,
        verdict: 'PASS',
        summary: 'no snapshot',
      },
      makeToolContext(fx.root),
    );
    expect(result.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(receiptCount(fx.root, 'cv', STAGE_ID, SLICE_ID)).toBe(0);
  });
});

describe('commit/integration binding (PO-S03-B-03)', () => {
  async function cvPassedFx(): Promise<{ fx: MatrixFx; cvDigest: string }> {
    const fx = fxBaseline(true, true);
    const tool = makeTool(fx.root);
    await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'finalize-slice' }));
    const cv = await cvAdmit(tool, fx.root, 'PASS', gitHead(fx.root));
    const cvDigest = (cv.data.receipt_ref as { digest: string }).digest;
    return { fx, cvDigest };
  }

  it('full chain: finalize -> CV PASS -> SLICE_COMMIT -> INTEGRATION_PASS with fresh reconcile readback', async () => {
    const { fx, cvDigest } = await cvPassedFx();
    const tool = makeTool(fx.root);
    const head = gitHead(fx.root);

    // SLICE_COMMIT: CV_PASSED + cv digest binding -> INTEGRATING.
    const commit = await commitAdmit(tool, fx.root, head, cvDigest);
    expect(commit.data.accepted).toBe(true);
    let receipts = receiptsIn(fx.root, 'committer', STAGE_ID, SLICE_ID);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].type).toBe('SLICE_COMMIT');
    expect(receipts[0].payload.slice_commit_sha).toBe(head);
    expect(receipts[0].payload.cv_receipt_digest).toBe(cvDigest);
    expect(sliceStateOf(fx)?.slice_state).toBe('INTEGRATING');

    // INTEGRATION_PASS: INTEGRATING + same commitSha -> INTEGRATED.
    const integration = await integrationAdmit(tool, fx.root, head);
    expect(integration.data.accepted).toBe(true);
    receipts = receiptsIn(fx.root, 'integration', STAGE_ID, SLICE_ID);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].type).toBe('INTEGRATION_PASS');
    expect(receipts[0].payload.slice_commit_sha).toBe(head);
    const slice = sliceStateOf(fx);
    expect(slice?.slice_state).toBe('INTEGRATED');
    expect(slice?.integrated).toBe(true);
  });

  it('wrong CV receipt digest -> no SLICE_COMMIT receipt', async () => {
    const { fx } = await cvPassedFx();
    const tool = makeTool(fx.root);
    const { data, output } = await commitAdmit(
      tool,
      fx.root,
      gitHead(fx.root),
      'f'.repeat(64), // not the latest CV_PASS digest
    );

    expect(data.accepted).toBe(false);
    expect(output).toContain('Status: failed');
    expect(receiptCount(fx.root, 'committer', STAGE_ID, SLICE_ID)).toBe(0);
  });

  it('different commitSha -> no INTEGRATION_PASS receipt', async () => {
    const { fx, cvDigest } = await cvPassedFx();
    const tool = makeTool(fx.root);
    await commitAdmit(tool, fx.root, gitHead(fx.root), cvDigest);
    // A second, different commit sha (HEAD unchanged, so the request binding
    // cannot match the SLICE_COMMIT receipt).
    const { data, output } = await integrationAdmit(tool, fx.root, 'e'.repeat(40));

    expect(data.accepted).toBe(false);
    expect(output).toContain('Status: failed');
    expect(receiptCount(fx.root, 'integration', STAGE_ID, SLICE_ID)).toBe(0);
  });

  it('missing prerequisite (integration without a SLICE_COMMIT) -> no Receipt', async () => {
    const fx = fxBaseline(true, true);
    const tool = makeTool(fx.root);
    await workerAdmit(tool, fx.root, makeEnvelope({ mode: 'finalize-slice' }));
    await cvAdmit(tool, fx.root, 'PASS', gitHead(fx.root));

    const { data, output } = await integrationAdmit(tool, fx.root, gitHead(fx.root));
    expect(data.accepted).toBe(false);
    expect(output).toContain('Status: failed');
    expect(receiptCount(fx.root, 'integration', STAGE_ID, SLICE_ID)).toBe(0);
  });
});
