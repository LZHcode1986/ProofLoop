/**
 * vNext Contract Foundation — S0-A bootstrap tests.
 *
 * Proves:
 * - vNext valid Plan / Reference Index / Proof Index / Manifest pass;
 * - checkbox / Worker Status / Current CV Status changes keep a stable
 *   plan_digest; Goal / ref / dependency / Required Skill changes change it;
 * - fail-closed: unknown fields, missing fields, wrong discriminator, wrong
 *   kind, empty/duplicate ref_id, Proof Index pointing at unregistered refs,
 *   and risk bindings pointing at non-acceptance/non-seam refs all throw.
 */

import { describe, expect, it } from 'vitest';
import {
  SchemaValidationError,
  canonicalizePlanProjection,
  computeDigest,
  computePlanDigest,
  validateVNextManifest,
  validateVNextPlan,
  validateVNextProofIndex,
  validateVNextReferenceDescriptor,
  validateVNextReferenceIndex,
  type VNextReferenceKind,
} from '@proofloop/kernel';

// ============================================================
// Fixtures
// ============================================================

const FILE_DIGEST = 'a'.repeat(64);   // valid SHA-256 hex
const SECTION_DIGEST = 'b'.repeat(64); // valid SHA-256 hex
const PLAN_DIGEST = 'c'.repeat(64);    // valid SHA-256 hex

function digestObject(file = FILE_DIGEST, section = SECTION_DIGEST) {
  return (kind: string, ref: string) => ({
    kind,
    ref,
    file_digest: file,
    section_digest: section,
  });
}

function makeIndex(): Record<string, unknown> {
  const d = digestObject();
  return {
    'REF-001': d('goal', 'delivery/stages/S04/tasks.md#/entities/S04-A-goal'),
    'REF-002': d('task', 'delivery/stages/S04/tasks.md#/entities/S04-A-T01'),
    'REF-003': d('acceptance', 'PRD.md#/entities/FR-08-acceptance'),
    'REF-004': d('seam', 'tech-spec/contract-state-matrix.md#/entities/Plugin-Load-Contract'),
    'REF-005': d('oracle', 'tech-spec/contract-state-matrix.md#/entities/Plugin-Load-Verification'),
    'REF-006': d('risk', 'tech-spec/hard-parts-register.md#/entities/HP-006-cross-process-cleanup'),
  };
}

function makeProofIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slice_id: 'S04-A',
    goal_ref: 'REF-001',
    task_refs: ['REF-002'],
    acceptance_refs: ['REF-003'],
    seam_refs: ['REF-004'],
    oracle_refs: ['REF-005'],
    risk_refs: [
      {
        ref_id: 'REF-006',
        applies_to_acceptance_refs: ['REF-003'],
        applies_to_seam_refs: ['REF-004'],
      },
    ],
    ...overrides,
  };
}

function toRegistered(index: Record<string, unknown>): Map<string, VNextReferenceKind> {
  const map = new Map<string, VNextReferenceKind>();
  for (const key of Object.keys(index)) {
    map.set(key, (index[key] as { kind: VNextReferenceKind }).kind);
  }
  return map;
}

function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const reference_index = makeIndex();
  return {
    version: 2,
    stage_id: 'S04',
    plan: {
      ref: 'delivery/stages/S04/tasks.md',
      plan_digest: PLAN_DIGEST,
      schema_version: 2,
    },
    reference_index,
    authority_ref_ids: ['REF-003', 'REF-004', 'REF-005', 'REF-006'],
    task_scopes: {
      'S04-A-T01': {
        task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
        execution_scope: {
          kind: 'implementation',
          code_paths: ['packages/kernel/src/vnext/plan.ts'],
          test_paths: ['packages/kernel/src/vnext/vnext.spec.ts'],
          forbidden_paths: ['.proofloop/receipts'],
        },
      },
    },
    slices: [
      {
        slice_id: 'S04-A',
        proof_index: makeProofIndex(),
        required_skills: ['test-driven-development'],
        depends_on: [],
        evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
      },
    ],
    ...overrides,
  };
}

function makePlan(overrides: Record<string, unknown> = {}): any {
  return {
    schema_version: 2,
    items: [
      {
        id: 'S04-A-T01',
        kind: 'task',
        goal: 'Implement plugin load',
        refs: ['REF-002'],
        dependencies: [],
        required_skills: ['test-driven-development'],
        execution_scope: {
          kind: 'implementation',
          code_paths: ['packages/kernel/src/vnext/plan.ts'],
          test_paths: ['packages/kernel/src/vnext/vnext.spec.ts'],
          forbidden_paths: ['.proofloop/receipts'],
        },
        checkbox: false,
        status: 'pending',
        cv_status: 'NOT_STARTED',
      },
    ],
    ...overrides,
  };
}

function expectsFail(fn: () => unknown): void {
  expect(fn).toThrow(SchemaValidationError);
}

// ============================================================
// Digest determinism — canonical JSON
// ============================================================

describe('vNext digest determinism', () => {
  it('canonicalizes equivalent logical data to the same digest', () => {
    const a = { b: 1, a: [1, 2], c: 'x' };
    const b = { c: 'x', a: [1, 2], b: 1 };
    expect(computeDigest(a)).toBe(computeDigest(b));
  });

  it('rejects non-finite numbers (fail closed, never hash ambiguous data)', () => {
    expect(() => computeDigest({ x: Number.NaN })).toThrow(TypeError);
  });
});

// ============================================================
// Canonical Plan — digest invariants (Slice 0.1)
// ============================================================

describe('VNextCanonicalPlan plan_digest (Slice 0.1)', () => {
  it('checkbox change does NOT change plan_digest', () => {
    const base = makePlan();
    const toggled = {
      ...base,
      items: [{ ...base.items[0], checkbox: true }],
    };
    expect(computePlanDigest(toggled)).toBe(computePlanDigest(base));
  });

  it('Worker Status (status) change does NOT change plan_digest', () => {
    const base = makePlan();
    const changed = {
      ...base,
      items: [{ ...base.items[0], status: 'in_progress' }],
    };
    expect(computePlanDigest(changed)).toBe(computePlanDigest(base));
  });

  it('Current CV Status (cv_status) change does NOT change plan_digest', () => {
    const base = makePlan();
    const changed = {
      ...base,
      items: [{ ...base.items[0], cv_status: 'PASS' }],
    };
    expect(computePlanDigest(changed)).toBe(computePlanDigest(base));
  });

  it('Goal change DOES change plan_digest', () => {
    const base = makePlan();
    const changed = {
      ...base,
      items: [{ ...base.items[0], goal: 'Implement plugin teardown' }],
    };
    expect(computePlanDigest(changed)).not.toBe(computePlanDigest(base));
  });

  it('ref change DOES change plan_digest', () => {
    const base = makePlan();
    const changed = {
      ...base,
      items: [{ ...base.items[0], refs: ['REF-999'] }],
    };
    expect(computePlanDigest(changed)).not.toBe(computePlanDigest(base));
  });

  it('dependency change DOES change plan_digest', () => {
    const base = makePlan();
    const changed = {
      ...base,
      items: [{ ...base.items[0], dependencies: ['S04-B'] }],
    };
    expect(computePlanDigest(changed)).not.toBe(computePlanDigest(base));
  });

  it('Required Skills change DOES change plan_digest', () => {
    const base = makePlan();
    const changed = {
      ...base,
      items: [{ ...base.items[0], required_skills: ['property-based-testing'] }],
    };
    expect(computePlanDigest(changed)).not.toBe(computePlanDigest(base));
  });

  it('execution_scope change DOES change plan_digest', () => {
    const base = makePlan();
    const changed = {
      ...base,
      items: [{
        ...base.items[0],
        execution_scope: {
          ...base.items[0].execution_scope,
          code_paths: ['packages/kernel/src/vnext/manifest.ts'],
        },
      }],
    };
    expect(computePlanDigest(changed)).not.toBe(computePlanDigest(base));
  });

  it('is deterministic for identical input', () => {
    const a = makePlan();
    expect(computePlanDigest(a)).toBe(computePlanDigest(a));
  });

  it('the projection excludes execution fields entirely', () => {
    const projection = canonicalizePlanProjection(makePlan());
    const json = JSON.stringify(projection);
    expect(json).not.toContain('checkbox');
    expect(json).not.toContain('status');
    expect(json).not.toContain('cv_status');
    expect(json).toContain('goal');
    expect(json).toContain('refs');
    expect(json).toContain('execution_scope');
  });

  it('validateVNextPlan accepts a valid plan', () => {
    expect(validateVNextPlan(makePlan()).items).toHaveLength(1);
  });

  it('validateVNextPlan rejects an unknown field in a plan item', () => {
    const bad = {
      ...makePlan(),
      items: [{ ...makePlan().items[0], extra: 'nope' }],
    };
    expectsFail(() => validateVNextPlan(bad));
  });

  it('validateVNextPlan rejects a missing schema_version', () => {
    const { schema_version: _v, ...bad } = makePlan();
    void _v;
    expectsFail(() => validateVNextPlan(bad));
  });

  it('validateVNextPlan rejects a non-boolean checkbox', () => {
    const bad = {
      ...makePlan(),
      items: [{ ...makePlan().items[0], checkbox: 'yes' }],
    };
    expectsFail(() => validateVNextPlan(bad));
  });

  it('validateVNextPlan rejects a missing task scope', () => {
    const bad = makePlan();
    delete bad.items[0].execution_scope;
    expectsFail(() => validateVNextPlan(bad));
  });

  it('validateVNextPlan rejects a forbidden overlap and non-canonical path', () => {
    const overlap = makePlan();
    overlap.items[0].execution_scope.forbidden_paths = ['packages/kernel'];
    expectsFail(() => validateVNextPlan(overlap));

    const escaped = makePlan();
    escaped.items[0].execution_scope.code_paths = ['../outside.ts'];
    expectsFail(() => validateVNextPlan(escaped));
  });
});

// ============================================================
// Reference Index (Slice 0.2)
// ============================================================

describe('validateVNextReferenceDescriptor / ReferenceIndex (Slice 0.2)', () => {
  const descriptor = makeIndex()['REF-003'] as Record<string, unknown>;

  it('accepts a valid descriptor', () => {
    expect(validateVNextReferenceDescriptor(descriptor).kind).toBe('acceptance');
  });

  it('accepts a valid reference_index', () => {
    const index = validateVNextReferenceIndex(makeIndex());
    expect(Object.keys(index)).toContain('REF-001');
  });

  it('rejects an unknown field in a descriptor', () => {
    expectsFail(() =>
      validateVNextReferenceDescriptor({ ...descriptor, extra: true }),
    );
  });

  it('rejects a reference_index entry whose descriptor has an unknown field', () => {
    expectsFail(() =>
      validateVNextReferenceIndex({ ...makeIndex(), EXTRA: { ...descriptor, extra: true } }),
    );
  });

  it('rejects a missing section_digest', () => {
    const { section_digest: _d, ...bad } = descriptor as Record<string, unknown>;
    void _d;
    expectsFail(() => validateVNextReferenceIndex({ 'REF-01': bad }));
  });

  it('rejects a wrong kind', () => {
    const bad = { ...descriptor, kind: 'bogus' };
    expectsFail(() => validateVNextReferenceDescriptor(bad));
  });

  it('rejects a descriptor that repeats its own ref_id', () => {
    const bad = { ...descriptor, ref_id: 'REF-01' };
    expectsFail(() => validateVNextReferenceDescriptor(bad));
  });

  it('rejects an empty ref string', () => {
    const bad = { ...descriptor, ref: '' };
    expectsFail(() => validateVNextReferenceDescriptor(bad));
  });

  it('rejects a non-canonical ref (no # fragment)', () => {
    const bad = { ...descriptor, ref: 'delivery/stages/S04/tasks.md' };
    expectsFail(() => validateVNextReferenceDescriptor(bad));
  });

  it('rejects a wrong digest shape (file_digest)', () => {
    const bad = { ...descriptor, file_digest: 'not-a-digest' };
    expectsFail(() => validateVNextReferenceDescriptor(bad));
  });

  it('rejects an short/uppercase digest shape', () => {
    const bad = { ...descriptor, section_digest: 'A'.repeat(64) };
    expectsFail(() => validateVNextReferenceDescriptor(bad));
  });

  it('rejects an empty ref_id key in the index', () => {
    const index = makeIndex();
    (index as Record<string, unknown>)[''] = descriptor;
    expectsFail(() => validateVNextReferenceIndex(index));
  });

  it('rejects an empty reference_index', () => {
    expectsFail(() => validateVNextReferenceIndex({}));
  });
});

// ============================================================
// Proof Index (Slice 0.2)
// ============================================================

describe('validateVNextProofIndex (Slice 0.2)', () => {
  const registered = toRegistered(makeIndex());

  it('accepts a valid Proof Index', () => {
    expect(validateVNextProofIndex(makeProofIndex(), registered).slice_id).toBe('S04-A');
  });

  it('rejects an unknown field in the Proof Index', () => {
    expectsFail(() =>
      validateVNextProofIndex(makeProofIndex({ extra: 1 }), registered),
    );
  });

  it('rejects an unregistered goal_ref', () => {
    expectsFail(() =>
      validateVNextProofIndex(makeProofIndex({ goal_ref: 'REF-999' }), registered),
    );
  });

  it('rejects an unregistered task_ref', () => {
    expectsFail(() =>
      validateVNextProofIndex(makeProofIndex({ task_refs: ['REF-999'] }), registered),
    );
  });

  it('rejects an unregistered oracle_ref', () => {
    expectsFail(() =>
      validateVNextProofIndex(makeProofIndex({ oracle_refs: ['REF-998'] }), registered),
    );
  });

  it('rejects an empty-string ref in oracle_refs', () => {
    expectsFail(() =>
      validateVNextProofIndex(makeProofIndex({ oracle_refs: [''] }), registered),
    );
  });

  it('rejects a duplicate task_ref', () => {
    expectsFail(() =>
      validateVNextProofIndex(
        makeProofIndex({ task_refs: ['REF-002', 'REF-002'] }),
        registered,
      ),
    );
  });

  it('rejects the wrong kind for goal_ref (not kind=goal)', () => {
    expectsFail(() =>
      validateVNextProofIndex(makeProofIndex({ goal_ref: 'REF-002' }), registered),
    );
  });

  it('rejects an unregistered risk ref_id', () => {
    const bad = makeProofIndex() as any;
    bad.risk_refs[0].ref_id = 'REF-999';
    expectsFail(() => validateVNextProofIndex(bad, registered));
  });

  it('rejects a duplicate risk ref_id', () => {
    const bad = makeProofIndex() as any;
    bad.risk_refs = [bad.risk_refs[0], { ...bad.risk_refs[0] }];
    expectsFail(() => validateVNextProofIndex(bad, registered));
  });

  it('rejects a risk binding pointing at a non-acceptance ref (applies_to_acceptance_refs)', () => {
    const bad = makeProofIndex() as any;
    // REF-005 is kind=oracle and is NOT in acceptance_refs
    bad.risk_refs[0].applies_to_acceptance_refs = ['REF-005'];
    expectsFail(() => validateVNextProofIndex(bad, registered));
  });

  it('rejects a risk binding pointing at a non-seam ref (applies_to_seam_refs)', () => {
    const bad = makeProofIndex() as any;
    // REF-003 is kind=acceptance and is NOT in seam_refs
    bad.risk_refs[0].applies_to_seam_refs = ['REF-003'];
    expectsFail(() => validateVNextProofIndex(bad, registered));
  });
});

// ============================================================
// vNext Manifest + schema cutover (Slace 0.2 / §9.5)
// ============================================================

describe('validateVNextManifest (Schema Cutover)', () => {
  it('accepts a valid vNext Manifest', () => {
    expect(validateVNextManifest(makeManifest()).stage_id).toBe('S04');
  });

  it('rejects an old v1 Manifest (no version) as NOT vNext', () => {
    const { version: _v, ...v1Like } = makeManifest();
    void _v;
    expectsFail(() => validateVNextManifest(v1Like));
  });

  it('rejects a wrong discriminator (version: 1)', () => {
    expectsFail(() => validateVNextManifest(makeManifest({ version: 1 })));
  });

  it('rejects an unknown top-level field', () => {
    expectsFail(() => validateVNextManifest(makeManifest({ extra: true })));
  });

  it('rejects a non-hex plan_digest', () => {
    const bad = makeManifest();
    (bad.plan as Record<string, unknown>).plan_digest = 'zzz';
    expectsFail(() => validateVNextManifest(bad));
  });

  it('rejects a slice proof_index referencing an unregistered ref', () => {
    const bad = makeManifest() as any;
    bad.slices[0].proof_index.goal_ref = 'REF-999';
    expectsFail(() => validateVNextManifest(bad));
  });

  it('rejects a slice risk binding pointing at a non-acceptance ref', () => {
    const bad = makeManifest() as any;
    bad.slices[0].proof_index.risk_refs[0].applies_to_acceptance_refs = ['REF-005'];
    expectsFail(() => validateVNextManifest(bad));
  });

  it('rejects slice/proof_index slice_id mismatch', () => {
    const bad = makeManifest() as any;
    bad.slices[0].proof_index.slice_id = 'S04-B';
    expectsFail(() => validateVNextManifest(bad));
  });

  it('rejects an empty reference_index in a manifest', () => {
    const bad = makeManifest({ reference_index: {} });
    expectsFail(() => validateVNextManifest(bad));
  });

  it('rejects an authority_ref_ids entry not registered in reference_index', () => {
    const bad = makeManifest({ authority_ref_ids: ['REF-999'] });
    expectsFail(() => validateVNextManifest(bad));
  });

  it('rejects a missing or mismatched per-task Manifest scope', () => {
    const missing = makeManifest() as any;
    delete missing.task_scopes;
    expectsFail(() => validateVNextManifest(missing));

    const mismatched = makeManifest() as any;
    mismatched.task_scopes['S04-A-T01'].task_ref = 'delivery/stages/S04/tasks.md#/entities/other-task';
    expectsFail(() => validateVNextManifest(mismatched));
  });

  it('accepts a valid optional runtime_proof section', () => {
    const withRp = makeManifest({
      runtime_proof: {
        spec_refs: ['REF-007'],
        resolved_steps: [],
        proof_digest: 'd'.repeat(64),
      },
    });
    expect(validateVNextManifest(withRp).runtime_proof).toBeDefined();
  });

  it('rejects a malformed runtime_proof (bad proof_digest shape)', () => {
    const bad = makeManifest({
      runtime_proof: {
        spec_refs: [],
        resolved_steps: [],
        proof_digest: 'short',
      },
    });
    expectsFail(() => validateVNextManifest(bad));
  });
});
