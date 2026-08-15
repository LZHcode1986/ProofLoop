/**
 * project-acceptance.cli.spec.ts — B1c Project Acceptance CLI entries
 * (blueprint §6.4 proofloop_project)
 *
 * Dist-script usage matrix for the three new runtime CLI entries:
 *
 *   compile-project-acceptance — COMPILE_ACCEPTANCE
 *   run-project-acceptance     — RUN_E2E
 *   finalize-project-review    — FINALIZE_PROJECT_REVIEW
 *
 * callable via `node packages/runtime/dist/cli/<tool>.js` with the legacy
 * arg contract (behavior authority: .agents/runtime/src/*.ts). One full
 * happy-path chain runs end-to-end through the three dist scripts
 * (compile → run → finalize) plus the negative run case.
 *
 * No mocks: real temp git repos / real receipts / real kernel writers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { computeDigest, computeReceiptDigest, validateVNextManifest } from '@proofloop/kernel';
import { computeCanonicalJsonDigest, fileDigest16 } from '../project-acceptance';

// ============================================================
// Fixture helpers (dist-level: real git repo + stage evidence)
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_CLI_DIR = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli');

const CLI_TOOLS = ['compile-project-acceptance', 'run-project-acceptance', 'finalize-project-review'] as const;

const SNAPSHOT_HEX16 = 'a1b2c3d4e5f6a7b8';
/** vNext stage snapshot digest shape: 40-hex (git commit sha). */
const SNAPSHOT_HEX40 = '15d873a0d06831be3f11fccd8042b536fd4f04d0';

const HEX64_FILL = (seed: string): string => seed.repeat(64).slice(0, 64);

interface Fx {
  readonly root: string;
  readonly artifacts: string;
  readonly receiptsDir: string;
  cleanup(): void;
}

function makeFx(): Fx {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-pa-cli-'));
  const root = path.join(parent, 'repo');
  const artifacts = path.join(parent, 'artifacts');
  const receiptsDir = path.join(artifacts, 'receipts');
  fs.mkdirSync(root);
  fs.mkdirSync(artifacts);
  fs.mkdirSync(receiptsDir);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'cli@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Cli Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'seed']);
  const fx: Fx = {
    root,
    artifacts,
    receiptsDir,
    cleanup: () => {
      try {
        fs.rmSync(parent, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/** Minimal kernel-valid vNext stage manifest (version 2). */
function makeVNextStageManifest(stageId: string): Record<string, unknown> {
  return {
    version: 2,
    stage_id: stageId,
    plan: {
      ref: `delivery/stages/${stageId}/tasks.md`,
      plan_digest: HEX64_FILL('a'),
      schema_version: 2,
    },
    reference_index: {
      'REF-GOAL': {
        kind: 'goal',
        ref: `delivery/stages/${stageId}/tasks.md#/entities/goal`,
        file_digest: HEX64_FILL('b'),
        section_digest: HEX64_FILL('c'),
      },
      'REF-TASK': {
        kind: 'task',
        ref: `delivery/stages/${stageId}/tasks.md#/entities/slice-task`,
        file_digest: HEX64_FILL('d'),
        section_digest: HEX64_FILL('e'),
      },
      'REF-ACCEPT': {
        kind: 'acceptance',
        ref: `delivery/stages/${stageId}/tasks.md#/entities/acceptance`,
        file_digest: HEX64_FILL('f'),
        section_digest: HEX64_FILL('a'),
      },
      'REF-SEAM': {
        kind: 'seam',
        ref: `delivery/stages/${stageId}/tasks.md#/entities/seam`,
        file_digest: HEX64_FILL('b'),
        section_digest: HEX64_FILL('c'),
      },
      'REF-ORACLE': {
        kind: 'oracle',
        ref: `delivery/stages/${stageId}/tasks.md#/entities/oracle`,
        file_digest: HEX64_FILL('d'),
        section_digest: HEX64_FILL('e'),
      },
    },
    slices: [
      {
        slice_id: `${stageId}-A`,
        proof_index: {
          slice_id: `${stageId}-A`,
          goal_ref: 'REF-GOAL',
          task_refs: ['REF-TASK'],
          acceptance_refs: ['REF-ACCEPT'],
          seam_refs: ['REF-SEAM'],
          oracle_refs: ['REF-ORACLE'],
          risk_refs: [],
        },
        required_skills: ['typescript'],
        depends_on: [],
        evidence_path: `delivery/stages/${stageId}/evidence/${stageId}-A.md`,
      },
    ],
    task_scopes: {
      'slice-task': {
        task_ref: `delivery/stages/${stageId}/tasks.md#/entities/slice-task`,
        execution_scope: { kind: 'implementation', code_paths: ['src'], test_paths: ['test'], forbidden_paths: [] },
      },
    },
  };
}

/** Build a vNext stage evidence envelope (STAGE_REVIEW_PASS / GATE_PASS) with a valid self-digest. */
function makeVNextEnvelope(opts: {
  type: 'STAGE_REVIEW_PASS' | 'GATE_PASS';
  stageId: string;
  verdict: string;
  manifestDigest: string;
  snapshotDigest: string;
  stageGateReceiptDigest?: string;
  timestamp?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    action: opts.type === 'STAGE_REVIEW_PASS' ? 'STAGE_REVIEW' : 'GATE',
    type: opts.type === 'STAGE_REVIEW_PASS' ? 'STAGE_REVIEW_RESULT' : 'GATE_RESULT',
    schema_version: 2,
    verdict: opts.verdict,
    stage_id: opts.stageId,
    manifest_digest: opts.manifestDigest,
    snapshot_digest: opts.snapshotDigest,
    receipt_chain_valid: true,
  };
  if (opts.stageGateReceiptDigest !== undefined) {
    payload['stage_gate_receipt_digest'] = opts.stageGateReceiptDigest;
  }
  const envelope = {
    version: 1,
    type: opts.type,
    stage_id: opts.stageId,
    timestamp: opts.timestamp ?? '2025-01-01T00:00:00.000Z',
    payload,
  };
  return { ...envelope, digest: computeReceiptDigest(envelope as never) };
}

/** Write stage manifest / review / gate evidence into fx.artifacts (real digests, vNext). */
function writeStageEvidence(fx: Fx): {
  stageManifestPath: string;
  stageManifestDigest: string;
  reviewPath: string;
  reviewDigest: string;
  gatePath: string;
  gateDigest: string;
} {
  const stageManifest = makeVNextStageManifest('S01');
  const stageManifestPath = path.join(fx.artifacts, 'stage-manifest-S01.json');
  fs.writeFileSync(stageManifestPath, JSON.stringify(stageManifest, null, 2), 'utf-8');
  const parsedManifest = JSON.parse(fs.readFileSync(stageManifestPath, 'utf-8'));
  validateVNextManifest(parsedManifest);
  const stageManifestDigest = computeDigest(parsedManifest);
  const gate = makeVNextEnvelope({
    type: 'GATE_PASS',
    stageId: 'S01',
    verdict: 'PASS',
    manifestDigest: stageManifestDigest,
    snapshotDigest: SNAPSHOT_HEX40,
  });
  const gatePath = path.join(fx.artifacts, 'stage-gate-S01.json');
  fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2), 'utf-8');
  const gateDigest = gate['digest'] as string;
  const review = makeVNextEnvelope({
    type: 'STAGE_REVIEW_PASS',
    stageId: 'S01',
    verdict: 'ACCEPTED',
    manifestDigest: stageManifestDigest,
    snapshotDigest: SNAPSHOT_HEX40,
    stageGateReceiptDigest: gateDigest,
  });
  const reviewPath = path.join(fx.artifacts, 'stage-review-S01.json');
  fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2), 'utf-8');
  const reviewDigest = review['digest'] as string;
  return { stageManifestPath, stageManifestDigest, reviewPath, reviewDigest, gatePath, gateDigest };
}

/** Compile input JSON (write to fx.artifacts/compile-input.json). */
function writeCompileInput(
  fx: Fx,
  stage: {
    stageManifestPath: string;
    stageManifestDigest: string;
    reviewPath: string;
    reviewDigest: string;
    gatePath: string;
    gateDigest: string;
  },
  e2eSteps: readonly Record<string, unknown>[],
): string {
  const input = {
    project_root: fx.root,
    project_id: 'P1',
    prd_goals: ['Goal A'],
    acceptance_criteria: ['AC-01', 'AC-02'],
    stage_receipts: [
      {
        stage_id: 'S01',
        stage_manifest: { path: stage.stageManifestPath, digest: stage.stageManifestDigest },
        review_receipt: { path: stage.reviewPath, digest: stage.reviewDigest },
        gate_receipt: { path: stage.gatePath, digest: stage.gateDigest },
      },
    ],
    e2e_steps: e2eSteps,
  };
  const inputPath = path.join(fx.artifacts, 'compile-input.json');
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2), 'utf-8');
  return inputPath;
}

const PASSING_STEPS: readonly Record<string, unknown>[] = [
  { id: 'smoke-1', executable: 'node', args: ['-e', 'console.log("e2e ok")'], expected: { output_contains: 'e2e ok' } },
  { id: 'smoke-2', executable: 'node', args: ['-e', 'process.exit(0)'] },
];

// ============================================================
// dist-script callability matrix
// ============================================================

describe('project-acceptance dist script callability matrix (B1c)', () => {
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

  it('compile-project-acceptance.js compiles a manifest and exits 0', () => {
    const distPath = path.join(DIST_CLI_DIR, 'compile-project-acceptance.js');
    const fx = makeFx();
    const stage = writeStageEvidence(fx);
    const inputPath = writeCompileInput(fx, stage, PASSING_STEPS);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');

    const res = spawnSync(process.execPath, [distPath, inputPath, manifestPath], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { success: boolean; manifestDigest?: string; errors: string[] };
    expect(out.success).toBe(true);
    expect(out.errors).toEqual([]);
    expect(typeof out.manifestDigest).toBe('string');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.project_id).toBe('P1');
    expect(manifest.expected_snapshot).toMatch(/^[a-f0-9]{16}$/);
  });

  it('compile-project-acceptance.js exits 1 on an invalid input', () => {
    const distPath = path.join(DIST_CLI_DIR, 'compile-project-acceptance.js');
    const fx = makeFx();
    const badPath = path.join(fx.artifacts, 'bad-input.json');
    fs.writeFileSync(badPath, JSON.stringify({ project_root: fx.root, stage_receipts: [] }), 'utf-8');

    const res = spawnSync(process.execPath, [distPath, badPath, path.join(fx.artifacts, 'm.json')], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout) as { success: boolean; errors: string[] };
    expect(out.success).toBe(false);
    expect(out.errors.join('\n')).toContain('stage_receipts');
  });

  it('run-project-acceptance.js executes a PASS run and exits 0', () => {
    const distPath = path.join(DIST_CLI_DIR, 'run-project-acceptance.js');
    const fx = makeFx();
    const stage = writeStageEvidence(fx);
    const inputPath = writeCompileInput(fx, stage, PASSING_STEPS);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compileRes = spawnSync(process.execPath, [
      path.join(DIST_CLI_DIR, 'compile-project-acceptance.js'),
      inputPath,
      manifestPath,
    ], { encoding: 'utf-8', timeout: 30000 });
    expect(compileRes.status).toBe(0);

    const res = spawnSync(process.execPath, [distPath, manifestPath, fx.receiptsDir, fx.root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { success: boolean; verdict: string; receiptPath?: string };
    expect(out.success).toBe(true);
    expect(out.verdict).toBe('PASS');
    expect(typeof out.receiptPath).toBe('string');
    expect(fs.existsSync(out.receiptPath!)).toBe(true);
    const envelope = JSON.parse(fs.readFileSync(out.receiptPath!, 'utf-8'));
    expect(envelope.type).toBe('PROJECT_E2E_PASS');
  });

  it('run-project-acceptance.js exits 1 on a FAIL run (never pretends PASS)', () => {
    const distPath = path.join(DIST_CLI_DIR, 'run-project-acceptance.js');
    const fx = makeFx();
    const stage = writeStageEvidence(fx);
    const inputPath = writeCompileInput(fx, stage, [
      { id: 'fail-step', executable: 'node', args: ['-e', 'process.exit(1)'] },
    ]);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compileRes = spawnSync(process.execPath, [
      path.join(DIST_CLI_DIR, 'compile-project-acceptance.js'),
      inputPath,
      manifestPath,
    ], { encoding: 'utf-8', timeout: 30000 });
    expect(compileRes.status).toBe(0);

    const res = spawnSync(process.execPath, [distPath, manifestPath, fx.receiptsDir, fx.root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout) as { success: boolean; verdict: string; errors: string[] };
    expect(out.success).toBe(false);
    expect(out.verdict).toBe('FAIL');
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it('finalize-project-review.js accepts a consistent chain and exits 0', () => {
    const finalizePath = path.join(DIST_CLI_DIR, 'finalize-project-review.js');
    const compilePath = path.join(DIST_CLI_DIR, 'compile-project-acceptance.js');
    const runPath = path.join(DIST_CLI_DIR, 'run-project-acceptance.js');
    const fx = makeFx();
    const stage = writeStageEvidence(fx);
    const inputPath = writeCompileInput(fx, stage, PASSING_STEPS);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');

    // compile
    const compileRes = spawnSync(process.execPath, [compilePath, inputPath, manifestPath], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(compileRes.status).toBe(0);

    // run (PASS) → PROJECT_E2E_PASS receipt
    const runRes = spawnSync(process.execPath, [runPath, manifestPath, fx.receiptsDir, fx.root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(runRes.status).toBe(0);
    const runOut = JSON.parse(runRes.stdout) as { receiptPath: string; receiptDigest: string };
    expect(fs.existsSync(runOut.receiptPath)).toBe(true);

    // reviewer result bound to manifest + e2e receipt
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const digest16 = (p: string) =>
      crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
    const manifestDigest = computeCanonicalJsonDigest(manifest);
    const e2eFileDigest = digest16(runOut.receiptPath);
    const reviewer = {
      verdict: 'PROJECT_ACCEPTED',
      reviewer: 'project-reviewer',
      reviewed_snapshot: manifest.expected_snapshot,
      project_manifest: { path: path.resolve(manifestPath), digest: manifestDigest },
      project_e2e_receipt: { path: path.resolve(runOut.receiptPath), digest: e2eFileDigest },
      criteria_results: [
        { criteria: 'AC-01', passed: true, notes: 'ok' },
        { criteria: 'AC-02', passed: true, notes: 'ok' },
      ],
      findings: [],
      accepted_deviations: [],
      reviewed_at: '2025-01-01T01:00:00.000Z',
    };
    const reviewerPath = path.join(fx.artifacts, 'reviewer-result.json');
    fs.writeFileSync(reviewerPath, JSON.stringify(reviewer, null, 2), 'utf-8');

    const finalizeInput = path.join(fx.artifacts, 'finalize-input.json');
    fs.writeFileSync(
      finalizeInput,
      JSON.stringify({
        manifestPath,
        e2eReceiptPath: runOut.receiptPath,
        reviewerResultPath: reviewerPath,
        outputDir: fx.receiptsDir,
      }),
      'utf-8',
    );

    const res = spawnSync(process.execPath, [finalizePath, finalizeInput], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { success: boolean; receiptPath?: string };
    expect(out.success).toBe(true);
    expect(typeof out.receiptPath).toBe('string');
    const envelope = JSON.parse(fs.readFileSync(out.receiptPath!, 'utf-8'));
    expect(envelope.type).toBe('PROJECT_REVIEW_PASS');
    expect(envelope.previous_digest).toBe(runOut.receiptDigest);
  });

  it('finalize-project-review.js exits 1 on a rejected reviewer result', () => {
    const finalizePath = path.join(DIST_CLI_DIR, 'finalize-project-review.js');
    const fx = makeFx();
    const inputPath = path.join(fx.artifacts, 'finalize-input.json');
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        manifestPath: path.join(fx.artifacts, 'missing-manifest.json'),
        e2eReceiptPath: path.join(fx.artifacts, 'missing-e2e.json'),
        reviewerResultPath: path.join(fx.artifacts, 'missing-reviewer.json'),
        outputDir: fx.receiptsDir,
      }),
      'utf-8',
    );

    const res = spawnSync(process.execPath, [finalizePath, inputPath], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout) as { success: boolean; errors: string[] };
    expect(out.success).toBe(false);
    expect(out.errors.join('\n')).toContain('Manifest not found');
  });
});
