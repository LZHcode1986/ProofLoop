import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  admitVNextCVResult,
  admitVNextStagePlan,
  admitVNextWorkerResult,
  admitSliceCommit,
  committerReceiptDir,
  computeVNextSpvPassReceiptDigest,
  cvReceiptDir,
  readReceiptCategory,
  resolveVNextReference,
  runReceiptAdmission,
  persistVNextWorkerContext,
  projectVNextWorkerDispatch,
  readVNextAdmissionAuthority,
  VNextNextActionService,
} from '@proofloop/runtime';
import type { VNextSpvPassReceipt } from '@proofloop/runtime';
import { computeDigest, computePlanDigest, computeReceiptDigest } from '@proofloop/kernel';
import { admitVNextSliceCommit, validateVNextSliceCommitRequest } from './commit-admission';

const repo = path.resolve(__dirname, '../../../..');
const roots: string[] = [];

/**
 * Directory-level test scope with 14 code/test files: the Worker fact declares
 * 16 files (Evidence + Plan projection + these 14), mirroring the scale of a
 * real Slice such as S08-E so the REPAIR-extra-file admission path is
 * exercised against a committed superset rather than a trivial 3-file diff.
 */
const DECLARED_WIDE_SCOPE_TEST_FILES = Array.from(
  { length: 14 },
  (_, index) => `packages/worker-file-${String(index + 1).padStart(2, '0')}.ts`,
);

/** REPAIR-only files: modified by the Worker repair, never declared by a Worker fact. */
const REPAIR_EXTRA_FILES = [
  'packages/types.ts',
  'packages/gate-admission.ts',
  'packages/gate-admission.spec.ts',
] as const;

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

function makeFixtureRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-commit-shape-')));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-commit-shape@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Commit Shape Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  execFileSync('git', ['-C', root, 'add', '.gitignore']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'vNext commit shape fixture']);
  return root;
}

function writeLegalV1Manifest(root: string): void {
  const manifestPath = path.join(root, '.proofloop', 'manifests', 'S04.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    stage_id: 'S04',
    source_path: 'delivery/stages/S04/tasks.md',
    source_digest: 'a'.repeat(64),
    stage_goal: 'legacy Slice Commit route fixture',
    outcomes: ['legacy Slice Commit route fixture'],
    slices: [{
      slice_id: 'S04-A',
      goal: 'legacy Slice Commit route fixture',
      observable_outcome: 'legacy Slice Commit route fixture',
      public_seam: '@proofloop/runtime admitSliceCommit',
      dependencies: [],
      proof_obligations: [],
      tasks: ['S04-A-T01'],
      risk_facts: [],
      evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
      cv_minimum_level: 'enhanced',
    }],
    dependencies: [],
    risk_facts: [],
  }), 'utf8');
}

function prepare(options: {
  readonly cvVerdict?: 'PASS' | 'REPAIR';
  /** Directory-level test scope: the Worker fact declares 16 files. */
  readonly wideScope?: boolean;
  /** Commit the REPAIR-only files together with the declared Slice boundary (S08-E shape). */
  readonly includeRepairFilesInCommit?: boolean;
} = {}): {
  readonly root: string;
  readonly snapshotDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly workerReceiptDigest: string;
  readonly cvReceiptDigest: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-commit-admission-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'commit@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Commit Test']);
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
    fs.readFileSync(tasksPath, 'utf8').replace('- Worker Status: `NOT_STARTED`', '- Worker Status: `planned`'),
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
        test_paths: options.wideScope ? ['packages'] : ['packages/worker-test.ts'],
        forbidden_paths: ['.proofloop/receipts'],
      },
    },
  };
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  for (const relative of options.wideScope ? DECLARED_WIDE_SCOPE_TEST_FILES : ['packages/worker-test.ts']) {
    fs.writeFileSync(path.join(root, relative), 'export const fixture = true;\n', 'utf8');
  }
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'vnext commit fixture']);

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
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8')
      .replace('- [ ] S04-A-T01', '- [x] S04-A-T01')
      .replace('- Worker Status: `planned`', '- Worker Status: `executing`'),
    'utf8',
  );
  const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
  fs.writeFileSync(
    evidencePath,
    fs.readFileSync(evidencePath, 'utf8').replace(
      '## Task Evidence\n\n*Not yet captured.*',
      [
        '## Task Evidence',
        '',
        '### S04-A-T01',
        '',
        '- Task Goal: commit fixture',
        '- Relevant PO IDs: PO-FIXTURE',
        '- Source Snapshot: fixture-source',
        '- Current Snapshot: fixture-current',
        '- Changed Files:',
        '  - delivery/stages/S04/evidence/S04-A.md',
        '  - delivery/stages/S04/tasks.md',
        '  - packages/worker-test.ts',
        '- RED Receipt:',
        '  - Test ID: commit-red',
        '  - Command: commit-red-command',
        '  - Failure Output: commit-red-output',
        '  - Expected Failure: commit-red-expected',
        '  - Snapshot: commit-red-snapshot',
        '- GREEN Receipt:',
        '  - Test ID: commit-green',
        '  - Command: commit-green-command',
        '  - Pass Output: commit-green-output',
        '  - Snapshot: commit-green-snapshot',
        '- Status: COMPLETE',
      ].join('\n'),
    ),
    'utf8',
  );
  for (const relative of options.wideScope ? DECLARED_WIDE_SCOPE_TEST_FILES : ['packages/worker-test.ts']) {
    fs.appendFileSync(path.join(root, relative), 'export const workerChanged = true;\n');
  }

  const worker = admitVNextWorkerResult({
    schemaVersion: 2,
    actionToken: 'commit-worker-1',
    stageId: 'S04',
    sliceId: 'S04-A',
    taskId: 'S04-A-T01',
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: 'delivery/stages/S04/evidence/S04-A.md',
    changedFiles: options.wideScope
      ? [
          'delivery/stages/S04/evidence/S04-A.md',
          'delivery/stages/S04/tasks.md',
          ...DECLARED_WIDE_SCOPE_TEST_FILES,
        ]
      : [
          'delivery/stages/S04/evidence/S04-A.md',
          'delivery/stages/S04/tasks.md',
          'packages/worker-test.ts',
        ],
    verificationRuns: [],
    summary: 'worker completed the commit fixture',
    manifestDigest: manifestDigest,
    planDigest: planDigest,
    proofIndexDigest: next.proof_index_digest,
    snapshotDigest,
    contextRef: next.context_ref,
    contextDigest: context.context_digest,
  }, { projectRoot: root });
  expect(worker.accepted).toBe(true);

  const slice = (manifest.slices as Array<Record<string, any>>)[0];
  const proofIndex = slice.proof_index as Record<string, any>;
  const cvInput: Record<string, unknown> = {
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
    verdict: options.cvVerdict ?? 'PASS',
    summary: 'commit fixture passed',
    acceptance_refs_checked: [...proofIndex.acceptance_refs],
    seam_refs_checked: [...proofIndex.seam_refs],
    oracle_refs_checked: [...proofIndex.oracle_refs],
    risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'fixture binding',
    })),
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
  };
  if (options.cvVerdict === 'REPAIR') {
    cvInput.failed_criterion = 'fixture criterion';
    cvInput.failure_signature = 'fixture failure';
    cvInput.required_recheck_scope = ['packages/worker-test.ts'];
  }
  const cv = admitVNextCVResult(cvInput, { projectRoot: root });
  expect(cv.accepted).toBe(true);

  // REPAIR-only files are created between the CV_REPAIR and the recheck and
  // are committed together with the declared Slice boundary, mirroring the
  // real REPAIR → recheck → Slice Commit flow (S08-E shape).
  if (options.includeRepairFilesInCommit === true) {
    for (const relative of REPAIR_EXTRA_FILES) {
      fs.writeFileSync(path.join(root, relative), 'export const repaired = true;\n', 'utf8');
    }
  }
  execFileSync('git', [
    '-C', root, 'add',
    'delivery/stages/S04/tasks.md',
    'delivery/stages/S04/evidence/S04-A.md',
    ...(options.wideScope ? DECLARED_WIDE_SCOPE_TEST_FILES : ['packages/worker-test.ts']),
    ...(options.includeRepairFilesInCommit === true ? REPAIR_EXTRA_FILES : []),
  ]);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'slice-output: S04-S04-A']);

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
  };
}

interface MultiTaskFixture {
  readonly root: string;
  readonly snapshotDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly workerReceiptDigest?: string;
  readonly cvReceiptDigest?: string;
  readonly commitSha?: string;
}

type MultiTaskCompletionCount = 0 | 1 | 2;

type DispatchContext = {
  readonly contextRef: string;
  readonly contextDigest: string;
};

function multiTaskPlan(taskScopes: Record<string, any>): Record<string, unknown> {
  return {
    schema_version: 2,
    items: [
      {
        id: 'S04',
        kind: 'stage',
        goal: 'vNext multi-task commit fixture stage',
        refs: ['REF-S04-STAGE-GOAL', 'REF-S04-FOUNDATION-GOAL'],
        dependencies: ['S0-A'],
        required_skills: [],
      },
      {
        id: 'S04-A',
        kind: 'slice',
        goal: 'vNext multi-task commit fixture slice',
        refs: ['REF-S04-A-GOAL'],
        dependencies: ['S0-A'],
        required_skills: ['test-driven-development'],
      },
      {
        id: 'S04-A-T01',
        kind: 'task',
        goal: 'complete the first fixture task',
        refs: ['REF-S04-A-T01'],
        dependencies: ['S04-A'],
        required_skills: ['test-driven-development'],
        execution_scope: taskScopes['S04-A-T01'].execution_scope,
      },
      {
        id: 'S04-A-T02',
        kind: 'task',
        goal: 'complete the second fixture task',
        refs: ['REF-S04-A-T02'],
        dependencies: ['S04-A-T01'],
        required_skills: ['test-driven-development'],
        execution_scope: taskScopes['S04-A-T02'].execution_scope,
      },
    ],
  };
}

function configureMultiTaskManifest(root: string): void {
  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  const tasks = fs.readFileSync(tasksPath, 'utf8').replace(
    '- Worker Status: `NOT_STARTED`',
    '- Worker Status: `planned`',
  ).replace(
    '<!-- SLICE:S04-A:END -->',
    [
      '<!-- proofloop:entity id="S04-A-T02" kind="task" -->',
      '- [ ] S04-A-T02 — second fixture task',
      '',
      '<!-- SLICE:S04-A:END -->',
    ].join('\n'),
  );
  fs.writeFileSync(tasksPath, tasks, 'utf8');

  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  const taskScopes = {
    'S04-A-T01': {
      task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['delivery/stages/S04/tasks.md'],
        test_paths: ['packages/worker-test.ts'],
        forbidden_paths: ['.proofloop/receipts'],
      },
    },
    'S04-A-T02': {
      task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T02',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['packages/worker-test-2.ts'],
        test_paths: ['packages/worker-test-2.spec.ts'],
        forbidden_paths: ['.proofloop/receipts'],
      },
    },
  };
  manifest.task_scopes = taskScopes;

  const referenceIndex = manifest.reference_index as Record<string, any>;
  referenceIndex['REF-S04-A-T02'] = {
    kind: 'task',
    ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T02',
    file_digest: '',
    section_digest: '',
  };
  const slice = (manifest.slices as Array<Record<string, any>>).find(
    (candidate) => candidate.slice_id === 'S04-A',
  );
  if (slice === undefined) throw new Error('multi-task fixture Slice S04-A is unavailable');
  const proofIndex = slice.proof_index as Record<string, any>;
  proofIndex.task_refs = [...proofIndex.task_refs, 'REF-S04-A-T02'];

  // Rebuild every digest affected by the additional immutable Task.  The
  // Context and proof-index digests are then produced by the real Runtime
  // dispatch/next consumers below, rather than written by the fixture.
  const plan = multiTaskPlan(taskScopes);
  manifest.plan.plan_digest = computePlanDigest(plan as any);
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
  fs.writeFileSync(path.join(root, 'packages/worker-test-2.ts'), 'export const fixtureTwo = true;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'packages/worker-test-2.spec.ts'), 'export const fixtureTwoTest = true;\n', 'utf8');
}

function multiTaskWorkerEnvelope(
  fixture: MultiTaskFixture,
  taskId: 'S04-A-T01' | 'S04-A-T02',
  actionToken: string,
  context: DispatchContext,
  changedFiles: readonly string[],
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    actionToken,
    stageId: 'S04',
    sliceId: 'S04-A',
    taskId,
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: 'delivery/stages/S04/evidence/S04-A.md',
    changedFiles: [...changedFiles],
    verificationRuns: [],
    summary: `${taskId} multi-task fixture completed`,
    manifestDigest: fixture.manifestDigest,
    planDigest: fixture.planDigest,
    proofIndexDigest: fixture.proofIndexDigest,
    snapshotDigest: fixture.snapshotDigest,
    contextRef: context.contextRef,
    contextDigest: context.contextDigest,
  };
}

function multiTaskCvEnvelope(
  fixture: MultiTaskFixture,
  context: DispatchContext,
  workerReceiptDigest: string,
): Record<string, unknown> {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixture.root, '.proofloop/manifests/S04.json'), 'utf8'),
  ) as Record<string, any>;
  const proofIndex = ((manifest.slices as Array<Record<string, any>>)[0]?.proof_index ?? {}) as Record<string, any>;
  return {
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: 'S04',
    slice_id: 'S04-A',
    worker_receipt_digest: workerReceiptDigest,
    manifest_digest: fixture.manifestDigest,
    plan_digest: fixture.planDigest,
    proof_index_digest: fixture.proofIndexDigest,
    context_ref: context.contextRef,
    context_digest: context.contextDigest,
    snapshot_digest: fixture.snapshotDigest,
    verification_type: 'initial',
    verdict: 'PASS',
    summary: 'multi-task fixture CV pass',
    acceptance_refs_checked: [...proofIndex.acceptance_refs],
    seam_refs_checked: [...proofIndex.seam_refs],
    oracle_refs_checked: [...proofIndex.oracle_refs],
    risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, unknown>>).map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'multi-task fixture execution binding is in scope',
    })),
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
  };
}

function applyMultiTaskFirstProjection(root: string): void {
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
      '- Task Goal: first multi-task fixture task',
      '- Relevant PO IDs: PO-MULTI-T01',
      '- Source Snapshot: multi-task-source-1',
      '- Current Snapshot: multi-task-current-1',
      '- Changed Files:',
      '  - delivery/stages/S04/evidence/S04-A.md',
      '  - delivery/stages/S04/tasks.md',
      '  - packages/worker-test.ts',
      '- RED Receipt:',
      '  - Test ID: multi-task-red-1',
      '  - Command: multi-task-red-command-1',
      '  - Failure Output: multi-task-red-output-1',
      '  - Expected Failure: multi-task-red-expected-1',
      '  - Snapshot: multi-task-red-snapshot-1',
      '- GREEN Receipt:',
      '  - Test ID: multi-task-green-1',
      '  - Command: multi-task-green-command-1',
      '  - Pass Output: multi-task-green-output-1',
      '  - Snapshot: multi-task-green-snapshot-1',
      '- Status: COMPLETE',
    ].join('\n'),
  );
  fs.writeFileSync(evidencePath, `${evidence}\n`, 'utf8');
  fs.appendFileSync(path.join(root, 'packages/worker-test.ts'), 'export const workerChanged = true;\n');
}

function applyMultiTaskSecondProjection(root: string): void {
  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- [ ] S04-A-T02', '- [x] S04-A-T02'),
    'utf8',
  );
  const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
  const secondTaskEvidence = [
    '',
    '### S04-A-T02',
    '',
    '- Task Goal: second multi-task fixture task',
    '- Relevant PO IDs: PO-MULTI-T02',
    '- Source Snapshot: multi-task-source-2',
    '- Current Snapshot: multi-task-current-2',
    '- Changed Files:',
    '  - delivery/stages/S04/evidence/S04-A.md',
    '  - delivery/stages/S04/tasks.md',
    '  - packages/worker-test-2.ts',
    '  - packages/worker-test-2.spec.ts',
    '- RED Receipt:',
    '  - Test ID: multi-task-red-2',
    '  - Command: multi-task-red-command-2',
    '  - Failure Output: multi-task-red-output-2',
    '  - Expected Failure: multi-task-red-expected-2',
    '  - Snapshot: multi-task-red-snapshot-2',
    '- GREEN Receipt:',
    '  - Test ID: multi-task-green-2',
    '  - Command: multi-task-green-command-2',
    '  - Pass Output: multi-task-green-output-2',
    '  - Snapshot: multi-task-green-snapshot-2',
    '- Status: COMPLETE',
  ].join('\n');
  const evidence = fs.readFileSync(evidencePath, 'utf8').replace(
    '\n## Current Slice Evidence',
    `${secondTaskEvidence}\n\n## Current Slice Evidence`,
  );
  fs.writeFileSync(evidencePath, evidence, 'utf8');
  fs.appendFileSync(path.join(root, 'packages/worker-test-2.ts'), 'export const workerChangedTwo = true;\n');
  fs.appendFileSync(path.join(root, 'packages/worker-test-2.spec.ts'), 'export const workerChangedTwoTest = true;\n');
}

function prepareMultiTask(options: { readonly completeTasks: MultiTaskCompletionCount }): MultiTaskFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-commit-multi-task-')));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'multi-task@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Multi-Task Commit Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  for (const relative of [
    'delivery/stages/S04/tasks.md',
    '.proofloop/manifests/S04.json',
    'delivery/stages/S04/evidence/S04-A.md',
    'delivery/stages/S0-A/tasks.md',
  ]) copyFixture(root, relative);
  configureMultiTaskManifest(root);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'multi-task candidate boundary']);

  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
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

  const firstNext = new VNextNextActionService().nextAction({
    projectRoot: root,
    stageId: 'S04',
    snapshotDigest,
    persistContext: true,
  });
  expect(firstNext.action).toBe('DISPATCH_WORKER');
  expect(firstNext.task_id).toBe('S04-A-T01');
  const firstContext = JSON.parse(
    fs.readFileSync(path.join(root, firstNext.context_ref as string), 'utf8'),
  ) as { context_digest: string };
  const base: MultiTaskFixture = {
    root,
    snapshotDigest,
    manifestDigest,
    planDigest,
    proofIndexDigest: firstNext.proof_index_digest as string,
    contextRef: firstNext.context_ref as string,
    contextDigest: firstContext.context_digest,
  };
  const firstContextRef: DispatchContext = {
    contextRef: base.contextRef,
    contextDigest: base.contextDigest,
  };
  expect(base.manifestDigest).toBe(computeDigest(manifest));
  expect(base.proofIndexDigest).toBe(computeDigest((manifest.slices as Array<Record<string, any>>)[0].proof_index));
  expect(firstContext.context_digest).toBe(base.contextDigest);
  if (options.completeTasks === 0) return base;

  applyMultiTaskFirstProjection(root);
  const firstWorker = admitVNextWorkerResult(
    multiTaskWorkerEnvelope(
      base,
      'S04-A-T01',
      'multi-task-worker-t01',
      firstContextRef,
      [
        'delivery/stages/S04/evidence/S04-A.md',
        'delivery/stages/S04/tasks.md',
        'packages/worker-test.ts',
      ],
    ),
    { projectRoot: root },
  );
  expect(firstWorker.accepted).toBe(true);
  if (options.completeTasks === 1) {
    return { ...base, workerReceiptDigest: firstWorker.receipt_ref as string };
  }

  const secondNext = new VNextNextActionService().nextAction({
    projectRoot: root,
    stageId: 'S04',
    snapshotDigest,
    persistContext: true,
  });
  expect(secondNext.action).toBe('DISPATCH_WORKER');
  expect(secondNext.task_id).toBe('S04-A-T02');
  const secondContext = JSON.parse(
    fs.readFileSync(path.join(root, secondNext.context_ref as string), 'utf8'),
  ) as { context_digest: string };
  const secondContextRef: DispatchContext = {
    contextRef: secondNext.context_ref as string,
    contextDigest: secondContext.context_digest,
  };
  expect(secondContext.context_digest).toBe(secondNext.context_ref?.slice('.proofloop/context/'.length, -'.json'.length));
  applyMultiTaskSecondProjection(root);
  const secondWorker = admitVNextWorkerResult(
    multiTaskWorkerEnvelope(
      base,
      'S04-A-T02',
      'multi-task-worker-t02',
      secondContextRef,
      [
        'delivery/stages/S04/evidence/S04-A.md',
        'delivery/stages/S04/tasks.md',
        'packages/worker-test.ts',
        'packages/worker-test-2.ts',
        'packages/worker-test-2.spec.ts',
      ],
    ),
    { projectRoot: root },
  );
  expect(secondWorker.accepted).toBe(true);

  const cv = admitVNextCVResult(
    multiTaskCvEnvelope(base, secondContextRef, secondWorker.receipt_ref as string),
    { projectRoot: root },
  );
  expect(cv.accepted).toBe(true);

  execFileSync('git', [
    '-C',
    root,
    'add',
    'delivery/stages/S04/tasks.md',
    'delivery/stages/S04/evidence/S04-A.md',
    'packages/worker-test.ts',
    'packages/worker-test-2.ts',
    'packages/worker-test-2.spec.ts',
  ]);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'multi-task slice output']);
  return {
    ...base,
    workerReceiptDigest: secondWorker.receipt_ref as string,
    cvReceiptDigest: cv.receipt_ref as string,
    commitSha: git(root, ['rev-parse', 'HEAD']),
  };
}

interface MultiSliceChainFixture {
  readonly root: string;
  readonly snapshotDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly cvReceiptDigest: string;
  readonly commitSha: string;
}

/**
 * Build the multi-Slice commit topology that exposed the changed-file
 * baseline defect: admission snapshot P, a prior Slice commit A (P's
 * descendant) carrying a file outside the current Slice scope, an optional
 * non-Slice fix commit F between the Slice outputs, and the current Slice
 * commit B whose parent boundary contains exactly the declared files.
 */
function prepareMultiSliceChain(options: {
  readonly fixCommit?: boolean;
} = {}): MultiSliceChainFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-commit-multi-slice-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'multi-slice@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Multi-Slice Commit Test']);
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
    fs.readFileSync(tasksPath, 'utf8').replace('- Worker Status: `NOT_STARTED`', '- Worker Status: `planned`'),
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
        forbidden_paths: ['.proofloop/receipts'],
      },
    },
  };
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/worker-test.ts'), 'export const fixture = true;\n', 'utf8');
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'vnext multi-slice fixture']);

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
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8')
      .replace('- [ ] S04-A-T01', '- [x] S04-A-T01')
      .replace('- Worker Status: `planned`', '- Worker Status: `executing`'),
    'utf8',
  );
  const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
  fs.writeFileSync(
    evidencePath,
    fs.readFileSync(evidencePath, 'utf8').replace(
      '## Task Evidence\n\n*Not yet captured.*',
      [
        '## Task Evidence',
        '',
        '### S04-A-T01',
        '',
        '- Task Goal: multi-slice fixture',
        '- Relevant PO IDs: PO-MULTI-SLICE',
        '- Source Snapshot: multi-slice-source',
        '- Current Snapshot: multi-slice-current',
        '- Changed Files:',
        '  - delivery/stages/S04/evidence/S04-A.md',
        '  - delivery/stages/S04/tasks.md',
        '  - packages/worker-test.ts',
        '- RED Receipt:',
        '  - Test ID: multi-slice-red',
        '  - Command: multi-slice-red-command',
        '  - Failure Output: multi-slice-red-output',
        '  - Expected Failure: multi-slice-red-expected',
        '  - Snapshot: multi-slice-red-snapshot',
        '- GREEN Receipt:',
        '  - Test ID: multi-slice-green',
        '  - Command: multi-slice-green-command',
        '  - Pass Output: multi-slice-green-output',
        '  - Snapshot: multi-slice-green-snapshot',
        '- Status: COMPLETE',
      ].join('\n'),
    ),
    'utf8',
  );
  fs.appendFileSync(path.join(root, 'packages/worker-test.ts'), 'export const workerChanged = true;\n');

  const worker = admitVNextWorkerResult({
    schemaVersion: 2,
    actionToken: 'multi-slice-worker-1',
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
    summary: 'worker completed the multi-slice fixture',
    manifestDigest: manifestDigest,
    planDigest: planDigest,
    proofIndexDigest: next.proof_index_digest,
    snapshotDigest,
    contextRef: next.context_ref,
    contextDigest: context.context_digest,
  }, { projectRoot: root });
  expect(worker.accepted).toBe(true);

  const slice = (manifest.slices as Array<Record<string, any>>)[0];
  const proofIndex = slice.proof_index as Record<string, any>;
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
    summary: 'multi-slice fixture passed',
    acceptance_refs_checked: [...proofIndex.acceptance_refs],
    seam_refs_checked: [...proofIndex.seam_refs],
    oracle_refs_checked: [...proofIndex.oracle_refs],
    risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'fixture binding',
    })),
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
  }, { projectRoot: root });
  expect(cv.accepted).toBe(true);

  // Prior Slice commit A (descendant of the admission snapshot P) carries a
  // file outside the current Slice scope, mirroring S08-A's Slice commit
  // being inserted between the S08 admission snapshot and the S08-B commit.
  // S04-B.md is not referenced by the Manifest reference_index, so the
  // Manifest/Plan digest bindings stay intact while the path remains
  // outside the admitted S04-A execution scope.
  fs.writeFileSync(
    path.join(root, 'delivery/stages/S04/evidence/S04-B.md'),
    '# Prior Slice Evidence\n\nprior slice output\n',
    'utf8',
  );
  execFileSync('git', ['-C', root, 'add', 'delivery/stages/S04/evidence/S04-B.md']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'slice-output: S04-S04-B']);

  // Optional non-Slice fix commit F between the two Slice outputs.
  if (options.fixCommit === true) {
    fs.writeFileSync(path.join(root, 'packages/fix-note.ts'), 'export const fix = true;\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', 'packages/fix-note.ts']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'fix(pluginv2): execution chain fix between slice outputs']);
  }

  // Current Slice commit B: its parent boundary must contain exactly the
  // files declared by the persisted Worker facts.
  execFileSync('git', ['-C', root, 'add',
    'delivery/stages/S04/tasks.md',
    'delivery/stages/S04/evidence/S04-A.md',
    'packages/worker-test.ts',
  ]);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'slice-output: S04-S04-A']);

  return {
    root,
    snapshotDigest,
    manifestDigest,
    planDigest,
    proofIndexDigest: next.proof_index_digest as string,
    cvReceiptDigest: cv.receipt_ref as string,
    commitSha: git(root, ['rev-parse', 'HEAD']),
  };
}

type SliceCommitShapeMutation = (
  state: Record<string, unknown>,
  payload: Record<string, unknown>,
) => void;

const malformedSliceCommitShapes: ReadonlyArray<readonly [string, SliceCommitShapeMutation, string]> = [
  [
    'state changed_files is not an array',
    (state) => { state.changed_files = 'not-an-array'; },
    'SLICE_COMMIT state.changed_files must be an array of unique root-relative strings',
  ],
  [
    'payload changed_files is not an array',
    (_state, payload) => { payload.changed_files = 'not-an-array'; },
    'SLICE_COMMIT payload.changed_files must be an array of unique root-relative strings',
  ],
  [
    'state contains an unknown field',
    (state) => { state.extra = true; },
    'SLICE_COMMIT state contains unknown field(s): extra',
  ],
  [
    'payload contains an unknown field',
    (_state, payload) => { payload.extra = true; },
    'SLICE_COMMIT payload contains unknown field(s): extra',
  ],
  [
    'state omits proof_index_digest',
    (state) => { delete state.proof_index_digest; },
    'SLICE_COMMIT state.proof_index_digest is required',
  ],
  [
    'payload omits receipt_chain_valid',
    (_state, payload) => { delete payload.receipt_chain_valid; },
    'SLICE_COMMIT payload.receipt_chain_valid is required',
  ],
  [
    'state receipt_chain_valid has the wrong type',
    (state) => { state.receipt_chain_valid = 1; },
    'SLICE_COMMIT state.receipt_chain_valid must be true',
  ],
  [
    'payload changed_files contains a duplicate',
    (_state, payload) => {
      payload.changed_files = ['packages/worker-test.ts', 'packages/worker-test.ts'];
    },
    'SLICE_COMMIT payload.changed_files contains duplicate entries',
  ],
  [
    'payload changed_files escapes the root',
    (_state, payload) => {
      payload.changed_files = ['../outside.ts'];
    },
    'SLICE_COMMIT payload.changed_files[0] must be a canonical root-relative path string',
  ],
];

function runMalformedSliceCommitShape(mutate: SliceCommitShapeMutation): {
  readonly root: string;
  readonly targetDir: string;
  readonly writerCalls: number;
  readonly result: ReturnType<typeof runReceiptAdmission>;
} {
  const root = makeFixtureRoot();
  const state: Record<string, unknown> = {
    schema_version: 2,
    type: 'SLICE_COMMIT_RESULT',
    action: 'SLICE_COMMIT',
    stage_id: 'S04',
    slice_id: 'S04-A',
    manifest_digest: 'a'.repeat(64),
    plan_digest: 'b'.repeat(64),
    proof_index_digest: 'c'.repeat(64),
    snapshot_digest: 'd'.repeat(40),
    commit_sha: 'e'.repeat(40),
    cv_receipt_digest: 'f'.repeat(64),
    changed_files: ['packages/worker-test.ts'],
    receipt_chain_valid: true,
  };
  const payload: Record<string, unknown> = {
    ...state,
    changed_files: ['packages/worker-test.ts'],
  };
  mutate(state, payload);
  let writerCalls = 0;
  const targetDir = committerReceiptDir(root, 'S04', 'S04-A');
  const result = runReceiptAdmission({
    build: {
      type: 'SLICE_COMMIT',
      stage_id: 'S04',
      slice_id: 'S04-A',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload,
    },
    targetDir,
    nextState: state,
    projectRoot: root,
    writer: {
      write: () => {
        writerCalls += 1;
        return { path: path.join(targetDir, 'unexpected.json'), digest: '1'.repeat(64) };
      },
      verifyChain: () => ({ valid: true, receipts: [] }),
    },
  });
  return { root, targetDir, writerCalls, result };
}

type PreparedSliceCommitFixture = ReturnType<typeof prepare>;

function admitPreparedSliceCommit(fixture: PreparedSliceCommitFixture) {
  return admitVNextSliceCommit({
    type: 'slice_commit',
    stageId: 'S04',
    sliceId: 'S04-A',
    commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
    cvReceiptDigest: fixture.cvReceiptDigest,
  }, { projectRoot: fixture.root });
}

function expectNoPreparedSliceCommitReceipt(
  fixture: PreparedSliceCommitFixture,
  result: ReturnType<typeof admitVNextSliceCommit>,
): void {
  expect(result.accepted).toBe(false);
  expect(result.receipt_ref).toBeNull();
  expect(readReceiptCategory({
    projectRoot: fixture.root,
    category: 'committer',
    stageId: 'S04',
    sliceId: 'S04-A',
  }).receipts).toHaveLength(0);
}

/** Build a closed vNext CV envelope matching the prepare() fixture bindings. */
function makeCvEnvelope(
  fixture: {
    readonly root: string;
    readonly manifestDigest: string;
    readonly planDigest: string;
    readonly proofIndexDigest: string;
    readonly contextRef: string;
    readonly contextDigest: string;
    readonly workerReceiptDigest: string;
    readonly snapshotDigest: string;
  },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixture.root, '.proofloop/manifests/S04.json'), 'utf8'),
  ) as Record<string, any>;
  const proofIndex = ((manifest.slices as Array<Record<string, any>>)[0]?.proof_index ?? {}) as Record<string, any>;
  return {
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: 'S04',
    slice_id: 'S04-A',
    worker_receipt_digest: fixture.workerReceiptDigest,
    manifest_digest: fixture.manifestDigest,
    plan_digest: fixture.planDigest,
    proof_index_digest: fixture.proofIndexDigest,
    context_ref: fixture.contextRef,
    context_digest: fixture.contextDigest,
    snapshot_digest: fixture.snapshotDigest,
    verification_type: 'initial',
    verdict: 'PASS',
    summary: 'handwritten CV fact for Slice Commit boundary assertions',
    acceptance_refs_checked: [...proofIndex.acceptance_refs],
    seam_refs_checked: [...proofIndex.seam_refs],
    oracle_refs_checked: [...proofIndex.oracle_refs],
    risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, unknown>>).map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'handwritten fixture binding',
    })),
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
    ...overrides,
  };
}

/**
 * Persist one CV receipt directly into the CV chain (bypassing CV admission),
 * so Slice Commit admission can be exercised against a tampered / handwritten
 * CV history that CV admission itself would never produce.
 */
function writeCvReceipt(
  root: string,
  envelope: Record<string, unknown>,
  previousDigest: string | undefined,
): string {
  const data: Record<string, unknown> = {
    version: 1,
    type: envelope.verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
    stage_id: 'S04',
    slice_id: 'S04-A',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: envelope,
  };
  if (previousDigest !== undefined) data.previous_digest = previousDigest;
  const digest = computeReceiptDigest(data);
  const dir = cvReceiptDir(root, 'S04', 'S04-A');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${digest}.json`), JSON.stringify({ ...data, digest }), 'utf8');
  return digest;
}

/** Replace the persisted CV chain with the supplied receipts (genesis first). */
function replaceCvChain(root: string, receipts: readonly { envelope: Record<string, unknown> }[]): string {
  const dir = cvReceiptDir(root, 'S04', 'S04-A');
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
  }
  let previous: string | undefined;
  let tip: string | undefined;
  for (const entry of receipts) {
    tip = writeCvReceipt(root, entry.envelope, previous);
    previous = tip;
  }
  return tip as string;
}

describe('vNext Slice Commit admission', () => {
  it.each(malformedSliceCommitShapes)('rejects a malformed closed state/payload before K2 and writer: %s', (_label, mutate, expectedFinding) => {
    const outcome = runMalformedSliceCommitShape(mutate);
    expect(outcome.result.accepted).toBe(false);
    expect(outcome.result.receipt_ref).toBeNull();
    expect(outcome.result.new_state).toBeNull();
    expect(outcome.result.findings).toEqual([{
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
      message: expectedFinding,
    }]);
    expect(outcome.writerCalls).toBe(0);
    expect(fs.existsSync(outcome.targetDir)).toBe(false);
    expect(readReceiptCategory({
      projectRoot: outcome.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('admits only the current HEAD boundary after a final CV_PASS', () => {
    const fixture = prepare();
    const commitSha = git(fixture.root, ['rev-parse', 'HEAD']);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.new_state).toBeNull();
    expect(result.vnext_state).toMatchObject({
      schema_version: 2,
      type: 'SLICE_COMMIT_RESULT',
      action: 'SLICE_COMMIT',
      commit_sha: commitSha,
      cv_receipt_digest: fixture.cvReceiptDigest,
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      proof_index_digest: fixture.proofIndexDigest,
      snapshot_digest: fixture.snapshotDigest,
      receipt_chain_valid: true,
      changed_files: [
        'delivery/stages/S04/evidence/S04-A.md',
        'delivery/stages/S04/tasks.md',
        'packages/worker-test.ts',
      ],
    });
    expect(Object.keys(result.vnext_state ?? {}).sort()).toEqual([
      'action',
      'changed_files',
      'commit_sha',
      'cv_receipt_digest',
      'manifest_digest',
      'plan_digest',
      'proof_index_digest',
      'receipt_chain_valid',
      'schema_version',
      'slice_id',
      'snapshot_digest',
      'stage_id',
      'type',
    ]);
    const receipts = readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.receipt.payload).toMatchObject({
      schema_version: 2,
      type: 'SLICE_COMMIT_RESULT',
      action: 'SLICE_COMMIT',
      commit_sha: commitSha,
      cv_receipt_digest: fixture.cvReceiptDigest,
      proof_index_digest: fixture.proofIndexDigest,
      receipt_chain_valid: true,
    });
    expect(Object.keys((receipts[0]?.receipt.payload ?? {}) as Record<string, unknown>).sort()).toEqual([
      'action',
      'changed_files',
      'commit_sha',
      'cv_receipt_digest',
      'manifest_digest',
      'plan_digest',
      'proof_index_digest',
      'receipt_chain_valid',
      'schema_version',
      'slice_id',
      'snapshot_digest',
      'stage_id',
      'type',
    ]);

    const duplicate = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.receipt_ref).toBeNull();
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(1);
  });

  it('fails closed when the vNext Manifest route changes before the Receipt write', () => {
    const fixture = prepare();
    const commitSha = git(fixture.root, ['rev-parse', 'HEAD']);
    let writerWriteCalls = 0;
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, {
      projectRoot: fixture.root,
      writer: {
        write: () => {
          writerWriteCalls += 1;
          return {
            path: path.join(fixture.root, 'unused-receipt.json'),
            digest: 'd'.repeat(64),
          };
        },
        verifyChain: () => {
          writeLegalV1Manifest(fixture.root);
          return { valid: true, receipts: [] };
        },
      },
    });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]).toMatchObject({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
    });
    expect(result.findings[0]?.message).toMatch(/vNext Manifest route|observed v1/i);
    expect(writerWriteCalls).toBe(0);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('rejects a stale HEAD or mismatched CV Receipt digest without writing', () => {
    const fixture = prepare();
    const head = git(fixture.root, ['rev-parse', 'HEAD']);
    const wrongDigest = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: head,
      cvReceiptDigest: 'f'.repeat(64),
    }, { projectRoot: fixture.root });
    expect(wrongDigest.accepted).toBe(false);
    expect(wrongDigest.receipt_ref).toBeNull();
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);

    const staleHead = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.snapshotDigest,
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });
    expect(staleHead.accepted).toBe(false);
    expect(staleHead.receipt_ref).toBeNull();
  });

  it('rejects CV_REPAIR and any non-final-PASS CV history without writing', () => {
    const fixture = prepare({ cvVerdict: 'REPAIR' });
    const commitSha = git(fixture.root, ['rev-parse', 'HEAD']);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('admits a Slice Commit after a REPAIR → recheck PASS bound to the same Worker Receipt tip', () => {
    // A Worker repair does not produce a new Worker Receipt, so the recheck
    // PASS binds the SAME Worker tip as the preceding CV_REPAIR. The CV
    // history [REPAIR → recheck PASS] is a legal tail sequence and must not
    // be mistaken for a duplicate Worker Receipt reuse.
    const fixture = prepare({ cvVerdict: 'REPAIR' });
    const manifestPath = path.join(fixture.root, '.proofloop/manifests/S04.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    const proofIndex = (manifest.slices as Array<Record<string, any>>)[0].proof_index as Record<string, any>;

    const recheck = admitVNextCVResult({
      schema_version: 2,
      type: 'CV_RESULT',
      stage_id: 'S04',
      slice_id: 'S04-A',
      worker_receipt_digest: fixture.workerReceiptDigest,
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      proof_index_digest: fixture.proofIndexDigest,
      context_ref: fixture.contextRef,
      context_digest: fixture.contextDigest,
      snapshot_digest: fixture.snapshotDigest,
      verification_type: 'recheck',
      verdict: 'PASS',
      summary: 'commit fixture recheck passed',
      previous_failure_signature: 'fixture failure',
      repair_diff_digest: 'd'.repeat(64),
      acceptance_refs_checked: [...proofIndex.acceptance_refs],
      seam_refs_checked: [...proofIndex.seam_refs],
      oracle_refs_checked: [...proofIndex.oracle_refs],
      risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
        ref_id: risk.ref_id,
        applicability: 'APPLICABLE',
        reason: 'fixture binding',
      })),
      failed_acceptance_refs: [],
      invalid_tests: [],
      counterexamples: [],
      scope_violations: [],
      forbidden_substitutions: [],
      regression_failures: [],
    }, { projectRoot: fixture.root });
    expect(recheck.accepted).toBe(true);

    const commitSha = git(fixture.root, ['rev-parse', 'HEAD']);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
      cvReceiptDigest: recheck.receipt_ref as string,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(1);
  });

  it('admits a Slice Commit whose committed boundary includes REPAIR-only files beyond the declared Worker facts', () => {
    // A Worker repair does not produce a new Worker Receipt or Worker fact,
    // so the files it modifies are absent from the persisted declared set.
    // When the repair touches previously undeclared in-scope files (the
    // S08-E shape: types.ts / gate-admission.ts / gate-admission.spec.ts),
    // the committed boundary is a strict superset of the Worker facts and
    // must still be admitted; the scope check keeps every committed path
    // inside the admitted execution scope.
    const fixture = prepare({
      cvVerdict: 'REPAIR',
      wideScope: true,
      includeRepairFilesInCommit: true,
    });
    const manifestPath = path.join(fixture.root, '.proofloop/manifests/S04.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    const proofIndex = (manifest.slices as Array<Record<string, any>>)[0].proof_index as Record<string, any>;

    const recheck = admitVNextCVResult({
      schema_version: 2,
      type: 'CV_RESULT',
      stage_id: 'S04',
      slice_id: 'S04-A',
      worker_receipt_digest: fixture.workerReceiptDigest,
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      proof_index_digest: fixture.proofIndexDigest,
      context_ref: fixture.contextRef,
      context_digest: fixture.contextDigest,
      snapshot_digest: fixture.snapshotDigest,
      verification_type: 'recheck',
      verdict: 'PASS',
      summary: 'commit fixture recheck passed after repair files',
      previous_failure_signature: 'fixture failure',
      repair_diff_digest: 'd'.repeat(64),
      acceptance_refs_checked: [...proofIndex.acceptance_refs],
      seam_refs_checked: [...proofIndex.seam_refs],
      oracle_refs_checked: [...proofIndex.oracle_refs],
      risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
        ref_id: risk.ref_id,
        applicability: 'APPLICABLE',
        reason: 'fixture binding',
      })),
      failed_acceptance_refs: [],
      invalid_tests: [],
      counterexamples: [],
      scope_violations: [],
      forbidden_substitutions: [],
      regression_failures: [],
    }, { projectRoot: fixture.root });
    expect(recheck.accepted).toBe(true);

    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: recheck.receipt_ref as string,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.vnext_state?.changed_files).toHaveLength(
      DECLARED_WIDE_SCOPE_TEST_FILES.length + 2 + REPAIR_EXTRA_FILES.length,
    );
    expect(result.vnext_state?.changed_files).toEqual(expect.arrayContaining([...REPAIR_EXTRA_FILES]));
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(1);
  });

  it('rejects a dirty or uncommitted worktree without writing', () => {
    const fixture = prepare();
    fs.appendFileSync(path.join(fixture.root, 'packages/worker-test.ts'), 'dirty\n', 'utf8');
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('rejects a committed changed file outside the admitted execution scope', () => {
    const fixture = prepare();
    fs.writeFileSync(path.join(fixture.root, 'outside-scope.txt'), 'outside\n', 'utf8');
    execFileSync('git', ['-C', fixture.root, 'add', 'outside-scope.txt']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'out-of-scope output']);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('rejects an incomplete Worker prefix before Slice Commit without writing', () => {
    const fixture = prepare();
    fs.unlinkSync(path.join(
      fixture.root,
      '.proofloop',
      'receipts',
      'tasks',
      'S04',
      'S04-A',
      `${fixture.workerReceiptDigest}.json`,
    ));
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('rejects Slice Commit when a two-task Manifest has only the T01 Worker Receipt', () => {
    const fixture = prepareMultiTask({ completeTasks: 1 });
    const workerReceipts = readReceiptCategory({
      projectRoot: fixture.root,
      category: 'tasks',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts;
    expect(workerReceipts).toHaveLength(1);
    expect(workerReceipts[0]?.receipt.payload.task_id).toBe('S04-A-T01');

    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: '0'.repeat(64),
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.new_state).toBeNull();
    expect(result.findings[0]?.message).toMatch(/Worker Receipt count 1 does not equal Manifest task count 2/);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('rejects a direct T02 Worker attempt and the following Slice Commit when T01 is skipped', () => {
    const fixture = prepareMultiTask({ completeTasks: 0 });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixture.root, '.proofloop/manifests/S04.json'), 'utf8'),
    ) as Record<string, any>;
    const dispatch = projectVNextWorkerDispatch({
      root: fixture.root,
      manifest,
      manifestDigest: fixture.manifestDigest,
      snapshotDigest: fixture.snapshotDigest,
      authority: readVNextAdmissionAuthority(fixture.root, 'S04'),
      sliceId: 'S04-A',
      completedTaskIds: ['S04-A-T01'],
    });
    persistVNextWorkerContext(fixture.root, dispatch);

    const workerAttempt = admitVNextWorkerResult(
      multiTaskWorkerEnvelope(
        fixture,
        'S04-A-T02',
        'multi-task-worker-t02-without-t01',
        {
          contextRef: dispatch.context_ref,
          contextDigest: dispatch.context.context_digest,
        },
        [
          'delivery/stages/S04/evidence/S04-A.md',
          'delivery/stages/S04/tasks.md',
          'packages/worker-test-2.ts',
          'packages/worker-test-2.spec.ts',
        ],
      ),
      { projectRoot: fixture.root },
    );
    expect(workerAttempt.accepted).toBe(false);
    expect(workerAttempt.receipt_ref).toBeNull();
    expect(workerAttempt.findings[0]?.message).toMatch(/prior Receipt.*S04-A-T01|prefix/i);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'tasks',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);

    const commitAttempt = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: '0'.repeat(64),
    }, { projectRoot: fixture.root });
    expect(commitAttempt.accepted).toBe(false);
    expect(commitAttempt.receipt_ref).toBeNull();
    expect(commitAttempt.new_state).toBeNull();
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('admits Slice Commit only after the real two-task T01→T02 prefix and CV chain completes', () => {
    const fixture = prepareMultiTask({ completeTasks: 2 });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixture.root, '.proofloop/manifests/S04.json'), 'utf8'),
    ) as Record<string, any>;
    expect(Object.keys(manifest.task_scopes as Record<string, unknown>)).toEqual([
      'S04-A-T01',
      'S04-A-T02',
    ]);
    expect((manifest.slices as Array<Record<string, any>>)[0]?.proof_index.task_refs).toEqual([
      'REF-S04-A-T01',
      'REF-S04-A-T02',
    ]);

    const workerReceipts = readReceiptCategory({
      projectRoot: fixture.root,
      category: 'tasks',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts;
    expect(workerReceipts).toHaveLength(2);
    expect(workerReceipts.map((entry) => entry.receipt.payload.task_id)).toEqual([
      'S04-A-T01',
      'S04-A-T02',
    ]);
    expect(workerReceipts[1]?.receipt.previous_digest).toBe(workerReceipts[0]?.receipt.digest);
    expect(workerReceipts[0]?.receipt.payload.proof_index_digest).toBe(fixture.proofIndexDigest);
    expect(workerReceipts[1]?.receipt.payload.proof_index_digest).toBe(fixture.proofIndexDigest);

    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(result.vnext_state).toMatchObject({
      type: 'SLICE_COMMIT_RESULT',
      action: 'SLICE_COMMIT',
      commit_sha: fixture.commitSha,
      cv_receipt_digest: fixture.cvReceiptDigest,
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      proof_index_digest: fixture.proofIndexDigest,
      snapshot_digest: fixture.snapshotDigest,
      receipt_chain_valid: true,
    });
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(1);
  });

  it('rejects wrong Manifest, Plan, proof, snapshot and Context bindings without writing', () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly mutate: (fixture: PreparedSliceCommitFixture) => void;
    }> = [
      {
        label: 'Manifest',
        mutate: (fixture) => {
          const manifestPath = path.join(fixture.root, '.proofloop/manifests/S04.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
          manifest.stage_id = 'S05';
          fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
        },
      },
      {
        label: 'Plan',
        mutate: (fixture) => {
          const manifestPath = path.join(fixture.root, '.proofloop/manifests/S04.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
          (manifest.plan as Record<string, unknown>).plan_digest = '0'.repeat(64);
          fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
        },
      },
      {
        label: 'proof',
        mutate: (fixture) => {
          const contextPath = path.join(fixture.root, fixture.contextRef);
          const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, any>;
          context.proof_index_digest = '0'.repeat(64);
          fs.writeFileSync(contextPath, JSON.stringify(context), 'utf8');
        },
      },
      {
        label: 'Context',
        mutate: (fixture) => {
          const contextPath = path.join(fixture.root, fixture.contextRef);
          const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, any>;
          context.stage_id = 'S05';
          fs.writeFileSync(contextPath, JSON.stringify(context), 'utf8');
        },
      },
      {
        label: 'snapshot',
        mutate: (fixture) => {
          execFileSync('git', ['-C', fixture.root, 'checkout', '--orphan', 'unrelated-snapshot'], {
            stdio: 'ignore',
          });
          execFileSync('git', ['-C', fixture.root, 'rm', '-r', '--cached', '.'], {
            stdio: 'ignore',
          });
          execFileSync('git', ['-C', fixture.root, 'add', '-A']);
          execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'unrelated snapshot']);
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = prepare();
      testCase.mutate(fixture);
      const result = admitPreparedSliceCommit(fixture);
      expectNoPreparedSliceCommitReceipt(fixture, result);
    }
  });

  it('routes the existing Runtime Slice Commit seam to vNext without reconcile', () => {
    const fixture = prepare();
    const commitSha = git(fixture.root, ['rev-parse', 'HEAD']);
    const result = admitSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, {
      projectRoot: fixture.root,
      reconcile: () => {
        throw new Error('legacy reconcile must not be called for a vNext Manifest');
      },
      reduce: () => {
        throw new Error('legacy reducer must not be called for a vNext Manifest');
      },
    });

    expect(result.accepted).toBe(true);
    expect(result.new_state).toBeNull();
    expect(result.vnext_state).toMatchObject({
      schema_version: 2,
      type: 'SLICE_COMMIT_RESULT',
      action: 'SLICE_COMMIT',
    });
  });

  it('rejects a vNext-bound direct Runtime admit after switching to a legal v1 Manifest', () => {
    const fixture = prepare();
    const commitSha = git(fixture.root, ['rev-parse', 'HEAD']);
    writeLegalV1Manifest(fixture.root);
    let reconcileCalls = 0;
    let reduceCalls = 0;
    let writerCalls = 0;
    const result = admitSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha,
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, {
      projectRoot: fixture.root,
      manifestRouteBinding: 'vnext',
      reconcile: () => {
        reconcileCalls += 1;
        throw new Error('legacy reconcile must not run after a route binding mismatch');
      },
      reduce: () => {
        reduceCalls += 1;
        throw new Error('legacy reducer must not run after a route binding mismatch');
      },
      writer: {
        write: () => {
          writerCalls += 1;
          return { path: path.join(fixture.root, 'unused-receipt.json'), digest: 'e'.repeat(64) };
        },
        verifyChain: () => {
          writerCalls += 1;
          return { valid: true, receipts: [] };
        },
      },
    });

    expect(result).toMatchObject({
      accepted: false,
      receipt_ref: null,
      new_state: null,
    });
    expect(result.findings[0]).toMatchObject({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
    });
    expect(result.findings[0]?.message).toMatch(/route binding mismatch|v1/i);
    expect(reconcileCalls).toBe(0);
    expect(reduceCalls).toBe(0);
    expect(writerCalls).toBe(0);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('admits a multi-Slice commit against its parent boundary instead of the admission snapshot', () => {
    const fixture = prepareMultiSliceChain();
    const parent = git(fixture.root, ['rev-parse', `${fixture.commitSha}^`]);
    const prior = git(fixture.root, ['rev-parse', `${parent}^`]);
    expect(prior).toBe(fixture.snapshotDigest);

    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(result.vnext_state).toMatchObject({
      snapshot_digest: fixture.snapshotDigest,
      commit_sha: fixture.commitSha,
      changed_files: [
        'delivery/stages/S04/evidence/S04-A.md',
        'delivery/stages/S04/tasks.md',
        'packages/worker-test.ts',
      ],
    });
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(1);
  });

  it('admits when a non-Slice fix commit is inserted between the prior and current Slice commits', () => {
    const fixture = prepareMultiSliceChain({ fixCommit: true });
    const parent = git(fixture.root, ['rev-parse', `${fixture.commitSha}^`]);
    const fix = git(fixture.root, ['rev-parse', `${parent}^`]);
    const prior = git(fixture.root, ['rev-parse', `${fix}^`]);
    expect(prior).toBe(fixture.snapshotDigest);

    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(result.vnext_state).toMatchObject({
      snapshot_digest: fixture.snapshotDigest,
      commit_sha: fixture.commitSha,
    });
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(1);
  });

  it('fails closed when the committed set includes a prior-Slice file beyond the current Slice scope', () => {
    const fixture = prepareMultiSliceChain();
    // 追加一个重新修改前 Slice 输出文件的 commit：S04-B.md 已在先前的
    // Slice commit A 中提交，且不属于当前 S04-A 的 admitted execution scope，
    // 因此该 commit 的文件集必然超出当前 Slice scope。
    fs.appendFileSync(
      path.join(fixture.root, 'delivery/stages/S04/evidence/S04-B.md'),
      'reopened prior slice evidence\n',
      'utf8',
    );
    execFileSync('git', ['-C', fixture.root, 'add', 'delivery/stages/S04/evidence/S04-B.md']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'prior slice evidence reopen']);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/expands beyond the admitted execution scope/);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('fails closed when committed files do not exactly match persisted Worker facts', () => {
    const fixture = prepareMultiSliceChain();
    // 追加一个只包含部分已声明文件的 commit，使 committed 集 ≠ declared 集，
    // 同时保持工作树 clean（否则会先被 working-tree 边界检查拒绝）。
    // evidence/S04-A.md 不在 Manifest reference_index 中，修改它不会破坏
    // Manifest/Plan digest 绑定。
    fs.appendFileSync(
      path.join(fixture.root, 'delivery/stages/S04/evidence/S04-A.md'),
      'incomplete second projection\n',
      'utf8',
    );
    execFileSync('git', ['-C', fixture.root, 'add', 'delivery/stages/S04/evidence/S04-A.md']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'incomplete slice output']);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/does not exactly match persisted Worker facts/);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('rejects a CV history whose first fact is not an initial verification', () => {
    // CV admission would never persist a recheck without a REPAIR predecessor,
    // so the chain is handwritten to prove Slice Commit admission independently
    // fail-closes against a tampered CV history.
    const fixture = prepare();
    const recheck = makeCvEnvelope(fixture, {
      verification_type: 'recheck',
      previous_failure_signature: 'stale-failure-signature',
      repair_diff_digest: 'd'.repeat(64),
    });
    const tip = replaceCvChain(fixture.root, [{ envelope: recheck }]);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: tip,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/first vNext CV fact must be an initial verification/);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('rejects a CV recheck whose predecessor is not a CV_REPAIR', () => {
    // PASS → recheck with a DIFFERENT Worker Receipt binding bypasses the
    // duplicate-guard, so the transition check itself must reject the tail.
    const fixture = prepareMultiTask({ completeTasks: 2 });
    const tasks = readReceiptCategory({
      projectRoot: fixture.root,
      category: 'tasks',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts;
    const t01 = tasks.find((entry) => entry.receipt.payload.task_id === 'S04-A-T01')?.receipt;
    expect(t01).toBeDefined();
    const recheck = makeCvEnvelope({
      ...fixture,
      workerReceiptDigest: t01?.digest as string,
      contextRef: t01?.payload.context_ref as string,
      contextDigest: t01?.payload.context_digest as string,
    }, {
      verification_type: 'recheck',
      previous_failure_signature: 'pass-predecessor',
      repair_diff_digest: 'd'.repeat(64),
    });
    const tip = writeCvReceipt(fixture.root, recheck, fixture.cvReceiptDigest);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha as string,
      cvReceiptDigest: tip,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/only a CV_REPAIR fact may be followed by a vNext CV recheck/);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('rejects a CV recheck whose previous_failure_signature does not match the CV_REPAIR', () => {
    const fixture = prepare({ cvVerdict: 'REPAIR' });
    const recheck = makeCvEnvelope(fixture, {
      verification_type: 'recheck',
      previous_failure_signature: 'wrong-failure-signature',
      repair_diff_digest: 'd'.repeat(64),
    });
    const tip = writeCvReceipt(fixture.root, recheck, fixture.cvReceiptDigest);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: tip,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/previous_failure_signature does not match CV_REPAIR/);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('rejects a final CV_PASS not bound to the complete Worker Receipt chain tip', () => {
    // The CV envelope is bound to T01 while the persisted Worker chain tip is
    // T02 — the commit admission must fail even though the CV fact itself is a
    // valid PASS for a Worker Receipt that exists in the chain.
    const fixture = prepareMultiTask({ completeTasks: 2 });
    const tasks = readReceiptCategory({
      projectRoot: fixture.root,
      category: 'tasks',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts;
    const t01 = tasks.find((entry) => entry.receipt.payload.task_id === 'S04-A-T01')?.receipt;
    expect(t01).toBeDefined();
    const pass = makeCvEnvelope({
      ...fixture,
      workerReceiptDigest: t01?.digest as string,
      contextRef: t01?.payload.context_ref as string,
      contextDigest: t01?.payload.context_digest as string,
    }, {});
    const tip = replaceCvChain(fixture.root, [{ envelope: pass }]);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha as string,
      cvReceiptDigest: tip,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/latest CV_PASS is not bound to the current complete Worker Receipt chain/);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });

  it('rejects staged index changes at the clean committed boundary', () => {
    // The clean-boundary check covers the index as well as the worktree:
    // a staged-but-uncommitted change must fail closed just like a dirty tree.
    const fixture = prepare();
    fs.appendFileSync(path.join(fixture.root, 'packages/worker-test.ts'), 'staged\n', 'utf8');
    execFileSync('git', ['-C', fixture.root, 'add', 'packages/worker-test.ts']);
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: git(fixture.root, ['rev-parse', 'HEAD']),
      cvReceiptDigest: fixture.cvReceiptDigest,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/requires a clean committed boundary/);
    expect(readReceiptCategory({
      projectRoot: fixture.root,
      category: 'committer',
      stageId: 'S04',
      sliceId: 'S04-A',
    }).receipts).toHaveLength(0);
  });
});

describe('S09-C-T03 — Slice Commit admission rejects legacy stage labels before any read/write', () => {
  it('rejects a Slice Commit request whose stageId is the parked S08B0 label', () => {
    expect(() =>
      validateVNextSliceCommitRequest({
        type: 'slice_commit',
        stageId: 'S08B0',
        sliceId: 'S08-C',
        commitSha: 'a'.repeat(40),
        cvReceiptDigest: 'b'.repeat(64),
      }),
    ).toThrowError(/canonical Stage ID/);
  });

  it('rejects a Slice Commit request whose stageId is the parked S08B label', () => {
    expect(() =>
      validateVNextSliceCommitRequest({
        type: 'slice_commit',
        stageId: 'S08B',
        sliceId: 'S08-C',
        commitSha: 'a'.repeat(40),
        cvReceiptDigest: 'b'.repeat(64),
      }),
    ).toThrowError(/canonical Stage ID/);
  });
});
