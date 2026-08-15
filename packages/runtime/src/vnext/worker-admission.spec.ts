import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  admitVNextStagePlan,
  computeVNextSpvPassReceiptDigest,
  persistVNextWorkerContext,
  projectVNextWorkerDispatch,
  readVNextAdmissionAuthority,
  readReceiptCategory,
  resolveVNextReference,
  VNextNextActionService,
} from '@proofloop/runtime';
import type { VNextSpvPassReceipt } from '@proofloop/runtime';
import { computeDigest } from '@proofloop/kernel';
import { admitWorkerResult } from '../admission.js';

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

function fixtureRoot(multiTask = false, s08ProjectionShape = false, keepPlanningStatus = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-worker-admission-'));
  cleanups.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-worker@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Worker Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');

  copyFixtureFile(root, 'delivery/stages/S04/tasks.md');
  copyFixtureFile(root, '.proofloop/manifests/S04.json');
  copyFixtureFile(root, 'delivery/stages/S04/evidence/S04-A.md');
  copyFixtureFile(root, 'delivery/stages/S0-A/tasks.md');

  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  const secondTaskProjection = multiTask
    ? '<!-- proofloop:entity id="S04-A-T02" kind="task" -->\n- [ ] S04-A-T02 — second fixture task'
    : '- [ ] S04-A-T02 — non-current fixture task';
  let tasks = fs.readFileSync(tasksPath, 'utf8')
    // The default fixture projects the canonical Worker value because the
    // planning-era NOT_STARTED spelling was only made legal on the HEAD side
    // for the real-shape fixture (keepPlanningStatus=true) below. The
    // protected repository artifact is never touched either way.
    .replace(
      '<!-- SLICE:S04-A:END -->',
      `${secondTaskProjection}\n\n<!-- SLICE:S04-A:END -->`,
    );
  if (!keepPlanningStatus) {
    tasks = tasks.replace('- Worker Status: `NOT_STARTED`', '- Worker Status: `planned`');
  }
  if (s08ProjectionShape) {
    // Mirror delivery/stages/S08/tasks.md: each Slice projection carries a
    // `- checkbox: `[ ]`` row between the heading and the Worker Status row.
    // The Worker flips this execution-only projection when it completes.
    const statusLine = keepPlanningStatus
      ? '- Worker Status: `NOT_STARTED`'
      : '- Worker Status: `planned`';
    tasks = tasks.replace(
      statusLine,
      `- checkbox: \`[ ]\`\n${statusLine}`,
    );
  }
  fs.writeFileSync(tasksPath, tasks, 'utf8');

  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const taskScopes: Record<string, unknown> = {
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
  if (multiTask) {
    taskScopes['S04-A-T02'] = {
      task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T02',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['packages/worker-test-2.ts'],
        test_paths: ['packages/worker-test-2.spec.ts'],
        forbidden_paths: ['.proofloop/receipts'],
      },
    };
  }
  manifest.task_scopes = taskScopes;
  const referenceIndex = manifest.reference_index as Record<string, {
    kind: string;
    ref: string;
    file_digest: string;
    section_digest: string;
  }>;
  if (multiTask) {
    referenceIndex['REF-S04-A-T02'] = {
      kind: 'task',
      ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T02',
      file_digest: '',
      section_digest: '',
    };
    const slices = manifest.slices as Array<{
      slice_id: string;
      proof_index: { task_refs: string[] };
    }>;
    const slice = slices.find((candidate) => candidate.slice_id === 'S04-A');
    if (slice === undefined) throw new Error('fixture Slice S04-A is unavailable');
    slice.proof_index.task_refs.push('REF-S04-A-T02');
  }
  for (const descriptor of Object.values(referenceIndex)) {
    const resolved = resolveVNextReference({
      root,
      ref: descriptor.ref,
      expectedKind: descriptor.kind as never,
    });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/worker-test.ts'), 'export const fixture = true;\n', 'utf8');
  if (multiTask) {
    fs.writeFileSync(path.join(root, 'packages/worker-test-2.ts'), 'export const fixtureTwo = true;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'packages/worker-test-2.spec.ts'), 'export const fixtureTwoTest = true;\n', 'utf8');
  }
  fs.writeFileSync(path.join(root, 'candidate-boundary.txt'), 'final candidate boundary\n', 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'candidate boundary']);
  return root;
}

function admitPlanAndDispatch(root: string): {
  readonly root: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly snapshotDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
} {
  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    plan: { plan_digest: string };
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
  };
}

function workerEnvelope(
  fixture: ReturnType<typeof admitPlanAndDispatch>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    ...overrides,
  };
}

function applyWorkerProjection(root: string, s08ProjectionShape = false, advanceWorkerStatus = true): void {
  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  let tasks = fs.readFileSync(tasksPath, 'utf8')
    .replace('- [ ] S04-A-T01', '- [x] S04-A-T01');
  if (s08ProjectionShape) {
    tasks = tasks.replace('- checkbox: `[ ]`', '- checkbox: `[x]`');
  }
  if (advanceWorkerStatus) {
    // Both the default fixture spelling (`planned`) and the real S08
    // planning baseline (`NOT_STARTED`) advance to the execution vocabulary.
    tasks = tasks
      .replace('- Worker Status: `NOT_STARTED`', '- Worker Status: `executing`')
      .replace('- Worker Status: `planned`', '- Worker Status: `executing`');
  }
  fs.writeFileSync(tasksPath, tasks, 'utf8');
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

function applySecondWorkerProjection(root: string): void {
  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  const tasks = fs.readFileSync(tasksPath, 'utf8').replace(
    '- [ ] S04-A-T02',
    '- [x] S04-A-T02',
  );
  fs.writeFileSync(tasksPath, tasks, 'utf8');

  const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
  const secondTaskEvidence = [
    '',
    '### S04-A-T02',
    '',
    '- Task Goal: second fixture task',
    '- Relevant PO IDs: PO-FIXTURE-2',
    '- Source Snapshot: fixture-source-2',
    '- Current Snapshot: fixture-current-2',
    '- Changed Files:',
    '  - delivery/stages/S04/evidence/S04-A.md',
    '  - delivery/stages/S04/tasks.md',
    '  - packages/worker-test-2.ts',
    '  - packages/worker-test-2.spec.ts',
    '- RED Receipt:',
    '  - Test ID: fixture-red-2',
    '  - Command: fixture-red-command-2',
    '  - Failure Output: fixture-red-output-2',
    '  - Expected Failure: fixture-red-expected-2',
    '  - Snapshot: fixture-red-snapshot-2',
    '- GREEN Receipt:',
    '  - Test ID: fixture-green-2',
    '  - Command: fixture-green-command-2',
    '  - Pass Output: fixture-green-output-2',
    '  - Snapshot: fixture-green-snapshot-2',
    '- Status: COMPLETE',
  ].join('\n');
  const evidence = fs.readFileSync(evidencePath, 'utf8').replace(
    '\n## Current Slice Evidence',
    `${secondTaskEvidence}\n\n## Current Slice Evidence`,
  );
  fs.writeFileSync(evidencePath, evidence, 'utf8');
  fs.appendFileSync(path.join(root, 'packages/worker-test-2.ts'), 'export const workerChangedTwo = true;\n', 'utf8');
  fs.appendFileSync(path.join(root, 'packages/worker-test-2.spec.ts'), 'export const workerChangedTwoTest = true;\n', 'utf8');
}

function taskTwoDispatch(
  root: string,
  fixture: ReturnType<typeof admitPlanAndDispatch>,
): { readonly context_ref: string; readonly context_digest: string } {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, '.proofloop/manifests/S04.json'), 'utf8'),
  );
  const dispatch = projectVNextWorkerDispatch({
    root,
    manifest,
    manifestDigest: fixture.manifestDigest,
    snapshotDigest: fixture.snapshotDigest,
    authority: readVNextAdmissionAuthority(root, 'S04'),
    sliceId: 'S04-A',
    completedTaskIds: ['S04-A-T01'],
  });
  persistVNextWorkerContext(root, dispatch);
  return {
    context_ref: dispatch.context_ref,
    context_digest: dispatch.context.context_digest,
  };
}

function rewriteContext(
  root: string,
  envelope: Record<string, unknown>,
  mutate: (context: Record<string, unknown>) => void,
): void {
  const oldRef = envelope.contextRef as string;
  const oldPath = path.join(root, oldRef);
  const context = JSON.parse(fs.readFileSync(oldPath, 'utf8')) as Record<string, unknown>;
  mutate(context);
  const withoutDigest = { ...context };
  delete withoutDigest.context_digest;
  const contextDigest = computeDigest(withoutDigest);
  context.context_digest = contextDigest;
  const contextRef = `.proofloop/context/${contextDigest}.json`;
  const contextPath = path.join(root, contextRef);
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8');
  if (contextRef !== oldRef) fs.rmSync(oldPath, { force: true });
  envelope.contextRef = contextRef;
  envelope.contextDigest = contextDigest;
}

function addContextArtifact(
  root: string,
  contextRef: string,
  mutate: (context: Record<string, unknown>) => void,
): void {
  const contextPath = path.join(root, contextRef);
  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
  mutate(context);
  const withoutDigest = { ...context };
  delete withoutDigest.context_digest;
  const contextDigest = computeDigest(withoutDigest);
  context.context_digest = contextDigest;
  const duplicateRef = `.proofloop/context/${contextDigest}.json`;
  fs.writeFileSync(path.join(root, duplicateRef), `${JSON.stringify(context, null, 2)}\n`, 'utf8');
}

function preparedWorker(): {
  readonly root: string;
  readonly fixture: ReturnType<typeof admitPlanAndDispatch>;
  readonly envelope: Record<string, unknown>;
} {
  const root = fixtureRoot();
  const fixture = admitPlanAndDispatch(root);
  applyWorkerProjection(root);
  return { root, fixture, envelope: workerEnvelope(fixture) };
}

function taskReceiptCount(root: string): number {
  return readReceiptCategory({
    projectRoot: root,
    category: 'tasks',
    stageId: 'S04',
    sliceId: 'S04-A',
  }).receipts.length;
}

describe('vNext Worker-result admission', () => {
  it('admits an explicit v2 Worker result and reads back a Runtime TASK_COMPLETE receipt', () => {
    const { root, envelope } = preparedWorker();

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    const readback = readReceiptCategory({
      projectRoot: root,
      category: 'tasks',
      stageId: 'S04',
      sliceId: 'S04-A',
    });
    expect(readback.receipts).toHaveLength(1);
    expect(readback.receipts[0]?.receipt.type).toBe('TASK_COMPLETE');
    expect(readback.receipts[0]?.receipt.payload).toMatchObject({
      schema_version: 2,
      action_token: 'worker-action-1',
    });
  });

  it('projects RUN_CV from the admitted Worker fact without reapplying the planning clean gate', () => {
    const { root, fixture, envelope } = preparedWorker();

    const admitted = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );
    expect(admitted.accepted).toBe(true);

    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest: fixture.snapshotDigest,
      persistContext: false,
    });

    expect(next.action).toBe('RUN_CV');
    expect(next.slice_id).toBe('S04-A');
    expect(next.task_id).toBeUndefined();
    expect(next.action_detail).toMatch(/no CV verdict|RUN_CV/i);
    expect(next).not.toHaveProperty('cv_verdict');
  });

  it('fails closed when execution dirty state expands outside the admitted Worker scope', () => {
    const { root, fixture, envelope } = preparedWorker();
    const admitted = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );
    expect(admitted.accepted).toBe(true);
    fs.appendFileSync(path.join(root, 'candidate-boundary.txt'), 'out-of-scope execution edit\n', 'utf8');

    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest: fixture.snapshotDigest,
      persistContext: false,
    });

    expect(next.action).toBe('VALIDATE');
    expect(next.action_detail).toMatch(/outside the admitted Worker scope/);
  });

  it.each([
    ['an ignored Runtime artifact', (root: string) => {
      const runtimePath = path.join(root, '.proofloop/runtime/S04/worker-hidden.json');
      fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
      fs.writeFileSync(runtimePath, '{}\n', 'utf8');
    }],
    ['an ignored runtime.lock change', (root: string) => {
      fs.writeFileSync(path.join(root, '.proofloop/runtime.lock'), '{}\n', 'utf8');
    }],
  ])('fails closed when %s is added after Worker admission', (_label, mutate) => {
    const { root, fixture, envelope } = preparedWorker();
    const admitted = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );
    expect(admitted.accepted).toBe(true);
    mutate(root);

    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest: fixture.snapshotDigest,
      persistContext: false,
    });

    expect(next.action).toBe('VALIDATE');
    expect(next.action_detail).toMatch(/ignored|protected|dirty|scope/i);
  });

  it('fails closed when the next snapshot assertion is stale after Worker admission', () => {
    const { root, envelope } = preparedWorker();
    const admitted = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );
    expect(admitted.accepted).toBe(true);

    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest: '0'.repeat(40),
      persistContext: false,
    });

    expect(next.action).toBe('VALIDATE');
    expect(next.action_detail).toMatch(/snapshot_digest/);
  });

  it.each([
    ['Manifest digest mismatch', (envelope: Record<string, unknown>) => { envelope.manifestDigest = 'f'.repeat(64); }],
    ['Plan digest mismatch', (envelope: Record<string, unknown>) => { envelope.planDigest = 'f'.repeat(64); }],
    ['snapshot mismatch', (envelope: Record<string, unknown>) => { envelope.snapshotDigest = '0'.repeat(40); }],
    ['Context digest mismatch', (envelope: Record<string, unknown>) => { envelope.contextDigest = 'f'.repeat(64); }],
    ['Evidence binding mismatch', (envelope: Record<string, unknown>) => { envelope.evidenceRef = 'delivery/stages/S04/other-evidence.md'; }],
    ['forbidden changed path', (envelope: Record<string, unknown>) => {
      envelope.changedFiles = ['.proofloop/receipts/tasks/S04/S04-A/forbidden.json'];
    }],
  ])('fails closed on %s without writing a Receipt', (_label, mutate) => {
    const { root, envelope } = preparedWorker();
    mutate(envelope);

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects an immutable Plan change even when the changed file is the exact plan projection', () => {
    const { root, envelope } = preparedWorker();
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('S04-A-T01 —', 'S04-A-T01 — immutable mutation —'),
      'utf8',
    );

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it.each([
    ['missing current Task Evidence', (root: string) => {
      fs.rmSync(path.join(root, 'delivery/stages/S04/evidence/S04-A.md'));
    }],
    ['wrong Task Evidence subsection', (root: string) => {
      const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
      fs.writeFileSync(
        evidencePath,
        fs.readFileSync(evidencePath, 'utf8').replace('### S04-A-T01', '### S04-A-T02'),
        'utf8',
      );
    }],
    ['missing RED Receipt', (root: string) => {
      const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
      fs.writeFileSync(
        evidencePath,
        fs.readFileSync(evidencePath, 'utf8').replace('- RED Receipt:', '- Missing RED Receipt:'),
        'utf8',
      );
    }],
    ['missing GREEN Receipt', (root: string) => {
      const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
      fs.writeFileSync(
        evidencePath,
        fs.readFileSync(evidencePath, 'utf8').replace('- GREEN Receipt:', '- Missing GREEN Receipt:'),
        'utf8',
      );
    }],
    ['missing RED Receipt field', (root: string) => {
      const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
      fs.writeFileSync(
        evidencePath,
        fs.readFileSync(evidencePath, 'utf8').replace('- Failure Output: fixture-red-output', '- Missing Failure Output: fixture-red-output'),
        'utf8',
      );
    }],
    ['missing GREEN Receipt field', (root: string) => {
      const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
      fs.writeFileSync(
        evidencePath,
        fs.readFileSync(evidencePath, 'utf8').replace('- Pass Output: fixture-green-output', '- Missing Pass Output: fixture-green-output'),
        'utf8',
      );
    }],
    ['incomplete Task Evidence status', (root: string) => {
      const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
      fs.writeFileSync(
        evidencePath,
        fs.readFileSync(evidencePath, 'utf8').replace('- Status: COMPLETE', '- Status: IN_PROGRESS'),
        'utf8',
      );
    }],
  ])('rejects %s before writing a Receipt', (_label, mutate) => {
    const { root, envelope } = preparedWorker();
    mutate(root);

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects an incomplete or rolled-back current Task checkbox before writing a Receipt', () => {
    const { root, envelope } = preparedWorker();
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [x] S04-A-T01', '- [ ] S04-A-T01'),
      'utf8',
    );

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it.each([
    ['another Task Evidence subsection', (evidence: string) => evidence.replace(
      '\n## Current Slice Evidence',
      '\n### S04-A-T02\n\n- Status: COMPLETE\n\n## Current Slice Evidence',
    )],
    ['Current Slice Evidence', (evidence: string) => evidence.replace(
      '## Current Slice Evidence\n\n*Not yet captured.*',
      '## Current Slice Evidence\n\nunauthorized slice evidence mutation',
    )],
    ['Current CV Status', (evidence: string) => evidence.replace(
      '- Status: NOT_RUN',
      '- Status: PASS',
    )],
  ])('rejects a protected %s mutation before writing a Receipt', (_label, mutate) => {
    const { root, envelope } = preparedWorker();
    const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
    fs.writeFileSync(
      evidencePath,
      mutate(fs.readFileSync(evidencePath, 'utf8')),
      'utf8',
    );

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects a Current CV Status projection change', () => {
    const { root, envelope } = preparedWorker();
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace(
        '- Current CV Status: `NOT_RUN`',
        '- Current CV Status: `PASS`',
      ),
      'utf8',
    );

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects a non-current Task checkbox projection change', () => {
    const { root, envelope } = preparedWorker();
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] S04-A-T02', '- [x] S04-A-T02'),
      'utf8',
    );

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('admits the real S08 worktree shape: planning NOT_STARTED HEAD baseline + Task checkbox + `- checkbox:` projection row + Worker Status change together', () => {
    // keepPlanningStatus=true reproduces the real planning clean boundary:
    // the committed HEAD baseline carries `- Worker Status: `NOT_STARTED``
    // exactly like delivery/stages/S08/tasks.md at the S08 snapshot.
    const root = fixtureRoot(false, true, true);
    const fixture = admitPlanAndDispatch(root);
    applyWorkerProjection(root, true);

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: workerEnvelope(fixture) as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(taskReceiptCount(root)).toBe(1);
  });

  it('rejects a real-shape worktree that keeps the planning NOT_STARTED Worker Status (Worker must advance into the execution vocabulary)', () => {
    const root = fixtureRoot(false, true, true);
    const fixture = admitPlanAndDispatch(root);
    // The Worker flips the Task checkbox and the `- checkbox:` projection row
    // but leaves Worker Status at the planning-era NOT_STARTED spelling.
    applyWorkerProjection(root, true, false);

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: workerEnvelope(fixture) as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toContain('AUTHORITY_GAP');
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects a HEAD baseline carrying an illegal Worker Status spelling (HEAD vocabulary stays closed)', () => {
    const root = fixtureRoot();
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace(
        '- Worker Status: `planned`',
        '- Worker Status: `NOT-STARTED`',
      ),
      'utf8',
    );
    // Make the illegal spelling part of the committed planning baseline so
    // admission must judge it as HEAD-side vocabulary, not worktree output.
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'illegal planning-era Worker Status spelling']);

    const fixture = admitPlanAndDispatch(root);
    applyWorkerProjection(root);

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: workerEnvelope(fixture) as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toContain('AUTHORITY_GAP');
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects a `- checkbox:` projection change mixed with a future Task checkbox change', () => {
    const root = fixtureRoot(true, true);
    const fixture = admitPlanAndDispatch(root);
    applyWorkerProjection(root, true);
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] S04-A-T02', '- [x] S04-A-T02'),
      'utf8',
    );

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: workerEnvelope(fixture) as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects a `- checkbox:` projection rewrite that is not checkbox-equivalent', () => {
    const root = fixtureRoot(false, true);
    const fixture = admitPlanAndDispatch(root);
    applyWorkerProjection(root, true);
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace(
        '- checkbox: `[x]`',
        '- checkbox: `[x]` appended text',
      ),
      'utf8',
    );

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: workerEnvelope(fixture) as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it.each(['unknown', 'NOT_STARTED', 'ready_for_cv'])(
    'returns an authority gap for non-canonical Worker Status %s',
    (status) => {
      const { root, envelope } = preparedWorker();
      const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
      fs.writeFileSync(
        tasksPath,
        fs.readFileSync(tasksPath, 'utf8').replace(
          '- Worker Status: `executing`',
          `- Worker Status: \`${status}\``,
        ),
        'utf8',
      );

      const result = admitWorkerResult(
        { type: 'worker_result', envelope: envelope as never },
        { projectRoot: root },
      );

      expect(result.accepted).toBe(false);
      expect(result.receipt_ref).toBeNull();
      expect(result.findings[0]?.message).toContain('AUTHORITY_GAP');
      expect(taskReceiptCount(root)).toBe(0);
    },
  );

  it.each(['planned', 'blocked', 'ready-for-cv'])(
    'rejects Worker Status %s for implement-task completion',
    (status) => {
      const { root, envelope } = preparedWorker();
      const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
      fs.writeFileSync(
        tasksPath,
        fs.readFileSync(tasksPath, 'utf8').replace(
          '- Worker Status: `executing`',
          `- Worker Status: \`${status}\``,
        ),
        'utf8',
      );

      const result = admitWorkerResult(
        { type: 'worker_result', envelope: envelope as never },
        { projectRoot: root },
      );

      expect(result.accepted).toBe(false);
      expect(result.receipt_ref).toBeNull();
      expect(result.findings[0]?.message).toContain('requires Worker Status executing');
      expect(taskReceiptCount(root)).toBe(0);
    },
  );

  it('rejects a Context scope expansion even when its digest is re-bound', () => {
    const { root, envelope } = preparedWorker();
    rewriteContext(root, envelope, (context) => {
      const scope = context.scope as Record<string, unknown>;
      scope.allowed_paths = [
        ...(scope.allowed_paths as string[]),
        'candidate-boundary.txt',
      ];
    });

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects an undeclared non-ignored Git path', () => {
    const { root, envelope } = preparedWorker();
    fs.appendFileSync(path.join(root, 'candidate-boundary.txt'), 'hidden worker edit\n', 'utf8');

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects an ignored forbidden path even when changedFiles omits it', () => {
    const { root, envelope } = preparedWorker();
    const hiddenManifest = path.join(root, '.proofloop/manifests/S04-hidden.json');
    fs.writeFileSync(hiddenManifest, '{}\n', 'utf8');

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('ignores unrelated legacy and invalid v2 Manifests but still rejects a current-stage hidden Manifest', () => {
    const unrelated = preparedWorker();
    fs.writeFileSync(
      path.join(unrelated.root, '.proofloop/manifests/S2.json'),
      JSON.stringify({ stage_id: 'S2' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(unrelated.root, '.proofloop/manifests/S0-A.json'),
      JSON.stringify({ version: 2, stage_id: 'S0-A' }),
      'utf8',
    );

    const ignored = admitWorkerResult(
      { type: 'worker_result', envelope: unrelated.envelope as never },
      { projectRoot: unrelated.root },
    );

    expect(ignored.accepted).toBe(true);

    const currentStage = preparedWorker();
    fs.writeFileSync(
      path.join(currentStage.root, '.proofloop/manifests/S04-hidden.json'),
      JSON.stringify({ version: 2, stage_id: 'S04' }),
      'utf8',
    );

    const rejected = admitWorkerResult(
      { type: 'worker_result', envelope: currentStage.envelope as never },
      { projectRoot: currentStage.root },
    );

    expect(rejected.accepted).toBe(false);
    expect(rejected.receipt_ref).toBeNull();
    expect(taskReceiptCount(currentStage.root)).toBe(0);
  });

  it('ignores a stale same-task Context bound to an old tuple but rejects a current-bound duplicate Context', () => {
    const stale = preparedWorker();
    addContextArtifact(stale.root, stale.fixture.contextRef, (context) => {
      context.manifest_digest = '0'.repeat(64);
      context.plan_digest = '1'.repeat(64);
      context.snapshot_digest = '0'.repeat(40);
    });

    const staleResult = admitWorkerResult(
      { type: 'worker_result', envelope: stale.envelope as never },
      { projectRoot: stale.root },
    );

    expect(staleResult.accepted).toBe(true);

    const currentDuplicate = preparedWorker();
    addContextArtifact(currentDuplicate.root, currentDuplicate.fixture.contextRef, (context) => {
      context.required_skills = [
        ...(context.required_skills as string[]),
        'duplicate-context',
      ];
    });

    const duplicateResult = admitWorkerResult(
      { type: 'worker_result', envelope: currentDuplicate.envelope as never },
      { projectRoot: currentDuplicate.root },
    );

    expect(duplicateResult.accepted).toBe(false);
    expect(duplicateResult.receipt_ref).toBeNull();
    expect(taskReceiptCount(currentDuplicate.root)).toBe(0);
  });

  it.each([
    ['an unallowlisted Runtime artifact', (root: string) => {
      const hiddenRuntime = path.join(root, '.proofloop/runtime/S04/worker-hidden.json');
      fs.mkdirSync(path.dirname(hiddenRuntime), { recursive: true });
      fs.writeFileSync(hiddenRuntime, '{}\n', 'utf8');
    }],
    ['a malformed canonical Runtime artifact', (root: string) => {
      const malformedRuntime = path.join(root, '.proofloop/runtime/S04/slice-complete-facts.json');
      fs.mkdirSync(path.dirname(malformedRuntime), { recursive: true });
      fs.writeFileSync(malformedRuntime, '{}\n', 'utf8');
    }],
    ['a malformed runtime.lock', (root: string) => {
      fs.writeFileSync(path.join(root, '.proofloop/runtime.lock'), '{}\n', 'utf8');
    }],
  ])('rejects %s even when changedFiles omits it', (_label, mutate) => {
    const { root, envelope } = preparedWorker();
    mutate(root);

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('allows only canonical Runtime artifacts and the active runtime.lock alongside vNext facts', () => {
    const { root, envelope } = preparedWorker();
    const runtimeArtifact = path.join(root, '.proofloop/runtime/S04/gate-result.json');
    fs.mkdirSync(path.dirname(runtimeArtifact), { recursive: true });
    fs.writeFileSync(
      runtimeArtifact,
      JSON.stringify({
        success: true,
        gate: 'PASS',
        stage_id: 'S04',
        steps: [],
        errors: [],
        output_path: '.proofloop/runtime/S04/gate-result.json',
      }),
      'utf8',
    );
    fs.copyFileSync(path.join(repo, '.proofloop/runtime.lock'), path.join(root, '.proofloop/runtime.lock'));

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects an actual changed file outside the admitted code/test scope', () => {
    const { root, envelope } = preparedWorker();
    fs.appendFileSync(path.join(root, 'candidate-boundary.txt'), 'forbidden worker edit\n', 'utf8');
    envelope.changedFiles = [
      ...(envelope.changedFiles as string[]),
      'candidate-boundary.txt',
    ];

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects T02 admission when the Manifest task prefix has no T01 Receipt', () => {
    const root = fixtureRoot(true);
    const fixture = admitPlanAndDispatch(root);
    const context = taskTwoDispatch(root, fixture);
    const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace(
        '- Worker Status: `planned`',
        '- Worker Status: `executing`',
      ),
      'utf8',
    );
    applySecondWorkerProjection(root);
    const envelope = workerEnvelope(fixture, {
      actionToken: 'worker-action-2',
      taskId: 'S04-A-T02',
      contextRef: context.context_ref,
      contextDigest: context.context_digest,
      changedFiles: [
        'delivery/stages/S04/evidence/S04-A.md',
        'delivery/stages/S04/tasks.md',
        'packages/worker-test-2.ts',
        'packages/worker-test-2.spec.ts',
      ],
    });

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/prefix|T01|prior/i);
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('continues from a valid T01 Receipt to admit T02', () => {
    const root = fixtureRoot(true);
    const fixture = admitPlanAndDispatch(root);
    applyWorkerProjection(root);
    const first = admitWorkerResult(
      { type: 'worker_result', envelope: workerEnvelope(fixture) as never },
      { projectRoot: root },
    );
    expect(first.accepted).toBe(true);

    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest: fixture.snapshotDigest,
      persistContext: true,
    });
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.task_id).toBe('S04-A-T02');
    const context = JSON.parse(
      fs.readFileSync(path.join(root, next.context_ref as string), 'utf8'),
    ) as { context_digest: string };

    applySecondWorkerProjection(root);
    const second = admitWorkerResult(
      {
        type: 'worker_result',
        envelope: workerEnvelope(fixture, {
          actionToken: 'worker-action-2',
          taskId: 'S04-A-T02',
          contextRef: next.context_ref,
          contextDigest: context.context_digest,
          changedFiles: [
            'delivery/stages/S04/evidence/S04-A.md',
            'delivery/stages/S04/tasks.md',
            'packages/worker-test.ts',
            'packages/worker-test-2.ts',
            'packages/worker-test-2.spec.ts',
          ],
        }) as never,
      },
      { projectRoot: root },
    );

    expect(second.accepted).toBe(true);
    expect(second.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(taskReceiptCount(root)).toBe(2);
  });

  it('rejects a non-canonical project-root assertion without writing a Receipt', () => {
    const { root, envelope } = preparedWorker();
    const parent = path.dirname(root);
    const alias = path.join(parent, `worker-root-alias-${path.basename(root)}`);
    fs.symlinkSync(root, alias);
    cleanups.push(alias);

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: alias },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('refuses a duplicate v2 action token without a second Receipt', () => {
    const { root, envelope } = preparedWorker();
    const first = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );
    const second = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.receipt_ref).toBeNull();
    expect(taskReceiptCount(root)).toBe(1);
  });

  it('refuses a second TASK_COMPLETE fact for the same task even with a new action token', () => {
    const { root, envelope } = preparedWorker();
    const first = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );
    const secondEnvelope = { ...envelope, actionToken: 'worker-action-2' };
    const second = admitWorkerResult(
      { type: 'worker_result', envelope: secondEnvelope as never },
      { projectRoot: root },
    );

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.receipt_ref).toBeNull();
    expect(second.findings[0]?.message).toMatch(/task|TASK_COMPLETE/i);
    expect(taskReceiptCount(root)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // recover-task discriminator (S08-E-T07): a recover-task result is a
  // consistency recheck of already-produced implementation evidence. It must
  // carry a persisted/admissible mode discriminator, must be bound to a
  // recover-task Context, and must never be admitted under the
  // implement-task narrative nor be consumed as a CV verdict.
  // -------------------------------------------------------------------------

  function recoverDispatch(
    root: string,
    fixture: ReturnType<typeof admitPlanAndDispatch>,
  ): { readonly context_ref: string; readonly context_digest: string; readonly mode: unknown } {
    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest: fixture.snapshotDigest,
      persistContext: true,
    });
    expect(next.action).toBe('DISPATCH_WORKER');
    const context = JSON.parse(
      fs.readFileSync(path.join(root, next.context_ref as string), 'utf8'),
    ) as { context_digest: string };
    return {
      context_ref: next.context_ref as string,
      context_digest: context.context_digest,
      mode: next.mode,
    };
  }

  it('re-dispatches an already-checked task as recover-task and admits its result with the persisted recover discriminator', () => {
    const root = fixtureRoot();
    const fixture = admitPlanAndDispatch(root);
    // The Worker produced implementation evidence and checked the Task before
    // the session was lost; no TASK_COMPLETE Receipt was admitted.
    applyWorkerProjection(root);

    const dispatch = recoverDispatch(root, fixture);
    expect(dispatch.mode).toBe('recover-task');

    const envelope = workerEnvelope(fixture, {
      actionToken: 'worker-recover-1',
      mode: 'recover-task',
      contextRef: dispatch.context_ref,
      contextDigest: dispatch.context_digest,
      summary: 'recover-task consistency recheck of the persisted evidence',
    });
    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    const readback = readReceiptCategory({
      projectRoot: root,
      category: 'tasks',
      stageId: 'S04',
      sliceId: 'S04-A',
    });
    expect(readback.receipts).toHaveLength(1);
    expect(readback.receipts[0]?.receipt.payload).toMatchObject({
      schema_version: 2,
      action_token: 'worker-recover-1',
      mode: 'recover-task',
      task_id: 'S04-A-T01',
      outcome: 'completed',
    });
  });

  it('projects RUN_CV after a recover-task admission without treating it as a CV verdict', () => {
    const root = fixtureRoot();
    const fixture = admitPlanAndDispatch(root);
    applyWorkerProjection(root);
    const dispatch = recoverDispatch(root, fixture);
    const envelope = workerEnvelope(fixture, {
      actionToken: 'worker-recover-2',
      mode: 'recover-task',
      contextRef: dispatch.context_ref,
      contextDigest: dispatch.context_digest,
    });

    const admitted = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );
    expect(admitted.accepted).toBe(true);
    if (admitted.accepted) {
      // vNext admissions carry their bounded state on `vnext_state`; the
      // legacy `new_state` projection stays null.
      expect(admitted.vnext_state).toMatchObject({
        schema_version: 2,
        action: 'TASK_COMPLETE',
        mode: 'recover-task',
        outcome: 'completed',
      });
    }

    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest: fixture.snapshotDigest,
      persistContext: false,
    });
    expect(next.action).toBe('RUN_CV');
    expect(next.slice_id).toBe('S04-A');
    expect(next.task_id).toBeUndefined();
    expect(next).not.toHaveProperty('cv_verdict');
  });

  it('rejects a recover-task envelope bound to an implement-task Context (mode binding)', () => {
    const root = fixtureRoot();
    const fixture = admitPlanAndDispatch(root);
    applyWorkerProjection(root);
    // Keep the implement-task Context that was dispatched before the session
    // loss; a recover-task envelope must not reuse it.
    const envelope = workerEnvelope(fixture, {
      actionToken: 'worker-recover-3',
      mode: 'recover-task',
      summary: 'recover narrative on an implement-task Context',
    });

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/mode|Context/i);
    expect(taskReceiptCount(root)).toBe(0);
  });

  it('rejects an implement-task envelope bound to a recover-task Context (reverse mode binding)', () => {
    const root = fixtureRoot();
    const fixture = admitPlanAndDispatch(root);
    applyWorkerProjection(root);
    // Remove the initial implement-task Context artifact so the ONLY
    // persisted Context on the tuple is the recover dispatch Context: the
    // rejection below must come from the admission mode binding itself, not
    // from a duplicate-Context scan of the earlier implement Context.
    fs.rmSync(path.join(root, fixture.contextRef), { force: true });
    // The recover dispatch persists a recover-task Context; an implement-task
    // narrative must never ride on it — the admission mode binding is a
    // persisted discriminator, not a Worker-chosen label (S08-E-T07 §Recovery).
    const dispatch = recoverDispatch(root, fixture);
    expect(dispatch.mode).toBe('recover-task');
    const envelope = workerEnvelope(fixture, {
      actionToken: 'worker-implement-on-recover-context',
      mode: 'implement-task',
      summary: 'implement narrative on a recover-task Context',
      contextRef: dispatch.context_ref,
      contextDigest: dispatch.context_digest,
    });

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: envelope as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/mode|Context/i);
    expect(taskReceiptCount(root)).toBe(0);
  });

  it.each(['repair', 'finalize-slice'])(
    'keeps non-recheck Worker mode %s inadmissible in the vNext consumer',
    (mode) => {
      const root = fixtureRoot();
      const fixture = admitPlanAndDispatch(root);
      applyWorkerProjection(root);
      const dispatch = recoverDispatch(root, fixture);
      const envelope = workerEnvelope(fixture, {
        actionToken: `worker-${mode}`,
        mode,
        contextRef: dispatch.context_ref,
        contextDigest: dispatch.context_digest,
      });

      const result = admitWorkerResult(
        { type: 'worker_result', envelope: envelope as never },
        { projectRoot: root },
      );

      expect(result.accepted).toBe(false);
      expect(result.receipt_ref).toBeNull();
      expect(taskReceiptCount(root)).toBe(0);
    },
  );

  it('refuses to re-admit the same Task after a recover-task receipt (recovery never re-implements)', () => {
    const root = fixtureRoot();
    const fixture = admitPlanAndDispatch(root);
    applyWorkerProjection(root);
    const dispatch = recoverDispatch(root, fixture);
    const recoverEnvelope = workerEnvelope(fixture, {
      actionToken: 'worker-recover-4',
      mode: 'recover-task',
      contextRef: dispatch.context_ref,
      contextDigest: dispatch.context_digest,
    });
    const recovered = admitWorkerResult(
      { type: 'worker_result', envelope: recoverEnvelope as never },
      { projectRoot: root },
    );
    expect(recovered.accepted).toBe(true);

    const implementEnvelope = workerEnvelope(fixture, {
      actionToken: 'worker-implement-after-recover',
      mode: 'implement-task',
      contextRef: fixture.contextRef,
      contextDigest: fixture.contextDigest,
    });
    const duplicate = admitWorkerResult(
      { type: 'worker_result', envelope: implementEnvelope as never },
      { projectRoot: root },
    );

    expect(duplicate.accepted).toBe(false);
    expect(duplicate.receipt_ref).toBeNull();
    expect(duplicate.findings[0]?.message).toMatch(/task|TASK_COMPLETE/i);
    expect(taskReceiptCount(root)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Execution snapshot advancement (S08-B downstream gap): after a Slice
  // Commit, HEAD legitimately advanced to a descendant of the admission
  // snapshot. A Worker result bound to the admission snapshot itself or to a
  // legal descendant commit must be admitted; an unrelated/reverted snapshot
  // must still fail closed.
  // -------------------------------------------------------------------------

  it('admits a Worker result bound to the admission snapshot after HEAD advanced to a legal descendant (Slice Commit boundary)', () => {
    const root = fixtureRoot();
    const fixture = admitPlanAndDispatch(root);
    // Simulate the prior Slice Commit boundary: HEAD advances to a
    // descendant of the admission snapshot while the worktree stays clean.
    execFileSync('git', ['-C', root, 'commit', '-q', '--allow-empty', '-m', 'slice commit boundary']);
    applyWorkerProjection(root);

    const result = admitWorkerResult(
      { type: 'worker_result', envelope: workerEnvelope(fixture) as never },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
  });

  it('admits a Worker result bound to a descendant execution commit', () => {
    const root = fixtureRoot();
    const fixture = admitPlanAndDispatch(root);
    // Simulate the prior Slice Commit boundary, then the current Worker
    // produces its projection on top of the descendant HEAD.
    execFileSync('git', ['-C', root, 'commit', '-q', '--allow-empty', '-m', 'slice commit boundary']);
    const descendant = gitHead(root);
    applyWorkerProjection(root);

    // Rebind the persisted Context to the descendant execution commit and
    // admit a Worker result bound to that same descendant snapshot.
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

    const result = admitWorkerResult(
      {
        type: 'worker_result',
        envelope: workerEnvelope(fixture, {
          snapshotDigest: descendant,
          contextRef: reboundRef,
          contextDigest: reboundDigest,
        }) as never,
      },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed when the Worker result snapshot is unrelated to the admitted snapshot', () => {
    const root = fixtureRoot();
    const fixture = admitPlanAndDispatch(root);
    // Create an unrelated orphan boundary (not HEAD afterwards) as the
    // claimed Worker snapshot; a foreign snapshot is never an execution fact.
    const originalBranch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', root, 'checkout', '-q', '--orphan', 'unrelated']);
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'unrelated boundary']);
    const unrelated = gitHead(root);
    execFileSync('git', ['-C', root, 'checkout', '-q', originalBranch]);
    applyWorkerProjection(root);

    const result = admitWorkerResult(
      {
        type: 'worker_result',
        envelope: workerEnvelope(fixture, { snapshotDigest: unrelated }) as never,
      },
      { projectRoot: root },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/snapshot/);
    expect(taskReceiptCount(root)).toBe(0);
  });
});
