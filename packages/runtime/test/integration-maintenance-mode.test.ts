/**
 * MES_MAINTENANCE mode-specific Integration apply tests (S06-R-D-T03).
 *
 * PO: .agents/contracts/brain/integration.md (D.1) — closed Integration
 * schema (execution_mode / expected_worktree / conditional
 * maintenance_binding), mode-specific target worktree, canonical integration
 * commit, Git-only evidence; acceptance E2E-26 / STATIC-33; contracts §5.3
 * Git worktree lifecycle. All tests use only isolated temp Git fixtures.
 *
 * The MES_MAINTENANCE branch targets a root-bound DETACHED isolated evidence
 * worktree (never the main / other-Slice worktree): exact HEAD, empty index,
 * clean target, candidate ancestry / exact paths / diff --check / three-way
 * conflict precheck, then ONE canonical `integration: <stage>-<slice>`
 * commit in the evidence worktree. Any failure is typed zero-write (the main
 * worktree and every evidence byte stay untouched). The maintenance_binding
 * tuple (frozen/forensic/audit refs+digests+count) is machine-verified via
 * the maintenance entry seam before any Git write. The result carries
 * execution_mode / expected_worktree and is evidence-only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { commitAll, makeFixture, sha, type Fixture } from './helpers';
import { applyIntegration, IntegrationError, proofloopCli, CLI_EXIT } from '../dist/index';
import type { IntegrationRequest } from '../dist/index';

const STAGE = 'S06';
const SLICE = 'R-D';
const EVIDENCE_WORKTREE = '.proofloop/worktrees/evidence';
const CANDIDATE_REF = 'proofloop-s06-d';

function fileDigest(abs: string): string {
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function frozenSnapshotJson(): string {
  const facts = [];
  for (let index = 0; index < 130; index += 1) {
    facts.push({
      schema_version: 2,
      fact_id: `mes:fact:fixture:${String(index).padStart(3, '0')}`,
      fact_kind: 'project',
      created_by: 'brain',
    });
  }
  return JSON.stringify({ schema_version: 2, facts }, null, 2);
}

interface MaintenanceFixture {
  readonly root: string;
  readonly mainBranch: string;
  readonly base: string;
  /** The frozen/forensic/audit tuple refs+digests (exact). */
  readonly binding: Record<string, unknown>;
  /** Evidence worktree root-relative identity + absolute path. */
  readonly evidenceRel: string;
  readonly evidenceAbs: string;
  readonly evidenceHead: string;
  maintenanceRequest(overrides?: Partial<IntegrationRequest>): IntegrationRequest;
  cleanup(): void;
}

function setupMaintenanceFixture(): MaintenanceFixture {
  const fixture = makeFixture();
  // Trust root: frozen MES tuple + recovery candidate (isolated fixture only).
  fixture.write('.proofloop/mes/snapshot.json', frozenSnapshotJson());
  fixture.write(
    '.proofloop/forensics/mes-recovery-fixture-001/incident.json',
    JSON.stringify({ incident: 's06-binding-mismatch-fixture', ref: 'mes:result:S06:planning-verification:1' }, null, 2),
  );
  fixture.write(
    '.proofloop/forensics/mes-recovery-fixture-001/audit.json',
    JSON.stringify({ audit: 'read-only relational audit fixture', misbound: 7 }, null, 2),
  );
  fixture.write('delivery/stages/S06/recovery-plan-r9.md', '# S06 recovery candidate (fixture)\n');
  // Candidate source: base commit on the main branch, then a candidate branch.
  fixture.write('a.txt', 'base-a\n');
  fixture.write('b.txt', 'base-b\n');
  commitAll(fixture, 'base');
  const base = fixture.head();
  const mainBranch = fixture.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  fixture.run(['checkout', '-q', '-b', CANDIDATE_REF]);
  fixture.write('a.txt', 'candidate-a\n');
  commitAll(fixture, 'candidate');
  fixture.run(['checkout', '-q', mainBranch]);

  // Physical quarantine AFTER seeding: `.proofloop/mes` becomes mode 0555.
  fs.chmodSync(path.join(fixture.dir, '.proofloop', 'mes'), 0o555);

  const frozenAbs = path.join(fixture.dir, '.proofloop', 'mes', 'snapshot.json');
  const forensicAbs = path.join(fixture.dir, '.proofloop', 'forensics', 'mes-recovery-fixture-001', 'incident.json');
  const auditAbs = path.join(fixture.dir, '.proofloop', 'forensics', 'mes-recovery-fixture-001', 'audit.json');
  const binding = {
    frozen_snapshot_ref: '.proofloop/mes/snapshot.json',
    frozen_snapshot_sha256: fileDigest(frozenAbs),
    frozen_fact_count: 130,
    forensic_ref: '.proofloop/forensics/mes-recovery-fixture-001/incident.json',
    forensic_sha256: fileDigest(forensicAbs),
    audit_ref: '.proofloop/forensics/mes-recovery-fixture-001/audit.json',
    audit_sha256: fileDigest(auditAbs),
  };

  // Detached isolated evidence worktree at the candidate base.
  fixture.run(['worktree', 'add', '--detach', EVIDENCE_WORKTREE, base]);
  const evidenceAbs = path.join(fixture.dir, EVIDENCE_WORKTREE);
  const evidenceHead = fixture.run(['rev-parse', 'HEAD'], { cwd: evidenceAbs }).trim();

  const maintenanceRequest = (overrides: Partial<IntegrationRequest> = {}): IntegrationRequest => ({
    expected_head: evidenceHead,
    expected_branch: 'HEAD',
    stage: STAGE,
    slice: SLICE,
    candidate_ref: CANDIDATE_REF,
    candidate_base_ref: base,
    paths: ['a.txt'],
    execution_mode: 'MES_MAINTENANCE',
    expected_worktree: EVIDENCE_WORKTREE,
    maintenance_binding: binding,
    ...overrides,
  });

  return {
    root: fixture.dir,
    mainBranch,
    base,
    binding,
    evidenceRel: EVIDENCE_WORKTREE,
    evidenceAbs,
    evidenceHead,
    maintenanceRequest,
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

function expectIntegrationCode(fn: () => unknown, code: IntegrationError['code']): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof IntegrationError) {
      assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
      return;
    }
    throw error;
  }
  assert.fail(`expected IntegrationError ${code}, but no error was thrown`);
}

/** Run the public CLI and capture the emitted envelope line(s). */
function runCli(
  argv: readonly string[],
  opts: { cwd: string },
): { exit: number; lines: string[] } {
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

describe('Integration apply — MES_MAINTENANCE mode (S06-R-D-T03)', () => {
  test('canonical maintenance integration commits into the detached evidence worktree; main worktree zero-write; result evidence-only', () => {
    const fx = setupMaintenanceFixture();
    try {
      const mainHeadBefore = fx.base;
      const result = applyIntegration(fx.root, fx.maintenanceRequest());
      // Evidence-only handoff: mode + target identity are in the result.
      assert.equal(result.execution_mode, 'MES_MAINTENANCE');
      assert.equal(result.expected_worktree, EVIDENCE_WORKTREE);
      assert.equal(result.pre_integration_head, fx.evidenceHead);
      assert.equal(result.commit_message, `integration: ${STAGE}-${SLICE}`);
      assert.deepEqual(result.changed_files, ['a.txt']);
      assert.deepEqual(result.dirty_after, []);
      const evCommit = runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim();
      assert.notEqual(evCommit, fx.evidenceHead);
      const evMessage = runGitQuiet(fx.evidenceAbs, ['log', '-1', '--format=%s']).trim();
      assert.equal(evMessage, `integration: ${STAGE}-${SLICE}`);
      assert.equal(runGitQuiet(fx.evidenceAbs, ['show', 'HEAD:a.txt']).trim(), 'candidate-a');
      assert.equal(runGitQuiet(fx.evidenceAbs, ['show', 'HEAD:b.txt']).trim(), 'base-b');
      // Evidence worktree clean + still detached.
      assert.equal(porcelainOf(fx.evidenceAbs), '');
      assert.notEqual(gitExitCode(fx.evidenceAbs, ['symbolic-ref', '--quiet', '--short', 'HEAD']), 0, 'evidence worktree must remain detached');
      // Main worktree zero-write: HEAD unchanged, worktree clean, candidate
      // ref preserved, main a.txt still base.
      assert.equal(runGitQuiet(fx.root, ['rev-parse', 'HEAD']).trim(), mainHeadBefore);
      assert.equal(porcelainOf(fx.root), '');
      assert.equal(runGitQuiet(fx.root, ['show', 'HEAD:a.txt']).trim(), 'base-a');
      runGitQuiet(fx.root, ['rev-parse', '--verify', `${CANDIDATE_REF}^{commit}`]);
    } finally {
      fx.cleanup();
    }
  });

  test('HEAD mismatch is typed zero-write', () => {
    const fx = setupMaintenanceFixture();
    try {
      const mainHead = runGitQuiet(fx.root, ['rev-parse', 'HEAD']).trim();
      const evHead = runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim();
      expectIntegrationCode(
        () => applyIntegration(fx.root, fx.maintenanceRequest({ expected_head: 'f'.repeat(40) })),
        'INTEGRATION.HEAD_MISMATCH',
      );
      assert.equal(runGitQuiet(fx.root, ['rev-parse', 'HEAD']).trim(), mainHead);
      assert.equal(runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim(), evHead);
      assert.equal(porcelainOf(fx.root), '');
      assert.equal(porcelainOf(fx.evidenceAbs), '');
    } finally {
      fx.cleanup();
    }
  });

  test('forbidden main-worktree target (expected_worktree ".") is typed zero-write', () => {
    const fx = setupMaintenanceFixture();
    try {
      expectIntegrationCode(
        () => applyIntegration(fx.root, fx.maintenanceRequest({ expected_worktree: '.' })),
        'INTEGRATION.REQUEST_INVALID',
      );
      assert.equal(porcelainOf(fx.root), '');
    } finally {
      fx.cleanup();
    }
  });

  test('protected frozen S06-C / S06-D worktree targets are typed zero-write (maintenance must not write main/C/D)', () => {
    const fx = setupMaintenanceFixture();
    try {
      // The maintenance Integration must reject the frozen stage worktrees
      // (root-contained, real git worktrees) BEFORE any Git write.
      for (const protectedWt of ['.proofloop/worktrees/S06-S06-C', '.proofloop/worktrees/S06-S06-D']) {
        const fixture = makeFixtureAlias(fx.root);
        fixture.run(['worktree', 'add', '--detach', protectedWt, fx.base]);
        const protectedAbs = path.join(fx.root, protectedWt);
        const mainHeadBefore = runGitQuiet(fx.root, ['rev-parse', 'HEAD']).trim();
        expectIntegrationCode(
          () => applyIntegration(fx.root, fx.maintenanceRequest({ expected_worktree: protectedWt })),
          'INTEGRATION.SCOPE_VIOLATION',
        );
        // Zero-write: the protected worktree and the main worktree are
        // byte-identical to the pre-call state.
        assert.equal(porcelainOf(protectedAbs), '');
        assert.equal(runGitQuiet(fx.root, ['rev-parse', 'HEAD']).trim(), mainHeadBefore);
        assert.equal(porcelainOf(fx.root), '');
        assert.equal(runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim(), fx.evidenceHead, 'evidence worktree untouched');
      }
    } finally {
      fx.cleanup();
    }
  });

  test('writable .proofloop/mes quarantine is a typed zero-write failure before any Git write (MAINTENANCE_EVIDENCE_BOUNDARY_BYPASS repair)', () => {
    const fx = setupMaintenanceFixture();
    try {
      // Lift the physical quarantine: the MES_MAINTENANCE Integration must
      // fail on the shared quarantine predicate BEFORE any apply/stage/commit
      // — refs/digests/count exactness alone is not enough.
      fs.chmodSync(path.join(fx.root, '.proofloop', 'mes'), 0o755);
      const mainHeadBefore = runGitQuiet(fx.root, ['rev-parse', 'HEAD']).trim();
      const evHeadBefore = runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim();
      expectIntegrationCode(
        () => applyIntegration(fx.root, fx.maintenanceRequest()),
        'INTEGRATION.QUARANTINE_VIOLATED',
      );
      // HEAD/index/worktree/evidence unchanged (zero-write).
      assert.equal(runGitQuiet(fx.root, ['rev-parse', 'HEAD']).trim(), mainHeadBefore);
      assert.equal(runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim(), evHeadBefore);
      assert.equal(porcelainOf(fx.root), '');
      assert.equal(porcelainOf(fx.evidenceAbs), '');
      // Frozen/forensic/audit bytes unchanged.
      assert.equal(
        fileDigest(path.join(fx.root, '.proofloop', 'mes', 'snapshot.json')),
        String(fx.binding.frozen_snapshot_sha256),
        'frozen snapshot byte-stable',
      );
      assert.equal(
        fileDigest(path.join(fx.root, '.proofloop', 'forensics', 'mes-recovery-fixture-001', 'incident.json')),
        String(fx.binding.forensic_sha256),
        'forensic byte-stable',
      );
      assert.equal(
        fileDigest(path.join(fx.root, '.proofloop', 'forensics', 'mes-recovery-fixture-001', 'audit.json')),
        String(fx.binding.audit_sha256),
        'audit byte-stable',
      );
    } finally {
      try {
        fs.chmodSync(path.join(fx.root, '.proofloop', 'mes'), 0o555);
      } catch {
        /* already gone */
      }
      fx.cleanup();
    }
  });

  test('invalid execution_mode is typed zero-write', () => {
    const fx = setupMaintenanceFixture();
    try {
      expectIntegrationCode(
        () =>
          applyIntegration(fx.root, {
            ...fx.maintenanceRequest(),
            execution_mode: 'GENERAL' as never,
          }),
        'INTEGRATION.REQUEST_INVALID',
      );
      assert.equal(porcelainOf(fx.root), '');
    } finally {
      fx.cleanup();
    }
  });

  test('dirty target worktree is typed zero-write', () => {
    const fx = setupMaintenanceFixture();
    try {
      fs.writeFileSync(path.join(fx.evidenceAbs, 'a.txt'), 'dirty\n', 'utf8');
      const evHead = runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim();
      expectIntegrationCode(
        () => applyIntegration(fx.root, fx.maintenanceRequest()),
        'INTEGRATION.DIRTY_WORKTREE',
      );
      assert.equal(runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim(), evHead);
      assert.equal(porcelainOf(fx.root), '');
    } finally {
      fx.cleanup();
    }
  });

  test('maintenance_binding digest mismatch is typed zero-write', () => {
    const fx = setupMaintenanceFixture();
    try {
      const badBinding = { ...fx.binding, frozen_snapshot_sha256: sha('stale') };
      expectIntegrationCode(
        () => applyIntegration(fx.root, fx.maintenanceRequest({ maintenance_binding: badBinding })),
        'INTEGRATION.REQUEST_INVALID',
      );
      assert.equal(porcelainOf(fx.root), '');
      assert.equal(porcelainOf(fx.evidenceAbs), '');
    } finally {
      fx.cleanup();
    }
  });

  test('missing maintenance_binding under MES_MAINTENANCE is typed zero-write', () => {
    const fx = setupMaintenanceFixture();
    try {
      const { maintenance_binding: _omitted, ...rest } = fx.maintenanceRequest();
      void _omitted;
      expectIntegrationCode(
        () => applyIntegration(fx.root, rest),
        'INTEGRATION.REQUEST_INVALID',
      );
      assert.equal(porcelainOf(fx.root), '');
    } finally {
      fx.cleanup();
    }
  });

  test('maintenance_binding under NORMAL is typed zero-write', () => {
    const fx = setupMaintenanceFixture();
    try {
      expectIntegrationCode(
        () =>
          applyIntegration(fx.root, {
            ...fx.maintenanceRequest(),
            execution_mode: 'NORMAL',
            expected_worktree: '.',
          }),
        'INTEGRATION.REQUEST_INVALID',
      );
      assert.equal(porcelainOf(fx.root), '');
    } finally {
      fx.cleanup();
    }
  });

  test('non-detached branch worktree target is typed zero-write', () => {
    const fx = setupMaintenanceFixture();
    try {
      // A BRANCH worktree (symbolic-ref HEAD) is a forbidden target.
      fx.root; // root used below through fixture.run alias
      const branchWt = '.proofloop/worktrees/evbranch';
      const fixture = makeFixtureAlias(fx.root);
      fixture.run(['worktree', 'add', '-b', 'evbranch', branchWt, fx.base]);
      const branchAbs = path.join(fx.root, branchWt);
      expectIntegrationCode(
        () => applyIntegration(fx.root, fx.maintenanceRequest({ expected_worktree: branchWt })),
        'INTEGRATION.BRANCH_MISMATCH',
      );
      // The branch worktree stayed untouched; main untouched.
      assert.equal(porcelainOf(fx.root), '');
      assert.equal(porcelainOf(branchAbs), '');
    } finally {
      fx.cleanup();
    }
  });

  test('detached target with expected_branch NOT-HEAD is typed zero-write (exact branch identity)', () => {
    const fx = setupMaintenanceFixture();
    try {
      const evHead = runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim();
      const mainHead = runGitQuiet(fx.root, ['rev-parse', 'HEAD']).trim();
      // The evidence worktree is genuinely detached (identity `HEAD`), but
      // the request pins expected_branch to a real branch name: the actual
      // branch identity must be checked BEFORE any Git write and fail
      // typed zero-write (detached identity is the literal `HEAD`).
      expectIntegrationCode(
        () => applyIntegration(fx.root, fx.maintenanceRequest({ expected_branch: 'proofloop-s06-r-d' })),
        'INTEGRATION.BRANCH_MISMATCH',
      );
      // Zero-write: evidence HEAD, main HEAD and both worktrees are
      // byte-identical to the pre-call state.
      assert.equal(runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim(), evHead);
      assert.equal(runGitQuiet(fx.root, ['rev-parse', 'HEAD']).trim(), mainHead);
      assert.equal(porcelainOf(fx.root), '');
      assert.equal(porcelainOf(fx.evidenceAbs), '');
    } finally {
      fx.cleanup();
    }
  });

  test('public CLI emits one closed maintenance envelope on success', () => {
    const fx = setupMaintenanceFixture();
    try {
      const request = {
        ...fx.maintenanceRequest(),
        domain: 'integration',
        operation: 'apply',
      };
      const { exit, lines } = runCli(
        ['integration', 'apply', '--json', JSON.stringify(request), '--project-root', fx.root],
        { cwd: fx.root },
      );
      assert.equal(exit, CLI_EXIT.OK);
      assert.equal(lines.length, 1, 'public CLI must emit exactly one canonical JSON envelope');
      const envelope = JSON.parse(lines[0] as string) as {
        ok: boolean;
        findings: { code: string; message: string }[];
        result: { execution_mode: string; expected_worktree: string; commit_message: string; changed_files: string[] };
      };
      assert.equal(envelope.ok, true);
      assert.deepEqual(envelope.findings, []);
      assert.equal(envelope.result.execution_mode, 'MES_MAINTENANCE');
      assert.equal(envelope.result.expected_worktree, EVIDENCE_WORKTREE);
      assert.equal(envelope.result.commit_message, `integration: ${STAGE}-${SLICE}`);
      assert.deepEqual(envelope.result.changed_files, ['a.txt']);
    } finally {
      fx.cleanup();
    }
  });

  test('public CLI rejects a missing execution_mode (closed schema)', () => {
    const fx = setupMaintenanceFixture();
    try {
      const { execution_mode: _omitted, ...rest } = fx.maintenanceRequest();
      void _omitted;
      const request = { ...rest, domain: 'integration', operation: 'apply' };
      const { exit, lines } = runCli(
        ['integration', 'apply', '--json', JSON.stringify(request), '--project-root', fx.root],
        { cwd: fx.root },
      );
      assert.equal(exit, CLI_EXIT.BLOCKED);
      const envelope = JSON.parse(lines[0] as string) as { findings: { code: string }[] };
      assert.equal(envelope.findings[0]?.code, 'RUNTIME.INPUT_INVALID');
      assert.equal(porcelainOf(fx.root), '');
    } finally {
      fx.cleanup();
    }
  });

  test('public CLI rejects maintenance_binding under NORMAL (closed schema)', () => {
    const fx = setupMaintenanceFixture();
    try {
      const request = {
        ...fx.maintenanceRequest(),
        domain: 'integration',
        operation: 'apply',
        execution_mode: 'NORMAL',
        expected_worktree: '.',
      };
      const { exit, lines } = runCli(
        ['integration', 'apply', '--json', JSON.stringify(request), '--project-root', fx.root],
        { cwd: fx.root },
      );
      assert.equal(exit, CLI_EXIT.BLOCKED);
      const envelope = JSON.parse(lines[0] as string) as { findings: { code: string }[] };
      assert.equal(envelope.findings[0]?.code, 'RUNTIME.INPUT_INVALID');
    } finally {
      fx.cleanup();
    }
  });

  test('public CLI rejects an unknown field (closed schema)', () => {
    const fx = setupMaintenanceFixture();
    try {
      const request = {
        ...fx.maintenanceRequest(),
        domain: 'integration',
        operation: 'apply',
        smuggled: 'nope',
      };
      const { exit, lines } = runCli(
        ['integration', 'apply', '--json', JSON.stringify(request), '--project-root', fx.root],
        { cwd: fx.root },
      );
      assert.equal(exit, CLI_EXIT.BLOCKED);
      const envelope = JSON.parse(lines[0] as string) as { findings: { code: string }[] };
      assert.equal(envelope.findings[0]?.code, 'RUNTIME.INPUT_INVALID');
      assert.equal(porcelainOf(fx.root), '');
    } finally {
      fx.cleanup();
    }
  });

  test('NORMAL mode regression unchanged through the closed schema (direct seam)', () => {
    const fx = setupMaintenanceFixture();
    try {
      // A NORMAL integration onto the current Stage worktree still works and
      // emits the canonical message with the new result fields.
      const normalRequest: IntegrationRequest = {
        expected_head: fx.base,
        expected_branch: fx.mainBranch,
        stage: STAGE,
        slice: SLICE,
        candidate_ref: CANDIDATE_REF,
        candidate_base_ref: fx.base,
        paths: ['a.txt'],
        execution_mode: 'NORMAL',
        expected_worktree: '.',
      };
      const result = applyIntegration(fx.root, normalRequest);
      assert.equal(result.execution_mode, 'NORMAL');
      assert.equal(result.expected_worktree, '.');
      assert.equal(result.commit_message, `integration: ${STAGE}-${SLICE}`);
      assert.deepEqual(result.changed_files, ['a.txt']);
      assert.equal(runGitQuiet(fx.root, ['show', 'HEAD:a.txt']).trim(), 'candidate-a');
      // The evidence worktree stayed untouched (zero-write).
      assert.equal(runGitQuiet(fx.evidenceAbs, ['rev-parse', 'HEAD']).trim(), fx.evidenceHead);
      assert.equal(porcelainOf(fx.evidenceAbs), '');
    } finally {
      fx.cleanup();
    }
  });
});

/** Run a git command quietly in a given cwd and return stdout. */
function runGitQuiet(cwd: string, args: readonly string[]): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** Return the git subprocess exit code (0 on success, 1 on failure). */
function gitExitCode(cwd: string, args: readonly string[]): number {
  try {
    runGitQuiet(cwd, args);
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return typeof status === 'number' ? status : 1;
  }
}

/** Porcelain status of a specific cwd (space-separated, sorted). */
function porcelainOf(cwd: string): string {
  const output = runGitQuiet(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  return output.split('\n').filter((line) => line.length > 0).sort().join('|');
}

/** A minimal alias of the fixture interface bound to an existing root. */
function makeFixtureAlias(root: string): Pick<Fixture, 'run'> {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  return {
    run: (args: readonly string[], opts: { cwd?: string } = {}) =>
      execFileSync('git', [...args], {
        cwd: opts.cwd ?? root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString(),
  };
}
