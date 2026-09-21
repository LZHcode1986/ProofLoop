/**
 * MES_MAINTENANCE bounded entry seam tests (S06-R-D-T01).
 *
 * PO: contracts.md §2.1.5 mes-maintenance-recovery-boundary (entry basis
 * machine-verified: frozen SHA/count, forensic/audit refs+digests, Git
 * basis, physical quarantine, Brain bounded authorization), §4.2 packet
 * maintenance_binding closure, §7 structured no-entry blocker; acceptance
 * E2E-24 / E2E-26 / STATIC-33; architecture mes-maintenance-recovery-boundary.
 *
 * The seam is ENTRY ONLY — it never writes. All fixtures are isolated temp
 * Git roots: a synthetic 130-fact frozen snapshot under a 0555-quarantined
 * `.proofloop/mes`, root-bound immutable forensic/audit artifacts, a
 * root-bound recovery candidate Plan, and a committed git basis on a
 * root-bound DETACHED isolated evidence worktree (the main worktree is
 * never the maintenance entry target). The real project `.proofloop/mes`
 * is never a fixture and never a mutation target.
 *
 * Positive: an EXACT tuple (frozen sha256/count + forensic/audit sha256 +
 * Git head/branch/worktree + quarantine 0555 + lane token equality) yields a
 * typed entry and leaves every fixture byte-stable (no write).
 *
 * Negative (typed no-entry blockers): stale digest, wrong count, mismatched
 * forensic/audit digest, missing/mis-pointed ref, escaping ref, missing or
 * mismatched authorization marker, wrong Git head/branch/worktree,
 * main-worktree target (identity '.' or any main-checkout path), writable
 * quarantine, frozen accepted-Plan substitution, non-canonical
 * authority/plan refs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { commitAll, makeFixture, sha } from './helpers';
import {
  MaintenanceSeamError,
  MES_MAINTENANCE_MODE,
  verifyMaintenanceBindingTuple,
  verifyMaintenanceEntry,
} from '../dist/mes/maintenance-seam';
import type {
  MaintenanceBinding,
  MaintenanceEntryBasis,
  MaintenanceEntryContext,
  MaintenanceGitBasis,
} from '../dist/mes/maintenance-seam';

const STAGE = 'S06';
const LANE_TOKEN = 'b4667878-09ee-4f16-94c6-eb31f97e115c';
const PLAN_REF = 'delivery/stages/S06/recovery-plan-r9.md';
/** Root-relative isolated maintenance evidence worktree of the entry fixture. */
const ENTRY_WORKTREE_REL = '.proofloop/worktrees/entry-D';
/**
 * Fixture recovery candidate Thin Plan: carries the exact machine markers the
 * seam binds (RECOVERY_REBASELINE / MES_MAINTENANCE / candidate_plan_ref
 * self-identity). Committed so the byte-fresh check closes.
 */
const RECOVERY_CANDIDATE_PLAN = [
  '# S06 Recovery Candidate Thin Plan (fixture)',
  'execution_mode: RECOVERY_REBASELINE',
  'executable_execution_mode: MES_MAINTENANCE',
  'candidate_plan_ref: delivery/stages/S06/recovery-plan-r9.md',
  '',
].join('\n');
const AUTHORITY_REFS = [
  'tech-spec/contracts.md#/entities/mes-maintenance-recovery-boundary',
  'tech-spec/acceptance.md#E2E-26',
];

function fileDigest(abs: string): string {
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/** A 130-fact synthetic frozen snapshot (fixture-only, never the real MES). */
function frozenSnapshotJson(): string {
  const facts = [];
  for (let index = 0; index < 130; index += 1) {
    facts.push({
      schema_version: 2,
      fact_id: `mes:fact:fixture:${String(index).padStart(3, '0')}`,
      fact_kind: index < 7 ? 'work' : 'project',
      created_by: 'brain',
    });
  }
  return JSON.stringify({ schema_version: 2, facts }, null, 2);
}

interface EntryFixture {
  readonly root: string;
  readonly binding: MaintenanceBinding;
  readonly gitBasis: MaintenanceGitBasis;
  readonly basis: MaintenanceEntryBasis;
  readonly context: MaintenanceEntryContext;
  readonly frozenAbs: string;
  readonly forensicAbs: string;
  readonly auditAbs: string;
  cleanup(): void;
}

function makeEntryFixture(): EntryFixture {
  const fixture = makeFixture();
  fixture.write('.proofloop/mes/snapshot.json', frozenSnapshotJson());
  fixture.write(
    '.proofloop/forensics/mes-recovery-fixture-001/incident.json',
    JSON.stringify({ incident: 's06-binding-mismatch-fixture', ref: 'mes:result:S06:planning-verification:1' }, null, 2),
  );
  fixture.write(
    '.proofloop/forensics/mes-recovery-fixture-001/audit.json',
    JSON.stringify({ audit: 'read-only relational audit fixture', misbound: 7 }, null, 2),
  );
  fixture.write(PLAN_REF, RECOVERY_CANDIDATE_PLAN);
  commitAll(fixture, 'seed maintenance fixture');
  // The positive git basis is a root-bound ISOLATED evidence worktree (the
  // main worktree identity '.' is never admissible for MES_MAINTENANCE).
  const worktreeRel = ENTRY_WORKTREE_REL;
  const worktreeAbs = path.join(fixture.dir, worktreeRel);
  fixture.run(['worktree', 'add', '--detach', worktreeAbs, 'HEAD']);

  const root = fixture.dir;
  const frozenAbs = path.join(root, '.proofloop', 'mes', 'snapshot.json');
  const forensicAbs = path.join(root, '.proofloop', 'forensics', 'mes-recovery-fixture-001', 'incident.json');
  const auditAbs = path.join(root, '.proofloop', 'forensics', 'mes-recovery-fixture-001', 'audit.json');
  // Physical quarantine AFTER seeding: `.proofloop/mes` becomes mode 0555.
  fs.chmodSync(path.join(root, '.proofloop', 'mes'), 0o555);

  const binding: MaintenanceBinding = {
    frozen_snapshot_ref: '.proofloop/mes/snapshot.json',
    frozen_snapshot_sha256: fileDigest(frozenAbs),
    frozen_fact_count: 130,
    forensic_ref: '.proofloop/forensics/mes-recovery-fixture-001/incident.json',
    forensic_sha256: fileDigest(forensicAbs),
    audit_ref: '.proofloop/forensics/mes-recovery-fixture-001/audit.json',
    audit_sha256: fileDigest(auditAbs),
  };
  const gitBasis: MaintenanceGitBasis = { head: fixture.head(), branch: 'HEAD', worktree: worktreeRel };
  const basis: MaintenanceEntryBasis = {
    plan_ref: PLAN_REF,
    authority_refs: AUTHORITY_REFS,
    maintenance_binding: binding,
    git_basis: gitBasis,
    actionToken: LANE_TOKEN,
  };
  const context: MaintenanceEntryContext = { stageId: STAGE, basis, laneActionToken: LANE_TOKEN };

  return {
    root,
    binding,
    gitBasis,
    basis,
    context,
    frozenAbs,
    forensicAbs,
    auditAbs,
    cleanup: () => {
      // Restore write permission so the temp fixture can be removed
      // (the 0555 quarantine would otherwise make rmSync fail with EACCES).
      try {
        fs.chmodSync(path.join(root, '.proofloop', 'mes'), 0o755);
      } catch {
        /* already gone */
      }
      try {
        fixture.run(['worktree', 'remove', '--force', worktreeAbs]);
      } catch {
        /* already removed */
      }
      fixture.cleanup();
    },
  };
}

function expectSeamError(
  code: MaintenanceSeamError['code'],
  fn: () => unknown,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof MaintenanceSeamError, `expected MaintenanceSeamError, got ${String(error)}`);
    assert.equal((error as MaintenanceSeamError).code, code);
    assert.equal((error as MaintenanceSeamError).route_code, 'RUNTIME_BLOCKER');
    assert.equal((error as MaintenanceSeamError).resume_target, 'recovery');
    assert.ok((error as MaintenanceSeamError).reason.length > 0);
    return true;
  });
}

interface CarryForwardFixture {
  readonly root: string;
  readonly binding: MaintenanceBinding;
  readonly gitBasis: MaintenanceGitBasis;
  readonly basis: MaintenanceEntryBasis;
  readonly context: MaintenanceEntryContext;
  readonly frozenAbs: string;
  readonly forensicAbs: string;
  readonly auditAbs: string;
  readonly planAbs: string;
  readonly worktreeAbs: string;
  readonly worktreeRel: string;
  readonly predecessorHead: string;
  cleanup(): void;
}

/**
 * cv-s06-r-d-r3 (MAINTENANCE_ENTRY_TUPLE_INVALID) reproducer topology: a
 * two-commit canonical-root repo whose HEAD carries the CURRENT recovery
 * candidate Plan, plus a linked carry-forward target worktree checked out at
 * the OLDER predecessor Plan commit. The seam must bind the canonical
 * project-root Plan at the canonical root HEAD and must NOT require the
 * carry-forward worktree checkout to contain the newer Plan commit.
 */
function makeCarryForwardFixture(): CarryForwardFixture {
  const fixture = makeFixture();
  // Commit 1 — predecessor recovery candidate Plan (same path, same candidate
  // markers, older revision): the carry-forward target worktree checkout.
  fixture.write(PLAN_REF, `${RECOVERY_CANDIDATE_PLAN}revision: predecessor\n`);
  const predecessorHead = commitAll(fixture, 'seed predecessor recovery candidate plan');
  // Commit 2 — CURRENT canonical recovery candidate Plan at the canonical root
  // HEAD plus the root-bound frozen evidence (quarantine applied afterwards).
  fixture.write(PLAN_REF, `${RECOVERY_CANDIDATE_PLAN}revision: current\n`);
  fixture.write('.proofloop/mes/snapshot.json', frozenSnapshotJson());
  fixture.write(
    '.proofloop/forensics/mes-recovery-fixture-001/incident.json',
    JSON.stringify({ incident: 's06-binding-mismatch-fixture', ref: 'mes:result:S06:planning-verification:1' }, null, 2),
  );
  fixture.write(
    '.proofloop/forensics/mes-recovery-fixture-001/audit.json',
    JSON.stringify({ audit: 'read-only relational audit fixture', misbound: 7 }, null, 2),
  );
  commitAll(fixture, 'seed current canonical recovery candidate plan');

  const root = fixture.dir;
  const worktreeRel = '.proofloop/worktrees/carry-forward-D';
  const worktreeAbs = path.join(root, worktreeRel);
  // Linked carry-forward target worktree at the OLDER predecessor commit
  // (detached HEAD → branch identity `HEAD`).
  fixture.run(['worktree', 'add', '--detach', worktreeAbs, predecessorHead]);

  const frozenAbs = path.join(root, '.proofloop', 'mes', 'snapshot.json');
  const forensicAbs = path.join(root, '.proofloop', 'forensics', 'mes-recovery-fixture-001', 'incident.json');
  const auditAbs = path.join(root, '.proofloop', 'forensics', 'mes-recovery-fixture-001', 'audit.json');
  // Physical quarantine AFTER seeding: `.proofloop/mes` becomes mode 0555.
  fs.chmodSync(path.join(root, '.proofloop', 'mes'), 0o555);

  const binding: MaintenanceBinding = {
    frozen_snapshot_ref: '.proofloop/mes/snapshot.json',
    frozen_snapshot_sha256: fileDigest(frozenAbs),
    frozen_fact_count: 130,
    forensic_ref: '.proofloop/forensics/mes-recovery-fixture-001/incident.json',
    forensic_sha256: fileDigest(forensicAbs),
    audit_ref: '.proofloop/forensics/mes-recovery-fixture-001/audit.json',
    audit_sha256: fileDigest(auditAbs),
  };
  const gitBasis: MaintenanceGitBasis = { head: predecessorHead, branch: 'HEAD', worktree: worktreeRel };
  const basis: MaintenanceEntryBasis = {
    plan_ref: PLAN_REF,
    authority_refs: AUTHORITY_REFS,
    maintenance_binding: binding,
    git_basis: gitBasis,
    actionToken: LANE_TOKEN,
  };
  const context: MaintenanceEntryContext = { stageId: STAGE, basis, laneActionToken: LANE_TOKEN };

  return {
    root,
    binding,
    gitBasis,
    basis,
    context,
    frozenAbs,
    forensicAbs,
    auditAbs,
    planAbs: path.join(root, PLAN_REF),
    worktreeAbs,
    worktreeRel,
    predecessorHead,
    cleanup: () => {
      // Restore write permission so the temp fixture can be removed
      // (the 0555 quarantine would otherwise make rmSync fail with EACCES).
      try {
        fs.chmodSync(path.join(root, '.proofloop', 'mes'), 0o755);
      } catch {
        /* already gone */
      }
      try {
        fixture.run(['worktree', 'remove', '--force', worktreeAbs]);
      } catch {
        /* already removed */
      }
      fixture.cleanup();
    },
  };
}

/** Git blob of `planRef` at `head` inside `cwd` (test-topology assertion). */
function planBlobAtHead(cwd: string, head: string, planRef: string): string {
  return execFileSync('git', ['rev-parse', `${head}:${planRef}`], { cwd, encoding: 'utf8' }).trim();
}

describe('MES_MAINTENANCE entry seam (S06-R-D-T01)', () => {
  test('exact tuple yields a typed entry and stays byte-stable (no write)', () => {
    const fx = makeEntryFixture();
    try {
      const entry = verifyMaintenanceEntry(fx.root, fx.context);
      assert.equal(entry.execution_mode, MES_MAINTENANCE_MODE);
      assert.equal(entry.stageId, STAGE);
      assert.equal(entry.plan_ref, PLAN_REF);
      assert.equal(entry.snapshot_sha256, fx.binding.frozen_snapshot_sha256);
      assert.equal(entry.snapshot_fact_count, 130);
      assert.equal(entry.forensic_sha256, fx.binding.forensic_sha256);
      assert.equal(entry.audit_sha256, fx.binding.audit_sha256);
      assert.equal(entry.git_basis.head, fx.gitBasis.head);
      assert.equal(entry.git_basis.branch, fx.gitBasis.branch);
      assert.equal(entry.git_basis.worktree, ENTRY_WORKTREE_REL);
      assert.equal(entry.actionToken, LANE_TOKEN);
      // No-write proof: every fixture byte stays identical after the entry.
      assert.equal(fileDigest(fx.frozenAbs), fx.binding.frozen_snapshot_sha256);
      assert.equal(fileDigest(fx.forensicAbs), fx.binding.forensic_sha256);
      assert.equal(fileDigest(fx.auditAbs), fx.binding.audit_sha256);
      assert.equal(
        fs.statSync(path.join(fx.root, '.proofloop', 'mes')).mode & 0o777,
        0o555,
        'quarantine mode must remain 0555',
      );
    } finally {
      fx.cleanup();
    }
  });

  test('stale frozen snapshot digest is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context = {
        ...fx.context,
        basis: { ...fx.basis, maintenance_binding: { ...fx.binding, frozen_snapshot_sha256: sha('stale-digest') } },
      };
      expectSeamError('MAINTENANCE.DIGEST_MISMATCH', () => verifyMaintenanceEntry(fx.root, context));
      assert.equal(fileDigest(fx.frozenAbs), fx.binding.frozen_snapshot_sha256, 'no write on failure');
    } finally {
      fx.cleanup();
    }
  });

  test('wrong frozen fact count is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context = {
        ...fx.context,
        basis: { ...fx.basis, maintenance_binding: { ...fx.binding, frozen_fact_count: 129 } },
      };
      expectSeamError('MAINTENANCE.FACT_COUNT_MISMATCH', () => verifyMaintenanceEntry(fx.root, context));
    } finally {
      fx.cleanup();
    }
  });

  test('mismatched forensic digest is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context = {
        ...fx.context,
        basis: { ...fx.basis, maintenance_binding: { ...fx.binding, forensic_sha256: sha('wrong-forensic') } },
      };
      expectSeamError('MAINTENANCE.DIGEST_MISMATCH', () => verifyMaintenanceEntry(fx.root, context));
    } finally {
      fx.cleanup();
    }
  });

  test('mismatched audit digest is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context = {
        ...fx.context,
        basis: { ...fx.basis, maintenance_binding: { ...fx.binding, audit_sha256: sha('wrong-audit') } },
      };
      expectSeamError('MAINTENANCE.DIGEST_MISMATCH', () => verifyMaintenanceEntry(fx.root, context));
    } finally {
      fx.cleanup();
    }
  });

  test('missing / mis-pointed audit ref is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context = {
        ...fx.context,
        basis: {
          ...fx.basis,
          maintenance_binding: {
            ...fx.binding,
            audit_ref: '.proofloop/forensics/mes-recovery-fixture-001/missing.json',
            audit_sha256: sha('missing'),
          },
        },
      };
      expectSeamError('MAINTENANCE.REF_UNREADABLE', () => verifyMaintenanceEntry(fx.root, context));
    } finally {
      fx.cleanup();
    }
  });

  test('escaping ref is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context = {
        ...fx.context,
        basis: { ...fx.basis, maintenance_binding: { ...fx.binding, frozen_snapshot_ref: '../outside.json' } },
      };
      expectSeamError('MAINTENANCE.REF_ESCAPE', () => verifyMaintenanceEntry(fx.root, context));
    } finally {
      fx.cleanup();
    }
  });

  test('missing authorization marker is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      expectSeamError(
        'MAINTENANCE.AUTHORIZATION_MISSING',
        () => verifyMaintenanceEntry(fx.root, { ...fx.context, basis: { ...fx.basis, actionToken: '' } }),
      );
      expectSeamError(
        'MAINTENANCE.AUTHORIZATION_MISSING',
        () =>
          verifyMaintenanceEntry(fx.root, {
            ...fx.context,
            basis: { ...fx.basis, actionToken: 'has\u0000control' },
          }),
      );
    } finally {
      fx.cleanup();
    }
  });

  test('mismatched lane token is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context: MaintenanceEntryContext = { ...fx.context, laneActionToken: 'other-lane-token' };
      expectSeamError('MAINTENANCE.AUTHORIZATION_MISMATCH', () => verifyMaintenanceEntry(fx.root, context));
    } finally {
      fx.cleanup();
    }
  });

  test('wrong Git HEAD is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context = {
        ...fx.context,
        basis: { ...fx.basis, git_basis: { ...fx.gitBasis, head: sha('wrong-head').slice(0, 40) } },
      };
      expectSeamError('MAINTENANCE.GIT_BASIS_MISMATCH', () => verifyMaintenanceEntry(fx.root, context));
    } finally {
      fx.cleanup();
    }
  });

  test('wrong Git branch identity is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context = {
        ...fx.context,
        basis: { ...fx.basis, git_basis: { ...fx.gitBasis, branch: fx.gitBasis.branch === 'HEAD' ? 'master' : 'HEAD' } },
      };
      expectSeamError('MAINTENANCE.GIT_BASIS_MISMATCH', () => verifyMaintenanceEntry(fx.root, context));
    } finally {
      fx.cleanup();
    }
  });

  test('wrong worktree identity is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context = {
        ...fx.context,
        basis: { ...fx.basis, git_basis: { ...fx.gitBasis, worktree: 'other' } },
      };
      expectSeamError('MAINTENANCE.GIT_BASIS_MISMATCH', () => verifyMaintenanceEntry(fx.root, context));
    } finally {
      fx.cleanup();
    }
  });

  test('main worktree target (git_basis.worktree ".") is a typed no-entry blocker (MAINTENANCE_EVIDENCE_BOUNDARY_BYPASS repair)', () => {
    const fx = makeEntryFixture();
    try {
      // The MES_MAINTENANCE entry requires a root-bound ISOLATED evidence
      // worktree: the main worktree identity '.' must never close the entry.
      const context = {
        ...fx.context,
        basis: { ...fx.basis, git_basis: { ...fx.gitBasis, worktree: '.' } },
      };
      expectSeamError('MAINTENANCE.GIT_BASIS_MISMATCH', () => verifyMaintenanceEntry(fx.root, context));
      // No-write proof: every fixture byte stays identical after the rejected entry.
      assert.equal(fileDigest(fx.frozenAbs), fx.binding.frozen_snapshot_sha256, 'no write on failure');
      assert.equal(fileDigest(fx.forensicAbs), fx.binding.forensic_sha256, 'forensic byte-stable');
      assert.equal(fileDigest(fx.auditAbs), fx.binding.audit_sha256, 'audit byte-stable');
    } finally {
      fx.cleanup();
    }
  });

  test('any main-worktree target (a main-checkout directory) is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      // '.proofloop' is a directory of the MAIN worktree checkout — not an
      // isolated evidence worktree. The entry must fail closed (typed
      // GIT_BASIS_MISMATCH) before it closes.
      const context = {
        ...fx.context,
        basis: { ...fx.basis, git_basis: { ...fx.gitBasis, worktree: '.proofloop' } },
      };
      expectSeamError('MAINTENANCE.GIT_BASIS_MISMATCH', () => verifyMaintenanceEntry(fx.root, context));
      assert.equal(fileDigest(fx.frozenAbs), fx.binding.frozen_snapshot_sha256, 'no write on failure');
    } finally {
      fx.cleanup();
    }
  });

  test('writable quarantine is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      fs.chmodSync(path.join(fx.root, '.proofloop', 'mes'), 0o755);
      expectSeamError('MAINTENANCE.QUARANTINE_VIOLATED', () => verifyMaintenanceEntry(fx.root, fx.context));
    } finally {
      fs.chmodSync(path.join(fx.root, '.proofloop', 'mes'), 0o555);
      fx.cleanup();
    }
  });

  test('frozen accepted-Plan substitution is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      const context = {
        ...fx.context,
        basis: { ...fx.basis, plan_ref: 'delivery/stages/S06/plan.md' },
      };
      expectSeamError('MAINTENANCE.ENTRY_INVALID', () => verifyMaintenanceEntry(fx.root, context));
    } finally {
      fx.cleanup();
    }
  });

  test('missing / non-canonical authority refs are typed no-entry blockers', () => {
    const fx = makeEntryFixture();
    try {
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceEntry(fx.root, { ...fx.context, basis: { ...fx.basis, authority_refs: [] } }),
      );
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () =>
          verifyMaintenanceEntry(fx.root, {
            ...fx.context,
            basis: { ...fx.basis, authority_refs: ['PRD.md#product-authority'] },
          }),
      );
    } finally {
      fx.cleanup();
    }
  });

  test('non-canonical stage id is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceEntry(fx.root, { ...fx.context, stageId: 'SX' }),
      );
    } finally {
      fx.cleanup();
    }
  });

  test('shared binding tuple helper closes the exact tuple and rejects drift', () => {
    const fx = makeEntryFixture();
    try {
      const verified = verifyMaintenanceBindingTuple(fx.root, fx.binding);
      assert.equal(verified.frozen_snapshot_sha256, fx.binding.frozen_snapshot_sha256);
      assert.equal(verified.frozen_fact_count, 130);
      expectSeamError(
        'MAINTENANCE.DIGEST_MISMATCH',
        () => verifyMaintenanceBindingTuple(fx.root, { ...fx.binding, frozen_snapshot_sha256: sha('stale') }),
      );
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceBindingTuple(fx.root, { ...fx.binding, frozen_fact_count: -1 }),
      );
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceBindingTuple(fx.root, { ...fx.binding, extra_field: 'smuggle' }),
      );
    } finally {
      fx.cleanup();
    }
  });

  test('lane widening: a non-S06 stage (S07) is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceEntry(fx.root, { ...fx.context, stageId: 'S07' }),
      );
      // The frozen-accepted-Plan substitution check must not be reachable
      // with a foreign stage either (S07 accepted plan is equally rejected).
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () =>
          verifyMaintenanceEntry(fx.root, {
            ...fx.context,
            stageId: 'S07',
            basis: { ...fx.basis, plan_ref: 'delivery/stages/S07/plan.md' },
          }),
      );
    } finally {
      fx.cleanup();
    }
  });

  test('stale recovery candidate (recovery-plan-r2.md) is a typed no-entry blocker', () => {
    const fx = makeEntryFixture();
    try {
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceEntry(fx.root, { ...fx.context, basis: { ...fx.basis, plan_ref: 'delivery/stages/S06/recovery-plan-r2.md' } }),
      );
      // Unknown non-candidate plan refs are equally rejected (exact-match rule).
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceEntry(fx.root, { ...fx.context, basis: { ...fx.basis, plan_ref: 'delivery/stages/S06/other.md' } }),
      );
      assert.equal(fileDigest(fx.frozenAbs), fx.binding.frozen_snapshot_sha256, 'no write on failure');
    } finally {
      fx.cleanup();
    }
  });

  test('same-path Plan swapped to NORMAL / accepted_plan_ref semantics is a typed no-entry blocker (MAINTENANCE.PLAN_SEMANTICS_INVALID)', () => {
    const fx = makeEntryFixture();
    try {
      // The SAME path, SAME commit — but the file content is a NORMAL
      // accepted-Plan substitution. The entry must not accept it on
      // pathname/readability alone: current candidate semantics are bound.
      fs.writeFileSync(
        path.join(fx.root, PLAN_REF),
        '# S06 accepted Plan (NORMAL)\nexecution_mode: NORMAL\naccepted_plan_ref: delivery/stages/S06/plan.md\n',
        'utf8',
      );
      expectSeamError('MAINTENANCE.PLAN_SEMANTICS_INVALID', () => verifyMaintenanceEntry(fx.root, fx.context));
      assert.equal(fileDigest(fx.frozenAbs), fx.binding.frozen_snapshot_sha256, 'no write on failure');
      assert.equal(fileDigest(fx.forensicAbs), fx.binding.forensic_sha256, 'forensic byte-stable');
      assert.equal(fileDigest(fx.auditAbs), fx.binding.audit_sha256, 'audit byte-stable');
    } finally {
      fx.cleanup();
    }
  });

  test('same-path uncommitted Plan edit (freshness drift) is a typed no-entry blocker (MAINTENANCE.PLAN_FRESHNESS_MISMATCH)', () => {
    const fx = makeEntryFixture();
    try {
      // A same-path edit that STILL carries the recovery-candidate markers
      // but is NOT committed: the seam binds the Git-tracked candidate
      // byte-fresh — an uncommitted on-disk drift is a no-entry blocker.
      fs.writeFileSync(
        path.join(fx.root, PLAN_REF),
        `${RECOVERY_CANDIDATE_PLAN}\ntampered-uncommitted-trailer\n`,
        'utf8',
      );
      expectSeamError('MAINTENANCE.PLAN_FRESHNESS_MISMATCH', () => verifyMaintenanceEntry(fx.root, fx.context));
      assert.equal(fileDigest(fx.frozenAbs), fx.binding.frozen_snapshot_sha256, 'no write on failure');
    } finally {
      fx.cleanup();
    }
  });

  test('unknown context keys fail closed (closed object)', () => {
    const fx = makeEntryFixture();
    try {
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceEntry(fx.root, { ...fx.context, session_narrative: 'hidden pane' } as never),
      );
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceEntry(fx.root, { ...fx.context, link_message_id: 'hl_xyz' } as never),
      );
    } finally {
      fx.cleanup();
    }
  });

  test('unknown basis keys (basis.work_id and friends) fail closed', () => {
    const fx = makeEntryFixture();
    try {
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceEntry(fx.root, { ...fx.context, basis: { ...fx.basis, work_id: 'mes:work:S06:S06-R-D:1' } } as never),
      );
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () => verifyMaintenanceEntry(fx.root, { ...fx.context, basis: { ...fx.basis, result_ref: 'mes:result:S06:1' } } as never),
      );
    } finally {
      fx.cleanup();
    }
  });

  test('unknown git_basis keys fail closed (closed object)', () => {
    const fx = makeEntryFixture();
    try {
      expectSeamError(
        'MAINTENANCE.ENTRY_INVALID',
        () =>
          verifyMaintenanceEntry(fx.root, {
            ...fx.context,
            basis: { ...fx.basis, git_basis: { ...fx.gitBasis, extra: 'smuggle' } } as never,
          }),
      );
    } finally {
      fx.cleanup();
    }
  });

  test('carry-forward target worktree at an older predecessor Plan commit is accepted while the canonical root Plan is current (MAINTENANCE_ENTRY_TUPLE_INVALID repair)', () => {
    const fx = makeCarryForwardFixture();
    try {
      // Topology proof: the carry-forward worktree HEAD really holds an OLDER
      // predecessor Plan blob than the canonical root HEAD.
      const canonicalBlob = planBlobAtHead(fx.root, 'HEAD', PLAN_REF);
      const predecessorBlob = planBlobAtHead(fx.root, fx.predecessorHead, PLAN_REF);
      assert.notEqual(predecessorBlob, canonicalBlob, 'carry-forward worktree must hold an older predecessor Plan blob');
      // All other entry tuple fields are exact: the seam must close on the
      // canonical project-root Plan binding, not the carry-forward worktree HEAD.
      const entry = verifyMaintenanceEntry(fx.root, fx.context);
      assert.equal(entry.execution_mode, MES_MAINTENANCE_MODE);
      assert.equal(entry.stageId, STAGE);
      assert.equal(entry.plan_ref, PLAN_REF);
      assert.equal(entry.git_basis.head, fx.gitBasis.head);
      assert.equal(entry.git_basis.branch, fx.gitBasis.branch);
      assert.equal(entry.git_basis.worktree, fx.worktreeRel);
      assert.equal(entry.actionToken, LANE_TOKEN);
      // No-write proof: every fixture byte stays identical after the entry.
      assert.equal(fileDigest(fx.frozenAbs), fx.binding.frozen_snapshot_sha256);
      assert.equal(fileDigest(fx.forensicAbs), fx.binding.forensic_sha256);
      assert.equal(fileDigest(fx.auditAbs), fx.binding.audit_sha256);
      assert.equal(fs.statSync(path.join(fx.root, '.proofloop', 'mes')).mode & 0o777, 0o555, 'quarantine mode must remain 0555');
    } finally {
      fx.cleanup();
    }
  });

  test('canonical-root Plan tampering and semantic substitution stay typed no-entry and no-write under a carry-forward worktree', () => {
    const fx = makeCarryForwardFixture();
    try {
      // 1) Uncommitted canonical-root edit that STILL carries the candidate
      //    markers: freshness binds the canonical root HEAD → typed no-entry.
      fs.writeFileSync(fx.planAbs, `${RECOVERY_CANDIDATE_PLAN}tampered-uncommitted-trailer\n`, 'utf8');
      expectSeamError('MAINTENANCE.PLAN_FRESHNESS_MISMATCH', () => verifyMaintenanceEntry(fx.root, fx.context));
      assert.equal(fileDigest(fx.frozenAbs), fx.binding.frozen_snapshot_sha256, 'no write on failure');
      assert.equal(fileDigest(fx.forensicAbs), fx.binding.forensic_sha256, 'forensic byte-stable');
      assert.equal(fileDigest(fx.auditAbs), fx.binding.audit_sha256, 'audit byte-stable');
      assert.equal(fs.statSync(path.join(fx.root, '.proofloop', 'mes')).mode & 0o777, 0o555, 'quarantine stays 0555');

      // 2) Same-path NORMAL / accepted_plan_ref substitution at the canonical
      //    root: typed no-entry on semantics, never on pathname alone.
      fs.writeFileSync(
        fx.planAbs,
        '# S06 accepted Plan (NORMAL)\nexecution_mode: NORMAL\naccepted_plan_ref: delivery/stages/S06/plan.md\n',
        'utf8',
      );
      expectSeamError('MAINTENANCE.PLAN_SEMANTICS_INVALID', () => verifyMaintenanceEntry(fx.root, fx.context));
      assert.equal(fileDigest(fx.frozenAbs), fx.binding.frozen_snapshot_sha256, 'no write on failure');
      assert.equal(fileDigest(fx.forensicAbs), fx.binding.forensic_sha256, 'forensic byte-stable');
      assert.equal(fileDigest(fx.auditAbs), fx.binding.audit_sha256, 'audit byte-stable');
    } finally {
      fx.cleanup();
    }
  });
});
