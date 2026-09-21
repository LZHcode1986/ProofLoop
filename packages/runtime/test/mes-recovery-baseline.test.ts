import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { MesSnapshotStore, MES_SNAPSHOT_REL } from '../dist/mes/store';
import type { MesFactEnvelope } from '../dist/mes/store';
import type { MesPlanVerdict } from '../dist/mes/types';
import { canonicalStringify } from '../dist/cli/proofloop-common';
import { makeFixture, commitAll } from './helpers';
import {
  CanonicalProjectMesObservationError,
  observeCanonicalProjectArtifact,
  resolveCanonicalProjectRoot,
} from './fixtures/e2e25';

/**
 * REAL forensic captures under the canonical project/trust root, observed
 * READ-ONLY (never a mutation target): the S05 partial 178→67 replace
 * (snapshot-67 / relational-audit-67 / plan-dirty.patch) and the S06
 * binding-mismatch / fact-gap captures. The digests are cross-checked at
 * runtime against the observed bytes — they must equal the values the immutable
 * incident records carry.
 */
const REAL_FORENSIC_DIR_REL = '.proofloop/forensics/mes-recovery-20260910';
const S06_BINDING_MISMATCH_DIR_REL = '.proofloop/forensics/mes-recovery-20260913-s06-binding-mismatch-001';
const S06_FACT_GAP_DIR_REL = '.proofloop/forensics/mes-recovery-20260913-s06-mes-fact-gap-001';
const REAL_SNAPSHOT_SHA = '0b9a0583e4e8c39089eb82453a87e165f0f1add482696eb865355a841432d956';
const REAL_SNAPSHOT_COUNT = 67;
const REAL_AUDIT_SHA = '9d4f67ba4c2bd41f49e32a1fabb4920155a24b00d34fce7b6911c8183f6be82c';
const REAL_PATCH_SHA = 'c7f9c0e352cc279fc633cc4d1650972f0bfa341b729c341c4a3c9a32af962d5d';
/** The identities the S06 incident records carry (immutable forensic input). */
const S06_SNAPSHOT_SHA = '741c009431cb9f4e7497e3b957a2652147ffdc2c1364fc82a618a85a671f99eb';
const S06_SNAPSHOT_COUNT = 130;
const S06_AUDIT_SHA = '1ad273fb9505646f2ab61553365c0f0c005a2481c00de0d8a9206d7f60d61262';
const S06_INCIDENT_SHA = '84281d23b6768d2a2b2e8a6128c1fbd18fa1e9ad9807eb567877e8b649c473ee';
/** The PVR observed in the accidental partial write — forensic input only. */
const PVR3_FACT_ID = 'mes:fact:planning_verification_result:S05:3';
const PVR3_RESULT_REF = 'mes:result:S05:planning-verification-3';
const PVR3_HEAD = 'bda2c449d555fd613e2777d7dc7d0b84d350fb0a';
const PVR3_PLAN_DIGEST = 'c573d694edd47158def0790943b7b79346d1155cb7fd7a33d6fbafcb4ea3ed8d';

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')).digest('hex');
}

/** The CURRENT observed Git basis (HEAD/branch/worktree) of a fixture. */
function observedGitBasis(fixture: ReturnType<typeof makeFixture>): { head: string; branch: string; worktree: string } {
  return {
    head: fixture.run(['rev-parse', 'HEAD']).trim(),
    branch: fixture.run(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    worktree: '.',
  };
}

type BaselineRefs = { forensicRef: string; auditRef: string; auditSha: string };
type GitBasis = { head: string; branch: string; worktree: string };

/**
 * A read-only relational audit that reports NO duplicate / ambiguous
 * relation evidence (the closed marker shape the store requires).
 */
function cleanAudit(sourceSha: string, sourceCount: number): Record<string, unknown> {
  return {
    audit_id: 'MES-RECOVERY-AUDIT-TEST-001',
    audit_mode: 'read_only',
    snapshot_sha256: sourceSha,
    fact_count: sourceCount,
    damage_conclusion: { exact_preimage_available: false },
    duplicate_fact_ids: [],
    finding_disposition_relations: [],
    plan_acceptance_relations: [],
    project_ready_closure: { stage_result_refs: [] },
  };
}

/**
 * Write the forensic incident + read-only audit artifacts a recovery
 * baseline references. `auditOverride` lets a probe inject duplicate /
 * ambiguous relation evidence into the audit artifact.
 */
function defineBaselineArtifacts(
  fixture: ReturnType<typeof makeFixture>,
  sourceSha: string,
  sourceCount: number,
  auditOverride?: (audit: Record<string, unknown>) => Record<string, unknown>,
): BaselineRefs {
  const forensicRef = '.proofloop/forensics/recovery/incident.json';
  const auditRef = '.proofloop/forensics/recovery/audit.json';
  fixture.write(
    forensicRef,
    JSON.stringify({
      incident_id: 'MES-RECOVERY-TEST-001',
      status: 'MES_RECOVERY_REQUIRED',
      preimage_recovery: 'EXACT_178_FACT_PREIMAGE_UNRECOVERABLE',
      source_snapshot: { sha256: sourceSha, fact_count: sourceCount },
    }),
  );
  let audit = cleanAudit(sourceSha, sourceCount);
  if (auditOverride !== undefined) audit = auditOverride(audit);
  const auditContent = JSON.stringify(audit);
  fixture.write(auditRef, auditContent);
  return { forensicRef, auditRef, auditSha: sha256(auditContent) };
}

function planningFact(): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:planning_verification_result:RECOVERY-TEST:1',
    fact_kind: 'planning_verification_result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.4a'],
    work_id: 'mes:work:RECOVERY-TEST:planning:1',
    result_ref: 'mes:result:RECOVERY-TEST:planning-verification-1',
    verifier_role: 'stage-plan-verifier',
    action_token: 'recovery-test-action-token',
    plan_binding: {
      binding_stage: 'candidate',
      candidate_plan_ref: 'delivery/stages/S05/plan.md',
      accepted_plan_ref: null,
      verdict: 'FINDINGS',
      plan_digest: 'a'.repeat(64),
    },
    git_basis: {
      head: 'b'.repeat(40),
      branch: 'recovery-test',
      worktree: '.',
    },
  };
}

/**
 * A NORMAL `plan_acceptance` that references a verification_result_ref.
 * Used to probe that the forensic PVR3 (FINDINGS, never revalidated) can
 * never underpin a NORMAL acceptance — the carry-forensic-only seam.
 */
function acceptanceReferencing(resultRef: string, head: string, planDigest: string, factId: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: factId,
    fact_kind: 'plan_acceptance',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.4a'],
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S05/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S05/plan.md',
      verification_result_ref: resultRef,
      plan_digest: planDigest,
    },
    git_basis: {
      head,
      branch: 'v2-herdr',
      worktree: '.',
    },
  };
}

/**
 * (S06-R-F-T01 relation-set exactness) The canonical S06 PLAN_READY PVR the
 * current incident accepted_plan_relation / audit canonical_relation
 * reference (mes:fact:planning_verification_result:S06:1, result_ref
 * mes:result:S06:planning-verification-1, cycle cycle-208cbbe8d8e946479bb746f318b56178,
 * plan_digest 13c41263...). Must be a durable fact in the observed source.
 */
function currentCanonicalPvrFact(verdict: MesPlanVerdict = 'PLAN_READY'): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:planning_verification_result:S06:1',
    fact_kind: 'planning_verification_result',
    created_by: 'brain',
    authority_refs: ['tech-spec/architecture.md#/entities/delivery-cycle-semantics', 'tech-spec/contracts.md#2.2.4a'],
    work_id: 'mes:work:S06:planning:1',
    result_ref: 'mes:result:S06:planning-verification-1',
    verifier_role: 'stage-plan-verifier',
    action_token: 'spv-s06-post-runtime',
    plan_binding: {
      binding_stage: 'candidate',
      candidate_plan_ref: 'delivery/stages/S06/plan.md',
      accepted_plan_ref: null,
      delivery_cycle_id: 'cycle-208cbbe8d8e946479bb746f318b56178',
      plan_digest: '13c41263c750b2df8ebf7b8269bcec31f7b37b770d4f50db543bf061ea6fb90e',
      verdict,
    },
    scope: { stage_id: 'S06' },
    git_basis: { head: 'c'.repeat(40), branch: 'v2-herdr', worktree: '.' },
  };
}

/**
 * (S06-R-F-T01 relation-set exactness) The canonical S06 plan_acceptance the
 * audit canonical_relation references (mes:fact:plan_acceptance:S06:1 with
 * verification_result_ref mes:result:S06:planning-verification-1 and the same
 * cycle / plan_digest). Must be durable in the observed source.
 */
function currentCanonicalPaFact(): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:plan_acceptance:S06:1',
    fact_kind: 'plan_acceptance',
    created_by: 'brain',
    authority_refs: ['tech-spec/architecture.md#/entities/delivery-cycle-semantics', 'tech-spec/contracts.md#2.2.4a'],
    supersedes_plan_acceptance_ref: null,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S06/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S06/plan.md',
      verification_result_ref: 'mes:result:S06:planning-verification-1',
      delivery_cycle_id: 'cycle-208cbbe8d8e946479bb746f318b56178',
      plan_digest: '13c41263c750b2df8ebf7b8269bcec31f7b37b770d4f50db543bf061ea6fb90e',
    },
    scope: { stage_id: 'S06' },
    git_basis: { head: 'd'.repeat(40), branch: 'v2-herdr', worktree: '.' },
  };
}

/**
 * (S06-R-F-T01 relation-set exactness) The single misbound S06-D work fact
 * the incident misbound_facts / audit misbound_fact_ids declare — it exists in
 * the frozen observed source (its submitted verification_result_ref
 * mes:result:S06:planning-verification:1 differs from the canonical
 * mes:result:S06:planning-verification-1, which is exactly the misbound
 * relation).
 */
function currentMisboundWorkFact(): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:work:S06:S06-D:post-fact-recovery-1',
    fact_kind: 'work',
    created_by: 'brain',
    authority_refs: ['tech-spec/architecture.md#/entities/delivery-cycle-semantics', 'tech-spec/contracts.md#2.5'],
    work_id: 'mes:work:S06:S06-D:post-fact-recovery-1',
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S06/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S06/plan.md',
      verification_result_ref: 'mes:result:S06:planning-verification:1',
      delivery_cycle_id: 'cycle-208cbbe8d8e946479bb746f318b56178',
      plan_digest: '13c41263c750b2df8ebf7b8269bcec31f7b37b770d4f50db543bf061ea6fb90e',
    },
    scope: { slice_id: 'S06-D', stage_id: 'S06' },
    git_basis: { head: 'e'.repeat(40), branch: 'HEAD', worktree: '.proofloop/worktrees/S06-S06-D-post-recovery-1' },
  };
}


/**
 * (S06-R-G-T01) A durable `recovery_baseline` fact already persisted in the
 * observed source snapshot for the fact-gap source incident — the canonical
 * source-incident identity the candidate binding-mismatch incident's
 * source_incident_ref must EXACTLY resolve to. Its forensic_ref points at a
 * re-readable canonicalized source-incident artifact carrying the SAME
 * incident_id, and its source_snapshot_sha256/source_fact_count equal the
 * candidate source incident's declared source_snapshot (the real 122-fact
 * fact-gap capture snapshot). `override` lets a probe inject a missing /
 * ambiguous / disagreeing / unreadable canonical identity.
 */
function durableSourceIncidentBaselineFact(override?: (baseline: MesFactEnvelope) => MesFactEnvelope): MesFactEnvelope {
  const baseline: MesFactEnvelope = {
    schema_version: 2,
    fact_id: `mes:fact:recovery_baseline:${CURRENT_SOURCE_INCIDENT_ID}`,
    fact_kind: 'recovery_baseline',
    created_by: 'brain',
    authority_refs: [
      'tech-spec/architecture.md#/entities/mes-disaster-rebaseline',
      'tech-spec/contracts.md#2.2.4a',
      'tech-spec/acceptance.md#E2E-24',
    ],
    recovery_id: CURRENT_SOURCE_INCIDENT_ID,
    preimage_status: 'UNRECOVERABLE',
    source_snapshot_sha256: CURRENT_SOURCE_INCIDENT_SOURCE_SHA,
    source_fact_count: CURRENT_SOURCE_INCIDENT_SOURCE_COUNT,
    forensic_ref: '.proofloop/forensics/recovery/canonicalized-source-incident.json',
    audit_ref: CANONICALIZED_SOURCE_AUDIT_REF,
    audit_sha256: sha256(CANONICALIZED_SOURCE_AUDIT_CONTENT),
    git_basis: { head: '9'.repeat(40), branch: 'v2-herdr', worktree: '.' },
  };
  return override !== undefined ? override(baseline) : baseline;
}

/**
 * Write the canonicalized source-incident artifact + its read-only audit the
 * durable source-incident recovery_baseline fact references (re-readable,
 * same incident identity). `canonicalizedIncidentOverride` lets a probe make
 * the canonical forensic_ref disagree with the candidate source incident.
 */
function defineCanonicalizedSourceArtifacts(
  fixture: ReturnType<typeof makeFixture>,
  canonicalizedIncidentOverride?: (incident: Record<string, unknown>) => Record<string, unknown>,
): string {
  const canonicalizedRef = '.proofloop/forensics/recovery/canonicalized-source-incident.json';
  let canonicalizedIncident: Record<string, unknown> = {
    incident_id: CURRENT_SOURCE_INCIDENT_ID,
    incident_type: 'mes_fact_set_drift_after_recovery',
    status: 'MES_RECOVERY_REQUIRED',
    source_snapshot: {
      path: '.proofloop/mes/snapshot.json',
      fact_count: CURRENT_SOURCE_INCIDENT_SOURCE_COUNT,
      schema_version: 2,
      sha256: CURRENT_SOURCE_INCIDENT_SOURCE_SHA,
    },
  };
  if (canonicalizedIncidentOverride !== undefined) canonicalizedIncident = canonicalizedIncidentOverride(canonicalizedIncident);
  fixture.write(canonicalizedRef, JSON.stringify(canonicalizedIncident));
  fixture.write(CANONICALIZED_SOURCE_AUDIT_REF, CANONICALIZED_SOURCE_AUDIT_CONTENT);
  return canonicalizedRef;
}

function recoveryFact(
  sourceSha: string,
  sourceCount: number,
  refs: BaselineRefs,
  basis: GitBasis,
  recoveryId = 'MES-RECOVERY-TEST-001',
): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:recovery_baseline:${recoveryId}`,
    fact_kind: 'recovery_baseline',
    created_by: 'brain',
    authority_refs: [
      'tech-spec/architecture.md#/entities/mes-disaster-rebaseline',
      'tech-spec/contracts.md#2.2.4a',
      'tech-spec/acceptance.md#E2E-24',
    ],
    recovery_id: recoveryId,
    preimage_status: 'UNRECOVERABLE',
    source_snapshot_sha256: sourceSha,
    source_fact_count: sourceCount,
    forensic_ref: refs.forensicRef,
    audit_ref: refs.auditRef,
    audit_sha256: refs.auditSha,
    git_basis: basis,
  };
}

/**
 * A fixture ready for recovery-baseline probes: a committed Git basis
 * (required by the F2 current-basis seam), one durable planning fact as the
 * observed source snapshot, and the forensic incident + audit artifacts.
 */
function seedRecoveryFixture(): {
  fixture: ReturnType<typeof makeFixture>;
  store: MesSnapshotStore;
  snapshotPath: string;
  sourceSha: string;
  sourceCount: number;
  refs: BaselineRefs;
  basis: GitBasis;
  snapshotBytes: () => string;
} {
  const fixture = makeFixture();
  fixture.write('delivery/stages/S05/plan.md', '# recovery fixture marker\n');
  commitAll(fixture, 'recovery fixture basis');
  const store = new MesSnapshotStore(fixture.dir);
  const snapshotPath = path.join(fixture.dir, MES_SNAPSHOT_REL);
  // Seed the observed source snapshot directly as a pre-existing durable
  // LEGACY snapshot (history-only): the recovery fixture carries the retained
  // legacy-shaped planning fact byte-for-byte instead of creating a NEW
  // legacy fact through a current store write (S05 runtime prereq — a new
  // fully legacy-shaped PVR/PA must fail closed no-write).
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(
    snapshotPath,
    canonicalStringify({ schema_version: 2, facts: [planningFact()] }),
    'utf8',
  );
  const sourceBytes = fs.readFileSync(snapshotPath);
  const sourceSha = sha256(sourceBytes);
  const sourceCount = JSON.parse(sourceBytes.toString('utf8')).facts.length as number;
  const refs = defineBaselineArtifacts(fixture, sourceSha, sourceCount);
  return {
    fixture,
    store,
    snapshotPath,
    sourceSha,
    sourceCount,
    refs,
    basis: observedGitBasis(fixture),
    snapshotBytes: () => fs.readFileSync(snapshotPath, 'utf8'),
  };
}

describe('MES disaster recovery baseline (E2E-24)', () => {
  test('writes an exact-source recovery baseline, retains it across restart and replays idempotently', () => {
    const s = seedRecoveryFixture();
    try {
      const baseline = recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis);
      s.store.write([baseline]);

      const afterFacts = new MesSnapshotStore(s.fixture.dir).read();
      assert.equal(afterFacts.length, s.sourceCount + 1);
      assert.ok(afterFacts.some((fact) => fact.fact_id === baseline.fact_id));
      assert.ok(afterFacts.some((fact) => fact.fact_id === planningFact().fact_id));

      const afterFirst = s.snapshotBytes();
      s.store.write([baseline]);
      assert.equal(s.snapshotBytes(), afterFirst, 'identical recovery baseline replay must be byte-stable');
      assert.ok(new MesSnapshotStore(s.fixture.dir).read().some((fact) => fact.fact_kind === 'recovery_baseline'));
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects a stale source count without modifying the last valid snapshot', () => {
    const s = seedRecoveryFixture();
    try {
      const invalid = recoveryFact(s.sourceSha, s.sourceCount + 1, s.refs, s.basis, 'MES-RECOVERY-TEST-STALE');
      const before = s.snapshotBytes();
      assert.throws(() => s.store.write([invalid]), /source_fact_count/);
      assert.equal(s.snapshotBytes(), before, 'stale recovery source must be no-write');
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects a recovery baseline whose git_basis does not equal the current observed basis (HEAD/branch/worktree) no-write', () => {
    const s = seedRecoveryFixture();
    try {
      const before = s.snapshotBytes();
      const probes: Array<{ label: string; basis: GitBasis }> = [
        { label: 'head', basis: { ...s.basis, head: 'f'.repeat(40) } },
        { label: 'branch', basis: { ...s.basis, branch: 'wrong-branch' } },
        { label: 'worktree', basis: { ...s.basis, worktree: 'subdir' } },
      ];
      probes.forEach(({ label, basis }, i) => {
        const bad = recoveryFact(s.sourceSha, s.sourceCount, s.refs, basis, `MES-RECOVERY-TEST-BASIS-${i}`);
        assert.throws(() => s.store.write([bad]), /git_basis/, `mismatched git_basis.${label} must fail closed`);
        assert.equal(s.snapshotBytes(), before, `mismatched git_basis.${label} must be no-write`);
      });
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects conflicting same-incident recovery epochs no-write (SPV-S05-REC-001 F3)', () => {
    const s = seedRecoveryFixture();
    try {
      const before = s.snapshotBytes();
      const first = recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, 'MES-RECOVERY-TEST-INCIDENT-001');
      const second = recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, 'MES-RECOVERY-TEST-INCIDENT-001-r2');

      // One submission must not carry TWO epochs for the same forensic
      // incident — the probe the verifier observed being accepted.
      assert.throws(() => s.store.write([first, second]), /forensic/);
      assert.equal(s.snapshotBytes(), before, 'conflicting epochs in one submission must be no-write');

      // The legal single epoch writes; identical replay is byte-stable.
      s.store.write([first]);
      const afterFirst = s.snapshotBytes();
      s.store.write([first]);
      assert.equal(s.snapshotBytes(), afterFirst, 'identical recovery baseline replay must be byte-stable');

      // A second epoch for the SAME incident after the durable baseline is a
      // conflicting duplicate — no-write, never a silent second baseline.
      assert.throws(() => s.store.write([second]), /forensic/);
      assert.equal(s.snapshotBytes(), afterFirst, 'conflicting second epoch must be no-write');
      assert.equal(new MesSnapshotStore(s.fixture.dir).read().length, s.sourceCount + 1);
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects an audit reporting duplicate or ambiguous relation evidence no-write (SPV-S05-REC-001 F3)', () => {
    const cases: Array<{ label: string; mutate: (audit: Record<string, unknown>) => Record<string, unknown>; match: RegExp }> = [
      {
        label: 'duplicate_fact_ids non-empty',
        mutate: (a) => ({ ...a, duplicate_fact_ids: ['mes:fact:stage:S01:accepted'] }),
        match: /duplicate/,
      },
      {
        label: 'finding_disposition relation without a unique resolves_fact_id',
        mutate: (a) => ({
          ...a,
          finding_disposition_relations: [{ fact_id: 'd', finding_ref: 'f', resolves_fact_id: null, resolves_result_refs: [] }],
        }),
        match: /resolves_fact_id/,
      },
      {
        label: 'plan_acceptance relation without a pvr_fact_id',
        mutate: (a) => ({ ...a, plan_acceptance_relations: [{ fact_id: 'a', verification_result_ref: 'r' }] }),
        match: /pvr_fact_id/,
      },
      {
        label: 'project_ready stage result with ambiguous resolves_to',
        mutate: (a) => ({
          ...a,
          project_ready_closure: { stage_result_refs: [{ fact_id: 's', result_ref: 'r', resolves_to: [] }] },
        }),
        match: /resolves_to/,
      },
    ];
    for (let i = 0; i < cases.length; i++) {
      const { label, mutate, match } = cases[i];
      const fixture = makeFixture();
      try {
        fixture.write('delivery/stages/S05/plan.md', '# recovery fixture marker\n');
        commitAll(fixture, 'recovery fixture basis');
        const store = new MesSnapshotStore(fixture.dir);
        const snapshotPath = path.join(fixture.dir, MES_SNAPSHOT_REL);
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        fs.writeFileSync(
          snapshotPath,
          canonicalStringify({ schema_version: 2, facts: [planningFact()] }),
          'utf8',
        );
        const sourceBytes = fs.readFileSync(snapshotPath);
        const sourceSha = sha256(sourceBytes);
        const sourceCount = JSON.parse(sourceBytes.toString('utf8')).facts.length as number;
        const refs = defineBaselineArtifacts(fixture, sourceSha, sourceCount, mutate);
        const basis = observedGitBasis(fixture);
        const before = fs.readFileSync(snapshotPath, 'utf8');
        const baseline = recoveryFact(sourceSha, sourceCount, refs, basis, `MES-RECOVERY-TEST-AUDIT-${i}`);
        assert.throws(() => store.write([baseline]), match, label);
        assert.equal(fs.readFileSync(snapshotPath, 'utf8'), before, `${label} must be no-write`);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test('real-incident recovery baseline: 67 retained facts stay history-only, forensic PVR3 never underpins NORMAL acceptance, dirty patch preserved, baseline-before-rehydrate ordering', () => {
    const fixture = makeFixture();
    try {
      // 1) Copy the REAL forensic capture read-only into the temp fixture:
      //    the exact 67-fact partial snapshot, the incident, the read-only
      //    relational audit and the dirty plan recovery patch.
      const copyReal = (name: string, rel: string): void => {
        const target = path.join(fixture.dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, observeCanonicalProjectArtifact(`${REAL_FORENSIC_DIR_REL}/${name}`).bytes);
      };
      copyReal('snapshot-67.json', MES_SNAPSHOT_REL);
      copyReal('incident.json', `${REAL_FORENSIC_DIR_REL}/incident.json`);
      copyReal('relational-audit-67.json', `${REAL_FORENSIC_DIR_REL}/relational-audit-67.json`);
      copyReal('plan-dirty.patch', `${REAL_FORENSIC_DIR_REL}/plan-dirty.patch`);
      const snapshotBytes = () => fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL));
      const snapshotText = () => snapshotBytes().toString('utf8');
      const patchRel = `${REAL_FORENSIC_DIR_REL}/plan-dirty.patch`;
      const patchBytes = () => fs.readFileSync(path.join(fixture.dir, patchRel));
      const patchBefore = patchBytes();
      const incident = JSON.parse(
        fs.readFileSync(path.join(fixture.dir, `${REAL_FORENSIC_DIR_REL}/incident.json`), 'utf8'),
      ) as {
        status: string;
        source_snapshot: { sha256: string; fact_count: number };
      };

      // Cross-check: the copied capture bytes ARE the digests the incident /
      // the SPV recovery tuple recorded — the test is grounded in the real
      // 67-fact incident, not a synthetic re-derivation.
      assert.equal(sha256(snapshotBytes()), REAL_SNAPSHOT_SHA);
      assert.equal(sha256(patchBytes()), REAL_PATCH_SHA);
      assert.equal(
        sha256(fs.readFileSync(path.join(fixture.dir, `${REAL_FORENSIC_DIR_REL}/relational-audit-67.json`))),
        REAL_AUDIT_SHA,
      );
      assert.equal(incident.status, 'MES_RECOVERY_REQUIRED');
      assert.equal(incident.source_snapshot.sha256, REAL_SNAPSHOT_SHA);
      assert.equal(incident.source_snapshot.fact_count, REAL_SNAPSHOT_COUNT);

      // 2) The current observed Git basis must exist for the recovery write
      //    (F2 seam) — the forensic capture alone is not enough.
      fixture.write('delivery/stages/S05/plan.md', '# recovery plan marker\n');
      commitAll(fixture, 'recovery basis');
      const basis = observedGitBasis(fixture);
      const store = new MesSnapshotStore(fixture.dir);
      const rehydrated67 = store.read();
      assert.equal(rehydrated67.length, REAL_SNAPSHOT_COUNT, 'the real partial snapshot must rehydrate as exactly 67 facts');

      const refs: BaselineRefs = {
        forensicRef: `${REAL_FORENSIC_DIR_REL}/incident.json`,
        auditRef: `${REAL_FORENSIC_DIR_REL}/relational-audit-67.json`,
        auditSha: REAL_AUDIT_SHA,
      };

      // 3) BASELINE-READINESS ORDERING (before baseline): the forensic PVR3
      //    observed in the accidental partial write is history-only — it can
      //    never underpin a NORMAL plan_acceptance even before the baseline
      //    exists (its FINDINGS verdict was never a PLAN_READY verification).
      const beforeBaseline = snapshotText();
      const acceptanceOnForensicPvr = acceptanceReferencing(
        PVR3_RESULT_REF,
        PVR3_HEAD,
        PVR3_PLAN_DIGEST,
        'mes:fact:plan_acceptance:S05:probe',
      );
      assert.throws(() => store.write([acceptanceOnForensicPvr]), /PLAN_READY/);
      assert.equal(snapshotText(), beforeBaseline, 'forensic PVR3 must not authorize a NORMAL acceptance (no-write)');

      // 4) F2: a baseline bound to a STALE git basis — the incident records
      //    git_state_at_capture, which is not the current write basis — is
      //    rejected no-write.
      const staleBasis = { ...basis, head: 'b49b9562d70ef83c6990ac53e999eb3704b7be6c' };
      const stale = recoveryFact(REAL_SNAPSHOT_SHA, REAL_SNAPSHOT_COUNT, refs, staleBasis, 'MES-RECOVERY-20260910-S05-001-r1');
      assert.throws(() => store.write([stale]), /git_basis/);
      assert.equal(snapshotText(), beforeBaseline, 'stale git basis must be no-write');

      // 5) The legal baseline write at the CURRENT observed basis.
      const baseline = recoveryFact(REAL_SNAPSHOT_SHA, REAL_SNAPSHOT_COUNT, refs, basis, 'MES-RECOVERY-20260910-S05-001-r1');
      store.write([baseline]);
      const afterBaseline = snapshotText();

      // Retained history-only preservation: all 67 original facts survive the
      // baseline write byte-identically (never rewritten, never promoted).
      const after = new MesSnapshotStore(fixture.dir).read();
      assert.equal(after.length, REAL_SNAPSHOT_COUNT + 1);
      const originalFacts = JSON.parse(
        observeCanonicalProjectArtifact(`${REAL_FORENSIC_DIR_REL}/snapshot-67.json`).bytes.toString('utf8'),
      ).facts as MesFactEnvelope[];
      assert.equal(originalFacts.length, REAL_SNAPSHOT_COUNT);
      for (const fact of originalFacts) {
        const retained = after.find((f) => f.fact_id === fact.fact_id);
        assert.ok(retained, `retained fact ${fact.fact_id} must survive the recovery baseline write`);
        assert.equal(
          canonicalStringify(retained),
          canonicalStringify(fact),
          `retained fact ${fact.fact_id} must stay byte-identical (history-only, never rewritten)`,
        );
      }
      assert.ok(after.some((fact) => fact.fact_kind === 'recovery_baseline'));

      // PVR3 forensic-only: still present with its FINDINGS verdict, still
      // unable to underpin a NORMAL acceptance, and immutable once durable.
      const pvr3 = after.find((fact) => fact.fact_id === PVR3_FACT_ID);
      assert.ok(pvr3, 'the forensic PVR3 must remain retained in the snapshot');
      assert.equal((pvr3!.plan_binding as { verdict: string }).verdict, 'FINDINGS');
      assert.throws(() => store.write([acceptanceOnForensicPvr]), /PLAN_READY/);
      assert.equal(snapshotText(), afterBaseline, 'forensic PVR3 must stay non-authorizing after the baseline (no-write)');
      const mutatedPvr3 = {
        ...pvr3,
        plan_binding: { ...pvr3!.plan_binding, plan_digest: 'e'.repeat(64) },
      } as MesFactEnvelope;
      assert.throws(() => store.write([mutatedPvr3]), /RESULT_INVALID/);
      assert.equal(snapshotText(), afterBaseline, 'a conflicting payload under the forensic PVR3 fact_id must be no-write');

      // Dirty patch preservation: the forensic dirty-plan recovery patch is
      // never stash/reset/checkout/rollback-ed and no store write touches it.
      assert.deepEqual(patchBytes(), patchBefore, 'the dirty plan recovery patch must stay byte-identical');

      // Conflicting second epoch for the SAME real incident → no-write (F3).
      const secondEpoch = recoveryFact(REAL_SNAPSHOT_SHA, REAL_SNAPSHOT_COUNT, refs, basis, 'MES-RECOVERY-20260910-S05-001-r2');
      assert.throws(() => store.write([secondEpoch]), /forensic/);
      assert.equal(snapshotText(), afterBaseline, 'a conflicting second recovery epoch must be no-write');

      // Baseline-before-rehydrate ordering: identical replay stays byte-stable
      // and a FRESH rehydrate (the post-baseline decision input) sees the
      // retained history + the durable baseline — 68 facts total.
      store.write([baseline]);
      assert.equal(snapshotText(), afterBaseline, 'identical recovery baseline replay must be byte-stable');
      assert.equal(new MesSnapshotStore(fixture.dir).read().length, REAL_SNAPSHOT_COUNT + 1);
    } finally {
      fixture.cleanup();
    }
  });

  test('every real forensic capture is observed through the canonical project/trust root', () => {
    const canonicalRoot = resolveCanonicalProjectRoot();

    // S05 partial-replace capture: the observed bytes equal the identity the
    // immutable incident record carries.
    const s05Snapshot = observeCanonicalProjectArtifact(`${REAL_FORENSIC_DIR_REL}/snapshot-67.json`);
    assert.equal(s05Snapshot.root, canonicalRoot);
    assert.equal(s05Snapshot.path, path.join(canonicalRoot, REAL_FORENSIC_DIR_REL, 'snapshot-67.json'));
    assert.equal(s05Snapshot.sha256, REAL_SNAPSHOT_SHA);
    assert.equal((JSON.parse(s05Snapshot.bytes.toString('utf8')) as { facts: unknown[] }).facts.length, REAL_SNAPSHOT_COUNT);
    assert.equal(observeCanonicalProjectArtifact(`${REAL_FORENSIC_DIR_REL}/relational-audit-67.json`).sha256, REAL_AUDIT_SHA);

    // S06 binding-mismatch capture.
    const bmSnapshot = observeCanonicalProjectArtifact(`${S06_BINDING_MISMATCH_DIR_REL}/snapshot-130.json`);
    assert.equal(bmSnapshot.root, canonicalRoot);
    assert.equal(bmSnapshot.sha256, S06_SNAPSHOT_SHA);
    assert.equal((JSON.parse(bmSnapshot.bytes.toString('utf8')) as { facts: unknown[] }).facts.length, S06_SNAPSHOT_COUNT);
    assert.equal(observeCanonicalProjectArtifact(`${S06_BINDING_MISMATCH_DIR_REL}/audit.json`).sha256, S06_AUDIT_SHA);
    assert.equal(observeCanonicalProjectArtifact(`${S06_BINDING_MISMATCH_DIR_REL}/incident.json`).sha256, S06_INCIDENT_SHA);

    // S06 fact-gap capture (including its canonicalized source incident): the
    // expected identity is the one its own immutable incident record declares.
    const gapRecord = JSON.parse(
      observeCanonicalProjectArtifact(`${S06_FACT_GAP_DIR_REL}/incident.json`).bytes.toString('utf8'),
    ) as { source_snapshot: { sha256: string; fact_count: number } };
    const gapSnapshot = observeCanonicalProjectArtifact(`${S06_FACT_GAP_DIR_REL}/snapshot-122.json`);
    assert.equal(gapSnapshot.root, canonicalRoot);
    assert.equal(gapSnapshot.sha256, gapRecord.source_snapshot.sha256);
    assert.equal(
      (JSON.parse(gapSnapshot.bytes.toString('utf8')) as { facts: unknown[] }).facts.length,
      gapRecord.source_snapshot.fact_count,
    );
    assert.equal(observeCanonicalProjectArtifact(`${S06_FACT_GAP_DIR_REL}/canonicalized-001/incident.json`).root, canonicalRoot);
  });

  test('canonical capture observation never falls back to a worktree-local copy', () => {
    const primary = makeFixture();
    const linked = path.join(primary.dir, '.proofloop', 'worktrees', 'decoy-linked');
    try {
      primary.write('seed.txt', 'seed\n');
      commitAll(primary, 'seed');
      fs.mkdirSync(path.dirname(linked), { recursive: true });
      primary.run(['worktree', 'add', '--detach', linked]);

      const gapRecord = JSON.parse(
        observeCanonicalProjectArtifact(`${S06_FACT_GAP_DIR_REL}/incident.json`).bytes.toString('utf8'),
      ) as { source_snapshot: { sha256: string } };
      const captures = [
        { rel: REAL_FORENSIC_DIR_REL, artifact: 'snapshot-67.json', sha256: REAL_SNAPSHOT_SHA },
        { rel: S06_BINDING_MISMATCH_DIR_REL, artifact: 'snapshot-130.json', sha256: S06_SNAPSHOT_SHA },
        { rel: S06_FACT_GAP_DIR_REL, artifact: 'snapshot-122.json', sha256: gapRecord.source_snapshot.sha256 },
      ];
      const decoyBytes = Buffer.from('{"facts":[]}\n', 'utf8');

      for (const capture of captures) {
        const artifactRel = `${capture.rel}/${capture.artifact}`;
        // The canonical (primary root) copy carries the REAL capture bytes;
        // the LINKED worktree carries a divergent copy at its own local root.
        const canonicalTarget = path.join(primary.dir, artifactRel);
        fs.mkdirSync(path.dirname(canonicalTarget), { recursive: true });
        fs.writeFileSync(canonicalTarget, observeCanonicalProjectArtifact(artifactRel).bytes);
        const decoyTarget = path.join(linked, artifactRel);
        fs.mkdirSync(path.dirname(decoyTarget), { recursive: true });
        fs.writeFileSync(decoyTarget, decoyBytes);

        const observed = observeCanonicalProjectArtifact(artifactRel, linked);
        assert.equal(observed.root, primary.dir);
        assert.equal(observed.sha256, capture.sha256, `${artifactRel} must be observed from the canonical root`);
        assert.ok(!observed.path.startsWith(`${linked}${path.sep}`));
        assert.deepEqual(fs.readFileSync(decoyTarget), decoyBytes, `${artifactRel} decoy is never a mutation target`);
      }

      // Canonical copies absent → typed fail closed, never the worktree-local copy.
      const s05ArtifactRel = `${REAL_FORENSIC_DIR_REL}/snapshot-67.json`;
      fs.rmSync(path.join(primary.dir, REAL_FORENSIC_DIR_REL), { recursive: true, force: true });
      assert.throws(
        () => observeCanonicalProjectArtifact(s05ArtifactRel, linked),
        (error: unknown) => error instanceof CanonicalProjectMesObservationError,
      );
      assert.deepEqual(fs.readFileSync(path.join(linked, s05ArtifactRel)), decoyBytes);
    } finally {
      primary.cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (S06-R-F-T01) Current Authority-approved S06 binding-mismatch incident
// semantics: the recovery_baseline validator must accept the CURRENT
// incident (binding-mismatch / source-incident relation / read-only audit)
// against its OWN field layout — never forced to masquerade as the
// historical S05 layout (status/preimage_recovery/audit_mode/
// damage_conclusion markers) — while every fail-closed criterion (exact
// source digest/count, root-bound forensic/audit binding, unrecoverable-
// history semantics, complete relation/currentness validation) stays
// enforced (contracts §2.2.4a / acceptance E2E-24/E2E-25/E2E-26,
// ADR-021/022).
// ────────────────────────────────────────────────────────────────────────────

const CURRENT_INCIDENT_ID = 'MES-RECOVERY-20260913-S06-BINDING-MISMATCH-001';
const CURRENT_SOURCE_INCIDENT_REF = '.proofloop/forensics/recovery/source-incident.json';

// (S06-R-G-T01) Canonical source-incident identity binding closure fixture
// facts: the authoritative source-incident identity is resolved from the
// observed source's EXISTING durable recovery_baseline facts (recovery_id /
// fact_id embedded incident identity). The synthetic fixture therefore seeds
// a durable recovery_baseline fact for the fact-gap source incident
// (MES-RECOVERY-20260913-S06-MES-FACT-GAP-001) whose source_snapshot binding
// matches the candidate source incident's declared source_snapshot (the
// real 122-fact fact-gap capture snapshot).
const CURRENT_SOURCE_INCIDENT_ID = 'MES-RECOVERY-20260913-S06-MES-FACT-GAP-001';
const CURRENT_SOURCE_INCIDENT_SOURCE_SHA = '638fa19bf81627e88135a04c81bade9d49dcdbd492e01e7ac2c1091201371312';
const CURRENT_SOURCE_INCIDENT_SOURCE_COUNT = 122;
const CANONICALIZED_SOURCE_AUDIT_REF = '.proofloop/forensics/recovery/canonicalized-source-audit.json';
const CANONICALIZED_SOURCE_AUDIT_CONTENT = JSON.stringify({
  audit_id: 'SOURCE-CANONICAL-AUDIT-001',
  mode: 'read_only',
  source_snapshot_sha256: CURRENT_SOURCE_INCIDENT_SOURCE_SHA,
  source_fact_count: CURRENT_SOURCE_INCIDENT_SOURCE_COUNT,
  no_reconstruction: true,
  no_history_rewrite: true,
});

type CurrentLayoutRefs = BaselineRefs & { sourceIncidentRef: string };

/**
 * Write the CURRENT binding-mismatch incident + read-only relational audit +
 * source incident (fact-gap capture) a current-layout recovery baseline
 * references. `incidentOverride`/`auditOverride`/`sourceIncidentOverride` let
 * a probe inject missing / ambiguous / wrong relation evidence into the
 * artifacts.
 */
function defineCurrentBaselineArtifacts(
  fixture: ReturnType<typeof makeFixture>,
  sourceSha: string,
  sourceCount: number,
  opts?: {
    incidentOverride?: (incident: Record<string, unknown>) => Record<string, unknown>;
    auditOverride?: (audit: Record<string, unknown>) => Record<string, unknown>;
    sourceIncidentOverride?: (sourceIncident: Record<string, unknown>) => Record<string, unknown>;
  },
): CurrentLayoutRefs {
  const forensicRef = '.proofloop/forensics/recovery/incident.json';
  const auditRef = '.proofloop/forensics/recovery/audit.json';
  // The source incident is the fact-gap capture the binding-mismatch
  // incident derives from (distinct, recovery-required, root-bound
  // re-readable — the source-incident relation).
  let sourceIncident: Record<string, unknown> = {
    incident_id: 'MES-RECOVERY-20260913-S06-MES-FACT-GAP-001',
    incident_type: 'mes_fact_set_drift_after_recovery',
    status: 'MES_RECOVERY_REQUIRED',
    source_snapshot: {
      path: '.proofloop/mes/snapshot.json',
      fact_count: 122,
      schema_version: 2,
      sha256: '638fa19bf81627e88135a04c81bade9d49dcdbd492e01e7ac2c1091201371312',
    },
  };
  if (opts?.sourceIncidentOverride) sourceIncident = opts.sourceIncidentOverride(sourceIncident);
  fixture.write(CURRENT_SOURCE_INCIDENT_REF, JSON.stringify(sourceIncident));
  let incident: Record<string, unknown> = {
    incident_id: CURRENT_INCIDENT_ID,
    incident_type: 'mes_binding_mismatch_in_durable_facts',
    control_state: 'S06_NORMAL_HARD_FROZEN',
    source_incident_ref: CURRENT_SOURCE_INCIDENT_REF,
    source_snapshot: {
      path: '.proofloop/mes/snapshot.json',
      schema_version: 2,
      fact_count: sourceCount,
      sha256: sourceSha,
    },
    forensic_copy: {
      path: '.proofloop/forensics/recovery/snapshot.json',
      schema_version: 2,
      fact_count: sourceCount,
      sha256: sourceSha,
      byte_equal_to_source: true,
    },
    misbound_fact_count: 1,
    misbound_facts: [
      {
        fact_id: 'mes:fact:work:S06:S06-D:post-fact-recovery-1',
        fact_kind: 'work',
        scope: { slice_id: 'S06-D', stage_id: 'S06' },
        binding_path: 'plan_binding.verification_result_ref',
        submitted_ref: 'mes:result:S06:planning-verification:1',
        canonical_ref: 'mes:result:S06:planning-verification-1',
      },
    ],
    accepted_plan_relation: {
      plan_ref: 'delivery/stages/S06/plan.md',
      planning_verification_fact_id: 'mes:fact:planning_verification_result:S06:1',
      planning_verification_result_ref: 'mes:result:S06:planning-verification-1',
      plan_acceptance_fact_id: 'mes:fact:plan_acceptance:S06:1',
      delivery_cycle_id: 'cycle-208cbbe8d8e946479bb746f318b56178',
      plan_digest: '13c41263c750b2df8ebf7b8269bcec31f7b37b770d4f50db543bf061ea6fb90e',
    },
    preimage_and_reconstruction: {
      current_source_preimage: 'available as exact current snapshot and forensic copy',
      historical_bad_binding_preimage: 'not reconstructed; no historical facts inferred',
      missing_fact_reconstruction_attempted: false,
      historical_facts_rewritten: false,
    },
    conclusion: {
      facts_remain: 'durable, immutable, readable, auditable',
      relation_classification: 'relation-invalid / non-authorizing',
      authorization_effect: 'cannot authorize Task/Slice completion, Integration/CLEANED, STAGE_ACCEPTED, PROJECT_READY, or S06 continuation',
      currentness_rule: 'canonical relation equality, never insertion order/newest-wins/ref spelling',
    },
    audit_ref: auditRef,
  };
  if (opts?.incidentOverride) incident = opts.incidentOverride(incident);
  fixture.write(forensicRef, JSON.stringify(incident));
  let audit: Record<string, unknown> = {
    audit_id: `${CURRENT_INCIDENT_ID}-AUDIT`,
    mode: 'read_only',
    incident_ref: forensicRef,
    source_snapshot_ref: '.proofloop/mes/snapshot.json',
    source_snapshot_sha256: sourceSha,
    source_fact_count: sourceCount,
    schema_version: 2,
    forensic_copy_ref: '.proofloop/forensics/recovery/snapshot.json',
    forensic_copy_sha256: sourceSha,
    forensic_copy_byte_equal_to_source: true,
    checks: [
      { check: 'exact source digest/count/schema', result: 'PASS' },
      { check: 'forensic copy byte equality', result: 'PASS' },
      { check: 'misbound facts retained in source', result: 'PASS', count: 1 },
      {
        check: 'accepted Plan binding relation',
        result: 'PASS',
        canonical_ref: 'mes:result:S06:planning-verification-1',
      },
      {
        check: 'misbound relation validity',
        result: 'INVALID_NON_AUTHORIZING',
        submitted_ref: 'mes:result:S06:planning-verification:1',
        canonical_ref: 'mes:result:S06:planning-verification-1',
      },
      {
        check: 'public status routing safety',
        result: 'OBSERVATION_ONLY',
        observed_phase: 'EXECUTE',
        required_skill: 'proofloop-execute',
        dispatch_authorized: false,
      },
      { check: 'MES write quarantine', result: 'PASS', directory_mode: '0555', safe_probe: 'EACCES' },
    ],
    misbound_fact_ids: ['mes:fact:work:S06:S06-D:post-fact-recovery-1'],
    canonical_relation: {
      plan_ref: 'delivery/stages/S06/plan.md',
      planning_verification_fact_id: 'mes:fact:planning_verification_result:S06:1',
      planning_verification_result_ref: 'mes:result:S06:planning-verification-1',
      plan_acceptance_fact_id: 'mes:fact:plan_acceptance:S06:1',
      delivery_cycle_id: 'cycle-208cbbe8d8e946479bb746f318b56178',
      plan_digest: '13c41263c750b2df8ebf7b8269bcec31f7b37b770d4f50db543bf061ea6fb90e',
    },
    no_reconstruction: true,
    no_history_rewrite: true,
    limitations: [
      'This audit does not reconstruct missing or prior facts.',
      'This audit does not modify or delete the retained facts.',
    ],
    conclusion: 'The facts are schema-readable durable history but fail exact accepted-Plan binding validation and are non-authorizing after restart/rehydration; no authorization is inferred from insertion order or ref naming.',
  };
  if (opts?.auditOverride) audit = opts.auditOverride(audit);
  const auditContent = JSON.stringify(audit);
  fixture.write(auditRef, auditContent);
  return { forensicRef, auditRef, auditSha: sha256(auditContent), sourceIncidentRef: CURRENT_SOURCE_INCIDENT_REF };
}

/**
 * A fixture ready for CURRENT-layout recovery-baseline probes: a committed
 * Git basis (required by the F2 current-basis seam), one durable planning
 * fact as the observed source snapshot, and the current binding-mismatch
 * incident + source incident + read-only relational audit.
 */
function seedCurrentIncidentFixture(opts?: {
  pvrVerdict?: MesPlanVerdict;
  incidentOverride?: (incident: Record<string, unknown>) => Record<string, unknown>;
  auditOverride?: (audit: Record<string, unknown>) => Record<string, unknown>;
  sourceIncidentOverride?: (sourceIncident: Record<string, unknown>) => Record<string, unknown>;
  // (S06-R-G-T01) Canonical source-incident identity binding closure probes:
  // the observed source by default seeds a durable recovery_baseline fact
  // for the fact-gap source incident so the candidate source_incident_ref
  // resolution can exact-match a canonical durable recovery_baseline fact.
  omitDurableBaseline?: boolean;
  duplicateDurableBaseline?: boolean;
  durableBaselineOverride?: (baseline: MesFactEnvelope) => MesFactEnvelope;
  canonicalizedIncidentOverride?: (incident: Record<string, unknown>) => Record<string, unknown>;
  extraSourceFacts?: MesFactEnvelope[];
}): {
  fixture: ReturnType<typeof makeFixture>;
  store: MesSnapshotStore;
  snapshotPath: string;
  sourceSha: string;
  sourceCount: number;
  refs: CurrentLayoutRefs;
  basis: GitBasis;
  snapshotBytes: () => string;
} {
  const fixture = makeFixture();
  fixture.write('delivery/stages/S06/plan.md', '# recovery fixture marker\n');
  commitAll(fixture, 'recovery fixture basis');
  const store = new MesSnapshotStore(fixture.dir);
  const snapshotPath = path.join(fixture.dir, MES_SNAPSHOT_REL);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  // (S06-R-G-T01) The observed source carries a durable recovery_baseline
  // fact for the fact-gap source incident by default (the canonical
  // source-incident identity the candidate pointer must exact-match);
  // `omitDurableBaseline` / `duplicateDurableBaseline` / extraSourceFacts
  // inject missing / ambiguous / duplicate canonical identity evidence.
  const observedFacts: MesFactEnvelope[] = [
    planningFact(),
    currentCanonicalPvrFact(opts?.pvrVerdict),
    currentCanonicalPaFact(),
    currentMisboundWorkFact(),
  ];
  if (!opts?.omitDurableBaseline) {
    observedFacts.push(durableSourceIncidentBaselineFact(opts?.durableBaselineOverride));
    if (opts?.duplicateDurableBaseline) observedFacts.push(durableSourceIncidentBaselineFact(opts?.durableBaselineOverride));
  }
  if (opts?.extraSourceFacts !== undefined) observedFacts.push(...opts.extraSourceFacts);
  fs.writeFileSync(
    snapshotPath,
    canonicalStringify({ schema_version: 2, facts: observedFacts }),
    'utf8',
  );
  const sourceBytes = fs.readFileSync(snapshotPath);
  const sourceSha = sha256(sourceBytes);
  const sourceCount = JSON.parse(sourceBytes.toString('utf8')).facts.length as number;
  const refs = defineCurrentBaselineArtifacts(fixture, sourceSha, sourceCount, opts);
  defineCanonicalizedSourceArtifacts(fixture, opts?.canonicalizedIncidentOverride);
  return {
    fixture,
    store,
    snapshotPath,
    sourceSha,
    sourceCount,
    refs,
    basis: observedGitBasis(fixture),
    snapshotBytes: () => fs.readFileSync(snapshotPath, 'utf8'),
  };
}

describe('current S06 binding-mismatch recovery baseline (S06-R-F-T01)', () => {
  test('writes an exact-source recovery baseline bound to the CURRENT incident semantics (own field layout, not historical masquerade), retains it across restart and replays idempotently', () => {
    const s = seedCurrentIncidentFixture();
    try {
      const baseline = recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID);
      s.store.write([baseline]);
      const afterFacts = new MesSnapshotStore(s.fixture.dir).read();
      assert.equal(afterFacts.length, s.sourceCount + 1);
      assert.ok(afterFacts.some((fact) => fact.fact_kind === 'recovery_baseline'));
      assert.ok(afterFacts.some((fact) => fact.fact_id === planningFact().fact_id));
      const afterFirst = s.snapshotBytes();
      s.store.write([baseline]);
      assert.equal(s.snapshotBytes(), afterFirst, 'identical current-layout recovery baseline replay must be byte-stable');
      assert.ok(new MesSnapshotStore(s.fixture.dir).read().some((fact) => fact.fact_kind === 'recovery_baseline'));
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects a current-layout baseline whose source snapshot digest/count does not match the observed source no-write', () => {
    const badDigest = seedCurrentIncidentFixture({
      incidentOverride: (i) => ({ ...i, source_snapshot: { ...(i.source_snapshot as Record<string, unknown>), sha256: 'f'.repeat(64) } }),
    });
    try {
      const before = badDigest.snapshotBytes();
      assert.throws(
        () => badDigest.store.write([recoveryFact(badDigest.sourceSha, badDigest.sourceCount, badDigest.refs, badDigest.basis, CURRENT_INCIDENT_ID)]),
        /source digest\/count mismatch/,
      );
      assert.equal(badDigest.snapshotBytes(), before, 'source digest mismatch must be no-write');
    } finally {
      badDigest.fixture.cleanup();
    }
    const badCount = seedCurrentIncidentFixture({
      incidentOverride: (i) => ({ ...i, source_snapshot: { ...(i.source_snapshot as Record<string, unknown>), fact_count: (i.source_snapshot as { fact_count: number }).fact_count + 1 } }),
    });
    try {
      const before = badCount.snapshotBytes();
      assert.throws(
        () => badCount.store.write([recoveryFact(badCount.sourceSha, badCount.sourceCount, badCount.refs, badCount.basis, CURRENT_INCIDENT_ID)]),
        /source digest\/count mismatch/,
      );
      assert.equal(badCount.snapshotBytes(), before, 'source count mismatch must be no-write');
    } finally {
      badCount.fixture.cleanup();
    }
  });

  test('rejects a current-layout baseline with wrong or missing source-incident relation no-write', () => {
    const cases: Array<{ label: string; opts: Parameters<typeof seedCurrentIncidentFixture>[0]; match: RegExp }> = [
      {
        label: 'missing source_incident_ref',
        opts: { incidentOverride: (i) => { const { source_incident_ref: _omit, ...rest } = i; return rest; } },
        match: /missing source-incident relation/,
      },
      {
        label: 'self-referential source_incident_ref',
        opts: { incidentOverride: (i) => ({ ...i, source_incident_ref: '.proofloop/forensics/recovery/incident.json' }) },
        match: /self-reference/,
      },
      {
        label: 'unreadable source_incident_ref',
        opts: { incidentOverride: (i) => ({ ...i, source_incident_ref: '.proofloop/forensics/recovery/missing-source.json' }) },
        match: /not re-readable/,
      },
      {
        label: 'source incident not recovery-required',
        opts: { sourceIncidentOverride: (src) => ({ ...src, status: 'OBSERVED' }) },
        match: /not a recovery-required incident/,
      },
      {
        label: 'source incident missing incident_id',
        opts: { sourceIncidentOverride: (src) => { const { incident_id: _omit, ...rest } = src; return rest; } },
        match: /not a recovery-required incident/,
      },
    ];
    for (const { label, opts, match } of cases) {
      const s = seedCurrentIncidentFixture(opts);
      try {
        const before = s.snapshotBytes();
        assert.throws(
          () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
          match,
          label,
        );
        assert.equal(s.snapshotBytes(), before, `${label} must be no-write`);
      } finally {
        s.fixture.cleanup();
      }
    }
  });

  test('rejects a non-read-only or non-matching audit and a forensic copy that is not byte-equal no-write', () => {
    const cases: Array<{ label: string; opts: Parameters<typeof seedCurrentIncidentFixture>[0]; match: RegExp }> = [
      {
        label: 'non-read-only audit',
        opts: { auditOverride: (a) => ({ ...a, mode: 'read_write' }) },
        match: /read-only audit/,
      },
      {
        label: 'audit source digest mismatch',
        opts: { auditOverride: (a) => ({ ...a, source_snapshot_sha256: 'f'.repeat(64) }) },
        match: /read-only audit/,
      },
      {
        label: 'audit forensic copy binding mismatch',
        opts: { auditOverride: (a) => ({ ...a, forensic_copy_byte_equal_to_source: false }) },
        match: /forensic copy binding/,
      },
      {
        label: 'incident forensic copy not byte-equal',
        opts: { incidentOverride: (i) => ({ ...i, forensic_copy: { ...(i.forensic_copy as Record<string, unknown>), byte_equal_to_source: false } }) },
        match: /byte-equal/,
      },
      {
        label: 'audit no_reconstruction false',
        opts: { auditOverride: (a) => ({ ...a, no_reconstruction: false }) },
        match: /no_reconstruction/,
      },
      {
        label: 'incident reconstruction attempted',
        opts: { incidentOverride: (i) => ({ ...i, preimage_and_reconstruction: { ...(i.preimage_and_reconstruction as Record<string, unknown>), missing_fact_reconstruction_attempted: true } }) },
        match: /no reconstruction/,
      },
    ];
    for (const { label, opts, match } of cases) {
      const s = seedCurrentIncidentFixture(opts);
      try {
        const before = s.snapshotBytes();
        assert.throws(
          () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
          match,
          label,
        );
        assert.equal(s.snapshotBytes(), before, `${label} must be no-write`);
      } finally {
        s.fixture.cleanup();
      }
    }
  });

  test('rejects missing/ambiguous plan-acceptance support, finding-disposition and closure evidence no-write', () => {
    const cases: Array<{ label: string; opts: Parameters<typeof seedCurrentIncidentFixture>[0]; match: RegExp }> = [
      {
        label: 'incident missing accepted_plan_relation',
        opts: { incidentOverride: (i) => { const { accepted_plan_relation: _omit, ...rest } = i; return rest; } },
        match: /accepted_plan_relation/,
      },
      {
        label: 'audit checks missing accepted Plan binding relation',
        opts: {
          auditOverride: (a) => ({ ...a, checks: (a.checks as Record<string, unknown>[]).filter((c) => c.check !== 'accepted Plan binding relation') }),
        },
        match: /accepted Plan binding relation/,
      },
      {
        label: 'audit canonical_relation missing plan_digest',
        opts: { auditOverride: (a) => ({ ...a, canonical_relation: { ...(a.canonical_relation as Record<string, unknown>), plan_digest: undefined } }) },
        match: /canonical_relation/,
      },
      {
        label: 'audit checks missing misbound relation validity',
        opts: {
          auditOverride: (a) => ({ ...a, checks: (a.checks as Record<string, unknown>[]).filter((c) => c.check !== 'misbound relation validity') }),
        },
        match: /misbound relation validity/,
      },
      {
        label: 'misbound validity without submitted_ref',
        opts: {
          auditOverride: (a) => ({
            ...a,
            checks: (a.checks as Record<string, unknown>[]).map((c) => (c.check === 'misbound relation validity' ? { ...c, submitted_ref: undefined } : c)),
          }),
        },
        match: /submitted_ref/,
      },
      {
        label: 'routing safety check authorizes dispatch',
        opts: {
          auditOverride: (a) => ({
            ...a,
            checks: (a.checks as Record<string, unknown>[]).map((c) => (c.check === 'public status routing safety' ? { ...c, dispatch_authorized: true } : c)),
          }),
        },
        match: /must not authorize dispatch/,
      },
    ];
    for (const { label, opts, match } of cases) {
      const s = seedCurrentIncidentFixture(opts);
      try {
        const before = s.snapshotBytes();
        assert.throws(
          () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
          match,
          label,
        );
        assert.equal(s.snapshotBytes(), before, `${label} must be no-write`);
      } finally {
        s.fixture.cleanup();
      }
    }
  });

  test('rejects missing/duplicate/dangling relation marker evidence and historical-source masquerade no-write', () => {
    const cases: Array<{ label: string; opts: Parameters<typeof seedCurrentIncidentFixture>[0]; match: RegExp }> = [
      {
        label: 'missing audit checks[] (marker arrays absent is NOT PASS)',
        opts: { auditOverride: (a) => { const { checks: _omit, ...rest } = a; return rest; } },
        match: /must report checks/,
      },
      {
        label: 'check entry without a definite result',
        opts: { auditOverride: (a) => ({ ...a, checks: [{ ...(a.checks as Record<string, unknown>[])[0], result: '' }] }) },
        match: /definite check\/result pair/,
      },
      {
        label: 'duplicate check name',
        opts: { auditOverride: (a) => ({ ...a, checks: [...(a.checks as Record<string, unknown>[]), (a.checks as Record<string, unknown>[])[0]] }) },
        match: /must not repeat check/,
      },
      {
        label: 'duplicate misbound fact id',
        opts: {
          auditOverride: (a) => ({ ...a, misbound_fact_ids: [(a.misbound_fact_ids as string[])[0], (a.misbound_fact_ids as string[])[0]] }),
        },
        match: /duplicate fact id/,
      },
      {
        label: 'dangling audit misbound id',
        opts: { auditOverride: (a) => ({ ...a, misbound_fact_ids: ['mes:fact:does:not:exist'] }) },
        match: /does not resolve/,
      },
      {
        label: 'incident misbound facts missing',
        opts: { incidentOverride: (i) => { const { misbound_facts: _omit, ...rest } = i; return rest; } },
        match: /must report misbound_facts/,
      },
      {
        label: 'incident_type not binding-mismatch (historical source as current)',
        opts: {
          incidentOverride: (i) => ({
            ...i,
            incident_type: 'mes_fact_set_drift_after_recovery',
            status: 'MES_RECOVERY_REQUIRED',
          }),
        },
        match: /unrecoverable-preimage incident/,
      },
    ];
    for (const { label, opts, match } of cases) {
      const s = seedCurrentIncidentFixture(opts);
      try {
        const before = s.snapshotBytes();
        assert.throws(
          () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
          match,
          label,
        );
        assert.equal(s.snapshotBytes(), before, `${label} must be no-write`);
      } finally {
        s.fixture.cleanup();
      }
    }
  });

  test('rejects conflicting recovery epochs and stale git basis for the CURRENT incident no-write', () => {
    const s = seedCurrentIncidentFixture();
    try {
      const before = s.snapshotBytes();
      const first = recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID);
      const second = recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, `${CURRENT_INCIDENT_ID}-r2`);
      // One submission must not carry TWO epochs for the same forensic
      // incident (F3 — the current layout shares the epoch seam).
      assert.throws(() => s.store.write([first, second]), /forensic/);
      assert.equal(s.snapshotBytes(), before, 'conflicting epochs in one submission must be no-write');
      // A legal single epoch writes; identical replay is byte-stable.
      s.store.write([first]);
      const afterFirst = s.snapshotBytes();
      s.store.write([first]);
      assert.equal(s.snapshotBytes(), afterFirst, 'identical current-layout replay must be byte-stable');
      // A second epoch for the SAME current incident after the durable
      // baseline is a conflicting duplicate — no-write (F3).
      assert.throws(() => s.store.write([second]), /forensic/);
      assert.equal(s.snapshotBytes(), afterFirst, 'conflicting second epoch must be no-write');
      // F2 (stale git basis) is probed on a FRESH fixture below — a stale
      // basis probe against `s` would collide with the durable `first` epoch
      // on the SAME forensic incident, firing the epoch-conflict seam first.
    } finally {
      s.fixture.cleanup();
    }
    // F2: a baseline bound to a STALE git basis is rejected no-write on a
    // fresh current-layout fixture (no pre-existing durable epoch).
    const s2 = seedCurrentIncidentFixture();
    try {
      const before = s2.snapshotBytes();
      const staleBasis = { ...s2.basis, head: 'f'.repeat(40) };
      const stale = recoveryFact(s2.sourceSha, s2.sourceCount, s2.refs, staleBasis, `${CURRENT_INCIDENT_ID}-stale`);
      assert.throws(() => s2.store.write([stale]), /git_basis/);
      assert.equal(s2.snapshotBytes(), before, 'stale git basis must be no-write');
    } finally {
      s2.fixture.cleanup();
    }
  });

  test('rejects relation-set exactness violations no-write (strict subset / extra-on-one-side / canonical disagreement / misbound or PVR-PA not resolving in the observed source)', () => {
    const cases: Array<{ label: string; opts: Parameters<typeof seedCurrentIncidentFixture>[0]; match: RegExp }> = [
      {
        label: 'strict subset of the misbound relation set (audit omits an incident misbound fact)',
        opts: {
          incidentOverride: (i) => ({ ...i, misbound_facts: [...(i.misbound_facts as Record<string, unknown>[]), { fact_id: 'mes:fact:task:S06-D-T01:post-fact-recovery-1', fact_kind: 'task', scope: { slice_id: 'S06-D', stage_id: 'S06' }, binding_path: 'plan_binding.verification_result_ref', submitted_ref: 'mes:result:S06:planning-verification:1', canonical_ref: 'mes:result:S06:planning-verification-1' }] }),
        },
        match: /absent from audit misbound_fact_ids/,
      },
      {
        label: 'extra id on the audit side (audit lists a misbound fact the incident does not declare)',
        opts: {
          auditOverride: (a) => ({ ...a, misbound_fact_ids: [...(a.misbound_fact_ids as string[]), 'mes:fact:task:S06-D-T01:post-fact-recovery-1'] }),
        },
        match: /does not resolve to an incident misbound fact/,
      },
      {
        label: 'canonical_relation disagrees with incident accepted_plan_relation (plan_digest)',
        opts: {
          auditOverride: (a) => ({ ...a, canonical_relation: { ...(a.canonical_relation as Record<string, unknown>), plan_digest: 'f'.repeat(64) } }),
        },
        match: /canonical_relation\.plan_digest disagrees/,
      },
      {
        label: 'canonical_relation disagrees with incident accepted_plan_relation (planning_verification_fact_id)',
        opts: {
          auditOverride: (a) => ({ ...a, canonical_relation: { ...(a.canonical_relation as Record<string, unknown>), planning_verification_fact_id: 'mes:fact:planning_verification_result:S06:ghost' } }),
        },
        match: /canonical_relation\.planning_verification_fact_id disagrees/,
      },
      {
        label: 'misbound fact does not exist in the observed source snapshot',
        opts: {
          incidentOverride: (i) => ({ ...i, misbound_facts: [{ fact_id: 'mes:fact:work:S06:S06-D:ghost', fact_kind: 'work', scope: { slice_id: 'S06-D', stage_id: 'S06' }, binding_path: 'plan_binding.verification_result_ref', submitted_ref: 'mes:result:S06:planning-verification:1', canonical_ref: 'mes:result:S06:planning-verification-1' }] }),
          auditOverride: (a) => ({ ...a, misbound_fact_ids: ['mes:fact:work:S06:S06-D:ghost'] }),
        },
        match: /does not exist in the observed source snapshot/,
      },
      {
        label: 'canonical PVR not resolving in the observed source (ghost fact id, accepted_plan_relation agrees)',
        opts: {
          incidentOverride: (i) => ({ ...i, accepted_plan_relation: { ...(i.accepted_plan_relation as Record<string, unknown>), planning_verification_fact_id: 'mes:fact:planning_verification_result:S06:ghost' } }),
          auditOverride: (a) => ({ ...a, canonical_relation: { ...(a.canonical_relation as Record<string, unknown>), planning_verification_fact_id: 'mes:fact:planning_verification_result:S06:ghost' } }),
        },
        match: /does not resolve to the durable PLAN_READY PVR/,
      },
      {
        label: 'canonical PVR plan_binding disagrees with canonical_relation (plan_digest swapped on both sides)',
        opts: {
          incidentOverride: (i) => ({ ...i, accepted_plan_relation: { ...(i.accepted_plan_relation as Record<string, unknown>), plan_digest: 'f'.repeat(64) } }),
          auditOverride: (a) => ({ ...a, canonical_relation: { ...(a.canonical_relation as Record<string, unknown>), plan_digest: 'f'.repeat(64) } }),
        },
        match: /PVR plan_binding disagrees/,
      },
      {
        label: 'canonical plan_acceptance not resolving in the observed source (ghost fact id)',
        opts: {
          incidentOverride: (i) => ({ ...i, accepted_plan_relation: { ...(i.accepted_plan_relation as Record<string, unknown>), plan_acceptance_fact_id: 'mes:fact:plan_acceptance:S06:ghost' } }),
          auditOverride: (a) => ({ ...a, canonical_relation: { ...(a.canonical_relation as Record<string, unknown>), plan_acceptance_fact_id: 'mes:fact:plan_acceptance:S06:ghost' } }),
        },
        match: /does not resolve to a durable plan_acceptance/,
      },
      {
        label: 'canonical plan_acceptance plan_binding does not resolve to the canonical PVR relation (verification_result_ref swapped on both sides, PVR untouched)',
        opts: {
          incidentOverride: (i) => ({ ...i, accepted_plan_relation: { ...(i.accepted_plan_relation as Record<string, unknown>), planning_verification_result_ref: 'mes:result:S06:planning-verification-ghost' } }),
          auditOverride: (a) => ({ ...a, canonical_relation: { ...(a.canonical_relation as Record<string, unknown>), planning_verification_result_ref: 'mes:result:S06:planning-verification-ghost' } }),
        },
        match: /does not resolve to the durable PLAN_READY PVR/,
      },
      {
        label: 'duplicate fact id WITHIN incident misbound_facts (audit keeps unique ids, incident count unchanged) — duplicate relation evidence fails closed',
        opts: {
          incidentOverride: (i) => ({ ...i, misbound_facts: [...(i.misbound_facts as Record<string, unknown>[]), (i.misbound_facts as Record<string, unknown>[])[0]] }),
        },
        match: /reports duplicate fact id/,
      },
    ];
    for (const { label, opts, match } of cases) {
      const s = seedCurrentIncidentFixture(opts);
      try {
        const before = s.snapshotBytes();
        assert.throws(
          () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
          match,
          label,
        );
        assert.equal(s.snapshotBytes(), before, `${label} must be no-write`);
      } finally {
        s.fixture.cleanup();
      }
    }
  });

  test('rejects a baseline whose canonical PVR does not carry verdict PLAN_READY no-write (verdict FINDINGS / BLOCKED)', () => {
    const cases: Array<{ label: string; verdict: MesPlanVerdict; match: RegExp }> = [
      { label: 'canonical PVR verdict FINDINGS', verdict: 'FINDINGS', match: /must be exactly PLAN_READY/ },
      { label: 'canonical PVR verdict BLOCKED', verdict: 'BLOCKED', match: /must be exactly PLAN_READY/ }
    ];
    for (const { label, verdict, match } of cases) {
      const s = seedCurrentIncidentFixture({ pvrVerdict: verdict });
      try {
        const before = s.snapshotBytes();
        assert.throws(
          () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
          match,
          label,
        );
        assert.equal(s.snapshotBytes(), before, `${label} must be no-write`);
      } finally {
        s.fixture.cleanup();
      }
    }
  });

  test('real S06 binding-mismatch recovery baseline: the current-incident 130-fact baseline write retains ALL 130 pre-existing facts byte-for-byte (including the six misbound work/task/result/git facts) and appends the baseline (130+1=131), never dropping or rewriting a pre-existing source fact (S06-R-F-T01 bounded recovery)', () => {
    const fixture = makeFixture();
    try {
      // Real forensic capture of the S06 binding-mismatch incident, copied
      // READ-ONLY into the temp fixture (same grounding as the legacy
      // real-incident test): the exact 130-fact observed snapshot, the
      // binding-mismatch incident, its read-only audit, and the fact-gap
      // source incident its source_incident_ref points at.
      const bmRel = S06_BINDING_MISMATCH_DIR_REL;
      const gapRel = S06_FACT_GAP_DIR_REL;
      const copyReal = (name: string, rel: string): void => {
        const target = path.join(fixture.dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, observeCanonicalProjectArtifact(`${bmRel}/${name}`).bytes);
      };
      copyReal('snapshot-130.json', MES_SNAPSHOT_REL);
      copyReal('incident.json', `${bmRel}/incident.json`);
      copyReal('audit.json', `${bmRel}/audit.json`);
      const gapIncidentTarget = path.join(fixture.dir, gapRel, 'incident.json');
      fs.mkdirSync(path.dirname(gapIncidentTarget), { recursive: true });
      fs.writeFileSync(gapIncidentTarget, observeCanonicalProjectArtifact(`${gapRel}/incident.json`).bytes);
      // (S06-R-G-T01) The durable fact-gap recovery_baseline fact already
      // inside snapshot-130.json references its OWN canonicalized source-
      // incident artifact as forensic_ref — the canonical identity the new
      // closure re-reads. Copy it READ-ONLY too so the canonical forensic
      // identity stays re-readable in the fixture.
      const gapCanonicalTarget = path.join(fixture.dir, gapRel, 'canonicalized-001', 'incident.json');
      fs.mkdirSync(path.dirname(gapCanonicalTarget), { recursive: true });
      fs.writeFileSync(gapCanonicalTarget, observeCanonicalProjectArtifact(`${gapRel}/canonicalized-001/incident.json`).bytes);
      const snapshotBytes = () => fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL));

      // Cross-check: the copied capture bytes ARE the digests the frozen
      // snapshot / forensic / audit binding recorded (not synthetic).
      const sourceSha = sha256(snapshotBytes());
      assert.equal(sourceSha, S06_SNAPSHOT_SHA);
      const sourceCount = JSON.parse(snapshotBytes().toString('utf8')).facts.length as number;
      assert.equal(sourceCount, S06_SNAPSHOT_COUNT);
      const auditSha = sha256(fs.readFileSync(path.join(fixture.dir, `${bmRel}/audit.json`)));
      assert.equal(auditSha, S06_AUDIT_SHA);
      const forensicSha = sha256(fs.readFileSync(path.join(fixture.dir, `${bmRel}/incident.json`)));
      assert.equal(forensicSha, S06_INCIDENT_SHA);

      // The current observed Git basis must exist for the recovery write (F2).
      fixture.write('delivery/stages/S06/plan.md', '# recovery plan marker\n');
      commitAll(fixture, 'recovery basis');
      const basis = observedGitBasis(fixture);
      const store = new MesSnapshotStore(fixture.dir);
      assert.equal(store.read().length, 130, 'the real 130-fact snapshot must rehydrate as exactly 130 facts');

      const refs: BaselineRefs = {
        forensicRef: `${bmRel}/incident.json`,
        auditRef: `${bmRel}/audit.json`,
        auditSha,
      };
      const baseline = recoveryFact(sourceSha, sourceCount, refs, basis, CURRENT_INCIDENT_ID);
      store.write([baseline]);

      // The durable baseline write must preserve the ENTIRE observed source
      // (history-only): all 130 original facts survive byte-identically AND
      // the recovery_baseline fact is appended — 131 facts total. In
      // particular the six misbound S06-D work/task/result/git facts the
      // read-only audit asserts as 'misbound facts retained in source' must
      // NEVER be silently dropped by the write retention merge.
      const after = new MesSnapshotStore(fixture.dir).read();
      assert.equal(after.length, sourceCount + 1, 'all 130 pre-existing source facts + the baseline fact (130+1=131)');
      assert.ok(after.some((fact) => fact.fact_kind === 'recovery_baseline'));
      const originalFacts = JSON.parse(
        observeCanonicalProjectArtifact(`${bmRel}/snapshot-130.json`).bytes.toString('utf8'),
      ).facts as MesFactEnvelope[];
      assert.equal(originalFacts.length, 130);
      const afterById = new Map(after.map((fact) => [fact.fact_id, fact]));
      for (const fact of originalFacts) {
        const retained = afterById.get(fact.fact_id);
        assert.ok(retained, `pre-existing source fact ${fact.fact_id} must survive the current-incident baseline write`);
        assert.equal(
          canonicalStringify(retained),
          canonicalStringify(fact),
          `pre-existing source fact ${fact.fact_id} must stay byte-identical (history-only, never rewritten)`,
        );
      }
      const misboundWorkTaskResultGit = [
        'mes:fact:work:S06:S06-D:post-fact-recovery-1',
        'mes:fact:task:S06-D-T01:post-fact-recovery-1',
        'mes:fact:result:S06:S06-D-T01:post-fact-recovery-1',
        'mes:fact:result:S06:S06-D:slice-ready:post-fact-recovery-1',
        'mes:fact:git:S06:S06-D:integration:post-fact-recovery-1',
        'mes:fact:git:S06:S06-D:cleanup:post-fact-recovery-1',
      ];
      for (const id of misboundWorkTaskResultGit) {
        assert.ok(afterById.has(id), `misbound fact ${id} must be retained in source (audit: misbound facts retained in source)`);
      }

      // Idempotent replay stays byte-stable (the baseline fact is retained
      // across later snapshot replacement/restart; no second epoch).
      const afterFirst = snapshotBytes().toString('utf8');
      store.write([baseline]);
      assert.equal(snapshotBytes().toString('utf8'), afterFirst, 'identical current-incident replay must be byte-stable');
    } finally {
      fixture.cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (S06-R-G-T01) source-incident-identity-binding: canonical source-incident
// identity binding closure. The authoritative source-incident identity is
// resolved from the observed source's EXISTING durable recovery_baseline
// facts (fact_id/recovery_id embedded incident identity), never from the
// candidate incident's self-declared fields: the candidate
// source_incident_ref is only a root-bound candidate pointer whose
// resolution must EXACTLY match one canonical durable recovery_baseline
// fact, whose forensic_ref identity and source_snapshot_sha256 /
// source_fact_count are the binding basis. Missing / ambiguous /
// disagreeing / duplicate evidence fails closed no-write byte-stable
// (contracts §2.1.3 / §2.2.4a / E2E-24/25, ADR-021/022).
describe('source-incident identity canonical binding closure (S06-R-G-T01)', () => {
  test('writes when the candidate source_incident_ref exactly matches one durable recovery_baseline fact in the observed source (canonical identity resolution), retains it across restart and replays idempotently', () => {
    const s = seedCurrentIncidentFixture();
    try {
      const baseline = recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID);
      s.store.write([baseline]);
      const afterFacts = new MesSnapshotStore(s.fixture.dir).read();
      assert.equal(afterFacts.length, s.sourceCount + 1);
      assert.ok(afterFacts.some((fact) => fact.fact_kind === 'recovery_baseline'));
      assert.ok(afterFacts.some((fact) => fact.fact_id === durableSourceIncidentBaselineFact().fact_id), 'the durable source-incident recovery_baseline fact must stay retained in the observed source');
      const afterFirst = s.snapshotBytes();
      s.store.write([baseline]);
      assert.equal(s.snapshotBytes(), afterFirst, 'identical canonical-identity replay must be byte-stable');
      assert.ok(new MesSnapshotStore(s.fixture.dir).read().some((fact) => fact.fact_kind === 'recovery_baseline'));
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects a candidate source-incident identity missing from the observed durable recovery_baseline facts no-write (omitDurableBaseline)', () => {
    const s = seedCurrentIncidentFixture({ omitDurableBaseline: true });
    try {
      const before = s.snapshotBytes();
      assert.throws(
        () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
        /not recorded by any durable recovery_baseline fact/
      );
      assert.equal(s.snapshotBytes(), before, 'missing canonical identity must be no-write byte-stable');
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects more than one durable recovery_baseline fact matching the identity no-write (duplicateDurableBaseline ambiguity)', () => {
    const s = seedCurrentIncidentFixture({ duplicateDurableBaseline: true });
    try {
      const before = s.snapshotBytes();
      assert.throws(
        () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
        /ambiguous canonical source-incident identity/
      );
      assert.equal(s.snapshotBytes(), before, 'ambiguous canonical identity must be no-write byte-stable');
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects an unreadable canonical recovery_baseline forensic_ref no-write (missing canonicalized source incident)', () => {
    const s = seedCurrentIncidentFixture({
      durableBaselineOverride: (baseline) => ({ ...baseline, forensic_ref: '.proofloop/forensics/recovery/missing-canonicalized.json' }),
    });
    try {
      const before = s.snapshotBytes();
      assert.throws(
        () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
        /not re-readable/
      );
      assert.equal(s.snapshotBytes(), before, 'unreadable canonical forensic_ref must be no-write byte-stable');
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects a canonical recovery_baseline forensic_ref whose incident identity disagrees no-write (canonicalizedIncidentOverride)', () => {
    const s = seedCurrentIncidentFixture({
      canonicalizedIncidentOverride: (incident) => ({ ...incident, incident_id: 'MES-RECOVERY-ALTERNATE-EPOCH-001' }),
    });
    try {
      const before = s.snapshotBytes();
      assert.throws(
        () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
        /does not equal the candidate source-incident identity/
      );
      assert.equal(s.snapshotBytes(), before, 'disagreeing canonical forensic identity must be no-write byte-stable');
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects canonical source_snapshot_sha256 / source_fact_count disagreement with the candidate source incident no-write (wrong equality / wrong version)', () => {
    const cases: Array<{ label: string; override: (baseline: MesFactEnvelope) => MesFactEnvelope }> = [
      {
        label: 'canonical source_snapshot_sha256 disagrees',
        override: (baseline) => ({ ...baseline, source_snapshot_sha256: 'f'.repeat(64) }),
      },
      {
        label: 'canonical source_fact_count disagrees',
        override: (baseline) => ({ ...baseline, source_fact_count: (baseline.source_fact_count ?? 0) + 1 }),
      },
    ];
    for (const { label, override } of cases) {
      const s = seedCurrentIncidentFixture({ durableBaselineOverride: override });
      try {
        const before = s.snapshotBytes();
        assert.throws(
          () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
          /does not match the candidate source incident declared source_snapshot/,
          label
        );
        assert.equal(s.snapshotBytes(), before, `${label} must be no-write byte-stable`);
      } finally {
        s.fixture.cleanup();
      }
    }
  });

  test('rejects a distinct but fully valid alternate source-capture incident no-write byte-stable (identity not durably recorded)', () => {
    const s = seedCurrentIncidentFixture({
      sourceIncidentOverride: (incident) => ({
        ...incident,
        incident_id: 'MES-RECOVERY-ALTERNATE-CAPTURE-001',
      }),
    });
    try {
      const before = s.snapshotBytes();
      assert.throws(
        () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
        /not recorded by any durable recovery_baseline fact/
      );
      assert.equal(s.snapshotBytes(), before, 'alternate-valid source capture must be no-write byte-stable');
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects duplicate durable source fact_id in the complete observed source no-write (byte-identical and conflicting-payload cases)', () => {
    const cases: Array<{ label: string; extra: MesFactEnvelope[]; match: RegExp }> = [
      {
        label: 'byte-identical duplicate fact_id',
        extra: [planningFact(), planningFact()],
        match: /duplicate fact-id evidence/
      },
      {
        label: 'conflicting-payload duplicate fact_id',
        extra: [planningFact(), { ...planningFact(), plan_binding: { binding_stage: 'candidate', candidate_plan_ref: 'delivery/stages/S05/plan.md', accepted_plan_ref: null, verdict: 'BLOCKED', plan_digest: 'a'.repeat(64) } }],
        match: /duplicate fact-id evidence/
      },
    ];
    for (const { label, extra, match } of cases) {
      const s = seedCurrentIncidentFixture({ extraSourceFacts: extra });
      try {
        const before = s.snapshotBytes();
        assert.throws(
          () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
          match,
          label
        );
        assert.equal(s.snapshotBytes(), before, `${label} must be no-write byte-stable`);
      } finally {
        s.fixture.cleanup();
      }
    }
  });

  test('rejects a raw durable recovery_baseline fact whose fact_id does not embed its own recovery_id no-write byte-stable (malformed raw fact_id/recovery_id identity)', () => {
    const s = seedCurrentIncidentFixture({
      durableBaselineOverride: (baseline) => ({ ...baseline, fact_id: 'mes:fact:recovery_baseline:MES-RECOVERY-OTHER-001' }),
    });
    try {
      const before = s.snapshotBytes();
      assert.throws(
        () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
        /malformed raw durable recovery_baseline fact_id\/recovery_id identity/
      );
      assert.equal(s.snapshotBytes(), before, 'malformed raw fact_id/recovery_id identity must be no-write byte-stable');
    } finally {
      s.fixture.cleanup();
    }
  });

  test('rejects a canonical fact_id/recovery_id pair identifying different recovery identities no-write byte-stably (recovery_id disagrees with the fact_id-embedded identity)', () => {
    const s = seedCurrentIncidentFixture({
      durableBaselineOverride: (baseline) => ({ ...baseline, recovery_id: 'MES-RECOVERY-OTHER-001' }),
    });
    try {
      const before = s.snapshotBytes();
      assert.throws(
        () => s.store.write([recoveryFact(s.sourceSha, s.sourceCount, s.refs, s.basis, CURRENT_INCIDENT_ID)]),
        /malformed raw durable recovery_baseline fact_id\/recovery_id identity/
      );
      assert.equal(s.snapshotBytes(), before, 'mismatched canonical identity pair must be no-write byte-stably');
    } finally {
      s.fixture.cleanup();
    }
  });
});
