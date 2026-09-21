/**
 * MES public-surface tests (S01-C-T02).
 *
 * # PO: PO-S01-C-03, PO-S01-C-04, PO-S01-C-06, PO-S01-C-07
 *
 * Exercises the assembled Runtime MES seam and the read-only `proofloop
 * status` observation surface on packages/runtime/src/cli/proofloop.ts:
 *   - Runtime consumers can import the MES seam (schema/validate/store/
 *     binding/bootstrap/status via `mes/index` and the runtime root export)
 *     WITHOUT bypassing the fail-closed validator and WITHOUT adding a CLI
 *     domain to the closed registry (PO-S01-C-03);
 *   - the current mechanical public surface (closed domain registry,
 *     `boundary close` routing, canonical envelope/exit contract) is
 *     preserved (PO-S01-C-04);
 *   - `proofloop status [--detail]` (human-readable) and
 *     `proofloop status --json [--detail]` (structured) expose the SAME
 *     read-only seeded projection through the existing public CLI
 *     (PO-S01-C-06);
 *   - status fails closed on a missing / corrupt / not-fully-seeded root-
 *     bound store and on unknown CLI input, never writes facts, and never
 *     emits next_action / route / reasoning (PO-S01-C-07).
 *
 * All tests use only temporary Git fixtures (helpers.ts#makeFixture) and
 * never the work clone's Git state. Imports the compiled runtime dist
 * (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  proofloopCli,
  CLI_EXIT,
  CANONICAL_DOMAINS,
  DOMAIN_REGISTRY,
  seedMesBootstrap,
  readMesSeedRecord,
  isMesSeeded,
  projectSparseStatus,
  projectDetailStatus,
  validateMesFactEnvelope,
  SchemaValidationError,
  MES_SEED_REL,
} from '../dist/index';
import { MesSnapshotStore, MES_SNAPSHOT_REL } from '../dist/mes/store';
import type { MesFactEnvelope } from '../dist/mes/types';
import { MES_ANOMALY_COUNTERS, MES_FACT_KINDS } from '../dist/mes';
import { makeFixture, commitAll, porcelain, sha } from './helpers';
import {
  CanonicalProjectMesObservationError,
  observeCanonicalProjectArtifact,
  resolveCanonicalProjectRoot,
  sha256OfBytes,
} from './fixtures/e2e25';

const PLAN_REF = 'delivery/stages/S01/plan.md';
const DIGEST = sha('plan-v1');

/**
 * The REAL S05 forensic capture (canonical root `.proofloop/forensics/**`) and
 * the identity its immutable incident record carries — the expected values for
 * the read-only canonical-root observations below.
 */
const REAL_FORENSIC_REL = '.proofloop/forensics/mes-recovery-20260910';
const REAL_SNAPSHOT_SHA = '0b9a0583e4e8c39089eb82453a87e165f0f1add482696eb865355a841432d956';
const REAL_SNAPSHOT_COUNT = 67;
const REAL_AUDIT_SHA = '9d4f67ba4c2bd41f49e32a1fabb4920155a24b00d34fce7b6911c8183f6be82c';

function fixtureRoot(): { fixture: ReturnType<typeof makeFixture>; dir: string; cleanup(): void; head: string; branch: string } {
  const fixture = makeFixture();
  const head = commitAll(fixture, 'baseline');
  return { fixture, dir: fixture.dir, head, branch: 'master', cleanup: fixture.cleanup };
}
function seedStore(dir: string, head: string, branch: string): void {
  seedMesBootstrap(dir, {
    authority_refs: ['PRD.md#FR-003', 'tech-spec/contracts.md#2.2.1'],
    accepted_plan_ref: PLAN_REF,
    plan_digest: DIGEST,
    git_basis: { head, branch, worktree: '.' },
    status: {
      scope: 'S01',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
      counters: { replan: 0, blocked: 1, finding: 2 },
    },
  });
}

interface CliRun {
  readonly exit: number;
  readonly lines: string[];
}

/** Run the public CLI and capture the emitted envelope line(s). */
function runCli(argv: readonly string[], opts: { cwd: string }): CliRun {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    const exit = proofloopCli([...argv], { cwd: opts.cwd });
    return { exit, lines: logs };
  } finally {
    console.log = original;
  }
}

/** Parse the single canonical envelope line emitted by a CLI run. */
function parseEnvelope(run: CliRun): Record<string, unknown> {
  assert.equal(run.lines.length, 1, 'exactly one envelope line must be emitted');
  return JSON.parse(run.lines[0]) as Record<string, unknown>;
}

function commandOf(envelope: Record<string, unknown>): { domain: string | null; operation: string | null } {
  const command = envelope.command as Record<string, unknown>;
  return {
    domain: (command.domain as string | null) ?? null,
    operation: (command.operation as string | null) ?? null,
  };
}

function resultOf(envelope: Record<string, unknown>): unknown {
  return envelope.result;
}

function findingsOf(envelope: Record<string, unknown>): { code: string }[] {
  return (envelope.findings as { code: string; message: string }[]).map((finding) => ({
    code: finding.code,
  }));
}

/** Flatten all object keys (including nested) for routing-field scans. */
function allKeys(value: unknown, root = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    root ? `${root}.${key}` : key,
    ...allKeys(entry, root ? `${root}.${key}` : key),
  ]);
}

describe('MES public surface + proofloop status (S01-C-T02)', () => {
  test('exports the MES seam without adding a CLI domain', () => {
    // The full S01 seam is importable from the runtime root AND from the
    // mes/index entry: schema/validate/store/binding/bootstrap/status.
    assert.equal(typeof projectSparseStatus, 'function');
    assert.equal(typeof projectDetailStatus, 'function');
    assert.equal(typeof seedMesBootstrap, 'function');
    assert.equal(typeof readMesSeedRecord, 'function');
    assert.equal(typeof validateMesFactEnvelope, 'function');
    assert.ok(MES_ANOMALY_COUNTERS.includes('blocked'));
    assert.ok(MES_FACT_KINDS.includes('plan_binding'));

    // The validator is NOT bypassed through the public seam: malformed /
    // unknown-kind / non-Brain envelopes fail closed.
    assert.throws(
      () =>
        validateMesFactEnvelope({
          schema_version: 2,
          fact_id: 'mes:fact:evil',
          fact_kind: 'does-not-exist',
          created_by: 'agent',
        }),
      SchemaValidationError,
    );

    // No CLI domain was added: status is a top-level observation entry, NOT
    // part of the closed domain registry.
    assert.deepEqual(CANONICAL_DOMAINS, ['boundary', 'integration']);
    assert.deepEqual(DOMAIN_REGISTRY.boundary.operations, ['close']);
    assert.deepEqual(DOMAIN_REGISTRY.integration.operations, ['apply']);
    assert.equal((CANONICAL_DOMAINS as readonly string[]).includes('status'), false);

    // `proofloop status` routes through the existing public dispatcher with
    // its own top-level command identity (no registry entry).
    const fixture = fixtureRoot();
    try {
      seedStore(fixture.dir, fixture.head, fixture.branch);
      const run = runCli(['status'], { cwd: fixture.dir });
      assert.equal(run.exit, CLI_EXIT.OK);
      const envelope = parseEnvelope(run);
      assert.equal(envelope.ok, true);
      assert.deepEqual(commandOf(envelope), { domain: 'status', operation: null });

      // Unknown domains still fail closed against the closed registry.
      const unknown = runCli(['nope', 'x'], { cwd: fixture.dir });
      assert.equal(unknown.exit, CLI_EXIT.BLOCKED);
      assert.equal(parseEnvelope(unknown).ok, false);
    } finally {
      fixture.cleanup();
    }
  });

  test('preserves the current mechanical public surface', () => {
    const fixture = fixtureRoot();
    try {
      // Closed command matrix unchanged.
      assert.deepEqual(CANONICAL_DOMAINS, ['boundary', 'integration']);

      // `boundary close` still routes through the mechanical boundary adapter
      // and keeps its fail-closed behavior (slice-output requires
      // expected_head → REQUEST_INVALID, no Git work, no write).
      const payload = JSON.stringify({ boundary_type: 'slice-output' });
      const run = runCli(['boundary', 'close', '--json', payload, '--project-root', fixture.dir], {
        cwd: fixture.dir,
      });
      assert.equal(run.exit, CLI_EXIT.BLOCKED);
      const envelope = parseEnvelope(run);
      assert.deepEqual(commandOf(envelope), { domain: 'boundary', operation: 'close' });
      assert.deepEqual(findingsOf(envelope), [{ code: 'BOUNDARY.REQUEST_INVALID' }]);
      assert.equal(porcelain(fixture.fixture), '', 'boundary refusal must leave the worktree/index untouched');

      // The global exit contract still maps structured refusals to exit 2.
      const unknown = runCli(['boundary', 'wat'], { cwd: fixture.dir });
      assert.equal(unknown.exit, CLI_EXIT.BLOCKED);
      assert.equal(parseEnvelope(unknown).ok, false);
    } finally {
      fixture.cleanup();
    }
  });

  test('invokes human-readable and JSON status through the public CLI', () => {
    const fixture = fixtureRoot();
    try {
      seedStore(fixture.dir, fixture.head, fixture.branch);

      // Human-readable primary projection (default form).
      const human = runCli(['status'], { cwd: fixture.dir });
      assert.equal(human.exit, CLI_EXIT.OK);
      const humanEnvelope = parseEnvelope(human);
      assert.equal(humanEnvelope.ok, true);
      const text = String(resultOf(humanEnvelope));
      assert.ok(text.startsWith('S01 / EXECUTE\nskill=proofloop-execute'), text);
      assert.ok(text.includes('blocked=1'), text);
      assert.ok(text.includes('finding=2'), text);
      assert.ok(!text.includes('replan=0'), 'zero counters never rendered');

      // Same read-only facts as a structured projection via `--json`.
      const json = runCli(['status', '--json'], { cwd: fixture.dir });
      assert.equal(json.exit, CLI_EXIT.OK);
      const jsonEnvelope = parseEnvelope(json);
      const structured = resultOf(jsonEnvelope) as Record<string, unknown>;
      assert.equal(structured.scope, 'S01');
      assert.equal(structured.phase, 'EXECUTE');
      assert.equal(structured.required_skill, 'proofloop-execute');
      assert.deepEqual(structured.counters, { blocked: 1, finding: 2 });

      // Bounded detail: human-readable adds the durable Git/Plan detail.
      const detail = runCli(['status', '--detail'], { cwd: fixture.dir });
      assert.equal(detail.exit, CLI_EXIT.OK);
      const detailText = String(resultOf(parseEnvelope(detail)));
      assert.ok(detailText.includes(`git_head=${fixture.head}`), detailText);
      assert.ok(detailText.includes('git_branch=master'), detailText);
      assert.ok(detailText.includes(`accepted_plan_ref=${PLAN_REF}`), detailText);
      assert.ok(detailText.includes(`plan_digest=${DIGEST}`), detailText);

      // Bounded detail as structured projection (flag order independent).
      for (const argv of [
        ['status', '--json', '--detail'],
        ['status', '--detail', '--json'],
      ]) {
        const run = runCli(argv, { cwd: fixture.dir });
        assert.equal(run.exit, CLI_EXIT.OK);
        const detailStructured = resultOf(parseEnvelope(run)) as Record<string, unknown>;
        assert.equal(detailStructured.scope, 'S01');
        assert.equal(detailStructured.phase, 'EXECUTE');
        assert.equal(detailStructured.required_skill, 'proofloop-execute');
        assert.deepEqual(detailStructured.counters, { blocked: 1, finding: 2 });
        assert.deepEqual(detailStructured.git_basis, {
          head: fixture.head,
          branch: fixture.branch,
          worktree: '.',
        });
        assert.equal(detailStructured.accepted_plan_ref, PLAN_REF);
        assert.equal(detailStructured.plan_digest, DIGEST);
      }

      // Both forms are deterministic across invocations.
      assert.equal(
        String(resultOf(parseEnvelope(runCli(['status'], { cwd: fixture.dir })))),
        text,
        'human status must be deterministic',
      );
      assert.equal(
        runCli(['status', '--json'], { cwd: fixture.dir }).lines[0],
        json.lines[0],
        'JSON status envelope must be byte-deterministic',
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('fails closed without mutation or routing fields', () => {
    // Missing store (no seed facts at all): structured refusal, exit 2, and
    // NOTHING is created on disk.
    const unseeded = fixtureRoot();
    try {
      const run = runCli(['status'], { cwd: unseeded.dir });
      assert.equal(run.exit, CLI_EXIT.BLOCKED);
      assert.equal(parseEnvelope(run).ok, false);
      assert.equal(fs.existsSync(path.join(unseeded.dir, '.proofloop')), false, 'no store may be created');
    } finally {
      unseeded.cleanup();
    }

    const fixture = fixtureRoot();
    try {
      seedStore(fixture.dir, fixture.head, fixture.branch);
      const durableBefore = fs.readFileSync(path.join(fixture.dir, MES_SEED_REL), 'utf8');
      const factsBefore = new MesSnapshotStore(fixture.dir).read();
      assert.equal(isMesSeeded(fixture.dir), true);

      // Corrupt seed record: fail closed, no partial status.
      fs.writeFileSync(path.join(fixture.dir, MES_SEED_REL), '{ not json', 'utf8');
      for (const argv of [['status'], ['status', '--json'], ['status', '--detail']]) {
        const run = runCli(argv, { cwd: fixture.dir });
        assert.equal(run.exit, CLI_EXIT.BLOCKED, `${argv.join(' ')} must fail closed on corrupt seed`);
        assert.equal(parseEnvelope(run).ok, false);
      }
      // Restore the durable seed record for the remaining checks.
      fs.writeFileSync(path.join(fixture.dir, MES_SEED_REL), durableBefore, 'utf8');

      // Seed record present but snapshot facts missing (crash state): not
      // fully seeded → fail closed, do not project.
      fs.rmSync(path.join(fixture.dir, MES_SNAPSHOT_REL), { force: true });
      const crash = runCli(['status'], { cwd: fixture.dir });
      assert.equal(crash.exit, CLI_EXIT.BLOCKED);
      assert.equal(isMesSeeded(fixture.dir), false);
      // Restore the snapshot (idempotent re-seed repairs the crash state) so
      // the remaining no-mutation assertions run against a fully seeded store.
      seedStore(fixture.dir, fixture.head, fixture.branch);
      assert.equal(isMesSeeded(fixture.dir), true);

      // Unknown CLI input: unknown flag → usage exit 1.
      const unknownFlag = runCli(['status', '--wat'], { cwd: fixture.dir });
      assert.equal(unknownFlag.exit, CLI_EXIT.USAGE);

      // A parsed --stage is a scope assertion for mechanical commands, but
      // status has no scope selector and must refuse it rather than project
      // whichever seeded Stage happens to be present.
      const scoped = runCli(['status', '--stage', 'S02'], { cwd: fixture.dir });
      assert.equal(scoped.exit, CLI_EXIT.BLOCKED);
      const scopedEnvelope = parseEnvelope(scoped);
      assert.equal(scopedEnvelope.ok, false);
      assert.deepEqual(findingsOf(scopedEnvelope), [{ code: 'RUNTIME.INPUT_INVALID' }]);
      assert.equal(scopedEnvelope.result, null, 'status --stage must not return another scope');

      // Extra positional → schema mismatch exit 2; inline input mode for the
      // read-only entry → INPUT_INVALID exit 2.
      const extra = runCli(['status', 'extra'], { cwd: fixture.dir });
      assert.equal(extra.exit, CLI_EXIT.BLOCKED);
      const extraEnvelope = parseEnvelope(extra);
      assert.equal((extraEnvelope.findings as { code: string }[])[0].code, 'RUNTIME.SCHEMA_MISMATCH');
      const inline = runCli(['status', '--json', JSON.stringify({ a: 1 })], { cwd: fixture.dir });
      assert.equal(inline.exit, CLI_EXIT.BLOCKED);

      // Status is read-only: the durable seed record and snapshot facts are
      // byte-for-byte unchanged by every invocation above.
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SEED_REL), 'utf8'), durableBefore);
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), factsBefore, 'snapshot facts must be unchanged');
    } finally {
      fixture.cleanup();
    }

    // Routing fields never appear in ANY status output form, and the pure
    // projections imported through the public seam reject them.
    const seeded = fixtureRoot();
    try {
      seedStore(seeded.dir, seeded.head, seeded.branch);
      const repo = seeded.dir;
      void repo;
      for (const argv of [['status'], ['status', '--json'], ['status', '--detail'], ['status', '--json', '--detail']]) {
        const envelope = parseEnvelope(runCli(argv, { cwd: seeded.dir }));
        const value = resultOf(envelope);
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        assert.ok(!rendered.includes('next_action'), `${argv.join(' ')} renders no next_action`);
        assert.ok(!rendered.includes('route=') && !rendered.includes('"route"'), `${argv.join(' ')} renders no route`);
        assert.ok(!rendered.includes('reasoning'), `${argv.join(' ')} renders no reasoning`);
        assert.equal(allKeys(value).some((key) => key === 'next_action' || key.includes('@next')), false);
        assert.equal(allKeys(value).some((key) => key === 'route' || key === 'reasoning'), false);
      }
    } finally {
      seeded.cleanup();
    }
  });

  test('projects cycle-filtered status through the public CLI after a legal recovery baseline without backfilling seed facts (S05-C-T02 / PO-S05-C-03)', () => {
    // The REAL S05 MES incident capture (67 retained facts, forensic
    // incident + read-only relational audit) is copied read-only into the
    // fixture; a legal recovery baseline is written at the current observed
    // Git basis; then the current NORMAL cycle facts (PVR/PA) are written.
    // The one-time seed record is NEVER written — `proofloop status` must
    // still observe the current cycle from the durable facts alone (no
    // seed reconstruction, no PRE_MES_BOOTSTRAP revival).
    const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
    const S05_PLAN = 'delivery/stages/S05/plan.md';
    const S05_DIGEST = sha('s05-recovery-plan-v1');
    // Distinct fact ids from the retained 67 (which already carry a forensic
    // `mes:fact:planning_verification_result:S05:1` FINDINGS — history-only).
    const PVR_REF = 'mes:result:S05:planning-verification-cycle-1';

    const fixture = makeFixture();
    try {
      const copyReal = (name: string, rel: string): void => {
        const target = path.join(fixture.dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, observeCanonicalProjectArtifact(`${REAL_FORENSIC_REL}/${name}`).bytes);
      };
      copyReal('snapshot-67.json', MES_SNAPSHOT_REL);
      copyReal('incident.json', `${REAL_FORENSIC_REL}/incident.json`);
      copyReal('relational-audit-67.json', `${REAL_FORENSIC_REL}/relational-audit-67.json`);
      fixture.write('delivery/stages/S05/plan.md', '# recovery plan marker\n');
      commitAll(fixture, 'recovery basis');
      const basis = {
        head: fixture.run(['rev-parse', 'HEAD']).trim(),
        branch: fixture.run(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
        worktree: '.',
      };
      const store = new MesSnapshotStore(fixture.dir);
      assert.equal(store.read().length, REAL_SNAPSHOT_COUNT, 'the real partial snapshot must rehydrate as exactly 67 facts');

      // Legal recovery baseline (digests/refs must match the real capture).
      const baseline: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:recovery_baseline:MES-RECOVERY-20260910-S05-001-r1',
        fact_kind: 'recovery_baseline',
        created_by: 'brain',
        authority_refs: ['tech-spec/architecture.md#/entities/mes-disaster-rebaseline', 'tech-spec/acceptance.md#E2E-24'],
        recovery_id: 'MES-RECOVERY-20260910-S05-001-r1',
        preimage_status: 'UNRECOVERABLE',
        source_snapshot_sha256: REAL_SNAPSHOT_SHA,
        source_fact_count: REAL_SNAPSHOT_COUNT,
        forensic_ref: `${REAL_FORENSIC_REL}/incident.json`,
        audit_ref: `${REAL_FORENSIC_REL}/relational-audit-67.json`,
        audit_sha256: REAL_AUDIT_SHA,
        git_basis: basis,
      };
      store.write([baseline]);
      assert.equal(store.read().length, REAL_SNAPSHOT_COUNT + 1, 'retained facts + recovery baseline');

      // Current NORMAL cycle facts (S05 PVR PLAN_READY + PA, same cycle).
      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:cycle-1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: PVR_REF,
        verifier_role: 'stage-plan-verifier',
        action_token: 's05-spv-1',
        plan_binding: {
          binding_stage: 'candidate' as const,
          candidate_plan_ref: S05_PLAN,
          accepted_plan_ref: null,
          verdict: 'PLAN_READY' as const,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: basis,
      };
      const pa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S05:cycle-1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: {
          binding_stage: 'accepted' as const,
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: PVR_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: basis,
      };
      store.write([pvr, pa]);
      assert.equal(store.read().length, REAL_SNAPSHOT_COUNT + 3, '67 retained + baseline + pvr + pa');
      const durableAfter = store.read();

      // Human-readable status: cycle-filtered from durable facts.
      const human = runCli(['status'], { cwd: fixture.dir });
      assert.equal(human.exit, CLI_EXIT.OK);
      const humanEnvelope = parseEnvelope(human);
      assert.equal(humanEnvelope.ok, true);
      const text = String(resultOf(humanEnvelope));
      assert.ok(text.startsWith('S05 / PLANNING'), text);
      assert.ok(text.includes('skill=proofloop-plan'), text);

      // Structured status: same cycle-filtered facts.
      const json = runCli(['status', '--json'], { cwd: fixture.dir });
      assert.equal(json.exit, CLI_EXIT.OK);
      const structured = resultOf(parseEnvelope(json)) as Record<string, unknown>;
      assert.equal(structured.scope, 'S05');
      assert.equal(structured.phase, 'PLANNING');
      assert.equal(structured.required_skill, 'proofloop-plan');

      // Bounded detail: the durable binding facts carry the Git/Plan detail.
      const detail = runCli(['status', '--detail'], { cwd: fixture.dir });
      assert.equal(detail.exit, CLI_EXIT.OK);
      const detailText = String(resultOf(parseEnvelope(detail)));
      assert.ok(detailText.includes(`accepted_plan_ref=${S05_PLAN}`), detailText);
      assert.ok(detailText.includes(`plan_digest=${S05_DIGEST}`), detailText);
      assert.ok(detailText.includes(`git_head=${basis.head}`), detailText);
      assert.ok(detailText.includes('candidate_plan_ref='), detailText);
      assert.ok(detailText.includes('planning_verification_result_ref='), detailText);

      // No routing / next-action / reasoning anywhere.
      for (const forbidden of ['next_action', 'route=', '"route"', 'reasoning']) {
        assert.ok(!text.includes(forbidden) && !detailText.includes(forbidden), `no ${forbidden} in status output`);
      }

      // NO seed reconstruction: the status read never backfills the missing
      // seed record and never touches the durable snapshot facts.
      assert.equal(fs.existsSync(path.join(fixture.dir, MES_SEED_REL)), false, 'status must not backfill the missing seed record');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), durableAfter, 'snapshot facts must be byte-unchanged by status');
    } finally {
      fixture.cleanup();
    }
  });

  test('real S05 forensic capture is observed through the canonical project/trust root', () => {
    const canonicalRoot = resolveCanonicalProjectRoot();
    const observed = observeCanonicalProjectArtifact(`${REAL_FORENSIC_REL}/snapshot-67.json`);

    // The canonical root is the repository owning the common `.git` directory
    // (the linked Slice worktree itself carries no forensic capture at all).
    assert.equal(observed.root, canonicalRoot);
    assert.equal(observed.path, path.join(canonicalRoot, REAL_FORENSIC_REL, 'snapshot-67.json'));
    assert.ok(fs.existsSync(path.join(canonicalRoot, '.proofloop', 'forensics')));

    // The observed bytes ARE the real capture: they equal the identity carried
    // by the immutable incident record.
    assert.equal(observed.sha256, REAL_SNAPSHOT_SHA);
    const parsed = JSON.parse(observed.bytes.toString('utf8')) as { facts?: unknown[] };
    assert.equal(parsed.facts?.length, REAL_SNAPSHOT_COUNT);
    assert.equal(observeCanonicalProjectArtifact(`${REAL_FORENSIC_REL}/relational-audit-67.json`).sha256, REAL_AUDIT_SHA);
  });

  test('canonical S05 capture observation never falls back to a worktree-local copy', () => {
    const primary = makeFixture();
    const linked = path.join(primary.dir, '.proofloop', 'worktrees', 'decoy-linked');
    try {
      primary.write('seed.txt', 'seed\n');
      commitAll(primary, 'seed');
      fs.mkdirSync(path.dirname(linked), { recursive: true });
      primary.run(['worktree', 'add', '--detach', linked]);

      // The canonical (primary root) copy carries the REAL capture bytes; the
      // LINKED worktree carries a divergent copy at its own local root.
      const canonicalDir = path.join(primary.dir, REAL_FORENSIC_REL);
      fs.mkdirSync(canonicalDir, { recursive: true });
      fs.writeFileSync(
        path.join(canonicalDir, 'snapshot-67.json'),
        observeCanonicalProjectArtifact(`${REAL_FORENSIC_REL}/snapshot-67.json`).bytes,
      );
      const decoyDir = path.join(linked, REAL_FORENSIC_REL);
      fs.mkdirSync(decoyDir, { recursive: true });
      const decoyBytes = Buffer.from('{"facts":[]}\n', 'utf8');
      fs.writeFileSync(path.join(decoyDir, 'snapshot-67.json'), decoyBytes);

      const observed = observeCanonicalProjectArtifact(`${REAL_FORENSIC_REL}/snapshot-67.json`, linked);
      assert.equal(observed.root, primary.dir);
      assert.equal(observed.sha256, REAL_SNAPSHOT_SHA, 'the canonical capture bytes, never the decoy');
      const parsed = JSON.parse(observed.bytes.toString('utf8')) as { facts?: unknown[] };
      assert.equal(parsed.facts?.length, REAL_SNAPSHOT_COUNT);
      assert.notEqual(observed.sha256, sha256OfBytes(decoyBytes));
      assert.ok(!observed.path.startsWith(`${linked}${path.sep}`));

      // With the canonical capture absent, observation fails closed typed
      // instead of silently reading the worktree-local copy.
      fs.rmSync(canonicalDir, { recursive: true, force: true });
      assert.throws(
        () => observeCanonicalProjectArtifact(`${REAL_FORENSIC_REL}/snapshot-67.json`, linked),
        (error: unknown) => error instanceof CanonicalProjectMesObservationError,
      );
      assert.deepEqual(fs.readFileSync(path.join(decoyDir, 'snapshot-67.json')), decoyBytes, 'the decoy is never a mutation target');
    } finally {
      primary.cleanup();
    }
  });

  test('projects the CURRENT durable cycle-filtered status through the public CLI when a seeded store also contains a newer legal NORMAL cycle, never the stale seed tuple (PO-S05-C-03)', () => {
    // A SEEDED store (S01-era bootstrap tuple) that afterwards also carries a
    // newer legal NORMAL cycle (S05 PVR/PA with the same opaque
    // delivery_cycle_id) must project the CURRENT cycle-filtered status from
    // the durable facts — never the stale seedRecord.status. Seeded legacy
    // behavior stays when no newer cycle exists; the read never writes /
    // backfills and keeps the structured envelope contract.
    const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
    const S05_PLAN = 'delivery/stages/S05/plan.md';
    const S05_DIGEST = sha('s05-seeded-cycle-plan-v1');
    const PVR_REF = 'mes:result:S05:planning-verification-seeded-cycle-1';

    const fixture = fixtureRoot();
    try {
      seedStore(fixture.dir, fixture.head, fixture.branch);
      assert.equal(isMesSeeded(fixture.dir), true);

      // Purely-seeded legacy behavior first: the seed tuple is projected.
      const legacyRun = runCli(['status', '--json'], { cwd: fixture.dir });
      assert.equal(legacyRun.exit, CLI_EXIT.OK);
      const legacyProjection = resultOf(parseEnvelope(legacyRun)) as Record<string, unknown>;
      assert.equal(legacyProjection.scope, 'S01');
      assert.equal(legacyProjection.phase, 'EXECUTE');

      // The durable store now also carries a NEWER legal NORMAL cycle:
      // resubmit the seed-owned facts byte-identically (they stay durable and
      // seeded) together with the fresh S05 PVR/PA of the same cycle.
      const store = new MesSnapshotStore(fixture.dir);
      const seededFacts = store.read();
      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:seeded-cycle-1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: PVR_REF,
        verifier_role: 'stage-plan-verifier',
        action_token: 's05-spv-1',
        plan_binding: {
          binding_stage: 'candidate' as const,
          candidate_plan_ref: S05_PLAN,
          accepted_plan_ref: null,
          verdict: 'PLAN_READY' as const,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      };
      const pa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S05:seeded-cycle-1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: {
          binding_stage: 'accepted' as const,
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: PVR_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      };
      store.write([...seededFacts, pvr, pa]);
      assert.equal(isMesSeeded(fixture.dir), true, 'the seed-owned facts stay durable byte-identically');

      // The public status must now project the CURRENT durable cycle-filtered
      // status, never the stale S01/EXECUTE seed tuple.
      const human = runCli(['status'], { cwd: fixture.dir });
      assert.equal(human.exit, CLI_EXIT.OK);
      const humanText = String(resultOf(parseEnvelope(human)));
      assert.ok(humanText.startsWith('S05 / PLANNING'), humanText);
      assert.ok(humanText.includes('skill=proofloop-plan'), humanText);

      const json = runCli(['status', '--json'], { cwd: fixture.dir });
      assert.equal(json.exit, CLI_EXIT.OK);
      const structured = resultOf(parseEnvelope(json)) as Record<string, unknown>;
      assert.equal(structured.scope, 'S05');
      assert.equal(structured.phase, 'PLANNING');
      assert.equal(structured.required_skill, 'proofloop-plan');

      const detail = runCli(['status', '--detail'], { cwd: fixture.dir });
      assert.equal(detail.exit, CLI_EXIT.OK);
      const detailText = String(resultOf(parseEnvelope(detail)));
      assert.ok(detailText.includes(`accepted_plan_ref=${S05_PLAN}`), detailText);
      assert.ok(detailText.includes(`plan_digest=${S05_DIGEST}`), detailText);
      assert.ok(detailText.includes(`git_head=${fixture.head}`), detailText);
      assert.ok(detailText.includes('candidate_plan_ref='), detailText);
      assert.ok(detailText.includes('planning_verification_result_ref='), detailText);

      // No routing / next-action / reasoning in any form.
      for (const forbidden of ['next_action', 'route=', '"route"', 'reasoning']) {
        assert.ok(!humanText.includes(forbidden) && !detailText.includes(forbidden), `no ${forbidden} in status output`);
      }

      // Read-only: no writes / backfill — seed record and snapshot facts stay
      // byte-unchanged across every status invocation.
      const durableAfter = store.read();
      for (const argv of [['status'], ['status', '--json'], ['status', '--detail'], ['status', '--json', '--detail']]) {
        const run = runCli(argv, { cwd: fixture.dir });
        assert.equal(run.exit, CLI_EXIT.OK, argv.join(' '));
      }
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), durableAfter, 'snapshot facts must be byte-unchanged by status');
    } finally {
      fixture.cleanup();
    }
  });

  test('fails closed with ONE structured RUNTIME.BLOCKED envelope when the snapshot is corrupt but the seed record is valid (EC-1 / CV S05-C-cv-1)', () => {
    const fixture = fixtureRoot();
    try {
      seedStore(fixture.dir, fixture.head, fixture.branch);
      assert.equal(isMesSeeded(fixture.dir), true);

      // Corrupt the SNAPSHOT only (the seed record stays valid):
      // isMesSeeded re-reads the snapshot and fails closed — runStatusDomain
      // must catch it and return ONE structured RUNTIME.BLOCKED envelope
      // (exit 2, ok false) for every status form, never throw.
      const snapshotAbs = path.join(fixture.dir, MES_SNAPSHOT_REL);
      assert.ok(fs.existsSync(snapshotAbs), 'snapshot must exist after seed');
      fs.writeFileSync(snapshotAbs, '{ corrupt snapshot', 'utf8');
      for (const argv of [['status'], ['status', '--json'], ['status', '--detail'], ['status', '--json', '--detail']]) {
        let run;
        assert.doesNotThrow(() => {
          run = runCli(argv, { cwd: fixture.dir });
        }, `${argv.join(' ')} must never throw on a corrupt snapshot`);
        assert.equal(run!.exit, CLI_EXIT.BLOCKED, `${argv.join(' ')} must fail closed`);
        const envelope = parseEnvelope(run!);
        assert.equal(envelope.ok, false);
        assert.deepEqual(
          findingsOf(envelope).map((f) => f.code),
          ['RUNTIME.BLOCKED'],
          `${argv.join(' ')} returns exactly one structured RUNTIME.BLOCKED finding`,
        );
      }

      // The durable store stays untouched by the refusal.
      assert.equal(fs.readFileSync(snapshotAbs, 'utf8'), '{ corrupt snapshot', 'the corrupt snapshot is never rewritten');
    } finally {
      fixture.cleanup();
    }
  });

  test('multi-cycle / chain-tip current-ready consumer fixture: retained closed-cycle facts + historical terminal coexist and the public CLI projects the CURRENT cycle-filtered status + project_terminal adjunct in human/JSON/detail (PO-S06-B-01)', () => {
    // E2E-23 / T10 through the public CLI. A SEEDED store that afterwards
    // carries TWO legal NORMAL cycles built through the durable store write
    // boundary: a retained CLOSED cycle (own PVR/PA + accepted stage + Review
    // result + chain-root terminal) and a NEWER cycle that first stays OPEN
    // (open-cycle precedence / PRE_TERMINAL even when all accepted-stage
    // supports exist) and then closes into a supersedes chain (chain-tip
    // selection → CURRENT_PROJECT_READY with exact tip identity). The public
    // status must project the CURRENT ready truth + project_terminal adjunct
    // in human / JSON / --detail forms, never the stale seed tuple, never a
    // historical terminal, with no writes / backfill / route / next-action.
    const CYCLE_OLD = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
    const CYCLE_NEW = 'cycle-208cbbe8d8e946479bb746f318b56178';
    const PLAN_OLD = 'delivery/stages/S05/plan.md';
    const PLAN_NEW = 'delivery/stages/S06/plan.md';
    const DIGEST_NEW = sha('s06-multi-cycle-plan-v1');
    const BASIS = { head: 'a'.repeat(40), branch: 'v2-herdr', worktree: '.' };

    const pvr = (cycle: string, stage: string, plan: string, tag: string): MesFactEnvelope => ({
      schema_version: 2,
      fact_id: `mes:fact:planning_verification_result:${stage}:${tag}`,
      fact_kind: 'planning_verification_result',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: stage },
      work_id: `mes:work:${stage}:planning:${tag}`,
      result_ref: `mes:result:${stage}:planning-verification-${tag}`,
      verifier_role: 'stage-plan-verifier',
      action_token: `s06-spv-${tag}`,
      plan_binding: {
        binding_stage: 'candidate',
        candidate_plan_ref: plan,
        accepted_plan_ref: null,
        verdict: 'PLAN_READY',
        plan_digest: DIGEST_NEW,
        delivery_cycle_id: cycle,
      },
      git_basis: BASIS,
    });
    const pa = (cycle: string, stage: string, plan: string, tag: string): MesFactEnvelope => ({
      schema_version: 2,
      fact_id: `mes:fact:plan_acceptance:${stage}:${tag}`,
      fact_kind: 'plan_acceptance',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: stage },
      supersedes_plan_acceptance_ref: null,
      plan_binding: {
        binding_stage: 'accepted',
        accepted_plan_ref: plan,
        source_candidate_plan_ref: plan,
        verification_result_ref: `mes:result:${stage}:planning-verification-${tag}`,
        plan_digest: DIGEST_NEW,
        delivery_cycle_id: cycle,
      },
      git_basis: BASIS,
    });
    const support = (cycle: string, stage: string, plan: string, tag: string): MesFactEnvelope => ({
      schema_version: 2,
      fact_id: `mes:fact:stage:${stage}:accepted:${tag}`,
      fact_kind: 'stage',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.1.1'],
      scope: { stage_id: stage },
      plan_binding: {
        binding_stage: 'accepted',
        accepted_plan_ref: plan,
        source_candidate_plan_ref: plan,
        verification_result_ref: `mes:result:${stage}:planning-verification-${tag}`,
        plan_digest: DIGEST_NEW,
        delivery_cycle_id: cycle,
      },
      git_basis: BASIS,
      result_ref: `mes:result:${stage}:stage-review-${tag}`,
    });
    const review = (cycle: string, stage: string, plan: string, tag: string): MesFactEnvelope => ({
      schema_version: 2,
      fact_id: `mes:fact:result:${stage}:stage-review-${tag}`,
      fact_kind: 'result',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.1.1'],
      scope: { stage_id: stage },
      work_id: `mes:work:${stage}:review:${tag}`,
      result_ref: `mes:result:${stage}:stage-review-${tag}`,
      plan_binding: {
        binding_stage: 'accepted',
        accepted_plan_ref: plan,
        source_candidate_plan_ref: plan,
        verification_result_ref: `mes:result:${stage}:planning-verification-${tag}`,
        plan_digest: DIGEST_NEW,
        delivery_cycle_id: cycle,
      },
      git_basis: BASIS,
      result_id: `stage-review-${stage}-${tag}`,
      result_payload_digest: DIGEST_NEW,
    });
    const terminal = (cycle: string, planned: string[], factId: string, supersedes: string | null): MesFactEnvelope => ({
      schema_version: 2,
      fact_id: factId,
      fact_kind: 'project_ready',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
      planned_stage_ids: planned,
      delivery_cycle_id: cycle,
      supersedes_project_ready_ref: supersedes,
      git_basis: BASIS,
    });

    const fixture = fixtureRoot();
    try {
      seedStore(fixture.dir, fixture.head, fixture.branch);
      assert.equal(isMesSeeded(fixture.dir), true);
      const store = new MesSnapshotStore(fixture.dir);

      // Generation 1: the RETAINED CLOSED cycle (S05, cycle-OLD) — PVR/PA +
      // accepted stage + Review result + chain-root terminal (supersedes null).
      // Resubmit the seed-owned facts + the new cohort (the seed facts are
      // not retained by a bare write — same pattern as the S05 seeded-cycle
      // regression: [...seededFacts, ...newFacts]).
      store.write([
        ...store.read(),
        pvr(CYCLE_OLD, 'S05', PLAN_OLD, 'a'),
        pa(CYCLE_OLD, 'S05', PLAN_OLD, 'a'),
        support(CYCLE_OLD, 'S05', PLAN_OLD, 'a'),
        review(CYCLE_OLD, 'S05', PLAN_OLD, 'a'),
        terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old', null),
      ]);

      // Generation 2: the NEWER cycle (S06, cycle-NEW) opens with FULL
      // accepted-stage support but NO terminal yet — it must stay OPEN
      // (open determination = no legal matching terminal, never support
      // completeness) and project PRE_TERMINAL while the retained closed cycle
      // + historical terminal never poison currentness.
      store.write([
        ...store.read(),
        pvr(CYCLE_NEW, 'S06', PLAN_NEW, 'b'),
        pa(CYCLE_NEW, 'S06', PLAN_NEW, 'b'),
        support(CYCLE_NEW, 'S06', PLAN_NEW, 'b'),
        review(CYCLE_NEW, 'S06', PLAN_NEW, 'b'),
      ]);

      // open-cycle precedence: the CURRENT cycle is cycle-NEW (S06); sparse
      // human / JSON forms carry the projection-only project_terminal adjunct
      // (contracts 2.3.1) even WITHOUT --detail.
      const humanOpen = runCli(['status'], { cwd: fixture.dir });
      assert.equal(humanOpen.exit, CLI_EXIT.OK);
      const humanOpenText = String(resultOf(parseEnvelope(humanOpen)));
      assert.ok(humanOpenText.startsWith('S06 / STAGE_ACCEPTED\nskill=stage-reviewer'), humanOpenText);
      assert.ok(humanOpenText.includes('project_terminal=PRE_TERMINAL'), humanOpenText);

      const jsonOpen = runCli(['status', '--json'], { cwd: fixture.dir });
      assert.equal(jsonOpen.exit, CLI_EXIT.OK);
      const jsonOpenStructured = resultOf(parseEnvelope(jsonOpen)) as Record<string, unknown>;
      assert.equal(jsonOpenStructured.scope, 'S06');
      assert.equal(jsonOpenStructured.phase, 'STAGE_ACCEPTED');
      assert.equal(jsonOpenStructured.required_skill, 'stage-reviewer');
      assert.deepEqual(jsonOpenStructured.project_terminal, {
        state: 'PRE_TERMINAL',
        project_ready: false,
        delivery_cycle_id: CYCLE_NEW,
        planned_stage_ids: [],
        accepted_stage_support_ids: ['S06'],
        exact_closure: false,
      });
      assert.equal('project_ready_ref' in (jsonOpenStructured.project_terminal as object), false, 'PRE_TERMINAL omits project_ready_ref');

      const detailOpen = runCli(['status', '--detail'], { cwd: fixture.dir });
      assert.equal(detailOpen.exit, CLI_EXIT.OK);
      const detailOpenText = String(resultOf(parseEnvelope(detailOpen)));
      assert.ok(detailOpenText.includes('project_terminal=PRE_TERMINAL'), detailOpenText);
      assert.ok(detailOpenText.includes(`accepted_plan_ref=${PLAN_NEW}`), detailOpenText);

      const detailJsonOpen = runCli(['status', '--json', '--detail'], { cwd: fixture.dir });
      assert.equal(detailJsonOpen.exit, CLI_EXIT.OK);
      const detailJsonOpenStructured = resultOf(parseEnvelope(detailJsonOpen)) as Record<string, unknown>;
      assert.deepEqual(detailJsonOpenStructured.project_terminal, {
        state: 'PRE_TERMINAL',
        project_ready: false,
        delivery_cycle_id: CYCLE_NEW,
        planned_stage_ids: [],
        accepted_stage_support_ids: ['S06'],
        exact_closure: false,
      });

      // Generation 3: the newer cycle closes into a supersedes chain (tip
      // supersedes the retained OLD terminal) — zero open cycles → the
      // validated chain tip is the CURRENT legal PROJECT_READY.
      store.write([...store.read(), terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', 'mes:fact:project_ready:old')]);

      const humanTip = runCli(['status'], { cwd: fixture.dir });
      assert.equal(humanTip.exit, CLI_EXIT.OK);
      const humanTipText = String(resultOf(parseEnvelope(humanTip)));
      assert.ok(humanTipText.startsWith('S06 / STAGE_ACCEPTED\nskill=stage-reviewer'), humanTipText);
      assert.ok(humanTipText.includes('project_terminal=CURRENT_PROJECT_READY'), humanTipText);

      const jsonTip = runCli(['status', '--json'], { cwd: fixture.dir });
      assert.equal(jsonTip.exit, CLI_EXIT.OK);
      const jsonTipStructured = resultOf(parseEnvelope(jsonTip)) as Record<string, unknown>;
      assert.deepEqual(jsonTipStructured.project_terminal, {
        state: 'CURRENT_PROJECT_READY',
        project_ready: true,
        project_ready_ref: 'mes:fact:project_ready:new',
        delivery_cycle_id: CYCLE_NEW,
        planned_stage_ids: ['S06'],
        accepted_stage_support_ids: ['S06'],
        exact_closure: true,
      });

      const detailTip = runCli(['status', '--detail'], { cwd: fixture.dir });
      assert.equal(detailTip.exit, CLI_EXIT.OK);
      const detailTipText = String(resultOf(parseEnvelope(detailTip)));
      assert.ok(detailTipText.includes('project_terminal=CURRENT_PROJECT_READY'), detailTipText);

      const detailJsonTip = runCli(['status', '--json', '--detail'], { cwd: fixture.dir });
      assert.equal(detailJsonTip.exit, CLI_EXIT.OK);
      const detailJsonTipStructured = resultOf(parseEnvelope(detailJsonTip)) as Record<string, unknown>;
      assert.deepEqual(detailJsonTipStructured.project_terminal, {
        state: 'CURRENT_PROJECT_READY',
        project_ready: true,
        project_ready_ref: 'mes:fact:project_ready:new',
        delivery_cycle_id: CYCLE_NEW,
        planned_stage_ids: ['S06'],
        accepted_stage_support_ids: ['S06'],
        exact_closure: true,
      });

      // Deterministic + read-only across every form: no route / next-action /
      // reasoning, no writes, no seed backfill, no PRE_MES_BOOTSTRAP revival.
      for (const argv of [['status'], ['status', '--json'], ['status', '--detail'], ['status', '--json', '--detail']]) {
        const envelope = parseEnvelope(runCli(argv, { cwd: fixture.dir }));
        const value = resultOf(envelope);
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        assert.ok(!rendered.includes('next_action'), `${argv.join(' ')} renders no next_action`);
        assert.ok(!rendered.includes('route=') && !rendered.includes('"route"'), `${argv.join(' ')} renders no route`);
        assert.ok(!rendered.includes('reasoning'), `${argv.join(' ')} renders no reasoning`);
        assert.equal(allKeys(value).some((key) => key === 'next_action' || key === 'route' || key === 'reasoning'), false);
      }
      const durableAfter = store.read();
      const seedAfter = fs.readFileSync(path.join(fixture.dir, MES_SEED_REL), 'utf8');
      assert.equal(isMesSeeded(fixture.dir), true, 'the store stays seeded — no orphaned/replaced seed facts');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), durableAfter, 'snapshot facts must be byte-unchanged by every status form');
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SEED_REL), 'utf8'), seedAfter, 'seed record must be byte-unchanged');
    } finally {
      fixture.cleanup();
    }
  });


  test('seeded legacy fallback exposes the projection-only project_terminal=HISTORICAL_PROJECT_READY adjunct for a legal no-cycle legacy terminal (repair CV S06-B-restart-cv-1 / contracts 2.3.1)', () => {
    // The seeded legacy projection (seed tuple) stays primary, but when the
    // durable facts ALSO carry a legal no-cycle legacy PROJECT_READY terminal
    // (retained history: no delivery_cycle_id, planned set exactly closed
    // against the no-cycle accepted-stage supports), the public status must
    // expose `project_terminal=HISTORICAL_PROJECT_READY` in human and JSON
    // forms without inventing currentness and without any write / backfill.
    const LEGACY_TERMINAL = 'mes:fact:project_ready:legacy';
    const fixture = fixtureRoot();
    try {
      seedStore(fixture.dir, fixture.head, fixture.branch);
      assert.equal(isMesSeeded(fixture.dir), true);
      const store = new MesSnapshotStore(fixture.dir);

      // Legal no-cycle legacy cohort: accepted stage support + project_ready
      // terminal (both omit delivery_cycle_id / supersedes_project_ready_ref).
      const legacySupport: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S04:accepted:legacy',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S04' },
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: 'delivery/stages/S04/plan.md',
          source_candidate_plan_ref: 'delivery/stages/S04/plan.md',
          verification_result_ref: 'mes:result:S04:planning-verification-legacy',
          plan_digest: sha('legacy-plan-v1'),
        },
        git_basis: { head: 'b'.repeat(40), branch: 'v2-herdr', worktree: '.' },
        result_ref: 'mes:result:S04:stage-review-legacy',
      };
      const legacyTerminal: MesFactEnvelope = {
        schema_version: 2,
        fact_id: LEGACY_TERMINAL,
        fact_kind: 'project_ready',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
        planned_stage_ids: ['S04'],
        git_basis: { head: 'b'.repeat(40), branch: 'v2-herdr', worktree: '.' },
      };
      store.write([...store.read(), legacySupport, legacyTerminal]);
      assert.equal(isMesSeeded(fixture.dir), true, 'extra valid legacy facts never unset the seeded state');

      // Sparse human: seed tuple primary + HISTORICAL adjunct line.
      const human = runCli(['status'], { cwd: fixture.dir });
      assert.equal(human.exit, CLI_EXIT.OK);
      const humanText = String(resultOf(parseEnvelope(human)));
      assert.ok(humanText.startsWith('S01 / EXECUTE\nskill=proofloop-execute'), humanText);
      assert.ok(humanText.includes('project_terminal=HISTORICAL_PROJECT_READY'), humanText);

      // Sparse JSON: seed tuple + full adjunct object (legacy → delivery_cycle_id omitted).
      const json = runCli(['status', '--json'], { cwd: fixture.dir });
      assert.equal(json.exit, CLI_EXIT.OK);
      const jsonStructured = resultOf(parseEnvelope(json)) as Record<string, unknown>;
      assert.equal(jsonStructured.scope, 'S01');
      assert.equal(jsonStructured.phase, 'EXECUTE');
      assert.deepEqual(jsonStructured.project_terminal, {
        state: 'HISTORICAL_PROJECT_READY',
        project_ready: true,
        project_ready_ref: LEGACY_TERMINAL,
        planned_stage_ids: ['S04'],
        accepted_stage_support_ids: ['S04'],
        exact_closure: true,
      });
      assert.equal('delivery_cycle_id' in (jsonStructured.project_terminal as object), false, 'legacy HISTORICAL omits delivery_cycle_id');

      // Detail forms carry the same adjunct.
      const detail = runCli(['status', '--detail'], { cwd: fixture.dir });
      assert.equal(detail.exit, CLI_EXIT.OK);
      const detailText = String(resultOf(parseEnvelope(detail)));
      assert.ok(detailText.includes('project_terminal=HISTORICAL_PROJECT_READY'), detailText);
      const detailJson = runCli(['status', '--json', '--detail'], { cwd: fixture.dir });
      assert.equal(detailJson.exit, CLI_EXIT.OK);
      const detailJsonStructured = resultOf(parseEnvelope(detailJson)) as Record<string, unknown>;
      assert.deepEqual(detailJsonStructured.project_terminal, {
        state: 'HISTORICAL_PROJECT_READY',
        project_ready: true,
        project_ready_ref: LEGACY_TERMINAL,
        planned_stage_ids: ['S04'],
        accepted_stage_support_ids: ['S04'],
        exact_closure: true,
      });

      // No route / next-action / reasoning; the store stays byte-unchanged.
      for (const argv of [['status'], ['status', '--json'], ['status', '--detail'], ['status', '--json', '--detail']]) {
        const envelope = parseEnvelope(runCli(argv, { cwd: fixture.dir }));
        const value = resultOf(envelope);
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        assert.ok(!rendered.includes('next_action'), `${argv.join(' ')} renders no next_action`);
        assert.ok(!rendered.includes('route=') && !rendered.includes('"route"'), `${argv.join(' ')} renders no route`);
        assert.ok(!rendered.includes('reasoning'), `${argv.join(' ')} renders no reasoning`);
      }
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), store.read(), 'snapshot facts must be byte-unchanged by every status form');
      assert.equal(isMesSeeded(fixture.dir), true);
    } finally {
      fixture.cleanup();
    }
  });
});