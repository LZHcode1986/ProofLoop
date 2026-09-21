/**
 * Runtime Integration adapter fixture tests (Phase B: `proofloop integration
 * apply`, .agents/contracts/brain/integration.md).
 *
 * Every test exercises a REAL temporary Git fixture (never the ProofLoop work
 * clone) through the compiled `applyIntegration` seam and/or the public
 * `proofloopCli` dispatcher. Required coverage:
 *   - HAPPY-1 current Stage HEAD equals candidate base; declared exact paths
 *   - HAPPY-2 (mandatory) candidate base is an older ancestor while the
 *     current Stage has another non-conflicting commit
 *   - FAIL-HEAD expected_head mismatch; no commit/write
 *   - FAIL-DIRTY Stage worktree or index dirty; no commit/write
 *   - FAIL-SCOPE candidate undeclared path; typed failure/no write
 *   - FAIL-PROTECTED candidate changes protected .proofloop scope
 *   - FAIL-CANDIDATE invalid candidate ref / base relationship
 *   - FAIL-CONFLICT genuinely conflicting current change; typed
 *     INTEGRATION.CONFLICT, no write and exact pre-state
 *   - POSTCONDITION exact changed_files, candidate ref remains, diff --check
 *     passes, public CLI emits one closed structured envelope
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, porcelain, type Fixture } from './helpers';
import {
  applyIntegration,
  IntegrationError,
  proofloopCli,
  CLI_EXIT,
  type IntegrationRequest,
  type IntegrationResult,
} from '../dist/index';

/** Assert that calling fn throws an IntegrationError with the given code. */
function expectIntegrationCode(fn: () => unknown, code: IntegrationError['code']): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof IntegrationError) {
      assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
      return error.message;
    }
    throw error;
  }
  assert.fail(`expected IntegrationError ${code}, but no error was thrown`);
}

interface Scenario {
  readonly fixture: Fixture;
  readonly branch: string;
  readonly base: string;
  readonly candidate: string;
  readonly candidateRef: string;
  readonly head: string;
}

function defaultBranch(fixture: Fixture): string {
  return fixture.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
}

/** Base a.txt+b.txt commit, then a `proofloop-s01-a` candidate branch modifying a.txt. HEAD back on base. */
function setupCandidate(fixture: Fixture): Scenario {
  fixture.write('a.txt', 'base-a\n');
  fixture.write('b.txt', 'base-b\n');
  fixture.run(['add', '-A']);
  fixture.run(['commit', '-q', '-m', 'base']);
  const base = fixture.head();
  const branch = defaultBranch(fixture);
  const candidateRef = 'proofloop-s01-a';
  fixture.run(['checkout', '-q', '-b', candidateRef]);
  fixture.write('a.txt', 'candidate-a\n');
  fixture.run(['add', '-A']);
  fixture.run(['commit', '-q', '-m', 'candidate']);
  const candidate = fixture.head();
  fixture.run(['checkout', '-q', branch]);
  return { fixture, branch, base, candidate, candidateRef, head: fixture.head() };
}

function baseRequest(scenario: Scenario, overrides: Partial<IntegrationRequest> = {}): IntegrationRequest {
  return {
    expected_head: scenario.head,
    expected_branch: scenario.branch,
    stage: 'S01',
    slice: 'A',
    candidate_ref: scenario.candidateRef,
    candidate_base_ref: scenario.base,
    paths: ['a.txt'],
    ...overrides,
  };
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

describe('Integration apply — happy paths', () => {
  test('HAPPY-1: current Stage HEAD equals candidate base; declared exact paths; success', () => {
    const s = setupCandidate(makeFixture());
    const result: IntegrationResult = applyIntegration(s.fixture.dir, baseRequest(s));
    assert.equal(result.pre_integration_head, s.head);
    assert.equal(result.commit_message, 'integration: S01-A');
    assert.deepEqual(result.changed_files, ['a.txt']);
    assert.deepEqual(result.dirty_after, []);
    // HEAD advanced and carries the canonical message.
    assert.notEqual(s.fixture.head(), s.head);
    assert.equal(s.fixture.run(['log', '-1', '--format=%s']).trim(), 'integration: S01-A');
    // Candidate content applied, candidate ref preserved, post-state clean.
    assert.equal(s.fixture.run(['show', 'HEAD:a.txt']).trim(), 'candidate-a');
    s.fixture.run(['rev-parse', '--verify', `${s.candidateRef}^{commit}`]);
    assert.equal(porcelain(s.fixture), '');
  });

  test('HAPPY-2 (mandatory): candidate base is an older ancestor while the current Stage has another non-conflicting commit', () => {
    const fixture = makeFixture();
    fixture.write('a.txt', 'base-a\n');
    fixture.write('b.txt', 'base-b\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'base']);
    const base = fixture.head();
    const branch = defaultBranch(fixture);
    const candidateRef = 'proofloop-s01-a';
    fixture.run(['checkout', '-q', '-b', candidateRef]);
    fixture.write('a.txt', 'candidate-a\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'candidate']);
    const candidate = fixture.head();
    fixture.run(['checkout', '-q', branch]);
    // HEAD advances with a non-conflicting commit on b.txt (stale base).
    fixture.write('b.txt', 'head-b\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'head-advance']);
    const head = fixture.head();
    const s: Scenario = { fixture, branch, base, candidate, candidateRef, head };
    const result: IntegrationResult = applyIntegration(fixture.dir, baseRequest(s));
    assert.equal(result.pre_integration_head, head);
    assert.equal(result.commit_message, 'integration: S01-A');
    assert.deepEqual(result.changed_files, ['a.txt']);
    // Candidate's a.txt integrated, HEAD's b.txt preserved.
    assert.equal(fixture.run(['show', 'HEAD:a.txt']).trim(), 'candidate-a');
    assert.equal(fixture.run(['show', 'HEAD:b.txt']).trim(), 'head-b');
    assert.equal(fixture.run(['log', '-1', '--format=%s']).trim(), 'integration: S01-A');
    assert.equal(porcelain(fixture), '');
    fixture.run(['rev-parse', '--verify', `${candidateRef}^{commit}`]);
  });
});

describe('Integration apply — fail-closed prechecks', () => {
  test('FAIL-HEAD: expected_head mismatch; no commit/write', () => {
    const s = setupCandidate(makeFixture());
    const headBefore = s.fixture.head();
    const message = expectIntegrationCode(
      () => applyIntegration(s.fixture.dir, baseRequest(s, { expected_head: 'f'.repeat(40) })),
      'INTEGRATION.HEAD_MISMATCH',
    );
    assert.ok(message.includes('expected_head'));
    assert.equal(s.fixture.head(), headBefore);
    assert.equal(porcelain(s.fixture), '');
  });

  test('FAIL-DIRTY: Stage worktree dirty; no commit/write', () => {
    const s = setupCandidate(makeFixture());
    s.fixture.write('b.txt', 'dirty\n');
    const headBefore = s.fixture.head();
    expectIntegrationCode(() => applyIntegration(s.fixture.dir, baseRequest(s)), 'INTEGRATION.DIRTY_WORKTREE');
    assert.equal(s.fixture.head(), headBefore);
    assert.ok(porcelain(s.fixture).includes('b.txt'));
  });

  test('FAIL-DIRTY: Stage index dirty; no commit/write', () => {
    const s = setupCandidate(makeFixture());
    s.fixture.write('c.txt', 'staged\n');
    s.fixture.run(['add', 'c.txt']);
    const headBefore = s.fixture.head();
    expectIntegrationCode(() => applyIntegration(s.fixture.dir, baseRequest(s)), 'INTEGRATION.INDEX_NOT_EMPTY');
    assert.equal(s.fixture.head(), headBefore);
    assert.ok(porcelain(s.fixture).includes('c.txt'));
  });

  test('FAIL-SCOPE: candidate undeclared path; typed failure/no write', () => {
    const fixture = makeFixture();
    fixture.write('a.txt', 'base-a\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'base']);
    const base = fixture.head();
    const branch = defaultBranch(fixture);
    const candidateRef = 'proofloop-s01-a';
    fixture.run(['checkout', '-q', '-b', candidateRef]);
    fixture.write('a.txt', 'candidate-a\n');
    fixture.write('c.txt', 'extra\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'candidate']);
    const candidate = fixture.head();
    fixture.run(['checkout', '-q', branch]);
    const head = fixture.head();
    const s: Scenario = { fixture, branch, base, candidate, candidateRef, head };
    const message = expectIntegrationCode(
      () => applyIntegration(fixture.dir, baseRequest(s)),
      'INTEGRATION.SCOPE_VIOLATION',
    );
    assert.ok(message.includes('a.txt') && message.includes('c.txt'));
    assert.equal(fixture.head(), head);
    assert.equal(porcelain(fixture), '');
  });

  test('FAIL-PROTECTED: candidate changes protected .proofloop scope; typed failure/no write', () => {
    const fixture = makeFixture();
    fixture.write('a.txt', 'base-a\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'base']);
    const base = fixture.head();
    const branch = defaultBranch(fixture);
    const candidateRef = 'proofloop-s01-a';
    fixture.run(['checkout', '-q', '-b', candidateRef]);
    fixture.write('.proofloop/secret.txt', 'secret\n');
    fixture.run(['add', '-f', '.proofloop/secret.txt']);
    fixture.run(['commit', '-q', '-m', 'candidate']);
    const candidate = fixture.head();
    fixture.run(['checkout', '-q', branch]);
    const head = fixture.head();
    const s: Scenario = { fixture, branch, base, candidate, candidateRef, head };
    const message = expectIntegrationCode(
      () => applyIntegration(fixture.dir, baseRequest(s, { paths: ['.proofloop/secret.txt'] })),
      'INTEGRATION.SCOPE_VIOLATION',
    );
    assert.ok(message.includes('.proofloop/secret.txt'));
    assert.equal(fixture.head(), head);
    assert.equal(porcelain(fixture), '');
  });

  test('FAIL-CANDIDATE: malformed candidate ref; typed failure/no write', () => {
    const s = setupCandidate(makeFixture());
    const headBefore = s.fixture.head();
    const message = expectIntegrationCode(
      () => applyIntegration(s.fixture.dir, baseRequest(s, { candidate_ref: 'nosuch-ref' })),
      'INTEGRATION.CANDIDATE_REF_INVALID',
    );
    assert.ok(message.includes('nosuch-ref'));
    assert.equal(s.fixture.head(), headBefore);
    assert.equal(porcelain(s.fixture), '');
  });

  test('FAIL-CANDIDATE: candidate base is not an ancestor of candidate; typed failure/no write', () => {
    const fixture = makeFixture();
    fixture.write('a.txt', 'base-a\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'base']);
    const base = fixture.head();
    const branch = defaultBranch(fixture);
    const candidateRef = 'proofloop-s01-a';
    // Candidate on an unrelated (orphan) history: base is NOT an ancestor.
    fixture.run(['checkout', '-q', '--orphan', candidateRef]);
    fixture.write('a.txt', 'candidate-a\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'candidate']);
    const candidate = fixture.head();
    fixture.run(['checkout', '-q', branch]);
    const head = fixture.head();
    const s: Scenario = { fixture, branch, base, candidate, candidateRef, head };
    expectIntegrationCode(
      () => applyIntegration(fixture.dir, baseRequest(s)),
      'INTEGRATION.CANDIDATE_BASE_INVALID',
    );
    assert.equal(fixture.head(), head);
    assert.equal(porcelain(fixture), '');
  });

  test('FAIL-CANDIDATE: candidate base is not an ancestor of current Stage HEAD; typed failure/no write', () => {
    const fixture = makeFixture();
    fixture.write('a.txt', 'base-a\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'base']);
    const base = fixture.head();
    const candidateRef = 'proofloop-s01-a';
    fixture.run(['checkout', '-q', '-b', candidateRef]);
    fixture.write('a.txt', 'candidate-a\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'candidate']);
    const candidate = fixture.head();
    // Current Stage HEAD on an unrelated orphan history (base NOT an ancestor).
    fixture.run(['checkout', '-q', '--orphan', 'unrelated-head']);
    fixture.write('x.txt', 'x\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'unrelated']);
    const head = fixture.head();
    const branch = defaultBranch(fixture);
    const s: Scenario = { fixture, branch, base, candidate, candidateRef, head };
    expectIntegrationCode(
      () => applyIntegration(fixture.dir, baseRequest(s)),
      'INTEGRATION.BASE_NOT_ANCESTOR',
    );
    assert.equal(fixture.head(), head);
    assert.equal(porcelain(fixture), '');
  });

  test('FAIL-CONFLICT: genuinely conflicting current change; typed INTEGRATION.CONFLICT, no write and exact pre-state', () => {
    const fixture = makeFixture();
    fixture.write('a.txt', 'base\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'base']);
    const base = fixture.head();
    const branch = defaultBranch(fixture);
    const candidateRef = 'proofloop-s01-a';
    fixture.run(['checkout', '-q', '-b', candidateRef]);
    fixture.write('a.txt', 'candidate\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'candidate']);
    const candidate = fixture.head();
    // HEAD changes the SAME line differently: genuine three-way conflict.
    fixture.run(['checkout', '-q', branch]);
    fixture.write('a.txt', 'headside\n');
    fixture.run(['add', '-A']);
    fixture.run(['commit', '-q', '-m', 'head']);
    const head = fixture.head();
    const s: Scenario = { fixture, branch, base, candidate, candidateRef, head };
    expectIntegrationCode(
      () => applyIntegration(fixture.dir, baseRequest(s)),
      'INTEGRATION.CONFLICT',
    );
    // Exact pre-state: HEAD unchanged, worktree clean, HEAD:a.txt untouched.
    assert.equal(fixture.head(), head);
    assert.equal(porcelain(fixture), '');
    assert.equal(fixture.run(['show', 'HEAD:a.txt']).trim(), 'headside');
  });
});

describe('Integration apply — public CLI + postcondition', () => {
  test('POSTCONDITION: exact changed_files, candidate ref remains, diff-check passes, public CLI emits one closed envelope', () => {
    const s = setupCandidate(makeFixture());
    // Integration Contract (D.1) closed schema: the integration request
    // requires execution_mode + expected_worktree (explicit migration).
    const request = {
      ...baseRequest(s),
      domain: 'integration',
      operation: 'apply',
      execution_mode: 'NORMAL' as const,
      expected_worktree: '.',
    };
    const { exit, lines } = runCli(
      ['integration', 'apply', '--json', JSON.stringify(request), '--project-root', s.fixture.dir],
      { cwd: s.fixture.dir },
    );
    assert.equal(exit, CLI_EXIT.OK);
    assert.equal(lines.length, 1, 'public CLI must emit exactly one canonical JSON envelope');
    const envelope = JSON.parse(lines[0] as string) as {
      ok: boolean;
      command: { domain: string; operation: string };
      result: IntegrationResult;
      findings: { code: string; message: string }[];
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command.domain, 'integration');
    assert.equal(envelope.command.operation, 'apply');
    assert.deepEqual(envelope.findings, []);
    assert.equal(envelope.result.pre_integration_head, s.head);
    assert.equal(envelope.result.commit_message, 'integration: S01-A');
    assert.deepEqual(envelope.result.changed_files, ['a.txt']);
    assert.equal(envelope.result.candidate_ref, s.candidateRef);
    assert.equal(envelope.result.candidate_base_ref, s.base);
    assert.deepEqual(envelope.result.dirty_after, []);
    // Git facts: HEAD advanced, candidate ref remains, diff --check passes,
    // worktree clean.
    assert.notEqual(s.fixture.head(), s.head);
    s.fixture.run(['rev-parse', '--verify', `${s.candidateRef}^{commit}`]);
    s.fixture.run(['diff', '--check']);
    assert.equal(porcelain(s.fixture), '');
  });

  test('POSTCONDITION: CLI emits one closed failure envelope on a typed failure', () => {
    const s = setupCandidate(makeFixture());
    const request = {
      ...baseRequest(s, { expected_head: 'e'.repeat(40) }),
      domain: 'integration',
      operation: 'apply',
      execution_mode: 'NORMAL' as const,
      expected_worktree: '.',
    };
    const { exit, lines } = runCli(
      ['integration', 'apply', '--json', JSON.stringify(request), '--project-root', s.fixture.dir],
      { cwd: s.fixture.dir },
    );
    assert.equal(exit, CLI_EXIT.BLOCKED);
    assert.equal(lines.length, 1, 'public CLI must emit exactly one canonical JSON envelope');
    const envelope = JSON.parse(lines[0] as string) as { ok: boolean; findings: { code: string }[] };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.findings[0].code, 'INTEGRATION.HEAD_MISMATCH');
  });
});
