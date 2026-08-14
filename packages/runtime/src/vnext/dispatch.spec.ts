/**
 * S04-A-T01 — vNext worker dispatch seam.
 * Task Ref: REF-S04-A-T01
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  projectVNextWorkerDispatch,
  readVNextManifest,
  verifyVNextWorkerContextBindings,
  VNextHandoffError,
} from './dispatch';
import { VNextNextActionService, persistVNextWorkerContext } from './next';
import type { VNextNextActionOutput } from './next';
import {
  computeDigest,
  computeVNextSpvPassReceiptDigest,
  computeVNextStagePlanReceiptDigest,
  writeReceipt,
} from '@proofloop/kernel';
import { resolveVNextReference } from '@proofloop/runtime';

const repoRoot = path.resolve(__dirname, '../../../..');

const DIGEST = 'a'.repeat(64);
const SNAPSHOT = 'a'.repeat(40);

function manifest(overrides: Record<string, unknown> = {}): any {
  return {
    version: 2,
    stage_id: 'S04',
    plan: { ref: 'delivery/stages/S04/tasks.md', plan_digest: 'b'.repeat(64), schema_version: 2 },
    reference_index: {
      GOAL: { kind: 'goal', ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-goal', file_digest: DIGEST, section_digest: DIGEST },
      TASK: { kind: 'task', ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01', file_digest: DIGEST, section_digest: DIGEST },
      ACCEPT: { kind: 'acceptance', ref: 'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-PO01', file_digest: DIGEST, section_digest: DIGEST },
      SEAM: { kind: 'seam', ref: 'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-seam', file_digest: DIGEST, section_digest: DIGEST },
      ORACLE: { kind: 'oracle', ref: 'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-oracle', file_digest: DIGEST, section_digest: DIGEST },
      RISK: { kind: 'risk', ref: 'delivery/stages/S0-A/tasks.md#/entities/S0-A-3-risk', file_digest: DIGEST, section_digest: DIGEST },
      PROOF: { kind: 'proof_spec', ref: 'delivery/stages/S04/tasks.md#/entities/S04-proof', file_digest: DIGEST, section_digest: DIGEST },
    },
    task_scopes: {
      'S04-A-T01': {
        task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
        execution_scope: {
          kind: 'implementation',
          code_paths: ['packages/runtime/src/vnext/dispatch.ts'],
          test_paths: ['packages/runtime/src/vnext/dispatch.spec.ts'],
          forbidden_paths: ['.proofloop/receipts'],
        },
      },
    },
    slices: [{
      slice_id: 'S04-A',
      proof_index: {
        slice_id: 'S04-A', goal_ref: 'GOAL', task_refs: ['TASK'],
        acceptance_refs: ['ACCEPT'], seam_refs: ['SEAM'], oracle_refs: ['ORACLE'],
        risk_refs: [{ ref_id: 'RISK', applies_to_acceptance_refs: ['ACCEPT'], applies_to_seam_refs: ['SEAM'] }],
      },
      required_skills: ['test-driven-development'], depends_on: [],
      evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
    }],
    ...overrides,
  };
}

const authority: any = {
  stagePlan: {
    version: 2, schema_version: 2, type: 'STAGE_PLAN', stage_id: 'S04',
    manifest_digest: DIGEST, plan_digest: 'b'.repeat(64), snapshot_digest: SNAPSHOT,
    spv_receipt_digest: 'c'.repeat(64), digest: 'd'.repeat(64),
  },
  spv: {
    version: 2, schema_version: 2, type: 'SPV_PASS', stage_id: 'S04',
    manifest_digest: DIGEST, plan_digest: 'b'.repeat(64), snapshot_digest: SNAPSHOT, digest: 'c'.repeat(64),
  },
};

const { digest: ignoredSpvDigest, ...spvContent } = authority.spv;
void ignoredSpvDigest;
authority.spv.digest = computeVNextSpvPassReceiptDigest(spvContent);
authority.stagePlan.spv_receipt_digest = authority.spv.digest;
const { digest: ignoredPlanDigest, ...stagePlanContent } = authority.stagePlan;
void ignoredPlanDigest;
authority.stagePlan.digest = computeVNextStagePlanReceiptDigest(stagePlanContent);

/** Rebuild a receipt fact with a canonical self digest from content
 *  overrides, so a binding test exercises exactly the field it names. */
function withReceiptDigest<T extends { digest: string; type: string }>(
  fact: T,
  overrides: Record<string, unknown>,
): T {
  const { digest: ignored, ...content } = { ...fact, ...overrides } as Record<string, unknown>;
  void ignored;
  const canonical = content as Record<string, string>;
  const digest = content.type === 'STAGE_PLAN'
    ? computeVNextStagePlanReceiptDigest(canonical as never)
    : computeVNextSpvPassReceiptDigest(canonical as never);
  return { ...content, digest } as T;
}

function admittedManifest(value = manifest(), snapshotDigest = SNAPSHOT) {
  const manifestDigest = computeDigest(value);
  const { digest: ignoredSpvDigest, ...spvContent } = {
    ...authority.spv,
    manifest_digest: manifestDigest,
    snapshot_digest: snapshotDigest,
  };
  void ignoredSpvDigest;
  const spv = { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) };
  const { digest: ignoredPlanDigest, ...stagePlanContent } = {
    ...authority.stagePlan,
    manifest_digest: manifestDigest,
    snapshot_digest: snapshotDigest,
    spv_receipt_digest: spv.digest,
  };
  void ignoredPlanDigest;
  const stagePlan = { ...stagePlanContent, digest: computeVNextStagePlanReceiptDigest(stagePlanContent) };
  return { value, manifestDigest, authority: { stagePlan, spv } };
}

/**
 * Admit a REAL Manifest value: the authority is bound to the value's actual
 * plan_digest (a real fixture's plan digest is not the synthetic digest used
 * by the in-memory unit fixtures) plus the live manifest/snapshot digests.
 */
function realAdmittedManifest(value: Record<string, unknown>, snapshotDigest: string) {
  const manifestDigest = computeDigest(value);
  const planDigest = (value as { plan: { plan_digest: string } }).plan.plan_digest;
  const { digest: ignoredSpvDigest, ...spvContent } = {
    ...authority.spv,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
  };
  void ignoredSpvDigest;
  const spv = { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) };
  const { digest: ignoredPlanDigest, ...stagePlanContent } = {
    ...authority.stagePlan,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
    spv_receipt_digest: spv.digest,
  };
  void ignoredPlanDigest;
  const stagePlan = { ...stagePlanContent, digest: computeVNextStagePlanReceiptDigest(stagePlanContent) };
  return { value, manifestDigest, planDigest, authority: { stagePlan, spv } };
}

function initGit(root: string): string {
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-dispatch@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Dispatch Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  fs.writeFileSync(path.join(root, 'dispatch-boundary.txt'), 'clean fixture\n', 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'dispatch boundary']);
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function multiSliceManifest(overrides: Record<string, unknown> = {}): any {
  const base = manifest();
  return {
    ...base,
    reference_index: {
      ...base.reference_index,
      GOAL_B: { kind: 'goal', ref: 'delivery/stages/S04/tasks.md#/entities/S04-B-goal', file_digest: DIGEST, section_digest: DIGEST },
      TASK_A2: { kind: 'task', ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T02', file_digest: DIGEST, section_digest: DIGEST },
      TASK_B: { kind: 'task', ref: 'delivery/stages/S04/tasks.md#/entities/S04-B-T01', file_digest: DIGEST, section_digest: DIGEST },
    },
    task_scopes: {
      ...base.task_scopes,
      'S04-A-T02': {
        task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T02',
        execution_scope: {
          kind: 'implementation',
          code_paths: ['packages/runtime/src/vnext/next.ts'],
          test_paths: ['packages/runtime/src/vnext/dispatch.spec.ts'],
          forbidden_paths: ['.proofloop/receipts'],
        },
      },
      'S04-B-T01': {
        task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-B-T01',
        execution_scope: {
          kind: 'implementation',
          code_paths: ['packages/runtime/src/vnext/dispatch.ts'],
          test_paths: ['packages/runtime/src/vnext/dispatch.spec.ts'],
          forbidden_paths: ['.proofloop/receipts'],
        },
      },
    },
    slices: [
      {
        slice_id: 'S04-A',
        proof_index: {
          slice_id: 'S04-A', goal_ref: 'GOAL', task_refs: ['TASK', 'TASK_A2'],
          acceptance_refs: ['ACCEPT'], seam_refs: ['SEAM'], oracle_refs: ['ORACLE'],
          risk_refs: [{ ref_id: 'RISK', applies_to_acceptance_refs: ['ACCEPT'], applies_to_seam_refs: ['SEAM'] }],
        },
        required_skills: ['test-driven-development'], depends_on: [],
        evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
      },
      {
        slice_id: 'S04-B',
        proof_index: {
          slice_id: 'S04-B', goal_ref: 'GOAL_B', task_refs: ['TASK_B'],
          acceptance_refs: ['ACCEPT'], seam_refs: ['SEAM'], oracle_refs: ['ORACLE'],
          risk_refs: [{ ref_id: 'RISK', applies_to_acceptance_refs: ['ACCEPT'], applies_to_seam_refs: ['SEAM'] }],
        },
        required_skills: ['test-driven-development'], depends_on: ['S04-A'],
        evidence_path: 'delivery/stages/S04/evidence/S04-B.md',
      },
    ],
    ...overrides,
  };
}

describe("projectVNextWorkerDispatch", () => {
  it('projects one bound DISPATCH_WORKER and a context without body leakage', () => {
    const admitted = admittedManifest();
    const result = projectVNextWorkerDispatch({
      root: '/tmp/s00-root', manifest: admitted.value, manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT, authority: admitted.authority,
      verifyReferenceBindings: false,
    });
    expect(result.action).toBe('DISPATCH_WORKER');
    expect(result.task_id).toBe('S04-A-T01');
    expect(result.manifest_digest).toBe(admitted.manifestDigest);
    expect(result.plan_digest).toBe('b'.repeat(64));
    expect(result.snapshot_digest).toBe(SNAPSHOT);
    expect(result.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    expect(JSON.stringify(result.context)).not.toContain('tasks.md\n');
    expect(JSON.stringify(result.context)).not.toContain('Worker Evidence');
    expect(result.context.evidence_path).toBe('delivery/stages/S04/evidence/S04-A.md');
    expect(result.context.plan_projection_path).toBe('delivery/stages/S04/tasks.md');
    expect(result.context.allowed_code_scope).toEqual([
      'packages/runtime/src/vnext/dispatch.ts',
      'packages/runtime/src/vnext/dispatch.spec.ts',
    ]);
    expect(result.context.allowed_code_scope).not.toContain('delivery/stages/S04/tasks.md');
    expect(result.context.execution_scope).toEqual({
      kind: 'implementation',
      code_paths: ['packages/runtime/src/vnext/dispatch.ts'],
      test_paths: ['packages/runtime/src/vnext/dispatch.spec.ts'],
      forbidden_paths: ['.proofloop/receipts'],
    });
    expect(result.context.scope.allowed_paths).toEqual([
      'packages/runtime/src/vnext/dispatch.ts',
      'packages/runtime/src/vnext/dispatch.spec.ts',
      'delivery/stages/S04/evidence/S04-A.md',
      'delivery/stages/S04/tasks.md',
    ]);
    expect(result.context.scope.allowed_paths).toContain('delivery/stages/S04/evidence/S04-A.md');
    expect(result.context.scope.allowed_paths).toContain('delivery/stages/S04/tasks.md');
    expect(result.context.scope.mutable_projection_paths).toEqual(['delivery/stages/S04/tasks.md']);
    expect(result.context.scope.forbidden_paths).toContain('.proofloop/receipts');
    expect(result.context.scope.forbidden_paths).toContain('.git');

    const contextWithoutDigest = { ...result.context } as Record<string, unknown>;
    delete contextWithoutDigest.context_digest;
    expect(computeDigest(contextWithoutDigest)).toBe(result.context.context_digest);

    const projectionChanged = {
      ...result.context,
      plan_projection_path: 'delivery/stages/S04/other-tasks.md',
    } as Record<string, unknown>;
    delete projectionChanged.context_digest;
    expect(computeDigest(projectionChanged)).not.toBe(result.context.context_digest);
  });

  it('rejects requested paths outside code/test, Evidence, or the exact Plan projection', () => {
    const admitted = admittedManifest();
    for (const requested of [
      'delivery/stages/S04/other.md',
      'delivery/stages/S04/tasks.md/immutable-plan-content',
    ]) {
      expect(() => projectVNextWorkerDispatch({
        root: '/tmp/s00-root',
        manifest: admitted.value,
        manifestDigest: admitted.manifestDigest,
        snapshotDigest: SNAPSHOT,
        authority: admitted.authority,
        allowedPaths: [requested],
        verifyReferenceBindings: false,
      })).toThrowError(/expands the admitted execution scope/);
    }

    const projectionOnly = projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: admitted.value,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: admitted.authority,
      allowedPaths: ['delivery/stages/S04/tasks.md'],
      verifyReferenceBindings: false,
    });
    expect(projectionOnly.context.scope.allowed_paths).toContain('delivery/stages/S04/tasks.md');
  });

  it('rejects v1-shaped input and never falls back', () => {
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root', manifest: { ...manifest(), version: 1 },
      manifestDigest: DIGEST, snapshotDigest: SNAPSHOT, authority,
    })).toThrowError(VNextHandoffError);
  });

  it('returns a bounded gap when Stage Plan authority or structured proof is absent', () => {
    const admitted = admittedManifest();
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root', manifest: admitted.value, manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT, authority: undefined,
    })).toThrowError(/Stage Plan admission authority/);
  });

  it('fails closed before action when the admitted task scope is missing or Evidence-only', () => {
    const admitted = admittedManifest();
    const missing = { ...admitted.value };
    delete missing.task_scopes;
    const missingAdmission = admittedManifest(missing);
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: missingAdmission.value,
      manifestDigest: missingAdmission.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: missingAdmission.authority,
      verifyReferenceBindings: false,
    })).toThrowError(VNextHandoffError);

    const evidenceOnly = admittedManifest({
      ...admitted.value,
      task_scopes: {
        'S04-A-T01': {
          task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
          execution_scope: {
            kind: 'evidence-only',
            code_paths: [],
            test_paths: [],
            forbidden_paths: [],
          },
        },
      },
    });
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: evidenceOnly.value,
      manifestDigest: evidenceOnly.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: evidenceOnly.authority,
      verifyReferenceBindings: false,
    })).toThrowError(/evidence-only|cannot be dispatched/);
  });

  it('fails closed for escaped paths and forbidden overlap before producing Context', () => {
    const base = admittedManifest();
    const escaped = admittedManifest({
      ...base.value,
      task_scopes: {
        'S04-A-T01': {
          ...base.value.task_scopes['S04-A-T01'],
          execution_scope: {
            ...base.value.task_scopes['S04-A-T01'].execution_scope,
            code_paths: ['../outside.ts'],
          },
        },
      },
    });
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: escaped.value,
      manifestDigest: escaped.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: escaped.authority,
      verifyReferenceBindings: false,
    })).toThrowError(VNextHandoffError);

    const overlap = admittedManifest({
      ...base.value,
      task_scopes: {
        'S04-A-T01': {
          ...base.value.task_scopes['S04-A-T01'],
          execution_scope: {
            ...base.value.task_scopes['S04-A-T01'].execution_scope,
            forbidden_paths: ['packages/runtime'],
          },
        },
      },
    });
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: overlap.value,
      manifestDigest: overlap.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: overlap.authority,
      verifyReferenceBindings: false,
    })).toThrowError(/overlaps executable|scope validation/);
  });

  it('selects the first task in the first dependency-ready Slice of a multi-Slice Manifest', () => {
    const admitted = admittedManifest(multiSliceManifest());
    const result = projectVNextWorkerDispatch({
      root: '/tmp/s00-root', manifest: admitted.value, manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT, authority: admitted.authority,
      verifyReferenceBindings: false,
    });
    expect(result.action).toBe('DISPATCH_WORKER');
    expect(result.slice_id).toBe('S04-A');
    expect(result.task_id).toBe('S04-A-T01');
    expect(result.context.proof_index.task_refs).toEqual(['TASK', 'TASK_A2']);
    expect(result.context_ref).toBe(`.proofloop/context/${result.context.context_digest}.json`);
    expect(result.context.manifest_digest).toBe(admitted.manifestDigest);
    expect(result.context.proof_index_digest).toBe(result.proof_index_digest);
    const contextWithoutDigest = { ...result.context } as Record<string, unknown>;
    delete contextWithoutDigest.context_digest;
    expect(computeDigest(contextWithoutDigest)).toBe(result.context.context_digest);
  });

  it('skips a task proven complete by persisted vNext facts when projecting the next Worker', () => {
    const admitted = admittedManifest(multiSliceManifest());
    const result = projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: admitted.value,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: admitted.authority,
      completedTaskIds: ['S04-A-T01'],
      verifyReferenceBindings: false,
    } as any);

    expect(result.action).toBe('DISPATCH_WORKER');
    expect(result.slice_id).toBe('S04-A');
    expect(result.task_id).toBe('S04-A-T02');
  });

  it('skips a dependency-blocked Slice and fails closed when none is dependency-ready', () => {
    const blockedFirst = multiSliceManifest({
      slices: [
        { ...multiSliceManifest().slices[0], depends_on: ['S04-B'] },
        { ...multiSliceManifest().slices[1], depends_on: [] },
      ],
    });
    const admitted = admittedManifest(blockedFirst);
    const result = projectVNextWorkerDispatch({
      root: '/tmp/s00-root', manifest: admitted.value, manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT, authority: admitted.authority,
      verifyReferenceBindings: false,
    });
    expect(result.slice_id).toBe('S04-B');
    expect(result.task_id).toBe('S04-B-T01');

    const mutuallyBlocked = multiSliceManifest({
      slices: [
        { ...multiSliceManifest().slices[0], depends_on: ['S04-B'] },
        { ...multiSliceManifest().slices[1], depends_on: ['S04-A'] },
      ],
    });
    const blockedAdmission = admittedManifest(mutuallyBlocked);
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root', manifest: blockedAdmission.value, manifestDigest: blockedAdmission.manifestDigest,
      snapshotDigest: SNAPSHOT, authority: blockedAdmission.authority,
      verifyReferenceBindings: false,
    })).toThrowError(/dependency-ready/);
  });
});

describe('vNext dispatch digest tuple binding (S08-B-T02)', () => {
  it('fails closed when the Stage Plan authority is not bound to the Manifest Plan digest', () => {
    const admitted = admittedManifest();
    const stagePlan = withReceiptDigest(admitted.authority.stagePlan, { plan_digest: 'f'.repeat(64) });
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: admitted.value,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: { stagePlan, spv: admitted.authority.spv },
      verifyReferenceBindings: false,
    })).toThrowError(/do not bind/);
  });

  it('fails closed when the Stage Plan authority is not bound to the dispatch snapshot', () => {
    const admitted = admittedManifest();
    const stagePlan = withReceiptDigest(admitted.authority.stagePlan, { snapshot_digest: 'b'.repeat(40) });
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: admitted.value,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: { stagePlan, spv: admitted.authority.spv },
      verifyReferenceBindings: false,
    })).toThrowError(/do not bind/);
  });

  it('fails closed when the Stage Plan authority does not bind the fresh SPV receipt digest', () => {
    const admitted = admittedManifest();
    const stagePlan = withReceiptDigest(admitted.authority.stagePlan, { spv_receipt_digest: 'e'.repeat(64) });
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: admitted.value,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: { stagePlan, spv: admitted.authority.spv },
      verifyReferenceBindings: false,
    })).toThrowError(/do not bind/);
  });

  it('fails closed when the fresh SPV is not bound to the dispatch snapshot', () => {
    const admitted = admittedManifest();
    const spv = withReceiptDigest(admitted.authority.spv, { snapshot_digest: 'b'.repeat(40) });
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: admitted.value,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: { stagePlan: admitted.authority.stagePlan, spv },
      verifyReferenceBindings: false,
    })).toThrowError(/do not bind/);
  });

  it('fails closed when the fresh SPV is bound to a different Manifest', () => {
    const admitted = admittedManifest();
    const spv = withReceiptDigest(admitted.authority.spv, { manifest_digest: 'f'.repeat(64) });
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: admitted.value,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: { stagePlan: admitted.authority.stagePlan, spv },
      verifyReferenceBindings: false,
    })).toThrowError(/do not bind/);
  });

  it('refuses a non-Git snapshot_digest when projecting a Worker Context', () => {
    const admitted = admittedManifest();
    const garbage = 'not-a-git-snapshot';
    const spv = withReceiptDigest(admitted.authority.spv, { snapshot_digest: garbage });
    const stagePlan = withReceiptDigest(admitted.authority.stagePlan, {
      snapshot_digest: garbage,
      spv_receipt_digest: spv.digest,
    });
    expect(() => projectVNextWorkerDispatch({
      root: '/tmp/s00-root',
      manifest: admitted.value,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: garbage,
      authority: { stagePlan, spv },
      verifyReferenceBindings: false,
    })).toThrowError(/snapshot_digest must be a canonical Git HEAD digest/);
  });
});

const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function gitHead(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/**
 * Build a REAL Git fixture from the repository's actual S04 vNext structure:
 * the real Manifest + tasks.md + evidence files are copied into a fresh
 * worktree, the reference bindings are re-resolved against the copied files,
 * and the tree is committed. Everything is re-read from persisted files by the
 * dispatch/next seams — no in-memory objects, no fictional roots.
 */
function realS04FixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-t04-real-'));
  cleanup.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-dispatch-t04@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Dispatch T04']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  for (const relative of [
    'delivery/stages/S04/tasks.md',
    '.proofloop/manifests/S04.json',
    'delivery/stages/S04/evidence/S04-A.md',
    'delivery/stages/S0-A/tasks.md',
  ]) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), destination);
  }
  // The repo's S04 manifest is a candidate manifest without task_scopes;
  // re-resolve the reference bindings against the COPIED files so the real
  // bindings seam passes on the fixture, then commit the tree.
  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  manifest.task_scopes = {
    'S04-A-T01': {
      task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['packages/runtime/src/vnext/dispatch.ts'],
        test_paths: ['packages/runtime/src/vnext/dispatch.spec.ts'],
        forbidden_paths: ['.proofloop/receipts'],
      },
    },
  };
  const referenceIndex = manifest.reference_index as Record<string, {
    kind: string;
    ref: string;
    file_digest: string;
    section_digest: string;
  }>;
  for (const descriptor of Object.values(referenceIndex)) {
    const resolved = resolveVNextReference({
      root,
      ref: descriptor.ref,
      expectedKind: descriptor.kind as never,
    });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'real S04 fixture']);
  return root;
}

describe('VNextNextActionService', () => {
  it('re-checks admitted scope paths against the live symlink boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-scope-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-scope-outside-'));
    cleanup.push(root, outside);
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    const admitted = admittedManifest({
      ...manifest(),
      task_scopes: {
        'S04-A-T01': {
          task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
          execution_scope: {
            kind: 'implementation',
            code_paths: ['link/implementation.ts'],
            test_paths: ['packages/runtime/src/vnext/dispatch.spec.ts'],
            forbidden_paths: [],
          },
        },
      },
    });
    expect(() => projectVNextWorkerDispatch({
      root,
      manifest: admitted.value,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: SNAPSHOT,
      authority: admitted.authority,
      verifyReferenceBindings: false,
    })).toThrowError(VNextHandoffError);
  });

  it('reads only v2 authority and persists a digest-addressed context', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-'));
    cleanup.push(root);
    const snapshotDigest = initGit(root);
    const admitted = admittedManifest(manifest(), snapshotDigest);
    const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
    const receiptDir = path.join(root, '.proofloop/receipts/plan/S04');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(admitted.value));
    fs.writeFileSync(path.join(receiptDir, 'c.json'), JSON.stringify(admitted.authority.spv));
    fs.writeFileSync(path.join(receiptDir, 'd.json'), JSON.stringify(admitted.authority.stagePlan));
    const result = new VNextNextActionService().nextAction({
      projectRoot: root, stageId: 'S04', snapshotDigest, persistContext: true, verifyReferenceBindings: false,
    });
    expect(result.action).toBe('DISPATCH_WORKER');
    expect(result.context_ref).toBeDefined();
    const contextPath = path.join(root, result.context_ref!);
    expect(fs.existsSync(contextPath)).toBe(true);
    expect(fs.readFileSync(contextPath, 'utf8')).not.toContain('The task body');
  });

  it('returns bounded VALIDATE for v1 authority instead of using legacy next', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-v1-'));
    cleanup.push(root);
    initGit(root);
    const admitted = admittedManifest();
    const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
    const receiptDir = path.join(root, '.proofloop/receipts/plan/S04');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(admitted.value));
    fs.writeFileSync(path.join(receiptDir, 'legacy.json'), JSON.stringify({ type: 'STAGE_PLAN', version: 1 }));
    const result = new VNextNextActionService().nextAction({
      projectRoot: root, stageId: 'S04',
    });
    expect(result.action).toBe('VALIDATE');
    expect(result.findings[0]?.message).toMatch(/v1 admission authority/);
  });

  it('returns bounded VALIDATE when the persisted authority snapshot is not a canonical Git digest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-badsnapshot-'));
    cleanup.push(root);
    initGit(root);
    const admitted = admittedManifest();
    const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
    const receiptDir = path.join(root, '.proofloop/receipts/plan/S04');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(admitted.value));
    fs.writeFileSync(
      path.join(receiptDir, 'spv.json'),
      JSON.stringify(withReceiptDigest(admitted.authority.spv, { snapshot_digest: 'not-a-git-snapshot' })),
    );
    fs.writeFileSync(
      path.join(receiptDir, 'stage-plan.json'),
      JSON.stringify(withReceiptDigest(admitted.authority.stagePlan, { snapshot_digest: 'not-a-git-snapshot' })),
    );
    const result = new VNextNextActionService().nextAction({
      projectRoot: root, stageId: 'S04', verifyReferenceBindings: false,
    });
    expect(result.action).toBe('VALIDATE');
    expect(fs.existsSync(path.join(root, '.proofloop/context'))).toBe(false);
  });

  it('projects the first dependency-ready task for an admitted multi-Slice Manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-multi-'));
    cleanup.push(root);
    const snapshotDigest = initGit(root);
    const admitted = admittedManifest(multiSliceManifest(), snapshotDigest);
    const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
    const receiptDir = path.join(root, '.proofloop/receipts/plan/S04');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(admitted.value));
    fs.writeFileSync(path.join(receiptDir, 'c.json'), JSON.stringify(admitted.authority.spv));
    fs.writeFileSync(path.join(receiptDir, 'd.json'), JSON.stringify(admitted.authority.stagePlan));

    const result = new VNextNextActionService().nextAction({
      projectRoot: root, stageId: 'S04', snapshotDigest, verifyReferenceBindings: false,
    });
    expect(result.action).toBe('DISPATCH_WORKER');
    expect(result.slice_id).toBe('S04-A');
    expect(result.task_id).toBe('S04-A-T01');
    expect(result.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
  });

  it('projects the next incomplete task from a persisted TASK_COMPLETE fact across an execution dirty boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-execution-'));
    cleanup.push(root);
    initGit(root);

    const baseManifest = multiSliceManifest();
    const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
    const planPath = path.join(root, 'delivery/stages/S04/tasks.md');
    const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(baseManifest), 'utf8');
    fs.writeFileSync(planPath, 'manifest plan projection\n', 'utf8');
    fs.writeFileSync(evidencePath, 'slice evidence\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'execution fixture']);

    const snapshotDigest = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const admitted = admittedManifest(baseManifest, snapshotDigest);
    const receiptDir = path.join(root, '.proofloop/receipts/plan/S04');
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, 'spv.json'), JSON.stringify(admitted.authority.spv), 'utf8');
    fs.writeFileSync(path.join(receiptDir, 'stage-plan.json'), JSON.stringify(admitted.authority.stagePlan), 'utf8');

    const first = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest,
      persistContext: true,
      verifyReferenceBindings: false,
    });
    expect(first.action).toBe('DISPATCH_WORKER');

    const changedFiles = [
      'delivery/stages/S04/evidence/S04-A.md',
      'delivery/stages/S04/tasks.md',
      'packages/runtime/src/vnext/dispatch.ts',
      'packages/runtime/src/vnext/dispatch.spec.ts',
    ];
    fs.appendFileSync(planPath, 'worker projection\n', 'utf8');
    fs.appendFileSync(evidencePath, 'worker evidence\n', 'utf8');
    fs.mkdirSync(path.join(root, 'packages/runtime/src/vnext'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/runtime/src/vnext/dispatch.ts'), 'worker implementation\n', 'utf8');
    fs.writeFileSync(path.join(root, 'packages/runtime/src/vnext/dispatch.spec.ts'), 'worker test\n', 'utf8');
    const taskReceiptDir = path.join(root, '.proofloop/receipts/tasks/S04/S04-A');
    fs.mkdirSync(taskReceiptDir, { recursive: true });
    writeReceipt(
      {
        version: 1,
        type: 'TASK_COMPLETE',
        stage_id: 'S04',
        slice_id: 'S04-A',
        timestamp: '2026-08-06T00:00:00.000Z',
        payload: {
          schema_version: 2,
          action_token: 'execution-task-1',
          mode: 'implement-task',
          outcome: 'completed',
          task_id: 'S04-A-T01',
          evidence_ref: 'delivery/stages/S04/evidence/S04-A.md',
          changed_files: changedFiles,
          verification_runs: [],
          summary: 'execution fixture',
          manifest_digest: admitted.manifestDigest,
          plan_digest: 'b'.repeat(64),
          proof_index_digest: computeDigest(baseManifest.slices[0].proof_index),
          snapshot_digest: snapshotDigest,
          context_ref: first.context_ref,
          context_digest: JSON.parse(
            fs.readFileSync(path.join(root, first.context_ref as string), 'utf8'),
          ).context_digest,
        },
      },
      {
        receiptDir: taskReceiptDir,
        tempDir: taskReceiptDir,
      },
    );

    const next = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest,
      verifyReferenceBindings: false,
    });
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S04-A');
    expect(next.task_id).toBe('S04-A-T02');
  });

  // -------------------------------------------------------------------------
  // Execution snapshot advancement (S08 execution-chain gap): Slice Commit is
  // a normal execution Git boundary that advances HEAD to a descendant of the
  // admission snapshot. The next consumer must accept that descendant HEAD
  // (and descendant-bound receipts) while still failing closed on a foreign
  // or reverted HEAD, and it must advance past an already-committed Slice to
  // the next dependency-ready Slice.
  // -------------------------------------------------------------------------

  function progressFixture(writeFirstReceipt = true, completeSlice = false): {
    readonly root: string;
    readonly snapshotDigest: string;
    readonly baseManifest: any;
    readonly admitted: ReturnType<typeof admittedManifest>;
    readonly changedFiles: string[];
    readonly firstContextRef: string;
    readonly taskReceiptDir: string;
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-progress-'));
    cleanup.push(root);
    initGit(root);
    const baseManifest = multiSliceManifest();
    const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
    const planPath = path.join(root, 'delivery/stages/S04/tasks.md');
    const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
    const evidenceBPath = path.join(root, 'delivery/stages/S04/evidence/S04-B.md');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(baseManifest), 'utf8');
    fs.writeFileSync(planPath, 'manifest plan projection\n', 'utf8');
    fs.writeFileSync(evidencePath, 'slice A evidence\n', 'utf8');
    fs.writeFileSync(evidenceBPath, 'slice B evidence\n', 'utf8');
    fs.mkdirSync(path.join(root, 'packages/runtime/src/vnext'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/runtime/src/vnext/dispatch.ts'), 'worker implementation\n', 'utf8');
    fs.writeFileSync(path.join(root, 'packages/runtime/src/vnext/dispatch.spec.ts'), 'worker test\n', 'utf8');
    fs.writeFileSync(path.join(root, 'packages/runtime/src/vnext/next.ts'), 'worker next\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'execution fixture']);

    const snapshotDigest = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const admitted = admittedManifest(baseManifest, snapshotDigest);
    const planAuthorityDir = path.join(root, '.proofloop/receipts/plan/S04');
    fs.mkdirSync(planAuthorityDir, { recursive: true });
    fs.writeFileSync(path.join(planAuthorityDir, 'spv.json'), JSON.stringify(admitted.authority.spv), 'utf8');
    fs.writeFileSync(path.join(planAuthorityDir, 'stage-plan.json'), JSON.stringify(admitted.authority.stagePlan), 'utf8');

    const first = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest,
      persistContext: true,
      verifyReferenceBindings: false,
    });
    expect(first.action).toBe('DISPATCH_WORKER');
    expect(first.slice_id).toBe('S04-A');

    const changedFiles = [
      'delivery/stages/S04/evidence/S04-A.md',
      'delivery/stages/S04/tasks.md',
      'packages/runtime/src/vnext/dispatch.ts',
      'packages/runtime/src/vnext/dispatch.spec.ts',
    ];
    fs.appendFileSync(planPath, 'worker projection\n', 'utf8');
    fs.appendFileSync(evidencePath, 'worker evidence\n', 'utf8');
    fs.appendFileSync(path.join(root, 'packages/runtime/src/vnext/dispatch.ts'), 'worker impl\n', 'utf8');
    fs.appendFileSync(path.join(root, 'packages/runtime/src/vnext/dispatch.spec.ts'), 'worker test\n', 'utf8');

    const taskReceiptDir = path.join(root, '.proofloop/receipts/tasks/S04/S04-A');
    fs.mkdirSync(taskReceiptDir, { recursive: true });
    if (writeFirstReceipt) {
      writeReceipt(
        {
          version: 1,
          type: 'TASK_COMPLETE',
          stage_id: 'S04',
          slice_id: 'S04-A',
          timestamp: '2026-08-06T00:00:00.000Z',
          payload: {
            schema_version: 2,
            action_token: 'progress-task-1',
            mode: 'implement-task',
            outcome: 'completed',
            task_id: 'S04-A-T01',
            evidence_ref: 'delivery/stages/S04/evidence/S04-A.md',
            changed_files: changedFiles,
            verification_runs: [],
            summary: 'progress fixture',
            manifest_digest: admitted.manifestDigest,
            plan_digest: 'b'.repeat(64),
            proof_index_digest: computeDigest(baseManifest.slices[0].proof_index),
            snapshot_digest: snapshotDigest,
            context_ref: first.context_ref,
            context_digest: JSON.parse(
              fs.readFileSync(path.join(root, first.context_ref as string), 'utf8'),
            ).context_digest,
          },
        },
        { receiptDir: taskReceiptDir, tempDir: taskReceiptDir },
      );
      // S08-REVIEW-005: a committed Slice must be backed by a TASK_COMPLETE
      // fact for EVERY Manifest task, so the progress fixture completes the
      // second S04-A task too (with its own real scope modification and
      // Context) instead of leaving a partial Worker chain.
      if (!completeSlice) {
        return {
          root,
          snapshotDigest,
          baseManifest,
          admitted,
          changedFiles,
          firstContextRef: first.context_ref as string,
          taskReceiptDir,
        };
      }
      const second = new VNextNextActionService().nextAction({
        projectRoot: root,
        stageId: 'S04',
        snapshotDigest,
        persistContext: true,
        verifyReferenceBindings: false,
      });
      if (second.action !== 'DISPATCH_WORKER' || second.task_id !== 'S04-A-T02') {
        throw new Error(`expected DISPATCH_WORKER S04-A-T02, got ${second.action} ${String(second.task_id)}`);
      }
      const secondContext = JSON.parse(
        fs.readFileSync(path.join(root, second.context_ref as string), 'utf8'),
      ) as { context_digest: string };
      fs.appendFileSync(
        path.join(root, 'packages/runtime/src/vnext/next.ts'),
        'worker next impl\n',
        'utf8',
      );
      changedFiles.push('packages/runtime/src/vnext/next.ts');
      const written = writeReceipt(
        {
          version: 1,
          type: 'TASK_COMPLETE',
          stage_id: 'S04',
          slice_id: 'S04-A',
          timestamp: '2026-08-06T00:00:01.000Z',
          payload: {
            schema_version: 2,
            action_token: 'progress-task-2',
            mode: 'implement-task',
            outcome: 'completed',
            task_id: 'S04-A-T02',
            evidence_ref: 'delivery/stages/S04/evidence/S04-A.md',
            changed_files: [
              'delivery/stages/S04/evidence/S04-A.md',
              'delivery/stages/S04/tasks.md',
              'packages/runtime/src/vnext/next.ts',
              'packages/runtime/src/vnext/dispatch.spec.ts',
            ],
            verification_runs: [],
            summary: 'progress fixture',
            manifest_digest: admitted.manifestDigest,
            plan_digest: 'b'.repeat(64),
            proof_index_digest: computeDigest(baseManifest.slices[0].proof_index),
            snapshot_digest: snapshotDigest,
            context_ref: second.context_ref,
            context_digest: secondContext.context_digest,
          },
        },
        { receiptDir: taskReceiptDir, tempDir: taskReceiptDir },
      );
    }
    return {
      root,
      snapshotDigest,
      baseManifest,
      admitted,
      changedFiles,
      firstContextRef: first.context_ref as string,
      taskReceiptDir,
    };
  }

  function writeCvPassReceipt(
    root: string,
    fixture: ReturnType<typeof progressFixture>,
  ): string {
    const taskDir = path.join(root, '.proofloop/receipts/tasks/S04/S04-A');
    // The CV fact binds the Worker chain tip: the latest completed task of
    // the Slice (S04-A-T02), never a filename-sorted guess.
    const tipReceipt = fs
      .readdirSync(taskDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(taskDir, name), 'utf8')),
      )
      .filter((receipt: { payload: { task_id: string } }) =>
        receipt.payload.task_id === 'S04-A-T02',
      )
      .sort((left: { timestamp: string }, right: { timestamp: string }) =>
        left.timestamp < right.timestamp ? -1 : left.timestamp > right.timestamp ? 1 : 0,
      )
      .pop() as { digest: string; payload: { context_ref: string; context_digest: string } };
    if (tipReceipt === undefined) {
      throw new Error('S04-A-T02 Worker chain tip is unavailable');
    }
    const proofIndex = (fixture.baseManifest.slices as Array<Record<string, any>>)[0]
      .proof_index as Record<string, any>;
    const cvDir = path.join(root, '.proofloop/receipts/cv/S04/S04-A');
    fs.mkdirSync(cvDir, { recursive: true });
    const written = writeReceipt(
      {
        version: 1,
        type: 'CV_PASS',
        stage_id: 'S04',
        slice_id: 'S04-A',
        timestamp: '2026-08-06T00:00:02.000Z',
        payload: {
          schema_version: 2,
          type: 'CV_RESULT',
          stage_id: 'S04',
          slice_id: 'S04-A',
          worker_receipt_digest: tipReceipt.digest,
          manifest_digest: fixture.admitted.manifestDigest,
          plan_digest: 'b'.repeat(64),
          proof_index_digest: computeDigest(fixture.baseManifest.slices[0].proof_index),
          context_ref: tipReceipt.payload.context_ref,
          context_digest: tipReceipt.payload.context_digest,
          snapshot_digest: fixture.snapshotDigest,
          verification_type: 'initial',
          verdict: 'PASS',
          summary: 'progress fixture CV',
          acceptance_refs_checked: [...proofIndex.acceptance_refs],
          seam_refs_checked: [...proofIndex.seam_refs],
          oracle_refs_checked: [...proofIndex.oracle_refs],
          risk_refs_considered: proofIndex.risk_refs.map((risk: Record<string, string>) => ({
            ref_id: risk.ref_id,
            applicability: 'APPLICABLE',
            reason: 'progress fixture binding',
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
    return written.digest;
  }

  function writeSliceCommitReceipt(
    root: string,
    fixture: ReturnType<typeof progressFixture>,
    commitSha: string,
    cvReceiptDigest: string,
  ): void {
    const committerDir = path.join(root, '.proofloop/receipts/committer/S04/S04-A');
    fs.mkdirSync(committerDir, { recursive: true });
    writeReceipt(
      {
        version: 1,
        type: 'SLICE_COMMIT',
        stage_id: 'S04',
        slice_id: 'S04-A',
        timestamp: '2026-08-06T00:00:03.000Z',
        payload: {
          schema_version: 2,
          type: 'SLICE_COMMIT_RESULT',
          action: 'SLICE_COMMIT',
          stage_id: 'S04',
          slice_id: 'S04-A',
          manifest_digest: fixture.admitted.manifestDigest,
          plan_digest: 'b'.repeat(64),
          proof_index_digest: computeDigest(fixture.baseManifest.slices[0].proof_index),
          snapshot_digest: fixture.snapshotDigest,
          commit_sha: commitSha,
          cv_receipt_digest: cvReceiptDigest,
          changed_files: fixture.changedFiles,
          receipt_chain_valid: true,
        },
      },
      { receiptDir: committerDir, tempDir: committerDir },
    );
  }

  it('advances execution past a committed Slice to the next dependency-ready Slice after a descendant HEAD', () => {
    // The committed Slice must have a TASK_COMPLETE fact for EVERY Manifest
    // task (S08-REVIEW-005), so the fixture completes the whole S04-A chain.
    const fx = progressFixture(true, true);
    // Slice Commit is a legal execution Git boundary: HEAD advances to a
    // descendant of the admission snapshot and a SLICE_COMMIT fact backed by
    // a persisted CV_PASS tip is written (S08-REVIEW-004 semantic bindings).
    const cvPassDigest = writeCvPassReceipt(fx.root, fx);
    execFileSync('git', ['-C', fx.root, 'add', '-A']);
    execFileSync('git', ['-C', fx.root, 'commit', '-q', '-m', 'slice A commit']);
    const committedHead = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeSliceCommitReceipt(fx.root, fx, committedHead, cvPassDigest);

    const next = new VNextNextActionService().nextAction({
      projectRoot: fx.root,
      stageId: 'S04',
      snapshotDigest: fx.snapshotDigest,
      verifyReferenceBindings: false,
    });
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S04-B');
    expect(next.task_id).toBe('S04-B-T01');
    expect(next.snapshot_digest).toBe(fx.snapshotDigest);
  });

  it('accepts a descendant execution HEAD after a persisted TASK_COMPLETE fact bound to the admission snapshot', () => {
    const fx = progressFixture();
    // The persisted Worker fact binds the admission snapshot; a later legal
    // execution Git boundary advances HEAD to a descendant. The next consumer
    // must not treat the advanced HEAD as a stale/foreign execution snapshot.
    execFileSync('git', ['-C', fx.root, 'add', '-A']);
    execFileSync('git', ['-C', fx.root, 'commit', '-q', '-m', 'execution boundary']);

    const next = new VNextNextActionService().nextAction({
      projectRoot: fx.root,
      stageId: 'S04',
      snapshotDigest: fx.snapshotDigest,
      verifyReferenceBindings: false,
    });
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S04-A');
    expect(next.task_id).toBe('S04-A-T02');
  });

  it('accepts TASK_COMPLETE receipts bound to a descendant execution commit', () => {
    const fx = progressFixture(false);
    execFileSync('git', ['-C', fx.root, 'add', '-A']);
    execFileSync('git', ['-C', fx.root, 'commit', '-q', '-m', 'execution boundary']);
    const committedHead = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    // Rebind the persisted Context to the descendant execution commit and
    // write a TASK_COMPLETE fact bound to that same descendant snapshot.
    const original = JSON.parse(fs.readFileSync(path.join(fx.root, fx.firstContextRef), 'utf8')) as Record<string, unknown>;
    const rebound = { ...original, snapshot_digest: committedHead } as Record<string, unknown>;
    delete rebound.context_digest;
    const reboundDigest = computeDigest(rebound);
    const reboundRef = `.proofloop/context/${reboundDigest}.json`;
    fs.writeFileSync(
      path.join(fx.root, reboundRef),
      JSON.stringify({ ...rebound, context_digest: reboundDigest }, null, 2) + '\n',
      'utf8',
    );
    writeReceipt(
      {
        version: 1,
        type: 'TASK_COMPLETE',
        stage_id: 'S04',
        slice_id: 'S04-A',
        timestamp: '2026-08-06T00:00:02.000Z',
        payload: {
          schema_version: 2,
          action_token: 'progress-task-2',
          mode: 'implement-task',
          outcome: 'completed',
          task_id: 'S04-A-T01',
          evidence_ref: 'delivery/stages/S04/evidence/S04-A.md',
          changed_files: fx.changedFiles,
          verification_runs: [],
          summary: 'descendant-bound fixture',
          manifest_digest: fx.admitted.manifestDigest,
          plan_digest: 'b'.repeat(64),
          proof_index_digest: computeDigest(fx.baseManifest.slices[0].proof_index),
          snapshot_digest: committedHead,
          context_ref: reboundRef,
          context_digest: reboundDigest,
        },
      },
      { receiptDir: fx.taskReceiptDir, tempDir: fx.taskReceiptDir },
    );

    const next = new VNextNextActionService().nextAction({
      projectRoot: fx.root,
      stageId: 'S04',
      snapshotDigest: fx.snapshotDigest,
      verifyReferenceBindings: false,
    });
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S04-A');
    expect(next.task_id).toBe('S04-A-T02');
  });

  it('fails closed when execution HEAD is not a descendant of the admitted snapshot', () => {
    const fx = progressFixture();
    // A foreign (unrelated) HEAD is not a legal execution Git boundary.
    execFileSync('git', ['-C', fx.root, 'checkout', '-q', '--orphan', 'foreign']);
    execFileSync('git', ['-C', fx.root, 'add', '-A']);
    execFileSync('git', ['-C', fx.root, 'commit', '-q', '-m', 'foreign boundary']);

    const next = new VNextNextActionService().nextAction({
      projectRoot: fx.root,
      stageId: 'S04',
      snapshotDigest: fx.snapshotDigest,
      verifyReferenceBindings: false,
    });
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/descendant|ancestor|snapshot/);
  });

  it('fails closed when a persisted TASK_COMPLETE fact binds a tampered Context identity', () => {
    const fx = progressFixture();
    // Tamper a Context field that the TASK_COMPLETE binding checks only
    // through the canonical content digest: proof_index.risk_refs is not
    // field-checked by the receipt binding, so a value change there is
    // detectable only by the read-time Context identity re-check, and the
    // next consumer must fail closed instead of re-projecting the next
    // Worker dispatch from an invalid Context authority.
    const contextPath = path.join(fx.root, fx.firstContextRef);
    const parsed = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, any>;
    const tampered = {
      ...parsed,
      proof_index: { ...parsed.proof_index, risk_refs: ['RISK-TAMPERED'] },
    };
    fs.writeFileSync(contextPath, JSON.stringify(tampered, null, 2) + '\n', 'utf8');

    const next = new VNextNextActionService().nextAction({
      projectRoot: fx.root,
      stageId: 'S04',
      snapshotDigest: fx.snapshotDigest,
      verifyReferenceBindings: false,
    });
    expect(next.action).toBe('VALIDATE');
    expect((next as VNextNextActionOutput).task_id).toBeUndefined();
    expect(next.findings[0]?.message).toMatch(/Context|digest/i);
  });
});

// ---------------------------------------------------------------------------
// S08-C-T02 — minimal, root-bound, self-verifiable current Task Context
// Projection. The generated Context must be re-verifiable from its own
// content (context_digest), its root binding (root_digest), and its
// root-bound entity references (task_ref / slice_goal_ref resolve to the
// same entities and digests the admitted Manifest binds).
// ---------------------------------------------------------------------------

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

/** S08 real-file fixture mirroring the admitted S08 candidate boundary. */
function s08TaskContextFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-s08c-'));
  cleanup.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-dispatch-s08c@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Dispatch S08C Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  const repoRoot = path.resolve(__dirname, '../../../..');
  for (const pair of [
    ['delivery/stages/S08/tasks.md', 'delivery/stages/S08/tasks.md'],
    ['.proofloop/manifests/S08.json', '.proofloop/manifests/S08.json'],
    ['delivery/stages/S08/evidence/S08-C.md', 'delivery/stages/S08/evidence/S08-C.md'],
    ['delivery/stages/S0-A/tasks.md', 'delivery/stages/S0-A/tasks.md'],
    ['tech-spec/task-acceptance-matrix.md', 'tech-spec/task-acceptance-matrix.md'],
    ['tech-spec/contract-state-matrix.md', 'tech-spec/contract-state-matrix.md'],
    ['tech-spec/ai-coding-architecture.md', 'tech-spec/ai-coding-architecture.md'],
    ['tech-spec/hard-parts-register.md', 'tech-spec/hard-parts-register.md'],
  ] as const) {
    const target = path.join(root, pair[1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, pair[0]), target);
  }
  rebindS08ReferenceDigests(root);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'S08 candidate boundary']);
  return root;
}

function s08TaskContextAdmitted(root: string): {
  manifest: any;
  manifestDigest: string;
  snapshotDigest: string;
  authority: any;
} {
  const snapshotDigest = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.proofloop/manifests/S08.json'), 'utf8')) as any;
  const manifestDigest = computeDigest(manifest);
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: 'S08',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
  };
  const spv = { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) };
  const stagePlanContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'STAGE_PLAN' as const,
    stage_id: 'S08',
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
    spv_receipt_digest: spv.digest,
  };
  const stagePlan = { ...stagePlanContent, digest: computeVNextStagePlanReceiptDigest(stagePlanContent) };
  return { manifest, manifestDigest, snapshotDigest, authority: { stagePlan, spv } };
}

describe('vNext current Task Context Projection (S08-C-T02)', () => {
  it('projects a minimal root-bound self-verifiable Context for the current Task', () => {
    const root = s08TaskContextFixture();
    const admitted = s08TaskContextAdmitted(root);
    const result = projectVNextWorkerDispatch({
      root,
      manifest: admitted.manifest,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: admitted.snapshotDigest,
      authority: admitted.authority,
      sliceId: 'S08-C',
      completedTaskIds: ['S08-C-T01'],
      provenCompleteSlices: new Set(['S08-A', 'S08-B']),
      verifyReferenceBindings: true,
    });
    expect(result.action).toBe('DISPATCH_WORKER');
    expect(result.slice_id).toBe('S08-C');
    expect(result.task_id).toBe('S08-C-T02');
    expect(result.context.task_ref).toBe('delivery/stages/S08/tasks.md#/entities/S08-C-T02');
    expect(result.context.slice_goal_ref).toBe('REF-S08-C-GOAL');
    expect(result.context.evidence_path).toBe('delivery/stages/S08/evidence/S08-C.md');
    expect(result.context.plan_projection_path).toBe('delivery/stages/S08/tasks.md');
    // Self-verifiable: the persisted Context re-verifies against the admitted
    // Manifest and the root-bound source entities without trusting strings.
    expect(() => verifyVNextWorkerContextBindings(root, admitted.manifest, result.context)).not.toThrow();
    // Minimal: the Context must not leak Plan body or Worker Evidence text.
    const serialized = JSON.stringify(result.context);
    expect(serialized).not.toContain('Primary Next Action');
    expect(serialized).not.toContain('Stage Goal');
    expect(serialized).not.toContain('Worker Evidence');
    // context_digest binds the exact projected content.
    const withoutDigest = { ...result.context } as Record<string, unknown>;
    delete withoutDigest.context_digest;
    expect(computeDigest(withoutDigest)).toBe(result.context.context_digest);
  });

  it('fails closed when the Context task_ref does not resolve to the projected Task entity', () => {
    const root = s08TaskContextFixture();
    const admitted = s08TaskContextAdmitted(root);
    const result = projectVNextWorkerDispatch({
      root,
      manifest: admitted.manifest,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: admitted.snapshotDigest,
      authority: admitted.authority,
      sliceId: 'S08-C',
      completedTaskIds: ['S08-C-T01'],
      provenCompleteSlices: new Set(['S08-A', 'S08-B']),
      verifyReferenceBindings: true,
    });
    const tampered = {
      ...result.context,
      task_ref: 'delivery/stages/S08/tasks.md#/entities/S08-C-T03',
      task_id: 'S08-C-T03',
    } as unknown as Record<string, unknown>;
    delete tampered.context_digest;
    const context = { ...tampered, context_digest: computeDigest(tampered) } as Parameters<typeof verifyVNextWorkerContextBindings>[2];
    expect(() => verifyVNextWorkerContextBindings(root, admitted.manifest, context)).toThrow(
      VNextHandoffError,
    );
  });

  it('fails closed when the task entity body drifts from the admitted section digest', () => {
    const root = s08TaskContextFixture();
    const admitted = s08TaskContextAdmitted(root);
    // Drift the S08-C-T02 task body in the Plan source after admission.
    const planPath = path.join(root, 'delivery/stages/S08/tasks.md');
    const plan = fs.readFileSync(planPath, 'utf8');
    fs.writeFileSync(planPath, plan.replace(/S08-C-T02 — 生成最小/, 'S08-C-T02 — 生成最小drifted'), 'utf8');
    expect(() => projectVNextWorkerDispatch({
      root,
      manifest: admitted.manifest,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: admitted.snapshotDigest,
      authority: admitted.authority,
      sliceId: 'S08-C',
      completedTaskIds: ['S08-C-T01'],
      provenCompleteSlices: new Set(['S08-A', 'S08-B']),
      verifyReferenceBindings: true,
    })).toThrowError(/file_digest|section_digest|reference-digest-mismatch/);
  });

  it('fails closed when the slice_goal_ref is not a registered goal reference', () => {
    const root = s08TaskContextFixture();
    const admitted = s08TaskContextAdmitted(root);
    const result = projectVNextWorkerDispatch({
      root,
      manifest: admitted.manifest,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest: admitted.snapshotDigest,
      authority: admitted.authority,
      sliceId: 'S08-C',
      completedTaskIds: ['S08-C-T01'],
      provenCompleteSlices: new Set(['S08-A', 'S08-B']),
      verifyReferenceBindings: true,
    });
    const tampered = { ...result.context, slice_goal_ref: 'REF-NOT-A-GOAL' } as unknown as Record<string, unknown>;
    delete tampered.context_digest;
    const context = { ...tampered, context_digest: computeDigest(tampered) } as Parameters<typeof verifyVNextWorkerContextBindings>[2];
    expect(() => verifyVNextWorkerContextBindings(root, admitted.manifest, context)).toThrow(
      VNextHandoffError,
    );
  });
});

// ---------------------------------------------------------------------------
// S08-C-T03 — missing or stale admission / broken Context identity never
// produce a Worker dispatch. Re-entry over the same admitted tuple is
// idempotent (identical digest-addressed ContextRef, write-once persistence);
// a missing admission fact, a stale authority binding, or a tampered Context
// body fails closed to bounded VALIDATE without persisting any executable
// Context authority (S08-C Acceptance/Seam/Oracle/Risk).
// ---------------------------------------------------------------------------

describe('vNext dispatch re-entry and Context identity (S08-C-T03)', () => {
  function s08AdmittedNextFixture(): {
    readonly root: string;
    readonly snapshotDigest: string;
  } {
    const root = s08TaskContextFixture();
    const admitted = s08TaskContextAdmitted(root);
    const planDir = path.join(root, '.proofloop/receipts/plan/S08');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'vnext-spv-pass.json'), JSON.stringify(admitted.authority.spv), 'utf8');
    fs.writeFileSync(path.join(planDir, 'vnext-stage-plan.json'), JSON.stringify(admitted.authority.stagePlan), 'utf8');
    return { root, snapshotDigest: admitted.snapshotDigest };
  }

  it('re-projects and re-persists the identical digest-addressed Context idempotently across re-entry', () => {
    const { root, snapshotDigest } = s08AdmittedNextFixture();
    const service = new VNextNextActionService();
    const first = service.nextAction({
      projectRoot: root,
      stageId: 'S08',
      snapshotDigest,
      persistContext: true,
      verifyReferenceBindings: true,
    });
    expect(first.action).toBe('DISPATCH_WORKER');
    expect(first.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    const contextPath = path.join(root, first.context_ref as string);
    const firstBytes = fs.readFileSync(contextPath, 'utf8');

    const second = service.nextAction({
      projectRoot: root,
      stageId: 'S08',
      snapshotDigest,
      persistContext: true,
      verifyReferenceBindings: true,
    });
    expect(second.action).toBe('DISPATCH_WORKER');
    expect(second.context_ref).toBe(first.context_ref);
    expect(fs.readFileSync(contextPath, 'utf8')).toBe(firstBytes);
    expect(fs.readdirSync(path.join(root, '.proofloop/context'))).toEqual([
      path.posix.basename(first.context_ref as string),
    ]);
  });

  it('fails closed when the persisted Context identity is tampered and never overwrites it', () => {
    const { root, snapshotDigest } = s08AdmittedNextFixture();
    const service = new VNextNextActionService();
    const first = service.nextAction({
      projectRoot: root,
      stageId: 'S08',
      snapshotDigest,
      persistContext: true,
      verifyReferenceBindings: true,
    });
    expect(first.action).toBe('DISPATCH_WORKER');
    const contextPath = path.join(root, first.context_ref as string);
    const tampered = JSON.stringify({ tampered: true, context_digest: 'f'.repeat(64) }, null, 2) + '\n';
    fs.writeFileSync(contextPath, tampered, 'utf8');

    const second = service.nextAction({
      projectRoot: root,
      stageId: 'S08',
      snapshotDigest,
      persistContext: true,
      verifyReferenceBindings: true,
    });
    expect(second.action).toBe('VALIDATE');
    expect((second as VNextNextActionOutput).context_ref).toBeUndefined();
    // Write-once: the tampered body must not be silently repaired or replaced.
    expect(fs.readFileSync(contextPath, 'utf8')).toBe(tampered);
  });
});

// ---------------------------------------------------------------------------
// S08-C-T04 — restart recovery: after an OpenCode restart the canonical
// next/context is re-projected ONLY from Git, Manifest and Receipts, never
// from session, progress or Worker narrative files. The fixture contains no
// session/progress/narrative state; a fresh VNextNextActionService instance
// (the consumer is stateless) re-projects the identical canonical Context,
// a tampered Receipt fails closed, and an out-of-scope progress artifact is
// rejected by the execution dirty boundary.
// ---------------------------------------------------------------------------

const S08_RESTART_REAL_FILES: readonly string[] = [
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

const S08_RESTART_SCOPE_FILE_BY_TASK: Record<string, string> = {
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

function s08RestartChainFixture(): {
  readonly root: string;
  readonly snapshotDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly taskReceiptPaths: Record<string, string>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-restart-s08-'));
  cleanup.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-dispatch-restart@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Dispatch Restart Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  const repoRoot = path.resolve(__dirname, '../../../..');
  for (const relative of S08_RESTART_REAL_FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), target);
  }
  // The fixture represents the pre-T04 execution state: the pending Task's
  // checkbox stays unchecked so the restart projects implement-task (a
  // checked box without an admitted Receipt is the recover discriminator).
  // Every S08-A/S08-B/S08-C task that this fixture then completes is also
  // un-checked first, so completing it really modifies the Plan projection
  // (the entity resolver normalizes checkbox state, so the admitted
  // Manifest file/section digests stay stable) and the Slice Commit Git
  // boundary really contains tasks.md — the S08-REVIEW-005 commit-diff
  // cross-validation compares the actual parent..commit file set against
  // the declared changed_files.
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
  const snapshotDigest = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const admitted = s08TaskContextAdmitted(root);
  const planDir = path.join(root, '.proofloop/receipts/plan/S08');
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, 'vnext-spv-pass.json'), JSON.stringify(admitted.authority.spv), 'utf8');
  fs.writeFileSync(path.join(planDir, 'vnext-stage-plan.json'), JSON.stringify(admitted.authority.stagePlan), 'utf8');

  const taskReceiptPaths: Record<string, string> = {};
  const chain: Array<{ sliceId: string; tasks: string[]; commit: boolean }> = [
    { sliceId: 'S08-A', tasks: ['S08-A-T01', 'S08-A-T02', 'S08-A-T03'], commit: true },
    { sliceId: 'S08-B', tasks: ['S08-B-T01', 'S08-B-T02', 'S08-B-T03'], commit: true },
    { sliceId: 'S08-C', tasks: ['S08-C-T01', 'S08-C-T02', 'S08-C-T03'], commit: false },
  ];
  let tick = 0;
  const timestamp = (): string => `2026-08-07T01:00:${String(tick++).padStart(2, '0')}.000Z`;
  const service = new VNextNextActionService();
  for (const { sliceId, tasks, commit } of chain) {
    const slice = admitted.manifest.slices.find((candidate: { slice_id: string }) => candidate.slice_id === sliceId);
    if (slice === undefined) throw new Error(`Slice ${sliceId} is unavailable`);
    const proofIndexDigest = computeDigest(slice.proof_index);
    const sliceChangedFiles: string[] = [];
    for (const taskId of tasks) {
      const output = service.nextAction({
        projectRoot: root,
        stageId: 'S08',
        snapshotDigest,
        persistContext: true,
        verifyReferenceBindings: true,
      });
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
      const scopeFile = S08_RESTART_SCOPE_FILE_BY_TASK[taskId];
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
            manifest_digest: admitted.manifestDigest,
            plan_digest: admitted.manifest.plan.plan_digest,
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
            manifest_digest: admitted.manifestDigest,
            plan_digest: admitted.manifest.plan.plan_digest,
            proof_index_digest: proofIndexDigest,
            context_ref: lastReceipt.payload.context_ref,
            context_digest: lastReceipt.payload.context_digest,
            snapshot_digest: snapshotDigest,
            verification_type: 'initial',
            verdict: 'PASS',
            summary: 'restart fixture CV',
            acceptance_refs_checked: [...slice.proof_index.acceptance_refs],
            seam_refs_checked: [...slice.proof_index.seam_refs],
            oracle_refs_checked: [...slice.proof_index.oracle_refs],
            risk_refs_considered: slice.proof_index.risk_refs.map((risk: { ref_id: string }) => ({
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
      const committedHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
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
            manifest_digest: admitted.manifestDigest,
            plan_digest: admitted.manifest.plan.plan_digest,
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
  return {
    root,
    snapshotDigest,
    manifestDigest: admitted.manifestDigest,
    planDigest: admitted.manifest.plan.plan_digest,
    taskReceiptPaths,
  };
}

describe('vNext restart recovery re-projection (S08-C-T04)', () => {
  it('re-projects the canonical S08-C-T04 next and a self-verifiable Context after a restart from persisted Receipts only', () => {
    const chain = s08RestartChainFixture();
    // Restart: a FRESH service instance re-projects next/context only from
    // the persisted Git/Manifest/Receipt facts.
    const restart = new VNextNextActionService().nextAction({
      projectRoot: chain.root,
      stageId: 'S08',
      snapshotDigest: chain.snapshotDigest,
      persistContext: true,
      verifyReferenceBindings: true,
    });
    expect(restart.action).toBe('DISPATCH_WORKER');
    expect(restart.slice_id).toBe('S08-C');
    expect(restart.task_id).toBe('S08-C-T04');
    expect(restart.mode).toBe('implement-task');
    expect(restart.manifest_digest).toBe(chain.manifestDigest);
    expect(restart.plan_digest).toBe(chain.planDigest);
    expect(restart.snapshot_digest).toBe(chain.snapshotDigest);
    expect(restart.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    // The re-projected Context is self-verifiable against the admitted
    // Manifest and the root-bound entity sources.
    const context = JSON.parse(
      fs.readFileSync(path.join(chain.root, restart.context_ref as string), 'utf8'),
    );
    expect(() =>
      verifyVNextWorkerContextBindings(chain.root, JSON.parse(fs.readFileSync(path.join(chain.root, '.proofloop/manifests/S08.json'), 'utf8')), context as never),
    ).not.toThrow();
    expect(context.task_ref).toBe('delivery/stages/S08/tasks.md#/entities/S08-C-T04');

    // A second fresh instance (another restart) yields the identical
    // canonical projection and byte-identical Context — it is a derived fact,
    // never session state.
    const again = new VNextNextActionService().nextAction({
      projectRoot: chain.root,
      stageId: 'S08',
      snapshotDigest: chain.snapshotDigest,
      persistContext: true,
      verifyReferenceBindings: true,
    });
    expect(again.action).toBe('DISPATCH_WORKER');
    expect(again.task_id).toBe('S08-C-T04');
    expect(again.context_ref).toBe(restart.context_ref);
    expect(fs.readFileSync(path.join(chain.root, again.context_ref as string), 'utf8')).toBe(
      fs.readFileSync(path.join(chain.root, restart.context_ref as string), 'utf8'),
    );
  });

  it('fails closed after restart when a persisted TASK_COMPLETE Receipt is tampered', () => {
    const chain = s08RestartChainFixture();
    // Tamper the T03 receipt body without recomputing its self-digest: the
    // persisted chain becomes invalid and the restart must fail closed.
    const t03Path = chain.taskReceiptPaths['S08-C-T03'];
    const receipt = JSON.parse(fs.readFileSync(t03Path, 'utf8')) as Record<string, any>;
    receipt.payload = { ...receipt.payload, summary: 'tampered receipt body' };
    fs.writeFileSync(t03Path, JSON.stringify(receipt), 'utf8');
    const before = fs.readdirSync(path.join(chain.root, '.proofloop/context')).sort();

    const restart = new VNextNextActionService().nextAction({
      projectRoot: chain.root,
      stageId: 'S08',
      snapshotDigest: chain.snapshotDigest,
      persistContext: true,
      verifyReferenceBindings: true,
    });
    expect(restart.action).toBe('VALIDATE');
    expect((restart as VNextNextActionOutput).context_ref).toBeUndefined();
    expect((restart as VNextNextActionOutput).task_id).toBeUndefined();
    // No new Context authority is persisted from the broken chain.
    expect(fs.readdirSync(path.join(chain.root, '.proofloop/context')).sort()).toEqual(before);
  });

  it('rejects an out-of-scope progress artifact after restart instead of deriving state from it', () => {
    const chain = s08RestartChainFixture();
    // A session/progress artifact is not a persisted Git/Manifest/Receipt
    // fact; the execution dirty boundary must fail closed on it and the
    // canonical projection must never be derived from it.
    const progressPath = path.join(chain.root, 'delivery/stages/S08/progress/session.json');
    fs.mkdirSync(path.dirname(progressPath), { recursive: true });
    fs.writeFileSync(progressPath, JSON.stringify({ task: 'S08-C-T04', state: 'completed' }), 'utf8');

    const restart = new VNextNextActionService().nextAction({
      projectRoot: chain.root,
      stageId: 'S08',
      snapshotDigest: chain.snapshotDigest,
      persistContext: true,
      verifyReferenceBindings: true,
    });
    expect(restart.action).toBe('VALIDATE');
    expect((restart as VNextNextActionOutput).context_ref).toBeUndefined();
    expect(restart.findings[0]?.message).toMatch(/execution dirty path/);
  });
});

// ---------------------------------------------------------------------------
// S08-D-T04 — root escape / symlink redirect / manifest-context swap / TOCTOU
// all fail closed (REF-S08-D-ACCEPTANCE: "path escape、symlink、TOCTOU、stale
// snapshot 和 unadmitted next 均不能产生执行 authority"; REF-S08-D-SEAM:
// root-bound canonical paths, no-follow read, manifest/context identity
// re-check, TOCTOU closure; REF-S08-D-ORACLE / REF-S08-D-RISK: real
// filesystem/Git counterexamples, not internal-function mocks).
//
// The dispatch read seam must never follow a symlink outside the trust root
// (file-level or directory-level redirect), never accept a Manifest whose
// content/path ownership changed after admission, and never accept a Context
// bound to a different Manifest — every violation fails closed with
// VNextHandoffError BEFORE any Context authority is produced.
// ---------------------------------------------------------------------------

describe('vNext dispatch security boundary fails closed (S08-D-T04)', () => {
  it('readVNextManifest fails closed when the manifest file is a symlink redirect outside the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-t04-file-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-t04-outside-'));
    cleanup.push(root, outside);
    fs.mkdirSync(path.join(root, '.proofloop', 'manifests'), { recursive: true });
    // The external manifest is a SCHEMA-VALID v2 manifest: only the symlink
    // path ownership may reject the read — the guard must not be a content
    // check that an identical external copy could pass.
    fs.writeFileSync(path.join(outside, 'S04.json'), JSON.stringify(manifest(), null, 2), 'utf8');
    fs.symlinkSync(
      path.join(outside, 'S04.json'),
      path.join(root, '.proofloop', 'manifests', 'S04.json'),
    );
    expect(() => readVNextManifest(root, '.proofloop/manifests/S04.json')).toThrowError(
      /escapes the project root/,
    );
  });

  it('readVNextManifest fails closed when a manifest parent directory is a symlink redirect outside the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-t04-dir-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-dispatch-t04-outside-dir-'));
    cleanup.push(root, outside);
    fs.mkdirSync(path.join(root, '.proofloop'), { recursive: true });
    // Directory-level redirect: `.proofloop/manifests` itself is replaced by
    // a symlink to an outside directory containing a valid S04 manifest. The
    // component-wise walk must reject the redirected PARENT before any read.
    fs.writeFileSync(path.join(outside, 'S04.json'), JSON.stringify(manifest(), null, 2), 'utf8');
    fs.symlinkSync(outside, path.join(root, '.proofloop', 'manifests'), 'dir');
    expect(() => readVNextManifest(root, '.proofloop/manifests/S04.json')).toThrowError(
      /escapes the project root/,
    );
  });

  it('projectVNextWorkerDispatch fails closed when the manifest FILE content was swapped after admission (real Git fixture, digest binding)', () => {
    // REAL Git fixture: the actual repository S04 Manifest + tasks.md +
    // evidence are copied into a fresh worktree, committed, and re-read from
    // the persisted files (never an in-memory object or a fictional root).
    const root = realS04FixtureRoot();
    const manifestPath = '.proofloop/manifests/S04.json';
    const snapshotDigest = gitHead(root);
    // The dispatch seam re-reads the PERSISTED manifest file through the real
    // no-follow read seam.
    const manifest = readVNextManifest(root, manifestPath);
    const manifestDigest = computeDigest(manifest);
    const admitted = realAdmittedManifest(manifest as unknown as Record<string, unknown>, snapshotDigest);
    // Baseline: the admitted manifest dispatches normally (reference bindings
    // verified against the real files — no verifyReferenceBindings bypass).
    const baseline = projectVNextWorkerDispatch({
      root,
      manifest: admitted.value as never,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest,
      authority: admitted.authority,
    });
    expect(baseline.action).toBe('DISPATCH_WORKER');
    expect(baseline.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    // Persist the admitted authority as REAL files so the Runtime next seam
    // re-reads the same persisted authority the Host would.
    const authorityDir = path.join(root, '.proofloop/receipts/plan/S04');
    fs.mkdirSync(authorityDir, { recursive: true });
    fs.writeFileSync(path.join(authorityDir, 'spv.json'), JSON.stringify(admitted.authority.spv));
    fs.writeFileSync(
      path.join(authorityDir, 'stage-plan.json'),
      JSON.stringify(admitted.authority.stagePlan),
    );
    // Content swap: the persisted manifest FILE is replaced by ANOTHER legal
    // v2 manifest (schema-valid, content different — `compiled_by` is a
    // legal manifest field) — the same attack the Runtime next seam would
    // observe after admission.
    const swapped = { ...manifest, compiled_by: 'SWAPPED-MANIFEST-CONTENT' };
    fs.writeFileSync(path.join(root, manifestPath), JSON.stringify(swapped, null, 2) + '\n', 'utf8');
    expect(computeDigest(swapped)).not.toBe(manifestDigest);
    // 1) The dispatch seam re-reads the swapped file and refuses the digest
    //    binding BEFORE any Context authority is projected.
    expect(() =>
      projectVNextWorkerDispatch({
        root,
        manifest: readVNextManifest(root, manifestPath),
        manifestDigest,
        snapshotDigest,
        authority: admitted.authority,
      }),
    ).toThrowError(/manifest_digest does not match/);
    // 2) The Runtime next seam re-reads the persisted authority + manifest
    //    files and fails closed to a bounded VALIDATE — no Worker dispatch,
    //    no Context authority.
    const outcome = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest,
      persistContext: true,
    });
    expect(outcome.action).toBe('VALIDATE');
    expect(outcome.context_ref).toBeUndefined();
    expect(outcome.task_id).toBeUndefined();
    expect(outcome.findings[0]?.message).toMatch(/digest|Manifest|binding/i);
    expect(fs.existsSync(path.join(root, '.proofloop/context'))).toBe(false);
  });

  it('verifyVNextWorkerContextBindings fails closed when the Context FILE was swapped to bind a different Manifest (real Git fixture)', () => {
    const root = realS04FixtureRoot();
    const manifestPath = '.proofloop/manifests/S04.json';
    const snapshotDigest = gitHead(root);
    const manifest = readVNextManifest(root, manifestPath);
    const admitted = realAdmittedManifest(manifest as unknown as Record<string, unknown>, snapshotDigest);
    const baseline = projectVNextWorkerDispatch({
      root,
      manifest: admitted.value as never,
      manifestDigest: admitted.manifestDigest,
      snapshotDigest,
      authority: admitted.authority,
    });
    expect(baseline.action).toBe('DISPATCH_WORKER');
    // The baseline Context is persisted as a digest-addressed FILE through
    // the SAME persistence seam the Runtime next consumer uses.
    persistVNextWorkerContext(root, baseline);
    const baselineContextPath = path.join(root, baseline.context_ref);
    expect(fs.existsSync(baselineContextPath)).toBe(true);
    const persistedContext = JSON.parse(
      fs.readFileSync(baselineContextPath, 'utf8'),
    ) as Record<string, unknown>;
    expect(persistedContext.manifest_digest).toBe(admitted.manifestDigest);
    // A DIFFERENT (also valid) Manifest: the swap is self-consistent
    // (context_digest recomputed) but the Context now binds the wrong
    // Manifest — the persisted FILE replacement must fail the identity
    // re-check, never trusting a string-carried manifest digest.
    const swappedManifest = { ...manifest, compiled_by: 'SWAPPED-CONTEXT-BINDING' };
    const swappedContextWithoutDigest: Record<string, unknown> = {
      ...persistedContext,
      manifest_digest: computeDigest(swappedManifest),
    };
    delete swappedContextWithoutDigest.context_digest;
    const swappedContext: Record<string, unknown> = {
      ...swappedContextWithoutDigest,
      context_digest: computeDigest(swappedContextWithoutDigest),
    };
    // 1) Dispatch seam: the identity re-check against the ADMITTED manifest
    //    rejects the swapped Context file content.
    expect(() =>
      verifyVNextWorkerContextBindings(
        root,
        admitted.value as never,
        swappedContext as unknown as Parameters<typeof verifyVNextWorkerContextBindings>[2],
      ),
    ).toThrowError(/manifest_digest does not match/);
    // 2) Runtime next seam: persist the swapped Context as a digest-addressed
    //    FILE and admit a TASK_COMPLETE whose payload references it — the
    //    next seam RE-READS the persisted Context file and fails closed on
    //    the manifest binding (bounded VALIDATE, no further authority).
    const swappedContextRef = `.proofloop/context/${swappedContext.context_digest}.json`;
    fs.writeFileSync(
      path.join(root, swappedContextRef),
      JSON.stringify(swappedContext, null, 2) + '\n',
      'utf8',
    );
    const dir = path.join(root, '.proofloop/receipts/plan/S04');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spv.json'), JSON.stringify(admitted.authority.spv));
    fs.writeFileSync(path.join(dir, 'stage-plan.json'), JSON.stringify(admitted.authority.stagePlan));
    const slice = (admitted.value as { slices: Array<{ proof_index: unknown; evidence_path: string }> }).slices[0];
    const receiptDir = path.join(root, '.proofloop/receipts/tasks/S04/S04-A');
    fs.mkdirSync(receiptDir, { recursive: true });
    writeReceipt(
      {
        version: 1,
        type: 'TASK_COMPLETE',
        stage_id: 'S04',
        slice_id: 'S04-A',
        timestamp: '2026-08-06T00:00:05.000Z',
        payload: {
          schema_version: 2,
          action_token: 'swapped-context-fact',
          mode: 'implement-task',
          outcome: 'completed',
          task_id: 'S04-A-T01',
          evidence_ref: slice.evidence_path,
          changed_files: [
            'delivery/stages/S04/evidence/S04-A.md',
            'delivery/stages/S04/tasks.md',
            'packages/runtime/src/vnext/dispatch.ts',
          ],
          manifest_digest: admitted.manifestDigest,
          plan_digest: admitted.planDigest,
          proof_index_digest: computeDigest(slice.proof_index),
          snapshot_digest: snapshotDigest,
          context_ref: swappedContextRef,
          context_digest: swappedContext.context_digest,
        },
      },
      { receiptDir, tempDir: receiptDir },
    );
    const outcome = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: 'S04',
      snapshotDigest,
      persistContext: true,
    });
    expect(outcome.action).toBe('VALIDATE');
    expect(outcome.context_ref).toBeUndefined();
    expect(outcome.task_id).toBeUndefined();
    expect(outcome.findings[0]?.message).toMatch(/Context is not bound|manifest-binding|digest/i);
  });
});
