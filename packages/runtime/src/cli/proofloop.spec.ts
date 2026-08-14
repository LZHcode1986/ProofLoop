/**
 * proofloop.spec.ts — S10-A-T01: public proofloop CLI dispatcher & seam base.
 *
 * PO binding (REF-S10-A-T01 / REF-CLI-ACCEPTANCE Acceptance A): 真实 built
 * `proofloop <domain> <operation>` 提供 canonical JSON envelope、closed
 * operation registry、root assertion 与 exit contract；unknown domain/op 在
 * 任何写入前 fail closed。Seam §0.1/§0.2/§0.3 — invocation、envelope 形状、
 * closed command matrix（11 域闭集，S10-D-T03 接线 recovery 域、S10-E-T02
 * repair 接线 cutover 域后）。Oracle —
 * source/dist 同构、harness-neutral。Risk REF-S08D-RISK — public_api_change /
 * cross_process_behavior。
 *
 * 本 spec 覆盖 T01 基座范围：closed registry、canonical envelope、exit
 * contract、root assertion、request 输入基础解析、bin 注册、built dist
 * smoke。doctor 域操作与完整 request-file 行为留待 S10-A-T02。
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { proofloopCli } from './proofloop';
import {
  CANONICAL_DOMAINS,
  DOMAIN_REGISTRY,
  CLI_EXIT,
  emitEnvelope,
  okEnvelope,
  canonicalStringify,
  resolveTrustRoot,
} from './proofloop-common';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_PROOFLOOP = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');

// ============================================================
// Fixture helpers
// ============================================================

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-'));
}

function gitRoot(): string {
  const root = tempRoot();
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'cli@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Cli Test']);
  return root;
}

interface CliRun {
  readonly code: number;
  readonly envelope: Record<string, any>;
  readonly stdout: string;
}

function runCli(
  argv: readonly string[],
  opts: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): CliRun {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
    logs.push(String(message));
  });
  let code: number;
  try {
    code = proofloopCli(argv, opts);
  } finally {
    spy.mockRestore();
  }
  const last = logs[logs.length - 1];
  if (last === undefined) {
    throw new Error(`CLI produced no stdout envelope (exit ${code})`);
  }
  return {
    code,
    envelope: JSON.parse(last) as Record<string, any>,
    stdout: logs.join('\n'),
  };
}

function entries(root: string): string[] {
  return fs.readdirSync(root).sort();
}

/**
 * Async 变体：gate 域 handler 是 async（proofloopCli 对 gate 域返回
 * Promise<number>），await 后才恢复 console spy，与 runCli 同构捕获
 * 唯一的 canonical envelope。
 */
async function runCliAsync(
  argv: readonly string[],
  opts: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<CliRun> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
    logs.push(String(message));
  });
  let code: number;
  try {
    code = (await proofloopCli(argv, opts)) as number;
  } finally {
    spy.mockRestore();
  }
  const last = logs[logs.length - 1];
  if (last === undefined) {
    throw new Error(`CLI produced no stdout envelope (exit ${code})`);
  }
  return {
    code,
    envelope: JSON.parse(last) as Record<string, any>,
    stdout: logs.join('\n'),
  };
}

// ============================================================
// Closed registry (§0.3)
// ============================================================

describe('proofloop closed registry (S10-A-T01)', () => {
  it('registers the §0.3 closed domain matrix exactly (10 domains, cutover added by S10-E-T02 repair)', () => {
    expect(CANONICAL_DOMAINS).toEqual([
      'authority',
      'plan',
      'context',
      'stage',
      'review',
      'project',
      'doctor',
      'gate',
      'recovery',
      'cutover',
    ]);
  });

  it('registers the §0.3 closed operation set per domain', () => {
    expect(DOMAIN_REGISTRY.authority.operations).toEqual(['check']);
    expect(DOMAIN_REGISTRY.plan.operations).toEqual([
      'materialize',
      'compile',
      'validate',
      'initialize-evidence',
      'refresh-evidence',
      'status',
      'admit-spv',
      'admit-stage-plan',
    ]);
    expect(DOMAIN_REGISTRY.context.operations).toEqual([
      'prepare',
      'show',
      'admit-refutation-observation',
    ]);
    expect(DOMAIN_REGISTRY.stage.operations).toEqual([
      'status',
      'next',
      'admit-worker',
      'admit-cv',
      'admit-slice-commit',
      'admit-integration',
      'run-gate',
      // P-11: stage close（vNext Stage Close admission public CLI 入口）。
      'close',
    ]);
    expect(DOMAIN_REGISTRY.review.operations).toEqual(['status', 'prepare-stage', 'finalize-stage']);
    expect(DOMAIN_REGISTRY.project.operations).toEqual([
      'status',
      'compile-acceptance',
      'run-e2e',
      'prepare-review',
      'finalize-review',
    ]);
    // S10-D-T03: doctor 域补 run/status 闭集完整语义。
    expect(DOMAIN_REGISTRY.doctor.operations).toEqual(['run', 'status']);
    expect(DOMAIN_REGISTRY.gate.operations).toEqual(['run', 'status']);
    // S10-D-T03: recovery 域 closed 操作集（check/preflight/restart/doctor）。
    expect(DOMAIN_REGISTRY.recovery.operations).toEqual([
      'check',
      'preflight',
      'restart',
      'doctor',
    ]);
    // S10-E-T02 repair: cutover 域 closed 操作集（status/execute）。
    expect(DOMAIN_REGISTRY.cutover.operations).toEqual(['status', 'execute']);
  });
});

// ============================================================
// Dispatcher: fail-closed domain/op + exit contract
// ============================================================

describe('proofloop dispatcher fail-closed (S10-A-T01)', () => {
  it('unknown domain exits 2 with a canonical RUNTIME.SCHEMA_MISMATCH envelope and writes nothing', () => {
    const root = gitRoot();
    const before = entries(root);
    const { code, envelope } = runCli(['bogus-domain', 'run'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toEqual({ domain: 'bogus-domain', operation: 'run' });
    expect(envelope.result).toBeNull();
    expect(envelope.findings).toHaveLength(1);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.findings[0].message).toContain('unknown domain');
    expect(Array.isArray(envelope.refs)).toBe(true);
    expect(envelope.refs).toEqual([]);
    expect(envelope.runtime.schema_version).toBe(2);
    // no-write: the trust root stays untouched (fixture's own .git excluded)
    expect(entries(root)).toEqual(before);
  });

  it('unknown operation in a closed domain exits 2 with RUNTIME.SCHEMA_MISMATCH', () => {
    const { code, envelope } = runCli(['stage', 'bogus-op'], { cwd: gitRoot() });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.findings[0].message).toContain('unknown operation');
  });

  it('a closed stage operation without a target stage fails closed with STAGE.STAGE_REQUIRED (exit 2, no write)', () => {
    const root = gitRoot();
    const before = entries(root);
    const { code, envelope } = runCli(['stage', 'status'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('STAGE.STAGE_REQUIRED');
    expect(envelope.command).toEqual({ domain: 'stage', operation: 'status' });
    expect(entries(root)).toEqual(before);
  });

  it('a closed gate operation that is not in the gate set (run|status) exits 2 with RUNTIME.SCHEMA_MISMATCH (no write)', () => {
    const root = gitRoot();
    const before = entries(root);
    const { code, envelope } = runCli(['gate', 'bogus', '--json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.findings[0].message).toContain('unknown operation');
    expect(envelope.command).toEqual({ domain: 'gate', operation: 'bogus' });
    expect(entries(root)).toEqual(before);
  });

  it('a closed gate operation without a target stage fails closed with STAGE.STAGE_REQUIRED (exit 2, no write)', async () => {
    const root = gitRoot();
    const before = entries(root);
    const { code, envelope } = await runCliAsync(['gate', 'status'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('STAGE.STAGE_REQUIRED');
    expect(envelope.findings[0].message).toContain('target stage');
    expect(envelope.command).toEqual({ domain: 'gate', operation: 'status' });
    expect(entries(root)).toEqual(before);
  });

  it('no arguments exits 1 with a USAGE finding (single envelope on stdout)', () => {
    const { code, envelope } = runCli([], { cwd: gitRoot() });
    expect(code).toBe(CLI_EXIT.USAGE);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('USAGE');
    expect(envelope.findings[0].message.toLowerCase()).toContain('usage:');
  });

  it('an unknown flag exits 1 with a USAGE finding (closed input, unknown field)', () => {
    const { code, envelope } = runCli(['--bogus-flag', 'x'], { cwd: gitRoot() });
    expect(code).toBe(CLI_EXIT.USAGE);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('USAGE');
  });

  it('--help exits 0 with an ok envelope exposing usage and the closed domain list', () => {
    const { code, envelope } = runCli(['--help'], { cwd: gitRoot() });
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: null, operation: null });
    expect(envelope.result.usage).toContain('proofloop <domain> <operation>');
    expect(envelope.result.domains).toEqual(CANONICAL_DOMAINS);
    expect(envelope.findings).toEqual([]);
  });

  it('--version exits 0 with ok envelope and version/runtime info', () => {
    const { code, envelope } = runCli(['--version'], { cwd: gitRoot() });
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(typeof envelope.result.version).toBe('string');
    expect(envelope.result.version.length).toBeGreaterThan(0);
    expect(typeof envelope.runtime.version).toBe('string');
    expect(envelope.runtime.schema_version).toBe(2);
  });
});

// ============================================================
// Root assertion
// ============================================================

describe('proofloop root assertion (S10-A-T01)', () => {
  it('resolves the canonical trust root upward from a git/.proofloop marker', () => {
    const root = gitRoot();
    const resolved = resolveTrustRoot({ cwd: root });
    expect(resolved.root).toBe(fs.realpathSync(root));
    expect(resolved.source).toBe('auto');
    // a nested cwd still resolves to the project root
    fs.mkdirSync(path.join(root, 'packages'));
    const nested = resolveTrustRoot({ cwd: path.join(root, 'packages') });
    expect(nested.root).toBe(fs.realpathSync(root));
    expect(nested.source).toBe('auto');
  });

  it('a .proofloop directory is an accepted trust-root marker', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.proofloop'));
    fs.mkdirSync(path.join(root, 'sub', 'dir'), { recursive: true });
    const resolved = resolveTrustRoot({ cwd: path.join(root, 'sub', 'dir') });
    expect(resolved.root).toBe(fs.realpathSync(root));
  });

  it('fails closed when cwd is not inside any trust-rooted project and no explicit root is given', () => {
    const bare = tempRoot();
    const { code, envelope } = runCli(['doctor', 'run'], { cwd: bare });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.PROJECT_ROOT_NOT_RESOLVED');
  });

  it('accepts an explicit --project-root as the canonical trust root', () => {
    const root = gitRoot();
    const bare = tempRoot();
    const { code, envelope } = runCli(['stage', 'status', '--project-root', root], { cwd: bare });
    // root resolution succeeded; the op fails closed because no target stage is given
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.findings[0].code).toBe('STAGE.STAGE_REQUIRED');
  });

  it('accepts the --root alias for the explicit trust root', () => {
    const root = gitRoot();
    const bare = tempRoot();
    const { code, envelope } = runCli(['stage', 'status', '--root', root], { cwd: bare });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.findings[0].code).toBe('STAGE.STAGE_REQUIRED');
  });

  it('fails closed when an explicit root conflicts with the auto-resolved canonical root', () => {
    const root = gitRoot();
    const other = gitRoot();
    const { code, envelope } = runCli(['doctor', 'run', '--project-root', other], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.PROJECT_ROOT_MISMATCH');
  });

  it('honors the PROOFLOOP_ROOT environment variable as the explicit trust root', () => {
    const root = gitRoot();
    const bare = tempRoot();
    const { code, envelope } = runCli(['stage', 'status'], {
      cwd: bare,
      env: { PROOFLOOP_ROOT: root },
    });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.findings[0].code).toBe('STAGE.STAGE_REQUIRED');
  });

  it('rejects an explicit root that is not an existing directory', () => {
    const bare = tempRoot();
    const { code, envelope } = runCli(['doctor', 'run', '--project-root', path.join(bare, 'nope')], {
      cwd: bare,
    });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.PROJECT_ROOT_NOT_RESOLVED');
  });
});

// ============================================================
// Request-file / JSON input base parsing (T02 delivers full behavior)
// ============================================================

describe('proofloop request input base (S10-A-T01)', () => {
  it('validates --request as a root-bound path before any handler runs', () => {
    const root = gitRoot();
    const { code, envelope } = runCli(['stage', 'status', '--request', '../escape.json'], {
      cwd: root,
    });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.PATH_OUTSIDE_ROOT');
  });

  it('validates --json as parseable closed JSON input', () => {
    const root = gitRoot();
    const { code, envelope } = runCli(['stage', 'status', '--json', 'not-json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
  });

  it('unknown domain fails closed BEFORE any request input read (fail fast, no file access)', () => {
    const root = gitRoot();
    const { code, envelope } = runCli(['bogus-domain', 'op', '--request', 'missing-file.json'], {
      cwd: root,
    });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.findings[0].message).toContain('unknown domain');
  });
});

// ============================================================
// Request-file / JSON input closed schema (S10-A-T02)
// ============================================================

describe('proofloop request input closed schema (S10-A-T02)', () => {
  it('--request file with a matching closed request passes validation (op fails closed without a target stage)', () => {
    const root = gitRoot();
    fs.writeFileSync(
      path.join(root, 'request.json'),
      JSON.stringify({ domain: 'stage', operation: 'status' }),
    );
    const { code, envelope } = runCli(['stage', 'status', '--request', 'request.json'], {
      cwd: root,
    });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('STAGE.STAGE_REQUIRED');
  });

  it('--request file with an unknown field fails closed with RUNTIME.INPUT_INVALID (exit 2)', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ domain: 'stage', extra: 1 }));
    const { code, envelope } = runCli(['stage', 'status', '--request', 'request.json'], {
      cwd: root,
    });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('unknown field');
  });

  it('--request domain conflicting with the positionals fails closed with RUNTIME.INPUT_INVALID', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ domain: 'doctor' }));
    const { code, envelope } = runCli(['stage', 'status', '--request', 'request.json'], {
      cwd: root,
    });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('does not match');
  });

  it('--request and --json together fail closed (mutually exclusive input modes)', () => {
    const root = gitRoot();
    const { code, envelope } = runCli(
      ['stage', 'status', '--request', 'request.json', '--json', '{"domain":"stage"}'],
      { cwd: root },
    );
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('mutually exclusive');
  });

  it('a missing --request file fails closed with RUNTIME.INPUT_INVALID (exit 2)', () => {
    const root = gitRoot();
    const { code, envelope } = runCli(['stage', 'status', '--request', 'nope.json'], {
      cwd: root,
    });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
  });

  it('--json inline object with an unknown field fails closed with RUNTIME.INPUT_INVALID', () => {
    const root = gitRoot();
    const { code, envelope } = runCli(
      ['stage', 'status', '--json', '{"domain":"stage","bogus":1}'],
      { cwd: root },
    );
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('unknown field');
  });

  it('--json inline object matching the command passes validation (op fails closed without a target stage)', () => {
    const root = gitRoot();
    const { code, envelope } = runCli(
      ['stage', 'status', '--json', '{"domain":"stage","operation":"status"}'],
      { cwd: root },
    );
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('STAGE.STAGE_REQUIRED');
  });

  it('bare --json flag without a value is accepted (JSON output mode, no input)', () => {
    const root = gitRoot();
    const { code, envelope } = runCli(['stage', 'status', '--json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('STAGE.STAGE_REQUIRED');
  });
});

// ============================================================
// Closed positional count (CV repair: extra positionals must fail closed)
// ============================================================

describe('proofloop closed positional count (CV repair S10-A)', () => {
  it('an extra positional beyond <domain> <operation> fails closed with exit 2 before any handler runs', () => {
    const root = gitRoot();
    const before = entries(root);
    const { code, envelope } = runCli(['doctor', 'run', 'extra'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.findings[0].message).toContain('too many positional');
    expect(entries(root)).toEqual(before);
  });

  it('every closed domain rejects an extra positional with exit 2 + RUNTIME.SCHEMA_MISMATCH', () => {
    const root = gitRoot();
    for (const domain of CANONICAL_DOMAINS) {
      const operation = DOMAIN_REGISTRY[domain].operations[0];
      const { code, envelope } = runCli([domain, operation, 'extra'], { cwd: root });
      expect(code, `${domain} extra positional`).toBe(CLI_EXIT.BLOCKED);
      expect(envelope.ok).toBe(false);
      expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.findings[0].message).toContain('too many positional');
    }
  });

  it('multiple extra positionals are rejected the same way', () => {
    const root = gitRoot();
    const { code, envelope } = runCli(['plan', 'status', 'a', 'b', 'c'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });

  it('missing positionals keep the USAGE exit 1 contract (unchanged)', () => {
    const root = gitRoot();
    const { code, envelope } = runCli(['doctor'], { cwd: root });
    expect(code).toBe(CLI_EXIT.USAGE);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('USAGE');
  });
});

// ============================================================
// Request path root-relative contract (CV repair)
// ============================================================

describe('proofloop request root-relative contract (CV repair S10-A)', () => {
  it('an absolute --request path is refused even when it lies inside the trust root', () => {
    const root = gitRoot();
    fs.writeFileSync(
      path.join(root, 'request.json'),
      JSON.stringify({ domain: 'doctor', operation: 'run' }),
    );
    const { code, envelope } = runCli(['doctor', 'run', '--request', path.join(root, 'request.json')], {
      cwd: root,
    });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message.toLowerCase()).toContain('root-relative');
  });

  it('a root-relative --request path stays accepted', () => {
    const root = gitRoot();
    fs.writeFileSync(
      path.join(root, 'request.json'),
      JSON.stringify({ domain: 'doctor', operation: 'run' }),
    );
    const { code, envelope } = runCli(['doctor', 'run', '--request', 'request.json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
  });
});

// ============================================================
// Canonical JSON serialization (CV repair)
// ============================================================

describe('canonical envelope serialization (CV repair S10-A)', () => {
  function captureEmit(envelope: ReturnType<typeof okEnvelope>): string {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    try {
      emitEnvelope(envelope);
    } finally {
      spy.mockRestore();
    }
    return logs.join('\n');
  }

  it('logically equal results with different property insertion order produce byte-identical stdout', () => {
    const command = { domain: 'doctor', operation: 'run' };
    const first: Record<string, unknown> = {};
    first['z'] = 1;
    first['a'] = { y: [1, { q: 2, p: 3 }], b: 'x' };
    const second: Record<string, unknown> = {};
    second['a'] = { b: 'x', y: [1, { p: 3, q: 2 }] };
    second['z'] = 1;
    // independent oracle: the objects are deep-equal but stringify differently
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));

    const out1 = captureEmit(okEnvelope(command, first));
    const out2 = captureEmit(okEnvelope(command, second));
    expect(out1).toBe(out2);
    expect(out1.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
  });

  it('canonicalStringify sorts object keys recursively and preserves array order', () => {
    const value = { b: 2, a: [{ y: 1, x: 0 }], c: null };
    expect(canonicalStringify(value)).toBe('{"a":[{"x":0,"y":1}],"b":2,"c":null}');
  });

  it('arrays keep element order and nested objects are canonicalized', () => {
    const value = { list: [{ q: 2, p: 1 }, { p: 3, q: 4 }] };
    const out = canonicalStringify(value);
    expect(out).toBe('{"list":[{"p":1,"q":2},{"p":3,"q":4}]}');
  });
});

// ============================================================
// bin registration
// ============================================================

describe('proofloop bin registration (S10-A-T01)', () => {
  it('packages/runtime/package.json registers the proofloop bin', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'packages', 'runtime', 'package.json'), 'utf8'),
    ) as { bin?: Record<string, string> };
    expect(pkg.bin).toEqual({ proofloop: 'dist/cli/proofloop.js' });
  });
});

// ============================================================
// Built process smoke (source/dist 同构, §0.1)
// ============================================================

describe('built proofloop dist process (S10-A-T01)', () => {
  it('dist proofloop.js: unknown domain exits 2 with a single canonical envelope on stdout', () => {
    expect(fs.existsSync(DIST_PROOFLOOP)).toBe(true);
    const root = gitRoot();
    const res = spawnSync(process.execPath, [DIST_PROOFLOOP, 'bogus-domain', 'run'], {
      encoding: 'utf-8',
      cwd: root,
      timeout: 30000,
    });
    expect(res.status).toBe(2);
    const out = JSON.parse(res.stdout.trim()) as { ok: boolean; findings: Array<{ code: string }> };
    expect(out.ok).toBe(false);
    expect(out.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });

  it('dist proofloop.js: --version exits 0 with an ok canonical envelope', () => {
    expect(fs.existsSync(DIST_PROOFLOOP)).toBe(true);
    const root = gitRoot();
    const res = spawnSync(process.execPath, [DIST_PROOFLOOP, '--version'], {
      encoding: 'utf-8',
      cwd: root,
      timeout: 30000,
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim()) as { ok: boolean; result: { version: string } };
    expect(out.ok).toBe(true);
    expect(out.result.version.length).toBeGreaterThan(0);
  });
});
