import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  admitVNextCVResult,
  admitVNextStagePlan,
  admitVNextWorkerResult,
  computeVNextSpvPassReceiptDigest,
  cvReceiptDir,
  defaultReceiptWriter,
  resolveVNextReference,
  runReceiptAdmission,
  tasksReceiptDir,
  VNextNextActionService,
} from '@proofloop/runtime';
import type { ReceiptBuild, ReceiptWriterPort, VNextSpvPassReceipt } from '@proofloop/runtime';
import { computeDigest, writeReceipt } from '@proofloop/kernel';

const repo = path.resolve(__dirname, '../../../..');
const cleanups: string[] = [];

afterEach(() => {
  for (const root of cleanups.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function gitHead(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function copyFixtureFile(root: string, relative: string): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), destination);
}

interface PreparedFixture {
  readonly root: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly snapshotDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly slice: {
    readonly proof_index: {
      readonly acceptance_refs: readonly string[];
      readonly seam_refs: readonly string[];
      readonly oracle_refs: readonly string[];
      readonly risk_refs: readonly { readonly ref_id: string }[];
    };
  };
}

function makeFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-cv-admission-'));
  cleanups.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-cv@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext CV Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');

  copyFixtureFile(root, 'delivery/stages/S04/tasks.md');
  copyFixtureFile(root, '.proofloop/manifests/S04.json');
  copyFixtureFile(root, 'delivery/stages/S04/evidence/S04-A.md');
  copyFixtureFile(root, 'delivery/stages/S0-A/tasks.md');

  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  const tasks = fs.readFileSync(tasksPath, 'utf8').replace(
    '- Worker Status: `NOT_STARTED`',
    '- Worker Status: `planned`',
  );
  fs.writeFileSync(tasksPath, tasks, 'utf8');

  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  manifest.task_scopes = {
    'S04-A-T01': {
      task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['delivery/stages/S04/tasks.md'],
        test_paths: ['packages/worker-test.ts'],
        forbidden_paths: ['.proofloop/receipts'],
      },
    },
  };
  const referenceIndex = manifest.reference_index as Record<string, any>;
  for (const descriptor of Object.values(referenceIndex)) {
    const resolved = resolveVNextReference({
      root,
      ref: descriptor.ref,
      expectedKind: descriptor.kind,
    });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/worker-test.ts'), 'export const fixture = true;\n', 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'vnext cv fixture']);
  return root;
}

function admitPlanAndDispatch(root: string): PreparedFixture {
  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    plan: { plan_digest: string };
    slices: [PreparedFixture['slice']];
  };
  const manifestDigest = computeDigest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  const snapshotDigest = gitHead(root);
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: 'S04',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: snapshotDigest,
  };
  const spv: VNextSpvPassReceipt = {
    ...spvContent,
    digest: computeVNextSpvPassReceiptDigest(spvContent),
  };
  const admitted = admitVNextStagePlan({
    version: 2 as const,
    schema_version: 2 as const,
    type: 'STAGE_PLAN_ADMISSION' as const,
    project_root: root,
    manifest_path: '.proofloop/manifests/S04.json',
    stage_id: 'S04',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: snapshotDigest,
    spv,
  });
  expect(admitted.accepted).toBe(true);

  const next = new VNextNextActionService().nextAction({
    projectRoot: root,
    stageId: 'S04',
    snapshotDigest,
    persistContext: true,
  });
  expect(next.action).toBe('DISPATCH_WORKER');
  const context = JSON.parse(
    fs.readFileSync(path.join(root, next.context_ref as string), 'utf8'),
  ) as { context_digest: string };
  return {
    root,
    manifestDigest,
    planDigest: manifest.plan.plan_digest,
    proofIndexDigest: next.proof_index_digest as string,
    snapshotDigest,
    contextRef: next.context_ref as string,
    contextDigest: context.context_digest,
    slice: manifest.slices[0],
  };
}

function applyWorkerProjection(root: string): void {
  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8')
      .replace('- [ ] S04-A-T01', '- [x] S04-A-T01')
      .replace('- Worker Status: `planned`', '- Worker Status: `executing`'),
    'utf8',
  );
  const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
  const evidence = fs.readFileSync(evidencePath, 'utf8').replace(
    '## Task Evidence\n\n*Not yet captured.*',
    [
      '## Task Evidence',
      '',
      '### S04-A-T01',
      '',
      '- Task Goal: fixture task',
      '- Relevant PO IDs: PO-FIXTURE',
      '- Source Snapshot: fixture-source',
      '- Current Snapshot: fixture-current',
      '- Changed Files:',
      '  - delivery/stages/S04/evidence/S04-A.md',
      '  - delivery/stages/S04/tasks.md',
      '  - packages/worker-test.ts',
      '- RED Receipt:',
      '  - Test ID: fixture-red',
      '  - Command: fixture-red-command',
      '  - Failure Output: fixture-red-output',
      '  - Expected Failure: fixture-red-expected',
      '  - Snapshot: fixture-red-snapshot',
      '- GREEN Receipt:',
      '  - Test ID: fixture-green',
      '  - Command: fixture-green-command',
      '  - Pass Output: fixture-green-output',
      '  - Snapshot: fixture-green-snapshot',
      '- Status: COMPLETE',
    ].join('\n'),
  );
  fs.writeFileSync(evidencePath, `${evidence}\n`, 'utf8');
  fs.appendFileSync(path.join(root, 'packages/worker-test.ts'), 'export const workerChanged = true;\n', 'utf8');
}

function workerEnvelope(fixture: PreparedFixture): Record<string, unknown> {
  return {
    schemaVersion: 2,
    actionToken: 'worker-action-1',
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
    summary: 'worker completed the admitted task',
    manifestDigest: fixture.manifestDigest,
    planDigest: fixture.planDigest,
    proofIndexDigest: fixture.proofIndexDigest,
    snapshotDigest: fixture.snapshotDigest,
    contextRef: fixture.contextRef,
    contextDigest: fixture.contextDigest,
  };
}

function cvEnvelope(
  fixture: PreparedFixture,
  workerReceiptDigest: string,
  verdict: 'PASS' | 'REPAIR' = 'PASS',
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: 'S04',
    slice_id: 'S04-A',
    worker_receipt_digest: workerReceiptDigest,
    manifest_digest: fixture.manifestDigest,
    plan_digest: fixture.planDigest,
    proof_index_digest: fixture.proofIndexDigest,
    context_ref: fixture.contextRef,
    context_digest: fixture.contextDigest,
    snapshot_digest: fixture.snapshotDigest,
    verification_type: 'initial',
    verdict,
    summary: verdict === 'PASS' ? 'all vNext checks passed' : 'bounded repair is required',
    acceptance_refs_checked: [...fixture.slice.proof_index.acceptance_refs],
    seam_refs_checked: [...fixture.slice.proof_index.seam_refs],
    oracle_refs_checked: [...fixture.slice.proof_index.oracle_refs],
    risk_refs_considered: fixture.slice.proof_index.risk_refs.map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'fixture execution binding is in scope',
    })),
    failed_acceptance_refs: verdict === 'PASS' ? [] : [...fixture.slice.proof_index.acceptance_refs],
    invalid_tests: [],
    counterexamples: verdict === 'PASS' ? [] : ['fixture counterexample'],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
  };
  if (verdict === 'REPAIR') {
    result.failed_criterion = 'fixture criterion requires repair';
    result.failure_signature = 'fixture-failure-signature';
    result.required_recheck_scope = ['fixture criterion'];
  }
  return result;
}

function preparedWorker(): {
  readonly fixture: PreparedFixture;
  readonly worker: Record<string, unknown>;
  readonly workerResult: ReturnType<typeof admitVNextWorkerResult>;
} {
  const root = makeFixtureRoot();
  const fixture = admitPlanAndDispatch(root);
  applyWorkerProjection(root);
  const worker = workerEnvelope(fixture);
  const workerResult = admitVNextWorkerResult(worker, { projectRoot: root });
  expect(workerResult.accepted).toBe(true);
  return { fixture, worker, workerResult };
}

describe('vNext CV admission core', () => {
  it('admits PASS through the public consumer and bounded Receipt writer', () => {
    const { fixture, workerResult } = preparedWorker();
    const result = admitVNextCVResult(
      cvEnvelope(fixture, workerResult.receipt_ref as string),
      { projectRoot: fixture.root },
    );

    expect(result.accepted).toBe(true);
    expect(result.new_state).toBeNull();
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.vnext_state).toMatchObject({
      schema_version: 2,
      type: 'CV_RESULT',
      action: 'CV_PASS',
      verdict: 'PASS',
      worker_receipt_digest: workerResult.receipt_ref,
      receipt_chain_valid: true,
    });

    const cvDir = path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A');
    const names = fs.readdirSync(cvDir).filter((name) => name.endsWith('.json'));
    expect(names).toHaveLength(1);
    const receipt = JSON.parse(fs.readFileSync(path.join(cvDir, names[0]), 'utf8')) as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(receipt.type).toBe('CV_PASS');
    expect(receipt.payload).toMatchObject({
      schema_version: 2,
      type: 'CV_RESULT',
      verdict: 'PASS',
      worker_receipt_digest: workerResult.receipt_ref,
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      context_digest: fixture.contextDigest,
    });
  });

  it('admits REPAIR with the same vNext bindings and no legacy state', () => {
    const { fixture, workerResult } = preparedWorker();
    const result = admitVNextCVResult(
      cvEnvelope(fixture, workerResult.receipt_ref as string, 'REPAIR'),
      { projectRoot: fixture.root },
    );

    expect(result.accepted).toBe(true);
    expect(result.new_state).toBeNull();
    expect(result.vnext_state).toMatchObject({ action: 'CV_REPAIR', verdict: 'REPAIR' });
    expect(fs.readdirSync(path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A'))).toHaveLength(1);
  });

  it('rejects incomplete, stale, duplicate, and invalid facts without a CV Receipt', () => {
    const root = makeFixtureRoot();
    const fixture = admitPlanAndDispatch(root);
    const incomplete = cvEnvelope(fixture, 'a'.repeat(64));
    const missingWorker = admitVNextCVResult(incomplete, { projectRoot: root });
    expect(missingWorker.accepted).toBe(false);
    expect(missingWorker.receipt_ref).toBeNull();

    applyWorkerProjection(root);
    const worker = admitVNextWorkerResult(workerEnvelope(fixture), { projectRoot: root });
    expect(worker.accepted).toBe(true);
    const stale = cvEnvelope(fixture, worker.receipt_ref as string);
    stale.manifest_digest = 'f'.repeat(64);
    const staleResult = admitVNextCVResult(stale, { projectRoot: root });
    expect(staleResult.accepted).toBe(false);
    expect(staleResult.receipt_ref).toBeNull();

    const valid = cvEnvelope(fixture, worker.receipt_ref as string);
    const first = admitVNextCVResult(valid, { projectRoot: root });
    const duplicate = admitVNextCVResult(valid, { projectRoot: root });
    expect(first.accepted).toBe(true);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.receipt_ref).toBeNull();
    expect(fs.readdirSync(path.join(root, '.proofloop/receipts/cv/S04/S04-A'))).toHaveLength(1);
  });

  it('rejects vNext seam type/category mismatches before the writer and without a Receipt', () => {
    const cases: readonly { readonly type: ReceiptBuild['type']; readonly category: 'cv' | 'tasks' }[] = [
      { type: 'GATE_PASS', category: 'cv' },
      { type: 'CV_PASS', category: 'tasks' },
    ];

    for (const testCase of cases) {
      const root = makeFixtureRoot();
      const stageId = 'S04';
      const sliceId = 'S04-A';
      const targetDir = testCase.category === 'cv'
        ? cvReceiptDir(root, stageId, sliceId)
        : tasksReceiptDir(root, stageId, sliceId);
      const build: ReceiptBuild = {
        type: testCase.type,
        stage_id: stageId,
        slice_id: sliceId,
        timestamp: '2026-08-06T00:00:00.000Z',
        payload: { schema_version: 2 },
      };
      const nextState = {
        schema_version: 2,
        type: 'CV_RESULT',
        action: 'CV_PASS',
        stage_id: stageId,
        slice_id: sliceId,
        verdict: 'PASS',
      };
      let writeCalls = 0;
      const writer: ReceiptWriterPort = {
        write: (data, options) => {
          writeCalls += 1;
          return defaultReceiptWriter.write(data, options);
        },
        verifyChain: defaultReceiptWriter.verifyChain,
      };

      const result = runReceiptAdmission({
        build,
        targetDir,
        nextState,
        projectRoot: root,
        writer,
      });

      expect(result.accepted).toBe(false);
      expect(result.receipt_ref).toBeNull();
      expect(writeCalls).toBe(0);
      expect(
        fs.existsSync(targetDir)
          ? fs.readdirSync(targetDir).filter((name) => name.endsWith('.json'))
          : [],
      ).toHaveLength(0);
    }
  });

  for (const verdict of ['PASS', 'REPAIR'] as const) {
    it(`rejects ${verdict} payload binding mismatches before K2 and the writer`, () => {
      const mismatchCases: readonly {
        readonly name: string;
        readonly mutate: (payload: Record<string, unknown>) => void;
      }[] = [
        { name: 'type', mutate: (payload) => { payload.type = 'CV_PASS'; } },
        { name: 'stage_id', mutate: (payload) => { payload.stage_id = 'S99'; } },
        { name: 'slice_id', mutate: (payload) => { payload.slice_id = 'S99-A'; } },
        { name: 'verdict', mutate: (payload) => { payload.verdict = verdict === 'PASS' ? 'REPAIR' : 'PASS'; } },
        { name: 'manifest_digest', mutate: (payload) => { payload.manifest_digest = 'f'.repeat(64); } },
        { name: 'plan_digest', mutate: (payload) => { payload.plan_digest = 'f'.repeat(64); } },
        { name: 'proof_index_digest', mutate: (payload) => { payload.proof_index_digest = 'f'.repeat(64); } },
        { name: 'context_ref', mutate: (payload) => { payload.context_ref = `.proofloop/context/${'f'.repeat(64)}.json`; } },
        { name: 'context_digest', mutate: (payload) => { payload.context_digest = 'f'.repeat(64); } },
        { name: 'snapshot_digest', mutate: (payload) => { payload.snapshot_digest = 'f'.repeat(40); } },
        { name: 'worker_receipt_digest', mutate: (payload) => { payload.worker_receipt_digest = 'f'.repeat(64); } },
        { name: 'action', mutate: (payload) => { payload.action = verdict === 'PASS' ? 'CV_REPAIR' : 'CV_PASS'; } },
      ];

      for (const mismatch of mismatchCases) {
        const root = makeFixtureRoot();
        const fixture = admitPlanAndDispatch(root);
        const workerReceiptDigest = 'e'.repeat(64);
        const payload = cvEnvelope(fixture, workerReceiptDigest, verdict);
        mismatch.mutate(payload);
        const build: ReceiptBuild = {
          type: verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
          stage_id: 'S04',
          slice_id: 'S04-A',
          timestamp: '2026-08-06T00:00:00.000Z',
          payload,
        };
        const nextState = {
          schema_version: 2,
          type: 'CV_RESULT',
          action: verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
          stage_id: 'S04',
          slice_id: 'S04-A',
          verdict,
          verification_type: 'initial',
          manifest_digest: fixture.manifestDigest,
          plan_digest: fixture.planDigest,
          proof_index_digest: fixture.proofIndexDigest,
          snapshot_digest: fixture.snapshotDigest,
          context_ref: fixture.contextRef,
          context_digest: fixture.contextDigest,
          worker_receipt_digest: workerReceiptDigest,
          receipt_chain_valid: true,
        };
        let writeCalls = 0;
        const writer: ReceiptWriterPort = {
          write: (data, options) => {
            writeCalls += 1;
            return defaultReceiptWriter.write(data, options);
          },
          verifyChain: defaultReceiptWriter.verifyChain,
        };

        const result = runReceiptAdmission({
          build,
          targetDir: cvReceiptDir(root, 'S04', 'S04-A'),
          nextState,
          projectRoot: root,
          writer,
        });

        expect(result.accepted, mismatch.name).toBe(false);
        expect(result.receipt_ref, mismatch.name).toBeNull();
        expect(result.findings[0]?.code, mismatch.name).toBe('RUNTIME.SCHEMA_MISMATCH');
        expect(writeCalls, mismatch.name).toBe(0);
        expect(
          fs.existsSync(cvReceiptDir(root, 'S04', 'S04-A'))
            ? fs.readdirSync(cvReceiptDir(root, 'S04', 'S04-A')).filter((name) => name.endsWith('.json'))
            : [],
          mismatch.name,
        ).toHaveLength(0);
      }
    });
  }

  for (const verdict of ['PASS', 'REPAIR'] as const) {
    it(`rejects ${verdict} when a required state/payload binding is absent`, () => {
      const requiredFields = [
        'type',
        'stage_id',
        'slice_id',
        'verdict',
        'verification_type',
        'manifest_digest',
        'plan_digest',
        'proof_index_digest',
        'context_ref',
        'context_digest',
        'snapshot_digest',
        'worker_receipt_digest',
      ] as const;

      for (const field of requiredFields) {
        const root = makeFixtureRoot();
        const fixture = admitPlanAndDispatch(root);
        const workerReceiptDigest = 'e'.repeat(64);
        const payload = cvEnvelope(fixture, workerReceiptDigest, verdict);
        const nextState = {
          schema_version: 2,
          type: 'CV_RESULT',
          action: verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
          stage_id: 'S04',
          slice_id: 'S04-A',
          verdict,
          verification_type: 'initial',
          manifest_digest: fixture.manifestDigest,
          plan_digest: fixture.planDigest,
          proof_index_digest: fixture.proofIndexDigest,
          snapshot_digest: fixture.snapshotDigest,
          context_ref: fixture.contextRef,
          context_digest: fixture.contextDigest,
          worker_receipt_digest: workerReceiptDigest,
          receipt_chain_valid: true,
        } as Record<string, unknown>;
        delete payload[field];
        delete nextState[field];

        const targetDir = cvReceiptDir(root, 'S04', 'S04-A');
        let writeCalls = 0;
        let verifyCalls = 0;
        const writer: ReceiptWriterPort = {
          write: (data, options) => {
            writeCalls += 1;
            return defaultReceiptWriter.write(data, options);
          },
          verifyChain: (receiptDir) => {
            verifyCalls += 1;
            return defaultReceiptWriter.verifyChain(receiptDir);
          },
        };

        const result = runReceiptAdmission({
          build: {
            type: verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
            stage_id: 'S04',
            slice_id: 'S04-A',
            timestamp: '2026-08-06T00:00:00.000Z',
            payload,
          },
          targetDir,
          nextState,
          projectRoot: root,
          writer,
        });

        expect(result.accepted, field).toBe(false);
        expect(result.receipt_ref, field).toBeNull();
        expect(result.findings[0]?.code, field).toBe('RUNTIME.SCHEMA_MISMATCH');
        expect(writeCalls, field).toBe(0);
        expect(verifyCalls, field).toBe(0);
        expect(fs.existsSync(targetDir), field).toBe(false);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Execution snapshot advancement (S08-B downstream gap): after a Slice
  // Commit, HEAD legitimately advanced to a descendant of the admission
  // snapshot. A CV result bound to the admission snapshot itself or to a
  // legal descendant commit must be admitted; an unrelated/reverted snapshot
  // must still fail closed.
  // -------------------------------------------------------------------------

  it('admits a CV result bound to the admission snapshot after HEAD advanced to a legal descendant (Slice Commit boundary)', () => {
    const { fixture, workerResult } = preparedWorker();
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'slice commit boundary']);

    const result = admitVNextCVResult(
      cvEnvelope(fixture, workerResult.receipt_ref as string),
      { projectRoot: fixture.root },
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readdirSync(path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A'))).toHaveLength(1);
  });

  it('admits a CV result bound to a descendant execution commit', () => {
    const root = makeFixtureRoot();
    const fixture = admitPlanAndDispatch(root);
    // Simulate the prior Slice Commit boundary, then the current Worker
    // produces its projection on top of the descendant HEAD.
    execFileSync('git', ['-C', root, 'commit', '-q', '--allow-empty', '-m', 'slice commit boundary']);
    const descendant = gitHead(root);
    applyWorkerProjection(root);

    // Rebind the persisted Context to the descendant execution commit and
    // admit the Worker fact bound to that same descendant snapshot.
    const original = JSON.parse(fs.readFileSync(path.join(root, fixture.contextRef), 'utf8')) as Record<string, unknown>;
    const rebound = { ...original, snapshot_digest: descendant } as Record<string, unknown>;
    delete rebound.context_digest;
    const reboundDigest = computeDigest(rebound);
    const reboundRef = `.proofloop/context/${reboundDigest}.json`;
    fs.writeFileSync(
      path.join(root, reboundRef),
      JSON.stringify({ ...rebound, context_digest: reboundDigest }, null, 2) + '\n',
      'utf8',
    );
    const worker = workerEnvelope(fixture) as Record<string, unknown>;
    worker.snapshotDigest = descendant;
    worker.contextRef = reboundRef;
    worker.contextDigest = reboundDigest;
    const workerResult = admitVNextWorkerResult(
      worker,
      { projectRoot: root },
    );
    expect(workerResult.accepted).toBe(true);

    // CV result bound to the same descendant execution commit.
    const cv = cvEnvelope(fixture, workerResult.receipt_ref as string) as Record<string, unknown>;
    cv.snapshot_digest = descendant;
    cv.context_ref = reboundRef;
    cv.context_digest = reboundDigest;
    const result = admitVNextCVResult(cv, { projectRoot: root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readdirSync(path.join(root, '.proofloop/receipts/cv/S04/S04-A'))).toHaveLength(1);
  });

  it('rejects a CV result whose Proof Index reference sets are not exactly the Manifest Slice binding', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;

    // A foreign acceptance ref is not part of the Manifest Slice Proof Index.
    const foreignAcceptance = cvEnvelope(fixture, workerTip);
    foreignAcceptance.acceptance_refs_checked = [
      ...fixture.slice.proof_index.acceptance_refs,
      'REF-FOREIGN-ACCEPTANCE',
    ];
    const foreignResult = admitVNextCVResult(foreignAcceptance, { projectRoot: fixture.root });
    expect(foreignResult.accepted).toBe(false);
    expect(foreignResult.receipt_ref).toBeNull();
    expect(foreignResult.findings[0]?.message).toMatch(/acceptance_refs_checked/);

    // A foreign risk ref is not part of the Manifest Slice Proof Index risk set.
    const foreignRisk = cvEnvelope(fixture, workerTip);
    foreignRisk.risk_refs_considered = [
      ...fixture.slice.proof_index.risk_refs.map((risk) => ({
        ref_id: risk.ref_id,
        applicability: 'APPLICABLE',
        reason: 'fixture execution binding is in scope',
      })),
      {
        ref_id: 'REF-FOREIGN-RISK',
        applicability: 'APPLICABLE',
        reason: 'not declared by the Manifest Slice',
      },
    ];
    const riskResult = admitVNextCVResult(foreignRisk, { projectRoot: fixture.root });
    expect(riskResult.accepted).toBe(false);
    expect(riskResult.receipt_ref).toBeNull();
    expect(riskResult.findings[0]?.message).toMatch(/risk_refs_considered/);

    // No CV Receipt was persisted by either rejected fact.
    expect(fs.existsSync(path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A'))).toBe(false);
  });

  it('rejects a REPAIR whose failed_acceptance_refs contains an out-of-scope ref', () => {
    const { fixture, workerResult } = preparedWorker();
    const repair = cvEnvelope(fixture, workerResult.receipt_ref as string, 'REPAIR');
    repair.failed_acceptance_refs = ['REF-FOREIGN-ACCEPTANCE'];

    const result = admitVNextCVResult(repair, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/out-of-scope ref/);
    expect(fs.existsSync(path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A'))).toBe(false);
  });

  it('persists only the closed v2 CV payload and no legacy CV state fields', () => {
    const { fixture, workerResult } = preparedWorker();
    const result = admitVNextCVResult(
      cvEnvelope(fixture, workerResult.receipt_ref as string),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(true);

    // The vNext consumer never fabricates legacy reconcile state.
    expect(result.new_state).toBeNull();
    expect(result.vnext_state).toMatchObject({
      schema_version: 2,
      type: 'CV_RESULT',
      receipt_chain_valid: true,
    });

    const cvDir = path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A');
    const names = fs.readdirSync(cvDir).filter((name) => name.endsWith('.json'));
    expect(names).toHaveLength(1);
    const receipt = JSON.parse(fs.readFileSync(path.join(cvDir, names[0]), 'utf8')) as {
      payload: Record<string, unknown>;
    };
    // The persisted payload is the closed v2 CV_RESULT envelope: legacy CV
    // Level/Profile fields and legacy reconcile state fields must be absent.
    for (const legacyField of [
      'cv_level',
      'cv_profile',
      'proof_profile',
      'stage_state',
      'project_state',
      'findings',
      'receipt_chain',
      'outcome',
    ]) {
      expect(receipt.payload, legacyField).not.toHaveProperty(legacyField);
    }
  });

  it('fails closed when the CV result snapshot is unrelated to the admitted snapshot', () => {
    const { fixture, workerResult } = preparedWorker();
    // Create an unrelated orphan boundary (not HEAD afterwards) as the
    // claimed CV snapshot; a foreign snapshot is never an execution fact.
    const originalBranch = execFileSync('git', ['-C', fixture.root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', fixture.root, 'checkout', '-q', '--orphan', 'unrelated']);
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'unrelated boundary']);
    const unrelated = gitHead(fixture.root);
    execFileSync('git', ['-C', fixture.root, 'checkout', '-q', originalBranch]);

    const cv = cvEnvelope(fixture, workerResult.receipt_ref as string) as Record<string, unknown>;
    cv.snapshot_digest = unrelated;
    const result = admitVNextCVResult(cv, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/snapshot/);
    expect(fs.existsSync(path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A'))).toBe(false);
  });
});


// -------------------------------------------------------------------------
// CV_REPAIR → recheck sequence: a Worker repair does not produce a new
// Worker Receipt, so the recheck PASS must bind the SAME Worker Receipt tip
// as the preceding CV_REPAIR. The duplicate-predecessor guard must treat
// this as a legal REPAIR→recheck sequence while still rejecting duplicate
// initial facts and rechecks that do not follow a REPAIR.
// -------------------------------------------------------------------------
describe('vNext CV REPAIR → recheck sequence', () => {
  function recheckEnvelope(
    fixture: PreparedFixture,
    workerTip: string,
  ): Record<string, unknown> {
    const envelope = cvEnvelope(fixture, workerTip, 'PASS');
    envelope.verification_type = 'recheck';
    envelope.previous_failure_signature = 'fixture-failure-signature';
    envelope.repair_diff_digest = 'd'.repeat(64);
    return envelope;
  }

  it('admits a recheck PASS after CV_REPAIR bound to the same Worker Receipt tip', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;

    const repair = admitVNextCVResult(cvEnvelope(fixture, workerTip, 'REPAIR'), {
      projectRoot: fixture.root,
    });
    expect(repair.accepted).toBe(true);

    const recheck = admitVNextCVResult(recheckEnvelope(fixture, workerTip), {
      projectRoot: fixture.root,
    });
    expect(recheck.accepted).toBe(true);
    expect(recheck.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(recheck.vnext_state).toMatchObject({
      action: 'CV_PASS',
      verdict: 'PASS',
      verification_type: 'recheck',
      worker_receipt_digest: workerTip,
      receipt_chain_valid: true,
    });

    const cvDir = path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A');
    const types = fs
      .readdirSync(cvDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const receipt = JSON.parse(fs.readFileSync(path.join(cvDir, name), 'utf8')) as {
          type: string;
        };
        return receipt.type;
      })
      .sort();
    expect(types).toEqual(['CV_PASS', 'CV_REPAIR']);
  });

  it('admits a multi-round repair loop: initial REPAIR → recheck REPAIR → recheck PASS on the same Worker tip', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;

    // Round 1: initial CV_REPAIR binds worker tip T.
    const initialRepair = admitVNextCVResult(cvEnvelope(fixture, workerTip, 'REPAIR'), {
      projectRoot: fixture.root,
    });
    expect(initialRepair.accepted).toBe(true);

    // Round 2: recheck REPAIR on the SAME tip (a Worker repair produces no
    // new Worker Receipt, so the legal REPAIR → recheck successor rebinds the
    // same tip).
    const recheckRepair = cvEnvelope(fixture, workerTip, 'REPAIR') as Record<string, unknown>;
    recheckRepair.verification_type = 'recheck';
    recheckRepair.previous_failure_signature = 'fixture-failure-signature';
    recheckRepair.repair_diff_digest = 'd'.repeat(64);
    const secondRound = admitVNextCVResult(recheckRepair, { projectRoot: fixture.root });
    expect(secondRound.accepted).toBe(true);

    // Round 3: recheck PASS on the same tip — the duplicate-predecessor guard
    // must exempt the whole same-tip REPAIR→recheck tail segment, matching
    // assertVNextCvChainSequence (S08-REVIEW-008: admission and recovery must
    // reach the same verdict).
    const thirdRound = admitVNextCVResult(recheckEnvelope(fixture, workerTip), {
      projectRoot: fixture.root,
    });
    expect(thirdRound.accepted).toBe(true);
    expect(thirdRound.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(thirdRound.vnext_state).toMatchObject({
      action: 'CV_PASS',
      verdict: 'PASS',
      verification_type: 'recheck',
      worker_receipt_digest: workerTip,
      receipt_chain_valid: true,
    });

    const cvDir = path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A');
    const types = fs
      .readdirSync(cvDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const receipt = JSON.parse(fs.readFileSync(path.join(cvDir, name), 'utf8')) as {
          type: string;
        };
        return receipt.type;
      })
      .sort();
    expect(types).toEqual(['CV_PASS', 'CV_REPAIR', 'CV_REPAIR']);
  });

  it('admits four consecutive same-tip rounds (REPAIR ×3 → recheck PASS), not just a fixed two-member tail', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;

    const initialRepair = admitVNextCVResult(cvEnvelope(fixture, workerTip, 'REPAIR'), {
      projectRoot: fixture.root,
    });
    expect(initialRepair.accepted).toBe(true);

    for (let round = 2; round <= 3; round += 1) {
      const recheckRepair = cvEnvelope(fixture, workerTip, 'REPAIR') as Record<string, unknown>;
      recheckRepair.verification_type = 'recheck';
      recheckRepair.previous_failure_signature = 'fixture-failure-signature';
      recheckRepair.repair_diff_digest = 'd'.repeat(64);
      const admitted = admitVNextCVResult(recheckRepair, { projectRoot: fixture.root });
      expect(admitted.accepted, `recheck REPAIR round ${round}`).toBe(true);
    }

    const recheckPass = admitVNextCVResult(recheckEnvelope(fixture, workerTip), {
      projectRoot: fixture.root,
    });
    expect(recheckPass.accepted).toBe(true);
    expect(recheckPass.receipt_ref).toMatch(/^[a-f0-9]{64}$/);

    const cvDir = path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A');
    const types = fs
      .readdirSync(cvDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const receipt = JSON.parse(fs.readFileSync(path.join(cvDir, name), 'utf8')) as {
          type: string;
        };
        return receipt.type;
      })
      .sort();
    expect(types).toEqual(['CV_PASS', 'CV_REPAIR', 'CV_REPAIR', 'CV_REPAIR']);
  });

  it('still rejects a duplicate initial CV fact bound to the same Worker Receipt tip', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;

    const first = admitVNextCVResult(cvEnvelope(fixture, workerTip, 'REPAIR'), {
      projectRoot: fixture.root,
    });
    expect(first.accepted).toBe(true);

    const duplicate = admitVNextCVResult(cvEnvelope(fixture, workerTip, 'REPAIR'), {
      projectRoot: fixture.root,
    });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.receipt_ref).toBeNull();
    expect(duplicate.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(fs.readdirSync(path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A'))).toHaveLength(1);
  });

  it('still rejects a recheck when the preceding CV fact is not a REPAIR', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;

    const pass = admitVNextCVResult(cvEnvelope(fixture, workerTip, 'PASS'), {
      projectRoot: fixture.root,
    });
    expect(pass.accepted).toBe(true);

    const recheck = admitVNextCVResult(recheckEnvelope(fixture, workerTip), {
      projectRoot: fixture.root,
    });
    expect(recheck.accepted).toBe(false);
    expect(recheck.receipt_ref).toBeNull();
    expect(fs.readdirSync(path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A'))).toHaveLength(1);
  });

  it('rejects a recheck whose previous_failure_signature does not match the latest CV_REPAIR fact', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;

    const repair = admitVNextCVResult(cvEnvelope(fixture, workerTip, 'REPAIR'), {
      projectRoot: fixture.root,
    });
    expect(repair.accepted).toBe(true);

    const recheck = recheckEnvelope(fixture, workerTip);
    recheck.previous_failure_signature = 'different-failure-signature';
    const mismatched = admitVNextCVResult(recheck, { projectRoot: fixture.root });

    expect(mismatched.accepted).toBe(false);
    expect(mismatched.receipt_ref).toBeNull();
    expect(mismatched.findings[0]?.message).toMatch(/previous_failure_signature/);
    // Only the REPAIR Receipt remains: the mismatched recheck wrote nothing.
    expect(fs.readdirSync(path.join(fixture.root, '.proofloop/receipts/cv/S04/S04-A'))).toHaveLength(1);
  });

  it('fails closed when the persisted CV chain genesis is a recheck (non-initial genesis)', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;
    const cvDir = cvReceiptDir(fixture.root, 'S04', 'S04-A');

    // Inject a bad-fact genesis: a closed-schema-valid v2 CV_REPAIR whose
    // verification_type is recheck. Every per-fact check passes (closed
    // payload, REPAIR discriminator, tuple, Worker tip, Proof Index refs),
    // but a recheck fact can never be a legal chain head — the next recovery
    // consumer rejects this chain as an illegal genesis.
    const badGenesis = cvEnvelope(fixture, workerTip, 'REPAIR');
    badGenesis.verification_type = 'recheck';
    badGenesis.previous_failure_signature = 'bad-genesis-failure-signature';
    badGenesis.repair_diff_digest = 'd'.repeat(64);
    fs.mkdirSync(cvDir, { recursive: true });
    writeReceipt(
      {
        version: 1,
        type: 'CV_REPAIR',
        stage_id: 'S04',
        slice_id: 'S04-A',
        timestamp: '2026-08-06T00:00:01.000Z',
        payload: badGenesis,
      },
      { receiptDir: cvDir, tempDir: cvDir },
    );

    // A recheck PASS with the matching failure signature: the per-fact
    // transition rules (REPAIR predecessor + matching signature) all pass,
    // but the FULL chain sequence (history + candidate) is illegal — the
    // genesis is not an initial verification.
    const recheck = recheckEnvelope(fixture, workerTip);
    const result = admitVNextCVResult(recheck, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(result.findings[0]?.message).toMatch(/genesis must be an initial/);
    // Nothing new was written: only the injected bad genesis remains.
    expect(fs.readdirSync(cvDir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it('rejects a recheck PASS when the persisted CV_REPAIR history binds an earlier Context instead of the final Worker Context', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;
    const cvDir = cvReceiptDir(fixture.root, 'S04', 'S04-A');

    // 历史 CV_REPAIR 的 schema/tuple/Proof Index/Worker tip 绑定全部合法，
    // 但 context_ref/context_digest 绑定较早的 Context（不是最终 Worker
    // Context digest）。正式 CV admission 与 next 恢复/Commit 读取必须对
    // 同一持久化链给出同一结论：恢复路径按 expectedContextDigest 拒绝，
    // admission 也必须拒绝（S08-REVIEW-009 对称绑定）。
    const badRepair = cvEnvelope(fixture, workerTip, 'REPAIR');
    const earlierContextDigest = 'c'.repeat(64);
    badRepair.context_ref = `.proofloop/context/${earlierContextDigest}.json`;
    badRepair.context_digest = earlierContextDigest;
    fs.mkdirSync(cvDir, { recursive: true });
    writeReceipt(
      {
        version: 1,
        type: 'CV_REPAIR',
        stage_id: 'S04',
        slice_id: 'S04-A',
        timestamp: '2026-08-06T00:00:01.000Z',
        payload: badRepair,
      },
      { receiptDir: cvDir, tempDir: cvDir },
    );

    const recheck = recheckEnvelope(fixture, workerTip);
    const result = admitVNextCVResult(recheck, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/final Worker Context/);
    // 只有注入的历史 REPAIR 存在：匹配的 recheck 没有写入任何 Receipt。
    expect(fs.readdirSync(cvDir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it('admits the matching recheck and keeps RUN_CV when the persisted REPAIR history binds the final Worker Context', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;

    const repair = admitVNextCVResult(cvEnvelope(fixture, workerTip, 'REPAIR'), {
      projectRoot: fixture.root,
    });
    expect(repair.accepted).toBe(true);

    // 合法 REPAIR 历史（绑定最终 Worker Context）→ next 保持 RUN_CV
    // （recheck 待定），与恢复/Commit 读取同强度、同结论。
    const before = new VNextNextActionService().nextAction({
      projectRoot: fixture.root,
      stageId: 'S04',
      snapshotDigest: fixture.snapshotDigest,
    });
    expect(before.action).toBe('RUN_CV');

    const recheck = admitVNextCVResult(recheckEnvelope(fixture, workerTip), {
      projectRoot: fixture.root,
    });
    expect(recheck.accepted).toBe(true);
    expect(recheck.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed when a legacy v1 CV Receipt is mixed into the vNext CV chain', () => {
    const { fixture, workerResult } = preparedWorker();
    const workerTip = workerResult.receipt_ref as string;

    const repair = admitVNextCVResult(cvEnvelope(fixture, workerTip, 'REPAIR'), {
      projectRoot: fixture.root,
    });
    expect(repair.accepted).toBe(true);

    // Inject a schema-valid legacy v1 CV_REPAIR Receipt (legacy payload, no
    // v2 discriminator) chained after the admitted v2 REPAIR fact.
    const cvDir = cvReceiptDir(fixture.root, 'S04', 'S04-A');
    writeReceipt(
      {
        version: 1,
        type: 'CV_REPAIR',
        stage_id: 'S04',
        slice_id: 'S04-A',
        timestamp: '2026-08-06T00:00:01.000Z',
        previous_digest: repair.receipt_ref as string,
        payload: { verdict: 'REPAIR', summary: 'legacy v1 cv fact' },
      },
      { receiptDir: cvDir, tempDir: cvDir },
    );

    const recheck = admitVNextCVResult(recheckEnvelope(fixture, workerTip), {
      projectRoot: fixture.root,
    });

    // The vNext chain reader must fail closed on the mixed v1 fact instead of
    // silently consuming it as a valid CV predecessor.
    expect(recheck.accepted).toBe(false);
    expect(recheck.receipt_ref).toBeNull();
    expect(recheck.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(recheck.findings[0]?.message).toMatch(/closed CV envelope/);
    // Nothing new was written: the v2 REPAIR and the injected legacy fact.
    expect(
      fs.readdirSync(cvDir).filter((name) => name.endsWith('.json')),
    ).toHaveLength(2);
  });
});
