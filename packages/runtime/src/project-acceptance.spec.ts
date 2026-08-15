/**
 * project-acceptance.spec.ts — B1c Project Acceptance pipeline (blueprint
 * §6.4 proofloop_project)
 *
 * Call matrix over the three pipeline functions:
 *
 *   compileProjectAcceptance — COMPILE_ACCEPTANCE: manifest build (git-based
 *     expected_snapshot + canonical digest), fail-closed schema, write-once;
 *   runProjectAcceptanceE2E — RUN_E2E: step execution through the B1a
 *     Process Runner (command/probe oracles incl. null exit-code semantics,
 *     service lifecycle, mandatory cleanup), verdict derivation (PASS/FAIL,
 *     BLOCKED reserved), kernel receipt persistence (PROJECT_E2E_PASS/FAIL);
 *   finalizeProjectReview — FINALIZE_PROJECT_REVIEW: full-chain
 *     cross-validation (manifest + E2E gate + reviewer + per-stage triple
 *     binding + criteria one-to-one) → PROJECT_REVIEW_PASS receipt chained
 *     to the E2E gate envelope.
 *
 * No mocks: real temp git repos / real receipts / real kernel writers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateVNextManifest, validateReceipt, verifyReceiptChain, computeDigest, computeReceiptDigest } from '@proofloop/kernel';
import {
  compileProjectAcceptance,
  runProjectAcceptanceE2E,
  finalizeProjectReview,
  computeSnapshot,
  computeCanonicalJsonDigest,
  fileDigest16,
} from './project-acceptance';
import type { RuntimeProofStep, ProjectE2EReceipt } from './project-acceptance';

// ============================================================
// Fixture helpers
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const SNAPSHOT_HEX16 = 'a1b2c3d4e5f6a7b8';
/** vNext stage snapshot digest shape: 40-hex (git commit sha). */
const SNAPSHOT_HEX40 = '15d873a0d06831be3f11fccd8042b536fd4f04d0';

const HEX64_FILL = (seed: string): string => seed.repeat(64).slice(0, 64);

interface RepoFx {
  /** Git repo root (project_root) — must stay clean between compile and E2E. */
  readonly root: string;
  /** Directory OUTSIDE the repo holding all acceptance artifacts. */
  readonly artifacts: string;
  /** Dedicated receipt directory (kernel chain pre-check scans .json files). */
  readonly receiptsDir: string;
  commitAll(message?: string): string;
  head(): string;
  snapshot(): string;
  write(rel: string, content: string): string;
}

function makeRepoFx(): RepoFx {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-pa-'));
  const root = path.join(parent, 'repo');
  const artifacts = path.join(parent, 'artifacts');
  const receiptsDir = path.join(artifacts, 'receipts');
  fs.mkdirSync(root);
  fs.mkdirSync(artifacts);
  fs.mkdirSync(receiptsDir);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'pa@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'PA Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.proofloop-README'), 'project acceptance fixture\n');
  const fx: RepoFx = {
    root,
    artifacts,
    receiptsDir,
    commitAll: (message = 'fixture') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
      return fx.head();
    },
    head: () =>
      execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
    snapshot: () => computeSnapshot(root),
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
      return p;
    },
  };
  cleanups.push(() => {
    try {
      fs.rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
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

interface StageEvidence {
  readonly stageManifestPath: string;
  readonly stageManifestDigest: string;
  readonly reviewPath: string;
  readonly reviewDigest: string;
  readonly gatePath: string;
  readonly gateDigest: string;
}

/** Write vNext stage manifest + review + gate with full triple-binding consistency. */
function writeStageEvidence(fx: RepoFx): StageEvidence {
  // a. Stage manifest (v2 vNext manifest; canonical 64-hex digest binding).
  const stageManifest = makeVNextStageManifest('S01');
  const stageManifestPath = path.join(fx.artifacts, 'stage-manifest-S01.json');
  fs.writeFileSync(stageManifestPath, JSON.stringify(stageManifest, null, 2), 'utf-8');
  const parsedManifest = JSON.parse(fs.readFileSync(stageManifestPath, 'utf-8'));
  validateVNextManifest(parsedManifest);
  const stageManifestDigest = computeDigest(parsedManifest);

  // b. Stage gate receipt: GATE_PASS envelope (PASS, manifest_digest bound).
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

  // c. Stage review receipt: STAGE_REVIEW_PASS envelope (ACCEPTED;
  //    stage_gate_receipt_digest triple-bound to the gate envelope digest).
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

/** Minimal valid compile input for a repo fixture. */
function compileInput(
  fx: RepoFx,
  stage: StageEvidence,
  e2eSteps: readonly RuntimeProofStep[],
): Record<string, unknown> {
  return {
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
    e2e_steps: e2eSteps.map((s) => ({ ...s })),
  };
}

/** Simple passing e2e steps (no service). */
function passingSteps(): RuntimeProofStep[] {
  return [
    {
      id: 'smoke-1',
      executable: 'node',
      args: ['-e', 'console.log("e2e ok")'],
      expected: { output_contains: 'e2e ok' },
    },
    {
      id: 'smoke-2',
      executable: 'node',
      args: ['-e', 'process.exit(0)'],
    },
  ];
}

/** Write the reviewer result bound to manifest + e2e files. */
function writeReviewerResult(
  fx: RepoFx,
  manifestPath: string,
  manifestDigest: string,
  e2ePath: string,
  e2eFileDigest: string,
  expectedSnapshot: string,
  criteria: readonly string[],
  verdict = 'PROJECT_ACCEPTED',
): string {
  const reviewer = {
    verdict,
    reviewer: 'project-reviewer',
    reviewed_snapshot: expectedSnapshot,
    project_manifest: { path: path.resolve(manifestPath), digest: manifestDigest },
    project_e2e_receipt: { path: path.resolve(e2ePath), digest: e2eFileDigest },
    criteria_results: criteria.map((c) => ({ criteria: c, passed: true, notes: 'ok' })),
    findings: [],
    accepted_deviations: [],
    reviewed_at: '2025-01-01T01:00:00.000Z',
  };
  const reviewerPath = path.join(fx.artifacts, 'reviewer-result.json');
  fs.writeFileSync(reviewerPath, JSON.stringify(reviewer, null, 2), 'utf-8');
  return reviewerPath;
}

// ============================================================
// compileProjectAcceptance
// ============================================================

describe('compileProjectAcceptance (COMPILE_ACCEPTANCE)', () => {
  it('writes a valid manifest with git snapshot + canonical digest', () => {
    const fx = makeRepoFx();
    fx.write('src/main.txt', 'hello');
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');

    const result = compileProjectAcceptance(
      compileInput(fx, stage, passingSteps()),
      manifestPath,
    );

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.outputPath).toBe(path.resolve(manifestPath));
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.project_id).toBe('P1');
    expect(manifest.expected_snapshot).toBe(fx.snapshot());
    expect(manifest.expected_snapshot).toMatch(/^[a-f0-9]{16}$/);
    expect(manifest.stage_receipts).toHaveLength(1);
    expect(manifest.e2e_steps).toHaveLength(2);
    expect(manifest.compiled_at).toBeTypeOf('string');
    // Canonical digest over the written file equals the reported digest.
    expect(computeCanonicalJsonDigest(manifest)).toBe(result.manifestDigest);
  });

  it('rejects input that is not a JSON object', () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const result = compileProjectAcceptance([], path.join(fx.artifacts, 'm.json'));
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('JSON object');
  });

  it('rejects a missing project_root', () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const result = compileProjectAcceptance(
      { project_id: 'P1', stage_receipts: [{ stage_id: 'S01' }] },
      path.join(fx.artifacts, 'm.json'),
    );
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('project_root');
  });

  it('rejects a non-existent project_root', () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const result = compileProjectAcceptance(
      { project_root: path.join(fx.root, 'missing'), project_id: 'P1', stage_receipts: [] },
      path.join(fx.artifacts, 'm.json'),
    );
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Project root not found');
  });

  it('rejects empty stage_receipts', () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const result = compileProjectAcceptance(
      { project_root: fx.root, project_id: 'P1', stage_receipts: [] },
      path.join(fx.artifacts, 'm.json'),
    );
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('stage_receipts');
  });

  it('fails closed when the assembled manifest violates the schema — no file written', () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');

    // e2e_steps empty → schema requires ≥ 1 step → compile refuses.
    const result = compileProjectAcceptance(
      compileInput(fx, stage, []),
      manifestPath,
    );
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('e2e_steps');
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it('fails closed on a non-git project_root (snapshot unavailable)', () => {
    const fx = makeRepoFx();
    const stage = writeStageEvidence(fx);
    // fx.root exists but has no commits / no git HEAD → snapshot fails.
    const result = compileProjectAcceptance(
      compileInput(fx, stage, passingSteps()),
      path.join(fx.artifacts, 'm.json'),
    );
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('PROJECT_SNAPSHOT_UNAVAILABLE');
  });
});

// ============================================================
// runProjectAcceptanceE2E
// ============================================================

describe('runProjectAcceptanceE2E (RUN_E2E)', () => {
  it('PASS: executing steps → PROJECT_E2E_PASS kernel receipt (chain-valid dir)', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, passingSteps()), manifestPath);
    expect(compiled.success).toBe(true);

    const result = await runProjectAcceptanceE2E(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
      { projectRoot: fx.root, receiptDir: fx.receiptsDir },
    );

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('PASS');
    expect(result.errors).toEqual([]);
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.steps).toHaveLength(2);
    expect(result.receipt!.steps.map((s) => s.step_id)).toEqual(['smoke-1', 'smoke-2']);
    expect(result.receipt!.steps.every((s) => s.exit_code === 0)).toBe(true);
    expect(result.receipt!.service_cleanup.failed).toEqual([]);
    expect(result.receipt!.service_cleanup.remainingPids).toEqual([]);

    // Kernel envelope: valid, typed PROJECT_E2E_PASS, chain-consistent.
    const envelope = JSON.parse(fs.readFileSync(result.receiptPath!, 'utf-8'));
    const validated = validateReceipt(envelope);
    expect(validated.type).toBe('PROJECT_E2E_PASS');
    expect(validated.stage_id).toBe('P1');
    expect(validated.payload.verdict).toBe('PASS');
    expect(result.receiptDigest).toBe(validated.digest);
    const chain = verifyReceiptChain(fx.receiptsDir);
    expect(chain.valid).toBe(true);
  });

  it('FAIL: failing step → PROJECT_E2E_FAIL receipt, success false', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const steps: RuntimeProofStep[] = [
      { id: 'fail-step', executable: 'node', args: ['-e', 'process.exit(1)'] },
    ];
    const compiled = compileProjectAcceptance(compileInput(fx, stage, steps), manifestPath);
    expect(compiled.success).toBe(true);

    const result = await runProjectAcceptanceE2E(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
      { projectRoot: fx.root, receiptDir: fx.receiptsDir },
    );

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('FAIL');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.steps[0].exit_code).toBe(1);
    const envelope = JSON.parse(fs.readFileSync(result.receiptPath!, 'utf-8'));
    expect(validateReceipt(envelope).type).toBe('PROJECT_E2E_FAIL');
  });

  it('BLOCKED: empty e2e_steps fails schema validation (manifest schema min(1))', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const bad = compileInput(fx, stage, []);
    bad['e2e_steps'] = [];

    const result = await runProjectAcceptanceE2E(bad, { projectRoot: fx.root, receiptDir: fx.receiptsDir });
    expect(result.success).toBe(false);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.errors.join('\n')).toContain('e2e_steps');
    expect(result.receiptPath).toBeUndefined();
  });

  it('BLOCKED: all steps not_applicable → PROJECT_E2E_ALL_SKIPPED', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const steps: RuntimeProofStep[] = [
      { id: 'skip-1', executable: 'node', args: [], not_applicable: { reason: 'n/a' } },
    ];
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, steps), manifestPath);
    expect(compiled.success).toBe(true);

    const result = await runProjectAcceptanceE2E(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
      { projectRoot: fx.root, receiptDir: fx.receiptsDir },
    );
    expect(result.success).toBe(false);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.errors[0]).toContain('PROJECT_E2E_ALL_SKIPPED');
    expect(result.receiptPath).toBeUndefined();
  });

  it('BLOCKED: topology violation (service_start without stop) — no receipt', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const steps: RuntimeProofStep[] = [
      {
        id: 'start-only',
        type: 'service_start',
        executable: 'node',
        args: ['-e', 'setInterval(function() {}, 60000)'],
      },
    ];
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, steps), manifestPath);
    expect(compiled.success).toBe(true);

    const result = await runProjectAcceptanceE2E(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
      { projectRoot: fx.root, receiptDir: fx.receiptsDir },
    );
    expect(result.success).toBe(false);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.errors.join('\n')).toContain('SERVICE_START_WITHOUT_STOP');
    expect(result.receiptPath).toBeUndefined();
  });

  it('BLOCKED: stale snapshot → PROJECT_SOURCE_STALE', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, passingSteps()), manifestPath);
    expect(compiled.success).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.expected_snapshot = 'deadbeefdeadbeef';

    const result = await runProjectAcceptanceE2E(manifest, { projectRoot: fx.root, receiptDir: fx.receiptsDir });
    expect(result.success).toBe(false);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.errors[0]).toContain('PROJECT_SOURCE_STALE');
    expect(result.receiptPath).toBeUndefined();
  });

  it('FAIL: expected output_contains not found', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const steps: RuntimeProofStep[] = [
      {
        id: 'wrong-output',
        executable: 'node',
        args: ['-e', 'console.log("actual")'],
        expected: { output_contains: 'nonexistent text' },
      },
    ];
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, steps), manifestPath);
    expect(compiled.success).toBe(true);

    const result = await runProjectAcceptanceE2E(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
      { projectRoot: fx.root, receiptDir: fx.receiptsDir },
    );
    expect(result.success).toBe(false);
    expect(result.verdict).toBe('FAIL');
    expect(result.errors.join('\n')).toContain('does not contain expected text');
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.verdict).toBe('FAIL');
  });

  it('PASS: expected.exit_code null accepts any exit code', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const steps: RuntimeProofStep[] = [
      { id: 'any-exit', executable: 'node', args: ['-e', 'process.exit(3)'], expected: { exit_code: null } },
    ];
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, steps), manifestPath);
    expect(compiled.success).toBe(true);

    const result = await runProjectAcceptanceE2E(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
      { projectRoot: fx.root, receiptDir: fx.receiptsDir },
    );
    expect(result.success).toBe(true);
    expect(result.verdict).toBe('PASS');
    expect(result.receipt!.steps[0].exit_code).toBe(3);
  });

  it('FAIL: exit_code mismatch', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const steps: RuntimeProofStep[] = [
      { id: 'mismatch', executable: 'node', args: ['-e', 'process.exit(2)'], expected: { exit_code: 0 } },
    ];
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, steps), manifestPath);
    expect(compiled.success).toBe(true);

    const result = await runProjectAcceptanceE2E(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
      { projectRoot: fx.root, receiptDir: fx.receiptsDir },
    );
    expect(result.success).toBe(false);
    expect(result.verdict).toBe('FAIL');
    expect(result.errors.join('\n')).toContain('exited 2, expected 0');
  });

  it('PASS: service lifecycle (service_start with readiness + service_stop) + cleanup', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const steps: RuntimeProofStep[] = [
      {
        id: 'srv-up',
        type: 'service_start',
        executable: 'node',
        args: ['-e', 'console.log("ready"); setInterval(function() {}, 60000)'],
        readiness_signal: 'ready',
        timeout_ms: 10000,
      },
      { id: 'srv-down', type: 'service_stop', executable: 'node', args: [], service_ref: 'srv-up' },
    ];
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, steps), manifestPath);
    expect(compiled.success).toBe(true);

    const result = await runProjectAcceptanceE2E(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
      { projectRoot: fx.root, receiptDir: fx.receiptsDir },
    );
    expect(result.success).toBe(true);
    expect(result.verdict).toBe('PASS');
    expect(result.receipt!.steps).toHaveLength(2);
    expect(result.receipt!.steps[0].observations).toContain('PID');
    expect(result.receipt!.steps[1].exit_code).toBe(0);
    expect(result.receipt!.service_cleanup.cleaned).toEqual([]);
    expect(result.receipt!.service_cleanup.remainingPids).toEqual([]);
  }, 30000);
});

// ============================================================
// finalizeProjectReview
// ============================================================

describe('finalizeProjectReview (FINALIZE_PROJECT_REVIEW)', () => {
  /** Build the complete happy-path chain and return all bound paths. */
  async function buildChain() {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, passingSteps()), manifestPath);
    expect(compiled.success).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const manifestDigest = computeCanonicalJsonDigest(manifest);

    const e2e = await runProjectAcceptanceE2E(manifest, {
      projectRoot: fx.root,
      receiptDir: fx.receiptsDir,
    });
    expect(e2e.success).toBe(true);
    const e2eFileDigest = fileDigest16(e2e.receiptPath!);

    const reviewerPath = writeReviewerResult(
      fx,
      manifestPath,
      manifestDigest,
      e2e.receiptPath!,
      e2eFileDigest,
      manifest.expected_snapshot,
      manifest.acceptance_criteria,
    );
    return { fx, manifestPath, e2e, reviewerPath };
  }

  it('accepts a fully consistent chain → PROJECT_REVIEW_PASS chained to the E2E gate', async () => {
    const { fx, manifestPath, e2e, reviewerPath } = await buildChain();

    const result = finalizeProjectReview({
      manifestPath,
      e2eReceiptPath: e2e.receiptPath!,
      reviewerResultPath: reviewerPath,
      outputDir: fx.receiptsDir,
    });

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(result.receiptPath!)).toBe(true);

    const envelope = JSON.parse(fs.readFileSync(result.receiptPath!, 'utf-8'));
    const validated = validateReceipt(envelope);
    expect(validated.type).toBe('PROJECT_REVIEW_PASS');
    expect(validated.stage_id).toBe('P1');
    // Chain: previous_digest = E2E gate envelope digest.
    const e2eEnvelope = JSON.parse(fs.readFileSync(e2e.receiptPath!, 'utf-8'));
    expect(validated.previous_digest).toBe(e2eEnvelope.digest);
    expect(validated.payload.verdict).toBe('PROJECT_ACCEPTED');
    expect(validated.payload.criteria_results).toHaveLength(2);
    const payloadStageReceipts = (validated.payload as { stage_receipts?: unknown[] }).stage_receipts ?? [];
    expect(payloadStageReceipts).toHaveLength(1);
    const sr = payloadStageReceipts[0] as {
      stage_id: string;
      review: { digest: string };
      gate: { digest: string };
      stage_manifest: { digest: string };
      snapshot: string;
    };
    expect(sr.stage_id).toBe('S01');
    // vNext stage digests: manifest/review/gate are 64-hex, snapshot is 40-hex.
    expect(sr.stage_manifest.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(sr.review.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(sr.gate.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(sr.snapshot).toMatch(/^[a-f0-9]{40}$/);
    const payloadE2ERef = validated.payload.project_e2e_receipt as { path: string; digest: string };
    expect(payloadE2ERef.path).toBe(path.resolve(e2e.receiptPath!));
    expect(payloadE2ERef.digest).toBe(fileDigest16(e2e.receiptPath!));
    // verifyReceiptChain over the same directory (E2E genesis + review tip).
    const chain = verifyReceiptChain(fx.receiptsDir);
    expect(chain.valid).toBe(true);
  });

  it('rejects a FAIL E2E gate receipt (verdict must be PASS)', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const steps: RuntimeProofStep[] = [
      { id: 'fail-step', executable: 'node', args: ['-e', 'process.exit(1)'] },
    ];
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, steps), manifestPath);
    expect(compiled.success).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const e2e = await runProjectAcceptanceE2E(manifest, { projectRoot: fx.root, receiptDir: fx.receiptsDir });
    expect(e2e.verdict).toBe('FAIL');
    const reviewerPath = writeReviewerResult(
      fx,
      manifestPath,
      computeCanonicalJsonDigest(manifest),
      e2e.receiptPath!,
      fileDigest16(e2e.receiptPath!),
      manifest.expected_snapshot,
      manifest.acceptance_criteria,
    );

    const result = finalizeProjectReview({
      manifestPath,
      e2eReceiptPath: e2e.receiptPath!,
      reviewerResultPath: reviewerPath,
      outputDir: fx.receiptsDir,
    });
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('expected "PASS"');
  });

  it('rejects a PROJECT_REJECTED reviewer result', async () => {
    const { fx, manifestPath, e2e, reviewerPath } = await buildChain();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const rejectedPath = writeReviewerResult(
      fx,
      manifestPath,
      computeCanonicalJsonDigest(manifest),
      e2e.receiptPath!,
      fileDigest16(e2e.receiptPath!),
      manifest.expected_snapshot,
      manifest.acceptance_criteria,
      'PROJECT_REJECTED',
    );

    const result = finalizeProjectReview({
      manifestPath,
      e2eReceiptPath: e2e.receiptPath!,
      reviewerResultPath: rejectedPath,
      outputDir: fx.receiptsDir,
    });
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('expected "PROJECT_ACCEPTED"');
    // Nothing written on failure.
    expect(result.receiptPath).toBeUndefined();
  });

  it('rejects a criteria mismatch (missing criterion result)', async () => {
    const { fx, manifestPath, e2e } = await buildChain();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    // Reviewer only covers AC-01 → AC-02 missing.
    const reviewer = {
      verdict: 'PROJECT_ACCEPTED',
      reviewer: 'project-reviewer',
      reviewed_snapshot: manifest.expected_snapshot,
      project_manifest: { path: path.resolve(manifestPath), digest: computeCanonicalJsonDigest(manifest) },
      project_e2e_receipt: { path: path.resolve(e2e.receiptPath!), digest: fileDigest16(e2e.receiptPath!) },
      criteria_results: [{ criteria: 'AC-01', passed: true }],
      findings: [],
      accepted_deviations: [],
      reviewed_at: '2025-01-01T01:00:00.000Z',
    };
    const reviewerPath = path.join(fx.artifacts, 'reviewer-result.json');
    fs.writeFileSync(reviewerPath, JSON.stringify(reviewer, null, 2), 'utf-8');

    const result = finalizeProjectReview({
      manifestPath,
      e2eReceiptPath: e2e.receiptPath!,
      reviewerResultPath: reviewerPath,
      outputDir: fx.receiptsDir,
    });
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('Missing criteria result');
  });

  it('rejects a missing manifest file', () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const result = finalizeProjectReview({
      manifestPath: path.join(fx.artifacts, 'nope.json'),
      e2eReceiptPath: path.join(fx.artifacts, 'e2e.json'),
      reviewerResultPath: path.join(fx.artifacts, 'reviewer.json'),
      outputDir: fx.receiptsDir,
    });
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('Manifest not found');
  });

  it('rejects a tampered stage gate envelope (self-digest broken, digest-addressed)', async () => {
    const { fx, manifestPath, e2e, reviewerPath } = await buildChain();
    // Tamper the stage gate payload AFTER the manifest was bound → the
    // envelope self-digest no longer matches its content → fail closed.
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const gatePath = manifest.stage_receipts[0].gate_receipt.path;
    const gate = JSON.parse(fs.readFileSync(gatePath, 'utf-8'));
    (gate.payload as Record<string, unknown>)['summary'] = 'tampered';
    fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2), 'utf-8');

    const result = finalizeProjectReview({
      manifestPath,
      e2eReceiptPath: e2e.receiptPath!,
      reviewerResultPath: reviewerPath,
      outputDir: fx.receiptsDir,
    });
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('self-digest mismatch');
    expect(result.receiptPath).toBeUndefined();
  });

  /** Compile → run-e2e → reviewer → finalize over an arbitrary (possibly mutated) stage evidence set. */
  async function finalizeWithStage(fx: RepoFx, stage: StageEvidence) {
    const manifestPath = path.join(fx.artifacts, 'project-manifest.json');
    const compiled = compileProjectAcceptance(compileInput(fx, stage, passingSteps()), manifestPath);
    expect(compiled.success).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const e2e = await runProjectAcceptanceE2E(manifest, {
      projectRoot: fx.root,
      receiptDir: fx.receiptsDir,
    });
    expect(e2e.success).toBe(true);
    const reviewerPath = writeReviewerResult(
      fx,
      manifestPath,
      computeCanonicalJsonDigest(manifest),
      e2e.receiptPath!,
      fileDigest16(e2e.receiptPath!),
      manifest.expected_snapshot,
      manifest.acceptance_criteria,
    );
    return finalizeProjectReview({
      manifestPath,
      e2eReceiptPath: e2e.receiptPath!,
      reviewerResultPath: reviewerPath,
      outputDir: fx.receiptsDir,
    });
  }

  it('rejects a stage manifest digest mismatch (vNext canonical digest binding)', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    // Tamper the stage manifest AFTER binding: the canonical digest changes
    // while the declared digest stays the original → mismatch.
    const manifest = JSON.parse(fs.readFileSync(stage.stageManifestPath, 'utf-8'));
    (manifest.plan as Record<string, unknown>)['plan_digest'] = 'f'.repeat(64);
    fs.writeFileSync(stage.stageManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const result = await finalizeWithStage(fx, stage);
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('declared digest');
    expect(result.receiptPath).toBeUndefined();
  });

  it('rejects a review verdict other than ACCEPTED', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const review = makeVNextEnvelope({
      type: 'STAGE_REVIEW_PASS',
      stageId: 'S01',
      verdict: 'REJECTED',
      manifestDigest: stage.stageManifestDigest,
      snapshotDigest: SNAPSHOT_HEX40,
      stageGateReceiptDigest: stage.gateDigest,
    });
    fs.writeFileSync(stage.reviewPath, JSON.stringify(review, null, 2), 'utf-8');

    const result = await finalizeWithStage(fx, { ...stage, reviewDigest: review['digest'] as string });
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('expected "ACCEPTED"');
  });

  it('rejects a gate verdict other than PASS', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const gate = makeVNextEnvelope({
      type: 'GATE_PASS',
      stageId: 'S01',
      verdict: 'FAIL',
      manifestDigest: stage.stageManifestDigest,
      snapshotDigest: SNAPSHOT_HEX40,
    });
    fs.writeFileSync(stage.gatePath, JSON.stringify(gate, null, 2), 'utf-8');

    const result = await finalizeWithStage(fx, { ...stage, gateDigest: gate['digest'] as string });
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('expected "PASS"');
  });

  it('rejects a review↔gate snapshot mismatch', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const review = makeVNextEnvelope({
      type: 'STAGE_REVIEW_PASS',
      stageId: 'S01',
      verdict: 'ACCEPTED',
      manifestDigest: stage.stageManifestDigest,
      snapshotDigest: '9'.repeat(40),
      stageGateReceiptDigest: stage.gateDigest,
    });
    fs.writeFileSync(stage.reviewPath, JSON.stringify(review, null, 2), 'utf-8');

    const result = await finalizeWithStage(fx, { ...stage, reviewDigest: review['digest'] as string });
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('Review snapshot');
    expect(result.errors.join('\n')).toContain('Gate snapshot');
  });

  it('rejects a stage_id mismatch between the review/gate and the manifest entry', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const review = makeVNextEnvelope({
      type: 'STAGE_REVIEW_PASS',
      stageId: 'S99',
      verdict: 'ACCEPTED',
      manifestDigest: stage.stageManifestDigest,
      snapshotDigest: SNAPSHOT_HEX40,
      stageGateReceiptDigest: stage.gateDigest,
    });
    fs.writeFileSync(stage.reviewPath, JSON.stringify(review, null, 2), 'utf-8');

    const result = await finalizeWithStage(fx, { ...stage, reviewDigest: review['digest'] as string });
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('Review stage_id "S99" != manifest entry "S01"');
  });

  it('rejects a broken review→gate triple binding (stage_gate_receipt_digest mismatch)', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    const review = makeVNextEnvelope({
      type: 'STAGE_REVIEW_PASS',
      stageId: 'S01',
      verdict: 'ACCEPTED',
      manifestDigest: stage.stageManifestDigest,
      snapshotDigest: SNAPSHOT_HEX40,
      stageGateReceiptDigest: 'f'.repeat(64),
    });
    fs.writeFileSync(stage.reviewPath, JSON.stringify(review, null, 2), 'utf-8');

    const result = await finalizeWithStage(fx, { ...stage, reviewDigest: review['digest'] as string });
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('triple binding');
  });

  it('rejects legacy/v1 stage manifests (archived stages are not part of acceptance)', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    // Strip the version discriminator → v1 legacy manifest → fail closed.
    const legacy = JSON.parse(fs.readFileSync(stage.stageManifestPath, 'utf-8'));
    delete (legacy as Record<string, unknown>)['version'];
    fs.writeFileSync(stage.stageManifestPath, JSON.stringify(legacy, null, 2), 'utf-8');

    const result = await finalizeWithStage(fx, stage);
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('not a vNext manifest');
    expect(result.errors.join('\n')).toContain('archived and not part of acceptance');
    expect(result.receiptPath).toBeUndefined();
  });

  it('rejects legacy flat review/gate receipts (envelope schema fail closed)', async () => {
    const fx = makeRepoFx();
    fx.commitAll();
    const stage = writeStageEvidence(fx);
    // Replace the review envelope with a legacy flat receipt (no envelope).
    const legacyReview = {
      stage_id: 'S01',
      verdict: 'ACCEPTED',
      snapshot: SNAPSHOT_HEX16,
      manifest_digest: stage.stageManifestDigest.slice(0, 16),
      stage_gate_receipt: { path: stage.gatePath, digest: stage.gateDigest.slice(0, 16) },
      findings: [],
      reviewer: 'stage-reviewer',
      reviewed_at: '2025-01-01T00:00:10.000Z',
    };
    fs.writeFileSync(stage.reviewPath, JSON.stringify(legacyReview, null, 2), 'utf-8');

    const result = await finalizeWithStage(fx, stage);
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('kernel envelope');
    expect(result.receiptPath).toBeUndefined();
  });

  // Guard: the E2E PASS payload itself must round-trip through the parser
  // used by finalize (parseProjectE2EReceipt PASS superRefine).
  it('produces an E2E PASS payload accepted by the receipt parser', async () => {
    const { e2e } = await buildChain();
    const payload = e2e.receipt as ProjectE2EReceipt;
    expect(payload.verdict).toBe('PASS');
    expect(payload.steps.filter((s) => !s.skipped).length).toBeGreaterThan(0);
    expect(payload.service_cleanup.failed).toEqual([]);
  });
});
