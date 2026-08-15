/**
 * vNext Stage Review admission — downstream consumer tests (S08-E-T06).
 *
 * The fixture drives a complete vNext prefix (Stage Plan + SPV authority,
 * Worker → CV → Slice Commit → Integration → Stage Gate PASS) and then
 * exercises the Stage Review consumer against the integrated boundary.
 * The Review is the terminal downstream consumer: it revalidates the
 * Manifest/Plan/snapshot tuple, the executed Runtime Proof digest, the
 * Stage Gate PASS fact that preceded the review, the SPV ancestry and the
 * current Git boundary, then persists one STAGE_REVIEW_PASS Receipt
 * (verdict ACCEPTED | REPAIR).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  admitVNextCVResult,
  admitVNextIntegration,
  admitVNextStagePlan,
  admitVNextWorkerResult,
  computeVNextSpvPassReceiptDigest,
  computeVNextStagePlanReceiptDigest,
  defaultReceiptWriter,
  resolveVNextReference,
  VNextNextActionService,
} from '@proofloop/runtime';
import type { ReceiptWriterPort, VNextSpvPassReceipt } from '@proofloop/runtime';
import { computeDigest, computeReceiptDigest } from '@proofloop/kernel';
import { admitVNextSliceCommit } from './commit-admission';
import { admitVNextGateResult } from './gate-admission';
import { admitVNextStageReview, readVNextStageReviewStatus, validateVNextStageReviewRequest } from './review-admission';
import { admitRequest } from '../cli/admit';

const repo = path.resolve(__dirname, '../../../..');
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

interface ReviewFixture {
  readonly root: string;
  readonly snapshotDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly workerReceiptDigest: string;
  readonly cvReceiptDigest: string;
  readonly sliceCommitReceiptDigest: string;
  readonly integrationReceiptDigest: string;
  readonly gateReceiptDigest: string;
  readonly commitSha: string;
}

function prepareFixture(options: { gateVerdict?: 'PASS' | 'FAIL' } = {}): ReviewFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-review-admission-')));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-review@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Review Test']);
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
        code_paths: ['delivery/stages/S04/tasks.md'],
        test_paths: ['packages/worker-test.ts'],
        forbidden_paths: ['.proofloop/receipts', '.git'],
      },
    },
  };
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'vNext review planning boundary']);

  const snapshotDigest = git(root, ['rev-parse', 'HEAD']);
  const manifestDigest = computeDigest(manifest);
  const planDigest = manifest.plan.plan_digest as string;
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: 'S04',
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

  const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
  fs.writeFileSync(path.join(root, 'packages/worker-test.ts'), 'export const fixture = true;\n', 'utf8');
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8')
      .replace('- [ ] S04-A-T01', '- [x] S04-A-T01')
      .replace('- Worker Status: `planned`', '- Worker Status: `executing`'),
    'utf8',
  );
  fs.writeFileSync(
    evidencePath,
    fs.readFileSync(evidencePath, 'utf8').replace(
      '## Task Evidence\n\n*Not yet captured.*',
      [
        '## Task Evidence',
        '',
        '### S04-A-T01',
        '',
        '- Task Goal: review fixture',
        '- Relevant PO IDs: PO-FIXTURE',
        '- Source Snapshot: fixture-source',
        '- Current Snapshot: fixture-current',
        '- Changed Files:',
        '  - delivery/stages/S04/evidence/S04-A.md',
        '  - delivery/stages/S04/tasks.md',
        '  - packages/worker-test.ts',
        '- RED Receipt:',
        '  - Test ID: review-red',
        '  - Command: review-red-command',
        '  - Failure Output: review-red-output',
        '  - Expected Failure: review-red-expected',
        '  - Snapshot: review-red-snapshot',
        '- GREEN Receipt:',
        '  - Test ID: review-green',
        '  - Command: review-green-command',
        '  - Pass Output: review-green-output',
        '  - Snapshot: review-green-snapshot',
        '- Status: COMPLETE',
      ].join('\n'),
    ),
    'utf8',
  );

  const proofIndex = (manifest.slices as Array<Record<string, any>>)[0].proof_index as Record<string, any>;
  const worker = admitVNextWorkerResult({
    schemaVersion: 2,
    actionToken: 'review-worker-1',
    stageId: 'S04',
    sliceId: 'S04-A',
    taskId: 'S04-A-T01',
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: 'delivery/stages/S04/evidence/S04-A.md',
    changedFiles: [
      'delivery/stages/S04/evidence/S04-A.md',
      'delivery/stages/S04/tasks.md',
      'packages/worker-test.ts',
    ],
    verificationRuns: [],
    summary: 'review Worker completed',
    manifestDigest: manifestDigest,
    planDigest,
    proofIndexDigest: next.proof_index_digest,
    snapshotDigest,
    contextRef: next.context_ref,
    contextDigest: context.context_digest,
  }, { projectRoot: root });
  if (!worker.accepted) {
    throw new Error('worker not accepted: ' + JSON.stringify(worker.findings));
  }

  const cv = admitVNextCVResult({
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: 'S04',
    slice_id: 'S04-A',
    worker_receipt_digest: worker.receipt_ref,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    proof_index_digest: next.proof_index_digest,
    context_ref: next.context_ref,
    context_digest: context.context_digest,
    snapshot_digest: snapshotDigest,
    verification_type: 'initial',
    verdict: 'PASS',
    summary: 'review CV passed',
    acceptance_refs_checked: [...proofIndex.acceptance_refs],
    seam_refs_checked: [...proofIndex.seam_refs],
    oracle_refs_checked: [...proofIndex.oracle_refs],
    risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'review fixture binding',
    })),
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
  }, { projectRoot: root });
  expect(cv.accepted).toBe(true);

  execFileSync('git', [
    '-C', root,
    'add',
    'delivery/stages/S04/tasks.md',
    'delivery/stages/S04/evidence/S04-A.md',
    'packages/worker-test.ts',
  ]);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'slice-output: S04-S04-A']);
  const commitSha = git(root, ['rev-parse', 'HEAD']);
  const sliceCommit = admitVNextSliceCommit({
    type: 'slice_commit',
    stageId: 'S04',
    sliceId: 'S04-A',
    commitSha,
    cvReceiptDigest: cv.receipt_ref as string,
  }, { projectRoot: root });
  expect(sliceCommit.accepted).toBe(true);

  const integration = admitVNextIntegration({
    type: 'integration',
    stageId: 'S04',
    sliceId: 'S04-A',
    commitSha,
  }, { projectRoot: root });
  expect(integration.accepted).toBe(true);

  // Stage Gate PASS — the review precondition fact on the same tuple/snapshot.
  const gate = admitVNextGateResult({
    type: 'gate_result',
    stageId: 'S04',
    verdict: options.gateVerdict ?? 'PASS',
    manifestDigest,
    snapshotDigest: commitSha,
    summary: 'review fixture gate PASS',
  }, { projectRoot: root });
  if (!gate.accepted) {
    throw new Error('gate not accepted: ' + JSON.stringify(gate.findings));
  }

  return {
    root,
    snapshotDigest,
    manifestDigest,
    planDigest,
    proofIndexDigest: next.proof_index_digest as string,
    contextRef: next.context_ref as string,
    contextDigest: context.context_digest,
    workerReceiptDigest: worker.receipt_ref as string,
    cvReceiptDigest: cv.receipt_ref as string,
    sliceCommitReceiptDigest: sliceCommit.receipt_ref as string,
    integrationReceiptDigest: integration.receipt_ref as string,
    gateReceiptDigest: gate.receipt_ref as string,
    commitSha,
  };
}

function reviewFiles(fixture: ReviewFixture): string[] {
  const directory = path.join(fixture.root, '.proofloop/receipts/review/S04');
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')) : [];
}

function reviewRequest(fixture: ReviewFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'stage_review',
    stageId: 'S04',
    verdict: 'ACCEPTED',
    manifestDigest: fixture.manifestDigest,
    snapshotDigest: fixture.commitSha,
    summary: 'review fixture ACCEPTED',
    ...overrides,
  };
}

function authorityDigests(fixture: ReviewFixture): { stagePlan: string; spv: string } {
  const planDir = path.join(fixture.root, '.proofloop/receipts/plan/S04');
  const stagePlan = JSON.parse(
    fs.readFileSync(path.join(planDir, 'vnext-stage-plan.json'), 'utf8'),
  ) as { digest: string };
  const spv = JSON.parse(
    fs.readFileSync(path.join(planDir, 'vnext-spv-pass.json'), 'utf8'),
  ) as { digest: string };
  return { stagePlan: stagePlan.digest, spv: spv.digest };
}

/**
 * Forge a self-consistent v2 GATE_PASS appended to the stage-gate chain whose
 * payload is a copy of the real Gate payload (so every tuple/snapshot binding
 * is correct) with exactly one closed-schema defect applied by `mutatePayload`.
 */
function forgeGateReceipt(
  fixture: ReviewFixture,
  mutatePayload: (payload: Record<string, unknown>) => void,
): string {
  const gateDir = path.join(fixture.root, '.proofloop/receipts/stage-gate/S04');
  const original = JSON.parse(
    fs.readFileSync(path.join(gateDir, `${fixture.gateReceiptDigest}.json`), 'utf8'),
  ) as Record<string, unknown>;
  const payload = JSON.parse(JSON.stringify(original.payload)) as Record<string, unknown>;
  mutatePayload(payload);
  const forged = {
    version: 1 as const,
    type: 'GATE_PASS' as const,
    stage_id: 'S04',
    timestamp: new Date(Date.now() + 2000).toISOString(),
    previous_digest: fixture.gateReceiptDigest,
    payload,
  } as Record<string, unknown>;
  forged.digest = computeReceiptDigest(forged as never);
  fs.writeFileSync(path.join(gateDir, `${forged.digest}.json`), JSON.stringify(forged), 'utf8');
  return forged.digest as string;
}

/**
 * Forge a self-consistent v2 STAGE_REVIEW_PASS (REPAIR tip, so the tip-verdict
 * rule cannot be the rejector) into the stage review chain whose payload binds
 * the active Manifest/Proof/Authority/Gate tuple with exactly one closed-schema
 * defect applied by `mutatePayload`; chained after `previousDigest` when given
 * (default: chain root).
 */
function forgeReviewReceipt(
  fixture: ReviewFixture,
  mutatePayload: (payload: Record<string, unknown>) => void,
  previousDigest?: string,
): string {
  const authority = authorityDigests(fixture);
  const reviewDir = path.join(fixture.root, '.proofloop/receipts/review/S04');
  fs.mkdirSync(reviewDir, { recursive: true });
  const payload: Record<string, unknown> = {
    schema_version: 2,
    type: 'STAGE_REVIEW_RESULT',
    action: 'STAGE_REVIEW',
    stage_id: 'S04',
    manifest_digest: fixture.manifestDigest,
    plan_digest: fixture.planDigest,
    stage_plan_receipt_digest: authority.stagePlan,
    spv_receipt_digest: authority.spv,
    stage_gate_receipt_digest: fixture.gateReceiptDigest,
    snapshot_digest: fixture.commitSha,
    verdict: 'REPAIR',
    summary: 'forged review round',
    receipt_chain_valid: true,
  };
  mutatePayload(payload);
  const forged = {
    version: 1 as const,
    type: 'STAGE_REVIEW_PASS' as const,
    stage_id: 'S04',
    timestamp: new Date(Date.now() - 5000).toISOString(),
    ...(previousDigest === undefined ? {} : { previous_digest: previousDigest }),
    payload,
  } as Record<string, unknown>;
  forged.digest = computeReceiptDigest(forged as never);
  fs.writeFileSync(path.join(reviewDir, `${forged.digest}.json`), JSON.stringify(forged), 'utf8');
  return forged.digest as string;
}

function injectedWriter(
  mutateAfterWrite: (fixture: ReviewFixture, writtenPath: string) => void,
  fixture: ReviewFixture,
): ReceiptWriterPort {
  return {
    verifyChain: (receiptDir) => defaultReceiptWriter.verifyChain(receiptDir),
    write: (data, options) => {
      const written = defaultReceiptWriter.write(data, options);
      mutateAfterWrite(fixture, written.path);
      return written;
    },
  };
}

describe('vNext Stage Review admission', () => {
  it('admits an ACCEPTED Review after the full integrated prefix through the public consumer', () => {
    const fixture = prepareFixture();
    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.new_state).toBeNull();
    expect(result.vnext_state).toEqual({
      schema_version: 2,
      type: 'STAGE_REVIEW_RESULT',
      action: 'STAGE_REVIEW',
      stage_id: 'S04',
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      stage_plan_receipt_digest: expect.any(String),
      spv_receipt_digest: expect.any(String),
      stage_gate_receipt_digest: fixture.gateReceiptDigest,
      snapshot_digest: fixture.commitSha,
      verdict: 'ACCEPTED',
      summary: 'review fixture ACCEPTED',
      receipt_chain_valid: true,
    });
    expect(reviewFiles(fixture)).toHaveLength(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.root, '.proofloop/receipts/review/S04', `${result.receipt_ref}.json`),
      'utf8',
    )) as Record<string, unknown>;
    expect(receipt.type).toBe('STAGE_REVIEW_PASS');
    expect(receipt.payload).toEqual(result.vnext_state);
  });

  it('admits a REPAIR Review, then admits a later ACCEPTED round, and refuses further review after ACCEPTED', () => {
    const fixture = prepareFixture();
    const first = admitVNextStageReview(
      reviewRequest(fixture, { verdict: 'REPAIR', summary: 'first review repairs' }),
      { projectRoot: fixture.root },
    );
    expect(first.accepted).toBe(true);
    expect(first.vnext_state).toMatchObject({ verdict: 'REPAIR', action: 'STAGE_REVIEW' });
    expect(reviewFiles(fixture)).toHaveLength(1);

    const second = admitVNextStageReview(
      reviewRequest(fixture, { verdict: 'ACCEPTED', summary: 'second review accepts' }),
      { projectRoot: fixture.root },
    );
    expect(second.accepted).toBe(true);
    expect(second.vnext_state).toMatchObject({ verdict: 'ACCEPTED' });
    expect(reviewFiles(fixture)).toHaveLength(2);

    const third = admitVNextStageReview(
      reviewRequest(fixture, { verdict: 'REPAIR', summary: 're-review after ACCEPTED' }),
      { projectRoot: fixture.root },
    );
    expect(third.accepted).toBe(false);
    expect(third.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(2);
  });

  it('rejects a Review when the stage-gate chain is empty (no Gate fact)', () => {
    const fixture = prepareFixture();
    fs.rmSync(path.join(fixture.root, '.proofloop/receipts/stage-gate/S04'), {
      recursive: true,
      force: true,
    });
    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Review when the stage-gate tip is a FAIL verdict', () => {
    const fixture = prepareFixture({ gateVerdict: 'FAIL' });
    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Review when a legacy v1 Gate fact is chained into the stage-gate chain', () => {
    const fixture = prepareFixture();
    const gateDir = path.join(fixture.root, '.proofloop/receipts/stage-gate/S04');
    const forged = {
      version: 1 as const,
      type: 'GATE_PASS' as const,
      stage_id: 'S04',
      timestamp: new Date(Date.now() + 2000).toISOString(),
      previous_digest: fixture.gateReceiptDigest,
      payload: { schema_version: 1, verdict: 'PASS', summary: 'legacy forged gate' },
    } as Record<string, unknown>;
    forged.digest = computeReceiptDigest(forged as never);
    fs.writeFileSync(path.join(gateDir, `${forged.digest}.json`), JSON.stringify(forged), 'utf8');

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Review when a mixed v2 Gate fact without the GATE_RESULT discriminator is chained', () => {
    const fixture = prepareFixture();
    const gateDir = path.join(fixture.root, '.proofloop/receipts/stage-gate/S04');
    const forged = {
      version: 2 as const,
      type: 'GATE_PASS' as const,
      stage_id: 'S04',
      timestamp: new Date(Date.now() + 2000).toISOString(),
      previous_digest: fixture.gateReceiptDigest,
      payload: {
        schema_version: 2,
        type: 'TASK_COMPLETE',
        action: 'GATE',
        verdict: 'PASS',
        manifest_digest: fixture.manifestDigest,
        plan_digest: fixture.planDigest,
        stage_plan_receipt_digest: 'a'.repeat(64),
        spv_receipt_digest: 'b'.repeat(64),
        snapshot_digest: fixture.commitSha,
        summary: 'mixed forged gate',
      },
    } as Record<string, unknown>;
    forged.digest = computeReceiptDigest(forged as never);
    fs.writeFileSync(path.join(gateDir, `${forged.digest}.json`), JSON.stringify(forged), 'utf8');

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it.each([
    ['missing receipt_chain_valid', (payload: Record<string, unknown>) => { delete payload.receipt_chain_valid; }],
    ['missing summary', (payload: Record<string, unknown>) => { delete payload.summary; }],
    ['with an unknown field', (payload: Record<string, unknown>) => { payload.forged_extra_field = 'x'; }],
  ])('rejects a Review when a forged v2 Gate Receipt %s is chained into the stage-gate chain', (_label, mutatePayload) => {
    const fixture = prepareFixture();
    forgeGateReceipt(fixture, mutatePayload);
    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it.each([
    ['missing receipt_chain_valid', (payload: Record<string, unknown>) => { delete payload.receipt_chain_valid; }],
    ['missing summary', (payload: Record<string, unknown>) => { delete payload.summary; }],
    ['with an unknown field', (payload: Record<string, unknown>) => { payload.forged_extra_field = 'x'; }],
  ])('rejects a Review when a forged v2 Stage Review Receipt %s is chained into the stage review chain', (_label, mutatePayload) => {
    const fixture = prepareFixture();
    forgeReviewReceipt(fixture, mutatePayload);
    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(1);
  });

  it('rejects a Review when the Stage Plan snapshot_digest differs from the SPV snapshot_digest', () => {
    const fixture = prepareFixture();
    // Tamper ONLY the Stage Plan authority snapshot, then recompute its digest
    // and rebind the Gate receipt to the new Stage Plan digest: the forged
    // authority prefix stays fully self-consistent except for the missing
    // Stage Plan/SPV snapshot equality.
    const planDir = path.join(fixture.root, '.proofloop/receipts/plan/S04');
    const stagePlanPath = path.join(planDir, 'vnext-stage-plan.json');
    const stagePlan = JSON.parse(fs.readFileSync(stagePlanPath, 'utf8')) as Record<string, unknown>;
    stagePlan.snapshot_digest = 'f'.repeat(40);
    const stagePlanWithoutDigest = { ...stagePlan };
    delete (stagePlanWithoutDigest as { digest?: string }).digest;
    stagePlan.digest = computeVNextStagePlanReceiptDigest(stagePlanWithoutDigest as never);
    fs.writeFileSync(stagePlanPath, JSON.stringify(stagePlan), 'utf8');

    const gateDir = path.join(fixture.root, '.proofloop/receipts/stage-gate/S04');
    const gatePath = path.join(gateDir, `${fixture.gateReceiptDigest}.json`);
    const gate = JSON.parse(fs.readFileSync(gatePath, 'utf8')) as Record<string, unknown>;
    (gate.payload as Record<string, unknown>).stage_plan_receipt_digest = stagePlan.digest;
    const { digest: _oldGateDigest, ...gateContent } = gate;
    void _oldGateDigest;
    gate.digest = computeReceiptDigest(gateContent as never);
    fs.writeFileSync(path.join(gateDir, `${gate.digest}.json`), JSON.stringify(gate), 'utf8');
    fs.rmSync(gatePath);

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Review when the request snapshot is not the current Git HEAD', () => {
    const fixture = prepareFixture();
    const result = admitVNextStageReview(
      reviewRequest(fixture, { snapshotDigest: fixture.snapshotDigest }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Review on a dirty working tree', () => {
    const fixture = prepareFixture();
    fs.writeFileSync(path.join(fixture.root, 'review-dirty.txt'), 'dirty\n', 'utf8');
    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Review when the SPV snapshot is not an ancestor of the integrated snapshot', () => {
    const fixture = prepareFixture();
    // Create an unrelated commit whose tree is the current boundary, then
    // restore the integrated commit as HEAD: the probe commit is not an
    // ancestor of the integrated snapshot.
    execFileSync('git', ['-C', fixture.root, 'commit', '--allow-empty', '-q', '-m', 'unrelated spv snapshot probe']);
    const probeCommit = git(fixture.root, ['rev-parse', 'HEAD']);
    execFileSync('git', ['-C', fixture.root, 'reset', '--hard', '-q', fixture.commitSha]);

    // Rewrite the SPV authority so its snapshot_digest points at the probe
    // commit, while keeping both authority files schema-valid (re-digest the
    // SPV receipt and rebind the Stage Plan spv_receipt_digest).
    const planDir = path.join(fixture.root, '.proofloop/receipts/plan/S04');
    const spvPath = path.join(planDir, 'vnext-spv-pass.json');
    const spv = JSON.parse(fs.readFileSync(spvPath, 'utf8')) as Record<string, unknown>;
    spv.snapshot_digest = probeCommit;
    const spvWithoutDigest = { ...spv };
    delete (spvWithoutDigest as { digest?: string }).digest;
    spv.digest = computeVNextSpvPassReceiptDigest(spvWithoutDigest as never);
    fs.writeFileSync(spvPath, JSON.stringify(spv), 'utf8');

    const stagePlanPath = path.join(planDir, 'vnext-stage-plan.json');
    const stagePlan = JSON.parse(fs.readFileSync(stagePlanPath, 'utf8')) as Record<string, unknown>;
    stagePlan.spv_receipt_digest = spv.digest;
    const stagePlanWithoutDigest = { ...stagePlan };
    delete (stagePlanWithoutDigest as { digest?: string }).digest;
    stagePlan.digest = computeVNextStagePlanReceiptDigest(stagePlanWithoutDigest as never);
    fs.writeFileSync(stagePlanPath, JSON.stringify(stagePlan), 'utf8');

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Review when the request manifestDigest does not match the persisted Manifest', () => {
    const fixture = prepareFixture();
    const result = admitVNextStageReview(
      reviewRequest(fixture, { manifestDigest: 'd'.repeat(64) }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Review with an illegal verdict (not ACCEPTED/REPAIR) at the closed schema', () => {
    const fixture = prepareFixture();
    const result = admitVNextStageReview(
      reviewRequest(fixture, { verdict: 'APPROVED' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Review when a Gate Receipt in the chain is re-bound away from the active tuple', () => {
    const fixture = prepareFixture();
    const directory = path.join(fixture.root, '.proofloop/receipts/stage-gate/S04');
    const filePath = path.join(directory, `${fixture.gateReceiptDigest}.json`);
    const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    receipt.payload = {
      ...(receipt.payload as Record<string, unknown>),
      manifest_digest: 'e'.repeat(64),
    };
    const { digest: _oldDigest, ...content } = receipt;
    void _oldDigest;
    receipt.digest = computeReceiptDigest(content as never);
    fs.writeFileSync(path.join(directory, `${receipt.digest}.json`), JSON.stringify(receipt), 'utf8');
    fs.rmSync(filePath);

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  // ---- dual-path SG: verification_source 可选字段（read seam 登记）----

  it('accepts a Gate Receipt carrying verification_source "git_facts" in the stage-gate chain (dual-path SG)', () => {
    // 兜底路径 GATE receipt（verification_source: git_facts）必须能通过 SR
    // 读缝的 closed 校验（可选字段，枚举值合法）。
    const fixture = prepareFixture();
    const directory = path.join(fixture.root, '.proofloop/receipts/stage-gate/S04');
    const filePath = path.join(directory, `${fixture.gateReceiptDigest}.json`);
    const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    receipt.payload = {
      ...(receipt.payload as Record<string, unknown>),
      verification_source: 'git_facts',
    };
    const { digest: _oldDigest, ...content } = receipt;
    void _oldDigest;
    receipt.digest = computeReceiptDigest(content as never);
    fs.writeFileSync(path.join(directory, `${receipt.digest}.json`), JSON.stringify(receipt), 'utf8');
    fs.rmSync(filePath);

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(true);
    expect(reviewFiles(fixture)).toHaveLength(1);
  });

  it('rejects a Review when a Gate Receipt carries an invalid verification_source value', () => {
    const fixture = prepareFixture();
    const directory = path.join(fixture.root, '.proofloop/receipts/stage-gate/S04');
    const filePath = path.join(directory, `${fixture.gateReceiptDigest}.json`);
    const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    receipt.payload = {
      ...(receipt.payload as Record<string, unknown>),
      verification_source: 'bogus',
    };
    const { digest: _oldDigest, ...content } = receipt;
    void _oldDigest;
    receipt.digest = computeReceiptDigest(content as never);
    fs.writeFileSync(path.join(directory, `${receipt.digest}.json`), JSON.stringify(receipt), 'utf8');
    fs.rmSync(filePath);

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/verification_source/);
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Review when the Gate chain tip changed during the injected write', () => {
    const fixture = prepareFixture();
    const writer = injectedWriter((f, writtenPath) => {
      void writtenPath;
      const gatePath = path.join(
        f.root,
        '.proofloop/receipts/stage-gate/S04',
        `${f.gateReceiptDigest}.json`,
      );
      const receipt = JSON.parse(fs.readFileSync(gatePath, 'utf8')) as Record<string, unknown>;
      receipt.payload = { ...(receipt.payload as Record<string, unknown>), verdict: 'FAIL' };
      fs.writeFileSync(gatePath, JSON.stringify(receipt), 'utf8');
    }, fixture);

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root, writer });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('routes the public CLI admit seam to the vNext Review consumer and refuses v1/unknown routes', () => {
    const fixture = prepareFixture();
    const result = admitRequest(
      reviewRequest(fixture) as unknown as Parameters<typeof admitRequest>[0],
      fixture.root,
    );
    expect(result.accepted).toBe(true);
    expect(result.vnext_state).toMatchObject({
      type: 'STAGE_REVIEW_RESULT',
      action: 'STAGE_REVIEW',
      verdict: 'ACCEPTED',
      snapshot_digest: fixture.commitSha,
    });
    expect(reviewFiles(fixture)).toHaveLength(1);

    const dirty = prepareFixture();
    fs.writeFileSync(
      path.join(dirty.root, '.proofloop/manifests/S04.json'),
      JSON.stringify({ version: 1 }),
      'utf8',
    );
    const refused = admitRequest(
      reviewRequest(dirty) as unknown as Parameters<typeof admitRequest>[0],
      dirty.root,
    );
    expect(refused.accepted).toBe(false);
    expect(refused.receipt_ref).toBeNull();
    expect(reviewFiles(dirty)).toHaveLength(0);
  });
});

describe('S09-C-T03 — Stage Review admission rejects legacy stage labels before any read/write', () => {
  function reviewRequest(stageId: string): Record<string, unknown> {
    return {
      type: 'stage_review',
      stageId,
      verdict: 'ACCEPTED',
      manifestDigest: 'a'.repeat(64),
      snapshotDigest: 'b'.repeat(40),
      summary: 'review summary',
    };
  }

  it('rejects a Stage Review request whose stageId is the parked S08B0 label', () => {
    expect(() => validateVNextStageReviewRequest(reviewRequest('S08B0'))).toThrowError(/canonical Stage ID/);
  });

  it('rejects a Stage Review request whose stageId is the parked S08B label', () => {
    expect(() => validateVNextStageReviewRequest(reviewRequest('S08B'))).toThrowError(/canonical Stage ID/);
  });
});

describe('P-09 — Review accepts a Gate chain with historical receipts on the current HEAD ancestry', () => {
  it('accepts a Review when the Gate chain tip binds the current snapshot and a historical PASS binds an ancestor', () => {
    const fixture = prepareFixture();
    // Advance HEAD with the repair fix (the REPAIR-driven re-run boundary).
    fs.appendFileSync(path.join(fixture.root, 'packages/worker-test.ts'), 'export const repaired = true;\n');
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'repair fix after review REPAIR']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);

    // Append a NEW Gate PASS tip bound to the advanced HEAD; the original
    // PASS (bound to the ancestor commitSha) stays as chain history.
    const forgedTip = forgeGateReceipt(fixture, (payload) => {
      payload.snapshot_digest = head;
    });
    expect(forgedTip).not.toBe(fixture.gateReceiptDigest);

    const result = admitVNextStageReview(
      reviewRequest(fixture, { snapshotDigest: head }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    // The Review binds the chain TIP (the new PASS), not the historical one.
    expect(result.vnext_state).toMatchObject({
      stage_gate_receipt_digest: forgedTip,
      snapshot_digest: head,
      verdict: 'ACCEPTED',
    });
  });

  it('rejects a Review when a historical Gate Receipt snapshot is NOT an ancestor of the current HEAD', () => {
    const fixture = prepareFixture();
    // Rewrite the chain ROOT to bind a non-ancestor snapshot, then append a
    // TIP bound to the current snapshot: the tip rule passes, the historical
    // ancestor rule must refuse the forged boundary.
    const gateDir = path.join(fixture.root, '.proofloop/receipts/stage-gate/S04');
    const rootPath = path.join(gateDir, `${fixture.gateReceiptDigest}.json`);
    const rootReceipt = JSON.parse(fs.readFileSync(rootPath, 'utf8')) as Record<string, unknown>;
    rootReceipt.payload = { ...(rootReceipt.payload as Record<string, unknown>), snapshot_digest: 'f'.repeat(40) };
    const { digest: _rootDigest, ...rootContent } = rootReceipt;
    void _rootDigest;
    rootReceipt.digest = computeReceiptDigest(rootContent as never);
    fs.writeFileSync(path.join(gateDir, `${rootReceipt.digest}.json`), JSON.stringify(rootReceipt), 'utf8');
    fs.rmSync(rootPath);
    const tip = {
      version: 1 as const,
      type: 'GATE_PASS' as const,
      stage_id: 'S04',
      timestamp: new Date(Date.now() + 2000).toISOString(),
      previous_digest: rootReceipt.digest,
      payload: { ...(rootReceipt.payload as Record<string, unknown>), snapshot_digest: fixture.commitSha },
    } as Record<string, unknown>;
    tip.digest = computeReceiptDigest(tip as never);
    fs.writeFileSync(path.join(gateDir, `${tip.digest}.json`), JSON.stringify(tip), 'utf8');

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/not an ancestor|ancestor/i);
    expect(reviewFiles(fixture)).toHaveLength(0);
  });

  it('keeps the strict tip rule: a Gate chain TIP that does not bind the current snapshot is refused', () => {
    const fixture = prepareFixture();
    // Append a forged tip bound to an ANCESTOR snapshot (the planning
    // boundary): even though the snapshot is a valid ancestor, the TIP must
    // bind the current snapshot exactly.
    const forgedTip = forgeGateReceipt(fixture, (payload) => {
      payload.snapshot_digest = fixture.snapshotDigest;
    });
    expect(forgedTip).not.toBe(fixture.gateReceiptDigest);

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/tip does not bind the current integrated snapshot/i);
    expect(reviewFiles(fixture)).toHaveLength(0);
  });
});

describe('P-09 — REPAIR loop: review chain tip/history bindings (re-gate then a second Review round)', () => {
  it('admits a second Review round after REPAIR → re-gate; the old REPAIR receipt stays as unblocking history', () => {
    const fixture = prepareFixture();
    // Round 1: Review REPAIR bound to the FIRST gate tip + integrated snapshot.
    const repair = admitVNextStageReview(
      reviewRequest(fixture, { verdict: 'REPAIR', summary: 'first review requires repair' }),
      { projectRoot: fixture.root },
    );
    expect(repair.accepted).toBe(true);
    expect(repair.vnext_state).toMatchObject({
      stage_gate_receipt_digest: fixture.gateReceiptDigest,
      snapshot_digest: fixture.commitSha,
      verdict: 'REPAIR',
    });
    expect(reviewFiles(fixture)).toHaveLength(1);

    // The repair fix advances HEAD.
    fs.appendFileSync(path.join(fixture.root, 'packages/worker-test.ts'), 'export const repaired = true;\n');
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'repair fix after review REPAIR']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);

    // Re-gate: the explicit re-gate appends a NEW PASS tip at the advanced
    // HEAD while the old PASS stays in the chain as write-once history.
    const regate = admitVNextGateResult({
      type: 'gate_result',
      stageId: 'S04',
      verdict: 'PASS',
      manifestDigest: fixture.manifestDigest,
      snapshotDigest: head,
      summary: 're-gate after review REPAIR',
      re_gate: true,
    }, { projectRoot: fixture.root });
    expect(regate.accepted).toBe(true);
    expect(regate.receipt_ref).not.toBe(fixture.gateReceiptDigest);

    // Round 2: the second Review must pass — the old REPAIR receipt (bound
    // to the OLD gate tip + OLD snapshot) stays in the chain and must not
    // block; the new receipt binds the NEW gate tip + NEW snapshot.
    const second = admitVNextStageReview(
      reviewRequest(fixture, { snapshotDigest: head, summary: 'second review accepts' }),
      { projectRoot: fixture.root },
    );
    expect(second.accepted).toBe(true);
    expect(second.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(second.vnext_state).toMatchObject({
      stage_gate_receipt_digest: regate.receipt_ref,
      snapshot_digest: head,
      verdict: 'ACCEPTED',
    });
    expect(reviewFiles(fixture)).toHaveLength(2);
  });

  it('rejects a Review when a historical Review Receipt binds a Stage Gate digest that is not in the gate chain', () => {
    const fixture = prepareFixture();
    // Chain: [forged historical REPAIR (gate digest never persisted), legit
    // REPAIR tip].  The tip rules pass; the historical fail-closed set
    // membership must refuse the forged gate binding.
    const historical = forgeReviewReceipt(fixture, (payload) => {
      payload.stage_gate_receipt_digest = 'f'.repeat(64);
    });
    forgeReviewReceipt(fixture, () => {}, historical);

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/does not bind a persisted Stage Gate Receipt/);
    expect(reviewFiles(fixture)).toHaveLength(2);
  });

  it('rejects a Review when a historical Review Receipt snapshot is NOT an ancestor of the current HEAD', () => {
    const fixture = prepareFixture();
    // Chain: [historical REPAIR bound to an unrelated snapshot, legit REPAIR
    // tip].  The historical gate binding is legal (it is in the gate chain);
    // only the snapshot ancestry fails closed.
    const historical = forgeReviewReceipt(fixture, (payload) => {
      payload.snapshot_digest = 'f'.repeat(40);
    });
    forgeReviewReceipt(fixture, () => {}, historical);

    const result = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/not an ancestor|ancestor/i);
    expect(reviewFiles(fixture)).toHaveLength(2);
  });

  it('keeps the strict tip rule: an ACCEPTED review tip bound to the OLD gate digest (not the current gate tip) is refused', () => {
    const fixture = prepareFixture();
    // Advance HEAD and append a NEW gate PASS tip; the OLD gate digest stays
    // in the chain, so the relaxed set-membership rule alone would accept it.
    // A forged ACCEPTED review tip bound to the OLD gate digest + the new
    // snapshot must be refused by the strict tip binding alone.
    fs.appendFileSync(path.join(fixture.root, 'packages/worker-test.ts'), 'export const repaired = true;\n');
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'repair fix after review REPAIR']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);
    const newGateTip = forgeGateReceipt(fixture, (payload) => {
      payload.snapshot_digest = head;
    });
    expect(newGateTip).not.toBe(fixture.gateReceiptDigest);
    forgeReviewReceipt(fixture, (payload) => {
      payload.stage_gate_receipt_digest = fixture.gateReceiptDigest;
      payload.snapshot_digest = head;
      payload.verdict = 'ACCEPTED';
    });

    const result = admitVNextStageReview(
      reviewRequest(fixture, { snapshotDigest: head }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/tip does not bind the current Stage Gate tip/i);
    expect(reviewFiles(fixture)).toHaveLength(1);
  });
});

describe('S10-D-T01 — readVNextStageReviewStatus read-only seam', () => {
  it('reports a clean no-review state with the Gate PASS prefix（zero write, ready for review）', () => {
    const fixture = prepareFixture();
    const report = readVNextStageReviewStatus(fixture.root, 'S04');
    expect(report.schema_version).toBe(2);
    expect(report.stage_id).toBe('S04');
    expect(report.manifest_digest).toBe(fixture.manifestDigest);
    expect(report.plan_digest).toBe(fixture.planDigest);
    expect(report.snapshot_digest).toBe(fixture.commitSha);
    expect(report.review.receipt_count).toBe(0);
    expect(report.review.latest).toBeNull();
    expect(report.stage_gate.receipt_count).toBe(1);
    expect(report.stage_gate.latest).toMatchObject({
      receipt_type: 'GATE_PASS',
      verdict: 'PASS',
      digest: fixture.gateReceiptDigest,
    });
    expect(report.ready_for_review).toBe(true);
  });

  it('reports not-ready-for-review when the stage-gate tip is FAIL', () => {
    const fixture = prepareFixture({ gateVerdict: 'FAIL' });
    const report = readVNextStageReviewStatus(fixture.root, 'S04');
    expect(report.stage_gate.latest).toMatchObject({ verdict: 'FAIL' });
    expect(report.review.receipt_count).toBe(0);
    expect(report.ready_for_review).toBe(false);
  });

  it('reports the ACCEPTED review tip and not-ready-for-review after an admitted Review', () => {
    const fixture = prepareFixture();
    const admitted = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(admitted.accepted).toBe(true);
    const report = readVNextStageReviewStatus(fixture.root, 'S04');
    expect(report.review.receipt_count).toBe(1);
    expect(report.review.latest).toMatchObject({
      receipt_type: 'STAGE_REVIEW_PASS',
      verdict: 'ACCEPTED',
      digest: admitted.receipt_ref,
    });
    expect(report.ready_for_review).toBe(false);
  });

  it('fails closed on a misplaced non-review Receipt type in the review chain directory', () => {
    const fixture = prepareFixture();
    const reviewDir = path.join(fixture.root, '.proofloop/receipts/review/S04');
    fs.mkdirSync(reviewDir, { recursive: true });
    const misplaced = {
      version: 1 as const,
      type: 'TASK_COMPLETE' as const,
      stage_id: 'S04',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { task_id: 'S04-A-T01' },
    } as Record<string, unknown>;
    misplaced.digest = computeReceiptDigest(misplaced as never);
    fs.writeFileSync(path.join(reviewDir, `${misplaced.digest}.json`), JSON.stringify(misplaced), 'utf8');

    expect(() => readVNextStageReviewStatus(fixture.root, 'S04')).toThrow(/stage review chain contains/i);
  });

  it('fails closed on a tampered review payload（unknown field）', () => {
    const fixture = prepareFixture();
    const admitted = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(admitted.accepted).toBe(true);
    const reviewDir = path.join(fixture.root, '.proofloop/receipts/review/S04');
    const filePath = path.join(reviewDir, `${admitted.receipt_ref}.json`);
    const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    (receipt.payload as Record<string, unknown>).forged_extra_field = 'x';
    // 保持链拓扑合法（previous_digest 指向原 tip、timestamp 递增），使
    // closed-schema 校验成为唯一失败点。
    const originalTimestamp = String(receipt.timestamp);
    const later = new Date(new Date(originalTimestamp).getTime() + 1000).toISOString();
    const forged = {
      ...receipt,
      previous_digest: receipt.digest,
      timestamp: later,
    } as Record<string, unknown>;
    const { digest: _oldDigest, ...content } = forged;
    void _oldDigest;
    forged.digest = computeReceiptDigest(content as never);
    fs.writeFileSync(path.join(reviewDir, `${forged.digest}.json`), JSON.stringify(forged), 'utf8');

    expect(() => readVNextStageReviewStatus(fixture.root, 'S04')).toThrow(/closed v2 schema/);
  });

  it('fails closed when a review Receipt does not bind a persisted Stage Gate Receipt', () => {
    const fixture = prepareFixture();
    const admitted = admitVNextStageReview(reviewRequest(fixture), { projectRoot: fixture.root });
    expect(admitted.accepted).toBe(true);
    const reviewDir = path.join(fixture.root, '.proofloop/receipts/review/S04');
    const filePath = path.join(reviewDir, `${admitted.receipt_ref}.json`);
    const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    (receipt.payload as Record<string, unknown>).stage_gate_receipt_digest = 'f'.repeat(64);
    const originalTimestamp = String(receipt.timestamp);
    const later = new Date(new Date(originalTimestamp).getTime() + 1000).toISOString();
    const forged = {
      ...receipt,
      previous_digest: receipt.digest,
      timestamp: later,
    } as Record<string, unknown>;
    const { digest: _oldDigest, ...content } = forged;
    void _oldDigest;
    forged.digest = computeReceiptDigest(content as never);
    fs.writeFileSync(path.join(reviewDir, `${forged.digest}.json`), JSON.stringify(forged), 'utf8');

    expect(() => readVNextStageReviewStatus(fixture.root, 'S04')).toThrow(/does not bind a persisted Stage Gate Receipt/);
  });

  it('rejects a non-canonical stage id before any read', () => {
    expect(() => readVNextStageReviewStatus('/tmp', 'S08B0')).toThrow(/canonical Stage ID/);
  });
});
