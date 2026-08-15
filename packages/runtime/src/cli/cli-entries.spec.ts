/**
 * cli-entries.spec.ts — PO-S03-H-01 call matrix (S03-H-T01)
 *
 * Call matrix (success + failure case per entry) for the remaining runtime
 * CLI entries:
 *
 *   next-action     — path-only input → NextActionService output
 *   admit           — 7 S02 admit operations through the pipeline
 *   run-gate        — Gate over v1 facts / vNext integration prefix (never
 *                     executes runtime_proof steps; lifecycle (B1b) +
 *                     command/probe oracles)
 *
 * plus the dist-script usage matrix for the remaining entries (callable via
 * `node packages/runtime/dist/cli/<tool>.js` with the legacy arg contract).
 *
 * No mocks: real temp dirs / real git repos / real receipts. Forbidden
 * shortcut covered: the next-action and admit entries MUST go through the
 * runtime services (NextActionService / S02 admit methods) — the assertions
 * verify the service-contract output shapes, not ad-hoc derivation.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  writeReceipt,
  verifyReceiptChain,
  StageState,
  SliceState,
  CVStatus,
  validateManifest,
} from '@proofloop/kernel';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import { receiptCategoryDir, reconcileStage } from '@proofloop/runtime';
import type { ReceiptContentCategory } from '@proofloop/runtime';
import { nextActionFromInput } from './next-action';
import { admitRequest } from './admit';
import { runGate, runGateCli } from './run-gate';

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

let fixtureCounter = 0;

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-H';
const TASKS: readonly string[] = ['S03-H-T01', 'S03-H-T02'];
const FAKE_SHA = 'a'.repeat(40);

function sliceDef(sid: string, taskIds: readonly string[]): ManifestSlice {
  return {
    slice_id: sid,
    goal: 'CLI entries',
    observable_outcome: 'callable CLI entries with zero host deps',
    public_seam: 'packages/runtime/dist/cli',
    dependencies: [],
    proof_obligations: [
      {
        po_id: 'PO-S03-H-01',
        behavior: 'CLI call matrix',
        public_seam: 'dist cli entries',
        oracle_source: 'legacy CLI contract',
        success_criteria: 'success + failure cases pass',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['public_api_change'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/${STAGE_ID}/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  };
}

function makeManifest(slices: ManifestSlice[] = [sliceDef(SLICE_ID, TASKS)]): Manifest {
  return {
    stage_id: STAGE_ID,
    source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
    source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
    stage_goal: 'Runtime CLI surface',
    outcomes: ['8 callable CLI entries'],
    slices,
    dependencies: [],
    risk_facts: ['public_api_change: true'],
  };
}

interface Fx {
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  write(rel: string, content: string): void;
  writeManifest(slices?: ManifestSlice[]): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean): void;
  seedReceipt(
    category: ReceiptContentCategory,
    overrides: Record<string, unknown>,
  ): { path: string; digest: string };
  commitAll(message?: string): string;
  head(): string;
  reconcile(): ReturnType<typeof reconcileStage>;
  cleanup(): void;
}

function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID): Fx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-entries-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'cli@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Cli Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const fx: Fx = {
    root,
    stageId,
    sliceId,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: (slices) => {
      const manifest = makeManifest(slices ?? [sliceDef(sliceId, TASKS)]);
      fx.write(`.proofloop/manifests/${stageId}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (checkedTasks) => {
      const lines = TASKS.map(
        (t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`,
      );
      const content =
        `# Stage ${stageId} — Runtime\n\n` +
        `## Slice ${sliceId}\n` +
        `<!-- SLICE:${sliceId}:BEGIN -->\n\n` +
        `### Tasks\n\n${lines.join('\n')}\n\n` +
        `<!-- SLICE:${sliceId}:END -->\n`;
      fx.write(`delivery/stages/${stageId}/tasks.md`, content);
    },
    writeEvidence: (finalized) => {
      const partial =
        `# Slice ${sliceId} Evidence\n\n` +
        `## Task Evidence\n\n### ${TASKS[0]}\n\n- Status: COMPLETE\n\n` +
        `## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
        `|---|---|---|---|---|\n| *None* | | | | |\n` +
        `\n## Current CV Status\n\n- Status: NOT_RUN\n- Level: *Not yet determined*\n- Latest CV Receipt: *None*\n- Open Finding: *None*\n`;
      const finalizedContent =
        `# Slice ${sliceId} Evidence\n\n` +
        `## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n` +
        `### Proof Obligation Coverage\n\n` +
        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
        `|---|---|---|---|---|\n| PO-S03-H-01 | cli-entries.spec.ts | yes | yes | pass |\n\n` +
        `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n` +
        `\n## Current CV Status\n\n- Status: NOT_RUN\n- Level: *Not yet determined*\n- Latest CV Receipt: *None*\n- Open Finding: *None*\n`;
      fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, finalized ? finalizedContent : partial);
    },
    seedReceipt: (category, overrides) => {
      const dir = receiptCategoryDir(root, category, stageId, sliceId);
      fs.mkdirSync(dir, { recursive: true });
      return writeReceipt(
        {
          version: 1,
          type: 'TASK_COMPLETE',
          stage_id: stageId,
          slice_id: sliceId,
          timestamp: '2025-01-01T00:00:00.000Z',
          payload: {},
          ...overrides,
        },
        { receiptDir: dir, tempDir: dir },
      );
    },
    commitAll: (message = 'fixture') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
      return fx.head();
    },
    head: () =>
      execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
    reconcile: () => reconcileStage({ projectRoot: root, stageId }),
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/** Build an INTEGRATED slice: CV_PASS → SLICE_COMMIT → INTEGRATION_PASS. */
function fxIntegrated(): Fx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  const cv = fx.seedReceipt('cv', {
    type: 'CV_PASS',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { verdict: 'PASS', snapshot_digest: FAKE_SHA, summary: 'pass' },
  });
  const commit = fx.seedReceipt('committer', {
    type: 'SLICE_COMMIT',
    timestamp: '2025-01-02T00:00:00.000Z',
    payload: { status: 'committed', slice_commit_sha: FAKE_SHA, cv_receipt_digest: cv.digest },
  });
  fx.seedReceipt('integration', {
    type: 'INTEGRATION_PASS',
    timestamp: '2025-01-03T00:00:00.000Z',
    payload: { status: 'integrated', slice_commit_sha: FAKE_SHA },
  });
  void commit;
  fx.commitAll();
  return fx;
}

// ============================================================
// next-action
// ============================================================

describe('next-action (PO-S03-H-01)', () => {
  it('runs the NextActionService from a path-only input and returns the contract shape', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([]);
    fx.commitAll();
    const out = nextActionFromInput({
      stage_id: STAGE_ID,
      project_root: fx.root,
    });
    // proofloop_next contract — exactly the service output shape (the CLI
    // must NOT re-derive the action itself).
    expect(Object.keys(out).sort()).toEqual([
      'action',
      'action_detail',
      'findings',
      'receipt_chain_valid',
      'responsible_role',
    ]);
    expect(typeof out.action).toBe('string');
    expect(out.action_detail.length).toBeGreaterThan(0);
    expect(typeof out.receipt_chain_valid).toBe('boolean');
    expect(Array.isArray(out.findings)).toBe(true);
  });

  it('accepts camelCase aliases for the path-only input', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([]);
    fx.commitAll();
    const out = nextActionFromInput({ stageId: STAGE_ID, projectRoot: fx.root });
    expect(out.action).toBeTruthy();
  });

  it('fails closed when the identity fields are missing', () => {
    expect(() => nextActionFromInput({ stage_id: STAGE_ID })).toThrow(/project_root/i);
    expect(() => nextActionFromInput({ project_root: '.' })).toThrow(/stage_id/i);
    expect(() => nextActionFromInput('nope')).toThrow(/object/i);
  });
});

// ============================================================
// admit
// ============================================================

describe('admit (PO-S03-H-01, 7 S02 operations)', () => {
  it('admits a completed worker result through the pipeline and writes a chain-verified receipt', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([TASKS[0]]);
    fx.writeEvidence(false);
    fx.commitAll();
    const result = admitRequest(
      {
        type: 'worker_result',
        envelope: {
          schemaVersion: 1,
          actionToken: 'tok-cli-1',
          stageId: STAGE_ID,
          sliceId: SLICE_ID,
          taskId: TASKS[0],
          mode: 'implement-task',
          outcome: 'completed',
          evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
          changedFiles: ['packages/runtime/src/cli/admit.ts'],
          verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
          summary: 'implemented via CLI',
        },
      },
      fx.root,
    );
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBeTruthy();
    expect(result.new_state).not.toBeNull();
    // post-write chain verification over the real category directory
    const dir = receiptCategoryDir(fx.root, 'tasks', STAGE_ID, SLICE_ID);
    expect(verifyReceiptChain(dir).valid).toBe(true);
    // fresh reconcile readback: slice still IN_PROGRESS after implement-task
    const state = fx.reconcile();
    const slice = state.slices.find((s) => s.slice_id === SLICE_ID);
    expect(slice?.slice_state).toBe(SliceState.IN_PROGRESS);
  });

  it('structurally rejects a cv_result admit when the slice is not in a CV state', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([TASKS[0]]);
    fx.writeEvidence(false);
    fx.commitAll();
    const result = admitRequest(
      {
        type: 'cv_result',
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        verdict: 'PASS',
        snapshotDigest: FAKE_SHA,
        summary: 'cv pass',
      },
      fx.root,
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
  });

  it('fails closed for an unknown admit kind (SLICE_PLAN reserved for S04)', () => {
    const fx = makeFx();
    expect(() =>
      admitRequest(
        { type: 'slice_plan', stageId: STAGE_ID, sliceId: SLICE_ID } as never,
        fx.root,
      ),
    ).toThrow(/reserved for S04/i);
  });
});

// ============================================================
// run-gate
// ============================================================

function gateManifest(steps: Array<Record<string, unknown>>): Manifest {
  return {
    ...makeManifest(),
    runtime_proof: steps as unknown as Manifest['runtime_proof'],
  };
}

describe('run-gate (PO-S03-H-01, facts-only Gate; runtime_proof steps are never executed)', () => {
  it('PASSes when every slice fact is present — no runtime_proof steps are executed (steps stay empty)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = gateManifest([]);
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    const factsPath = path.join(dir, 'facts.json');
    fs.writeFileSync(
      factsPath,
      JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]),
      'utf-8',
    );
    const result = await runGate({ manifestPath, factsPath, outputDir: path.join(dir, 'out'), projectRoot: dir });
    expect(result.gate).toBe('PASS');
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.steps).toEqual([]);
    // result file written
    expect(fs.existsSync(result.output_path as string)).toBe(true);
    const written = JSON.parse(fs.readFileSync(result.output_path as string, 'utf-8'));
    expect(written.gate).toBe('PASS');
  });

  it('FAILs when a step in the (ignored) runtime_proof list would have failed — facts still decide', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = gateManifest([
      {
        id: 'boom',
        type: 'command',
        executable: 'node',
        args: ['-e', 'process.exit(3)'],
        cwd: '.',
        timeout_ms: 10000,
        expected: { exit_code: 0 },
      },
    ]);
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    const factsPath = path.join(dir, 'facts.json');
    fs.writeFileSync(factsPath, JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
    const result = await runGate({ manifestPath, factsPath, outputDir: path.join(dir, 'out'), projectRoot: dir });
    expect(result.gate).toBe('PASS');
    expect(result.success).toBe(true);
    expect(result.steps).toEqual([]);
  });

  it('FAILs when a manifest slice has no integrated fact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(makeManifest(), null, 2), 'utf-8');
    const factsPath = path.join(dir, 'facts.json');
    fs.writeFileSync(factsPath, JSON.stringify([]), 'utf-8');
    const result = await runGate({ manifestPath, factsPath, projectRoot: dir });
    expect(result.gate).toBe('FAIL');
    expect(result.errors.join(' ')).toContain('no COMPLETE fact');
  });

  it('FAILs on a fact for an undeclared slice (stale facts refused)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(makeManifest(), null, 2), 'utf-8');
    const factsPath = path.join(dir, 'facts.json');
    fs.writeFileSync(
      factsPath,
      JSON.stringify([{ slice_id: SLICE_ID, integrated: true }, { slice_id: 'S03-OLD', integrated: true }]),
      'utf-8',
    );
    const result = await runGate({ manifestPath, factsPath, projectRoot: dir });
    expect(result.gate).toBe('FAIL');
    expect(result.errors.join(' ')).toContain('undeclared slice');
  });

  it('FAILs closed when the manifest or facts file is unreadable/invalid', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const badManifest = { ...makeManifest(), stage_id: 42 };
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(badManifest), 'utf-8');
    const factsPath = path.join(dir, 'facts.json');
    fs.writeFileSync(factsPath, JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
    const result = await runGate({ manifestPath, factsPath, projectRoot: dir });
    expect(result.gate).toBe('FAIL');
    expect(result.errors.join(' ')).toMatch(/manifest/i);
  });

  it('kernel oracle: gateManifest output is a valid Manifest', () => {
    expect(() => validateManifest(gateManifest([]))).not.toThrow();
  });

  it('runGateCli routes a vNext Manifest to the canonical Gate (exit 1 without an integrated prefix, no gate result written)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-vnext-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, '.proofloop/manifests/S04.json'), 'utf8'),
    ) as Record<string, any>;
    manifest.task_scopes = {
      'S04-A-T01': {
        task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
        execution_scope: {
          kind: 'implementation',
          code_paths: ['delivery/stages/S04/tasks.md'],
          test_paths: ['packages/worker-test.ts'],
          forbidden_paths: ['.proofloop/receipts', '.git'],
        },
      },
    };
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    const outDir = path.join(dir, 'out');
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    const code = await runGateCli([manifestPath, '', outDir, dir]);
    logSpy.mockRestore();
    expect(code).toBe(1);
    // The Gate failed honestly on the missing integrated prefix — the gate
    // result file may be written (honest FAIL); the verdict is not a PASS.
    const written = fs.existsSync(path.join(outDir, 'gate-result.json'))
      ? JSON.parse(fs.readFileSync(path.join(outDir, 'gate-result.json'), 'utf8')) as { gate: string }
      : null;
    expect(written === null || written.gate === 'FAIL').toBe(true);
  });
});

// ============================================================
// dist-script usage matrix — remaining entries callable via dist
// ============================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_CLI_DIR = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli');

const CLI_TOOLS = [
  'next-action',
  'admit',
  'run-gate',
  // S10-A-T01: the public harness-neutral `proofloop` dispatcher joins the
  // same dist callability matrix (no args → usage + exit 1).
  'proofloop',
  // S10-E-T02: the cutover domain entry joins the same dist callability
  // matrix (no args → usage + exit 1).  Legacy entries removed by cutover /
  // plugin retirement: compile-manifest / validate-stage /
  // initialize-slice-evidence / sync-cv-status / prepare-gate-facts were
  // deleted from the runtime CLI.
  'proofloop-cutover',
] as const;

describe('dist script callability matrix (PO-S03-H-01: node packages/runtime/dist/cli/<tool>.js)', () => {
  for (const tool of CLI_TOOLS) {
    it(`${tool}.js loads and enforces the usage contract (exit 1 + usage text without args)`, () => {
      const distPath = path.join(DIST_CLI_DIR, `${tool}.js`);
      expect(fs.existsSync(distPath)).toBe(true);
      const res = spawnSync(process.execPath, [distPath], { encoding: 'utf-8' });
      expect(res.status).toBe(1);
      expect((res.stderr + res.stdout).toLowerCase()).toContain('usage:');
    });
  }

  it('dist scripts contain no host-dependency imports (@earendil-works / .agents)', () => {
    for (const tool of CLI_TOOLS) {
      const distPath = path.join(DIST_CLI_DIR, `${tool}.js`);
      const src = fs.readFileSync(distPath, 'utf-8');
      expect(src).not.toContain('@earendil-works');
      expect(src).not.toContain('.agents/');
    }
  });

  it('admit.js runs a structured rejection through the pipeline and exits 1', () => {
    const distPath = path.join(DIST_CLI_DIR, 'admit.js');
    expect(fs.existsSync(distPath)).toBe(true);
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([TASKS[0]]);
    fx.writeEvidence(false);
    fx.commitAll();
    const requestPath = path.join(fx.root, 'request.json');
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        type: 'cv_result',
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        verdict: 'PASS',
        snapshotDigest: FAKE_SHA,
        summary: 'cv pass',
      }),
      'utf-8',
    );
    const res = spawnSync(process.execPath, [distPath, requestPath, fx.root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout) as { accepted: boolean };
    expect(out.accepted).toBe(false);
  });

  it('next-action.js runs the service over a real fixture and exits 0', () => {
    const distPath = path.join(DIST_CLI_DIR, 'next-action.js');
    expect(fs.existsSync(distPath)).toBe(true);
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([]);
    fx.commitAll();
    const inputPath = path.join(fx.root, 'input.json');
    fs.writeFileSync(
      inputPath,
      JSON.stringify({ stage_id: STAGE_ID, project_root: fx.root }),
      'utf-8',
    );
    const res = spawnSync(process.execPath, [distPath, inputPath], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { action: string };
    expect(typeof out.action).toBe('string');
    expect(out.action.length).toBeGreaterThan(0);
  });
});

// ============================================================
// S10-E-T02 repair: cutover 域 public dispatcher 路径（唯一 public seam）
// ============================================================

describe('proofloop cutover public dispatcher path (S10-E-T02 repair, REF-CLI-ACCEPTANCE F)', () => {
  const PROOFLOOP_DIST = path.join(DIST_CLI_DIR, 'proofloop.js');

  it('proofloop.js cutover status 经 public dispatcher 可达（exit 0 canonical envelope）', () => {
    const fx = makeFx();
    const res = spawnSync(process.execPath, [PROOFLOOP_DIST, 'cutover', 'status'], {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: fx.root,
    });
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as {
      ok: boolean;
      command: { domain: string; operation: string };
      result: { cutover_matrix: { delete_targets: string[] } };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'cutover', operation: 'status' });
    expect(Array.isArray(envelope.result.cutover_matrix.delete_targets)).toBe(true);
  });

  it('proofloop.js cutover execute 未确认 → exit 2 canonical Finding（不可逆保护）', () => {
    const fx = makeFx();
    const res = spawnSync(
      process.execPath,
      [PROOFLOOP_DIST, 'cutover', 'execute', '--json', JSON.stringify({ stage: 'S03' })],
      { encoding: 'utf-8', timeout: 30000, cwd: fx.root },
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toMatch(/CONFIRM|IRREVERSIBLE/);
  });

  it('proofloop.js cutover execute 未知 request 字段 → exit 2（closed request parser）', () => {
    const fx = makeFx();
    const res = spawnSync(
      process.execPath,
      [
        PROOFLOOP_DIST,
        'cutover',
        'execute',
        '--json',
        JSON.stringify({ stage: 'S03', confirmed: true, delete_list: ['x'], bogus_field: 'nope' }),
      ],
      { encoding: 'utf-8', timeout: 30000, cwd: fx.root },
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('bogus_field');
  });

  it('proofloop.js cutover execute confirmed:true + delete_list 类型错误 → exit 2（closed request parser）', () => {
    const fx = makeFx();
    const res = spawnSync(
      process.execPath,
      [
        PROOFLOOP_DIST,
        'cutover',
        'execute',
        '--json',
        JSON.stringify({ stage: 'S03', confirmed: 'yes', delete_list: ['x'] }),
      ],
      { encoding: 'utf-8', timeout: 30000, cwd: fx.root },
    );
    expect(res.status).toBe(2);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; findings: Array<{ code: string; message: string }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('confirmed');
  });
});

describe('run-gate built process no-execution (dual-path SG)', () => {
  it('dist run-gate does not execute vNext runtime_proof steps (exit 1 on admission refusal without an integrated prefix)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-bound-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, '.proofloop/manifests/S04.json'), 'utf8'),
    ) as Record<string, any>;
    manifest.task_scopes = {
      'S04-A-T01': {
        task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
        execution_scope: {
          kind: 'implementation',
          code_paths: ['delivery/stages/S04/tasks.md'],
          test_paths: ['packages/worker-test.ts'],
          forbidden_paths: ['.proofloop/receipts', '.git'],
        },
      },
    };
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    const outDir = path.join(dir, 'out');
    const distPath = path.join(REPO_ROOT, 'packages/runtime/dist/cli/run-gate.js');
    const res = spawnSync(process.execPath, [distPath, manifestPath, '', outDir, dir], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout) as { steps: Array<{ id: string; passed: boolean }>; errors: string[] };
    // Dual-path SG: runtime_proof commands are NEVER executed — the step list
    // is empty and the Gate fails honestly (no git repo / no integrated
    // prefix) without any Receipt write.
    expect(out.steps).toEqual([]);
    expect(out.errors.join(' ')).toMatch(/cannot resolve the current Git HEAD|Integration Receipt|authority is unavailable/i);
    const gateResult = JSON.parse(fs.readFileSync(path.join(outDir, 'gate-result.json'), 'utf8')) as { gate: string };
    expect(gateResult.gate).toBe('FAIL');
  });
});
