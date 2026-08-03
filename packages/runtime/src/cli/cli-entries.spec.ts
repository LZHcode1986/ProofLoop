/**
 * cli-entries.spec.ts — PO-S03-H-01 call matrix (S03-H-T01)
 *
 * Call matrix (success + failure case per entry) for the six remaining new
 * runtime CLI entries:
 *
 *   initialize-slice-evidence  — skeleton creation, no-overwrite, traversal guard
 *   next-action                — path-only input → NextActionService output
 *   sync-cv-status             — reconcile-derived CV status (read-only)
 *   admit                      — 7 S02 admit operations through the pipeline
 *   prepare-gate-facts         — reconcile + git clean + HEAD + integrated
 *   run-gate                   — runtime_proof step execution incl. service
 *                                lifecycle (B1b) + command/probe oracles
 *
 * plus the dist-script usage matrix for all eight entries (callable via
 * `node packages/runtime/dist/cli/<tool>.js` with the legacy arg contract).
 *
 * No mocks: real temp dirs / real git repos / real receipts. Forbidden
 * shortcut covered: the next-action and admit entries MUST go through the
 * runtime services (NextActionService / S02 admit methods) — the assertions
 * verify the service-contract output shapes, not ad-hoc derivation.
 */

import { describe, it, expect, afterEach } from 'vitest';
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
import { initializeSliceEvidence } from './initialize-slice-evidence';
import { nextActionFromInput } from './next-action';
import { syncCvStatus } from './sync-cv-status';
import { admitRequest } from './admit';
import { prepareGateFacts } from './prepare-gate-facts';
import { runGate } from './run-gate';

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
// initialize-slice-evidence
// ============================================================

describe('initialize-slice-evidence (PO-S03-H-01)', () => {
  it('creates the standard evidence skeleton for every slice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-init-ev-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = makeManifest([sliceDef('S03-A', ['S03-A-T01']), sliceDef('S03-B', ['S03-B-T01'])]);
    const result = initializeSliceEvidence({ manifest, deliveryRoot: dir });
    expect(result.errors).toEqual([]);
    expect(result.created).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    for (const slice of manifest.slices) {
      const p = path.join(dir, slice.evidence_path);
      expect(fs.existsSync(p)).toBe(true);
      const content = fs.readFileSync(p, 'utf-8');
      expect(content).toContain(`# Slice ${slice.slice_id} Evidence`);
      expect(content).toContain('## Current CV Status');
      expect(content).toContain('## Task Evidence');
    }
  });

  it('never overwrites an existing non-empty evidence file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-init-ev-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = makeManifest();
    const evidencePath = path.join(dir, manifest.slices[0].evidence_path);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, 'PRECIOUS CONTENT', 'utf-8');
    const result = initializeSliceEvidence({ manifest, deliveryRoot: dir });
    expect(result.created).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(fs.readFileSync(evidencePath, 'utf-8')).toBe('PRECIOUS CONTENT');
  });

  it('rejects evidence paths that escape the canonical evidence directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-init-ev-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = makeManifest();
    manifest.slices[0] = {
      ...manifest.slices[0],
      evidence_path: 'delivery/stages/S03/evidence/../S03-H.md',
    };
    const result = initializeSliceEvidence({ manifest, deliveryRoot: dir });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.created).toEqual([]);
  });

  it('rejects a non-canonical evidence_path pattern', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-init-ev-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = makeManifest();
    manifest.slices[0] = { ...manifest.slices[0], evidence_path: 'custom/path.md' };
    const result = initializeSliceEvidence({ manifest, deliveryRoot: dir });
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

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
// sync-cv-status
// ============================================================

describe('sync-cv-status (PO-S03-H-01, read-only derive)', () => {
  it('derives the CV status snapshot from reconcile without writing anything', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.seedReceipt('tasks', { payload: { mode: 'finalize-slice' } });
    fx.commitAll();
    const evidenceContentBefore = fs.readFileSync(
      path.join(fx.root, `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`),
      'utf-8',
    );
    const out = syncCvStatus({ stageId: STAGE_ID, sliceId: SLICE_ID, projectRoot: fx.root });
    expect(out.success).toBe(true);
    expect(out.stage_id).toBe(STAGE_ID);
    expect(out.slice_id).toBe(SLICE_ID);
    expect(out.slice_state).toBe(SliceState.READY_FOR_CV);
    expect(out.cv_status).toBe(CVStatus.NOT_STARTED);
    expect(out.latest_cv_receipt).toBeNull();
    expect(out.cv_level).toBe('enhanced');
    expect(out.evidence_file_present).toBe(true);
    // read-only: the evidence file must be byte-identical
    expect(
      fs.readFileSync(path.join(fx.root, `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`), 'utf-8'),
    ).toBe(evidenceContentBefore);
  });

  it('reports CV_PASS receipt facts when a CV_PASS receipt exists', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.seedReceipt('tasks', { payload: { mode: 'finalize-slice' } });
    const cv = fx.seedReceipt('cv', {
      type: 'CV_PASS',
      timestamp: '2025-01-02T00:00:00.000Z',
      payload: { verdict: 'PASS', snapshot_digest: FAKE_SHA, summary: 'pass' },
    });
    fx.commitAll();
    const out = syncCvStatus({ stageId: STAGE_ID, sliceId: SLICE_ID, projectRoot: fx.root });
    expect(out.success).toBe(true);
    expect(out.cv_status).toBe(CVStatus.PASS);
    expect(out.latest_cv_receipt?.type).toBe('CV_PASS');
    expect(out.latest_cv_receipt?.digest).toBe(cv.digest);
    expect(out.open_finding).toBeNull();
  });

  it('reports an open finding for a CV_REPAIR receipt', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.seedReceipt('tasks', { payload: { mode: 'finalize-slice' } });
    fx.seedReceipt('cv', {
      type: 'CV_REPAIR',
      timestamp: '2025-01-02T00:00:00.000Z',
      payload: { verdict: 'REPAIR', snapshot_digest: FAKE_SHA, summary: 'scope gap' },
    });
    fx.commitAll();
    const out = syncCvStatus({ stageId: STAGE_ID, sliceId: SLICE_ID, projectRoot: fx.root });
    expect(out.success).toBe(true);
    expect(out.cv_status).toBe(CVStatus.REPAIR);
    expect(out.latest_cv_receipt?.type).toBe('CV_REPAIR');
    expect(out.open_finding).toContain('scope gap');
  });

  it('fails closed for an unknown slice', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([]);
    fx.commitAll();
    const out = syncCvStatus({ stageId: STAGE_ID, sliceId: 'S99-Z', projectRoot: fx.root });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not found/i);
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
// prepare-gate-facts
// ============================================================

describe('prepare-gate-facts (PO-S03-H-01)', () => {
  it('writes slice-complete facts for an all-integrated clean stage', () => {
    const fx = fxIntegrated();
    const input = {
      stage_id: STAGE_ID,
      project_root: fx.root,
      manifest_path: `.proofloop/manifests/${STAGE_ID}.json`,
      tasks_path: `delivery/stages/${STAGE_ID}/tasks.md`,
    };
    const result = prepareGateFacts(input);
    expect(result.success).toBe(true);
    expect(result.path).toContain(`.proofloop${path.sep}runtime${path.sep}${STAGE_ID}${path.sep}slice-complete-facts.json`);
    expect(fs.existsSync(result.path as string)).toBe(true);
    const facts = JSON.parse(fs.readFileSync(result.path as string, 'utf-8')) as Array<Record<string, unknown>>;
    expect(facts).toHaveLength(1);
    expect(facts[0]['slice_id']).toBe(SLICE_ID);
    expect(facts[0]['integrated']).toBe(true);
    expect(facts[0]['git_clean']).toBe(true);
    expect(facts[0]['head_sha']).toBe(fx.head());
  });

  it('refuses when a slice is not integrated (no facts file written)', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.commitAll();
    const result = prepareGateFacts({ stage_id: STAGE_ID, project_root: fx.root });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not every slice is integrated/i);
    expect(fs.existsSync(path.join(fx.root, '.proofloop', 'runtime', STAGE_ID, 'slice-complete-facts.json'))).toBe(false);
  });

  it('refuses when the working tree is not clean', () => {
    const fx = fxIntegrated();
    fx.write('uncommitted.txt', 'dirty');
    const result = prepareGateFacts({ stage_id: STAGE_ID, project_root: fx.root });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not clean/i);
  });

  it('fails closed on missing identity fields', () => {
    const result = prepareGateFacts({ stage_id: '', project_root: '' } as never);
    expect(result.success).toBe(false);
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

describe('run-gate (PO-S03-H-01, runtime proof + service lifecycle)', () => {
  it('PASSes when every slice fact is present and every step exits as expected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = gateManifest([
      {
        id: 'ok',
        type: 'command',
        executable: 'node',
        args: ['-e', 'process.exit(0)'],
        cwd: '.',
        timeout_ms: 10000,
        expected: { exit_code: 0 },
      },
      {
        id: 'na',
        type: 'service_start',
        executable: 'node',
        args: ['--version'],
        cwd: '.',
        timeout_ms: 10000,
        not_applicable: { reason: 'library-only stage' },
      },
    ]);
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
    expect(result.steps[0]).toMatchObject({ id: 'ok', passed: true, exit_code: 0 });
    expect(result.steps[1]).toMatchObject({ id: 'na', passed: true, skipped: true });
    // result file written
    expect(fs.existsSync(result.output_path as string)).toBe(true);
    const written = JSON.parse(fs.readFileSync(result.output_path as string, 'utf-8'));
    expect(written.gate).toBe('PASS');
  });

  it('FAILs when a step exits with a non-expected code', async () => {
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
    expect(result.gate).toBe('FAIL');
    expect(result.success).toBe(false);
    expect(result.steps[0].exit_code).toBe(3);
    expect(result.errors.join(' ')).toContain('exited 3');
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

  it('FAILs when a service_start cannot be spawned (service lifecycle implemented)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-rungate-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = gateManifest([
      {
        id: 'svc',
        type: 'service_start',
        executable: 'definitely-not-a-real-binary-xyz',
        args: [],
        cwd: '.',
        timeout_ms: 10000,
      },
    ]);
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    const factsPath = path.join(dir, 'facts.json');
    fs.writeFileSync(factsPath, JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
    const result = await runGate({ manifestPath, factsPath, projectRoot: dir });
    expect(result.gate).toBe('FAIL');
    expect(result.steps[0].passed).toBe(false);
    expect(result.errors.join(' ')).toContain('service_start');
    expect(result.errors.join(' ')).toContain('failed');
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
});

// ============================================================
// dist-script usage matrix — all 8 entries callable via dist
// ============================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_CLI_DIR = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli');

const CLI_TOOLS = [
  'compile-manifest',
  'validate-stage',
  'initialize-slice-evidence',
  'next-action',
  'sync-cv-status',
  'admit',
  'prepare-gate-facts',
  'run-gate',
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
