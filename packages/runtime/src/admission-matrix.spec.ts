/**
 * admission-matrix.spec.ts — S02-E-T05 (PO-S02-E-01 success matrix)
 *
 * Test-matrix completion for the AdmissionService slice: the full 7-method
 * success walk against ONE real fixture project (temp dir + real git repo +
 * canonical `.proofloop` layout + kernel `writeReceipt` receipts). This is
 * the AWI-006 acceptance walk — every one of the 7 admit methods produces a
 * Receipt that is (a) written into its canonical category directory and
 * linked into that category chain, (b) chain-validated via
 * `verifyReceiptChain`, and (c) read back by a FRESH `reconcileStage` as the
 * corresponding fact (stage COMPLETED / slice INTEGRATED / committed /
 * integrated / complete).
 *
 * The walk drives the methods in the kernel §6 lifecycle order:
 *
 *   admitStagePlan (UNINITIALIZED → PLANNING, STAGE_PLAN to plan/<stage>/)
 *     → admitWorkerResult finalize-slice (→ READY_FOR_CV, TASK_COMPLETE to
 *       tasks/<stage>/<slice>/)
 *     → admitCVResult PASS (→ CV_PASSED, CV_PASS to cv/<stage>/<slice>/)
 *     → admitSliceCommit (→ INTEGRATING, SLICE_COMMIT to
 *       committer/<stage>/<slice>/ — cv digest binding + real baseline SHA)
 *     → admitIntegration (→ INTEGRATED, INTEGRATION_PASS to
 *       integration/<stage>/<slice>/ — same SHA binding)
 *     → [seed SPV_PASS into plan/<stage>/ — S03/S04 tool-flow receipt, NOT
 *       one of the 7 admit methods; seeded so the stage derives
 *       UNDER_REVIEW, exactly as the S02-E-T04 review fixtures do]
 *     → admitStageReview ACCEPTED (→ COMPLETED, STAGE_REVIEW_PASS to
 *       review/<stage>/)
 *     → admitProjectReview ACCEPTED (→ project COMPLETED,
 *       PROJECT_REVIEW_PASS to project/)
 *
 * Every refusal case of each method is independently proven in the T02–T04
 * spec files (admission-methods / admission-boundary / admission-review-plan);
 * this file deliberately does NOT duplicate them.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 state machines, AWI-006, PO-S02-E-01..07) — not derived from
 * the implementation under test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeReceipt, verifyReceiptChain, StageState, ProjectState } from '@proofloop/kernel';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import {
  reconcileStage,
  receiptCategoryDir,
  manifestFileDigest,
  admitStagePlan,
  admitWorkerResult,
  admitCVResult,
  admitSliceCommit,
  admitIntegration,
  admitStageReview,
  admitProjectReview,
  type AdmissionDeps,
  type ReconcileStageResult,
  type WorkerResultEnvelope,
  type ReceiptContentCategory,
} from '@proofloop/runtime';

// ============================================================
// Known-good literals (authority excerpts — never derived)
// ============================================================

const STAGE_ID = 'S02';
const SLICE_ID = 'S02-E';
const TASKS: readonly string[] = ['S02-E-T01', 'S02-E-T02', 'S02-E-T03', 'S02-E-T04', 'S02-E-T05'];

function makeEnvelope(overrides: Partial<WorkerResultEnvelope> = {}): WorkerResultEnvelope {
  return {
    schemaVersion: 1,
    actionToken: 'tok-lifecycle',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: 'S02-E-T05',
    mode: 'finalize-slice',
    outcome: 'completed',
    evidenceRef: 'delivery/stages/S02/evidence/S02-E.md',
    changedFiles: ['packages/runtime/src/admission-matrix.spec.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 'lifecycle walk',
    ...overrides,
  };
}

// ============================================================
// Fixture helpers (real temp dir + real git repo + canonical layout)
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

interface AdmitFx {
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  write(rel: string, content: string): void;
  writeManifest(): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean): void;
  seedReceipt(
    category: ReceiptContentCategory,
    overrides: Record<string, unknown>,
  ): { path: string; digest: string };
  commitAll(message?: string): string;
  reconcile(): ReconcileStageResult;
  cleanup(): void;
}

function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID): AdmitFx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-matrix-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'matrix@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Matrix Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);

  const sliceDef = (sid: string, taskIds: readonly string[]): ManifestSlice => ({
    slice_id: sid,
    goal: 'AdmissionService 7 类 admit 操作',
    observable_outcome: 'deterministic admits with chain-verified receipts',
    public_seam: '@proofloop/runtime AdmissionService',
    dependencies: ['S02-A'],
    proof_obligations: [
      {
        po_id: 'PO-S02-E-01',
        behavior: 'unified pipeline is the only receipt creation path for the 7 admit methods',
        public_seam: '@proofloop/runtime AdmissionService',
        oracle_source: 'real fixture project',
        success_criteria: 'receipt chain valid + reconcile readback for every success admit',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['persistent_state', 'core_state_machine'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/${stageId}/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  });

  const fx: AdmitFx = {
    root,
    stageId,
    sliceId,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: () => {
      const manifest: Manifest = {
        stage_id: stageId,
        source_path: `delivery/stages/${stageId}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'Runtime core application services',
        outcomes: ['deterministic admits'],
        slices: [sliceDef(sliceId, TASKS)],
        dependencies: [],
        risk_facts: [],
      };
      fx.write(`.proofloop/manifests/${stageId}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (checkedTasks) => {
      const lines = TASKS.map(
        (t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`,
      );
      const content =
        `# Stage ${stageId} — Runtime Core\n\n` +
        `## Slice ${sliceId}\n` +
        `<!-- SLICE:${sliceId}:BEGIN -->\n\n` +
        `### Tasks\n\n${lines.join('\n')}\n\n` +
        `<!-- SLICE:${sliceId}:END -->\n`;
      fx.write(`delivery/stages/${stageId}/tasks.md`, content);
    },
    writeEvidence: (finalized) => {
      const content =
        `# Slice ${sliceId} Evidence\n\n` +
        `## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n` +
            `### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S02-E-01 | admission-matrix.spec.ts | yes | yes | pass |\n\n` +
            `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
          : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| *None* | | | | |\n`);
      fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, content);
    },
    seedReceipt: (category, overrides) => {
      const dir = receiptCategoryDir(root, category, stageId, sliceId);
      fs.mkdirSync(dir, { recursive: true });
      return writeReceipt(
        {
          version: 1,
          type: 'TASK_COMPLETE',
          stage_id: stageId,
          timestamp: '2026-08-01T00:00:00.000Z',
          payload: {},
          ...overrides,
        },
        { receiptDir: dir, tempDir: dir },
      );
    },
    commitAll: (message = 'fixture') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
      return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf-8',
      }).trim();
    },
    reconcile: () => reconcileStage({ projectRoot: root, stageId }),
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/**
 * Baseline fixture: manifest + all tasks checked + evidence finalized, then
 * ONE baseline commit (git HEAD = baselineSha). No receipts yet — the stage
 * derives UNINITIALIZED, the slice derives IN_PROGRESS.
 */
function fxBaseline(): { fx: AdmitFx; baselineSha: string } {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  const baselineSha = fx.commitAll();
  return { fx, baselineSha };
}

// ============================================================
// Shared helpers
// ============================================================

function depsFor(fx: AdmitFx, extra?: Partial<AdmissionDeps>): AdmissionDeps {
  return { projectRoot: fx.root, ...extra };
}

function categoryDir(fx: AdmitFx, category: ReceiptContentCategory): string {
  return path.join(fx.root, '.proofloop', 'receipts', category, fx.stageId, fx.sliceId);
}

// ============================================================
// PO-S02-E-01 — full success matrix (AWI-006 acceptance walk)
// ============================================================

describe('PO-S02-E-01 — full 7-method success matrix on one fixture', () => {
  it(
    'walks the whole lifecycle: every success admit is chain-verified and ' +
      'read back by a fresh reconcile',
    () => {
      const { fx, baselineSha } = fxBaseline();

      // ── 1. admitStagePlan (PO-S02-E-07): UNINITIALIZED + canonical
      //        manifest digest binding → STAGE_PLAN to plan/<stage>/.
      const planDigest = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });
      const plan = admitStagePlan(
        { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: planDigest },
        depsFor(fx),
      );
      expect(plan.accepted).toBe(true);
      expect(plan.receipt_ref).not.toBeNull();
      expect(plan.new_state?.stage_state).toBe('PLANNING');
      const planChain = verifyReceiptChain(
        path.join(fx.root, '.proofloop', 'receipts', 'plan', STAGE_ID),
      );
      expect(planChain.valid).toBe(true);
      expect(planChain.receipts).toHaveLength(1);

      // ── 2. admitWorkerResult finalize-slice (PO-S02-E-02): IN_PROGRESS +
      //        evidence finalized → READY_FOR_CV; TASK_COMPLETE to
      //        tasks/<stage>/<slice>/.
      const worker = admitWorkerResult(
        {
          type: 'worker_result',
          envelope: makeEnvelope({ mode: 'finalize-slice' }),
        },
        depsFor(fx),
      );
      expect(worker.accepted).toBe(true);
      expect(worker.receipt_ref).not.toBeNull();
      expect(worker.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
      expect(verifyReceiptChain(categoryDir(fx, 'tasks')).valid).toBe(true);

      // ── 3. admitCVResult PASS (PO-S02-E-03): READY_FOR_CV → CV_PASSED;
      //        CV_PASS to cv/<stage>/<slice>/.
      const cv = admitCVResult(
        {
          type: 'cv_result',
          stageId: STAGE_ID,
          sliceId: SLICE_ID,
          verdict: 'PASS',
          snapshotDigest: baselineSha,
          summary: 'cv pass',
        },
        depsFor(fx),
      );
      expect(cv.accepted).toBe(true);
      expect(cv.receipt_ref).not.toBeNull();
      expect(cv.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
      expect(verifyReceiptChain(categoryDir(fx, 'cv')).valid).toBe(true);

      // ── 4. admitSliceCommit (PO-S02-E-04): CV_PASSED + cv digest binding
      //        (request digest === the CV_PASS receipt digest just written)
      //        + real baseline SHA → SLICE_COMMIT to committer/<stage>/<slice>/.
      const commit = admitSliceCommit(
        {
          type: 'slice_commit',
          stageId: STAGE_ID,
          sliceId: SLICE_ID,
          commitSha: baselineSha,
          cvReceiptDigest: cv.receipt_ref as string,
        },
        depsFor(fx),
      );
      expect(commit.accepted).toBe(true);
      expect(commit.receipt_ref).not.toBeNull();
      expect(commit.new_state?.slices[0]?.slice_state).toBe('INTEGRATING');
      const commitChain = verifyReceiptChain(categoryDir(fx, 'committer'));
      expect(commitChain.valid).toBe(true);
      expect(commitChain.receipts).toHaveLength(1);

      // ── 5. admitIntegration (PO-S02-E-04): INTEGRATING + SLICE_COMMIT
      //        bound to the SAME SHA → INTEGRATION_PASS to
      //        integration/<stage>/<slice>/.
      const integration = admitIntegration(
        {
          type: 'integration',
          stageId: STAGE_ID,
          sliceId: SLICE_ID,
          commitSha: baselineSha,
        },
        depsFor(fx),
      );
      expect(integration.accepted).toBe(true);
      expect(integration.receipt_ref).not.toBeNull();
      expect(integration.new_state?.slices[0]?.slice_state).toBe('INTEGRATED');
      const integrationChain = verifyReceiptChain(categoryDir(fx, 'integration'));
      expect(integrationChain.valid).toBe(true);
      expect(integrationChain.receipts).toHaveLength(1);

      // ── 6. Seed SPV_PASS into plan/<stage>/ — S03/S04 tool-flow receipt
      //        (NOT one of the 7 admit methods). Presence of SPV_PASS + all
      //        slices integrated derives the stage UNDER_REVIEW (the
      //        S02-E-T04 review precondition), exactly like the review
      //        fixtures seed it.
      const spv = fx.seedReceipt('plan', {
        type: 'SPV_PASS',
        timestamp: '2026-08-02T00:00:00.000Z',
        payload: { verdict: 'PASS' },
      });
      expect(spv.digest.length).toBe(64);
      expect(verifyReceiptChain(
        path.join(fx.root, '.proofloop', 'receipts', 'plan', STAGE_ID),
      ).valid).toBe(true);

      // ── 7. admitStageReview ACCEPTED (PO-S02-E-05): stage derived
      //        UNDER_REVIEW → COMPLETED; STAGE_REVIEW_PASS to review/<stage>/.
      const review = admitStageReview(
        { type: 'stage_review', stageId: STAGE_ID, verdict: 'ACCEPTED', summary: 'stage accepted' },
        depsFor(fx),
      );
      expect(review.accepted).toBe(true);
      expect(review.receipt_ref).not.toBeNull();
      expect(review.new_state?.stage_state).toBe('COMPLETED');
      expect(verifyReceiptChain(
        path.join(fx.root, '.proofloop', 'receipts', 'review', STAGE_ID),
      ).valid).toBe(true);

      // ── 8. admitProjectReview ACCEPTED (PO-S02-E-06, F-1): the project
      //        state is a REAL reconcile-derived gate — after step 7 the
      //        stage is COMPLETED (STAGE_REVIEW_PASS receipt), so a fresh
      //        reconcile derives the project UNDER_REVIEW (stage review
      //        passed, no PROJECT_REVIEW_PASS yet); ACCEPTED → reducer
      //        COMPLETE → project COMPLETED; PROJECT_REVIEW_PASS to project/.
      const preProjectState = fx.reconcile().project_state;
      expect(preProjectState).toBe('UNDER_REVIEW');
      const project = admitProjectReview(
        { type: 'project_review', stageId: STAGE_ID, verdict: 'ACCEPTED', summary: 'project accepted' },
        depsFor(fx),
      );
      expect(project.accepted).toBe(true);
      expect(project.receipt_ref).not.toBeNull();
      expect(project.new_state?.project_state).toBe('COMPLETED');
      expect(verifyReceiptChain(
        path.join(fx.root, '.proofloop', 'receipts', 'project'),
      ).valid).toBe(true);

      // ── 9. Final FRESH reconcile reads every fact back (PO-S02-E-01
      //        Required Observation / AWI-006).
      const reread = fx.reconcile();
      expect(reread.receipt_chain_valid).toBe(true);
      expect(reread.stage_state).toBe('COMPLETED');
      // Project COMPLETED is derived from the PROJECT_REVIEW_PASS receipt
      // read back through the shared project/ chain (F-1).
      expect(reread.project_state).toBe('COMPLETED');
      const slice = reread.slices[0];
      expect(slice?.slice_state).toBe('INTEGRATED');
      expect(slice?.committed).toBe(true);
      expect(slice?.integrated).toBe(true);
      expect(slice?.complete).toBe(true);
      // All 7 admitted receipts (8 with the seeded SPV_PASS) are read back
      // through the category chains into the reconciled receipt_chain.
      const admittedRefs = [
        plan.receipt_ref,
        worker.receipt_ref,
        cv.receipt_ref,
        commit.receipt_ref,
        integration.receipt_ref,
        review.receipt_ref,
        project.receipt_ref,
      ];
      for (const ref of admittedRefs) {
        expect(reread.receipt_chain, `receipt ${ref} read back`).toContain(ref);
      }
      expect(reread.receipt_chain).toContain(spv.digest);
    },
  );
});
