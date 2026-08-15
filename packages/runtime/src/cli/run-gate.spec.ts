/**
 * run-gate.spec.ts — v1/vNext Gate routes
 *
 * The Gate never executes Manifest runtime_proof steps (transition check
 * deleted by the 2026-08-13 ruling; build/test is the Stage Review's job):
 * the v1 route decides PASS/FAIL from the Slice COMPLETE facts alone, and
 * the vNext route delegates integration completeness to the admission
 * consumer.  This spec covers the remaining CLI contract: facts validation,
 * result persistence, vNext integrated-prefix PASS/FAIL, archive refusal,
 * re-gate, and the canonical Stage ID guard.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Manifest } from '@proofloop/kernel';
import { validateManifest } from '@proofloop/kernel';
import { runGate, runGateCli } from './run-gate';

// ============================================================
// Fixture helpers
// ============================================================

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-H';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function makeManifest(steps: Array<Record<string, unknown>>): Manifest {
  return {
    stage_id: STAGE_ID,
    source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
    source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
    stage_goal: 'Runtime CLI surface',
    outcomes: ['service lifecycle'],
    slices: [
      {
        slice_id: SLICE_ID,
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
        tasks: ['S03-H-T01'],
        risk_facts: ['persistent_state'],
        evidence_path: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
        cv_minimum_level: 'enhanced',
      },
    ],
    dependencies: [],
    risk_facts: ['public_api_change: true'],
    runtime_proof: steps as unknown as Manifest['runtime_proof'],
  };
}

interface GateFixture {
  readonly dir: string;
  readonly result: Awaited<ReturnType<typeof runGate>>;
}

/** Write manifest + facts into a fresh temp dir and run the gate. */
async function gateFixture(steps: Array<Record<string, unknown>>): Promise<GateFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
  cleanups.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
  const manifest = makeManifest(steps);
  expect(() => validateManifest(manifest)).not.toThrow();
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  const factsPath = path.join(dir, 'facts.json');
  fs.writeFileSync(factsPath, JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
  const result = await runGate({
    manifestPath,
    factsPath,
    outputDir: path.join(dir, 'out'),
    projectRoot: dir,
  });
  return { dir, result };
}



/** command step — scripts must avoid shell operator chars (runProcess enforces). */
function commandStep(id: string, script: string, expected: unknown, timeoutMs = 10000): Record<string, unknown> {
  return {
    id,
    type: 'command',
    executable: 'node',
    args: ['-e', script],
    cwd: '.',
    timeout_ms: timeoutMs,
    ...(expected !== undefined ? { expected } : {}),
  };
}


// ============================================================
// service_start
// ============================================================

describe('run-gate CLI', () => {
  it('runGateCli returns 0 on PASS and prints the result JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(makeManifest([
      commandStep('ok', 'process.exit(0)', { exit_code: 0 }),
    ]), null, 2), 'utf-8');
    fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
    const code = await runGateCli([path.join(dir, 'manifest.json'), path.join(dir, 'facts.json'), path.join(dir, 'out'), dir]);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'out', 'gate-result.json'))).toBe(true);
  });

  it('runGateCli returns 1 on FAIL (facts not integrated; no runtime_proof steps are executed)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(makeManifest([]), null, 2), 'utf-8');
    fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify([{ slice_id: SLICE_ID, integrated: false }]), 'utf-8');
    const code = await runGateCli([path.join(dir, 'manifest.json'), path.join(dir, 'facts.json'), path.join(dir, 'out'), dir]);
    expect(code).toBe(1);
  });

  it('runGateCli returns 1 with usage text when args are missing', async () => {
    const code = await runGateCli([]);
    expect(code).toBe(1);
  });
});
import { execFileSync } from 'node:child_process';
import {
  admitVNextCVResult,
  admitVNextIntegration,
  admitVNextStagePlan,
  admitVNextStageReview,
  admitVNextWorkerResult,
  computeVNextSpvPassReceiptDigest,
  defaultReceiptWriter,
  resolveVNextReference,
  VNextNextActionService,
} from '@proofloop/runtime';
import type { VNextSpvPassReceipt } from '@proofloop/runtime';
import { computeDigest, computeReceiptDigest } from '@proofloop/kernel';
import { admitVNextSliceCommit } from '../vnext/commit-admission';
import { runGateVNext } from './run-gate';

// ============================================================
// vNext Stage Gate route (S08-E-T06) — runGateVNext + runGateCli
// ============================================================

const REPO = path.resolve(__dirname, '../../../..');

function copyFixture(root: string, relative: string): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(REPO, relative), destination);
}

/** Minimal vNext planning stage without the integrated Slices. */
function vNextAcceptedFixture(): { dir: string; manifestPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-vnext-'));
  cleanups.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'run-gate-vnext@test.local']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'run-gate vNext']);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.proofloop/\n', 'utf8');
  for (const relative of [
    'delivery/stages/S04/tasks.md',
    '.proofloop/manifests/S04.json',
    'delivery/stages/S04/evidence/S04-A.md',
    'delivery/stages/S0-A/tasks.md',
  ]) {
    vFixtureCopy(dir, relative);
  }
  const tasksPath = path.join(dir, 'delivery/stages/S04/tasks.md');
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- Worker Status: `NOT_STARTED`', '- Worker Status: `planned`'),
    'utf8',
  );
  fs.mkdirSync(path.join(dir, 'packages'), { recursive: true });
  const manifestPath = path.join(dir, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
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
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root: dir, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'vNext run-gate planning boundary']);
  return { dir, manifestPath };
}

function vFixtureCopy(root: string, relative: string): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(REPO, relative), destination);
}

/**
 * P-11 task B fixture seam：手工写入合法 v2 STAGE_CLOSE_RESULT envelope
 * （任务 A 的 admit seam 未就绪前，测试直接构造自 digest 一致的 envelope
 * 文件到 stage-close 目录）。
 */
function writeStageCloseReceipt(root: string, stageId: string, closeType = 'COMPLETED'): string {
  const content = {
    version: 1,
    type: 'STAGE_CLOSE_PASS',
    stage_id: stageId,
    timestamp: '2026-08-20T10:00:00.000Z',
    payload: {
      schema_version: 2,
      type: 'STAGE_CLOSE_RESULT',
      action: 'STAGE_CLOSE',
      stage_id: stageId,
      close_type: closeType,
      reason: 'stage closed (fixture)',
      manifest_digest: 'a'.repeat(64),
    },
  };
  const digest = computeReceiptDigest(content);
  const directory = path.join(root, '.proofloop', 'receipts', 'stage-close', stageId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${digest}.json`), JSON.stringify({ ...content, digest }, null, 2), 'utf8');
  return digest;
}

describe('run-gate vNext Gate route', () => {
  it('refuses a vNext run without the integrated prefix (no receipt, honest FAIL)', async () => {
    const { dir, manifestPath } = vNextAcceptedFixture();
    const result = await runGateVNext({
      manifestPath,
      factsPath: '',
      outputDir: path.join(dir, 'out'),
      projectRoot: dir,
    });
    expect(result.success).toBe(false);
    expect(result.gate).toBe('FAIL');
    if (result.errors.some((message) => /Integration Receipt|authority is unavailable/i.test(message))) {
      // ok
    } else {
      throw new Error('stage plan refused: ' + JSON.stringify(result.errors));
    }
    expect(result.errors.some((message) => /Integration Receipt|authority is unavailable/i.test(message))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.proofloop/receipts/stage-gate/S04'))).toBe(false);
  });

  it('PASSes on a fully integrated vNext stage and persists the GATE_PASS receipt', async () => {
    const { dir, manifestPath } = vNextAcceptedFixture();
    const root = dir;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    const manifestDigest = computeDigest(manifest);
    const planDigest = manifest.plan.plan_digest as string;
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
    const snapshotDigest = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const spvContent = {
      version: 2 as const,
      schema_version: 2 as const,
      type: 'SPV_PASS' as const,
      stage_id: 'S04',
      manifest_digest: manifestDigest,
      plan_digest: planDigest,
      snapshot_digest: snapshotDigest,
    };
    const spv: VNextSpvPassReceipt = { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) };
    expect(admitVNextStagePlan({
      version: 2,
      schema_version: 2,
      type: 'STAGE_PLAN_ADMISSION',
      project_root: root,
      manifest_path: '.proofloop/manifests/S04.json',
      stage_id: 'S04',
      manifest_digest: manifestDigest,
      plan_digest: planDigest,
      snapshot_digest: snapshotDigest,
      spv,
    }).accepted).toBe(true);

    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest,
      persistContext: true,
    });
    const context = JSON.parse(fs.readFileSync(path.join(root, next.context_ref as string), 'utf8')) as {
      context_digest: string;
    };

    fs.writeFileSync(path.join(root, 'packages/worker-test.ts'), 'export const fixture = true;\n', 'utf8');
    fs.writeFileSync(tasksPath, fs.readFileSync(tasksPath, 'utf8').replace('- [ ] S04-A-T01', '- [x] S04-A-T01').replace('- Worker Status: `planned`', '- Worker Status: `executing`'), 'utf8');
fs.writeFileSync(
    evidencePath,
    fs.readFileSync(evidencePath, 'utf8').replace(
      '## Task Evidence\n\n*Not yet captured.*',
      [
        '## Task Evidence',
      '',
      '### S04-A-T01',
      '',
      '- Task Goal: run-gate vNext',
      '- Relevant PO IDs: PO-FIXTURE',
      '- Source Snapshot: fixture-source',
      '- Current Snapshot: fixture-current',
      '- Changed Files:',
      '  - delivery/stages/S04/evidence/S04-A.md',
      '  - delivery/stages/S04/tasks.md',
      '  - packages/worker-test.ts',
      '- RED Receipt:',
      '  - Test ID: integration-red',
      '  - Command: integration-red-command',
      '  - Failure Output: integration-red-output',
      '  - Expected Failure: integration-red-expected',
      '  - Snapshot: integration-red-snapshot',
      '- GREEN Receipt:',
      '  - Test ID: integration-green',
      '  - Command: integration-green-command',
      '  - Pass Output: integration-green-output',
      '  - Snapshot: integration-green-snapshot',
      '- Status: COMPLETE',
      '',
      ].join('\n'),
    ),
    'utf8',
  );
    const proofIndex = (manifest.slices as Array<Record<string, any>>)[0].proof_index as Record<string, any>;
    const worker = admitVNextWorkerResult({
      schemaVersion: 2,
      actionToken: 'run-gate-worker-1',
      stageId: 'S04',
      sliceId: 'S04-A',
      taskId: 'S04-A-T01',
      mode: 'implement-task',
      outcome: 'completed',
      evidenceRef: 'delivery/stages/S04/evidence/S04-A.md',
      changedFiles: ['delivery/stages/S04/evidence/S04-A.md', 'delivery/stages/S04/tasks.md', 'packages/worker-test.ts'],
      verificationRuns: [],
      summary: 'run-gate vNext Worker completed',
      manifestDigest,
      planDigest,
      proofIndexDigest: next.proof_index_digest,
      snapshotDigest,
      contextRef: next.context_ref,
      contextDigest: context.context_digest,
    }, { projectRoot: root, writer: defaultReceiptWriter });
    if (!worker.accepted) throw new Error('worker admission failed: ' + JSON.stringify(worker.findings));
    expect(worker.accepted).toBe(true);

    const cv = admitVNextCVResult({
      schema_version: 2,
      type: 'CV_RESULT',
      stage_id: 'S04',
      slice_id: 'S04-A',
      worker_receipt_digest: worker.receipt_ref as string,
      manifest_digest: manifestDigest,
      plan_digest: planDigest,
      proof_index_digest: next.proof_index_digest,
      context_ref: next.context_ref,
      context_digest: context.context_digest,
      snapshot_digest: snapshotDigest,
      verification_type: 'initial',
      verdict: 'PASS',
      summary: 'run-gate vNext fixture CV pass',
      acceptance_refs_checked: [...(proofIndex.acceptance_refs as string[])],
      seam_refs_checked: [...(proofIndex.seam_refs as string[])],
      oracle_refs_checked: [...(proofIndex.oracle_refs as string[])],
      risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
        ref_id: risk.ref_id,
        applicability: 'APPLICABLE',
        reason: 'run-gate fixture binding',
      })),
      failed_acceptance_refs: [],
      invalid_tests: [],
      counterexamples: [],
      scope_violations: [],
      forbidden_substitutions: [],
      regression_failures: [],
    }, { projectRoot: root, writer: defaultReceiptWriter });
    if (!cv.accepted) throw new Error('cv admission failed: ' + JSON.stringify(cv.findings));
    expect(cv.accepted).toBe(true);

    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'slice S04-A integration work']);
    const commitSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const commit = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
      cvReceiptDigest: cv.receipt_ref as string,
    }, { projectRoot: root, writer: defaultReceiptWriter });
    expect(commit.accepted).toBe(true);

    const integration = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
    }, { projectRoot: root, writer: defaultReceiptWriter });
    expect(integration.accepted).toBe(true);

    const result = await runGateVNext({
      manifestPath,
      factsPath: '',
      outputDir: path.join(root, 'out'),
      projectRoot: root,
    });
    expect(result.success).toBe(true);
    expect(result.gate).toBe('PASS');
    const gateDir = path.join(root, '.proofloop/receipts/stage-gate/S04');
    const receipts = fs.existsSync(gateDir) ? fs.readdirSync(gateDir) : [];
    expect(receipts).toHaveLength(1);
    const gateReceipt = JSON.parse(fs.readFileSync(path.join(gateDir, receipts[0]), 'utf8')) as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(gateReceipt.type).toBe('GATE_PASS');
    expect(gateReceipt.payload).toMatchObject({
      schema_version: 2,
      type: 'GATE_RESULT',
      action: 'GATE',
      manifest_digest: manifestDigest,
      // Dual-path SG: the default receipts path is recorded on the Receipt.
      verification_source: 'receipts',
    });
    const out = JSON.parse(fs.readFileSync(path.join(root, 'out/gate-result.json'), 'utf8')) as Record<string, unknown>;
    expect(out.success).toBe(true);
    expect((out.vnext as Record<string, unknown>).receipt_ref).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses an archived stage before any admission check（STAGE_CLOSE → honest FAIL with an archived finding, zero writes）', async () => {
    const { dir, manifestPath } = vNextAcceptedFixture();
    const closeDigest = writeStageCloseReceipt(dir, 'S04');
    const outDir = path.join(dir, 'out');
    const result = await runGateVNext({
      manifestPath,
      factsPath: '',
      outputDir: outDir,
      projectRoot: dir,
    });
    expect(result.success).toBe(false);
    expect(result.gate).toBe('FAIL');
    // 归档守卫先于 admission 触发：错误是 archived，不是缺失集成前缀。
    expect(result.errors.some((message) => /is archived/i.test(message))).toBe(true);
    expect(result.errors.some((message) => /is archived/i.test(message) && message.includes(closeDigest))).toBe(true);
    expect(result.errors.some((message) => /Integration Receipt|authority is unavailable/i.test(message))).toBe(false);
    // 零写入：不写 gate-result.json、不写任何 GATE Receipt。
    expect(fs.existsSync(path.join(outDir, 'gate-result.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.proofloop/receipts/stage-gate/S04'))).toBe(false);
  });

  it('re-gates after a REPAIR review via reGate: true (new PASS tip appended, old PASS kept as history)', async () => {
    const { dir, manifestPath } = vNextAcceptedFixture();
    const root = dir;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    const manifestDigest = computeDigest(manifest);
    const planDigest = manifest.plan.plan_digest as string;
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
    const snapshotDigest = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const spvContent = {
      version: 2 as const,
      schema_version: 2 as const,
      type: 'SPV_PASS' as const,
      stage_id: 'S04',
      manifest_digest: manifestDigest,
      plan_digest: planDigest,
      snapshot_digest: snapshotDigest,
    };
    const spv: VNextSpvPassReceipt = { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) };
    expect(admitVNextStagePlan({
      version: 2,
      schema_version: 2,
      type: 'STAGE_PLAN_ADMISSION',
      project_root: root,
      manifest_path: '.proofloop/manifests/S04.json',
      stage_id: 'S04',
      manifest_digest: manifestDigest,
      plan_digest: planDigest,
      snapshot_digest: snapshotDigest,
      spv,
    }).accepted).toBe(true);

    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest,
      persistContext: true,
    });
    const context = JSON.parse(fs.readFileSync(path.join(root, next.context_ref as string), 'utf8')) as {
      context_digest: string;
    };

    fs.writeFileSync(path.join(root, 'packages/worker-test.ts'), 'export const fixture = true;\n', 'utf8');
    fs.writeFileSync(tasksPath, fs.readFileSync(tasksPath, 'utf8').replace('- [ ] S04-A-T01', '- [x] S04-A-T01').replace('- Worker Status: `planned`', '- Worker Status: `executing`'), 'utf8');
    fs.writeFileSync(
      evidencePath,
      fs.readFileSync(evidencePath, 'utf8').replace(
        '## Task Evidence\n\n*Not yet captured.*',
        [
          '## Task Evidence',
          '',
          '### S04-A-T01',
          '',
          '- Task Goal: run-gate vNext',
          '- Relevant PO IDs: PO-FIXTURE',
          '- Source Snapshot: fixture-source',
          '- Current Snapshot: fixture-current',
          '- Changed Files:',
          '  - delivery/stages/S04/evidence/S04-A.md',
          '  - delivery/stages/S04/tasks.md',
          '  - packages/worker-test.ts',
          '- RED Receipt:',
          '  - Test ID: integration-red',
          '  - Command: integration-red-command',
          '  - Failure Output: integration-red-output',
          '  - Expected Failure: integration-red-expected',
          '  - Snapshot: integration-red-snapshot',
          '- GREEN Receipt:',
          '  - Test ID: integration-green',
          '  - Command: integration-green-command',
          '  - Pass Output: integration-green-output',
          '  - Snapshot: integration-green-snapshot',
          '- Status: COMPLETE',
          '',
        ].join('\n'),
      ),
      'utf8',
    );
    const proofIndex = (manifest.slices as Array<Record<string, any>>)[0].proof_index as Record<string, any>;
    const worker = admitVNextWorkerResult({
      schemaVersion: 2,
      actionToken: 'run-gate-worker-1',
      stageId: 'S04',
      sliceId: 'S04-A',
      taskId: 'S04-A-T01',
      mode: 'implement-task',
      outcome: 'completed',
      evidenceRef: 'delivery/stages/S04/evidence/S04-A.md',
      changedFiles: ['delivery/stages/S04/evidence/S04-A.md', 'delivery/stages/S04/tasks.md', 'packages/worker-test.ts'],
      verificationRuns: [],
      summary: 'run-gate vNext Worker completed',
      manifestDigest,
      planDigest,
      proofIndexDigest: next.proof_index_digest,
      snapshotDigest,
      contextRef: next.context_ref,
      contextDigest: context.context_digest,
    }, { projectRoot: root, writer: defaultReceiptWriter });
    if (!worker.accepted) throw new Error('worker admission failed: ' + JSON.stringify(worker.findings));
    expect(worker.accepted).toBe(true);

    const cv = admitVNextCVResult({
      schema_version: 2,
      type: 'CV_RESULT',
      stage_id: 'S04',
      slice_id: 'S04-A',
      worker_receipt_digest: worker.receipt_ref as string,
      manifest_digest: manifestDigest,
      plan_digest: planDigest,
      proof_index_digest: next.proof_index_digest,
      context_ref: next.context_ref,
      context_digest: context.context_digest,
      snapshot_digest: snapshotDigest,
      verification_type: 'initial',
      verdict: 'PASS',
      summary: 'run-gate vNext fixture CV pass',
      acceptance_refs_checked: [...(proofIndex.acceptance_refs as string[])],
      seam_refs_checked: [...(proofIndex.seam_refs as string[])],
      oracle_refs_checked: [...(proofIndex.oracle_refs as string[])],
      risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
        ref_id: risk.ref_id,
        applicability: 'APPLICABLE',
        reason: 'run-gate fixture binding',
      })),
      failed_acceptance_refs: [],
      invalid_tests: [],
      counterexamples: [],
      scope_violations: [],
      forbidden_substitutions: [],
      regression_failures: [],
    }, { projectRoot: root, writer: defaultReceiptWriter });
    if (!cv.accepted) throw new Error('cv admission failed: ' + JSON.stringify(cv.findings));
    expect(cv.accepted).toBe(true);

    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'slice S04-A integration work']);
    const commitSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const commit = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
      cvReceiptDigest: cv.receipt_ref as string,
    }, { projectRoot: root, writer: defaultReceiptWriter });
    expect(commit.accepted).toBe(true);

    const integration = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
    }, { projectRoot: root, writer: defaultReceiptWriter });
    expect(integration.accepted).toBe(true);

    // First Gate PASS at the integrated boundary.  The output dir lives under
    // the gitignored .proofloop/ so the tree stays clean for the review round.
    const runOutputDir = path.join(root, '.proofloop', 'runtime', 'S04');
    const first = await runGateVNext({
      manifestPath,
      factsPath: '',
      outputDir: runOutputDir,
      projectRoot: root,
    });
    expect(first.success).toBe(true);
    expect(first.gate).toBe('PASS');
    const gateDir = path.join(root, '.proofloop/receipts/stage-gate/S04');
    let receipts = fs.existsSync(gateDir) ? fs.readdirSync(gateDir).filter((name) => name.endsWith('.json')) : [];
    expect(receipts).toHaveLength(1);
    const firstDigest = receipts[0].replace(/\.json$/, '');

    // REPAIR review round at the integrated boundary.
    const review = admitVNextStageReview({
      type: 'stage_review',
      stageId: 'S04',
      verdict: 'REPAIR',
      manifestDigest,
      snapshotDigest: commitSha,
      summary: 'run-gate REPAIR round',
    }, { projectRoot: root });
    expect(review.accepted).toBe(true);

    // The repair fix advances HEAD.
    fs.appendFileSync(path.join(root, 'packages/worker-test.ts'), 'export const repaired = true;\n');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'repair fix after review REPAIR']);
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    // Without reGate the duplicate run is still refused (fail-closed).
    const refused = await runGateVNext({
      manifestPath,
      factsPath: '',
      outputDir: runOutputDir,
      projectRoot: root,
    });
    expect(refused.success).toBe(false);
    expect(refused.gate).toBe('FAIL');
    expect(refused.errors.join(' ')).toMatch(/re-gate refused/i);

    // Explicit re-gate: appended as the new chain tip at the advanced HEAD.
    const second = await runGateVNext({
      manifestPath,
      factsPath: '',
      outputDir: runOutputDir,
      projectRoot: root,
      reGate: true,
    });
    expect(second.success).toBe(true);
    expect(second.gate).toBe('PASS');
    const out2 = JSON.parse(fs.readFileSync(path.join(runOutputDir, 'gate-result.json'), 'utf8')) as Record<string, unknown>;
    const newDigest = (out2.vnext as Record<string, unknown>).receipt_ref as string;
    expect(newDigest).not.toBe(firstDigest);
    receipts = fs.readdirSync(gateDir).filter((name) => name.endsWith('.json'));
    expect(receipts).toHaveLength(2);
    const chain = receipts.map((name) =>
      JSON.parse(fs.readFileSync(path.join(gateDir, name), 'utf8')) as Record<string, any>,
    );
    const tip = chain.find((r) => r.digest === newDigest) as Record<string, any> | undefined;
    expect(tip).toBeDefined();
    expect((tip?.payload as Record<string, unknown>)?.snapshot_digest).toBe(head);
    expect(chain.some((r) => r.digest === firstDigest)).toBe(true);
  });
});

// ============================================================
// S09-REVIEW-001 — run-gate fails closed on a non-canonical Stage
// label in the manifest path BEFORE reading/executing anything
// ============================================================
describe('run-gate Stage ID guard before any read (S09-REVIEW-001)', () => {
  it('refuses a vNext manifest path whose stage label is the parked S08B0 label before reading the Manifest', async () => {
    const { dir, manifestPath } = vNextAcceptedFixture();
    const forgedPath = path.join(dir, '.proofloop/manifests/S08B0.json');
    fs.copyFileSync(manifestPath, forgedPath);
    const result = await runGateVNext({
      manifestPath: forgedPath,
      factsPath: '',
      outputDir: path.join(dir, 'out'),
      projectRoot: dir,
    });
    expect(result.success).toBe(false);
    expect(result.gate).toBe('FAIL');
    expect(result.steps).toEqual([]);
    expect(result.errors.join(' ')).toMatch(/canonical Stage ID/);
    // The Manifest was never read (route probe not reached) and nothing was
    // executed or written.
    expect(fs.existsSync(path.join(dir, '.proofloop/receipts/stage-gate/S08B0'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'out/gate-result.json'))).toBe(false);
  });

  it('refuses a vNext manifest path whose stage label is the parked S08B label before reading the Manifest', async () => {
    const { dir, manifestPath } = vNextAcceptedFixture();
    const forgedPath = path.join(dir, '.proofloop/manifests/S08B.json');
    fs.copyFileSync(manifestPath, forgedPath);
    const result = await runGateVNext({
      manifestPath: forgedPath,
      factsPath: '',
      outputDir: path.join(dir, 'out'),
      projectRoot: dir,
    });
    expect(result.success).toBe(false);
    expect(result.gate).toBe('FAIL');
    expect(result.steps).toEqual([]);
    expect(result.errors.join(' ')).toMatch(/canonical Stage ID/);
  });
});

// ============================================================
// S09-REVIEW-002-F01 — run-gate fails closed on the
// Manifest-DECLARED stage_id (parked S08B0/S08B) BEFORE any proof
// step executes and BEFORE any gate-result is written.  The
// manifest FILE name is irrelevant (manifest.json / S09.json are
// both fine) — the filename label guard cannot see the declared
// stage_id, so the declared value itself must be guarded.
// ============================================================
describe('run-gate Manifest-declared Stage ID guard (S09-REVIEW-002-F01)', () => {
  it('refuses a manifest.json whose declared stage_id is the parked S08B0 label before executing steps or writing gate-result', async () => {
    const { dir, manifestPath } = vNextAcceptedFixture();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    manifest.stage_id = 'S08B0';
    const forgedPath = path.join(dir, '.proofloop/manifests/manifest.json');
    fs.writeFileSync(forgedPath, JSON.stringify(manifest), 'utf8');
    const result = await runGateVNext({
      manifestPath: forgedPath,
      factsPath: '',
      outputDir: path.join(dir, 'out'),
      projectRoot: dir,
    });
    expect(result.success).toBe(false);
    expect(result.gate).toBe('FAIL');
    expect(result.steps).toEqual([]);
    expect(result.errors.join(' ')).toMatch(/canonical Stage ID/);
    // Nothing executed, nothing written.
    expect(fs.existsSync(path.join(dir, 'out/gate-result.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.proofloop/receipts/stage-gate/S08B0'))).toBe(false);
  });

  it('refuses a manifest whose declared stage_id is the parked S08B label even when the file name label is canonical', async () => {
    const { dir, manifestPath } = vNextAcceptedFixture();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    manifest.stage_id = 'S08B';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const result = await runGateVNext({
      manifestPath,
      factsPath: '',
      outputDir: path.join(dir, 'out'),
      projectRoot: dir,
    });
    expect(result.success).toBe(false);
    expect(result.gate).toBe('FAIL');
    expect(result.steps).toEqual([]);
    expect(result.errors.join(' ')).toMatch(/canonical Stage ID/);
    expect(fs.existsSync(path.join(dir, 'out/gate-result.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.proofloop/receipts/stage-gate/S08B'))).toBe(false);
  });

  it('built dist run-gate refuses a manifest.json whose declared stage_id is S08B0 before executing steps or writing gate-result', async () => {
    const { dir, manifestPath } = vNextAcceptedFixture();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    manifest.stage_id = 'S08B0';
    const forgedPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(forgedPath, JSON.stringify(manifest), 'utf8');
    const distPath = path.resolve(__dirname, '../../../../packages/runtime/dist/cli/run-gate.js');
    const res = spawnSync(process.execPath, [distPath, forgedPath, '', path.join(dir, 'out'), dir], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout) as { steps: unknown[]; errors: string[] };
    expect(out.steps).toEqual([]);
    expect(out.errors.join(' ')).toMatch(/canonical Stage ID/);
    expect(fs.existsSync(path.join(dir, 'out/gate-result.json'))).toBe(false);
  });
});
