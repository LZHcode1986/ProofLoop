/**
 * ReceiptWriter bounded-directory boundary tests.
 *
 * These tests intentionally exercise the filesystem seam through /tmp
 * fixtures.  They must not use the canonical worktree or write any Receipt
 * artifact under the repository.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Vitest exposes Node's ESM namespace as non-configurable, so direct
// `vi.spyOn(fs, ...)` cannot install deterministic race/capability seams.
// Wrap only the synchronous calls used by the fault-injection tests;
// every wrapper calls the real Node implementation unless a test overrides it.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    realpathSync: vi.fn(actual.realpathSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    linkSync: vi.fn(actual.linkSync),
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

import {
  computeReceiptDigest,
  ensureBoundedReceiptDirectory,
  verifyReceiptChain,
  verifyReceiptDigest,
  writeReceiptBounded,
  type BoundedReceiptWriterOptions,
  type BoundedWriteReceiptResult,
} from './receipt-writer';

const openSyncMock = vi.mocked(fs.openSync);
const mkdirSyncMock = vi.mocked(fs.mkdirSync);
const realpathSyncMock = vi.mocked(fs.realpathSync);
const realOpenSync = openSyncMock.getMockImplementation() as typeof fs.openSync;
const realMkdirSync = mkdirSyncMock.getMockImplementation() as typeof fs.mkdirSync;
const realRealpathSync = realpathSyncMock.getMockImplementation() as typeof fs.realpathSync;
const fsyncSyncMock = vi.mocked(fs.fsyncSync);
const realFsyncSync = fsyncSyncMock.getMockImplementation() as typeof fs.fsyncSync;
const linkSyncMock = vi.mocked(fs.linkSync);
const realLinkSync = linkSyncMock.getMockImplementation() as typeof fs.linkSync;
const lstatSyncMock = vi.mocked(fs.lstatSync);
const realLstatSync = lstatSyncMock.getMockImplementation() as typeof fs.lstatSync;
const readFileSyncMock = vi.mocked(fs.readFileSync);
const realReadFileSync = readFileSyncMock.getMockImplementation() as typeof fs.readFileSync;
const unlinkSyncMock = vi.mocked(fs.unlinkSync);
const realUnlinkSync = unlinkSyncMock.getMockImplementation() as typeof fs.unlinkSync;

function validReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    type: 'TASK_COMPLETE',
    stage_id: 'S01',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: {},
    ...overrides,
  };
}

interface Fixture {
  root: string;
  receiptDir: string;
  outside: string;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-bounded-root-'));
  const receiptDir = path.join(root, 'receipts');
  fs.mkdirSync(receiptDir);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-bounded-outside-'));
  return { root, receiptDir, outside };
}

function optionsFor(fixture: Fixture): BoundedReceiptWriterOptions {
  return {
    projectRoot: fixture.root,
    receiptDir: fixture.receiptDir,
    tempDir: fixture.receiptDir,
  };
}

function receiptFiles(directory: string): string[] {
  return fs.readdirSync(directory).filter((entry) => entry.endsWith('.json'));
}

function cleanupFixture(fixture: Fixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.outside, { recursive: true, force: true });
}

describe('writeReceiptBounded — root-bound directory boundary', () => {
  const fixtures: Fixture[] = [];

  afterEach(() => {
    openSyncMock.mockImplementation(realOpenSync);
    mkdirSyncMock.mockImplementation(realMkdirSync);
    realpathSyncMock.mockImplementation(realRealpathSync);
    fsyncSyncMock.mockImplementation(realFsyncSync);
    linkSyncMock.mockImplementation(realLinkSync);
    lstatSyncMock.mockImplementation(realLstatSync);
    readFileSyncMock.mockImplementation(realReadFileSync);
    unlinkSyncMock.mockImplementation(realUnlinkSync);
    for (const fixture of fixtures.splice(0)) {
      cleanupFixture(fixture);
    }
  });

  it('writes and reads a linked chain through the bound directory', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);

    const first = writeReceiptBounded(
      validReceipt({ type: 'SLICE_PLAN', payload: { step: 1 } }),
      optionsFor(fixture),
    );
    expect(fs.existsSync(path.join(fixture.receiptDir, '.receipt-lock'))).toBe(false);
    const second = writeReceiptBounded(
      validReceipt({
        previous_digest: first.digest,
        payload: { step: 2 },
      }),
      optionsFor(fixture),
    );

    expect(first.path).toBe(path.join(fixture.receiptDir, `${first.digest}.json`));
    expect(first.path).not.toContain('/proc/self/fd/');
    expect(first.boundDirectory.path).toBe(fixture.receiptDir);
    expect(first.boundDirectory.dev).toEqual(expect.any(Number));
    expect(first.boundDirectory.ino).toEqual(expect.any(Number));
    expect(verifyReceiptDigest(first.path)).toBe(true);
    expect(verifyReceiptDigest(second.path)).toBe(true);
    expect(verifyReceiptChain(fixture.receiptDir).valid).toBe(true);
    expect(receiptFiles(fixture.receiptDir)).toEqual(
      expect.arrayContaining([`${first.digest}.json`, `${second.digest}.json`]),
    );
    expect(receiptFiles(fixture.outside)).toHaveLength(0);
    expect(fs.existsSync(path.join(fixture.receiptDir, '.receipt-lock'))).toBe(false);
    expect(fs.readdirSync(fixture.receiptDir).some((entry) => entry.includes('.tmp.'))).toBe(false);
  });

  it('returns a writer-time Receipt identity that remains stable when the entry is later replaced', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);

    const result = writeReceiptBounded(
      validReceipt({ payload: { writer_time_identity: true } }),
      optionsFor(fixture),
    );
    const captured = { ...result.receiptFile };
    const finalStat = fs.lstatSync(result.path);

    expect(result.receiptFile.name).toBe(`${result.digest}.json`);
    expect(result.receiptFile.dev).toBe(finalStat.dev);
    expect(result.receiptFile.ino).toBe(finalStat.ino);
    expect(result.receiptFile.nlink).toBe(finalStat.nlink);
    expect(result.receiptFile.size).toBe(finalStat.size);
    expect(result.receiptFile.nlink).toBe(1);

    const moved = path.join(fixture.root, 'writer-time-original.json');
    fs.renameSync(result.path, moved);
    fs.writeFileSync(result.path, 'competitor-entry\n', 'utf-8');

    // A later path read sees the replacement, but the result remains the
    // closed writer-time binding that Runtime must consume.
    expect(result.receiptFile).toEqual(captured);
    expect(fs.lstatSync(result.path).ino).not.toBe(captured.ino);
    expect(fs.readFileSync(moved, 'utf-8')).not.toBe('competitor-entry\n');
  });

  it('removes its own Receipt when post-install digest verification fails', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    let installed = false;
    let finalName: string | undefined;

    linkSyncMock.mockImplementation(((temporary: unknown, destination: unknown, ...rest: unknown[]) => {
      const result = (realLinkSync as (...args: unknown[]) => void)(temporary, destination, ...rest);
      installed = true;
      finalName = path.basename(String(destination));
      return result;
    }) as typeof fs.linkSync);
    readFileSyncMock.mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (installed && finalName !== undefined && typeof file === 'number') {
        try {
          const physical = realRealpathSync(`/proc/self/fd/${file}`);
          if (physical === path.join(fixture.receiptDir, finalName)) {
            return '{"digest":"tampered-by-test"}\n';
          }
        } catch {
          // Fall through to the real read for unrelated descriptors.
        }
      }
      return (realReadFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);

    expect(() => writeReceiptBounded(validReceipt(), optionsFor(fixture))).toThrow(
      /post-write digest verification failed/i,
    );
    expect(finalName).toBeDefined();
    expect(receiptFiles(fixture.receiptDir)).toHaveLength(0);
    expect(fs.readdirSync(fixture.receiptDir).some((entry) => entry.includes('.tmp.'))).toBe(false);
  });

  it('removes its own Receipt when the post-install directory fsync fails', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    let installed = false;

    linkSyncMock.mockImplementation(((temporary: unknown, destination: unknown, ...rest: unknown[]) => {
      const result = (realLinkSync as (...args: unknown[]) => void)(temporary, destination, ...rest);
      installed = true;
      return result;
    }) as typeof fs.linkSync);
    fsyncSyncMock.mockImplementation(((fd: number) => {
      let physical: string | undefined;
      try { physical = realRealpathSync(`/proc/self/fd/${fd}`); } catch { /* unrelated fd */ }
      if (installed && physical === fixture.receiptDir) {
        throw new Error('injected post-install directory fsync failure');
      }
      return (realFsyncSync as (fileDescriptor: number) => void)(fd);
    }) as typeof fs.fsyncSync);

    expect(() => writeReceiptBounded(validReceipt(), optionsFor(fixture))).toThrow(
      /injected post-install directory fsync failure/i,
    );
    expect(receiptFiles(fixture.receiptDir)).toHaveLength(0);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
  });

  it('fails closed after a post-install bound-directory stability fault and declares the retained Receipt', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const renamed = path.join(fixture.root, 'receipts-after-install');
    let installed = false;
    let injected = false;

    linkSyncMock.mockImplementation(((temporary: unknown, destination: unknown, ...rest: unknown[]) => {
      const result = (realLinkSync as (...args: unknown[]) => void)(temporary, destination, ...rest);
      installed = true;
      return result;
    }) as typeof fs.linkSync);
    fsyncSyncMock.mockImplementation(((fd: number) => {
      let physical: string | undefined;
      try { physical = realRealpathSync(`/proc/self/fd/${fd}`); } catch { /* unrelated fd */ }
      if (installed && !injected && physical === fixture.receiptDir) {
        injected = true;
        fs.renameSync(fixture.receiptDir, renamed);
        fs.symlinkSync(fixture.outside, fixture.receiptDir, 'dir');
      }
      return (realFsyncSync as (fileDescriptor: number) => void)(fd);
    }) as typeof fs.fsyncSync);

    expect(() => writeReceiptBounded(validReceipt(), optionsFor(fixture))).toThrow(
      /persisted|cleanup|stable|bound|changed/i,
    );
    expect(injected).toBe(true);
    expect(receiptFiles(renamed)).toHaveLength(1);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
  });

  it('never deletes a competitor that replaces the Receipt after writer-time capture', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const movedOwn = path.join(fixture.root, 'own-receipt-moved');
    let installed = false;
    let finalName: string | undefined;
    let injected = false;

    linkSyncMock.mockImplementation(((temporary: unknown, destination: unknown, ...rest: unknown[]) => {
      const result = (realLinkSync as (...args: unknown[]) => void)(temporary, destination, ...rest);
      installed = true;
      finalName = path.basename(String(destination));
      return result;
    }) as typeof fs.linkSync);
    fsyncSyncMock.mockImplementation(((fd: number) => {
      let physical: string | undefined;
      try { physical = realRealpathSync(`/proc/self/fd/${fd}`); } catch { /* unrelated fd */ }
      if (installed && !injected && physical === fixture.receiptDir) {
        injected = true;
        const finalPath = path.join(fixture.receiptDir, finalName as string);
        fs.renameSync(finalPath, movedOwn);
        fs.writeFileSync(finalPath, 'competitor-entry\n', 'utf-8');
        throw new Error('injected competitor replacement during directory fsync');
      }
      return (realFsyncSync as (fileDescriptor: number) => void)(fd);
    }) as typeof fs.fsyncSync);

    expect(() => writeReceiptBounded(validReceipt(), optionsFor(fixture))).toThrow(
      /competitor|identity mismatch|cleanup|persisted/i,
    );
    expect(injected).toBe(true);
    expect(finalName).toBeDefined();
    expect(fs.readFileSync(path.join(fixture.receiptDir, finalName as string), 'utf-8')).toBe(
      'competitor-entry\n',
    );
    expect(fs.existsSync(movedOwn)).toBe(true);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
  });

  it('declares cleanup failure honestly instead of hiding a retained Receipt', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    let installed = false;
    let finalName: string | undefined;

    linkSyncMock.mockImplementation(((temporary: unknown, destination: unknown, ...rest: unknown[]) => {
      const result = (realLinkSync as (...args: unknown[]) => void)(temporary, destination, ...rest);
      installed = true;
      finalName = path.basename(String(destination));
      return result;
    }) as typeof fs.linkSync);
    fsyncSyncMock.mockImplementation(((fd: number) => {
      let physical: string | undefined;
      try { physical = realRealpathSync(`/proc/self/fd/${fd}`); } catch { /* unrelated fd */ }
      if (installed && physical === fixture.receiptDir) {
        throw new Error('injected post-install failure before cleanup');
      }
      return (realFsyncSync as (fileDescriptor: number) => void)(fd);
    }) as typeof fs.fsyncSync);
    unlinkSyncMock.mockImplementation(((filePath: unknown, ...rest: unknown[]) => {
      if (installed && finalName !== undefined && path.basename(String(filePath)) === finalName) {
        throw new Error('injected cleanup unlink failure');
      }
      return (realUnlinkSync as (...args: unknown[]) => void)(filePath, ...rest);
    }) as typeof fs.unlinkSync);

    let failure: unknown;
    try {
      writeReceiptBounded(validReceipt(), optionsFor(fixture));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/persisted|cleanup|unlink failure/i);
    expect(finalName).toBeDefined();
    expect(fs.existsSync(path.join(fixture.receiptDir, finalName as string))).toBe(true);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
  });

  it('opens a newly-created lock with no-follow binding before writing metadata', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const rawLockPath = path.join(fixture.receiptDir, '.receipt-lock');
    let injected = false;
    const lockOpenFlags: number[] = [];

    openSyncMock.mockImplementation(((filePath: unknown, flags: unknown, ...rest: unknown[]) => {
      if (
        typeof filePath === 'string' &&
        filePath.endsWith('/.receipt-lock') &&
        typeof flags === 'number'
      ) {
        lockOpenFlags.push(flags);
      }
      return (realOpenSync as (...args: unknown[]) => number)(filePath, flags, ...rest);
    }) as typeof fs.openSync);

    mkdirSyncMock.mockImplementation(((directory: unknown, ...rest: unknown[]) => {
      const result = (realMkdirSync as (...args: unknown[]) => string | undefined)(directory, ...rest);
      if (
        !injected &&
        typeof directory === 'string' &&
        directory.startsWith('/proc/self/fd/') &&
        directory.endsWith('/.receipt-lock')
      ) {
        injected = true;
        fs.rmSync(rawLockPath, { recursive: true, force: true });
        fs.symlinkSync(fixture.outside, rawLockPath, 'dir');
      }
      return result;
    }) as typeof fs.mkdirSync);

    expect(() => writeReceiptBounded(validReceipt(), optionsFor(fixture))).toThrow(
      /bound|lock|open|symlink/i,
    );
    expect(injected).toBe(true);
    expect(lockOpenFlags).toHaveLength(1);
    expect(lockOpenFlags[0] & fs.constants.O_DIRECTORY).not.toBe(0);
    expect(lockOpenFlags[0] & fs.constants.O_NOFOLLOW).not.toBe(0);
    expect(fs.lstatSync(rawLockPath).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
    expect(receiptFiles(fixture.receiptDir)).toHaveLength(0);
  });

  it('rejects a pre-existing lock symlink before stale reads or recovery', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const rawLockPath = path.join(fixture.receiptDir, '.receipt-lock');
    fs.writeFileSync(path.join(fixture.outside, 'owner.pid'), '999999999\n', 'utf-8');
    fs.symlinkSync(fixture.outside, rawLockPath, 'dir');

    expect(() => writeReceiptBounded(validReceipt(), optionsFor(fixture))).toThrow(
      /bound|lock|open|symlink/i,
    );
    expect(fs.lstatSync(rawLockPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(fixture.outside, 'owner.pid'), 'utf-8')).toBe('999999999\n');
    expect(receiptFiles(fixture.outside)).toHaveLength(0);
    expect(receiptFiles(fixture.receiptDir)).toHaveLength(0);
  });

  it('fails closed when a bound lock is replaced before the next metadata operation', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const rawLockPath = path.join(fixture.receiptDir, '.receipt-lock');
    const movedLockPath = path.join(fixture.root, '.receipt-lock-moved');
    let injected = false;

    fsyncSyncMock.mockImplementation(((fd: number) => {
      const physicalPath = realRealpathSync(`/proc/self/fd/${fd}`);
      if (
        !injected &&
        physicalPath === path.join(rawLockPath, 'owner.pid')
      ) {
        injected = true;
        fs.renameSync(rawLockPath, movedLockPath);
        fs.symlinkSync(fixture.outside, rawLockPath, 'dir');
      }
      return (realFsyncSync as (fileDescriptor: number) => void)(fd);
    }) as typeof fs.fsyncSync);

    expect(() => writeReceiptBounded(validReceipt(), optionsFor(fixture))).toThrow(
      /bound|lock|changed|symlink|stable/i,
    );
    expect(injected).toBe(true);
    expect(fs.lstatSync(rawLockPath).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
    expect(fs.readdirSync(movedLockPath)).not.toContain('created-at');
    expect(receiptFiles(fixture.receiptDir)).toHaveLength(0);
  });

  it('rejects a different outside directory inserted at the bound lock entry', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const rawLockPath = path.join(fixture.receiptDir, '.receipt-lock');
    const movedLockPath = path.join(fixture.root, '.receipt-lock-moved');
    const outsideReplacement = fs.mkdtempSync(path.join(fixture.outside, 'lock-replacement-'));
    let injected = false;

    fsyncSyncMock.mockImplementation(((fd: number) => {
      const physicalPath = realRealpathSync(`/proc/self/fd/${fd}`);
      if (!injected && physicalPath === path.join(rawLockPath, 'owner.pid')) {
        injected = true;
        fs.renameSync(rawLockPath, movedLockPath);
        fs.renameSync(outsideReplacement, rawLockPath);
      }
      return (realFsyncSync as (fileDescriptor: number) => void)(fd);
    }) as typeof fs.fsyncSync);

    expect(() => writeReceiptBounded(validReceipt(), optionsFor(fixture))).toThrow(
      /bound|identity|changed|lock|stable/i,
    );
    expect(injected).toBe(true);
    expect(fs.readdirSync(rawLockPath)).toEqual([]);
    expect(fs.readdirSync(movedLockPath)).not.toContain('created-at');
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
    expect(receiptFiles(fixture.receiptDir)).toHaveLength(0);
  });

  it('rejects a regular-file competitor inserted immediately before final install', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    let injected = false;
    let finalPath: string | undefined;

    linkSyncMock.mockImplementation(((temporary: unknown, destination: unknown, ...rest: unknown[]) => {
      if (!injected && typeof destination === 'string' && destination.endsWith('.json')) {
        injected = true;
        finalPath = path.join(fixture.receiptDir, path.basename(destination));
        fs.writeFileSync(finalPath, 'competitor-regular\n', 'utf-8');
      }
      return (realLinkSync as (...args: unknown[]) => void)(temporary, destination, ...rest);
    }) as typeof fs.linkSync);

    expect(() => writeReceiptBounded(validReceipt(), optionsFor(fixture))).toThrow(
      /exist|install|link|duplicate/i,
    );
    expect(injected).toBe(true);
    expect(finalPath).toBeDefined();
    expect(fs.readFileSync(finalPath as string, 'utf-8')).toBe('competitor-regular\n');
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
    expect(fs.readdirSync(fixture.receiptDir).some((entry) => entry.includes('.tmp.'))).toBe(false);
  });

  it('rejects a symlink competitor inserted immediately before final install without following it', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    let injected = false;
    let finalPath: string | undefined;

    linkSyncMock.mockImplementation(((temporary: unknown, destination: unknown, ...rest: unknown[]) => {
      if (!injected && typeof destination === 'string' && destination.endsWith('.json')) {
        injected = true;
        finalPath = path.join(fixture.receiptDir, path.basename(destination));
        fs.symlinkSync(fixture.outside, finalPath, 'file');
      }
      return (realLinkSync as (...args: unknown[]) => void)(temporary, destination, ...rest);
    }) as typeof fs.linkSync);

    expect(() => writeReceiptBounded(validReceipt(), optionsFor(fixture))).toThrow(
      /exist|install|link|duplicate/i,
    );
    expect(injected).toBe(true);
    expect(finalPath).toBeDefined();
    expect(fs.lstatSync(finalPath as string).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
    expect(fs.readdirSync(fixture.receiptDir).some((entry) => entry.includes('.tmp.'))).toBe(false);
  });

  it('fails before writing when the target starts as an outside-root symlink', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    fs.rmSync(fixture.receiptDir, { recursive: true, force: true });
    fs.symlinkSync(fixture.outside, fixture.receiptDir, 'dir');

    expect(() =>
      writeReceiptBounded(validReceipt(), optionsFor(fixture)),
    ).toThrow(/bound|root|symlink|outside/i);

    expect(receiptFiles(fixture.outside)).toHaveLength(0);
    expect(fs.readdirSync(fixture.outside)).not.toContain('.receipt-lock');
  });

  it('fails before writing when receiptDir is not a directory', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    fs.rmSync(fixture.receiptDir, { recursive: true, force: true });
    fs.writeFileSync(fixture.receiptDir, 'not a directory', 'utf-8');

    expect(() =>
      writeReceiptBounded(validReceipt(), optionsFor(fixture)),
    ).toThrow(/directory/i);
    expect(receiptFiles(fixture.outside)).toHaveLength(0);
  });

  it('fails closed when the verified directory is renamed and replaced by an outside symlink before open', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const renamed = path.join(fixture.root, 'receipts-renamed');
    let injected = false;

    openSyncMock.mockImplementation(((filePath: unknown, flags: unknown, ...rest: unknown[]) => {
      if (
        !injected &&
        typeof filePath === 'string' &&
        filePath.startsWith('/proc/self/fd/') &&
        filePath.endsWith('/receipts') &&
        typeof flags === 'number' &&
        (flags & fs.constants.O_DIRECTORY) !== 0
      ) {
        injected = true;
        fs.renameSync(fixture.receiptDir, renamed);
        fs.symlinkSync(fixture.outside, fixture.receiptDir, 'dir');
      }
      return (realOpenSync as (...args: unknown[]) => number)(filePath, flags, ...rest);
    }) as typeof fs.openSync);

    expect(() =>
      writeReceiptBounded(validReceipt(), optionsFor(fixture)),
    ).toThrow(/bound|changed|open|symlink|directory/i);
    expect(injected).toBe(true);
    expect(receiptFiles(fixture.outside)).toHaveLength(0);
    expect(receiptFiles(renamed)).toHaveLength(0);
  });

  it('fails closed when the bound target is renamed outside before the next operation', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const movedOutside = path.join(fixture.outside, 'receipts-moved');
    let injected = false;

    mkdirSyncMock.mockImplementation(((directory: unknown, ...rest: unknown[]) => {
      if (
        !injected &&
        typeof directory === 'string' &&
        directory.startsWith('/proc/self/fd/') &&
        directory.endsWith('/.receipt-lock')
      ) {
        injected = true;
        fs.renameSync(fixture.receiptDir, movedOutside);
      }
      return (realMkdirSync as (...args: unknown[]) => string | undefined)(directory, ...rest);
    }) as typeof fs.mkdirSync);

    expect(() =>
      writeReceiptBounded(validReceipt(), optionsFor(fixture)),
    ).toThrow(/bound|changed|directory|path/i);
    expect(injected).toBe(true);
    expect(receiptFiles(fixture.outside)).toHaveLength(0);
    expect(receiptFiles(movedOutside)).toHaveLength(0);
    expect(fs.readdirSync(movedOutside)).toEqual([]);
    expect(fs.existsSync(fixture.receiptDir)).toBe(false);
  });

  it('fails closed when the bound target is replaced by an outside symlink before the next operation', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const renamed = path.join(fixture.root, 'receipts-renamed');
    let injected = false;

    fsyncSyncMock.mockImplementation(((fd: number) => {
      const physicalPath = realRealpathSync(`/proc/self/fd/${fd}`);
      if (
        !injected &&
        physicalPath.startsWith(`${fixture.receiptDir}/`) &&
        physicalPath.includes('.tmp.')
      ) {
        injected = true;
        fs.renameSync(fixture.receiptDir, renamed);
        fs.symlinkSync(fixture.outside, fixture.receiptDir, 'dir');
      }
      return (realFsyncSync as (fileDescriptor: number) => void)(fd);
    }) as typeof fs.fsyncSync);

    expect(() =>
      writeReceiptBounded(validReceipt(), optionsFor(fixture)),
    ).toThrow(/bound|changed|directory|path|symlink/i);
    expect(injected).toBe(true);
    expect(receiptFiles(fixture.outside)).toHaveLength(0);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
    expect(receiptFiles(renamed)).toHaveLength(0);
  });

  it('fails closed before temp/lock/receipt writes when /proc fd capability is unavailable', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);

    realpathSyncMock.mockImplementation(((filePath: unknown, ...rest: unknown[]) => {
      if (typeof filePath === 'string' && filePath.startsWith('/proc/self/fd/')) {
        const error = new Error('proc fd unavailable') as NodeJS.ErrnoException;
        error.code = 'ENOTSUP';
        throw error;
      }
      return (realRealpathSync as (...args: unknown[]) => string)(filePath, ...rest);
    }) as typeof fs.realpathSync);

    expect(() =>
      writeReceiptBounded(validReceipt(), optionsFor(fixture)),
    ).toThrow(/capabil|proc|support|bound/i);
    expect(fs.readdirSync(fixture.receiptDir)).toEqual([]);
    expect(receiptFiles(fixture.outside)).toHaveLength(0);
  });

  it('fails closed before writes when the directory-open capability is unsupported', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    let directoryOpenAttempted = false;

    openSyncMock.mockImplementation(((filePath: unknown, flags: unknown, ...rest: unknown[]) => {
      if (typeof flags === 'number' && (flags & fs.constants.O_DIRECTORY) !== 0) {
        directoryOpenAttempted = true;
        const error = new Error('directory no-follow open unsupported') as NodeJS.ErrnoException;
        error.code = 'ENOTSUP';
        throw error;
      }
      return (realOpenSync as (...args: unknown[]) => number)(filePath, flags, ...rest);
    }) as typeof fs.openSync);

    expect(() =>
      writeReceiptBounded(validReceipt(), optionsFor(fixture)),
    ).toThrow(/capabil|support|directory|bound/i);
    expect(directoryOpenAttempted).toBe(true);
    expect(fs.readdirSync(fixture.receiptDir)).toEqual([]);
    expect(receiptFiles(fixture.outside)).toHaveLength(0);
  });

  it('does not expose a closed proc-fd path in the bounded result', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const result: BoundedWriteReceiptResult = writeReceiptBounded(
      validReceipt({ payload: { path_shape: true } }),
      optionsFor(fixture),
    );

    expect(result.path).toEqual(path.join(fixture.receiptDir, `${result.digest}.json`));
    expect(result.path).not.toMatch(/^\/proc\/self\/fd\//);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(computeReceiptDigest(validReceipt({ payload: { path_shape: true } }))).toBe(result.digest);
  });

  it('securely creates a nested target and returns a binding usable by the bounded writer', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    fs.rmSync(fixture.receiptDir, { recursive: true, force: true });
    const targetDir = path.join(fixture.root, '.proofloop', 'receipts', 'S01');
    const mkdirPaths: string[] = [];

    mkdirSyncMock.mockImplementation(((directory: unknown, ...rest: unknown[]) => {
      if (typeof directory === 'string' && directory.startsWith('/proc/self/fd/')) {
        mkdirPaths.push(directory);
      }
      return (realMkdirSync as (...args: unknown[]) => string | undefined)(directory, ...rest);
    }) as typeof fs.mkdirSync);

    const binding = ensureBoundedReceiptDirectory({
      projectRoot: fixture.root,
      targetDir,
    });
    mkdirSyncMock.mockImplementation(realMkdirSync);

    expect(mkdirPaths).toHaveLength(3);
    const rootAnchor = mkdirPaths[0].match(/^\/proc\/self\/fd\/\d+/)?.[0];
    expect(rootAnchor).toBeDefined();
    expect(mkdirPaths.every((directory) => directory.startsWith(`${rootAnchor}/`))).toBe(true);

    expect(binding.rootPath).toBe(fixture.root);
    expect(binding.path).toBe(targetDir);
    expect(binding.path).not.toContain('/proc/self/fd/');
    expect(fs.realpathSync(binding.path)).toBe(targetDir);
    expect(fs.statSync(binding.path).dev).toBe(binding.dev);
    expect(fs.statSync(binding.path).ino).toBe(binding.ino);

    const result = writeReceiptBounded(validReceipt(), {
      projectRoot: fixture.root,
      receiptDir: binding.path,
      tempDir: binding.path,
    });
    expect(result.path).toBe(path.join(targetDir, `${result.digest}.json`));
    expect(receiptFiles(fixture.outside)).toHaveLength(0);
  });

  it('fails closed on a symlinked parent without creating anything outside the root', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const parent = path.join(fixture.root, 'parent-link');
    const targetDir = path.join(parent, 'receipts', 'S01');
    fs.symlinkSync(fixture.outside, parent, 'dir');

    expect(() =>
      ensureBoundedReceiptDirectory({ projectRoot: fixture.root, targetDir }),
    ).toThrow(/symlink|follow|bound/i);

    expect(fs.readdirSync(fixture.outside)).toEqual([]);
    expect(fs.existsSync(path.join(fixture.outside, 'receipts'))).toBe(false);
  });

  it('fails closed on a symlinked final target without creating anything outside the root', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    fs.rmSync(fixture.receiptDir, { recursive: true, force: true });
    fs.symlinkSync(fixture.outside, fixture.receiptDir, 'dir');

    expect(() =>
      ensureBoundedReceiptDirectory({
        projectRoot: fixture.root,
        targetDir: fixture.receiptDir,
      }),
    ).toThrow(/symlink|follow|bound/i);

    expect(fs.readdirSync(fixture.outside)).toEqual([]);
  });

  it('rejects a target outside the canonical root before creating any directory', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const targetDir = path.join(fixture.outside, 'receipts', 'S01');

    expect(() =>
      ensureBoundedReceiptDirectory({ projectRoot: fixture.root, targetDir }),
    ).toThrow(/escape|root/i);

    expect(fs.existsSync(targetDir)).toBe(false);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
  });

  it('fails closed before scaffolding when directory-fd capability is unsupported', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const targetDir = path.join(fixture.root, '.proofloop', 'receipts', 'S01');
    let directoryOpenAttempted = false;

    openSyncMock.mockImplementation(((filePath: unknown, flags: unknown, ...rest: unknown[]) => {
      if (typeof flags === 'number' && (flags & fs.constants.O_DIRECTORY) !== 0) {
        directoryOpenAttempted = true;
        const error = new Error('directory no-follow open unsupported') as NodeJS.ErrnoException;
        error.code = 'ENOTSUP';
        throw error;
      }
      return (realOpenSync as (...args: unknown[]) => number)(filePath, flags, ...rest);
    }) as typeof fs.openSync);

    expect(() =>
      ensureBoundedReceiptDirectory({ projectRoot: fixture.root, targetDir }),
    ).toThrow(/support|capability|directory|bound/i);

    expect(directoryOpenAttempted).toBe(true);
    expect(fs.existsSync(path.join(fixture.root, '.proofloop'))).toBe(false);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
  });

  it('fails closed when the opened target identity changes after creation', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const targetDir = path.join(fixture.root, '.proofloop', 'receipts', 'S01');
    const renamed = path.join(fixture.root, '.proofloop', 'receipts', 'S01-renamed');
    let injected = false;

    openSyncMock.mockImplementation(((filePath: unknown, flags: unknown, ...rest: unknown[]) => {
      const fd = (realOpenSync as (...args: unknown[]) => number)(filePath, flags, ...rest);
      if (
        !injected &&
        typeof filePath === 'string' &&
        filePath.startsWith('/proc/self/fd/') &&
        filePath.endsWith('/S01') &&
        typeof flags === 'number' &&
        (flags & fs.constants.O_DIRECTORY) !== 0
      ) {
        injected = true;
        fs.renameSync(targetDir, renamed);
        fs.symlinkSync(fixture.outside, targetDir, 'dir');
      }
      return fd;
    }) as typeof fs.openSync);

    expect(() =>
      ensureBoundedReceiptDirectory({ projectRoot: fixture.root, targetDir }),
    ).toThrow(/identity|changed|bound|symlink/i);

    expect(injected).toBe(true);
    expect(fs.readdirSync(fixture.outside)).toEqual([]);
    expect(receiptFiles(renamed)).toHaveLength(0);
  });
});
