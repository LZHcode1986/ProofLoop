/**
 * @proofloop/opencode-plugin — proofloop_stage S3 CLI-admit parity spec
 * (S03-B-T02).
 *
 * PO: PO-S03-B-02 / PO-S03-B-03 (the plugin's host-execute AdmitResult
 * projection must be canonical-field-identical to the CLI `admit` oracle on
 * the same fixture), PO-S03-B-04 (projection parts: `refs` stay exactly
 * `{ ref, digest }`, never a Receipt payload).
 *
 * The runtime CLI `admitRequest` (packages/runtime/dist/cli/admit.js) is
 * consumed ONLY inside this TEST process as the parity oracle — the production
 * plugin never shells the CLI and never bypasses the runtime admit methods.
 *
 * Parity semantics:
 *   - The plugin's host-execute AdmitResult projection (`{ accepted,
 *     receipt_ref {ref,digest}, new_state (bounded canonical facts), findings
 *     }`) is compared against `admitRequest(request, root)` on an IDENTICAL
 *     fixture. Time is frozen (vi.useFakeTimers) so the runtime receipt
 *     timestamp is identical → the receipt digest and the receipt file bytes
 *     are IDENTICAL between the CLI oracle and the plugin (same runtime
 *     pipeline, same inputs).
 *   - `new_state` parity compares the plugin's bounded projection against the
 *     CLI's full reconcile state restricted to the SAME canonical facts.
 *   - A refusal case (CV on a non-READY_FOR_CV slice) compares the canonical
 *     finding codes/order.
 *   - The ToolResult `refs` contract (exactly { ref, digest }) is asserted at
 *     the handler-seam level through `projectAdmitToolResult` — the compact
 *     host envelope only exposes the `{ ref, digest }` receipt_ref projection
 *     and never a Receipt payload/body.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { admitRequest } from '@proofloop/runtime/dist/cli/admit.js';
import type { AdmissionRequest } from '@proofloop/runtime';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { createStageTool } from './stage.js';
import type { StageToolArgsShape } from './stage.js';
import { mapHostArgsToAdmissionRequest } from './stage-admit-common.js';
import type { StageAdmitOperation, StageAdmitWireArgs } from './stage-admit-common.js';
import { projectAdmitToolResult } from './stage-admit.js';

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-B';
const TASKS: readonly string[] = ['S03-B-T01', 'S03-B-T02', 'S03-B-T03'];
const FROZEN_NOW = new Date('2026-08-03T00:00:00.000Z');

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

beforeEach(() => {
  // Freeze time so the plugin and the CLI oracle produce IDENTICAL receipt
  // timestamps → identical digests and identical receipt file bytes.
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

interface ParityFx {
  readonly root: string;
  write(rel: string, content: string): void;
  writeManifest(): void;
  writeTasksMd(): void;
  writeEvidence(): void;
  cleanup(): void;
}

function makeFx(): ParityFx {
  const root = mkdtempSync(path.join(tmpdir(), 's03b-parity-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03b@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03B Parity']);
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
    evidence_path: `delivery/stages/${STAGE_ID}/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  });
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

  const fx: ParityFx = {
    root,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: () => {
      fx.write(`.proofloop/manifests/${STAGE_ID}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: () => {
      const lines = TASKS.map((t) => `- [x] ${t}: task ${t}`);
      fx.write(
        `delivery/stages/${STAGE_ID}/tasks.md`,
        `# Stage ${STAGE_ID} — S3 Admission\n\n## Slice ${SLICE_ID}\n<!-- SLICE:${SLICE_ID}:BEGIN -->\n\n### Tasks\n\n${lines.join('\n')}\n\n<!-- SLICE:${SLICE_ID}:END -->\n`,
      );
    },
    writeEvidence: () => {
      fx.write(
        `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
        `# Slice ${SLICE_ID} Evidence\n\n## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
          `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n### Proof Obligation Coverage\n\n` +
          `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
          `|---|---|---|---|---|\n| PO-S03-B-02 | stage-admit-parity.spec.ts | yes | yes | pass |\n\n` +
          `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`,
      );
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

function fxBaseline(): ParityFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd();
  fx.writeEvidence();
  execFileSync('git', ['-C', fx.root, 'add', '-A']);
  execFileSync('git', ['-C', fx.root, 'commit', '-q', '-m', 'baseline']);
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
    sessionID: 'sess-s03b-t02p',
    messageID: 'msg-s03b-t02p',
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

function parseData(output: string): Record<string, unknown> {
  const line = output.split('\n').find((l) => l.startsWith('Data: '));
  expect(line, `expected a Data: line in:\n${output}`).toBeDefined();
  return JSON.parse(line!.slice('Data: '.length)) as Record<string, unknown>;
}

function makeEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionToken: 'tok-parity-worker',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: 'S03-B-T01',
    mode: 'finalize-slice',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    changedFiles: ['packages/opencode-plugin/src/tools/stage.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 'parity worker',
  };
}

/** Build the canonical AdmissionRequest the plugin would map for an operation. */
function wireFor(operation: StageAdmitOperation, extra: Record<string, unknown>): StageAdmitWireArgs {
  return {
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    rawArgs: { operation, stage_id: STAGE_ID, slice_id: SLICE_ID, ...extra },
  };
}

function mappedRequest(operation: StageAdmitOperation, extra: Record<string, unknown>): AdmissionRequest {
  const mapped = mapHostArgsToAdmissionRequest(operation, wireFor(operation, extra));
  expect(mapped.ok, `mapper accepted ${operation}`).toBe(true);
  return (mapped as { request: AdmissionRequest }).request;
}

/** Same bounded new_state projection the plugin exposes. */
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

async function pluginAdmit(
  tool: StageExecuteTool,
  root: string,
  operation: StageAdmitOperation,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await tool.execute(
    { operation, stage_id: STAGE_ID, slice_id: SLICE_ID, ...extra },
    makeToolContext(root),
  );
  return parseData(result.output);
}

/** Build the chain up to the given point on a fixture via the PLUGIN (production path). */
async function chainTo(root: string, phase: 'baseline' | 'cv-pass' | 'committed'): Promise<{ cvDigest: string }> {
  const tool = makeTool(root);
  let cvDigest = '';
  if (phase !== 'baseline') {
    const worker = await pluginAdmit(tool, root, 'admit_worker_result', { envelope: makeEnvelope() });
    expect(worker.accepted).toBe(true);
    if (phase === 'cv-pass') {
      const cv = await pluginAdmit(tool, root, 'admit_cv_result', {
        verdict: 'PASS',
        snapshot_digest: 'c'.repeat(64),
        summary: 'cv pass',
      });
      expect(cv.accepted).toBe(true);
      cvDigest = (cv.receipt_ref as { digest: string }).digest;
    }
    if (phase === 'committed') {
      const cv = await pluginAdmit(tool, root, 'admit_cv_result', {
        verdict: 'PASS',
        snapshot_digest: 'c'.repeat(64),
        summary: 'cv pass',
      });
      expect(cv.accepted).toBe(true);
      cvDigest = (cv.receipt_ref as { digest: string }).digest;
      const commit = await pluginAdmit(tool, root, 'admit_slice_commit', {
        commit_sha: 'a'.repeat(40),
        cv_receipt_digest: cvDigest,
      });
      expect(commit.accepted).toBe(true);
    }
  }
  return { cvDigest };
}

describe('CLI-admit parity (PO-S03-B-02 / PO-S03-B-03)', () => {
  it('admit_worker_result: plugin projection + receipt bytes equal the CLI oracle', async () => {
    const cliFx = fxBaseline();
    const pluginFx = fxBaseline();
    const wire = wireFor('admit_worker_result', { envelope: makeEnvelope() });
    const request = mappedRequest('admit_worker_result', { envelope: makeEnvelope() });

    // CLI oracle on fixture A.
    const cli = admitRequest(request, cliFx.root);
    // Plugin on fixture B.
    const tool = makeTool(pluginFx.root);
    const plugin = await pluginAdmit(tool, pluginFx.root, 'admit_worker_result', { envelope: makeEnvelope() });

    expect(plugin.accepted).toBe(cli.accepted);
    expect(cli.accepted).toBe(true);
    // receipt_ref digest parity (frozen time → same runtime receipt).
    const cliDigest = cli.receipt_ref as string;
    expect((plugin.receipt_ref as { digest: string }).digest).toBe(cliDigest);
    expect((plugin.receipt_ref as { ref: string }).ref).toBe(
      `.proofloop/receipts/tasks/${STAGE_ID}/${SLICE_ID}/${cliDigest}.json`,
    );
    // new_state canonical-fields parity.
    expect(plugin.new_state).toEqual(projectCliNewState(cli.new_state));
    // findings parity.
    expect(plugin.findings).toEqual(cli.findings);
    // Receipt file bytes are IDENTICAL (same runtime, same timestamp).
    expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
  });

  it('admit_cv_result (PASS): plugin projection + receipt bytes equal the CLI oracle', async () => {
    const cliFx = fxBaseline();
    const pluginFx = fxBaseline();
    // Prerequisite: finalize-slice on both fixtures (identical chain) so the
    // slice derives READY_FOR_CV for the CV admit.
    {
      const t = makeTool(cliFx.root);
      await pluginAdmit(t, cliFx.root, 'admit_worker_result', { envelope: makeEnvelope() });
    }
    {
      const t = makeTool(pluginFx.root);
      await pluginAdmit(t, pluginFx.root, 'admit_worker_result', { envelope: makeEnvelope() });
    }
    const request = mappedRequest('admit_cv_result', {
      verdict: 'PASS',
      snapshot_digest: 'c'.repeat(64),
      summary: 'cv pass',
    });

    const cli = admitRequest(request, cliFx.root);
    const tool = makeTool(pluginFx.root);
    const plugin = await pluginAdmit(tool, pluginFx.root, 'admit_cv_result', {
      verdict: 'PASS',
      snapshot_digest: 'c'.repeat(64),
      summary: 'cv pass',
    });

    expect(cli.accepted).toBe(true);
    expect(plugin.accepted).toBe(true);
    const cliDigest = cli.receipt_ref as string;
    expect((plugin.receipt_ref as { digest: string }).digest).toBe(cliDigest);
    expect(plugin.new_state).toEqual(projectCliNewState(cli.new_state));
    expect(plugin.findings).toEqual(cli.findings);
    expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
  });

  it('admit_slice_commit: plugin projection + receipt bytes equal the CLI oracle', async () => {
    const cliFx = fxBaseline();
    const pluginFx = fxBaseline();
    // Prerequisite chain identical on both: finalize-slice + CV PASS.
    const cliChain = await chainTo(cliFx.root, 'cv-pass');
    const pluginChain = await chainTo(pluginFx.root, 'cv-pass');
    expect(pluginChain.cvDigest).toBe(cliChain.cvDigest);
    const request = mappedRequest('admit_slice_commit', {
      commit_sha: 'a'.repeat(40),
      cv_receipt_digest: cliChain.cvDigest,
    });

    const cli = admitRequest(request, cliFx.root);
    const tool = makeTool(pluginFx.root);
    const plugin = await pluginAdmit(tool, pluginFx.root, 'admit_slice_commit', {
      commit_sha: 'a'.repeat(40),
      cv_receipt_digest: pluginChain.cvDigest,
    });

    expect(cli.accepted).toBe(true);
    expect(plugin.accepted).toBe(true);
    const cliDigest = cli.receipt_ref as string;
    expect((plugin.receipt_ref as { digest: string }).digest).toBe(cliDigest);
    expect(plugin.new_state).toEqual(projectCliNewState(cli.new_state));
    expect(plugin.findings).toEqual(cli.findings);
    expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
  });

  it('admit_integration: plugin projection + receipt bytes equal the CLI oracle', async () => {
    const cliFx = fxBaseline();
    const pluginFx = fxBaseline();
    // Prerequisite chain identical on both: finalize + CV PASS + SLICE_COMMIT.
    const cliChain = await chainTo(cliFx.root, 'committed');
    const pluginChain = await chainTo(pluginFx.root, 'committed');
    expect(pluginChain.cvDigest).toBe(cliChain.cvDigest);
    const request = mappedRequest('admit_integration', { commit_sha: 'a'.repeat(40) });

    const cli = admitRequest(request, cliFx.root);
    const tool = makeTool(pluginFx.root);
    const plugin = await pluginAdmit(tool, pluginFx.root, 'admit_integration', {
      commit_sha: 'a'.repeat(40),
    });

    expect(cli.accepted).toBe(true);
    expect(plugin.accepted).toBe(true);
    const cliDigest = cli.receipt_ref as string;
    expect((plugin.receipt_ref as { digest: string }).digest).toBe(cliDigest);
    expect(plugin.new_state).toEqual(projectCliNewState(cli.new_state));
    expect(plugin.findings).toEqual(cli.findings);
    expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
  });

  it('refused CV (wrong state): canonical finding codes/order parity', async () => {
    const cliFx = fxBaseline(); // slice IN_PROGRESS — not READY_FOR_CV
    const pluginFx = fxBaseline();
    const request = mappedRequest('admit_cv_result', {
      verdict: 'PASS',
      snapshot_digest: 'c'.repeat(64),
      summary: 'cv pass',
    });

    const cli = admitRequest(request, cliFx.root);
    const tool = makeTool(pluginFx.root);
    const plugin = await pluginAdmit(tool, pluginFx.root, 'admit_cv_result', {
      verdict: 'PASS',
      snapshot_digest: 'c'.repeat(64),
      summary: 'cv pass',
    });

    expect(cli.accepted).toBe(false);
    expect(plugin.accepted).toBe(false);
    expect(cli.receipt_ref).toBeNull();
    expect(plugin.receipt_ref).toBeNull();
    const pluginFindings = plugin.findings as Array<{ code: string }>;
    expect(cli.findings.map((f) => f.code)).toEqual(pluginFindings.map((f) => f.code));
    expect(cli.findings.map((f) => f.code)).toEqual(['DOMAIN.INVALID_TRANSITION']);
    // Neither side wrote a receipt.
    expect(snapshotReceipts(pluginFx.root).size).toBe(0);
    expect(snapshotReceipts(cliFx.root).size).toBe(0);
  });
});

describe('unified AdmitResult/ReceiptRef projection (PO-S03-B-04)', () => {
  it('the ToolResult refs carry exactly { ref, digest } and no Receipt payload leaks', () => {
    const result = projectAdmitToolResult(
      { accepted: true, receipt_ref: 'abc123', new_state: null, findings: [] },
      'admit_cv_result',
      STAGE_ID,
      SLICE_ID,
    );
    expect(result.ok).toBe(true);
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]).toEqual({
      ref: `.proofloop/receipts/cv/${STAGE_ID}/${SLICE_ID}/abc123.json`,
      digest: 'abc123',
    });
    expect(Object.keys(result.refs[0]).sort()).toEqual(['digest', 'ref']);
    // The data projection carries accepted / receipt_ref / new_state /
    // findings — never a Receipt payload/body.
    expect(JSON.stringify(result.data)).not.toContain('payload');
    expect(Object.keys(result.data as Record<string, unknown>).sort()).toEqual([
      'accepted',
      'findings',
      'new_state',
      'receipt_ref',
    ]);
  });

  it('a refused admit produces no refs and an ok:false ToolResult', () => {
    const result = projectAdmitToolResult(
      {
        accepted: false,
        receipt_ref: null,
        new_state: null,
        findings: [
          { code: 'DOMAIN.INVALID_TRANSITION', severity: 'error', message: 'refused' },
        ],
      },
      'admit_integration',
      STAGE_ID,
      SLICE_ID,
    );
    expect(result.ok).toBe(false);
    expect(result.refs).toEqual([]);
    expect((result.data as { receipt_ref: unknown }).receipt_ref).toBeNull();
  });
});
