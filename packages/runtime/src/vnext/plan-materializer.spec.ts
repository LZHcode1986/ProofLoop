/**
 * plan-materializer.spec.ts — A1 step 2: Runtime TypeScript port of the
 * active Plan Materializer deterministic rendering pipeline.
 *
 * The golden snapshot below is the byte-exact output of the active helper
 * (`.agents/skills/proofloop-plan/references/active-plan-materializer.mjs`,
 * kept untouched as the comparison baseline) rendered from the SAME closed
 * fixture.  The port must render byte-identically (sha256
 * a44c480ae9c49b7ba07568c7fce8951eb35134045139e25ded2ccf101507b759); any
 * drift is a blocking port defect.  Fixtures live under the gitignored
 * `.proofloop/tmp` and the untracked `delivery/stages/S99` stage dir, both
 * removed after the suite.
 */

import { createHash } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  materializeCandidatePlan,
  renderCandidatePlan,
  validateInput,
  validateRenderedDocument,
} from './plan-materializer';

const REPO_ROOT = fs.realpathSync(path.resolve(__dirname, '..', '..', '..', '..'));
const FIXTURE_DIR = '.proofloop/tmp/plan-materializer-spec';
const STAGE_ID = 'S99';
const PLAN_PATH = `delivery/stages/${STAGE_ID}/tasks.md`;
const STAGE_DIR = path.join(REPO_ROOT, 'delivery', 'stages', STAGE_ID);
const GOLDEN_SHA256 = 'a44c480ae9c49b7ba07568c7fce8951eb35134045139e25ded2ccf101507b759';

/** Byte-exact helper output for the fixture below (JSON-escaped snapshot). */
const GOLDEN_TASKS_MD = "# Stage S99 — candidate\n\n## Stage Goal\n<!-- proofloop:entity id=\"S99-goal\" kind=\"goal\" -->\nPort the active Plan Materializer rendering into Runtime TypeScript with byte-identical output.\n\n## Authority References\n### Selected Work Items\n- `tech-spec/task-acceptance-matrix.md#/entities/AWI-S99`\n### Authority Entity Refs\n- `delivery/stages/S0-A/tasks.md#/entities/S0-A-3-PO01`\n- `delivery/stages/S0-A/tasks.md#/entities/S0-A-3-seam`\n- `delivery/stages/S0-A/tasks.md#/entities/S0-A-3-oracle`\n- `delivery/stages/S0-A/tasks.md#/entities/S0-A-3-risk`\n\n## Stable Entity References\n- `REF-S99-GOAL` (goal) → `delivery/stages/S99/tasks.md#/entities/S99-goal`\n- `REF-S99-AWI` (goal) → `tech-spec/task-acceptance-matrix.md#/entities/AWI-S99`\n- `REF-S99-A-GOAL` (goal) → `delivery/stages/S99/tasks.md#/entities/S99-A-goal`\n- `REF-S99-A-T01` (task) → `delivery/stages/S99/tasks.md#/entities/S99-A-T01`\n- `REF-S99-ACCEPTANCE` (acceptance) → `delivery/stages/S0-A/tasks.md#/entities/S0-A-3-PO01`\n- `REF-S99-SEAM` (seam) → `delivery/stages/S0-A/tasks.md#/entities/S0-A-3-seam`\n- `REF-S99-ORACLE` (oracle) → `delivery/stages/S0-A/tasks.md#/entities/S0-A-3-oracle`\n- `REF-S99-RISK` (risk) → `delivery/stages/S0-A/tasks.md#/entities/S0-A-3-risk`\n- `REF-S99-A-ACCEPTANCE` (acceptance) → `delivery/stages/S99/tasks.md#/entities/S99-A-acceptance`\n- `REF-S99-A-SEAM` (seam) → `delivery/stages/S99/tasks.md#/entities/S99-A-seam`\n- `REF-S99-A-ORACLE` (oracle) → `delivery/stages/S99/tasks.md#/entities/S99-A-oracle`\n- `REF-S99-A-RISK` (risk) → `delivery/stages/S99/tasks.md#/entities/S99-A-risk`\n- `REF-S99-A-PROOF` (proof_spec) → `delivery/stages/S99/tasks.md#/entities/S99-A-proof`\n\n## Immutable Plan Projection\n- Stage/Slice/Task goals, stable ref_ids, Dependencies and Required Skills are immutable plan inputs.\n- Runtime computes authoritative `plan_digest` from this immutable projection.\n- This materializer does not write a digest, Manifest or admission fact.\n\n## Mutable Execution Projection\n- checkbox: `[ ]`\n- Worker Status: `NOT_STARTED`\n- Current CV Status: `NOT_RUN`\n- Mutable projection is excluded from Runtime `plan_digest`.\n\n## Dependencies\n- None\n\n## Constraints\n- Candidate-only; Runtime owns compilation and admission.\n\n## Out of Scope\n- Manifest, Evidence, Receipt and Worker/CV execution.\n\n## Candidate Boundary\n- plan_state: `CANDIDATE_ONLY`\n- Manifest: `NOT_GENERATED_BY_THIS_OWNER`\n- Evidence: `NOT_GENERATED_BY_THIS_OWNER`\n- Receipt/admission: `NOT_WRITTEN_BY_THIS_OWNER`\n- Worker/CV execution: `BLOCKED_PENDING_RUNTIME_ADMISSION`\n\n## Slice Graph\n- S99-A (depends on: none)\n\n## Slice S99-A — candidate\n<!-- SLICE:S99-A:BEGIN -->\n\n### Goal\n<!-- proofloop:entity id=\"S99-A-goal\" kind=\"goal\" -->\nThe Runtime TypeScript materializer emits a structurally closed candidate Slice without execution authority.\n\n### Proof Index References\n- slice_id: `S99-A`\n- goal_ref: `REF-S99-A-GOAL` (goal) → `delivery/stages/S99/tasks.md#/entities/S99-A-goal`\n- task_refs: `REF-S99-A-T01` (task) → `delivery/stages/S99/tasks.md#/entities/S99-A-T01`\n- acceptance_refs: `REF-S99-A-ACCEPTANCE` (acceptance) → `delivery/stages/S99/tasks.md#/entities/S99-A-acceptance`\n- seam_refs: `REF-S99-A-SEAM` (seam) → `delivery/stages/S99/tasks.md#/entities/S99-A-seam`\n- oracle_refs: `REF-S99-A-ORACLE` (oracle) → `delivery/stages/S99/tasks.md#/entities/S99-A-oracle`\n- risk_refs:\n  - ref_id: `REF-S99-A-RISK` (risk) → `delivery/stages/S99/tasks.md#/entities/S99-A-risk`\n    applies_to_acceptance_refs: `REF-S99-A-ACCEPTANCE`\n    applies_to_seam_refs: `REF-S99-A-SEAM`\n\n### Dependencies\n- None\n\n### Required Skills\n- `test-driven-development`\n\n### Tasks\n<!-- proofloop:entity id=\"S99-A-T01\" kind=\"task\" -->\n- [ ] S99-A-T01 — Render the candidate plan byte-identically and hand compilation to Runtime.\n  - refs: `REF-S99-A-T01`\n  - Dependencies: S99-A\n  - Required Skills: `test-driven-development`\n  - execution_scope: {\"kind\":\"implementation\",\"code_paths\":[\"packages/runtime/src/vnext/dispatch.ts\"],\"test_paths\":[\"packages/runtime/src/vnext/dispatch.spec.ts\"],\"forbidden_paths\":[\".proofloop/receipts\"]}\n\n### Task → Slice Closure\n- task `S99-A-T01` → slice `S99-A`\n  - goal_ref: `REF-S99-A-GOAL`\n  - task refs: `REF-S99-A-T01`\n  - slice task_refs: `REF-S99-A-T01`\n  - acceptance_refs: `REF-S99-A-ACCEPTANCE`\n  - seam_refs: `REF-S99-A-SEAM`\n  - oracle_refs: `REF-S99-A-ORACLE`\n  - risk_refs: `REF-S99-A-RISK`\n  - evidence_path: `delivery/stages/S99/evidence/S99-A.md`\n  - execution_scope: kind `implementation`, code_paths `packages/runtime/src/vnext/dispatch.ts`, test_paths `packages/runtime/src/vnext/dispatch.spec.ts`\n\n### Immutable Plan Projection\n- goal_ref: `REF-S99-A-GOAL`\n- task_refs: `REF-S99-A-T01`\n- Dependencies: none\n- Required Skills: `test-driven-development`\n\n### Mutable Execution Projection\n- checkbox: `[ ]`\n- Worker Status: `NOT_STARTED`\n- Current CV Status: `NOT_RUN`\n- `plan_digest` excludes this mutable projection.\n\n### Candidate Evidence Path\n- declared path only: `delivery/stages/S99/evidence/S99-A.md`\n- Evidence is not created by this owner.\n\n<!-- SLICE:S99-A:END -->\n\n## Candidate Entity Markers\n<!-- proofloop:entity id=\"S99-A-acceptance\" kind=\"acceptance\" -->\n- ref_id: `REF-S99-A-ACCEPTANCE` (acceptance) → `delivery/stages/S99/tasks.md#/entities/S99-A-acceptance`\n<!-- proofloop:entity id=\"S99-A-seam\" kind=\"seam\" -->\n- ref_id: `REF-S99-A-SEAM` (seam) → `delivery/stages/S99/tasks.md#/entities/S99-A-seam`\n<!-- proofloop:entity id=\"S99-A-oracle\" kind=\"oracle\" -->\n- ref_id: `REF-S99-A-ORACLE` (oracle) → `delivery/stages/S99/tasks.md#/entities/S99-A-oracle`\n<!-- proofloop:entity id=\"S99-A-risk\" kind=\"risk\" -->\n- ref_id: `REF-S99-A-RISK` (risk) → `delivery/stages/S99/tasks.md#/entities/S99-A-risk`\n<!-- proofloop:entity id=\"S99-A-proof\" kind=\"proof_spec\" -->\n- ref_id: `REF-S99-A-PROOF` (proof_spec) → `delivery/stages/S99/tasks.md#/entities/S99-A-proof`\n\n## Slice → Stage Closure\n- S99-A → S99 candidate goal only\n\n## Runtime Handoff\n- Runtime must compile and mechanically validate this candidate before fresh SPV.\n- No Worker/CV/Committer dispatch is authorized by this file.\n";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
afterAll(() => {
  try {
    fs.rmSync(path.join(REPO_ROOT, FIXTURE_DIR), { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function resetStage(): void {
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  cleanups.push(() => fs.rmSync(STAGE_DIR, { recursive: true, force: true }));
}

/** Closed candidate fixture (mirrors the baseline .mjs fixture exactly). */
function fixtureInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const entity = (ref_id: string, kind: string, ref: string) => ({ ref_id, kind, ref });
  const input: Record<string, unknown> = {
    schema_version: 2,
    mode: 'initial',
    caller: 'brain',
    owner: 'pluginv2-active-plan-materializer',
    project_root: REPO_ROOT,
    stage_id: STAGE_ID,
    candidate_plan_path: PLAN_PATH,
    selected_work_item_refs: ['tech-spec/task-acceptance-matrix.md#/entities/AWI-S99'],
    authority_entity_refs: [
      'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-PO01',
      'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-seam',
      'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-oracle',
      'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-risk',
    ],
    existing_plan_ref: null,
    finding_refs: [],
    stage_goal: {
      entity_id: 'S99-goal',
      ref_id: 'REF-S99-GOAL',
      goal: 'Port the active Plan Materializer rendering into Runtime TypeScript with byte-identical output.',
      refs: ['REF-S99-AWI'],
    },
    dependencies: [],
    constraints: ['Candidate-only; Runtime owns compilation and admission.'],
    out_of_scope: ['Manifest, Evidence, Receipt and Worker/CV execution.'],
    reference_index: [
      entity('REF-S99-GOAL', 'goal', `${PLAN_PATH}#/entities/S99-goal`),
      entity('REF-S99-AWI', 'goal', 'tech-spec/task-acceptance-matrix.md#/entities/AWI-S99'),
      entity('REF-S99-A-GOAL', 'goal', `${PLAN_PATH}#/entities/S99-A-goal`),
      entity('REF-S99-A-T01', 'task', `${PLAN_PATH}#/entities/S99-A-T01`),
      entity('REF-S99-ACCEPTANCE', 'acceptance', 'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-PO01'),
      entity('REF-S99-SEAM', 'seam', 'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-seam'),
      entity('REF-S99-ORACLE', 'oracle', 'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-oracle'),
      entity('REF-S99-RISK', 'risk', 'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-risk'),
      entity('REF-S99-A-ACCEPTANCE', 'acceptance', `${PLAN_PATH}#/entities/S99-A-acceptance`),
      entity('REF-S99-A-SEAM', 'seam', `${PLAN_PATH}#/entities/S99-A-seam`),
      entity('REF-S99-A-ORACLE', 'oracle', `${PLAN_PATH}#/entities/S99-A-oracle`),
      entity('REF-S99-A-RISK', 'risk', `${PLAN_PATH}#/entities/S99-A-risk`),
      entity('REF-S99-A-PROOF', 'proof_spec', `${PLAN_PATH}#/entities/S99-A-proof`),
    ],
    slices: [
      {
        slice_id: 'S99-A',
        goal_entity_id: 'S99-A-goal',
        goal: 'The Runtime TypeScript materializer emits a structurally closed candidate Slice without execution authority.',
        proof_index: {
          slice_id: 'S99-A',
          goal_ref: 'REF-S99-A-GOAL',
          task_refs: ['REF-S99-A-T01'],
          acceptance_refs: ['REF-S99-A-ACCEPTANCE'],
          seam_refs: ['REF-S99-A-SEAM'],
          oracle_refs: ['REF-S99-A-ORACLE'],
          risk_refs: [
            {
              ref_id: 'REF-S99-A-RISK',
              applies_to_acceptance_refs: ['REF-S99-A-ACCEPTANCE'],
              applies_to_seam_refs: ['REF-S99-A-SEAM'],
            },
          ],
        },
        dependencies: [],
        required_skills: ['test-driven-development'],
        evidence_path: 'delivery/stages/S99/evidence/S99-A.md',
        tasks: [
          {
            task_id: 'S99-A-T01',
            entity_id: 'S99-A-T01',
            goal: 'Render the candidate plan byte-identically and hand compilation to Runtime.',
            refs: ['REF-S99-A-T01'],
            dependencies: ['S99-A'],
            required_skills: ['test-driven-development'],
            execution_scope: {
              kind: 'implementation',
              code_paths: ['packages/runtime/src/vnext/dispatch.ts'],
              test_paths: ['packages/runtime/src/vnext/dispatch.spec.ts'],
              forbidden_paths: ['.proofloop/receipts'],
            },
            checkbox: false,
            status: 'NOT_STARTED',
            cv_status: 'NOT_RUN',
          },
        ],
      },
    ],
  };
  return { ...input, ...overrides };
}

function writeFixtureInput(overrides: Record<string, unknown> = {}): string {
  const inputPath = path.join(REPO_ROOT, FIXTURE_DIR, 'candidate.json');
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  fs.writeFileSync(inputPath, `${JSON.stringify(fixtureInput(overrides), null, 2)}\n`, 'utf8');
  return `${FIXTURE_DIR}/candidate.json`;
}

function readCandidateMarkdown(): string {
  return fs.readFileSync(path.join(REPO_ROOT, PLAN_PATH), 'utf8');
}

function expectFailure(result: ReturnType<typeof materializeCandidatePlan>): { subtype: string; reason: string; route_code: string } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected failure');
  return { subtype: result.subtype, reason: result.reason, route_code: result.route_code };
}

// ============================================================
// Byte-consistency against the active helper golden
// ============================================================

describe('plan-materializer byte consistency (A1 step 2)', () => {
  it('renders the closed fixture byte-identically to the .mjs golden snapshot', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, writeFixtureInput()), 'utf8')) as unknown;
    const plan = validateInput(raw);
    const rendered = renderCandidatePlan(plan);
    expect(rendered).toBe(GOLDEN_TASKS_MD);
    expect(createHash('sha256').update(rendered, 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
    expect(validateRenderedDocument(rendered, plan)).toBe(true);
  });

  it('materializeCandidatePlan writes the candidate tasks.md with the golden bytes (CANDIDATE_READY)', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    const result = materializeCandidatePlan(REPO_ROOT, inputPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toBe('CANDIDATE_READY');
    expect(result.stage_id).toBe(STAGE_ID);
    expect(result.candidate_plan_path).toBe(PLAN_PATH);
    expect(result.candidate_only).toBe(true);
    expect(result.writes).toEqual([PLAN_PATH]);
    expect(result.runtime_handoff).toEqual({
      manifest: 'DEFERRED_TO_RUNTIME',
      validator: 'DEFERRED_TO_RUNTIME',
      evidence_initializer: 'DEFERRED_TO_RUNTIME',
      spv: 'FRESH_DISPATCH_BY_BRAIN',
      admission: 'DEFERRED_TO_RUNTIME',
    });
    expect(readCandidateMarkdown()).toBe(GOLDEN_TASKS_MD);
  });
});

// ============================================================
// Render + check fail-closed behavior
// ============================================================

describe('plan-materializer fail-closed rendering', () => {
  it('initial mode refuses to overwrite an existing candidate (CANDIDATE_EXISTS)', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    expect(materializeCandidatePlan(REPO_ROOT, inputPath).ok).toBe(true);
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, inputPath));
    expect(failure.route_code).toBe('PLAN_GAP');
    expect(failure.subtype).toBe('CANDIDATE_EXISTS');
    expect(failure.reason).toBe('initial materialization will not overwrite an existing candidate; use mode: replan');
  });

  it('replan mode overwrites an existing candidate with golden bytes', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    expect(materializeCandidatePlan(REPO_ROOT, inputPath).ok).toBe(true);
    const replanPath = writeFixtureInput({ mode: 'replan', existing_plan_ref: PLAN_PATH });
    const result = materializeCandidatePlan(REPO_ROOT, replanPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toBe('CANDIDATE_READY');
    expect(readCandidateMarkdown()).toBe(GOLDEN_TASKS_MD);
  });

  it('rejects a forbidden closed-contract field (FORBIDDEN_PLAN_FIELD)', () => {
    resetStage();
    const input = fixtureInput({ manifest_path: '.proofloop/manifests/S99.json' });
    const inputPath = path.join(REPO_ROOT, FIXTURE_DIR, 'candidate.json');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, `${FIXTURE_DIR}/candidate.json`));
    expect(failure.subtype).toBe('FORBIDDEN_PLAN_FIELD');
    expect(failure.reason).toContain('manifest_path is outside the active candidate contract');
  });

  it('rejects a reference kind mismatch in a Proof Index (PROOF_INDEX_KIND_MISMATCH)', () => {
    resetStage();
    const input = fixtureInput();
    const references = input.reference_index as Array<Record<string, unknown>>;
    // REF-S99-A-T01 is bound as kind=task in the slice Proof Index; rebinding
    // it as goal must fail closed before any render.
    references[3].kind = 'goal';
    const inputPath = path.join(REPO_ROOT, FIXTURE_DIR, 'candidate.json');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, `${FIXTURE_DIR}/candidate.json`));
    expect(failure.subtype).toBe('PROOF_INDEX_KIND_MISMATCH');
    expect(failure.reason).toContain('expects task but REF-S99-A-T01 is goal');
  });

  it('rejects a slice dependency cycle (SLICE_DEPENDENCY_CYCLE)', () => {
    resetStage();
    const input = fixtureInput();
    const slices = input.slices as Array<Record<string, unknown>>;
    slices[0].dependencies = ['S99-A'];
    const inputPath = path.join(REPO_ROOT, FIXTURE_DIR, 'candidate.json');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, `${FIXTURE_DIR}/candidate.json`));
    expect(failure.subtype).toBe('SLICE_DEPENDENCY_CYCLE');
    expect(failure.reason).toContain('Slice dependency cycle includes S99-A');
  });

  it('rejects a multi-line array string (CANDIDATE_SCHEMA_INVALID, helper singleLine default)', () => {
    resetStage();
    const input = fixtureInput({ constraints: ['line one\nline two'] });
    const inputPath = path.join(REPO_ROOT, FIXTURE_DIR, 'candidate.json');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, `${FIXTURE_DIR}/candidate.json`));
    expect(failure.subtype).toBe('CANDIDATE_SCHEMA_INVALID');
    expect(failure.reason).toBe('input.constraints[0] must be a single line');
  });

  it('rejects an implementation task with empty code_paths (CANDIDATE_SCHEMA_INVALID)', () => {
    resetStage();
    const input = fixtureInput();
    const slices = input.slices as Array<Record<string, unknown>>;
    const tasks = slices[0].tasks as Array<Record<string, unknown>>;
    (tasks[0].execution_scope as Record<string, unknown>).code_paths = [];
    const inputPath = path.join(REPO_ROOT, FIXTURE_DIR, 'candidate.json');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, `${FIXTURE_DIR}/candidate.json`));
    expect(failure.subtype).toBe('CANDIDATE_SCHEMA_INVALID');
    expect(failure.reason).toContain('code_paths must be non-empty for implementation scope');
  });
});

// ============================================================
// check mode（CANDIDATE_CHECKED）+ rendered-document fail-closed
// ============================================================

describe('plan-materializer check mode and rendered-document validation', () => {
  it('check mode rechecks read-only and reports CANDIDATE_CHECKED without writes', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    expect(materializeCandidatePlan(REPO_ROOT, inputPath).ok).toBe(true);
    const before = readCandidateMarkdown();
    const result = materializeCandidatePlan(REPO_ROOT, inputPath, { check: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toBe('CANDIDATE_CHECKED');
    expect(result.writes).toEqual([]);
    expect(readCandidateMarkdown()).toBe(before);
  });

  it('check mode fails closed on a missing candidate (CANDIDATE_MISSING)', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    // Parent exists but the candidate tasks.md is missing: check must fail
    // closed with the .mjs-identical CANDIDATE_MISSING reason (readFileSync
    // path), never a partial result.
    fs.mkdirSync(STAGE_DIR, { recursive: true });
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, inputPath, { check: true }));
    expect(failure.route_code).toBe('RUNTIME_BLOCKER');
    expect(failure.subtype).toBe('CANDIDATE_MISSING');
    expect(failure.reason).toContain('candidate tasks.md is not readable');
  });

  it('missing entity marker fails closed (MISSING_ENTITY_MARKER)', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    expect(materializeCandidatePlan(REPO_ROOT, inputPath).ok).toBe(true);
    const tampered = readCandidateMarkdown().replace(
      '<!-- proofloop:entity id="S99-A-acceptance" kind="acceptance" -->\n',
      '',
    );
    fs.writeFileSync(path.join(REPO_ROOT, PLAN_PATH), tampered, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, inputPath, { check: true }));
    expect(failure.subtype).toBe('MISSING_ENTITY_MARKER');
    expect(failure.reason).toBe('missing entity marker acceptance:S99-A-acceptance');
  });

  it('duplicate entity marker fails closed (DUPLICATE_ENTITY_MARKER)', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    expect(materializeCandidatePlan(REPO_ROOT, inputPath).ok).toBe(true);
    const tampered = readCandidateMarkdown().replace(
      '<!-- proofloop:entity id="S99-A-seam" kind="seam" -->',
      '<!-- proofloop:entity id="S99-A-seam" kind="seam" -->\n<!-- proofloop:entity id="S99-A-seam" kind="seam" -->',
    );
    fs.writeFileSync(path.join(REPO_ROOT, PLAN_PATH), tampered, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, inputPath, { check: true }));
    expect(failure.subtype).toBe('DUPLICATE_ENTITY_MARKER');
    expect(failure.reason).toBe('duplicate entity marker S99-A-seam');
  });

  it('tampered Task → Slice Closure line fails closed (TASK_SLICE_CLOSURE_MISMATCH)', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    expect(materializeCandidatePlan(REPO_ROOT, inputPath).ok).toBe(true);
    const tampered = readCandidateMarkdown().replace(
      '  - acceptance_refs: `REF-S99-A-ACCEPTANCE`',
      '  - acceptance_refs: `REF-S99-A-ACCEPTANCE` (forged)',
    );
    fs.writeFileSync(path.join(REPO_ROOT, PLAN_PATH), tampered, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, inputPath, { check: true }));
    expect(failure.subtype).toBe('TASK_SLICE_CLOSURE_MISMATCH');
    expect(failure.reason).toContain('is not canonical');
  });

  it('duplicate Task → Slice Closure heading fails closed (TASK_SLICE_CLOSURE_MISMATCH)', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    expect(materializeCandidatePlan(REPO_ROOT, inputPath).ok).toBe(true);
    const tampered = readCandidateMarkdown().replace(
      '### Task → Slice Closure\n',
      '### Task → Slice Closure\n### Task → Slice Closure\n',
    );
    fs.writeFileSync(path.join(REPO_ROOT, PLAN_PATH), tampered, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, inputPath, { check: true }));
    expect(failure.subtype).toBe('TASK_SLICE_CLOSURE_MISMATCH');
    expect(failure.reason).toContain('heading must appear exactly once per Slice (found 2)');
  });

  it('tampered execution_scope projection fails closed (EXECUTION_SCOPE_MISMATCH)', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    expect(materializeCandidatePlan(REPO_ROOT, inputPath).ok).toBe(true);
    const tampered = readCandidateMarkdown().replace(
      '  - execution_scope: {"kind":"implementation",',
      '  - execution_scope: {"kind":"evidence-only",',
    );
    fs.writeFileSync(path.join(REPO_ROOT, PLAN_PATH), tampered, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, inputPath, { check: true }));
    expect(failure.subtype).toBe('EXECUTION_SCOPE_MISMATCH');
    expect(failure.reason).toBe('S99-A-T01 execution_scope is not preserved canonically');
  });

  it('tampering the Stage heading fails closed (CANDIDATE_SCHEMA_INVALID)', () => {
    resetStage();
    const inputPath = writeFixtureInput();
    expect(materializeCandidatePlan(REPO_ROOT, inputPath).ok).toBe(true);
    const tampered = readCandidateMarkdown().replace('# Stage S99 — candidate', '# Stage S99 — candidate (tampered)');
    fs.writeFileSync(path.join(REPO_ROOT, PLAN_PATH), tampered, 'utf8');
    const failure = expectFailure(materializeCandidatePlan(REPO_ROOT, inputPath, { check: true }));
    expect(failure.subtype).toBe('CANDIDATE_SCHEMA_INVALID');
    expect(failure.reason).toBe('candidate tasks.md has an invalid Stage heading');
  });
});
