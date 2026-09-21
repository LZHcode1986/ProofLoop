/**
 * Integration / cleanup lifecycle and failure-finding seam tests.
 *
 * # PO: PO-S03-E-02, PO-S03-E-03
 *
 * The tests use the existing closed MES envelope validator and temporary Git
 * facts.  They never write the production worktree or a second result store.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, commitAll } from './helpers';
import { createGitWorktree, removeGitWorktree } from '../dist/git-worktree';
import { IntegrationError } from '../dist/git-integration';
import {
  buildCandidateFact,
  validateCandidateFact,
  buildCleanupFact,
  buildIntegrationFact,
  buildIntegrationFailureFinding,
  buildCleanupFailureFinding,
  buildCleanupFailureAnomaly,
  validateCleanupFact,
  validateIntegrationFact,
  validateIntegrationTransition,
  IntegrationStateError,
  type IntegrationStateBinding,
} from '../dist/execute/integration-state';
import type { MesFactEnvelope, MesGitBasis, MesPlanBinding } from '../dist/mes/types';

const PLAN_BINDING: MesPlanBinding = {
  binding_stage: 'accepted',
  accepted_plan_ref: 'delivery/stages/S03/plan.md',
  source_candidate_plan_ref: 'delivery/stages/S03/plan.md',
  verification_result_ref: 'mes:result:S03:planning-verification-1',
  plan_digest: 'a'.repeat(64),
};
const GIT_BASIS: MesGitBasis = {
  head: 'b'.repeat(40),
  branch: 'worktree/quiet-stone-f275',
  worktree: '.proofloop/worktrees/S03-S03-E',
};
const BINDING: IntegrationStateBinding = {
  stage_id: 'S03',
  slice_id: 'S03-E',
  work_id: 'mes:work:S03:S03-E:1',
  authority_refs: ['tech-spec/contracts.md#5.3', 'tech-spec/acceptance.md#E2E-04'],
  plan_binding: PLAN_BINDING,
  git_basis: GIT_BASIS,
};
const GIT_FACTS = {
  candidate_ref: 'proofloop-s03-e',
  candidate_base_ref: 'c'.repeat(40),
  commit_sha: 'd'.repeat(40),
  changed_files: ['packages/runtime/src/execute/integration-state.ts'],
};

function candidateFact(overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return buildCandidateFact({
    ...BINDING,
    ...GIT_FACTS,
    fact_id: 'mes:fact:git:S03:S03-E:candidate',
    ...overrides,
  });
}

function integrationFact(overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return buildIntegrationFact({
    ...BINDING,
    ...GIT_FACTS,
    fact_id: 'mes:fact:git:S03:S03-E:integration',
    ...overrides,
  });
}

describe('integration-state lifecycle facts (PO-S03-E-02)', () => {
  test('constructs and validates candidate and INTEGRATED facts from the same Git payload', () => {
    const candidate = candidateFact();
    const integrated = integrationFact();
    assert.equal(candidate.fact_kind, 'git');
    assert.equal(candidate.git_subkind, 'candidate');
    assert.equal(integrated.git_subkind, 'integration');
    assert.equal(integrated.commit_sha, GIT_FACTS.commit_sha);
    assert.deepEqual(integrated.changed_files, GIT_FACTS.changed_files);
    assert.equal(integrated.candidate_ref, GIT_FACTS.candidate_ref);
    assert.equal(validateIntegrationFact(integrated).fact_id, integrated.fact_id);
    assert.equal(validateCandidateFact(candidate).git_subkind, 'candidate');
  });

  test('PO-S03-E-01/PO-S03-E-02 candidate_base_ref source equality', () => {
    const fixture = makeFixture();
    fixture.write('README.md', 'baseline\n');
    commitAll(fixture, 'baseline');
    let created: ReturnType<typeof createGitWorktree> | undefined;
    try {
      created = createGitWorktree(fixture.dir, { stage: 'S03', slice: 'E' });
      const candidate = buildCandidateFact({
        ...BINDING,
        ...GIT_FACTS,
        candidate_base_ref: created.base_ref,
        fact_id: 'mes:fact:git:S03:S03-E:candidate-from-worktree',
      });
      const integrated = buildIntegrationFact({
        ...BINDING,
        ...GIT_FACTS,
        candidate_base_ref: candidate.candidate_base_ref,
        fact_id: 'mes:fact:git:S03:S03-E:integration-from-candidate',
      });
      assert.equal(created.base_ref, candidate.candidate_base_ref);
      assert.equal(candidate.candidate_base_ref, integrated.candidate_base_ref);
    } finally {
      if (created !== undefined) removeGitWorktree(fixture.dir, { stage: 'S03', slice: 'E' });
      fixture.cleanup();
    }
  });

  test('binds an integration fact field-for-field to integration apply output', () => {
    const result = { ...GIT_FACTS, dirty_after: [] };
    const built = buildIntegrationFact({
      ...BINDING,
      fact_id: 'mes:fact:git:S03:S03-E:integration-from-result',
      integration_result: result,
    });
    assert.equal(built.commit_sha, GIT_FACTS.commit_sha);
    assert.deepEqual(built.changed_files, GIT_FACTS.changed_files);
    assert.throws(
      () => buildIntegrationFact({
        ...BINDING,
        fact_id: 'mes:fact:git:S03:S03-E:integration-result-drift',
        integration_result: { ...result, commit_sha: 'e'.repeat(40) },
        commit_sha: GIT_FACTS.commit_sha,
      }),
      IntegrationStateError,
    );
  });

  test('requires an exact accepted-plan/work/lane Git binding and rejects payload drift', () => {
    const integrated = integrationFact();
    assert.throws(
      () => validateIntegrationFact({ ...integrated, candidate_ref: 'proofloop-other' }),
      IntegrationStateError,
    );
    assert.throws(
      () => validateIntegrationFact({ ...integrated, changed_files: [...GIT_FACTS.changed_files, ...GIT_FACTS.changed_files] }),
      IntegrationStateError,
    );
    assert.throws(
      () => validateIntegrationFact({ ...integrated, scope: { stage_id: 'S03', slice_id: 'S03-A' } }),
      IntegrationStateError,
    );
  });

  test('validates CLEANUP_PENDING → CLEANED and preserves the INTEGRATED business milestone', () => {
    const integrated = integrationFact();
    const cleanup = buildCleanupFact({
      ...BINDING,
      ...GIT_FACTS,
      fact_id: 'mes:fact:git:S03:S03-E:cleanup',
      integration_fact: integrated,
    });
    assert.equal(validateCleanupFact(cleanup, integrated).git_subkind, 'cleanup');
    assert.equal(validateIntegrationTransition('INTEGRATED', 'CLEANUP_PENDING'), true);
    assert.equal(validateIntegrationTransition('CLEANUP_PENDING', 'CLEANED'), true);
    assert.equal(validateIntegrationTransition({ from: 'READY_TO_INTEGRATE', to: 'INTEGRATED' }), true);
    assert.throws(() => validateIntegrationTransition('INTEGRATED', 'EXECUTING'), IntegrationStateError);
    assert.throws(() => validateCleanupFact(cleanup, { ...integrated, commit_sha: 'e'.repeat(40) }), IntegrationStateError);
  });
  test('records cleanup failure as an anomaly while retaining INTEGRATED', () => {
    const integrated = integrationFact();
    const error = { code: 'WORKTREE.REMOVE_FAILED', message: 'worktree is still dirty' };
    const anomaly = buildCleanupFailureAnomaly({ integration_fact: integrated, error });
    assert.equal(anomaly.anomaly, 'cleanup');
    assert.equal(anomaly.state, 'INTEGRATED');
    assert.equal(anomaly.cleanup_pending, true);
    assert.equal(anomaly.integration_fact.commit_sha, integrated.commit_sha);
    const finding = buildCleanupFailureFinding({
      integration_fact: integrated,
      error,
      fact_id: 'mes:fact:finding:S03:S03-E:cleanup-1',
    });
    assert.equal(finding.fact_kind, 'finding');
    assert.ok(finding.finding_evidence_refs?.includes('WORKTREE.REMOVE_FAILED'));
  });
});

describe('main-worktree git_basis "." (S05 integration-state repair)', () => {
  test('accepts the canonical main-worktree git_basis.worktree "." for candidate/integration/cleanup facts', () => {
    const mainBasis = { ...GIT_BASIS, worktree: '.' };
    const candidate = buildCandidateFact({
      ...BINDING,
      git_basis: mainBasis,
      ...GIT_FACTS,
      fact_id: 'mes:fact:git:S03:S03-E:candidate-main',
    });
    assert.equal(candidate.git_basis?.worktree, '.');
    assert.equal(validateCandidateFact(candidate).git_basis?.worktree, '.');
    const integrated = buildIntegrationFact({
      ...BINDING,
      git_basis: mainBasis,
      ...GIT_FACTS,
      fact_id: 'mes:fact:git:S03:S03-E:integration-main',
    });
    assert.equal(integrated.git_basis?.worktree, '.');
    assert.equal(validateIntegrationFact(integrated).git_basis?.worktree, '.');
    const cleanup = buildCleanupFact({
      ...BINDING,
      git_basis: mainBasis,
      ...GIT_FACTS,
      fact_id: 'mes:fact:git:S03:S03-E:cleanup-main',
      integration_fact: integrated,
    });
    assert.equal(validateCleanupFact(cleanup, integrated).git_basis?.worktree, '.');
  });

  test('still rejects absolute, traversal, empty-segment, drive-prefix, backslash and control-char worktrees', () => {
    const invalidWorktrees = [
      '/abs/path',
      '//double-slash',
      '../escape',
      'a/../b',
      './rel',
      'a/./b',
      'a//b',
      'a/b/',
      'C:/drive',
      'a\\b',
      'a\nb',
    ];
    for (const worktree of invalidWorktrees) {
      assert.throws(
        () => buildIntegrationFact({
          ...BINDING,
          git_basis: { ...GIT_BASIS, worktree },
          ...GIT_FACTS,
          fact_id: 'mes:fact:git:S03:S03-E:integration-invalid-worktree',
        }),
        IntegrationStateError,
        `git_basis.worktree ${JSON.stringify(worktree)} must be rejected`
      );
    }
  });
});

describe('integration failure finding closure (PO-S03-E-03)', () => {
  test('turns a typed integration failure into a durable finding without rollback', () => {
    const integrated = integrationFact();
    const error = new IntegrationError(
      'INTEGRATION.CONFLICT',
      'candidate patch conflicts with the current Stage HEAD; no Git write was performed',
    );
    const finding = buildIntegrationFailureFinding({
      ...BINDING,
      integration_fact: integrated,
      error,
      fact_id: 'mes:fact:finding:S03:S03-E:integration-conflict-1',
    });
    assert.equal(finding.fact_kind, 'finding');
    assert.equal(finding.verifier_verdict, 'BLOCKED');
    assert.equal(finding.claimed_route_code, 'RUNTIME_BLOCKER');
    assert.equal(finding.scope?.stage_id, 'S03');
    assert.equal(finding.scope?.slice_id, 'S03-E');
    assert.equal(finding.plan_binding?.binding_stage, 'accepted');
    assert.equal(finding.work_id, BINDING.work_id);
    assert.deepEqual(finding.git_basis, BINDING.git_basis);
    assert.ok(finding.finding_evidence_refs?.some((ref) => ref.includes('INTEGRATION.CONFLICT')));
  });

  test('accepts a candidate Git fact as the pre-apply failure basis', () => {
    const finding = buildIntegrationFailureFinding({
      candidate_fact: candidateFact(),
      error: new IntegrationError('INTEGRATION.BASE_NOT_ANCESTOR', 'candidate base is stale'),
      fact_id: 'mes:fact:finding:S03:S03-E:base-1',
    });
    assert.equal(finding.scope?.slice_id, 'S03-E');
    assert.ok(finding.finding_evidence_refs?.includes('proofloop-s03-e'));
  });

  test('keeps the candidate/integration refs in the failure evidence and rejects non-integration errors', () => {
    const integrated = integrationFact();
    const finding = buildIntegrationFailureFinding({
      ...BINDING,
      integration_fact: integrated,
      error: new IntegrationError('INTEGRATION.HEAD_MISMATCH', 'expected head differs'),
      fact_id: 'mes:fact:finding:S03:S03-E:integration-head-1',
    });
    assert.ok(finding.finding_evidence_refs?.includes('proofloop-s03-e'));
    assert.throws(
      () => buildIntegrationFailureFinding({
        ...BINDING,
        integration_fact: integrated,
        error: new Error('untyped'),
        fact_id: 'mes:fact:finding:S03:S03-E:bad-1',
      }),
      IntegrationStateError,
    );
  });
});
