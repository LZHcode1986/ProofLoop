import type {} from 'node:fs';

/**
 * A real vNext slice-output fixture.
 *
 * The fixture uses Runtime APIs for compilation, Evidence, Stage Plan,
 * Context, Worker and CV admission.  Only the two Git boundaries are driven
 * through the public proofloop child process.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const runtime = require('../dist/index.js');

const STAGE_ID = 'S01';
const SLICE_ID = 'S01-A';
const TASK_ID = 'S01-A-T01';
const TASKS_PATH = `delivery/stages/${STAGE_ID}/tasks.md`;
const EVIDENCE_PATH = `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`;
const SOURCE_PATH = `delivery/stages/${STAGE_ID}/src/impl.ts`;
const TEST_PATH = `delivery/stages/${STAGE_ID}/test/impl.test.ts`;
const CANDIDATE_PATH = '.proofloop/candidate.json';
const MANIFEST_RELATIVE_PATH = `.proofloop/manifests/${STAGE_ID}.json`;
const PUBLIC_CLI_PATH = path.resolve(__dirname, '../dist/cli/proofloop.js');

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return relative;
}

function entityRef(entityId: string): string {
  return `${TASKS_PATH}#/entities/${entityId}`;
}

function tasksMarkdown(): string {
  return `# Stage ${STAGE_ID}

<!-- proofloop:entity id="${STAGE_ID}-goal" kind="goal" -->
Stage goal: prove the public slice boundary recipe with real Runtime facts.

## Slice ${SLICE_ID}

<!-- proofloop:entity id="${SLICE_ID}-goal" kind="goal" -->
Slice goal: implement and verify one bounded implementation task.

<!-- proofloop:entity id="${TASK_ID}" kind="task" -->
Task goal: implement the fixture implementation and its verification boundary.

<!-- proofloop:entity id="${SLICE_ID}-A01" kind="acceptance" -->
Acceptance: the implementation returns the expected value.

<!-- proofloop:entity id="${SLICE_ID}-S01" kind="seam" -->
Seam: the public boundary CLI creates the Slice commit.

<!-- proofloop:entity id="${SLICE_ID}-O01" kind="oracle" -->
Oracle: Runtime admission and the final committer Receipt are canonical.

<!-- proofloop:entity id="${SLICE_ID}-R01" kind="risk" -->
Risk: a dirty or out-of-scope file must not enter the Slice boundary.

- [ ] ${TASK_ID}
- Worker Status: \`NOT_STARTED\`
`;
}

function candidateInput(root: string): Record<string, any> {
  const sourceScope = {
    kind: 'implementation',
    code_paths: [`delivery/stages/${STAGE_ID}/src`],
    test_paths: [`delivery/stages/${STAGE_ID}/test`],
    forbidden_paths: [],
  };
  return {
    schema_version: 2,
    mode: 'initial',
    caller: 'brain',
    owner: 'pluginv2-active-plan-materializer',
    project_root: root,
    stage_id: STAGE_ID,
    candidate_plan_path: TASKS_PATH,
    selected_work_item_refs: [entityRef(TASK_ID)],
    authority_entity_refs: [entityRef(`${STAGE_ID}-goal`)],
    existing_plan_ref: null,
    finding_refs: [],
    stage_goal: {
      entity_id: `${STAGE_ID}-goal`,
      ref_id: 'REF-G01',
      goal: 'Prove the public slice boundary recipe with real Runtime facts.',
      refs: ['REF-G02'],
    },
    dependencies: [],
    constraints: [],
    out_of_scope: [],
    reference_index: [
      { ref_id: 'REF-G01', kind: 'goal', ref: entityRef(`${STAGE_ID}-goal`) },
      { ref_id: 'REF-G02', kind: 'goal', ref: entityRef(`${SLICE_ID}-goal`) },
      { ref_id: 'REF-T01', kind: 'task', ref: entityRef(TASK_ID) },
      { ref_id: 'REF-A01', kind: 'acceptance', ref: entityRef(`${SLICE_ID}-A01`) },
      { ref_id: 'REF-S01', kind: 'seam', ref: entityRef(`${SLICE_ID}-S01`) },
      { ref_id: 'REF-O01', kind: 'oracle', ref: entityRef(`${SLICE_ID}-O01`) },
      { ref_id: 'REF-R01', kind: 'risk', ref: entityRef(`${SLICE_ID}-R01`) },
    ],
    slices: [
      {
        slice_id: SLICE_ID,
        goal_entity_id: `${SLICE_ID}-goal`,
        goal: 'Implement and verify one bounded implementation task.',
        proof_index: {
          slice_id: SLICE_ID,
          goal_ref: 'REF-G02',
          task_refs: ['REF-T01'],
          acceptance_refs: ['REF-A01'],
          seam_refs: ['REF-S01'],
          oracle_refs: ['REF-O01'],
          risk_refs: [
            {
              ref_id: 'REF-R01',
              applies_to_acceptance_refs: ['REF-A01'],
              applies_to_seam_refs: ['REF-S01'],
            },
          ],
        },
        dependencies: [],
        required_skills: [],
        evidence_path: EVIDENCE_PATH,
        tasks: [
          {
            task_id: TASK_ID,
            entity_id: TASK_ID,
            goal: 'Implement the fixture implementation and its verification boundary.',
            refs: ['REF-T01'],
            dependencies: [],
            required_skills: [],
            execution_scope: sourceScope,
            checkbox: false,
            status: 'NOT_STARTED',
            cv_status: 'NOT_RUN',
          },
        ],
      },
    ],
  };
}

function mustAccepted(label: string, value: any): any {
  if (!value || value.accepted !== true) {
    throw new Error(`${label} was not accepted: ${JSON.stringify(value)}`);
  }
  return value;
}

function mustOk(label: string, envelope: any): any {
  if (!envelope || envelope.ok !== true) {
    throw new Error(`${label} was not successful: ${JSON.stringify(envelope)}`);
  }
  return envelope;
}

function runFixtureTest(root: string): { status: number | null; output: string } {
  const child = spawnSync(process.execPath, [TEST_PATH], {
    cwd: root,
    encoding: 'utf8',
  });
  if (child.error) throw child.error;
  return {
    status: child.status,
    output: `${String(child.stdout ?? '')}${String(child.stderr ?? '')}`,
  };
}

function finalEvidence(skeleton: string, baselineHead: string): string {
  const task = `### ${TASK_ID}
- Task Goal: implement the fixture implementation and its verification boundary.
- Relevant PO IDs: REF-A01, REF-S01, REF-O01
- Source Snapshot: ${baselineHead}
- Current Snapshot: ${baselineHead}
- Changed Files: ${SOURCE_PATH}
- RED Receipt:
  - Test ID: fixture-red
  - Command: fixture assertion before implementation
  - Failure Output: expected implementation value was not present
  - Expected Failure: implementation is not yet complete
  - Snapshot: ${baselineHead}
- GREEN Receipt:
  - Test ID: fixture-green
  - Command: fixture assertion after implementation
  - Pass Output: implementation returned the expected value
  - Snapshot: ${baselineHead}
- Status: COMPLETE`;
  const marker = '## Task Evidence\n\n*Not yet captured.*';
  if (!skeleton.includes(marker)) throw new Error('Evidence initializer did not emit the expected Task Evidence skeleton');
  return skeleton.replace(marker, `## Task Evidence\n\n${task}`);
}

/** Run the public CLI from the fixture root and parse its one-line envelope. */
function runPublicCli(root: string, positionals: string[], request: Record<string, any>): any {
  const input = JSON.stringify({ domain: positionals[0], operation: positionals[1], ...request });
  const child = spawnSync(
    process.execPath,
    [PUBLIC_CLI_PATH, ...positionals, '--project-root', root, '--json', input],
    { cwd: root, encoding: 'utf8' },
  );
  if (child.error) throw child.error;
  const stdout = String(child.stdout ?? '').trim();
  const lines = stdout.length === 0 ? [] : stdout.split(/\r?\n/);
  if (lines.length !== 1) {
    throw new Error(`public CLI did not emit exactly one envelope line (status=${child.status}): ${stdout}\n${child.stderr ?? ''}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`public CLI emitted non-JSON output: ${stdout}\n${error}`);
  }
  if (
    envelope.schema_version !== 2 ||
    typeof envelope.ok !== 'boolean' ||
    !envelope.command ||
    !Array.isArray(envelope.findings) ||
    !Array.isArray(envelope.refs) ||
    !envelope.runtime
  ) {
    throw new Error(`public CLI emitted a non-canonical envelope: ${stdout}`);
  }
  if (child.status !== 0) {
    throw new Error(`public CLI failed with status ${child.status}: ${stdout}\n${child.stderr ?? ''}`);
  }
  return envelope;
}

/**
 * Build and run the complete fixture.  The returned cleanup function removes
 * the throwaway repository after the caller has inspected the final Receipt.
 */
function buildSliceBoundaryFixture(): any {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-slice-boundary-'));
  try {
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'ProofLoop Fixture']);
    git(root, ['config', 'user.email', 'proofloop-fixture@example.invalid']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    write(root, '.gitignore', '.proofloop/\n');
    write(root, TASKS_PATH, tasksMarkdown());
    write(root, SOURCE_PATH, 'export function answer(): number { return 1; }\n');
    write(root, TEST_PATH, `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer } from '../src/impl.ts';

test('fixture implementation', () => assert.equal(answer(), 2));
`);
    write(root, CANDIDATE_PATH, `${JSON.stringify(candidateInput(root), null, 2)}\n`);

    const compile = runtime.compileVNextPlan({
      projectRoot: root,
      candidateInputPath: CANDIDATE_PATH,
      manifestPath: MANIFEST_RELATIVE_PATH,
    });
    if (compile.success !== true || compile.manifest_path === null || compile.manifest_digest === null) {
      throw new Error(`compileVNextPlan failed: ${JSON.stringify(compile)}`);
    }
    const manifestPath = compile.manifest_path;
    const manifestDigest = compile.manifest_digest;
    const manifest = runtime.readVNextManifest(root, manifestPath);
    const composition = runtime.auditVNextStageComposition(manifest);
    if (composition.closure_valid !== true) {
      throw new Error(`auditVNextStageComposition failed: ${JSON.stringify(composition)}`);
    }

    const initialized = runtime.initializeVNextPlanEvidence(manifestPath, undefined, root);
    if (initialized.success !== true || initialized.initialized.length !== 1) {
      throw new Error(`initializeVNextPlanEvidence failed: ${JSON.stringify(initialized)}`);
    }

    // This is the stable planning boundary.  The candidate and Manifest are
    // under ignored .proofloop/, while tasks.md, Evidence, code and test are
    // real committed baseline files.
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'fixture: stable vNext slice baseline']);
    const snapshotDigest = git(root, ['rev-parse', 'HEAD']);
    for (const relative of [TASKS_PATH, EVIDENCE_PATH, SOURCE_PATH, TEST_PATH]) {
      if (!fs.existsSync(path.join(root, relative))) {
        throw new Error(`stable baseline is missing ${relative}`);
      }
    }
    const red = runFixtureTest(root);
    if (red.status === 0) {
      throw new Error(`baseline fixture test unexpectedly passed: ${red.output}`);
    }

    const spvWithoutDigest = {
      version: 2,
      schema_version: 2,
      type: 'SPV_PASS',
      stage_id: STAGE_ID,
      manifest_digest: manifestDigest,
      plan_digest: manifest.plan.plan_digest,
      snapshot_digest: snapshotDigest,
    };
    const spv = {
      ...spvWithoutDigest,
      digest: runtime.computeVNextSpvPassReceiptDigest(spvWithoutDigest),
    };
    const stagePlan = mustAccepted('admitVNextStagePlan', runtime.admitVNextStagePlan({
      version: 2,
      schema_version: 2,
      type: 'STAGE_PLAN_ADMISSION',
      project_root: root,
      manifest_path: manifestPath,
      stage_id: STAGE_ID,
      manifest_digest: manifestDigest,
      plan_digest: manifest.plan.plan_digest,
      snapshot_digest: snapshotDigest,
      spv,
    }));

    const dispatch = runtime.projectVNextWorkerDispatch({
      root,
      manifest,
      manifestDigest,
      snapshotDigest,
      authority: { stagePlan: stagePlan.stage_plan, spv: stagePlan.spv },
      completedTaskIds: [],
      mode: 'implement-task',
      sliceId: SLICE_ID,
      verifyReferenceBindings: true,
    });
    runtime.persistVNextWorkerContext(root, dispatch);

    // Simulated Worker output.  All files named by the Worker existed in the
    // committed baseline before this mutation.
    write(root, SOURCE_PATH, 'export function answer(): number { return 2; }\n');
    const baselineTasks = fs.readFileSync(path.join(root, TASKS_PATH), 'utf8');
    write(
      root,
      TASKS_PATH,
      baselineTasks
        .replace(`- [ ] ${TASK_ID}`, `- [x] ${TASK_ID}`)
        .replace('- Worker Status: `NOT_STARTED`', '- Worker Status: `executing`'),
    );
    const skeleton = fs.readFileSync(path.join(root, EVIDENCE_PATH), 'utf8');
    write(root, EVIDENCE_PATH, finalEvidence(skeleton, snapshotDigest));
    const green = runFixtureTest(root);
    if (green.status !== 0) {
      throw new Error(`worker fixture test failed: ${green.output}`);
    }

    const proof = manifest.slices[0].proof_index;
    const worker = mustAccepted('admitVNextWorkerResult', runtime.admitVNextWorkerResult({
      schemaVersion: 2,
      actionToken: 'slice-boundary-e2e-worker',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      taskId: TASK_ID,
      mode: 'implement-task',
      outcome: 'completed',
      evidenceRef: EVIDENCE_PATH,
      changedFiles: [SOURCE_PATH, EVIDENCE_PATH, TASKS_PATH],
      verificationRuns: [
        { commandId: 'fixture-green', exitCode: 0, logRef: 'fixture-green.log' },
      ],
      summary: 'Implemented answer and verified the bounded fixture output.',
      manifestDigest: manifestDigest,
      planDigest: manifest.plan.plan_digest,
      proofIndexDigest: dispatch.proof_index_digest,
      snapshotDigest,
      contextRef: dispatch.context_ref,
      contextDigest: dispatch.context.context_digest,
    }, { projectRoot: root }));

    const cv = mustAccepted('admitVNextCVResult', runtime.admitVNextCVResult({
      schema_version: 2,
      type: 'CV_RESULT',
      stage_id: STAGE_ID,
      slice_id: SLICE_ID,
      worker_receipt_digest: worker.receipt_ref,
      manifest_digest: manifestDigest,
      plan_digest: manifest.plan.plan_digest,
      proof_index_digest: dispatch.proof_index_digest,
      context_ref: dispatch.context_ref,
      context_digest: dispatch.context.context_digest,
      snapshot_digest: snapshotDigest,
      verification_type: 'initial',
      verdict: 'PASS',
      summary: 'Acceptance, seam, oracle and risk bindings passed.',
      acceptance_refs_checked: [...proof.acceptance_refs],
      seam_refs_checked: [...proof.seam_refs],
      oracle_refs_checked: [...proof.oracle_refs],
      risk_refs_considered: proof.risk_refs.map((risk: any) => ({
        ref_id: risk.ref_id,
        applicability: 'APPLICABLE',
        reason: 'The fixture exercises this boundary risk explicitly.',
      })),
      failed_acceptance_refs: [],
      invalid_tests: [],
      counterexamples: [],
      scope_violations: [],
      forbidden_substitutions: [],
      regression_failures: [],
    }, { projectRoot: root }));

    const boundary = mustOk('boundary close', runPublicCli(root, ['boundary', 'close'], {
      boundary_type: 'slice-output',
      expected_head: snapshotDigest,
      stage: STAGE_ID,
      slice: SLICE_ID,
      manifest_digest: manifestDigest,
      cv_receipt_digest: cv.receipt_ref,
      description: 'fixture slice output boundary',
    }));
    const commitSha = boundary.result.commit_sha;
    if (typeof commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(commitSha)) {
      throw new Error(`boundary close did not return a commit SHA: ${JSON.stringify(boundary)}`);
    }

    const stageCommit = mustOk('stage admit-slice-commit', runPublicCli(root, ['stage', 'admit-slice-commit'], {
      stage: STAGE_ID,
      slice: SLICE_ID,
      commit_sha: commitSha,
      cv_receipt_digest: cv.receipt_ref,
    }));
    const committerRef = stageCommit.refs[0];
    if (!committerRef || typeof committerRef.ref !== 'string' || typeof committerRef.digest !== 'string') {
      throw new Error(`stage admit-slice-commit did not return a Receipt ref: ${JSON.stringify(stageCommit)}`);
    }
    const committerPath = path.join(root, committerRef.ref);
    const committerReceipt = JSON.parse(fs.readFileSync(committerPath, 'utf8'));

    return {
      root,
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      taskId: TASK_ID,
      tasksPath: TASKS_PATH,
      evidencePath: EVIDENCE_PATH,
      sourcePath: SOURCE_PATH,
      testPath: TEST_PATH,
      manifestPath,
      manifestDigest,
      planDigest: manifest.plan.plan_digest,
      snapshotDigest,
      composition,
      compile,
      initialized,
      stagePlan,
      dispatch,
      worker,
      cv,
      boundary,
      stageCommit,
      committerRef,
      committerPath,
      committerReceipt,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { buildSliceBoundaryFixture };
