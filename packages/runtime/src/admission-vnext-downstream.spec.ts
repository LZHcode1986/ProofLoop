/**
 * vNext downstream chain — end-to-end public-seam spec (S08-E-T06).
 *
 * Drives the complete Worker → CV → Slice Commit → Integration → Stage Gate →
 * Stage Review chain through the public Runtime admit seams
 * (`admitSliceCommit`, `admitIntegration`, `admitGateResult`,
 * `admitStageReview`), asserting at every hop that the vNext consumer is
 * selected, the state binds the Manifest/Plan/snapshot tuple plus every prior
 * Receipt digest, no legacy state is produced, and the persisted Receipt
 * readback matches the returned state.
 *
 * The fixture also builds a TWO-slice stage (S04-A + S04-B): the Gate must
 * require EVERY Manifest Slice to have a complete CV_PASS + Slice Commit +
 * Integration chain before it accepts, and the Review must bind the Gate
 * Receipt that preceded it.  This multi-slice completeness is not exercised by
 * the single-slice consumer specs.
 *
 * PO: REF-S08-E-ACCEPTANCE / REF-S08-E-SEAM / REF-S08-E-ORACLE /
 * REF-S08-E-RISK (AWI-022) — Worker→CV→Commit→Integration→Gate→Review
 * end-to-end fixture, dirty execution boundary, v1/vNext isolation, Receipt
 * digest/readback.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  admitGateResult,
  admitIntegration,
  admitSliceCommit,
  admitStageReview,
  admitVNextCVResult,
  admitVNextStagePlan,
  admitVNextWorkerResult,
  computeVNextSpvPassReceiptDigest,
  resolveVNextReference,
  VNextNextActionService,
} from '@proofloop/runtime';
import type { VNextSpvPassReceipt, VNextGateAdmissionState } from '@proofloop/runtime';
import { computeDigest } from '@proofloop/kernel';

const repo = path.resolve(__dirname, '../../..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function copyFixture(root: string, relative: string): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), destination);
}

interface SliceChain {
  readonly workerReceiptDigest: string;
  readonly cvReceiptDigest: string;
  readonly sliceCommitReceiptDigest: string;
  readonly integrationReceiptDigest: string;
  readonly commitSha: string;
}

interface DownstreamFixture {
  readonly root: string;
  readonly snapshotDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly slices: Record<string, SliceChain>;
}

const SLICE_A = 'S04-A';
const SLICE_B = 'S04-B';
const STAGE = 'S04';

/**
 * Build a complete vNext execution prefix through the REAL public seams:
 *   slice A:  worker → CV PASS → git commit → admitSliceCommit → admitIntegration
 *   slice B:  (optional) the same chain, dispatched by the next-action seam
 *             after slice A is committed
 * The planning boundary is committed before Stage Plan admission, so the
 * authority snapshot is the clean planning HEAD.
 */
function prepareFixture(options: { readonly sliceB?: boolean } = {}): DownstreamFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-downstream-')));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-downstream@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Downstream Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');

  for (const relative of [
    'delivery/stages/S04/tasks.md',
    '.proofloop/manifests/S04.json',
    'delivery/stages/S04/evidence/S04-A.md',
    'delivery/stages/S0-A/tasks.md',
  ]) copyFixture(root, relative);

  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace(
      '- Worker Status: `NOT_STARTED`',
      '- Worker Status: `planned`',
    ),
    'utf8',
  );

  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  manifest.task_scopes = {
    'S04-A-T01': {
      task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['packages/worker-test.ts'],
        test_paths: ['packages/worker-test.spec.ts'],
        forbidden_paths: ['.proofloop/receipts', '.git'],
      },
    },
  };

  if (options.sliceB === true) {
    // Append a second slice region with resolvable entities so the reference
    // digests below bind S04-B refs exactly like S04-A.
    fs.appendFileSync(
      tasksPath,
      [
        '',
        '## Slice S04-B — downstream fixture slice',
        '<!-- SLICE:S04-B:BEGIN -->',
        '',
        '### Goal',
        '',
        '<!-- proofloop:entity id="S04-B-goal" kind="goal" -->',
        'Second downstream slice used to prove multi-slice Integration/Gate completeness.',
        '',
        '### Authority References',
        '',
        '- `goal_ref`: `REF-S04-B-GOAL`',
        '- `task_refs`: `REF-S04-B-T01`',
        '- `acceptance_refs`: `REF-S04-FOUNDATION-ACCEPTANCE`',
        '- `seam_refs`: `REF-S04-FOUNDATION-SEAM`',
        '- `oracle_refs`: `REF-S04-FOUNDATION-ORACLE`',
        '- `risk_refs`: `REF-S04-FOUNDATION-RISK`',
        '',
        '### Tasks',
        '',
        '<!-- proofloop:entity id="S04-B-T01" kind="task" -->',
        '- [ ] S04-B-T01 — downstream slice B task.',
        '',
        '### Minimal Execution Projection',
        '',
        '- Plan state: `CANDIDATE_ONLY`',
        '- Worker Status: `planned`',
        '- Current CV Status: `NOT_RUN`',
        '',
        '<!-- SLICE:S04-B:END -->',
      ].join('\n'),
      'utf8',
    );
    manifest.reference_index['REF-S04-B-GOAL'] = {
      kind: 'goal',
      ref: 'delivery/stages/S04/tasks.md#/entities/S04-B-goal',
      file_digest: '',
      section_digest: '',
    };
    manifest.reference_index['REF-S04-B-T01'] = {
      kind: 'task',
      ref: 'delivery/stages/S04/tasks.md#/entities/S04-B-T01',
      file_digest: '',
      section_digest: '',
    };
    manifest.slices.push({
      slice_id: SLICE_B,
      proof_index: {
        slice_id: SLICE_B,
        goal_ref: 'REF-S04-B-GOAL',
        task_refs: ['REF-S04-B-T01'],
        acceptance_refs: ['REF-S04-FOUNDATION-ACCEPTANCE'],
        seam_refs: ['REF-S04-FOUNDATION-SEAM'],
        oracle_refs: ['REF-S04-FOUNDATION-ORACLE'],
        risk_refs: [
          {
            ref_id: 'REF-S04-FOUNDATION-RISK',
            applies_to_acceptance_refs: ['REF-S04-FOUNDATION-ACCEPTANCE'],
            applies_to_seam_refs: ['REF-S04-FOUNDATION-SEAM'],
          },
        ],
      },
      required_skills: ['test-driven-development'],
      depends_on: [SLICE_A],
      evidence_path: 'delivery/stages/S04/evidence/S04-B.md',
    });
    manifest.task_scopes['S04-B-T01'] = {
      task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-B-T01',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['packages/worker-test-b.ts'],
        test_paths: ['packages/worker-test-b.spec.ts'],
        forbidden_paths: ['.proofloop/receipts', '.git'],
      },
    };
    // Multi-slice dispatch selects the first dependency-ready slice whose
    // dependencies have committed SLICE_COMMIT facts in THIS stage.  The base
    // fixture S04-A depends on the foundation slice S0-A (no commit chain in
    // this fixture), so S04-A must be re-rooted as the stage's first slice.
    (manifest.slices as Array<Record<string, any>>)[0].depends_on = [];
    // Slice B evidence skeleton: same closed skeleton as S04-A (Plan Binding /
    // Proof Index / Task Evidence placeholder / Current Slice Evidence /
    // Current CV Status) so the worker projection check sees only the Task
    // Evidence section change.
    fs.writeFileSync(
      path.join(root, 'delivery/stages/S04/evidence/S04-B.md'),
      [
        '# Slice S04-B Evidence (vNext)',
        '',
        '## Plan Binding',
        '',
        '- Stage ID: S04',
        '- Slice ID: S04-B',
        '- Plan Ref: delivery/stages/S04/tasks.md',
        '- Plan Digest: eeb40acc210d2b10b6af41ef093de00205af5492c91b9dfb7fdf254d06a0e23b',
        '',
        '## Proof Index',
        '',
        '- Goal Ref ID: REF-S04-B-GOAL',
        '- Task Ref IDs: REF-S04-B-T01',
        '- Acceptance Ref IDs: REF-S04-FOUNDATION-ACCEPTANCE',
        '- Seam Ref IDs: REF-S04-FOUNDATION-SEAM',
        '- Oracle Ref IDs: REF-S04-FOUNDATION-ORACLE',
        '- Risk Ref IDs: REF-S04-FOUNDATION-RISK',
        '',
        '## Authority References',
        '',
        '- Ref IDs: REF-S04-FOUNDATION-GOAL, REF-S04-FOUNDATION-ACCEPTANCE, REF-S04-FOUNDATION-SEAM, REF-S04-FOUNDATION-ORACLE, REF-S04-FOUNDATION-RISK',
        '',
        '## Task Evidence',
        '',
        '*Not yet captured.*',
        '',
        '## Current Slice Evidence',
        '',
        '*Not yet captured.*',
        '',
        '## Current CV Status',
        '',
        '- Status: NOT_RUN',
        '- Latest CV Receipt: *None*',
        '- Open Finding: *None*',
      ].join('\n'),
      'utf8',
    );
    fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
    // Worker code/test files are created at WORKER time (below), so the
    // planning boundary stays clean and the worker changed_files exactly
    // describes the execution worktree diff.
    fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  }

  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/worker-test.ts'), 'export const fixture = true;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'packages/worker-test.spec.ts'), 'export const fixtureSpec = true;\n', 'utf8');
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'vNext downstream planning boundary']);

  const snapshotDigest = git(root, ['rev-parse', 'HEAD']);
  const manifestDigest = computeDigest(manifest);
  const planDigest = manifest.plan.plan_digest as string;
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: STAGE,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
  };
  const spv: VNextSpvPassReceipt = {
    ...spvContent,
    digest: computeVNextSpvPassReceiptDigest(spvContent),
  };
  expect(admitVNextStagePlan({
    version: 2,
    schema_version: 2,
    type: 'STAGE_PLAN_ADMISSION',
    project_root: root,
    manifest_path: '.proofloop/manifests/S04.json',
    stage_id: STAGE,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
    spv,
  }).accepted).toBe(true);

  const evidenceTemplate = (taskId: string, changedFiles: readonly string[]): string => [
    '## Task Evidence',
    '',
    `### ${taskId}`,
    '',
    '- Task Goal: downstream fixture',
    '- Relevant PO IDs: PO-FIXTURE',
    '- Source Snapshot: fixture-source',
    '- Current Snapshot: fixture-current',
    '- Changed Files:',
    ...changedFiles.map((file) => `  - ${file}`),
    '- RED Receipt:',
    '  - Test ID: downstream-red',
    '  - Command: downstream-red-command',
    '  - Failure Output: downstream-red-output',
    '  - Expected Failure: downstream-red-expected',
    '  - Snapshot: downstream-red-snapshot',
    '- GREEN Receipt:',
    '  - Test ID: downstream-green',
    '  - Command: downstream-green-command',
    '  - Pass Output: downstream-green-output',
    '  - Snapshot: downstream-green-snapshot',
    '- Status: COMPLETE',
  ].join('\n');
  const runSliceChain = (sliceId: string, taskId: string, extraChanged: string[]): SliceChain => {
    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: STAGE,
      snapshotDigest,
      persistContext: true,
    });
    if (next.action !== 'DISPATCH_WORKER' || next.slice_id !== sliceId || next.task_id !== taskId) {
      throw new Error(`unexpected next action for ${sliceId}: ${JSON.stringify(next)}`);
    }
    const context = JSON.parse(fs.readFileSync(path.join(root, next.context_ref as string), 'utf8')) as {
      context_digest: string;
    };

    const slice = (manifest.slices as Array<Record<string, any>>).find((s) => s.slice_id === sliceId);
    if (slice === undefined) throw new Error(`slice ${sliceId} missing from fixture manifest`);
    const proofIndex = slice.proof_index as Record<string, any>;
    const evidencePath = path.join(root, 'delivery/stages/S04/evidence', `${sliceId}.md`);

    // Execution worktree changes: modify/create the scope code/test files so
    // the worker changed_files exactly describes the current worktree diff.
    for (const relative of extraChanged) {
      const filePath = path.join(root, relative);
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      fs.writeFileSync(filePath, `${existing}export const workerChanged${sliceId.replace('-', '')} = true;\n`, 'utf8');
    }

    fs.writeFileSync(
      evidencePath,
      fs.readFileSync(evidencePath, 'utf8').replace(
        '## Task Evidence\n\n*Not yet captured.*',
        evidenceTemplate(taskId, [
          `delivery/stages/S04/evidence/${sliceId}.md`,
          'delivery/stages/S04/tasks.md',
          ...extraChanged,
        ]),
      ),
      'utf8',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8')
        .replace(`- [ ] ${taskId}`, `- [x] ${taskId}`)
        .replace('- Worker Status: `planned`', '- Worker Status: `executing`'),
      'utf8',
    );

    const changedFiles = [
      `delivery/stages/S04/evidence/${sliceId}.md`,
      'delivery/stages/S04/tasks.md',
      ...extraChanged,
    ];
    const worker = admitVNextWorkerResult({
      schemaVersion: 2,
      actionToken: `downstream-worker-${sliceId}`,
      stageId: STAGE,
      sliceId,
      taskId,
      mode: 'implement-task',
      outcome: 'completed',
      evidenceRef: `delivery/stages/S04/evidence/${sliceId}.md`,
      changedFiles,
      verificationRuns: [],
      summary: `downstream Worker completed for ${sliceId}`,
      manifestDigest,
      planDigest,
      proofIndexDigest: next.proof_index_digest,
      snapshotDigest,
      contextRef: next.context_ref,
      contextDigest: context.context_digest,
    }, { projectRoot: root });
    if (!worker.accepted) {
      throw new Error(`worker not accepted for ${sliceId}: ${JSON.stringify(worker.findings)}`);
    }

    const cv = admitVNextCVResult({
      schema_version: 2,
      type: 'CV_RESULT',
      stage_id: STAGE,
      slice_id: sliceId,
      worker_receipt_digest: worker.receipt_ref,
      manifest_digest: manifestDigest,
      plan_digest: planDigest,
      proof_index_digest: next.proof_index_digest,
      context_ref: next.context_ref,
      context_digest: context.context_digest,
      snapshot_digest: snapshotDigest,
      verification_type: 'initial',
      verdict: 'PASS',
      summary: `downstream CV passed for ${sliceId}`,
      acceptance_refs_checked: [...proofIndex.acceptance_refs],
      seam_refs_checked: [...proofIndex.seam_refs],
      oracle_refs_checked: [...proofIndex.oracle_refs],
      risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
        ref_id: risk.ref_id,
        applicability: 'APPLICABLE',
        reason: 'downstream fixture binding',
      })),
      failed_acceptance_refs: [],
      invalid_tests: [],
      counterexamples: [],
      scope_violations: [],
      forbidden_substitutions: [],
      regression_failures: [],
    }, { projectRoot: root });
    if (!cv.accepted) {
      throw new Error(`cv not accepted for ${sliceId}: ${JSON.stringify(cv.findings)}`);
    }

    execFileSync('git', ['-C', root, 'add', ...changedFiles]);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', `slice-output: S04-${sliceId}`]);
    const commitSha = git(root, ['rev-parse', 'HEAD']);

    const sliceCommit = admitSliceCommit({
      type: 'slice_commit',
      stageId: STAGE,
      sliceId,
      commitSha,
      cvReceiptDigest: cv.receipt_ref as string,
    }, { projectRoot: root });
    if (!sliceCommit.accepted) {
      throw new Error(`sliceCommit not accepted for ${sliceId}: ${JSON.stringify(sliceCommit.findings)}`);
    }

    const integration = admitIntegration({
      type: 'integration',
      stageId: STAGE,
      sliceId,
      commitSha,
    }, { projectRoot: root });
    if (!integration.accepted) {
      throw new Error(`integration not accepted for ${sliceId}: ${JSON.stringify(integration.findings)}`);
    }

    return {
      workerReceiptDigest: worker.receipt_ref as string,
      cvReceiptDigest: cv.receipt_ref as string,
      sliceCommitReceiptDigest: sliceCommit.receipt_ref as string,
      integrationReceiptDigest: integration.receipt_ref as string,
      commitSha,
    };
  };

  const sliceA = runSliceChain(SLICE_A, 'S04-A-T01', ['packages/worker-test.ts', 'packages/worker-test.spec.ts']);
  const slices: Record<string, SliceChain> = { [SLICE_A]: sliceA };
  if (options.sliceB === true) {
    slices[SLICE_B] = runSliceChain(SLICE_B, 'S04-B-T01', ['packages/worker-test-b.ts', 'packages/worker-test-b.spec.ts']);
  }

  return {
    root,
    snapshotDigest,
    manifestDigest,
    planDigest,
    slices,
  };
}

function gateFiles(fixture: DownstreamFixture): string[] {
  const directory = path.join(fixture.root, '.proofloop/receipts/stage-gate/S04');
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')) : [];
}

function reviewFiles(fixture: DownstreamFixture): string[] {
  const directory = path.join(fixture.root, '.proofloop/receipts/review/S04');
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')) : [];
}

function gateRequest(fixture: DownstreamFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const head = git(fixture.root, ['rev-parse', 'HEAD']);
  return {
    type: 'gate_result',
    stageId: STAGE,
    verdict: 'PASS',
    manifestDigest: fixture.manifestDigest,
    snapshotDigest: head,
    summary: 'downstream gate PASS',
    ...overrides,
  };
}

describe('vNext downstream chain (public seam)', { timeout: 60_000 }, () => {
  it('drives Worker → CV → Slice Commit → Integration → Gate → Review end-to-end with digest readback', () => {
    const fixture = prepareFixture();

    // Gate via the public admit seam — vNext consumer selected, no legacy state.
    const gate = admitGateResult(gateRequest(fixture) as never, { projectRoot: fixture.root });
    expect(gate.accepted).toBe(true);
    expect(gate.new_state).toBeNull();
    expect(gate.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(gate.vnext_state).toMatchObject({
      schema_version: 2,
      type: 'GATE_RESULT',
      action: 'GATE',
      stage_id: STAGE,
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      snapshot_digest: fixture.slices[SLICE_A].commitSha,
      verdict: 'PASS',
    });
    const gateState = gate.vnext_state as unknown as VNextGateAdmissionState | undefined;
    expect(gateState?.integrated_slices).toEqual([
      {
        slice_id: SLICE_A,
        integration_receipt_digest: fixture.slices[SLICE_A].integrationReceiptDigest,
        commit_sha: fixture.slices[SLICE_A].commitSha,
      },
    ]);
    expect(gateFiles(fixture)).toHaveLength(1);
    const gateReceipt = JSON.parse(fs.readFileSync(
      path.join(fixture.root, '.proofloop/receipts/stage-gate/S04', `${gate.receipt_ref}.json`),
      'utf8',
    )) as Record<string, unknown>;
    expect(gateReceipt.type).toBe('GATE_PASS');
    expect(gateReceipt.payload).toEqual(gate.vnext_state);
    // Review via the public admit seam with a HOST-STYLE minimal request: the
    // Runtime assembles manifest digest / HEAD snapshot / Runtime Proof digest
    // from persisted facts and binds the preceding Gate Receipt.
    const review = admitStageReview({
      type: 'stage_review',
      stageId: STAGE,
      verdict: 'ACCEPTED',
      summary: 'downstream review ACCEPTED',
    }, { projectRoot: fixture.root });
    expect(review.accepted).toBe(true);
    expect(review.new_state).toBeNull();
    expect(review.vnext_state).toMatchObject({
      schema_version: 2,
      type: 'STAGE_REVIEW_RESULT',
      action: 'STAGE_REVIEW',
      stage_id: STAGE,
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      stage_gate_receipt_digest: gate.receipt_ref,
      snapshot_digest: fixture.slices[SLICE_A].commitSha,
      verdict: 'ACCEPTED',
      receipt_chain_valid: true,
    });
    expect(reviewFiles(fixture)).toHaveLength(1);
    const reviewReceipt = JSON.parse(fs.readFileSync(
      path.join(fixture.root, '.proofloop/receipts/review/S04', `${review.receipt_ref}.json`),
      'utf8',
    )) as Record<string, unknown>;
    expect(reviewReceipt.type).toBe('STAGE_REVIEW_PASS');
    expect(reviewReceipt.payload).toEqual(review.vnext_state);
  });

  it('requires EVERY Manifest Slice to have a complete Integration Receipt chain before the Gate (dual-path SG: the upstream prefix is proven at Integration)', () => {
    const fixture = prepareFixture({ sliceB: true });
    const head = git(fixture.root, ['rev-parse', 'HEAD']);

    // Both slices complete → Gate PASS with both integrated bindings.
    const pass = admitGateResult(gateRequest(fixture) as never, { projectRoot: fixture.root });
    expect(pass.accepted).toBe(true);
    const passState = pass.vnext_state as unknown as VNextGateAdmissionState | undefined;
    expect(passState?.integrated_slices).toEqual([
      {
        slice_id: SLICE_A,
        integration_receipt_digest: fixture.slices[SLICE_A].integrationReceiptDigest,
        commit_sha: fixture.slices[SLICE_A].commitSha,
      },
      {
        slice_id: SLICE_B,
        integration_receipt_digest: fixture.slices[SLICE_B].integrationReceiptDigest,
        commit_sha: fixture.slices[SLICE_B].commitSha,
      },
    ]);
    expect(gateFiles(fixture)).toHaveLength(1);

    // Slice B's Integration chain removed → Gate refused, no new Receipt.
    const missing = prepareFixture({ sliceB: true });
    void head;
    fs.rmSync(path.join(missing.root, '.proofloop/receipts/integration/S04/S04-B'), {
      recursive: true,
      force: true,
    });
    const refused = admitGateResult(gateRequest(missing) as never, { projectRoot: missing.root });
    expect(refused.accepted).toBe(false);
    expect(refused.receipt_ref).toBeNull();
    expect(gateFiles(missing)).toHaveLength(0);

    // Dual-path SG: the reduced Gate verifies ONLY the Integration Receipt
    // chains — removing Slice B's upstream CV chain no longer refuses the
    // Gate (the Integration admission already proved the full Worker → CV →
    // Slice Commit prefix machine-verified).
    const noCv = prepareFixture({ sliceB: true });
    fs.rmSync(path.join(noCv.root, '.proofloop/receipts/cv/S04/S04-B'), { recursive: true, force: true });
    const cvAccepted = admitGateResult(gateRequest(noCv) as never, { projectRoot: noCv.root });
    expect(cvAccepted.accepted).toBe(true);
    expect(gateFiles(noCv)).toHaveLength(1);
  });

  it('binds the integrated snapshot, Runtime Proof, authority and prior Receipt digests in the Gate state', () => {
    const fixture = prepareFixture({ sliceB: true });
    const gate = admitGateResult(gateRequest(fixture) as never, { projectRoot: fixture.root });
    expect(gate.accepted).toBe(true);

    const planDir = path.join(fixture.root, '.proofloop/receipts/plan/S04');
    const stagePlan = JSON.parse(fs.readFileSync(path.join(planDir, 'vnext-stage-plan.json'), 'utf8')) as { digest: string };
    const spv = JSON.parse(fs.readFileSync(path.join(planDir, 'vnext-spv-pass.json'), 'utf8')) as { digest: string };

    expect(gate.vnext_state).toMatchObject({
      stage_plan_receipt_digest: stagePlan.digest,
      spv_receipt_digest: spv.digest,
      snapshot_digest: fixture.slices[SLICE_B].commitSha,
      receipt_chain_valid: true,
    });

    // Each Integration state binds its own worker / cv / slice-commit digests.
    for (const sliceId of [SLICE_A, SLICE_B]) {
      const integrationPath = path.join(
        fixture.root,
        '.proofloop/receipts/integration/S04',
        sliceId,
        `${fixture.slices[sliceId].integrationReceiptDigest}.json`,
      );
      const receipt = JSON.parse(fs.readFileSync(integrationPath, 'utf8')) as { payload: Record<string, unknown> };
      expect(receipt.payload).toMatchObject({
        schema_version: 2,
        type: 'INTEGRATION_RESULT',
        action: 'INTEGRATION',
        stage_id: STAGE,
        slice_id: sliceId,
        manifest_digest: fixture.manifestDigest,
        plan_digest: fixture.planDigest,
        snapshot_digest: fixture.snapshotDigest,
        commit_sha: fixture.slices[sliceId].commitSha,
        slice_commit_receipt_digest: fixture.slices[sliceId].sliceCommitReceiptDigest,
        worker_receipt_digest: fixture.slices[sliceId].workerReceiptDigest,
        cv_receipt_digest: fixture.slices[sliceId].cvReceiptDigest,
        receipt_chain_valid: true,
      });
    }
  });

  it('rejects duplicate and wrong-boundary downstream facts without a second Receipt', () => {
    const fixture = prepareFixture();

    const first = admitIntegration({
      type: 'integration',
      stageId: STAGE,
      sliceId: SLICE_A,
      commitSha: fixture.slices[SLICE_A].commitSha,
    }, { projectRoot: fixture.root });
    expect(first.accepted).toBe(false); // already integrated by the fixture

    const wrongBoundary = prepareFixture();
    const wrongCommit = admitIntegration({
      type: 'integration',
      stageId: STAGE,
      sliceId: SLICE_A,
      commitSha: wrongBoundary.snapshotDigest, // planning boundary, not the slice commit
    }, { projectRoot: wrongBoundary.root });
    expect(wrongCommit.accepted).toBe(false);

    const gate = admitGateResult(gateRequest(fixture) as never, { projectRoot: fixture.root });
    expect(gate.accepted).toBe(true);
    const duplicate = admitGateResult(gateRequest(fixture) as never, { projectRoot: fixture.root });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.receipt_ref).toBeNull();
    expect(gateFiles(fixture)).toHaveLength(1);

    const wrongSnapshot = admitGateResult(
      gateRequest(fixture, { snapshotDigest: fixture.snapshotDigest }) as never,
      { projectRoot: fixture.root },
    );
    expect(wrongSnapshot.accepted).toBe(false);
    expect(gateFiles(fixture)).toHaveLength(1);
  });

  it('assembles the Stage Review request from persisted facts and refuses illegal sequences', () => {
    const fixture = prepareFixture();
    const gate = admitGateResult(gateRequest(fixture) as never, { projectRoot: fixture.root });
    expect(gate.accepted).toBe(true);

    // REPAIR review is admitted and binds the SAME preceding Gate Receipt.
    const repair = admitStageReview({
      type: 'stage_review',
      stageId: STAGE,
      verdict: 'REPAIR',
      summary: 'downstream review REPAIR',
    }, { projectRoot: fixture.root });
    expect(repair.accepted).toBe(true);
    expect(repair.vnext_state).toMatchObject({
      verdict: 'REPAIR',
      stage_gate_receipt_digest: gate.receipt_ref,
      receipt_chain_valid: true,
    });
    expect(reviewFiles(fixture)).toHaveLength(1);

    // ACCEPTED after REPAIR is admitted; a further review is refused.
    const accepted = admitStageReview({
      type: 'stage_review',
      stageId: STAGE,
      verdict: 'ACCEPTED',
      summary: 'downstream review ACCEPTED',
    }, { projectRoot: fixture.root });
    expect(accepted.accepted).toBe(true);
    expect(reviewFiles(fixture)).toHaveLength(2);
    const third = admitStageReview({
      type: 'stage_review',
      stageId: STAGE,
      verdict: 'ACCEPTED',
      summary: 're-review after ACCEPTED',
    }, { projectRoot: fixture.root });
    expect(third.accepted).toBe(false);
    expect(third.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(2);

    // No Gate fact at all → Review refused.
    const noGate = prepareFixture();
    const refused = admitStageReview({
      type: 'stage_review',
      stageId: STAGE,
      verdict: 'ACCEPTED',
      summary: 'review without gate',
    }, { projectRoot: noGate.root });
    expect(refused.accepted).toBe(false);
    expect(refused.receipt_ref).toBeNull();
    expect(reviewFiles(noGate)).toHaveLength(0);

    // Gate FAIL tip → Review refused.
    const failGate = prepareFixture();
    const failed = admitGateResult(gateRequest(failGate, { verdict: 'FAIL' }) as never, { projectRoot: failGate.root });
    expect(failed.accepted).toBe(true);
    const afterFail = admitStageReview({
      type: 'stage_review',
      stageId: STAGE,
      verdict: 'ACCEPTED',
      summary: 'review after gate FAIL',
    }, { projectRoot: failGate.root });
    expect(afterFail.accepted).toBe(false);
    expect(afterFail.receipt_ref).toBeNull();
    expect(reviewFiles(failGate)).toHaveLength(0);
  });

  it('keeps the public admit seams on a v1 Manifest fully isolated from vNext consumers', () => {
    const fixture = prepareFixture();
    fs.writeFileSync(
      path.join(fixture.root, '.proofloop/manifests/S04.json'),
      JSON.stringify({ version: 1 }),
      'utf8',
    );
    // For a v1 Manifest the legacy consumer IS the canonical route — the
    // isolation contract is that no vNext consumer is selected (vnext_state
    // stays absent) and no vNext Receipt is ever written.
    let reconcileCalls = 0;
    let vnextWriterCalls = 0;
    const deps = {
      projectRoot: fixture.root,
      reconcile: (() => {
        reconcileCalls += 1;
        return {
          stage_id: STAGE,
          slices: [],
          stage_state: 'PLANNING',
          project_state: 'PLANNING',
          receipt_chain: [],
          findings: [],
          receipt_chain_valid: true,
          receipt_categories: [],
        };
      }) as never,
      reduce: (() => {
        reconcileCalls += 1;
        return { stage_state: 'PLANNING' };
      }) as never,
      writer: {
        verifyChain: () => ({ valid: true, receipts: [] }),
        write: () => {
          vnextWriterCalls += 1;
          throw new Error('no vNext Receipt may be written for a v1 Manifest');
        },
      } as never,
    };

    const commit = admitSliceCommit({
      type: 'slice_commit',
      stageId: STAGE,
      sliceId: SLICE_A,
      commitSha: fixture.slices[SLICE_A].commitSha,
      cvReceiptDigest: fixture.slices[SLICE_A].cvReceiptDigest,
    }, deps as never);
    expect(commit.accepted).toBe(false);
    expect(commit.vnext_state).toBeUndefined();

    const integration = admitIntegration({
      type: 'integration',
      stageId: STAGE,
      sliceId: SLICE_A,
      commitSha: fixture.slices[SLICE_A].commitSha,
    }, deps as never);
    expect(integration.accepted).toBe(false);
    expect(integration.vnext_state).toBeUndefined();

    const gate = admitGateResult({
      type: 'gate_result',
      stageId: STAGE,
      verdict: 'PASS',
      manifestDigest: fixture.manifestDigest,
      snapshotDigest: fixture.slices[SLICE_A].commitSha,
      summary: 'v1 gate',
    } as never, deps as never);
    expect(gate.accepted).toBe(false);
    expect(gate.vnext_state).toBeUndefined();

    const review = admitStageReview({
      type: 'stage_review',
      stageId: STAGE,
      verdict: 'ACCEPTED',
      summary: 'v1 review',
    }, deps as never);
    expect(review.accepted).toBe(false);
    expect(review.vnext_state).toBeUndefined();
    // Every request reached the legacy consumer seam (reconcile ran) and
    // NONE of them wrote a vNext Receipt through the bounded writer seam.
    expect(reconcileCalls).toBeGreaterThan(0);
    expect(vnextWriterCalls).toBe(0);
  });
});
