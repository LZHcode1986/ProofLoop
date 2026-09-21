/**
 * E2E-26 `MES_MAINTENANCE` executable lane fixtures (S06-R-D-T02, isolated
 * fixture roots only — never the real `.proofloop/mes`).
 *
 * Builds the exact entry tuple (frozen snapshot/forensic/audit/quarantine/
 * recovery candidate Plan) plus the evidence-only lane envelopes (packet /
 * Task Result / ACK / CV / Integration request / maintenance Review), and
 * read-only helpers for the REAL frozen project snapshot (used ONLY to prove
 * byte-stability: real `.proofloop/mes` is never a mutation target — E2E-24/
 * 25/26).
 *
 * The chain is Git + canonical Authority/Plan + immutable forensic/audit/
 * frozen-source structured Link evidence (§2.1.5 / §4.2 / §5.1.2 / §5.3):
 * no MES `work_id` / `result_ref` / PVR / PA / recovery baseline, no second
 * store, no ack log, no NORMAL `INTEGRATED` / `STAGE_ACCEPTED`.
 *
 * The candidate is a REAL isolated fixture dirty set (a tracked file
 * modified in a DETACHED slice worktree, uncommitted). The durable canonical
 * candidate ref `proofloop-s06-r-d` is NEVER pre-created by the fixture: it
 * is established only by the canonical Runtime slice-output boundary
 * (`closeGitBoundary`) in the lane test. A second detached evidence worktree
 * is the mechanical Integration target (maintenance evidence lane).
 *
 * `rehydrateLane(root)` re-derives the complete lane state purely from the
 * persisted Plan/forensic/Git facts (disk files + Git refs/commits) with no
 * in-session state, so a fresh process (restart / lost-ACK) rebuilds the
 * same evidence deterministically.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { makeFixture, commitAll, type Fixture } from '../helpers';
import type { MesGitBasis } from '../../dist/mes/types';
import { MES_RESUME_TARGETS } from '../../dist/mes/types';
import type { WorkPacketMaintenanceBinding } from '../../dist/execute/work-packet';
import type { TaskResultMaintenanceBinding } from '../../dist/execute/task-result';
import type { CvMaintenanceBinding } from '../../dist/execute/cv-result';

export const E26_STAGE = 'S06';
export const E26_SLICE = 'S06-R-D';
export const E26_LANE_TOKEN = 'b4667878-09ee-4f16-94c6-eb31f97e115c';
export const E26_PLAN_REF = 'delivery/stages/S06/recovery-plan-r9.md';
/**
 * Fixture recovery candidate Thin Plan: carries the exact machine markers the
 * maintenance entry seam binds (RECOVERY_REBASELINE / MES_MAINTENANCE /
 * candidate_plan_ref self-identity), committed so the byte-fresh check closes.
 */
export const E26_RECOVERY_CANDIDATE_PLAN = [
  '# S06 Recovery Candidate Thin Plan (fixture)',
  'execution_mode: RECOVERY_REBASELINE',
  'executable_execution_mode: MES_MAINTENANCE',
  'candidate_plan_ref: delivery/stages/S06/recovery-plan-r9.md',
  '',
].join('\n');
/** The isolated DETACHED slice worktree that carries the real candidate dirty set. */
export const E26_SLICE_WORKTREE = '.proofloop/worktrees/slice';
/** The isolated DETACHED maintenance evidence worktree (mechanical Integration target). */
export const E26_EVIDENCE_WORKTREE = '.proofloop/worktrees/evidence';
export const E26_CANDIDATE_REF = 'proofloop-s06-r-d';
/**
 * Canonical MES projection of the maintenance lane slice identity (the MES
 * git-fact schema only admits `S06-RD`-shaped ids; `S06-R-D` is the
 * recovery-lane id and is REFUSED by the canonical schema — evidence-only).
 */
export const E26_CANONICAL_SLICE = 'S06-RD' as const;
export const E26_AUTHORITY_REFS = [
  'tech-spec/contracts.md#/entities/mes-maintenance-recovery-boundary',
  'tech-spec/acceptance.md#E2E-26',
];

export function sha256OfFile(abs: string): string {
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/** A 130-fact synthetic frozen snapshot (fixture-only). */
export function frozenSnapshotJson(): string {
  const facts = [];
  for (let index = 0; index < 130; index += 1) {
    facts.push({
      schema_version: 2,
      fact_id: `mes:fact:fixture:${String(index).padStart(3, '0')}`,
      fact_kind: index < 7 ? 'work' : 'project',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.1.2'],
    });
  }
  return JSON.stringify({ schema_version: 2, facts }, null, 2);
}

/** The closed snake_case maintenance binding (packet §4.2). */
export function snakeBindingOf(root: string): WorkPacketMaintenanceBinding {
  return {
    frozen_snapshot_ref: '.proofloop/mes/snapshot.json',
    frozen_snapshot_sha256: sha256OfFile(path.join(root, '.proofloop', 'mes', 'snapshot.json')),
    frozen_fact_count: 130,
    forensic_ref: '.proofloop/forensics/mes-recovery-fixture-001/incident.json',
    forensic_sha256: sha256OfFile(path.join(root, '.proofloop', 'forensics', 'mes-recovery-fixture-001', 'incident.json')),
    audit_ref: '.proofloop/forensics/mes-recovery-fixture-001/audit.json',
    audit_sha256: sha256OfFile(path.join(root, '.proofloop', 'forensics', 'mes-recovery-fixture-001', 'audit.json')),
  };
}

/** The closed camelCase maintenanceBinding (Task Result / CV result). */
export function camelBindingOf(root: string): TaskResultMaintenanceBinding & CvMaintenanceBinding {
  const snake = snakeBindingOf(root);
  return {
    frozenSnapshotRef: snake.frozen_snapshot_ref,
    frozenSnapshotSha256: snake.frozen_snapshot_sha256,
    frozenFactCount: snake.frozen_fact_count,
    forensicRef: snake.forensic_ref,
    forensicSha256: snake.forensic_sha256,
    auditRef: snake.audit_ref,
    auditSha256: snake.audit_sha256,
  };
}

/**
 * The durable lane state, all derived from disk + Git facts only. `base` is
 * the candidate base (the commit the candidate diff sits on); `evidenceHead`
 * is the evidence worktree HEAD BEFORE integration (derived as the parent of
 * the integration commit on rehydrate); `evidenceHeadAfter` is the evidence
 * worktree HEAD AFTER integration.
 */
export interface LaneState {
  readonly root: string;
  readonly sliceAbs: string;
  readonly evidenceAbs: string;
  readonly evidenceRel: string;
  readonly mainBranch: string;
  readonly base: string;
  readonly sliceHead: string;
  readonly evidenceHead: string;
  readonly candidateSha: string | null;
  readonly bindingSnake: WorkPacketMaintenanceBinding;
  readonly bindingCamel: TaskResultMaintenanceBinding;
}

/** The maintenance Review evidence bound to the ACTUAL lane Git facts. */
export interface MaintenanceReviewEvidence {
  /** Git candidate/integration evidence snapshot (the evidence commit). */
  readonly reviewSnapshotRef: string;
  /** The evidence worktree basis AFTER integration. */
  readonly gitBasis: MesGitBasis;
}

export interface LaneFixture extends LaneState {
  packet(overrides?: Record<string, unknown>): Record<string, unknown>;
  result(overrides?: Record<string, unknown>): Record<string, unknown>;
  cvResult(overrides?: Record<string, unknown>): Record<string, unknown>;
  integrationRequest(overrides?: Record<string, unknown>): Record<string, unknown>;
  sliceOutputRequest(overrides?: Record<string, unknown>): Record<string, unknown>;
  /** Full canonical maintenance Review envelope bound to real lane Git facts. */
  reviewEnvelope(evidence: MaintenanceReviewEvidence, overrides?: Record<string, unknown>): Record<string, unknown>;
  cleanup(): void;
}

/** Build the shared closed lane envelopes from a derived lane state. */
function binderFor(state: LaneState): Pick<
  LaneFixture,
  | 'packet'
  | 'result'
  | 'cvResult'
  | 'integrationRequest'
  | 'sliceOutputRequest'
  | 'reviewEnvelope'
> {
  const {
    root,
    evidenceRel,
    mainBranch,
    base,
    sliceHead,
    evidenceHead,
    bindingSnake,
    bindingCamel,
  } = state;
  const gitBasis = (): MesGitBasis => ({
    head: evidenceHead,
    branch: 'HEAD',
    worktree: evidenceRel,
  });

  const packet = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    execution_mode: 'MES_MAINTENANCE',
    target_agent: 'worker',
    caller: 'brain',
    skill: 'proofloop-execute',
    stage_id: E26_STAGE,
    slice_id: E26_SLICE,
    project_root: root,
    thin_plan_ref: E26_PLAN_REF,
    authority_refs: E26_AUTHORITY_REFS,
    actionToken: E26_LANE_TOKEN,
    code_anchors: ['packages/runtime/src/mes/maintenance-seam.ts'],
    git_basis: { worktree: E26_SLICE_WORKTREE, base_ref: base },
    scope: {
      allowed_paths: ['packages/runtime/src/mes/maintenance-seam.ts'],
      forbidden_paths: ['.git', '.proofloop'],
    },
    required_skills: ['worker'],
    slice_task_ids: ['S06-R-D-T01', 'S06-R-D-T03', 'S06-R-D-T04', 'S06-R-D-T02'],
    stop_conditions: ['binding is stale', 'quarantine breaks'],
    expected_result: 'SLICE_CANDIDATE_READY',
    maintenance_binding: bindingSnake,
    ...overrides,
  });

  const result = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    executionMode: 'MES_MAINTENANCE',
    stageId: E26_STAGE,
    sliceId: E26_SLICE,
    taskId: 'S06-R-D-T01',
    outcome: 'completed',
    changedFiles: ['packages/runtime/src/mes/maintenance-seam.ts'],
    verificationRuns: ['node --test packages/runtime/test-dist/mes-maintenance-seam.test.js'],
    summary: 'maintenance lane evidence-only Task Result (fixture)',
    planRef: E26_PLAN_REF,
    authorityRefs: E26_AUTHORITY_REFS,
    gitBasis: { head: sliceHead, branch: 'HEAD', worktree: E26_SLICE_WORKTREE },
    actionToken: E26_LANE_TOKEN,
    resultId: 'result-e26-t01',
    maintenanceBinding: bindingCamel,
    ...overrides,
  });

  const cvResult = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    execution_mode: 'MES_MAINTENANCE',
    actionToken: E26_LANE_TOKEN,
    verdict: 'PASS',
    stage_id: E26_STAGE,
    slice_id: E26_SLICE,
    verification_type: 'initial',
    planRef: E26_PLAN_REF,
    authorityRefs: E26_AUTHORITY_REFS,
    gitBasis: { head: sliceHead, candidateRef: E26_CANDIDATE_REF, diffRef: 'packages/runtime/slice-s06-r-d.diff' },
    summary: 'maintenance lane CV evidence (fixture)',
    acceptance_refs_checked: ['tech-spec/acceptance.md#E2E-26'],
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
    claimed_route_code: null,
    maintenanceBinding: bindingCamel,
    ...overrides,
  });

  const integrationRequest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    expected_head: evidenceHead,
    expected_branch: 'HEAD',
    stage: E26_STAGE,
    slice: 'R-D',
    candidate_ref: E26_CANDIDATE_REF,
    candidate_base_ref: base,
    paths: ['a.txt'],
    execution_mode: 'MES_MAINTENANCE',
    expected_worktree: E26_EVIDENCE_WORKTREE,
    maintenance_binding: bindingSnake,
    ...overrides,
  });

  const sliceOutputRequest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    boundary_type: 'slice-output',
    stage: E26_STAGE,
    slice: 'R-D',
    expected_head: sliceHead,
    expected_branch: 'HEAD',
    paths: ['a.txt'],
    ...overrides,
  });

  /**
   * Full canonical maintenance Review envelope (stage-review.md schema):
   * three axis verdicts (outcome/composition/authority), mode/scope binding,
   * the exact maintenance binding and a gitBasis/reviewSnapshotRef bound to
   * the ACTUAL post-integration lane Git facts (never a fixture placeholder).
   */
  const reviewEnvelope = (
    evidence: MaintenanceReviewEvidence,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    protocol: 'proofloop-execute',
    type: 'STAGE_REVIEW_RESULT',
    actionToken: E26_LANE_TOKEN,
    verdict: 'PASS',
    outcome_verdict: 'PASS',
    composition_verdict: 'PASS',
    authority_verdict: 'PASS',
    verification_type: 'initial',
    stage: E26_STAGE,
    review_scope: 'maintenance',
    execution_mode: 'MES_MAINTENANCE',
    planRef: E26_PLAN_REF,
    authorityRefs: E26_AUTHORITY_REFS,
    maintenanceBinding: bindingCamel,
    gitBasis: evidence.gitBasis,
    reviewSnapshotRef: evidence.reviewSnapshotRef,
    claimed_route_code: null,
    subtype: 'review-pass',
    finding_id: 'none',
    finding_evidence_refs: [],
    affected_stage: E26_STAGE,
    affected_outcomes: [],
    affected_artifacts: [],
    evidence: 'maintenance Review PASS is evidence-only — never a Stage acceptance',
    suggested_owner: 'stage-reviewer',
    invalidation_scope: [],
    resume_target: { owner: 'recovery', phase: 'evidence-closure', stage: E26_STAGE },
    ...overrides,
  });

  return {
    packet,
    result,
    cvResult,
    integrationRequest,
    sliceOutputRequest,
    reviewEnvelope,
  };
}

function seedFixtureRoot(fixture: Fixture): { base: string; mainBranch: string } {
  fixture.write('.proofloop/mes/snapshot.json', frozenSnapshotJson());
  fixture.write(
    '.proofloop/forensics/mes-recovery-fixture-001/incident.json',
    JSON.stringify({ incident: 's06-binding-mismatch-fixture', ref: 'mes:result:S06:planning-verification:1' }, null, 2),
  );
  fixture.write(
    '.proofloop/forensics/mes-recovery-fixture-001/audit.json',
    JSON.stringify({ audit: 'read-only relational audit fixture', misbound: 7 }, null, 2),
  );
  fixture.write(E26_PLAN_REF, E26_RECOVERY_CANDIDATE_PLAN);
  fixture.write('a.txt', 'base-a\n');
  fixture.write('b.txt', 'base-b\n');
  commitAll(fixture, 'base');
  const base = fixture.head();
  const mainBranch = fixture.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  return { base, mainBranch };
}

/**
 * Build an isolated maintenance lane fixture: trust root with the frozen
 * tuple + recovery candidate Plan; a DETACHED slice worktree carrying the
 * REAL candidate dirty set (tracked `a.txt` modified, uncommitted); a
 * DETACHED evidence worktree at the candidate base (clean); `.proofloop/mes`
 * quarantined to 0555. The canonical candidate ref does NOT exist yet.
 */
export function makeLaneFixture(): LaneFixture {
  const fixture: Fixture = makeFixture();
  const { base, mainBranch } = seedFixtureRoot(fixture);

  // Physical quarantine AFTER seeding: `.proofloop/mes` becomes mode 0555.
  fs.chmodSync(path.join(fixture.dir, '.proofloop', 'mes'), 0o555);

  // Detached slice worktree at the candidate base with the REAL dirty set.
  fixture.run(['worktree', 'add', '--detach', E26_SLICE_WORKTREE, base]);
  const sliceAbs = path.join(fixture.dir, E26_SLICE_WORKTREE);
  fs.writeFileSync(path.join(sliceAbs, 'a.txt'), 'candidate-a\n', 'utf8');
  const sliceHead = fixture.run(['rev-parse', 'HEAD'], { cwd: sliceAbs }).trim();

  // Detached isolated evidence worktree at the candidate base (clean).
  fixture.run(['worktree', 'add', '--detach', E26_EVIDENCE_WORKTREE, base]);
  const evidenceAbs = path.join(fixture.dir, E26_EVIDENCE_WORKTREE);
  const evidenceHead = fixture.run(['rev-parse', 'HEAD'], { cwd: evidenceAbs }).trim();
  const root = fixture.dir;

  const state: LaneState = {
    root,
    sliceAbs,
    evidenceAbs,
    evidenceRel: E26_EVIDENCE_WORKTREE,
    mainBranch,
    base,
    sliceHead,
    evidenceHead,
    candidateSha: null,
    bindingSnake: snakeBindingOf(root),
    bindingCamel: camelBindingOf(root),
  };

  return {
    ...state,
    ...binderFor(state),
    cleanup: () => {
      try {
        fs.chmodSync(path.join(fixture.dir, '.proofloop', 'mes'), 0o755);
      } catch {
        /* already gone */
      }
      fixture.cleanup();
    },
  };
}

/**
 * Rehydrate the complete lane state from the PERSISTED Plan/forensic/Git
 * facts ONLY (disk files + Git refs/commits) — a fresh-process restart with
 * no in-session state. The pre-integration evidence HEAD is derived as the
 * parent of the integration commit; the candidate base as the parent of the
 * durable candidate ref; the binding tuple from the immutable files.
 */
export function rehydrateLane(root: string): Omit<LaneFixture, 'cleanup'> {
  const evidenceAbs = path.join(root, E26_EVIDENCE_WORKTREE);
  const sliceAbs = path.join(root, E26_SLICE_WORKTREE);
  const evidenceHead = runGitQuiet(evidenceAbs, ['rev-parse', 'HEAD^']).trim();
  let candidateSha: string | null = null;
  try {
    candidateSha = runGitQuiet(root, ['rev-parse', '--verify', `${E26_CANDIDATE_REF}^{commit}`]).trim();
  } catch {
    candidateSha = null;
  }
  const base = candidateSha === null
    ? evidenceHead
    : runGitQuiet(root, ['rev-parse', `${E26_CANDIDATE_REF}^{commit}^`]).trim();
  // The slice worktree HEAD at submission time is the candidate base (the
  // commit the dirty candidate diff sat on) — a Git fact, not session state.
  const sliceHead = base;
  const mainBranch = runGitQuiet(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  const state: LaneState = {
    root,
    sliceAbs,
    evidenceAbs,
    evidenceRel: E26_EVIDENCE_WORKTREE,
    mainBranch,
    base,
    sliceHead,
    evidenceHead,
    candidateSha,
    bindingSnake: snakeBindingOf(root),
    bindingCamel: camelBindingOf(root),
  };
  return { ...state, ...binderFor(state) };
}

/**
 * Closed-shape validation of the FULL canonical maintenance Review envelope
/**
 * The ACTUAL lane facts the maintenance Review oracle exact-binds: the
 * fixture root (immutable files re-derive the exact frozen/forensic/audit
 * tuple) and the ACTUAL post-integration evidence HEAD. A Review envelope is
 * never accepted on shape alone.
 */
export interface MaintenanceReviewExpected {
  readonly root: string;
  readonly evidenceHead: string;
}

export function validateMaintenanceReviewEnvelope(value: unknown, expected: MaintenanceReviewExpected): Record<string, unknown> {
  // The oracle EXACT-binds the maintenance lane: a valid expected evidence
  // HEAD and root are required up front (never a fixture placeholder).
  if (typeof expected !== 'object' || expected === null) {
    throw new Error('the exact-bound Review oracle requires expected lane facts (root + evidenceHead)');
  }
  if (typeof expected.root !== 'string' || expected.root.length === 0) {
    throw new Error('expected.root must be a non-empty fixture root');
  }
  if (typeof expected.evidenceHead !== 'string' || !/^[0-9a-f]{40}$/.test(expected.evidenceHead)) {
    throw new Error('expected.evidenceHead must be a 40-char lowercase hex commit SHA');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('maintenance Review envelope must be an object');
  }
  const record = value as Record<string, unknown>;
  const KNOWN = new Set([
    'protocol',
    'type',
    'actionToken',
    'verdict',
    'outcome_verdict',
    'composition_verdict',
    'authority_verdict',
    'verification_type',
    'stage',
    'review_scope',
    'execution_mode',
    'planRef',
    'authorityRefs',
    'maintenanceBinding',
    'gitBasis',
    'reviewSnapshotRef',
    'claimed_route_code',
    'subtype',
    'finding_id',
    'finding_evidence_refs',
    'affected_stage',
    'affected_outcomes',
    'affected_artifacts',
    'evidence',
    'suggested_solution',
    'reason',
    'suggested_owner',
    'invalidation_scope',
    'resume_target',
  ]);
  const unknown = Object.keys(record).filter((key) => !KNOWN.has(key));
  if (unknown.length > 0) {
    throw new Error(`maintenance Review envelope carries unknown field(s): ${unknown.map((k) => JSON.stringify(k)).join(', ')}`);
  }
  const REQUIRE = [
    'actionToken',
    'verdict',
    'outcome_verdict',
    'composition_verdict',
    'authority_verdict',
    'verification_type',
    'stage',
    'review_scope',
    'execution_mode',
    'planRef',
    'authorityRefs',
    'maintenanceBinding',
    'gitBasis',
    'reviewSnapshotRef',
    'claimed_route_code',
    'subtype',
    'finding_id',
    'finding_evidence_refs',
    'affected_stage',
    'affected_outcomes',
    'affected_artifacts',
    'evidence',
    'suggested_owner',
    'invalidation_scope',
    'resume_target',
  ];
  for (const field of REQUIRE) {
    if (record[field] === undefined) {
      throw new Error(`maintenance Review envelope is missing required field ${JSON.stringify(field)}`);
    }
  }
  const verdicts = new Set(['PASS', 'FINDINGS', 'BLOCKED']);
  for (const axis of ['verdict', 'outcome_verdict', 'composition_verdict', 'authority_verdict'] as const) {
    if (!verdicts.has(record[axis] as string)) {
      throw new Error(`maintenance Review ${axis} must be one of PASS|FINDINGS|BLOCKED`);
    }
  }
  if (record.review_scope !== 'maintenance' && record.review_scope !== 'stage') {
    throw new Error('review_scope must be "stage" | "maintenance"');
  }
  if (record.execution_mode !== 'NORMAL' && record.execution_mode !== 'MES_MAINTENANCE') {
    throw new Error('execution_mode must be NORMAL | MES_MAINTENANCE');
  }
  if (record.review_scope === 'maintenance' && record.execution_mode !== 'MES_MAINTENANCE') {
    throw new Error('review_scope maintenance requires execution_mode MES_MAINTENANCE');
  }
  if (record.verification_type !== 'initial' && record.verification_type !== 'recheck') {
    throw new Error('verification_type must be "initial" | "recheck"');
  }
  if (record.planRef !== E26_PLAN_REF) {
    throw new Error(`maintenance Review planRef must be the recovery candidate ${E26_PLAN_REF}`);
  }
  const binding = record.maintenanceBinding as Record<string, unknown>;
  if (typeof binding !== 'object' || binding === null) {
    throw new Error('maintenanceBinding must be a closed object');
  }
  const BINDING_FIELDS = new Set([
    'frozenSnapshotRef',
    'frozenSnapshotSha256',
    'frozenFactCount',
    'forensicRef',
    'forensicSha256',
    'auditRef',
    'auditSha256',
  ]);
  for (const key of Object.keys(binding)) {
    if (!BINDING_FIELDS.has(key)) {
      throw new Error(`maintenanceBinding carries unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const digestField of ['frozenSnapshotSha256', 'forensicSha256', 'auditSha256'] as const) {
    if (typeof binding[digestField] !== 'string' || !/^[0-9a-f]{64}$/.test(binding[digestField] as string)) {
      throw new Error(`maintenanceBinding.${digestField} must be a 64-char lowercase hex sha256`);
    }
  }
  if (typeof binding.frozenFactCount !== 'number' || !Number.isInteger(binding.frozenFactCount) || (binding.frozenFactCount as number) <= 0) {
    throw new Error('maintenanceBinding.frozenFactCount must be a positive integer');
  }
  const gitBasis = record.gitBasis as Record<string, unknown>;
  if (typeof gitBasis !== 'object' || gitBasis === null) {
    throw new Error('gitBasis must be a closed object');
  }
  const basisKeys = Object.keys(gitBasis).sort();
  if (basisKeys.length !== 3 || basisKeys[0] !== 'branch' || basisKeys[1] !== 'head' || basisKeys[2] !== 'worktree') {
    throw new Error('gitBasis must be the closed object {head, branch, worktree}');
  }
  if (typeof gitBasis.head !== 'string' || !/^[0-9a-f]{40}$/.test(gitBasis.head)) {
    throw new Error('gitBasis.head must be a 40-char lowercase hex commit SHA');
  }
  if (typeof gitBasis.branch !== 'string' || gitBasis.branch.length === 0) {
    throw new Error('gitBasis.branch must be a non-empty branch identity');
  }
  if (typeof gitBasis.worktree !== 'string' || gitBasis.worktree.length === 0) {
    throw new Error('gitBasis.worktree must be a non-empty root-relative worktree identity');
  }
  if (typeof record.reviewSnapshotRef !== 'string' || !/^[0-9a-f]{40}$/.test(record.reviewSnapshotRef)) {
    throw new Error('reviewSnapshotRef must be a 40-char lowercase hex Git commit SHA');
  }
  const claim = record.claimed_route_code;
  const CV_CLAIMED = new Set([
    'IMPLEMENTATION_DEFECT',
    'PLAN_GAP',
    'TECHNICAL_UNKNOWN',
    'RUNTIME_BLOCKER',
    'USER_DECISION_REQUIRED',
    'EVIDENCE_GAP',
  ]);
  if (claim !== null && (typeof claim !== 'string' || !CV_CLAIMED.has(claim))) {
    throw new Error('claimed_route_code must be null or a closed CV route (AUTHORITY_GAP is never claimable)');
  }
  if (!Array.isArray(record.finding_evidence_refs)) {
    throw new Error('finding_evidence_refs must be an array');
  }
  if (record.verdict === 'PASS' && (record.finding_evidence_refs as unknown[]).length > 0) {
    throw new Error('PASS Review must carry an empty finding_evidence_refs');
  }
  if (record.verdict !== 'PASS' && (record.finding_evidence_refs as unknown[]).length === 0) {
    throw new Error('non-PASS Review must carry non-empty finding_evidence_refs');
  }
  // resume_target is a CLOSED object: exactly {owner, phase, stage}, owner in
  // the closed MES_RESUME_TARGETS set, non-empty phase and the EXACT
  // maintenance lane stage — an invalid owner / phase / stage is rejected.
  const resume = record.resume_target as Record<string, unknown>;
  if (typeof resume !== 'object' || resume === null || Array.isArray(resume)) {
    throw new Error('resume_target must be a closed object');
  }
  const resumeKeys = Object.keys(resume).sort();
  if (resumeKeys.length !== 3 || resumeKeys[0] !== 'owner' || resumeKeys[1] !== 'phase' || resumeKeys[2] !== 'stage') {
    throw new Error('resume_target must be the closed object {owner, phase, stage}');
  }
  if (typeof resume.owner !== 'string' || !(MES_RESUME_TARGETS as readonly string[]).includes(resume.owner)) {
    throw new Error(`resume_target.owner must be one of the closed MES resume targets: ${MES_RESUME_TARGETS.join(', ')}`);
  }
  if (typeof resume.phase !== 'string' || resume.phase.length === 0) {
    throw new Error('resume_target.phase must be a non-empty phase');
  }
  if (resume.stage !== E26_STAGE) {
    throw new Error(`resume_target.stage must EXACTLY equal the maintenance lane stage ${E26_STAGE}`);
  }
  // ---- Exact binding against the ACTUAL lane facts (post-integration
  // evidence): the maintenanceBinding tuple, reviewSnapshotRef and gitBasis
  // must be bound to the real lane evidence — a mutated digest / ref or an
  // unbound snapshot is rejected, never partially accepted.
  const exact = camelBindingOf(expected.root);
  const BINDING_EXACT: (keyof TaskResultMaintenanceBinding)[] = [
    'frozenSnapshotRef',
    'frozenSnapshotSha256',
    'frozenFactCount',
    'forensicRef',
    'forensicSha256',
    'auditRef',
    'auditSha256',
  ];
  for (const field of BINDING_EXACT) {
    if (binding[field] !== exact[field]) {
      throw new Error(`maintenanceBinding.${field} does not EXACTLY match the lane tuple (mutated digest/ref → rejected)`);
    }
  }
  if (gitBasis.head !== expected.evidenceHead) {
    throw new Error('gitBasis.head must be bound to the ACTUAL post-integration evidence HEAD');
  }
  if (gitBasis.branch !== 'HEAD') {
    throw new Error('maintenance gitBasis.branch must be the literal detached identity HEAD');
  }
  if (gitBasis.worktree !== E26_EVIDENCE_WORKTREE) {
    throw new Error('maintenance gitBasis.worktree must be the maintenance evidence worktree');
  }
  if (record.reviewSnapshotRef !== expected.evidenceHead) {
    throw new Error('reviewSnapshotRef must be bound to the ACTUAL post-integration evidence snapshot (the evidence commit)');
  }
  return record;
}

/** Porcelain status of a specific cwd (space-separated, sorted). */
export function porcelainOf(cwd: string): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const output = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  return output.split('\n').filter((line) => line.length > 0).sort().join('|');
}

/** Run a git command quietly in a given cwd and return stdout. */
export function runGitQuiet(cwd: string, args: readonly string[]): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/**
 * Canonical project/trust-root MES observation (PO-S06-E-04).
 *
 * The lane mutates isolated fixture roots only; the canonical project MES is
 * never a mutation target, only ever observed. The observation must be
 * EFFECTIVE from a Slice worktree too: there the local root carries no MES at
 * all, so the canonical root is resolved through Git (the common `.git`
 * directory belongs to the primary worktree owning the trust root) instead of
 * a worktree-relative path. An unobservable canonical MES is a typed, visible
 * failure — never a silent pass or skip. The lane's frozen snapshot /
 * forensic / audit identity keeps coming from its own durable fixture binding
 * (`makeLaneFixture`), never from this live observation.
 */
export class CanonicalProjectMesObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalProjectMesObservationError';
  }
}

const CANONICAL_PROJECT_MES_REL = path.join('.proofloop', 'mes', 'snapshot.json');

/** The primary worktree that owns the common `.git` directory. */
export function resolveCanonicalProjectRoot(): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch (error) {
    throw new CanonicalProjectMesObservationError(
      `cannot resolve the canonical project/trust root from ${__dirname}: ${(error as Error).message}`,
    );
  }
  if (commonDir.length === 0) {
    throw new CanonicalProjectMesObservationError('git reported an empty common directory');
  }
  return path.dirname(commonDir);
}

export interface CanonicalProjectMesObservation {
  readonly root: string;
  readonly path: string;
  readonly sha256: string;
  readonly factCount: number;
  readonly factIds: readonly string[];
}

/** Read-only observation of the canonical project MES (never a mutation target). */
export function observeCanonicalProjectMes(): CanonicalProjectMesObservation {
  const root = resolveCanonicalProjectRoot();
  const abs = path.join(root, CANONICAL_PROJECT_MES_REL);
  if (!fs.existsSync(abs)) {
    throw new CanonicalProjectMesObservationError(
      `the canonical project MES is not observable at ${abs} (canonical root ${root})`,
    );
  }
  const bytes = fs.readFileSync(abs);
  const parsed = JSON.parse(bytes.toString('utf8')) as { facts?: Array<{ fact_id?: unknown }> };
  if (!Array.isArray(parsed.facts)) {
    throw new CanonicalProjectMesObservationError(`the canonical project MES at ${abs} carries no fact array`);
  }
  return {
    root,
    path: abs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    factCount: parsed.facts.length,
    factIds: parsed.facts.map((fact) => String(fact.fact_id)),
  };
}
