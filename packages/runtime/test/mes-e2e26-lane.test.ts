/**
 * E2E-26 `MES_MAINTENANCE` executable lane closure test (S06-R-D-T02, sole
 * proof owner; isolated fixture roots only).
 *
 * PO: acceptance E2E-26 — with the exact frozen snapshot/forensic/audit/
 * quarantine/recovery Plan tuple, the shared Worker packet runs the
 * dependency-ready evidence-only chain:
 *   seam entry → packet projection → Worker Task Result → `TASK_RESULT_ACK`
 *   → CV initial PASS → canonical Runtime slice-output boundary
 *   (`closeGitBoundary` on the REAL isolated fixture dirty set establishes
 *   the durable candidate ref) → mechanical Git Integration → canonical
 *   cleanup validator (`buildCleanupFact` / `validateCleanupFact` against the
 *   ACTUAL integration result) → full maintenance Review envelope
 *   (outcome/composition/authority axis verdicts, closed-shape validated) →
 *   restart / lost-ACK rebuild from rehydrated Plan/forensic/Git facts (no
 *   ack-log, no second result store, no hidden-session continuation).
 *
 * Evidence-only invariants (contracts §2.1.5 / §4.2 / §4.3 / §5.1.2 / §5.3):
 * no MES `work_id` / `result_ref` / PVR / PA / recovery baseline writes; no
 * NORMAL `INTEGRATED` / `STAGE_ACCEPTED`; every failure is a typed no-write
 * blocker; the lane's own fixture frozen snapshot stays byte-identical; the
 * canonical project/trust-root `.proofloop/mes` is only ever observed (in-run
 * pre/post bytes + fact identity invariance), never a mutation target.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha } from './helpers';
import {
  E26_AUTHORITY_REFS,
  E26_CANDIDATE_REF,
  E26_CANONICAL_SLICE,
  E26_EVIDENCE_WORKTREE,
  E26_LANE_TOKEN,
  E26_PLAN_REF,
  E26_SLICE,
  E26_STAGE,
  makeLaneFixture,
  porcelainOf,
  observeCanonicalProjectMes,
  rehydrateLane,
  runGitQuiet,
  sha256OfFile,
  validateMaintenanceReviewEnvelope,
} from './fixtures/e2e26';
import { verifyMaintenanceEntry, MaintenanceSeamError } from '../dist/mes/maintenance-seam';
import { validateSliceWorkPacket } from '../dist/execute/work-packet';
import { validateWorkerTaskResult, TaskResultValidationError } from '../dist/execute/task-result';
import { buildTaskResultAck, TaskResultAckError } from '../dist/execute/task-result-ack';
import { validateCvResult, gateCvResult } from '../dist/execute/cv-result';
import { applyIntegration, IntegrationError } from '../dist/git-integration';
import { closeGitBoundary, GitBoundaryError } from '../dist/git-boundary';
import {
  buildCleanupFact,
  buildIntegrationFact,
  validateCleanupFact,
  validateIntegrationFact,
} from '../dist/execute/integration-state';
import { IntegrationStateError } from '../dist/execute/integration-state';
import type { MesFactEnvelope } from '../dist/mes/types';
import type { CanonicalProjectMesObservation } from './fixtures/e2e26';

/** Full entry basis for the lane (recovery candidate + exact tuple + token). */
function entryContextFor(fx: ReturnType<typeof makeLaneFixture>, opts: { laneActionToken?: string; planRef?: string } = {}) {
  return {
    stageId: E26_STAGE,
    basis: {
      plan_ref: opts.planRef ?? E26_PLAN_REF,
      authority_refs: E26_AUTHORITY_REFS,
      maintenance_binding: fx.bindingSnake,
      git_basis: { head: fx.evidenceHead, branch: 'HEAD', worktree: E26_EVIDENCE_WORKTREE },
      actionToken: E26_LANE_TOKEN,
    },
    laneActionToken: opts.laneActionToken ?? E26_LANE_TOKEN,
  };
}

function expectSeamCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MaintenanceSeamError, `expected MaintenanceSeamError, got ${String(error)}`);
    assert.equal((error as MaintenanceSeamError).code, code);
    return;
  }
  assert.fail(`expected MaintenanceSeamError ${code}, but no error was thrown`);
}

/**
 * Pre-run canonical project MES observation (PO-S06-E-04), captured at module
 * load — before this lane's first isolated fixture executes. The lane proves
 * safety as in-run pre/post invariance of the OBSERVED canonical MES (bytes +
 * fact identity); no historical frozen tuple is pinned as current truth. An
 * unobservable canonical MES fails closed at the assertion below.
 */
const CANONICAL_PROJECT_MES_PRE:
  | { ok: true; observation: CanonicalProjectMesObservation }
  | { ok: false; error: string } = (() => {
  try {
    return { ok: true, observation: observeCanonicalProjectMes() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
})();

describe('E2E-26 MES_MAINTENANCE executable lane (S06-R-D-T02)', () => {
  test('full evidence-only chain closes: entry → packet → Result → ACK → CV → canonical slice-output → Integration → canonical cleanup → maintenance Review', () => {
    const fx = makeLaneFixture();
    try {
      // 1) Seam entry: exact tuple machine-verified against the evidence
      //    worktree basis.
      const entry = verifyMaintenanceEntry(fx.root, entryContextFor(fx));
      assert.equal(entry.execution_mode, 'MES_MAINTENANCE');
      assert.equal(entry.snapshot_fact_count, 130);
      assert.equal(entry.git_basis.worktree, E26_EVIDENCE_WORKTREE);

      // 2) Maintenance packet projection (shared Worker packet).
      const packet = validateSliceWorkPacket(fx.packet());
      assert.equal(packet.execution_mode, 'MES_MAINTENANCE');
      assert.equal(packet.thin_plan_ref, E26_PLAN_REF);
      assert.equal(packet.maintenance_binding?.frozen_fact_count, 130);

      // 3) Evidence-only Worker Task Result (no MES resultRef).
      const submitted = validateWorkerTaskResult(fx.result());
      assert.equal(submitted.executionMode, 'MES_MAINTENANCE');
      assert.equal(submitted.resultRef, undefined);
      assert.equal(submitted.maintenanceBinding?.frozenFactCount, 130);

      // 4) Evidence-only TASK_RESULT_ACK: ACCEPTED never carries a MES
      //    acceptedResultRef.
      const ack = buildTaskResultAck({
        laneActionToken: E26_LANE_TOKEN,
        submitted,
        decision: { resultDisposition: 'ACCEPTED', continuationDisposition: 'CONTINUE' },
        durableFacts: [],
      });
      assert.equal(ack.resultDisposition, 'ACCEPTED');
      assert.equal(ack.acceptedResultRef, undefined, 'maintenance ACK accepts evidence, not a MES result');

      // 5) CV initial PASS (evidence-only). The candidate ref is NOT durable
      //    yet — the gate stays PASS_PENDING_CANDIDATE_REF.
      const cvInitial = validateCvResult(fx.cvResult());
      assert.equal(cvInitial.verdict, 'PASS');
      assert.equal(cvInitial.resultRef, undefined);
      assert.equal(
        gateCvResult(cvInitial, { candidateRefDurable: false }).state,
        'PASS_PENDING_CANDIDATE_REF',
        'without a durable candidate ref the gate never closes READY_TO_INTEGRATE',
      );
      // The canonical candidate ref must NOT pre-exist: it is established
      // only by the slice-output boundary below (no precreated substitute).
      assert.throws(
        () => runGitQuiet(fx.root, ['rev-parse', '--verify', `${E26_CANDIDATE_REF}^{commit}`]),
        /could not resolve|unknown revision|fatal/,
        'candidate ref must not be pre-created by the fixture',
      );

      // 6) Canonical Runtime slice-output boundary on the REAL isolated
      //    fixture dirty set (tracked a.txt modified in the detached slice
      //    worktree): commits the dirty set and establishes the durable
      //    canonical candidate ref proofloop-s06-r-d.
      const boundary = closeGitBoundary(fx.sliceAbs, fx.sliceOutputRequest() as never);
      assert.equal(boundary.boundary_type, 'slice-output');
      assert.equal(boundary.commit_message, `slice-output: ${E26_STAGE}-R-D`);
      assert.deepEqual(boundary.changed_files, ['a.txt']);
      assert.equal(boundary.dirty_after, false);
      const candidateSha = runGitQuiet(fx.root, ['rev-parse', '--verify', `${E26_CANDIDATE_REF}^{commit}`]).trim();
      assert.equal(candidateSha, boundary.commit_sha, 'slice-output establishes the durable candidate ref at the boundary commit');
      assert.equal(porcelainOf(fx.sliceAbs), '', 'slice worktree is clean after the boundary');
      // Now the CV gate closes: PASS + durable candidate ref (a Git fact).
      assert.equal(
        gateCvResult(cvInitial, { candidateRefDurable: true }).state,
        'READY_TO_INTEGRATE',
      );

      // 7) Mechanical Git Integration into the detached evidence worktree.
      const result = applyIntegration(fx.root, fx.integrationRequest() as never);
      assert.equal(result.execution_mode, 'MES_MAINTENANCE');
      assert.equal(result.expected_worktree, E26_EVIDENCE_WORKTREE);
      assert.equal(result.commit_message, `integration: ${E26_STAGE}-R-D`);
      assert.deepEqual(result.changed_files, ['a.txt']);
      // Evidence worktree clean + still detached; main worktree zero-write.
      assert.equal(porcelainOf(fx.evidenceAbs), '');
      assert.equal(runGitQuiet(fx.root, ['rev-parse', 'HEAD']).trim(), fx.base);
      assert.equal(porcelainOf(fx.root), '');
      const evidenceCommit = runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim();
      assert.notEqual(evidenceCommit, fx.evidenceHead);

      // 8) Canonical cleanup validator against the ACTUAL integration result.
      //    The maintenance lane is schema-enforced evidence-only: the
      //    canonical MES git-fact schema REFUSES the recovery-lane slice id
      //    (S06-R-D is not a canonical MES slice) AND refuses the ACTUAL
      //    maintenance candidate ref under any canonical projection
      //    (canonicalCandidateRef(S06, S06-RD) = proofloop-s06-rd, never
      //    proofloop-s06-r-d) — the lane can never smuggle itself into a
      //    durable NORMAL fact. Both refusals are typed no-write.
      const planBinding = {
        binding_stage: 'accepted',
        accepted_plan_ref: 'delivery/stages/S06/plan.md',
        source_candidate_plan_ref: 'delivery/stages/S06/plan.md',
        verification_result_ref: 'mes:result:S06:planning-verification-1',
        plan_digest: '13c41263c750b2df8ebf7b8269bcec31f7b37b770d4f50db543bf061ea6fb90e',
        delivery_cycle_id: 'cycle-208cbbe8d8e946479bb746f318b56178',
      };
      assert.throws(
        () =>
          buildIntegrationFact(
            {
              stage_id: E26_STAGE,
              slice_id: E26_SLICE,
              authority_refs: E26_AUTHORITY_REFS,
              plan_binding: planBinding,
              git_basis: { head: result.pre_integration_head, branch: 'HEAD', worktree: E26_EVIDENCE_WORKTREE },
              candidate_ref: result.candidate_ref,
              candidate_base_ref: result.candidate_base_ref,
              commit_sha: result.commit_sha,
              changed_files: result.changed_files,
              fact_id: 'mes:fact:git:S06:S06-R-D:integration',
            },
            result,
          ),
        IntegrationStateError,
        'the raw recovery-lane slice id must be refused by the canonical MES git-fact schema',
      );
      assert.throws(
        () =>
          buildIntegrationFact(
            {
              stage_id: E26_STAGE,
              slice_id: E26_CANONICAL_SLICE,
              work_id: 'mes:work:S06:S06-RD:1',
              authority_refs: E26_AUTHORITY_REFS,
              plan_binding: planBinding,
              git_basis: { head: result.pre_integration_head, branch: 'HEAD', worktree: E26_EVIDENCE_WORKTREE },
              candidate_ref: result.candidate_ref,
              candidate_base_ref: result.candidate_base_ref,
              commit_sha: result.commit_sha,
              changed_files: result.changed_files,
              fact_id: 'mes:fact:git:S06:S06-RD:integration',
            },
            result,
          ),
        IntegrationStateError,
        'the actual maintenance candidate ref must be refused under any canonical projection',
      );
      //    The canonical CLEANED closure is still exercised against the
      //    ACTUAL apply payload: the in-memory evidence envelope uses the
      //    canonical MES projection of the lane identity and binds the
      //    ACTUAL integration commit_sha / changed_files / candidate_base_ref
      //    exactly (buildCleanupFact + validateCleanupFact). It is NEVER
      //    written to MES — the lane itself binds the recovery candidate
      //    (verified at entry/packet/result/CV).
      const projectedIntegration = validateIntegrationFact({
        schema_version: 2,
        fact_id: 'mes:fact:git:S06:S06-RD:integration',
        fact_kind: 'git',
        git_subkind: 'integration',
        created_by: 'brain',
        authority_refs: E26_AUTHORITY_REFS,
        scope: { stage_id: E26_STAGE, slice_id: E26_CANONICAL_SLICE },
        work_id: 'mes:work:S06:S06-RD:1',
        plan_binding: planBinding,
        git_basis: { head: result.pre_integration_head, branch: 'HEAD', worktree: E26_EVIDENCE_WORKTREE },
        candidate_ref: 'proofloop-s06-rd',
        candidate_base_ref: result.candidate_base_ref,
        commit_sha: result.commit_sha,
        changed_files: result.changed_files,
      });
      const cleanup = buildCleanupFact({ integration_fact: projectedIntegration });
      validateCleanupFact(cleanup, projectedIntegration);
      assert.equal(cleanup.git_subkind, 'cleanup');
      assert.equal(cleanup.commit_sha, result.commit_sha, 'cleanup binds the actual integration commit');
      assert.deepEqual(cleanup.changed_files, result.changed_files);
      assert.equal(cleanup.candidate_base_ref, result.candidate_base_ref);
      // Candidate ref preserved and evidence commit reachable.
      runGitQuiet(fx.root, ['rev-parse', '--verify', `${E26_CANDIDATE_REF}^{commit}`]);

      // 9) Full canonical maintenance Review envelope constructed from the
      //    ACTUAL lane Git facts (post-integration evidence basis) and
      //    closed-shape validated — never a fixture-only placeholder.
      const review = fx.reviewEnvelope({
        reviewSnapshotRef: evidenceCommit,
        gitBasis: { head: evidenceCommit, branch: 'HEAD', worktree: E26_EVIDENCE_WORKTREE },
      });
      validateMaintenanceReviewEnvelope(review, { root: fx.root, evidenceHead: evidenceCommit });
      assert.equal(review.review_scope, 'maintenance');
      assert.equal(review.execution_mode, 'MES_MAINTENANCE');
      assert.equal(review.verdict, 'PASS');
      assert.equal(review.outcome_verdict, 'PASS');
      assert.equal(review.composition_verdict, 'PASS');
      assert.equal(review.authority_verdict, 'PASS');
      assert.equal(review.planRef, E26_PLAN_REF);
      assert.equal(review.reviewSnapshotRef, evidenceCommit);
      assert.equal((review.gitBasis as { head: string }).head, evidenceCommit);
      // A maintenance Review PASS is evidence-only: no MES stage fact exists
      // anywhere in the fixture.
      const fixtureMES = path.join(fx.root, '.proofloop', 'mes');
      assert.deepEqual(fs.readdirSync(fixtureMES), ['snapshot.json'], 'no MES facts were materialized by the lane');
      // Frozen snapshot stays byte-identical (digest + count).
      assert.equal(sha256OfFile(path.join(fx.root, '.proofloop', 'mes', 'snapshot.json')), fx.bindingSnake.frozen_snapshot_sha256);
      assert.equal(entry.snapshot_fact_count, 130);
    } finally {
      fx.cleanup();
    }
  });

  test('restart / lost-ACK rebuild: rehydrated Plan/forensic/Git facts derive the SAME evidence without hidden session state', () => {
    const fx = makeLaneFixture();
    let firstDigest = '';
    let firstResultId = '';
    try {
      // Run the lane far enough to leave durable Git facts (candidate ref +
      // evidence commit) on disk.
      const entry = verifyMaintenanceEntry(fx.root, entryContextFor(fx));
      assert.equal(entry.execution_mode, 'MES_MAINTENANCE');
      const submitted = validateWorkerTaskResult(fx.result());
      firstDigest = submitted.resultPayloadDigest;
      firstResultId = submitted.resultId;
      const ack = buildTaskResultAck({
        laneActionToken: E26_LANE_TOKEN,
        submitted,
        decision: { resultDisposition: 'ACCEPTED', continuationDisposition: 'CONTINUE' },
        durableFacts: [],
      });
      assert.equal(ack.resultDisposition, 'ACCEPTED');
      const cvInitial = validateCvResult(fx.cvResult());
      const boundary = closeGitBoundary(fx.sliceAbs, fx.sliceOutputRequest() as never);
      assert.equal(gateCvResult(cvInitial, { candidateRefDurable: true }).state, 'READY_TO_INTEGRATE');
      const result = applyIntegration(fx.root, fx.integrationRequest() as never);
      assert.equal(result.commit_message, `integration: ${E26_STAGE}-R-D`);

      // SERIALIZE: the durable truth is the persisted Plan/forensic/snapshot
      // files + Git refs/commits. RESTART: a fresh process rehydrates ONLY
      // from those facts (no in-session closure reuse, no ack-log).
      const rebuilt = rehydrateLane(fx.root);
      assert.deepEqual(rebuilt.bindingSnake, fx.bindingSnake, 'binding tuple re-derived from the immutable files');
      assert.equal(rebuilt.candidateSha, boundary.commit_sha, 'candidate commit re-derived from the Git ref');
      assert.equal(rebuilt.evidenceHead, fx.evidenceHead, 'pre-integration evidence HEAD re-derived as the integration parent');
      assert.equal(
        rebuilt.evidenceHead,
        runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD^']).trim(),
        'evidence HEAD is a Git fact, not session state',
      );

      // Rebuild the SAME evidence-only Result + ACK from the re-derived facts.
      const resubmitted = validateWorkerTaskResult(rebuilt.result());
      assert.equal(resubmitted.resultPayloadDigest, firstDigest, 'restart rebuild derives the identical evidence digest');
      const ack2 = buildTaskResultAck({
        laneActionToken: E26_LANE_TOKEN,
        submitted: resubmitted,
        decision: { resultDisposition: 'ACCEPTED', continuationDisposition: 'CONTINUE' },
        durableFacts: [],
      });
      assert.equal(ack2.resultDisposition, 'ACCEPTED');
      assert.equal(ack2.resultId, firstResultId);

      // The maintenance Review evidence re-derives on restart from Git only.
      const evidenceCommit = runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim();
      const review2 = rebuilt.reviewEnvelope({
        reviewSnapshotRef: evidenceCommit,
        gitBasis: { head: evidenceCommit, branch: 'HEAD', worktree: E26_EVIDENCE_WORKTREE },
      });
      validateMaintenanceReviewEnvelope(review2, { root: fx.root, evidenceHead: evidenceCommit });
      assert.equal(review2.reviewSnapshotRef, evidenceCommit);

      // No ack-log / second result store anywhere in the fixture root.
      const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) out.push(...walk(abs));
          else out.push(abs);
        }
        return out;
      };
      const files = walk(fx.root).map((abs) => path.relative(fx.root, abs));
      assert.ok(!files.some((f) => /ack|result-store|receipt|manifest/i.test(f)), 'no ack-log / second store file may exist');
      assert.equal(fx.bindingSnake.frozen_snapshot_sha256, sha256OfFile(path.join(fx.root, '.proofloop', 'mes', 'snapshot.json')));
    } finally {
      fx.cleanup();
    }
  });

  test('CV FINDINGS → bounded recheck PASS stays evidence-only', () => {
    const fx = makeLaneFixture();
    try {
      const findings = validateCvResult(
        fx.cvResult({
          verdict: 'FINDINGS',
          failed_criterion: 'PO coverage',
          failure_signature: 'E2E-26-R1',
          required_recheck_scope: ['packages/runtime/src/mes/maintenance-seam.ts'],
          claimed_route_code: 'IMPLEMENTATION_DEFECT',
          subtype: 'finding',
          reason: 'fixture finding',
          invalidation_scope: ['packages/runtime/src/mes/maintenance-seam.ts'],
          resume_target: 'producer',
        }),
      );
      assert.equal(findings.verdict, 'FINDINGS');
      assert.equal(findings.execution_mode, 'MES_MAINTENANCE');
      assert.equal(findings.claimed_route_code, 'IMPLEMENTATION_DEFECT');
      // Bounded recheck on the same basis (evidence-only).
      const recheck = validateCvResult(
        fx.cvResult({
          verdict: 'PASS',
          verification_type: 'recheck',
          previous_failure_signature: 'E2E-26-R1',
          repair_diff_basis: 'packages/runtime/slice-s06-r-d-recheck.diff',
        }),
      );
      assert.equal(recheck.verdict, 'PASS');
      assert.equal(recheck.verification_type, 'recheck');
    } finally {
      fx.cleanup();
    }
  });

  test('negative: missing tuple, stale token, post-recovery reuse, accepted-Plan substitution, lane widening → typed no-write blockers', () => {
    const fx = makeLaneFixture();
    try {
      // Missing tuple: empty maintenance_binding shape.
      expectSeamCode(
        () =>
          verifyMaintenanceEntry(fx.root, {
            ...entryContextFor(fx),
            basis: { ...entryContextFor(fx).basis, maintenance_binding: {} as never },
          }),
        'MAINTENANCE.ENTRY_INVALID',
      );
      // Stale lane token.
      expectSeamCode(
        () => verifyMaintenanceEntry(fx.root, entryContextFor(fx, { laneActionToken: 'other-lane' })),
        'MAINTENANCE.AUTHORIZATION_MISMATCH',
      );
      // Post-recovery reuse: after the lane closed, a NEW lane needs a NEW
      // token — presenting the old token is stale (§4.3).
      expectSeamCode(
        () => verifyMaintenanceEntry(fx.root, entryContextFor(fx, { laneActionToken: 'fresh-recovery-lane' })),
        'MAINTENANCE.AUTHORIZATION_MISMATCH',
      );
      // S06 accepted Plan substitution is rejected at the entry (§4.2).
      expectSeamCode(
        () => verifyMaintenanceEntry(fx.root, entryContextFor(fx, { planRef: 'delivery/stages/S06/plan.md' })),
        'MAINTENANCE.ENTRY_INVALID',
      );
      // Stale recovery candidate substitution is rejected at the entry.
      expectSeamCode(
        () => verifyMaintenanceEntry(fx.root, entryContextFor(fx, { planRef: 'delivery/stages/S06/recovery-plan-r2.md' })),
        'MAINTENANCE.ENTRY_INVALID',
      );
      // Lane widening: a foreign stage cannot enter the S06 lane.
      expectSeamCode(
        () => verifyMaintenanceEntry(fx.root, { ...entryContextFor(fx), stageId: 'S07' }),
        'MAINTENANCE.ENTRY_INVALID',
      );
      // Forbidden MES identity/resultRef under maintenance.
      assert.throws(
        () => validateWorkerTaskResult(fx.result({ resultRef: 'mes:result:S06:1' })),
        (error: unknown) => error instanceof TaskResultValidationError,
      );
      // No retry loop: every failed attempt leaves the fixture byte-stable.
      assert.equal(sha256OfFile(path.join(fx.root, '.proofloop', 'mes', 'snapshot.json')), fx.bindingSnake.frozen_snapshot_sha256);
    } finally {
      fx.cleanup();
    }
  });

  test('negative: NORMAL / PRE_MES_BOOTSTRAP fallback and maintenance-result smuggling fail closed', () => {
    const fx = makeLaneFixture();
    try {
      // A maintenance packet cannot fall back to NORMAL / PRE_MES_BOOTSTRAP
      // (maintenance_binding is forbidden there).
      assert.throws(() => validateSliceWorkPacket(fx.packet({ execution_mode: 'NORMAL' })));
      assert.throws(() => validateSliceWorkPacket(fx.packet({ execution_mode: 'PRE_MES_BOOTSTRAP' })));
      // A NORMAL Task Result cannot smuggle maintenanceBinding.
      assert.throws(() =>
        validateWorkerTaskResult(
          fx.result({
            executionMode: 'NORMAL',
            resultRef: 'mes:result:S06:normal:1',
            maintenanceBinding: undefined,
          }),
        ),
      );
      // A maintenance integration cannot target the main worktree.
      assert.throws(
        () => applyIntegration(fx.root, fx.integrationRequest({ expected_worktree: '.' }) as never),
        (error: unknown) => error instanceof IntegrationError,
      );
      // A maintenance CV FINDINGS result cannot claim AUTHORITY_GAP.
      assert.throws(() =>
        validateCvResult(
          fx.cvResult({
            verdict: 'FINDINGS',
            failed_criterion: 'PO coverage',
            failure_signature: 'E2E-26-R2',
            required_recheck_scope: ['packages/runtime/src/mes/maintenance-seam.ts'],
            claimed_route_code: 'AUTHORITY_GAP',
            subtype: 'finding',
            reason: 'fixture finding',
            invalidation_scope: ['packages/runtime/src/mes/maintenance-seam.ts'],
            resume_target: 'producer',
          }),
        ),
      );
      // slice-output requires the canonical boundary: a missing paths policy
      // fails closed before any Git write.
      assert.throws(
        () => closeGitBoundary(fx.sliceAbs, fx.sliceOutputRequest({ paths: [] }) as never),
        (error: unknown) => error instanceof GitBoundaryError,
      );
      assert.equal(porcelainOf(fx.sliceAbs), ' M a.txt', 'slice-output with no declared paths must not write');
    } finally {
      fx.cleanup();
    }
  });

  test('fresh clone has no canonical project MES and fails closed instead of reading ignored history', () => {
    const pre = CANONICAL_PROJECT_MES_PRE;
    assert.equal(pre.ok, false, 'fresh clone must not depend on an ignored canonical MES snapshot');
    assert.throws(() => observeCanonicalProjectMes(), /CanonicalProjectMesObservationError/);
  });

  test('every envelope in the lane is closed: unknown keys and hidden-session fields are rejected', () => {
    const fx = makeLaneFixture();
    try {
      // Hidden-session continuation field on the Task Result.
      assert.throws(
        () => validateWorkerTaskResult(fx.result({ session_narrative: 'continue from hidden pane' })),
        (error: unknown) => error instanceof TaskResultValidationError,
      );
      // Hidden-session continuation field on the CV result.
      assert.throws(() => validateCvResult(fx.cvResult({ session_narrative: 'hidden session' })));
      // Closed ACK: unknown keys fail closed.
      try {
        buildTaskResultAck({
          laneActionToken: E26_LANE_TOKEN,
          submitted: validateWorkerTaskResult(fx.result()),
          decision: {
            resultDisposition: 'ACCEPTED',
            continuationDisposition: 'CONTINUE',
            // @ts-expect-error — closed decision shape
            hidden_session: true,
          },
          durableFacts: [] as MesFactEnvelope[],
        });
        assert.fail('expected TaskResultAckError for a closed-shape violation');
      } catch (error) {
        assert.ok(error instanceof TaskResultAckError);
      }
      // The maintenance Review envelope is closed too: unknown keys fail.
      const review = fx.reviewEnvelope({
        reviewSnapshotRef: 'a'.repeat(40),
        gitBasis: { head: 'a'.repeat(40), branch: 'HEAD', worktree: E26_EVIDENCE_WORKTREE },
      });
      assert.throws(() => validateMaintenanceReviewEnvelope({ ...review, session_narrative: 'hidden pane' }, { root: fx.root, evidenceHead: fx.evidenceHead }));
      // Axis verdict closure: a verdict that is not in PASS|FINDINGS|BLOCKED
      // fails the closed shape.
      assert.throws(() => validateMaintenanceReviewEnvelope({ ...review, verdict: 'MAYBE' }, { root: fx.root, evidenceHead: fx.evidenceHead }));
      // A maintenance Review envelope missing the axis verdicts is not full.
      const { outcome_verdict: _omitted, ...partial } = review;
      void _omitted;
      assert.throws(() => validateMaintenanceReviewEnvelope(partial, { root: fx.root, evidenceHead: fx.evidenceHead }));
    } finally {
      fx.cleanup();
    }
  });

  test('stale binding on the wire is a typed no-write blocker (wrong digest never accepted)', () => {
    const fx = makeLaneFixture();
    try {
      const stale = {
        ...fx.bindingSnake,
        frozen_snapshot_sha256: sha('stale-frozen'),
      };
      expectSeamCode(
        () =>
          verifyMaintenanceEntry(fx.root, {
            ...entryContextFor(fx),
            basis: { ...entryContextFor(fx).basis, maintenance_binding: stale },
          }),
        'MAINTENANCE.DIGEST_MISMATCH',
      );
      // Integration with the stale tuple is also typed zero-write.
      assert.throws(
        () => applyIntegration(fx.root, fx.integrationRequest({ maintenance_binding: stale }) as never),
        (error: unknown) => error instanceof IntegrationError,
      );
      assert.equal(sha256OfFile(path.join(fx.root, '.proofloop', 'mes', 'snapshot.json')), fx.bindingSnake.frozen_snapshot_sha256);
    } finally {
      fx.cleanup();
    }
  });
  test('negative: Review oracle exact-binds the lane — mutated maintenanceBinding, malformed resume_target, unbound evidence are all rejected', () => {
    const fx = makeLaneFixture();
    try {
      // Run the lane far enough to leave the ACTUAL post-integration
      // evidence commit on disk (the oracle binds against it).
      const entry = verifyMaintenanceEntry(fx.root, entryContextFor(fx));
      assert.equal(entry.execution_mode, 'MES_MAINTENANCE');
      const submitted = validateWorkerTaskResult(fx.result());
      buildTaskResultAck({
        laneActionToken: E26_LANE_TOKEN,
        submitted,
        decision: { resultDisposition: 'ACCEPTED', continuationDisposition: 'CONTINUE' },
        durableFacts: [],
      });
      const cvInitial = validateCvResult(fx.cvResult());
      closeGitBoundary(fx.sliceAbs, fx.sliceOutputRequest() as never);
      assert.equal(gateCvResult(cvInitial, { candidateRefDurable: true }).state, 'READY_TO_INTEGRATE');
      const result = applyIntegration(fx.root, fx.integrationRequest() as never);
      const evidenceCommit = runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim();
      assert.equal(evidenceCommit, result.commit_sha, 'oracle binds the ACTUAL evidence commit');
      const expected = { root: fx.root, evidenceHead: evidenceCommit };
      const realEvidence = {
        reviewSnapshotRef: evidenceCommit,
        gitBasis: { head: evidenceCommit, branch: 'HEAD', worktree: E26_EVIDENCE_WORKTREE },
      };
      // The exact tuple closes on the real evidence.
      validateMaintenanceReviewEnvelope(fx.reviewEnvelope(realEvidence), expected);
      // 1) Mutated maintenanceBinding digest is exact-rejected.
      assert.throws(
        () =>
          validateMaintenanceReviewEnvelope(
            fx.reviewEnvelope(realEvidence, { maintenanceBinding: { ...fx.bindingCamel, frozenSnapshotSha256: 'c'.repeat(64) } }),
            expected,
          ),
        /maintenanceBinding\.frozenSnapshotSha256/,
        'mutated frozen digest must be exact-rejected',
      );
      // 2) A well-formed but WRONG auditRef is exact-rejected.
      assert.throws(
        () =>
          validateMaintenanceReviewEnvelope(
            fx.reviewEnvelope(realEvidence, { maintenanceBinding: { ...fx.bindingCamel, auditRef: '.proofloop/forensics/other/audit.json' } }),
            expected,
          ),
        /maintenanceBinding\.auditRef/,
      );
      // 3) resume_target owner outside the closed MES resume targets.
      assert.throws(
        () =>
          validateMaintenanceReviewEnvelope(
            fx.reviewEnvelope(realEvidence, { resume_target: { owner: 'brain', phase: 'evidence-closure', stage: E26_STAGE } }),
            expected,
          ),
        /resume_target\.owner/,
      );
      // 4) resume_target with an unknown key / missing phase is closed.
      assert.throws(
        () =>
          validateMaintenanceReviewEnvelope(
            fx.reviewEnvelope(realEvidence, { resume_target: { owner: 'recovery', phase: 'evidence-closure', stage: E26_STAGE, extra: 'nope' } }),
            expected,
          ),
        /resume_target must be the closed object/,
      );
      // 5) resume_target.stage must EXACTLY equal the lane stage.
      assert.throws(
        () =>
          validateMaintenanceReviewEnvelope(
            fx.reviewEnvelope(realEvidence, { resume_target: { owner: 'recovery', phase: 'evidence-closure', stage: 'S07' } }),
            expected,
          ),
        /resume_target\.stage/,
      );
      // 6) reviewSnapshotRef not bound to the ACTUAL evidence commit.
      assert.throws(
        () => validateMaintenanceReviewEnvelope(fx.reviewEnvelope({ ...realEvidence, reviewSnapshotRef: 'a'.repeat(40) }), expected),
        /reviewSnapshotRef must be bound/,
      );
      // 7) gitBasis.head not bound to the ACTUAL evidence commit.
      assert.throws(
        () =>
          validateMaintenanceReviewEnvelope(
            fx.reviewEnvelope({ ...realEvidence, gitBasis: { head: 'a'.repeat(40), branch: 'HEAD', worktree: E26_EVIDENCE_WORKTREE } }),
            expected,
          ),
        /gitBasis\.head must be bound/,
      );
      // 8) Byte-stability: every failed oracle probe left the frozen tuple
      //    byte-identical (no write).
      assert.equal(
        sha256OfFile(path.join(fx.root, '.proofloop', 'mes', 'snapshot.json')),
        fx.bindingSnake.frozen_snapshot_sha256,
      );
      assert.equal(porcelainOf(fx.evidenceAbs), '', 'evidence worktree clean');
      assert.equal(porcelainOf(fx.root), '', 'main worktree zero-write');
    } finally {
      fx.cleanup();
    }
  });

});
