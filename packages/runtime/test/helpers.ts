/**
 * Minimal temp-Git-fixture helpers for the boundary-repair tests.
 *
 * These create an isolated throwaway Git repository on disk and exercise only
 * mechanical Git commands (git init, config, add, commit, mv) against that
 * fixture — never against the ProofLoop work clone itself. All git commands
 * here are test-only and permitted by the task ("只可在临时 Git fixture 中执行
 * 测试性 Git 命令").
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface Fixture {
  readonly dir: string;
  run(args: readonly string[], opts?: { cwd?: string }): string;
  write(relative: string, content: string): string;
  head(): string;
  cleanup(): void;
}

export function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-boundary-'));
  const git = (args: readonly string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  // Mirror the ProofLoop root .gitignore so Runtime artifacts under
  // .proofloop/ are ignored and never surface as dirty/untracked.
    fs.writeFileSync(path.join(dir, '.gitignore'), '.proofloop/\n', 'utf8');;
  return {
    dir,
    run: git,
    write(relative: string, content: string): string {
      const abs = path.join(dir, relative);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return relative;
    },
    head(): string {
      return git(['rev-parse', 'HEAD']).trim();
    },
    cleanup(): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Stage+commit a set of files in the fixture and return the new HEAD. */
export function commitAll(fixture: Fixture, message: string): string {
  fixture.run(['add', '-A']);
  fixture.run(['commit', '-q', '-m', message]);
  return fixture.head();
}

/** Return the raw porcelain status (space-separated, sorted) for the fixture. */
export function porcelain(fixture: Fixture): string {
  return fixture
    .run(['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .filter((line) => line.length > 0)
    .sort()
    .join('|');
}

/** Return a deterministic pseudo-SHA for the given seed (used for digest tests). */
export function sha(seed: string): string {
  // A lowercase 64-char hex string derived from the seed.
  const digits = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < seed.length; i++) out += digits[(seed.charCodeAt(i) + i) % 16];
  while (out.length < 64) out += out;
  return out.slice(0, 64);
}