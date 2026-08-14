/**
 * S08-C-T04 — restart recovery: after an OpenCode restart the canonical
 * next/context is re-projected ONLY from Git, Manifest and Receipts, never
 * from session, progress or Worker narrative files.
 * Task Ref: REF-S08-C-T04
 *
 * The real S08 candidate is admitted; S08-A and S08-B are advanced past a
 * Slice Commit Git boundary; S08-C-T01..T03 are completed with persisted
 * TASK_COMPLETE facts. A restart is a FRESH `nextActionFromInput` call (the
 * vNext consumer is stateless), and it must re-project S08-C-T04 with the
 * identical canonical digest-bound Context. A narrative claim in Evidence can
 * never substitute for a Receipt, and a broken persisted Receipt chain fails
 * closed to bounded VALIDATE without persisting any new Context authority.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeDigest, computeVNextSpvPassReceiptDigest, writeReceipt, type VNextManifest } from '@proofloop/kernel';
import { admitVNextStagePlan, resolveVNextReference } from '../vnext';
import type { VNextNextActionOutput, CompileVNextManifestInput } from '../vnext';
import { nextActionFromInput } from './next-action';
import { compileVNextManifestCli } from './compile-vnext-manifest';
import { initializeVNextSliceEvidence } from './initialize-vnext-slice-evidence';
import { renderVNextEvidenceSkeleton } from './vnext-cli-support-vnext';
import { refreshVNextSliceEvidence, REFRESH_JOURNAL_FILE } from '../vnext/evidence-refresh';

const repo = path.resolve(__dirname, '../../../..');
const cleanups: string[] = [];
afterEach(() => {
  for (const root of cleanups.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function gitHead(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function copyFixtureFile(root: string, relative: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), target);
}

/** Real S08 candidate files mirrored into the temp worktree. */
const S08_REAL_FILES: readonly string[] = [
  'delivery/stages/S08/tasks.md',
  '.proofloop/manifests/S08.json',
  'delivery/stages/S08/evidence/S08-A.md',
  'delivery/stages/S08/evidence/S08-B.md',
  'delivery/stages/S08/evidence/S08-C.md',
  'delivery/stages/S08/evidence/S08-D.md',
  'delivery/stages/S08/evidence/S08-E.md',
  'delivery/stages/S0-A/tasks.md',
  'tech-spec/task-acceptance-matrix.md',
  'tech-spec/contract-state-matrix.md',
  'tech-spec/ai-coding-architecture.md',
  'tech-spec/hard-parts-register.md',
];

/** The in-scope code file each fixture Task touches as its Worker change. */
const SCOPE_FILE_BY_TASK: Record<string, string> = {
  'S08-A-T01': 'packages/opencode-plugin/src/tools/plan-status.ts',
  'S08-A-T02': 'packages/runtime/src/vnext/next.ts',
  'S08-A-T03': 'packages/opencode-plugin/src/tools/review.ts',
  'S08-B-T01': 'packages/runtime/src/vnext/admission.ts',
  'S08-B-T02': 'packages/runtime/src/vnext/dispatch.ts',
  'S08-B-T03': 'packages/runtime/src/vnext/admission.ts',
  'S08-C-T01': 'packages/runtime/src/vnext/next.ts',
  'S08-C-T02': 'packages/runtime/src/vnext/dispatch.ts',
  'S08-C-T03': 'packages/runtime/src/vnext/next.ts',
};

interface S08RestartChain {
  readonly root: string;
  readonly snapshotDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  /** Absolute path of every persisted TASK_COMPLETE receipt by task id. */
  readonly taskReceiptPaths: Record<string, string>;
}

/**
 * Rebind every Manifest reference to the fixture's copied authority files.
 * The archived S08 Manifest records compile-time (2026-08-05) file/section
 * digests, but the fixture mirrors the CURRENT repo files (with local
 * checkbox resets), so admission would fail closed on digest mismatch.
 * Recompute both digests per reference against the fixture root with the
 * same resolver the compiler uses — the fixture keeps its "real S08
 * candidate shape" while staying self-consistent (the archived repo
 * Manifest is never touched).
 */
function rebindS08ReferenceDigests(root: string): void {
  const manifestPath = path.join(root, '.proofloop/manifests/S08.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Build the admitted S08 chain through the CLI seam: S08-A and S08-B are
 * closed by a Slice Commit execution Git boundary, and S08-C-T01..T03 carry
 * admitted TASK_COMPLETE facts. Only Git / Manifest / Receipts are persisted;
 * no session / progress / narrative file is ever created.
 */
function buildS08RestartChain(): S08RestartChain {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-restart-s08-'));
  cleanups.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-restart-s08@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Restart S08 Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  for (const relative of S08_REAL_FILES) copyFixtureFile(root, relative);
  // The fixture represents the pre-T04 execution state: the pending Task's
  // checkbox stays unchecked so the restart projects implement-task (a
  // checked box without an admitted Receipt is the recover discriminator).
  // Every S08-A/S08-B/S08-C task this fixture completes is also un-checked
  // first, so completing it really modifies the Plan projection (the entity
  // resolver normalizes checkbox state, so the admitted Manifest file/section
  // digests stay stable) and the Slice Commit Git boundary really contains
  // tasks.md — the S08-REVIEW-005 commit-diff cross-validation compares the
  // actual parent..commit file set against the declared changed_files.
  const fixtureTasksPath = path.join(root, 'delivery/stages/S08/tasks.md');
  const uncheckedTasks = [
    'S08-A-T01', 'S08-A-T02', 'S08-A-T03',
    'S08-B-T01', 'S08-B-T02', 'S08-B-T03',
    'S08-C-T01', 'S08-C-T02', 'S08-C-T03', 'S08-C-T04',
  ];
  let fixturePlanText = fs.readFileSync(fixtureTasksPath, 'utf8');
  for (const taskId of uncheckedTasks) {
    fixturePlanText = fixturePlanText.replace(`- [x] ${taskId}`, `- [ ] ${taskId}`);
  }
  fs.writeFileSync(fixtureTasksPath, fixturePlanText, 'utf8');
  rebindS08ReferenceDigests(root);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'S08 candidate boundary']);
  const snapshotDigest = gitHead(root);

  const manifestPath = path.join(root, '.proofloop/manifests/S08.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    plan: { plan_digest: string };
    slices: Array<{ slice_id: string; proof_index: unknown; evidence_path: string }>;
  };
  const manifestDigest = computeDigest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: 'S08',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: snapshotDigest,
  };
  const admitted = admitVNextStagePlan({
    version: 2 as const,
    schema_version: 2 as const,
    type: 'STAGE_PLAN_ADMISSION' as const,
    project_root: root,
    manifest_path: '.proofloop/manifests/S08.json',
    stage_id: 'S08',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: snapshotDigest,
    spv: { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) },
  });
  if (!admitted.accepted) throw new Error(admitted.findings[0]?.message ?? 'Stage Plan admission failed');

  const taskReceiptPaths: Record<string, string> = {};
  const chain: Array<{ sliceId: string; tasks: string[]; commit: boolean }> = [
    { sliceId: 'S08-A', tasks: ['S08-A-T01', 'S08-A-T02', 'S08-A-T03'], commit: true },
    { sliceId: 'S08-B', tasks: ['S08-B-T01', 'S08-B-T02', 'S08-B-T03'], commit: true },
    { sliceId: 'S08-C', tasks: ['S08-C-T01', 'S08-C-T02', 'S08-C-T03'], commit: false },
  ];
  let tick = 0;
  const timestamp = (): string => `2026-08-07T00:00:${String(tick++).padStart(2, '0')}.000Z`;
  for (const { sliceId, tasks, commit } of chain) {
    const slice = manifest.slices.find((candidate) => candidate.slice_id === sliceId);
    if (slice === undefined) throw new Error(`Slice ${sliceId} is unavailable`);
    const proofIndexDigest = computeDigest(slice.proof_index);
    const sliceChangedFiles: string[] = [];
    for (const taskId of tasks) {
      const output = nextActionFromInput({
        project_root: root,
        stage_id: 'S08',
        manifest_path: '.proofloop/manifests/S08.json',
        snapshot_digest: snapshotDigest,
      }) as VNextNextActionOutput;
      if (
        output.action !== 'DISPATCH_WORKER' ||
        output.task_id !== taskId ||
        output.context_ref === undefined ||
        output.mode === undefined
      ) {
        throw new Error(`expected DISPATCH_WORKER ${taskId}, got ${output.action} ${String(output.task_id)}`);
      }
      const context = JSON.parse(fs.readFileSync(path.join(root, output.context_ref), 'utf8')) as {
        context_digest: string;
      };
      const scopeFile = SCOPE_FILE_BY_TASK[taskId];
      fs.mkdirSync(path.dirname(path.join(root, scopeFile)), { recursive: true });
      fs.appendFileSync(path.join(root, scopeFile), `// worker change for ${taskId}\n`, 'utf8');
      fs.appendFileSync(path.join(root, slice.evidence_path), `\nworker evidence for ${taskId}\n`, 'utf8');
      // Checking the Task checkbox really modifies the Plan projection; the
      // entity resolver normalizes checkbox state away, so the admitted
      // Manifest digests stay stable (S08-REVIEW-005 commit-diff match).
      const planProjection = path.join(root, 'delivery/stages/S08/tasks.md');
      const planText = fs.readFileSync(planProjection, 'utf8');
      if (planText.includes(`- [ ] ${taskId}`)) {
        fs.writeFileSync(
          planProjection,
          planText.replace(`- [ ] ${taskId}`, `- [x] ${taskId}`),
          'utf8',
        );
      }
      const changedFiles = [slice.evidence_path, 'delivery/stages/S08/tasks.md', scopeFile];
      sliceChangedFiles.push(...changedFiles);
      const receiptDir = path.join(root, '.proofloop/receipts/tasks/S08', sliceId);
      fs.mkdirSync(receiptDir, { recursive: true });
      const written = writeReceipt(
        {
          version: 1,
          type: 'TASK_COMPLETE',
          stage_id: 'S08',
          slice_id: sliceId,
          timestamp: timestamp(),
          payload: {
            schema_version: 2,
            action_token: `restart-${taskId}`,
            mode: output.mode,
            outcome: 'completed',
            task_id: taskId,
            evidence_ref: slice.evidence_path,
            changed_files: changedFiles,
            verification_runs: [],
            summary: 'restart fixture task',
            manifest_digest: manifestDigest,
            plan_digest: manifest.plan.plan_digest,
            proof_index_digest: proofIndexDigest,
            snapshot_digest: snapshotDigest,
            context_ref: output.context_ref,
            context_digest: context.context_digest,
          },
        },
        { receiptDir, tempDir: receiptDir },
      );
      taskReceiptPaths[taskId] = written.path;
    }
    if (commit) {
      // S08-REVIEW-004: the SLICE_COMMIT must be backed by a persisted
      // CV_PASS tip; write the CV fact first and bind the commit to it.
      const lastTaskId = tasks[tasks.length - 1] as string;
      const lastReceipt = JSON.parse(fs.readFileSync(taskReceiptPaths[lastTaskId], 'utf8')) as {
        digest: string;
        payload: { context_ref: string; context_digest: string };
      };
      const proofIndex = slice.proof_index as {
        acceptance_refs: string[];
        seam_refs: string[];
        oracle_refs: string[];
        risk_refs: Array<{ ref_id: string }>;
      };
      const cvDir = path.join(root, '.proofloop/receipts/cv/S08', sliceId);
      fs.mkdirSync(cvDir, { recursive: true });
      const cvWritten = writeReceipt(
        {
          version: 1,
          type: 'CV_PASS',
          stage_id: 'S08',
          slice_id: sliceId,
          timestamp: timestamp(),
          payload: {
            schema_version: 2,
            type: 'CV_RESULT',
            stage_id: 'S08',
            slice_id: sliceId,
            worker_receipt_digest: lastReceipt.digest,
            manifest_digest: manifestDigest,
            plan_digest: manifest.plan.plan_digest,
            proof_index_digest: proofIndexDigest,
            context_ref: lastReceipt.payload.context_ref,
            context_digest: lastReceipt.payload.context_digest,
            snapshot_digest: snapshotDigest,
            verification_type: 'initial',
            verdict: 'PASS',
            summary: 'restart fixture CV',
            acceptance_refs_checked: [...proofIndex.acceptance_refs],
            seam_refs_checked: [...proofIndex.seam_refs],
            oracle_refs_checked: [...proofIndex.oracle_refs],
            risk_refs_considered: proofIndex.risk_refs.map((risk) => ({
              ref_id: risk.ref_id,
              applicability: 'APPLICABLE',
              reason: 'restart fixture binding',
            })),
            failed_acceptance_refs: [],
            invalid_tests: [],
            counterexamples: [],
            scope_violations: [],
            forbidden_substitutions: [],
            regression_failures: [],
          },
        },
        { receiptDir: cvDir, tempDir: cvDir },
      );
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', `${sliceId} execution boundary`]);
      const committedHead = gitHead(root);
      const committerDir = path.join(root, '.proofloop/receipts/committer/S08', sliceId);
      fs.mkdirSync(committerDir, { recursive: true });
      writeReceipt(
        {
          version: 1,
          type: 'SLICE_COMMIT',
          stage_id: 'S08',
          slice_id: sliceId,
          timestamp: timestamp(),
          payload: {
            schema_version: 2,
            type: 'SLICE_COMMIT_RESULT',
            action: 'SLICE_COMMIT',
            stage_id: 'S08',
            slice_id: sliceId,
            manifest_digest: manifestDigest,
            plan_digest: manifest.plan.plan_digest,
            proof_index_digest: proofIndexDigest,
            snapshot_digest: committedHead,
            commit_sha: committedHead,
            cv_receipt_digest: cvWritten.digest,
            changed_files: sliceChangedFiles,
            receipt_chain_valid: true,
          },
        },
        { receiptDir: committerDir, tempDir: committerDir },
      );
    }
  }
  return { root, snapshotDigest, manifestDigest, planDigest: manifest.plan.plan_digest, taskReceiptPaths };
}

/** Walk the persisted fixture and report any session/progress/narrative path. */
function findSessionLikePaths(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.proofloop') continue;
      const full = path.join(dir, entry.name);
      if (/session|progress|narrative/i.test(entry.name)) found.push(path.relative(root, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return found;
}

function restartInput(root: string, admittedSnapshot: string): Record<string, string> {
  return {
    project_root: root,
    stage_id: 'S08',
    manifest_path: '.proofloop/manifests/S08.json',
    // The authority binds the admitted snapshot; the current HEAD is a legal
    // descendant (Slice Commit execution boundaries) and stays on its chain.
    snapshot_digest: admittedSnapshot,
  };
}

describe('vNext restart recovery re-projection (S08-C-T04)', () => {
  it('re-projects the canonical next/context after an OpenCode restart from Git, Manifest and Receipts only', () => {
    const chain = buildS08RestartChain();
    // The persisted fixture contains no session/progress/narrative state: the
    // only facts are the Git boundary, the admitted Manifest/Plan authorities
    // and the Receipt chain (the .proofloop artifacts are excluded from this
    // walk and are themselves digest-bound persisted facts).
    expect(findSessionLikePaths(chain.root)).toEqual([]);

    // OpenCode restart: a FRESH CLI consumer call re-projects the canonical
    // next/context exclusively from the persisted facts.
    const restart = nextActionFromInput(restartInput(chain.root, chain.snapshotDigest)) as VNextNextActionOutput;
    expect(restart.action).toBe('DISPATCH_WORKER');
    expect(restart.slice_id).toBe('S08-C');
    expect(restart.task_id).toBe('S08-C-T04');
    expect(restart.mode).toBe('implement-task');
    expect(restart.receipt_chain_valid).toBe(true);
    expect(restart.manifest_digest).toBe(chain.manifestDigest);
    expect(restart.plan_digest).toBe(chain.planDigest);
    expect(restart.snapshot_digest).toBe(chain.snapshotDigest);
    // Digest-bound ContextRef: the persisted Context exists and its content
    // digest equals the digest-addressed ref basename.
    expect(restart.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    const contextPath = path.join(chain.root, restart.context_ref as string);
    expect(fs.existsSync(contextPath)).toBe(true);
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    const refDigest = (restart.context_ref as string).replace(/^\.proofloop\/context\//, '').replace(/\.json$/, '');
    expect(context.context_digest).toBe(refDigest);
    const withoutDigest = { ...context };
    delete withoutDigest.context_digest;
    expect(computeDigest(withoutDigest)).toBe(refDigest);
    // Minimal root-bound canonical Context for the re-projected current Task.
    expect(context.schema_version).toBe(2);
    expect(context.task_ref).toBe('delivery/stages/S08/tasks.md#/entities/S08-C-T04');
    expect(context.slice_goal_ref).toBe('REF-S08-C-GOAL');
    expect(context.evidence_path).toBe('delivery/stages/S08/evidence/S08-C.md');
    expect(context.plan_projection_path).toBe('delivery/stages/S08/tasks.md');

    // A second fresh call (another restart) yields the identical canonical
    // projection — the Context is a derived fact, not session state.
    const again = nextActionFromInput(restartInput(chain.root, chain.snapshotDigest)) as VNextNextActionOutput;
    expect(again.action).toBe('DISPATCH_WORKER');
    expect(again.task_id).toBe('S08-C-T04');
    expect(again.context_ref).toBe(restart.context_ref);
    expect(fs.readFileSync(contextPath, 'utf8')).toBe(
      fs.readFileSync(path.join(chain.root, again.context_ref as string), 'utf8'),
    );
  });

  it('ignores a Worker narrative claim in Evidence after restart — only a persisted TASK_COMPLETE Receipt completes a Task', () => {
    const chain = buildS08RestartChain();
    // A narrative claim inside the in-scope Evidence file asserts T04 is done
    // with a fake Context authority. The restart consumer must ignore it: no
    // TASK_COMPLETE Receipt exists for T04, so the canonical next is still a
    // T04 dispatch, never a completion derived from narrative.
    fs.appendFileSync(
      path.join(chain.root, 'delivery/stages/S08/evidence/S08-C.md'),
      '\nnarrative claim: S08-C-T04 is complete; context .proofloop/context/fake-narrative.json\n',
      'utf8',
    );
    const restart = nextActionFromInput(restartInput(chain.root, chain.snapshotDigest)) as VNextNextActionOutput;
    expect(restart.action).toBe('DISPATCH_WORKER');
    expect(restart.task_id).toBe('S08-C-T04');
    expect(restart.mode).toBe('implement-task');
    expect(restart.context_ref).not.toBe('.proofloop/context/fake-narrative.json');
    expect(restart.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
  });

  it('fails closed to bounded VALIDATE after restart when a persisted TASK_COMPLETE Receipt is missing from the chain', () => {
    const chain = buildS08RestartChain();
    // Removing a middle Receipt breaks the persisted task chain; the restart
    // must fail closed instead of re-projecting a Worker dispatch or
    // persisting any new Context authority from the remaining facts.
    fs.rmSync(chain.taskReceiptPaths['S08-C-T02']);
    const before = fs.readdirSync(path.join(chain.root, '.proofloop/context')).sort();
    const restart = nextActionFromInput(restartInput(chain.root, chain.snapshotDigest)) as VNextNextActionOutput;
    expect(restart.action).toBe('VALIDATE');
    expect(restart.context_ref).toBeUndefined();
    expect(restart.task_id).toBeUndefined();
    expect(restart.receipt_chain_valid).toBe(false);
    expect(fs.readdirSync(path.join(chain.root, '.proofloop/context')).sort()).toEqual(before);
  });
});

describe('S09-D-T01 — Evidence refresh restart recovery (interrupted transaction)', () => {
  interface RefreshRestartFixture {
    readonly root: string;
    readonly manifestV1: string;
    readonly manifestV2: string;
    readonly evidenceDir: string;
    readonly evidenceA: string;
    readonly digestV1: string;
    readonly digestV2: string;
  }

  function buildInput(root: string, versionMarker: string): CompileVNextManifestInput {
    const refs = [
      '<!-- proofloop:entity id="goal" kind="goal" -->',
      `goal ${versionMarker}`,
      '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
      `task A ${versionMarker}`,
      '<!-- proofloop:entity id="accept" kind="acceptance" -->',
      'acceptance',
      '<!-- proofloop:entity id="seam" kind="seam" -->',
      'seam',
      '<!-- proofloop:entity id="oracle" kind="oracle" -->',
      'oracle',
      '<!-- proofloop:entity id="risk" kind="risk" -->',
      'risk',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'refs.md'), refs, 'utf8');
    const tasks = path.join(root, 'delivery', 'stages', 'S04', 'tasks.md');
    fs.mkdirSync(path.dirname(tasks), { recursive: true });
    fs.writeFileSync(tasks, 'not parsed\n', 'utf8');
    return {
      root,
      stage_id: 'S04',
      plan_path: 'delivery/stages/S04/tasks.md',
      plan: {
        schema_version: 2,
        items: [
          {
            id: 'S04-A-T01',
            kind: 'task',
            goal: `slice A goal ${versionMarker}`,
            refs: ['REF-T'],
            dependencies: [],
            required_skills: [],
            execution_scope: {
              kind: 'implementation',
              code_paths: ['packages/runtime/src/vnext/evidence-refresh.ts'],
              test_paths: ['packages/runtime/src/cli/restart-recovery-vnext.spec.ts'],
              forbidden_paths: ['.proofloop/receipts'],
            },
          },
        ],
      },
      refs: [
        { ref_id: 'REF-G', kind: 'goal', ref: 'refs.md#/entities/goal' },
        { ref_id: 'REF-T', kind: 'task', ref: 'refs.md#/entities/S04-A-T01' },
        { ref_id: 'REF-A', kind: 'acceptance', ref: 'refs.md#/entities/accept' },
        { ref_id: 'REF-S', kind: 'seam', ref: 'refs.md#/entities/seam' },
        { ref_id: 'REF-O', kind: 'oracle', ref: 'refs.md#/entities/oracle' },
        { ref_id: 'REF-R', kind: 'risk', ref: 'refs.md#/entities/risk' },
      ],
      authority_ref_ids: ['REF-A', 'REF-S', 'REF-O'],
      slices: [
        {
          slice_id: 'S04-A',
          proof_index: {
            slice_id: 'S04-A',
            goal_ref: 'REF-G',
            task_refs: ['REF-T'],
            acceptance_refs: ['REF-A'],
            seam_refs: ['REF-S'],
            oracle_refs: ['REF-O'],
            risk_refs: [
              {
                ref_id: 'REF-R',
                applies_to_acceptance_refs: ['REF-A'],
                applies_to_seam_refs: ['REF-S'],
              },
            ],
          },
          required_skills: [],
          depends_on: [],
          evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
        },
      ],
    };
  }

  function makeRefreshRestartFixture(): RefreshRestartFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-refresh-restart-'));
    cleanups.push(root);
    const manifestV1 = path.join(root, 'delivery', 'stages', 'S04', 'manifest-v1.json');
    const manifestV2 = path.join(root, 'delivery', 'stages', 'S04', 'manifest-v2.json');
    const evidenceDir = path.join(root, 'delivery', 'stages', 'S04', 'evidence');
    const requestV1 = path.join(root, 'request-v1.json');
    fs.writeFileSync(requestV1, JSON.stringify(buildInput(root, 'v1')), 'utf8');
    expect(compileVNextManifestCli([requestV1, manifestV1, root])).toBe(0);
    expect(initializeVNextSliceEvidence(manifestV1, evidenceDir, root).success).toBe(true);
    const requestV2 = path.join(root, 'request-v2.json');
    fs.writeFileSync(requestV2, JSON.stringify(buildInput(root, 'v2')), 'utf8');
    expect(compileVNextManifestCli([requestV2, manifestV2, root])).toBe(0);
    return {
      root,
      manifestV1,
      manifestV2,
      evidenceDir,
      evidenceA: path.join(evidenceDir, 'S04-A.md'),
      digestV1: computeDigest(JSON.parse(fs.readFileSync(manifestV1, 'utf8'))),
      digestV2: computeDigest(JSON.parse(fs.readFileSync(manifestV2, 'utf8'))),
    };
  }

  /**
   * Simulate a process interruption mid-transaction: the journal is persisted
   * and the evidence file has ALREADY been swapped to the new binding.  A
   * restart is exactly this on-disk state — the in-memory refresh call that
   * was interrupted is gone and only the journal + files remain.
   */
  function installInterruptedSwap(fx: RefreshRestartFixture): { oldContent: string; newContent: string } {
    const identityOf = (file: string): string => {
      const stat = fs.lstatSync(file);
      return `${stat.dev}:${stat.ino}`;
    };
    const oldContent = fs.readFileSync(fx.evidenceA, 'utf8');
    // The journaled NEW content must be the canonical skeleton rendered for
    // the CURRENT Manifest (Slice S04-A), never a digest-only replacement.
    const manifestV2Value = JSON.parse(fs.readFileSync(fx.manifestV2, 'utf8')) as VNextManifest;
    const newContent = renderVNextEvidenceSkeleton(manifestV2Value, manifestV2Value.slices[0], fx.digestV2);
    // The atomic rename replaced the inode: capture the OLD identity first,
    // then simulate the swap with unlink+create so the identity really
    // changes on disk.
    const oldIdentity = identityOf(fx.evidenceA);
    fs.unlinkSync(fx.evidenceA);
    fs.writeFileSync(fx.evidenceA, newContent, 'utf8');
    const journal = {
      version: 1,
      stage_id: 'S04',
      manifest_ref: 'delivery/stages/S04/tasks.md',
      previous_manifest_digest: fx.digestV1,
      manifest_digest: fx.digestV2,
      files: [{ name: 'S04-A.md', old: oldContent, new: newContent, old_identity: oldIdentity }],
    };
    fs.writeFileSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE), JSON.stringify(journal), 'utf8');
    return { oldContent, newContent };
  }

  it('a fresh refresh after restart returns blocked recovery and changes nothing', () => {
    const fx = makeRefreshRestartFixture();
    const { newContent } = installInterruptedSwap(fx);

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(false);
    expect(result.blocked_recovery).toBe(true);
    expect(result.errors.some((error) => error.type === 'UNRECOVERED_TRANSACTION')).toBe(true);
    // The on-disk state is untouched: no partial update is ever reported as
    // success and no silent continuation happens.
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(newContent);
    expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(true);
  });

  it('recover after restart completes the journaled transaction', () => {
    const fx = makeRefreshRestartFixture();
    const { oldContent, newContent } = installInterruptedSwap(fx);

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'recover',
    });
    expect(result.success).toBe(true);
    expect(result.recovered).toBe(true);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(newContent);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).not.toBe(oldContent);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toContain(`Manifest Digest: ${fx.digestV2}`);
    expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(false);
  });

  it('rollback after restart restores the previous binding', () => {
    const fx = makeRefreshRestartFixture();
    const { oldContent } = installInterruptedSwap(fx);

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'rollback',
    });
    expect(result.success).toBe(true);
    expect(result.rolled_back).toBe(true);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(oldContent);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toContain(`Manifest Digest: ${fx.digestV1}`);
    expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(false);
  });

  it('recovery fails closed when a file matches neither journaled state', () => {
    const fx = makeRefreshRestartFixture();
    const { oldContent } = installInterruptedSwap(fx);
    // A competitor replaced the file with content that is neither old nor new.
    fs.writeFileSync(fx.evidenceA, 'unrelated competitor content\n', 'utf8');

    const recover = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'recover',
    });
    expect(recover.success).toBe(false);
    expect(recover.blocked_recovery).toBe(true);
    expect(recover.errors.some((error) => error.type === 'UNRECOVERABLE_STATE')).toBe(true);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe('unrelated competitor content\n');
    expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(true);

    const rollback = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'rollback',
    });
    expect(rollback.success).toBe(false);
    expect(rollback.blocked_recovery).toBe(true);
    // Nothing was changed and the old binding is not silently restored.
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe('unrelated competitor content\n');
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).not.toBe(oldContent);
    expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(true);
  });
});

// ============================================================
// S10-D-T03 — recovery restart CLI（built public proofloop）
//
// 重启恢复语义（Acceptance E / REF-S08E-RISK persistent_state+concurrency）：
// `proofloop recovery restart --json --stage <id>` 只从本地持久事实
// （Git/Manifest/Receipts/Contexts）重新投影派发状态 —— 复用
// VNextNextActionService.nextAction（persistContext:true，Runtime next seam
// 落盘 Context，handler 不直接写 .proofloop/*）；不重放 Worker 实现；失败
// canonical Finding + no-write。
//
// fixture 是自包含的（refs.md 由 fixture 自己写、compile 产物的 reference
// file_digest 与磁盘自洽，不依赖真实仓库 tech-spec 文件）—— 真实 S08
// fixture 因 authority-update 后 reference digest 漂移属于 pre-existing
// 失败基线（T02 GREEN 已登记），故 restart 语义验证使用本自包含 chain。
// ============================================================

const DIST_PROOFLOOP = path.join(repo, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');

function runRecoveryCliExpectStatus(args: readonly string[], root: string): { status: number; envelope: Record<string, any> } {
  try {
    const out = execFileSync(process.execPath, [DIST_PROOFLOOP, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, envelope: JSON.parse(String(out).trim()) as Record<string, any> };
  } catch (error) {
    const e = error as { status?: number; stdout?: string | Buffer };
    return {
      status: e.status ?? -1,
      envelope: JSON.parse(String(e.stdout ?? '{}').trim()) as Record<string, any>,
    };
  }
}

interface RecoveryRestartChain {
  readonly root: string;
  readonly stageId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly snapshotDigest: string;
  /** 已 admit 完成的第一个 task 的 Receipt 路径。 */
  readonly taskReceiptPaths: Record<string, string>;
  /** 第二个 task 的 checkbox 是否已勾选（true = 勾选但无 receipt → recover-task 判别）。 */
  readonly secondTaskChecked: boolean;
}

/**
 * Build a SELF-CONTAINED admitted restart chain: refs.md / tasks.md /
 * Manifest 全部在临时 fixture 内生成并编译，admission 的 reference
 * file_digest 与磁盘自洽。S04-A-T01 有 admitted TASK_COMPLETE fact（checkbox
 * 已勾）；S04-A-T02 是下一个待派发 task（checkbox 默认未勾，或按
 * `secondTaskChecked` 勾选以触发 recover-task 一致性重检）。
 */
function buildRecoveryRestartChain(secondTaskChecked = false): RecoveryRestartChain {
  const stageId = 'S04';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-recovery-cli-'));
  cleanups.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'recovery-cli@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Recovery CLI Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');

  // refs.md：自包含 reference 实体（compile 计算的 file_digest 与磁盘自洽）。
  fs.writeFileSync(path.join(root, 'refs.md'), [
    '<!-- proofloop:entity id="goal" kind="goal" -->',
    'goal S04',
    '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
    'task T01',
    '<!-- proofloop:entity id="S04-A-T02" kind="task" -->',
    'task T02',
    '<!-- proofloop:entity id="accept" kind="acceptance" -->',
    'acceptance',
    '<!-- proofloop:entity id="seam" kind="seam" -->',
    'seam',
    '<!-- proofloop:entity id="oracle" kind="oracle" -->',
    'oracle',
    '<!-- proofloop:entity id="risk" kind="risk" -->',
    'risk',
    '<!-- proofloop:entity id="rp" kind="proof_spec" -->',
    'runtime proof step',
  ].join('\n'), 'utf8');

  const planRef = 'delivery/stages/S04/tasks.md';
  const tasksPath = path.join(root, planRef);
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, [
    '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
    '- [ ] S04-A-T01 — first task',
    '<!-- proofloop:entity id="S04-A-T02" kind="task" -->',
    `- [${secondTaskChecked ? 'x' : ' '}] S04-A-T02 — second task`,
  ].join('\n'), 'utf8');

  const scopeFile = 'packages/runtime/src/cli/proofloop-recovery.ts';
  const evidencePath = 'delivery/stages/S04/evidence/S04-A.md';
  const requestPath = path.join(root, 'request.json');
  fs.writeFileSync(
    requestPath,
    JSON.stringify({
      root,
      stage_id: stageId,
      plan_path: planRef,
      plan: {
        schema_version: 2,
        items: [
          {
            id: 'S04-A-T01',
            kind: 'task',
            goal: 'first task',
            refs: ['REF-T1'],
            dependencies: [],
            required_skills: [],
            execution_scope: {
              kind: 'implementation',
              code_paths: [scopeFile],
              test_paths: ['packages/runtime/src/cli/proofloop-recovery.spec.ts'],
              forbidden_paths: ['.proofloop/receipts'],
            },
          },
          {
            id: 'S04-A-T02',
            kind: 'task',
            goal: 'second task',
            refs: ['REF-T2'],
            dependencies: [],
            required_skills: [],
            execution_scope: {
              kind: 'implementation',
              code_paths: [scopeFile],
              test_paths: ['packages/runtime/src/cli/proofloop-recovery.spec.ts'],
              forbidden_paths: ['.proofloop/receipts'],
            },
          },
        ],
      },
      refs: [
        { ref_id: 'REF-G', kind: 'goal', ref: 'refs.md#/entities/goal' },
        { ref_id: 'REF-T1', kind: 'task', ref: 'refs.md#/entities/S04-A-T01' },
        { ref_id: 'REF-T2', kind: 'task', ref: 'refs.md#/entities/S04-A-T02' },
        { ref_id: 'REF-A', kind: 'acceptance', ref: 'refs.md#/entities/accept' },
        { ref_id: 'REF-S', kind: 'seam', ref: 'refs.md#/entities/seam' },
        { ref_id: 'REF-O', kind: 'oracle', ref: 'refs.md#/entities/oracle' },
        { ref_id: 'REF-R', kind: 'risk', ref: 'refs.md#/entities/risk' },
        { ref_id: 'REF-RP', kind: 'proof_spec', ref: 'refs.md#/entities/rp' },
      ],
      authority_ref_ids: ['REF-A', 'REF-S', 'REF-O'],
      slices: [
        {
          slice_id: 'S04-A',
          proof_index: {
            slice_id: 'S04-A',
            goal_ref: 'REF-G',
            task_refs: ['REF-T1', 'REF-T2'],
            acceptance_refs: ['REF-A'],
            seam_refs: ['REF-S'],
            oracle_refs: ['REF-O'],
            risk_refs: [
              {
                ref_id: 'REF-R',
                applies_to_acceptance_refs: ['REF-A'],
                applies_to_seam_refs: ['REF-S'],
              },
            ],
          },
          required_skills: [],
          depends_on: [],
          evidence_path: evidencePath,
        },
      ],
    }),
    'utf8',
  );

  const manifestPath = '.proofloop/manifests/S04.json';
  expect(compileVNextManifestCli([requestPath, manifestPath, root])).toBe(0);
  const manifestValue = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8')) as {
    plan: { plan_digest: string };
  };
  const manifestDigest = computeDigest(JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8')));
  const evidenceDir = path.join(root, 'delivery', 'stages', 'S04', 'evidence');
  expect(initializeVNextSliceEvidence(manifestPath, evidenceDir, root).success).toBe(true);

  // candidate boundary：clean worktree 后才允许 Stage Plan admission。
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'S04 candidate boundary']);
  const snapshotDigest = gitHead(root);

  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: stageId,
    manifest_digest: manifestDigest,
    plan_digest: manifestValue.plan.plan_digest,
    snapshot_digest: snapshotDigest,
  };
  const admitted = admitVNextStagePlan({
    version: 2 as const,
    schema_version: 2 as const,
    type: 'STAGE_PLAN_ADMISSION' as const,
    project_root: root,
    manifest_path: manifestPath,
    stage_id: stageId,
    manifest_digest: manifestDigest,
    plan_digest: manifestValue.plan.plan_digest,
    snapshot_digest: snapshotDigest,
    spv: { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) },
  });
  if (!admitted.accepted) throw new Error(admitted.findings[0]?.message ?? 'Stage Plan admission failed');

  // T01：投影 dispatch（persistContext:true 落盘 Context）→ scope-bound 修改
  // → checkbox → TASK_COMPLETE receipt（只从持久事实恢复的 restart 基座）。
  const output = nextActionFromInput({
    project_root: root,
    stage_id: stageId,
    manifest_path: manifestPath,
    snapshot_digest: snapshotDigest,
  }) as VNextNextActionOutput;
  if (output.action !== 'DISPATCH_WORKER') {
    throw new Error('T01 dispatch unexpected: ' + JSON.stringify(output).slice(0, 900));
  }
  expect(output.task_id).toBe('S04-A-T01');
  const context = JSON.parse(fs.readFileSync(path.join(root, output.context_ref as string), 'utf8')) as {
    context_digest: string;
  };
  const scopeAbs = path.join(root, scopeFile);
  fs.mkdirSync(path.dirname(scopeAbs), { recursive: true });
  fs.appendFileSync(scopeAbs, '// recovery fixture worker change\n', 'utf8');
  fs.appendFileSync(path.join(root, evidencePath), '\nworker evidence T01\n', 'utf8');
  const planText = fs.readFileSync(tasksPath, 'utf8');
  fs.writeFileSync(tasksPath, planText.replace('- [ ] S04-A-T01', '- [x] S04-A-T01'), 'utf8');
  const changedFiles = [evidencePath, planRef, scopeFile];
  const receiptDir = path.join(root, '.proofloop', 'receipts', 'tasks', stageId, 'S04-A');
  fs.mkdirSync(receiptDir, { recursive: true });
  const proofIndexDigest = computeDigest(
    (JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8')) as VNextManifest).slices[0].proof_index,
  );
  const written = writeReceipt(
    {
      version: 1,
      type: 'TASK_COMPLETE',
      stage_id: stageId,
      slice_id: 'S04-A',
      timestamp: '2026-08-12T00:00:00.000Z',
      payload: {
        schema_version: 2,
        action_token: 'recovery-cli-T01',
        mode: output.mode,
        outcome: 'completed',
        task_id: 'S04-A-T01',
        evidence_ref: evidencePath,
        changed_files: changedFiles,
        verification_runs: [],
        summary: 'recovery restart fixture task',
        manifest_digest: manifestDigest,
        plan_digest: manifestValue.plan.plan_digest,
        proof_index_digest: proofIndexDigest,
        snapshot_digest: snapshotDigest,
        context_ref: output.context_ref,
        context_digest: context.context_digest,
      },
    },
    { receiptDir, tempDir: receiptDir },
  );

  return {
    root,
    stageId,
    manifestDigest,
    planDigest: manifestValue.plan.plan_digest,
    snapshotDigest,
    taskReceiptPaths: { 'S04-A-T01': written.path },
    secondTaskChecked,
  };
}

describe('recovery restart CLI（S10-D-T03，built public proofloop）', () => {
  it('`recovery restart --json --stage S04` re-projects the canonical dispatch from persisted facts only', () => {
    const chain = buildRecoveryRestartChain();
    // 重启 fixture：无 session/progress/narrative 状态 —— 只读事实（Git/
    // Manifest/Receipts）驱动恢复。
    expect(findSessionLikePaths(chain.root)).toEqual([]);

    const { status, envelope } = runRecoveryCliExpectStatus(
      ['recovery', 'restart', '--json', '--stage', chain.stageId],
      chain.root,
    );
    expect(status).toBe(0);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'recovery', operation: 'restart' });
    expect(envelope.findings).toEqual([]);
    expect(envelope.result.action).toBe('DISPATCH_WORKER');
    expect(envelope.result.slice_id).toBe('S04-A');
    expect(envelope.result.task_id).toBe('S04-A-T02');
    expect(envelope.result.mode).toBe('implement-task');
    expect(envelope.result.receipt_chain_valid).toBe(true);
    expect(envelope.result.manifest_digest).toBe(chain.manifestDigest);
    expect(envelope.result.plan_digest).toBe(chain.planDigest);
    expect(envelope.result.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    // Context 由 Runtime next seam 从持久事实落盘（restart fixture 语义）。
    const contextPath = path.join(chain.root, envelope.result.context_ref as string);
    expect(fs.existsSync(contextPath)).toBe(true);
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    const refDigest = (envelope.result.context_ref as string).replace(/^\.proofloop\/context\//, '').replace(/\.json$/, '');
    expect(context.context_digest).toBe(refDigest);
  });

  it('`recovery restart` re-dispatches a checked-but-unadmitted task as recover-task（一致性重检，不重放实现）', () => {
    const chain = buildRecoveryRestartChain(true);
    const { status, envelope } = runRecoveryCliExpectStatus(
      ['recovery', 'restart', '--json', '--stage', chain.stageId],
      chain.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.task_id).toBe('S04-A-T02');
    expect(envelope.result.mode).toBe('recover-task');
    expect(envelope.result.action).toBe('DISPATCH_WORKER');
  });

  it('a second restart re-projects the identical canonical Context（write-once, replayable）', () => {
    const chain = buildRecoveryRestartChain();
    const first = runRecoveryCliExpectStatus(['recovery', 'restart', '--json', '--stage', chain.stageId], chain.root);
    expect(first.status).toBe(0);
    const second = runRecoveryCliExpectStatus(['recovery', 'restart', '--json', '--stage', chain.stageId], chain.root);
    expect(second.status).toBe(0);
    expect(second.envelope.result.context_ref).toBe(first.envelope.result.context_ref);
    expect(second.envelope.result.task_id).toBe('S04-A-T02');
  });

  it('`recovery restart` fails closed with zero Context writes when a persisted Receipt is corrupt', () => {
    const chain = buildRecoveryRestartChain();
    // 在 task receipt 目录落一个 digest-addressed 但内容非法的 Receipt 事实：
    // 持久事实破坏时 restart 必须 fail closed，不能从剩余事实重投影任何派发，
    // 也不能写入任何新 Context（write-once / fail-closed，REF-S08E-RISK）。
    const corrupt = 'f'.repeat(64);
    fs.writeFileSync(
      path.join(chain.root, '.proofloop', 'receipts', 'tasks', chain.stageId, 'S04-A', `${corrupt}.json`),
      '{"version":1,"type":"TASK_COMPLETE","payload":"not-closed"}\n',
      'utf8',
    );
    const before = fs.readdirSync(path.join(chain.root, '.proofloop/context')).sort();
    const { status, envelope } = runRecoveryCliExpectStatus(
      ['recovery', 'restart', '--json', '--stage', chain.stageId],
      chain.root,
    );
    expect(status).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.result).toBeNull();
    expect(envelope.findings.length).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(chain.root, '.proofloop/context')).sort()).toEqual(before);
  });

  it('`recovery check --json --stage S04` reports the recoverable persisted state（read-only, no Context write）', () => {
    const chain = buildRecoveryRestartChain();
    const { status, envelope } = runRecoveryCliExpectStatus(
      ['recovery', 'check', '--json', '--stage', chain.stageId],
      chain.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.stage_id).toBe('S04');
    expect(envelope.result.manifest.readable).toBe(true);
    expect(envelope.result.refresh_journal.present).toBe(false);
    expect(envelope.result.next_projection.ok).toBe(true);
    expect(envelope.result.next_projection.task_id).toBe('S04-A-T02');
    expect(envelope.result.recoverable).toBe(true);
  });

  it('`recovery preflight --json --stage S04` reports ready（read-only preflight before restart）', () => {
    const chain = buildRecoveryRestartChain();
    const before = fs.readdirSync(path.join(chain.root, '.proofloop/context')).sort();
    const { status, envelope } = runRecoveryCliExpectStatus(
      ['recovery', 'preflight', '--json', '--stage', chain.stageId],
      chain.root,
    );
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.stage_id).toBe('S04');
    expect(envelope.result.ready).toBe(true);
    expect(envelope.result.manifest.manifest_digest).toBe(chain.manifestDigest);
    expect(envelope.result.next_projection.action).toBe('DISPATCH_WORKER');
    expect(envelope.result.next_projection.task_id).toBe('S04-A-T02');
    expect(envelope.findings).toEqual([]);
    // preflight 零写入：没有产生任何 Context。
    expect(fs.readdirSync(path.join(chain.root, '.proofloop/context')).sort()).toEqual(before);
  });
});
