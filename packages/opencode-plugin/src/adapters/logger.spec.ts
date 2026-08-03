/**
 * LoggerAdapter — trust-root boundary on file persistence (S2-F-003)
 *
 * The logger persists every structured diagnostic entry to
 * `<projectRoot>/.proofloop/logs/`. When `projectRoot` is supplied (the host
 * runtime context always supplies it), a `logsDir` — or the per-session log
 * file inside it — whose canonical path escapes the project root must NEVER be
 * created or appended to: a symlinked `.proofloop/logs` pointing outside the
 * worktree would otherwise let the logger write outside the read-only/no-write
 * boundary. Escapes fail closed exactly like other persistence failures
 * (`fileHealthy: false`, `logRef: undefined`, never a fake persisted claim).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLoggerAdapter } from './logger.js';

// Inode-mismatch / stat-error injection (S2-F-003 final supplement + stat-error
// fix): mock `node:fs` so the pre-append `statSync` can be (a) fabricated with
// a DIFFERENT dev/ino than the real file (simulating the canonical log file
// being replaced between the expectation capture and the open) or (b) forced to
// throw a non-ENOENT error (EIO/EACCES — simulating an unreadable expected
// identity that must fail closed). The mock is transparent (`...real`) except
// when a toggle is set.
const inodeState = vi.hoisted(() => ({
  mismatchPath: undefined as string | undefined,
  statErrorPath: undefined as string | undefined,
  statErrorCode: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    statSync: ((p: fs.PathLike, _opts?: fs.StatOptions | undefined) => {
      if (
        inodeState.statErrorPath !== undefined &&
        inodeState.statErrorCode !== undefined &&
        String(p) === inodeState.statErrorPath
      ) {
        const err = new Error('injected statSync error') as NodeJS.ErrnoException;
        err.code = inodeState.statErrorCode;
        throw err;
      }
      const st = real.statSync(p as string);
      if (inodeState.mismatchPath !== undefined && String(p) === inodeState.mismatchPath) {
        return { ...st, dev: st.dev + 1, ino: st.ino + 1 } as fs.Stats;
      }
      return st;
    }) as unknown as typeof real.statSync,
  };
});

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function makeRoot(prefix = 'proofloop-logger-guard-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });
  return root;
}

function makeExternal(prefix = 'proofloop-logger-outside-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });
  return dir;
}

describe('logger file persistence trust-root boundary (S2-F-003)', () => {
  it('writes normally when .proofloop/logs stays inside the project root', () => {
    const root = makeRoot();
    const logger = createLoggerAdapter(() => undefined, 'test-service', {
      projectRoot: root,
      logsDir: path.join(root, '.proofloop', 'logs'),
    });

    logger.info('hello');

    expect(logger.persisted).toBe(true);
    expect(logger.fileHealthy).toBe(true);
    expect(logger.logRef).toMatch(/^\.proofloop\/logs\/doctor-.*\.log$/);
    expect(fs.existsSync(path.join(root, logger.logRef as string))).toBe(true);
  });

  it('fails closed and NEVER writes outside when .proofloop/logs is a symlink to an external dir', () => {
    const root = makeRoot();
    const external = makeExternal();
    fs.mkdirSync(path.join(root, '.proofloop'), { recursive: true });
    fs.symlinkSync(external, path.join(root, '.proofloop', 'logs'), 'dir');

    const logger = createLoggerAdapter(() => undefined, 'test-service', {
      projectRoot: root,
      logsDir: path.join(root, '.proofloop', 'logs'),
    });

    logger.info('should not leak');

    expect(logger.persisted).toBe(true);
    expect(logger.fileHealthy).toBe(false);
    expect(logger.logRef).toBeUndefined();
    // The external directory must contain NO log file (nothing was written
    // outside the trust root).
    expect(fs.readdirSync(external)).toHaveLength(0);
  });

  it('fails closed when logsDir itself is an absolute path outside the root', () => {
    const root = makeRoot();
    const external = makeExternal();

    const logger = createLoggerAdapter(() => undefined, 'test-service', {
      projectRoot: root,
      logsDir: external,
    });

    logger.info('should not leak');

    expect(logger.fileHealthy).toBe(false);
    expect(logger.logRef).toBeUndefined();
    expect(fs.readdirSync(external)).toHaveLength(0);
  });

  it('fails closed when the log file path (pre-existing symlink) escapes the root', () => {
    // Freeze the clock so the adapter's generated log filename is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const root = makeRoot();
      const external = makeExternal();
      const logsDir = path.join(root, '.proofloop', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(external, 'outside.log'), 'outside', 'utf-8');
      // Plant a symlinked log file at the exact name the adapter will generate
      // (doctor-<frozen ISO timestamp with : and . replaced by ->.log).
      const planted = path.join(logsDir, 'doctor-2026-01-01T00-00-00-000Z.log');
      fs.symlinkSync(path.join(external, 'outside.log'), planted);

      const logger = createLoggerAdapter(() => undefined, 'test-service', {
        projectRoot: root,
        logsDir,
      });

      logger.info('redirect attempt');

      expect(logger.fileHealthy).toBe(false);
      expect(logger.logRef).toBeUndefined();
      // The external target was NOT appended to.
      expect(fs.readFileSync(path.join(external, 'outside.log'), 'utf-8')).toBe('outside');
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes normally when no projectRoot is supplied (no trust boundary to enforce)', () => {
    const root = makeRoot();
    const logsDir = path.join(root, 'logs');
    const logger = createLoggerAdapter(() => undefined, 'test-service', { logsDir });

    logger.info('ok');

    expect(logger.fileHealthy).toBe(true);
    expect(logger.logRef).toBeDefined();
    expect(fs.existsSync(path.join(root, 'logs', path.basename(logger.logRef as string)))).toBe(true);
  });

  it('appends to the CANONICAL logs dir: a lexical symlink swap after creation cannot redirect the write (S2-F-003 round 2)', () => {
    const root = makeRoot();
    const external = makeExternal();
    // logsDir is reached through an IN-ROOT symlink, so its canonical realpath
    // (root/real/logs) differs from its lexical path (root/link/logs).
    const realDir = path.join(root, 'real');
    fs.mkdirSync(realDir, { recursive: true });
    const link = path.join(root, 'link');
    fs.symlinkSync(realDir, link, 'dir');
    const logsDir = path.join(link, 'logs');

    const logger = createLoggerAdapter(() => undefined, 'test-service', {
      projectRoot: root,
      logsDir,
    });

    logger.info('first');
    expect(logger.fileHealthy).toBe(true);
    // The first write landed in the canonical directory (root/real/logs).
    const canonicalFile = path.join(realDir, 'logs', path.basename(logger.logRef as string));
    expect(fs.existsSync(canonicalFile)).toBe(true);

    // Now swap the LEXICAL logsDir to a symlink pointing outside the root. The
    // canonical dir (root/real/logs) stays intact.
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(external, link, 'dir');

    logger.info('second');

    // The append still targeted the canonical file, never the external dir.
    expect(logger.fileHealthy).toBe(true);
    expect(fs.readdirSync(external)).toHaveLength(0);
    const content = fs.readFileSync(canonicalFile, 'utf-8');
    expect(content).toContain('first');
    expect(content).toContain('second');
  });

  it('appends via the O_NOFOLLOW fd with correct JSONL content (S2-F-003 round 3)', () => {
    const root = makeRoot();
    const logger = createLoggerAdapter(() => undefined, 'test-service', {
      projectRoot: root,
      logsDir: path.join(root, '.proofloop', 'logs'),
    });

    logger.info('hello');
    logger.error('boom', { extra: 1 });

    expect(logger.fileHealthy).toBe(true);
    const content = fs.readFileSync(path.join(root, logger.logRef as string), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as { service: string; level: string; message: string };
    expect(first.service).toBe('test-service');
    expect(first.level).toBe('info');
    expect(first.message).toBe('hello');
    const second = JSON.parse(lines[1]) as {
      level: string;
      message: string;
      extra: Record<string, unknown>;
    };
    expect(second.level).toBe('error');
    expect(second.message).toBe('boom');
    expect(second.extra).toEqual({ extra: 1 });
  });

  it('fails closed via the O_NOFOLLOW append when the log file is a symlink (no reverify boundary applies)', () => {
    // With no projectRoot the reverify is skipped, so ONLY the O_NOFOLLOW open
    // guards the append — a symlinked log file must fail closed (ELOOP) with no
    // external byte written.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const root = makeRoot();
      const external = makeExternal();
      const logsDir = path.join(root, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(external, 'outside.log'), 'outside', 'utf-8');
      const planted = path.join(logsDir, 'doctor-2026-01-01T00-00-00-000Z.log');
      fs.symlinkSync(path.join(external, 'outside.log'), planted);

      const logger = createLoggerAdapter(() => undefined, 'test-service', { logsDir });

      logger.info('redirect attempt');

      expect(logger.fileHealthy).toBe(false);
      expect(logger.logRef).toBeUndefined();
      expect(fs.readFileSync(path.join(external, 'outside.log'), 'utf-8')).toBe('outside');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the canonical log file is swapped to an external symlink before the next append', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const root = makeRoot();
      const external = makeExternal();
      const logger = createLoggerAdapter(() => undefined, 'test-service', {
        projectRoot: root,
        logsDir: path.join(root, '.proofloop', 'logs'),
      });

      logger.info('first');
      expect(logger.fileHealthy).toBe(true);
      const canonicalFile = path.join(
        root,
        '.proofloop',
        'logs',
        'doctor-2026-01-01T00-00-00-000Z.log',
      );
      expect(fs.existsSync(canonicalFile)).toBe(true);

      // Swap the canonical log file to a symlink pointing outside.
      fs.writeFileSync(path.join(external, 'outside.log'), 'outside', 'utf-8');
      fs.rmSync(canonicalFile);
      fs.symlinkSync(path.join(external, 'outside.log'), canonicalFile);

      logger.info('second');

      // The append failed closed (reverify + O_NOFOLLOW) — no external byte.
      expect(logger.fileHealthy).toBe(false);
      expect(logger.logRef).toBeUndefined();
      expect(fs.readFileSync(path.join(external, 'outside.log'), 'utf-8')).toBe('outside');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the pre-append expected dev/ino differs from the opened fd (inode changed, S2-F-003 final supplement)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const root = makeRoot();
      const logger = createLoggerAdapter(() => undefined, 'test-service', {
        projectRoot: root,
        logsDir: path.join(root, '.proofloop', 'logs'),
      });

      logger.info('first');
      expect(logger.fileHealthy).toBe(true);
      const canonicalFile = path.join(
        root,
        '.proofloop',
        'logs',
        'doctor-2026-01-01T00-00-00-000Z.log',
      );
      expect(fs.existsSync(canonicalFile)).toBe(true);

      // Inject: the expected identity stat (before the append open) reports a
      // DIFFERENT dev/ino than the real file the O_NOFOLLOW open opens —
      // simulating the canonical file being replaced between the expectation
      // capture and the open. The append must fail closed (no 'second' write).
      inodeState.mismatchPath = canonicalFile;
      try {
        logger.info('second');
      } finally {
        inodeState.mismatchPath = undefined;
      }

      expect(logger.fileHealthy).toBe(false);
      expect(logger.logRef).toBeUndefined();
      // The second entry was never appended.
      const content = fs.readFileSync(canonicalFile, 'utf-8');
      expect(content).toContain('first');
      expect(content).not.toContain('second');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dev/ino identity matches on the normal append path (repeated appends succeed)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const root = makeRoot();
      const logger = createLoggerAdapter(() => undefined, 'test-service', {
        projectRoot: root,
        logsDir: path.join(root, '.proofloop', 'logs'),
      });

      logger.info('first');
      logger.info('second');
      logger.info('third');

      expect(logger.fileHealthy).toBe(true);
      const canonicalFile = path.join(
        root,
        '.proofloop',
        'logs',
        'doctor-2026-01-01T00-00-00-000Z.log',
      );
      const content = fs.readFileSync(canonicalFile, 'utf-8');
      expect(content).toContain('first');
      expect(content).toContain('second');
      expect(content).toContain('third');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed on a pre-placed FIFO log file WITHOUT blocking (O_NONBLOCK, S2-F-003-R3-FIFO-BLOCK-BEFORE-FSTAT)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const root = makeRoot();
      const logsDir = path.join(root, '.proofloop', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const fifoPath = path.join(logsDir, 'doctor-2026-01-01T00-00-00-000Z.log');
      // Node has no mkfifo API — use the coreutils binary in the TEST (the
      // production path never shells out). A FIFO with no reader would block an
      // O_WRONLY open forever; O_NONBLOCK makes the open fail fast (ENXIO).
      execFileSync('mkfifo', [fifoPath]);

      const logger = createLoggerAdapter(() => undefined, 'test-service', {
        projectRoot: root,
        logsDir,
      });

      logger.info('should not block or write');

      expect(logger.fileHealthy).toBe(false);
      expect(logger.logRef).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a FIFO log file even when a reader is attached (isFile before any write)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const root = makeRoot();
      const logsDir = path.join(root, '.proofloop', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const fifoPath = path.join(logsDir, 'doctor-2026-01-01T00-00-00-000Z.log');
      execFileSync('mkfifo', [fifoPath]);
      // Attach a read end in the test process so the logger's O_WRONLY open
      // SUCCEEDS (no ENXIO) — the post-open isFile check must still reject the
      // FIFO before any write.
      const readerFd = fs.openSync(
        fifoPath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
      );
      try {
        const logger = createLoggerAdapter(() => undefined, 'test-service', {
          projectRoot: root,
          logsDir,
        });

        logger.info('should not write');

        expect(logger.fileHealthy).toBe(false);
        expect(logger.logRef).toBeUndefined();
      } finally {
        fs.closeSync(readerFd);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when statSync fails with EIO before the append (no expected identity, no write)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const root = makeRoot();
      const logger = createLoggerAdapter(() => undefined, 'test-service', {
        projectRoot: root,
        logsDir: path.join(root, '.proofloop', 'logs'),
      });

      logger.info('first');
      expect(logger.fileHealthy).toBe(true);
      const canonicalFile = path.join(
        root,
        '.proofloop',
        'logs',
        'doctor-2026-01-01T00-00-00-000Z.log',
      );
      expect(fs.existsSync(canonicalFile)).toBe(true);

      // Inject a statSync EIO on the canonical file — the expected identity
      // cannot be captured, so the append must fail closed (no 'second' write).
      inodeState.statErrorPath = canonicalFile;
      inodeState.statErrorCode = 'EIO';
      try {
        logger.info('second');
      } finally {
        inodeState.statErrorPath = undefined;
        inodeState.statErrorCode = undefined;
      }

      expect(logger.fileHealthy).toBe(false);
      expect(logger.logRef).toBeUndefined();
      const content = fs.readFileSync(canonicalFile, 'utf-8');
      expect(content).toContain('first');
      expect(content).not.toContain('second');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when statSync fails with EACCES before the append (no expected identity, no write)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const root = makeRoot();
      const logger = createLoggerAdapter(() => undefined, 'test-service', {
        projectRoot: root,
        logsDir: path.join(root, '.proofloop', 'logs'),
      });

      logger.info('first');
      expect(logger.fileHealthy).toBe(true);
      const canonicalFile = path.join(
        root,
        '.proofloop',
        'logs',
        'doctor-2026-01-01T00-00-00-000Z.log',
      );
      expect(fs.existsSync(canonicalFile)).toBe(true);

      inodeState.statErrorPath = canonicalFile;
      inodeState.statErrorCode = 'EACCES';
      try {
        logger.info('second');
      } finally {
        inodeState.statErrorPath = undefined;
        inodeState.statErrorCode = undefined;
      }

      expect(logger.fileHealthy).toBe(false);
      expect(logger.logRef).toBeUndefined();
      const content = fs.readFileSync(canonicalFile, 'utf-8');
      expect(content).toContain('first');
      expect(content).not.toContain('second');
    } finally {
      vi.useRealTimers();
    }
  });
});
