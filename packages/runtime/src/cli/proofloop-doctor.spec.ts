/**
 * proofloop-doctor.spec.ts — S10-A-T02: doctor domain handler.
 *
 * PO binding (REF-S10-A-T02 / REF-CLI-ACCEPTANCE Acceptance A+D / REF-CLI-SEAM
 * §0.3 doctor 域): doctor 域从同一 public CLI 调用，closed 操作集 `run`，
 * 输出 --json canonical envelope（版本、Git 状态 HEAD/clean、trust root、
 * receipt schema version、基本状态报告）；read-only，不写任何文件；Runtime
 * Proof step 形态 `doctor run --json` 期望 exit 0。Risk REF-S08E-RISK —
 * cross_process_behavior / snapshot 一致性。
 *
 * 本 spec 覆盖：doctor run 的 canonical envelope 与 structured diagnostics、
 * read-only 不变性、非 git 仓库降级报告、dirty 工作树、裸 `--json` flag、
 * --request/--json closed input 一致性、request 非法输入 fail closed、
 * built dist 进程 smoke（Runtime Proof `doctor run --json` 形态）。
 */

import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { proofloopCli } from './proofloop';
import { CLI_EXIT } from './proofloop-common';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_PROOFLOOP = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'proofloop.js');

// ============================================================
// Fixture helpers
// ============================================================

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-doctor-'));
}

function gitRoot(): string {
  const root = tempRoot();
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'doctor@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Doctor Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  return root;
}

function commitAll(root: string, message = 'fixture'): string {
  fs.writeFileSync(path.join(root, 'README.md'), 'doctor fixture\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function proofloopMarkerRoot(): string {
  // trust root anchored by `.proofloop` marker but NOT a git repository
  const root = tempRoot();
  fs.mkdirSync(path.join(root, '.proofloop'));
  fs.mkdirSync(path.join(root, '.proofloop', 'manifests'), { recursive: true });
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

/**
 * Recursive byte-level snapshot (CV repair): file path + sha256 content
 * digest + mode (and symlink target) for EVERY entry, including the .git
 * internals.  Two snapshots of the same tree are compared as strings.
 */
function recursiveSnapshot(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        lines.push(`D ${rel}`);
        walk(full);
      } else if (stat.isSymbolicLink()) {
        lines.push(`L ${rel} -> ${fs.readlinkSync(full)}`);
      } else if (stat.isFile()) {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        const mode = stat.mode & 0o777;
        lines.push(`F ${rel} ${digest} ${mode}`);
      } else {
        lines.push(`O ${rel}`);
      }
    }
  };
  walk(root);
  return lines.join('\n');
}

// ============================================================
// doctor run — canonical envelope + structured diagnostics
// ============================================================

describe('proofloop doctor run (S10-A-T02)', () => {
  it('doctor run exits 0 with an ok canonical envelope and structured diagnostics', () => {
    const root = gitRoot();
    const head = commitAll(root);
    const { code, envelope } = runCli(['doctor', 'run'], { cwd: root });
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'doctor', operation: 'run' });
    expect(envelope.findings).toEqual([]);
    expect(Array.isArray(envelope.refs)).toBe(true);
    expect(envelope.runtime.schema_version).toBe(2);
    // structured diagnostics: trust root
    expect(envelope.result.project_root).toBe(fs.realpathSync(root));
    expect(envelope.result.root_source).toBe('auto');
    // structured diagnostics: git state (HEAD / clean)
    expect(envelope.result.git.available).toBe(true);
    expect(envelope.result.git.head).toBe(head);
    expect(envelope.result.git.clean).toBe(true);
    expect(typeof envelope.result.git.root).toBe('string');
    // structured diagnostics: versions / schema
    expect(typeof envelope.result.runtime_version).toBe('string');
    expect(envelope.result.runtime_version.length).toBeGreaterThan(0);
    expect(envelope.result.cli_schema_version).toBe(2);
    expect(envelope.result.receipt_schema_version).toBe(2);
    // basic state report (read-only)
    expect(envelope.result.state.read_only).toBe(true);
    expect(Array.isArray(envelope.result.state.operations)).toBe(true);
    expect(envelope.result.state.operations).toContain('run');
    expect(typeof envelope.result.capabilities).toBe('object');
  });

  it('doctor run is read-only: no file is written under the trust root (recursive, incl. .git internals)', () => {
    const root = gitRoot();
    commitAll(root);
    // warm-up: let git settle its index stat cache so the CLI's read-only git
    // probes do not refresh .git/index between snapshots
    runCli(['doctor', 'run'], { cwd: root });
    const before = recursiveSnapshot(root);
    const { code, envelope } = runCli(['doctor', 'run'], { cwd: root });
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(recursiveSnapshot(root)).toBe(before);
  });

  it('doctor run reports a dirty worktree as git.clean=false with porcelain entries', () => {
    const root = gitRoot();
    commitAll(root);
    fs.writeFileSync(path.join(root, 'uncommitted.txt'), 'dirty\n');
    const { code, envelope } = runCli(['doctor', 'run'], { cwd: root });
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.git.clean).toBe(false);
    expect(Array.isArray(envelope.result.git.porcelain)).toBe(true);
    expect(envelope.result.git.porcelain.some((line: string) => line.includes('uncommitted.txt'))).toBe(true);
  });

  it('doctor run degrades gracefully in a non-git trust root (.proofloop marker only)', () => {
    const root = proofloopMarkerRoot();
    const { code, envelope } = runCli(['doctor', 'run'], { cwd: root });
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.git.available).toBe(false);
    expect(envelope.result.capabilities.proofloop_dir).toBe(true);
    expect(envelope.result.capabilities.manifests_dir).toBe(true);
    // still read-only
    expect(envelope.result.state.read_only).toBe(true);
  });

  it('doctor run accepts the bare --json flag (JSON output mode, no value)', () => {
    const root = gitRoot();
    commitAll(root);
    const { code, envelope } = runCli(['doctor', 'run', '--json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toEqual({ domain: 'doctor', operation: 'run' });
    expect(envelope.result.git.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('doctor run honors an explicit --project-root as the canonical trust root', () => {
    const root = gitRoot();
    commitAll(root);
    const bare = tempRoot();
    const { code, envelope } = runCli(['doctor', 'run', '--project-root', root], { cwd: bare });
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.project_root).toBe(fs.realpathSync(root));
    expect(envelope.result.root_source).toBe('explicit');
  });
});

// ============================================================
// doctor run — request-file / JSON input closed schema
// ============================================================

describe('proofloop doctor request input closed schema (S10-A-T02)', () => {
  it('--request file with a matching closed request {domain,operation} is accepted', () => {
    const root = gitRoot();
    commitAll(root);
    fs.writeFileSync(
      path.join(root, 'request.json'),
      JSON.stringify({ domain: 'doctor', operation: 'run' }),
    );
    const { code, envelope } = runCli(['doctor', 'run', '--request', 'request.json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.git.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('--request file with an unknown field fails closed with RUNTIME.INPUT_INVALID (exit 2)', () => {
    const root = gitRoot();
    commitAll(root);
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ domain: 'doctor', extra: 1 }));
    const { code, envelope } = runCli(['doctor', 'run', '--request', 'request.json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('unknown field');
  });

  it('--request file whose domain conflicts with the positionals fails closed', () => {
    const root = gitRoot();
    commitAll(root);
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ domain: 'stage' }));
    const { code, envelope } = runCli(['doctor', 'run', '--request', 'request.json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('does not match');
  });

  it('--request file whose operation conflicts with the positionals fails closed', () => {
    const root = gitRoot();
    commitAll(root);
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ operation: 'status' }));
    const { code, envelope } = runCli(['doctor', 'run', '--request', 'request.json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('does not match');
  });

  it('a missing --request file fails closed with RUNTIME.INPUT_INVALID (exit 2)', () => {
    const root = gitRoot();
    commitAll(root);
    const { code, envelope } = runCli(['doctor', 'run', '--request', 'nope.json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
  });

  it('a --request file that is not valid JSON fails closed with RUNTIME.INPUT_INVALID', () => {
    const root = gitRoot();
    commitAll(root);
    fs.writeFileSync(path.join(root, 'request.json'), 'not-json');
    const { code, envelope } = runCli(['doctor', 'run', '--request', 'request.json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message.toLowerCase()).toContain('json');
  });

  it('a --request symlink escaping the root fails closed with RUNTIME.PATH_OUTSIDE_ROOT', () => {
    const root = gitRoot();
    commitAll(root);
    const outside = tempRoot();
    fs.writeFileSync(path.join(outside, 'escape.json'), JSON.stringify({ domain: 'doctor' }));
    fs.symlinkSync(path.join(outside, 'escape.json'), path.join(root, 'link.json'));
    const { code, envelope } = runCli(['doctor', 'run', '--request', 'link.json'], { cwd: root });
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.PATH_OUTSIDE_ROOT');
  });

  it('--request and --json together fail closed (mutually exclusive input modes)', () => {
    const root = gitRoot();
    commitAll(root);
    const { code, envelope } = runCli(
      ['doctor', 'run', '--request', 'request.json', '--json', '{"domain":"doctor"}'],
      { cwd: root },
    );
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('mutually exclusive');
  });

  it('--json inline object with an unknown field fails closed with RUNTIME.INPUT_INVALID', () => {
    const root = gitRoot();
    commitAll(root);
    const { code, envelope } = runCli(
      ['doctor', 'run', '--json', '{"domain":"doctor","bogus":1}'],
      { cwd: root },
    );
    expect(code).toBe(CLI_EXIT.BLOCKED);
    expect(envelope.ok).toBe(false);
    expect(envelope.findings[0].code).toBe('RUNTIME.INPUT_INVALID');
    expect(envelope.findings[0].message).toContain('unknown field');
  });

  it('--json inline object matching the command is accepted', () => {
    const root = gitRoot();
    commitAll(root);
    const { code, envelope } = runCli(
      ['doctor', 'run', '--json', '{"domain":"doctor","operation":"run"}'],
      { cwd: root },
    );
    expect(code).toBe(CLI_EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.git.head).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ============================================================
// Built process smoke — Runtime Proof `doctor run --json` shape
// ============================================================

describe('built proofloop doctor dist process (S10-A-T02)', () => {
  it('dist proofloop.js doctor run --json exits 0 with a single canonical envelope', () => {
    expect(fs.existsSync(DIST_PROOFLOOP)).toBe(true);
    const root = gitRoot();
    commitAll(root);
    const res = spawnSync(process.execPath, [DIST_PROOFLOOP, 'doctor', 'run', '--json'], {
      encoding: 'utf-8',
      cwd: root,
      timeout: 30000,
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    const out = JSON.parse(res.stdout.trim()) as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.command).toEqual({ domain: 'doctor', operation: 'run' });
    expect(out.result.project_root).toBe(fs.realpathSync(root));
    expect(out.result.git.head).toMatch(/^[0-9a-f]{40}$/);
    expect(out.result.git.clean).toBe(true);
    expect(out.result.receipt_schema_version).toBe(2);
  });
});
