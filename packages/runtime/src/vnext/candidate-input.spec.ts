import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  adaptCandidateInputToCompileVNextManifestInput,
  CandidateInputError,
} from './candidate-input';
import { compileVNextManifest } from './compiler';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeCandidate(): { readonly root: string; readonly input: Record<string, unknown> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-active-candidate-proof-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

  const planPath = 'delivery/stages/S08/tasks.md';
  const tasksPath = path.join(root, planPath);
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(
    tasksPath,
    [
      '<!-- proofloop:entity id="S08-goal" kind="goal" -->',
      'stage goal',
      '<!-- proofloop:entity id="S08-A-goal" kind="goal" -->',
      'slice goal',
      '<!-- proofloop:entity id="S08-A-T01" kind="task" -->',
      'task goal',
      '<!-- proofloop:entity id="S08-A-acceptance" kind="acceptance" -->',
      'acceptance',
      '<!-- proofloop:entity id="S08-A-seam" kind="seam" -->',
      'seam',
      '<!-- proofloop:entity id="S08-A-oracle" kind="oracle" -->',
      'oracle',
      '<!-- proofloop:entity id="S08-A-risk" kind="risk" -->',
      'risk',
      '<!-- proofloop:entity id="S08-RUNTIME-PROOF" kind="proof_spec" -->',
      'candidate-only proof specification',
    ].join('\n'),
    'utf8',
  );

  const entity = (ref_id: string, kind: string, entityId: string) => ({
    ref_id,
    kind,
    ref: `${planPath}#/entities/${entityId}`,
  });

  return {
    root,
    input: {
      schema_version: 2,
      mode: 'replan',
      caller: 'brain',
      owner: 'pluginv2-active-plan-materializer',
      project_root: root,
      stage_id: 'S08',
      candidate_plan_path: planPath,
      selected_work_item_refs: [`${planPath}#/entities/S08-A-goal`],
      authority_entity_refs: [`${planPath}#/entities/S08-A-acceptance`],
      existing_plan_ref: planPath,
      finding_refs: [],
      stage_goal: {
        entity_id: 'S08-goal',
        ref_id: 'REF-S08-GOAL',
        goal: 'Compile one explicit candidate-only Runtime Proof boundary.',
        refs: ['REF-S08-A-GOAL'],
      },
      dependencies: [],
      constraints: ['candidate-only'],
      out_of_scope: ['execution'],
      reference_index: [
        entity('REF-S08-GOAL', 'goal', 'S08-goal'),
        entity('REF-S08-A-GOAL', 'goal', 'S08-A-goal'),
        entity('REF-S08-A-T01', 'task', 'S08-A-T01'),
        entity('REF-S08-A-ACCEPTANCE', 'acceptance', 'S08-A-acceptance'),
        entity('REF-S08-A-SEAM', 'seam', 'S08-A-seam'),
        entity('REF-S08-A-ORACLE', 'oracle', 'S08-A-oracle'),
        entity('REF-S08-A-RISK', 'risk', 'S08-A-risk'),
        entity('REF-S08-RUNTIME-PROOF', 'proof_spec', 'S08-RUNTIME-PROOF'),
      ],
      slices: [
        {
          slice_id: 'S08-A',
          goal_entity_id: 'S08-A-goal',
          goal: 'Keep the Runtime Proof boundary structured and candidate-only.',
          proof_index: {
            slice_id: 'S08-A',
            goal_ref: 'REF-S08-A-GOAL',
            task_refs: ['REF-S08-A-T01'],
            acceptance_refs: ['REF-S08-A-ACCEPTANCE'],
            seam_refs: ['REF-S08-A-SEAM'],
            oracle_refs: ['REF-S08-A-ORACLE'],
            risk_refs: [
              {
                ref_id: 'REF-S08-A-RISK',
                applies_to_acceptance_refs: ['REF-S08-A-ACCEPTANCE'],
                applies_to_seam_refs: ['REF-S08-A-SEAM'],
              },
            ],
          },
          dependencies: [],
          required_skills: ['test-driven-development'],
          evidence_path: 'delivery/stages/S08/evidence/S08-A.md',
          tasks: [
            {
              task_id: 'S08-A-T01',
              entity_id: 'S08-A-T01',
              goal: 'Preserve a candidate-only Runtime Proof handoff.',
              refs: ['REF-S08-A-T01'],
              dependencies: ['S08-A'],
              required_skills: ['test-driven-development'],
              execution_scope: {
                kind: 'implementation',
                code_paths: ['packages/runtime/src/vnext/candidate-input.ts'],
                test_paths: ['packages/runtime/src/vnext/candidate-input.spec.ts'],
                forbidden_paths: ['.proofloop/receipts'],
              },
              checkbox: false,
              status: 'NOT_STARTED',
              cv_status: 'NOT_RUN',
            },
          ],
        },
      ],
    },
  };
}

describe('active candidate adapter — Runtime Proof removed from the candidate contract', () => {
  it('adapts a candidate without any Runtime Proof projection (field deleted)', () => {
    const { root, input } = makeCandidate();
    const adapted = adaptCandidateInputToCompileVNextManifestInput(input, root);

    // The Runtime Proof field is deleted: the adapted compiler input and the
    // compiled Manifest never carry runtime_proof.
    expect('runtime_proof' in adapted).toBe(false);
    expect(adapted.plan.items[2].execution_scope).toEqual(
      (input.slices as any)[0].tasks[0].execution_scope,
    );

    const compiled = compileVNextManifest(adapted);
    expect('runtime_proof' in compiled.manifest).toBe(false);
    expect(compiled.manifest.task_scopes['S08-A-T01'].execution_scope).toEqual(
      adapted.plan.items[2].execution_scope,
    );
  });

  it('rejects a candidate that still declares a runtime_proof section (closed schema)', () => {
    const { root, input } = makeCandidate();
    const legacy = JSON.parse(JSON.stringify(input)) as Record<string, any>;
    legacy.runtime_proof = {
      spec_refs: ['REF-S08-RUNTIME-PROOF'],
      resolved_steps: [{ not_applicable: { reason: 'candidate-only boundary' } }],
    };
    expect(() => adaptCandidateInputToCompileVNextManifestInput(legacy, root)).toThrowError(
      CandidateInputError,
    );
    expect(() => adaptCandidateInputToCompileVNextManifestInput(legacy, root)).toThrowError(
      /unknown field "runtime_proof"/,
    );
  });

  it('rejects missing, escaped, and forbidden-overlap execution scopes', () => {
    const { root, input } = makeCandidate();

    const missing = JSON.parse(JSON.stringify(input)) as Record<string, any>;
    delete missing.slices[0].tasks[0].execution_scope;
    expect(() => adaptCandidateInputToCompileVNextManifestInput(missing, root)).toThrowError(CandidateInputError);

    const escaped = JSON.parse(JSON.stringify(input)) as Record<string, any>;
    escaped.slices[0].tasks[0].execution_scope.code_paths = ['../outside.ts'];
    expect(() => adaptCandidateInputToCompileVNextManifestInput(escaped, root)).toThrowError(/canonical root-relative|escapes/);

    const overlap = JSON.parse(JSON.stringify(input)) as Record<string, any>;
    overlap.slices[0].tasks[0].execution_scope.forbidden_paths = ['packages/runtime'];
    expect(() => adaptCandidateInputToCompileVNextManifestInput(overlap, root)).toThrowError(/overlaps executable/);
  });
});

describe('S09-C-T03 — candidate parser rejects legacy stage labels before any read/write', () => {
  it('rejects a candidate whose stage_id is the parked S08B0 label', () => {
    const { root, input } = makeCandidate();
    const legacy = JSON.parse(JSON.stringify(input)) as Record<string, any>;
    legacy.stage_id = 'S08B0';
    legacy.candidate_plan_path = 'delivery/stages/S08B0/tasks.md';
    expect(() => adaptCandidateInputToCompileVNextManifestInput(legacy, root)).toThrowError(
      CandidateInputError,
    );
    expect(() => adaptCandidateInputToCompileVNextManifestInput(legacy, root)).toThrowError(
      /canonical Stage ID/,
    );
  });

  it('rejects a candidate whose stage_id is the parked S08B label', () => {
    const { root, input } = makeCandidate();
    const legacy = JSON.parse(JSON.stringify(input)) as Record<string, any>;
    legacy.stage_id = 'S08B';
    legacy.candidate_plan_path = 'delivery/stages/S08B/tasks.md';
    expect(() => adaptCandidateInputToCompileVNextManifestInput(legacy, root)).toThrowError(
      /canonical Stage ID/,
    );
  });
});
