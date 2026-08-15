/**
 * receipt-writer.f1-ownership.spec.ts — PO-S03-I-03 (S03-I-T03, F1 硬化)
 *
 * F1（遗留 minor，SR Round 5）：stale-recovery 重试的
 * `finally { rmSync(lockDir) }` 可能删掉胜者持有的锁（≥3 进程竞争 stale 锁 +
 * 特定交错）。本 spec 先写断言，驱动 `receipt-writer.ts` 的两处硬化：
 *
 *   1. stale 恢复的删除前重检：删除前重新读取 `owner.pid`——若在 stale 判定与
 *      删除之间被另一个进程以活 PID 重新获取（胜者锁），则中止恢复（抛
 *      `ReceiptChainError`），绝不删除胜者锁；
 *   2. 释放前所有权校验：锁释放（finally）仅在 `owner.pid === 本进程 PID` 时
 *      才删除锁目录，非所有者绝不删除。
 *
 * 测试覆盖：
 *   - interleaving（stale 恢复重检）：在恢复者的删除点之前编排"胜者以活 PID
 *     重新获取"（真实 fs 操作），断言恢复者中止、胜者锁保留；无修复时恢复者
 *     不存在第二次 owner 读取、会继续写入并删除胜者锁 → RED；
 *   - release path（所有权校验）：写入中途由竞争胜者替换锁，断言释放路径不
 *     删除新所有者的锁；无修复时 finally 无条件删除 → RED；
 *   - multi-process（双进程 fixture）：真实子进程经 dist 执行 stale 恢复并
 *     写入，父进程在子进程写入窗口内替换为自身锁，断言子进程释放不删除父进
 *     程锁；无修复时被删 → RED；
 *   - regression：正常写入仍释放自己的锁（所有权校验不破坏正常路径）。
 *
 * 竞争交错通过真实 fs 编排（临时目录 + 独立进程 fixture）实现；锁判定本身
 * （owner.pid 读取 / 存活探测 / stale 决策）不被 mock。`node:fs` 以
 * call-through mock 包装（默认全部委托真实实现），仅用于在精确交错点暂停
 * 编排"胜者重新获取"。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    // originals for the orchestration helpers (the mock delegates by default)
    __real: {
      readFileSync: actual.readFileSync,
      renameSync: actual.renameSync,
      rmSync: actual.rmSync,
      mkdirSync: actual.mkdirSync,
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { writeReceipt } from './receipt-writer';
import { ReceiptChainError } from './errors';

const LOCK_DIR_NAME = '.receipt-lock';
const OWNER_FILE = 'owner.pid';

type FnWithMock = {
  mockImplementation(fn: (...args: unknown[]) => unknown): void;
};

const REAL = (fs as unknown as {
  __real: {
    readFileSync: typeof fs.readFileSync;
    renameSync: typeof fs.renameSync;
    rmSync: typeof fs.rmSync;
    mkdirSync: typeof fs.mkdirSync;
  };
}).__real;

const readFileSyncMock = fs.readFileSync as unknown as FnWithMock;
const renameSyncMock = fs.renameSync as unknown as FnWithMock;
const rmSyncMock = fs.rmSync as unknown as FnWithMock;
const mkdirSyncMock = fs.mkdirSync as unknown as FnWithMock;

const cleanups: Array<() => void> = [];
afterEach(() => {
  // restore call-through defaults after orchestration
  readFileSyncMock.mockImplementation(REAL.readFileSync as never);
  renameSyncMock.mockImplementation(REAL.renameSync as never);
  rmSyncMock.mockImplementation(REAL.rmSync as never);
  mkdirSyncMock.mockImplementation(REAL.mkdirSync as never);
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

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

/** A PID guaranteed to be dead (spawn a child that exits immediately). */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 });
  expect(child.status).toBe(0);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid as number;
}

/**
 * Test-side oracle: read `/proc/<pid>/stat` field 22 (start-time in clock
 * ticks since boot).  Returns undefined when /proc is unavailable.
 */
function readProcStartTime(pid: number): number | undefined {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0) return undefined;
    const after = raw.slice(closeParen + 1).trim().split(/\s+/);
    const ticks = Number(after[19]); // field 22 overall (comm removed)
    return Number.isFinite(ticks) && ticks >= 0 ? ticks : undefined;
  } catch {
    return undefined;
  }
}

const HAS_PROC = readProcStartTime(process.pid) !== undefined;

function writeOwner(lockDir: string, pid: number): void {
  writeOwnerMetadata(lockDir, { pid });
}

function writeOwnerMetadata(
  lockDir: string,
  owner: { pid: number; startTimeTicks?: number },
): void {
  fs.writeFileSync(
    path.join(lockDir, OWNER_FILE),
    `${JSON.stringify({ pid: owner.pid, startedAt: Date.now(), ...(owner.startTimeTicks !== undefined ? { startTimeTicks: owner.startTimeTicks } : {}) })}\n`,
    'utf-8',
  );
}

function readOwnerMetadataFrom(lockDir: string): { pid?: number; startTimeTicks?: number } {
  try {
    const raw = fs.readFileSync(path.join(lockDir, OWNER_FILE), 'utf-8');
    const parsed = JSON.parse(raw.trim()) as { pid?: unknown; startTimeTicks?: unknown };
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      startTimeTicks: typeof parsed.startTimeTicks === 'number' ? parsed.startTimeTicks : undefined,
    };
  } catch {
    return {};
  }
}

function readOwnerPidFrom(lockDir: string): number | undefined {
  return readOwnerMetadataFrom(lockDir).pid;
}

function makeReceiptDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-f1-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Create a receipt dir + a stale lock owned by a dead PID. */
function makeStaleLock(receiptDir: string): { lockDir: string; staleOwner: number } {
  const lockDir = path.join(receiptDir, LOCK_DIR_NAME);
  const staleOwner = deadPid();
  fs.mkdirSync(lockDir);
  writeOwner(lockDir, staleOwner);
  return { lockDir, staleOwner };
}

describe('F1 hardening — lock ownership checks (PO-S03-I-03)', () => {
  it('F1: stale recovery never deletes a lock that a live winner re-acquired (interleaving)', () => {
    const receiptDir = makeReceiptDir();
    const { lockDir } = makeStaleLock(receiptDir);
    const ownerPath = path.join(lockDir, OWNER_FILE);

    // Orchestrate the race between the recoverer's stale decision (owner.pid
    // read #1) and the hardened pre-deletion re-check (read #2): on read #2
    // a live winner re-acquires the lock with its own pid (real fs ops — the
    // lock judgement stays real).  Without the hardening there is no read #2
    // at all: the recoverer goes straight from the stale decision to the
    // unconditional deletion.
    let ownerReads = 0;
    readFileSyncMock.mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (String(file) === ownerPath) {
        ownerReads += 1;
        if (ownerReads === 2) {
          // a competing writer recovered the same stale lock first and
          // re-acquired it with its own (live) owner pid
          (REAL.rmSync as unknown as (...a: unknown[]) => void)(lockDir, { recursive: true, force: true });
          (REAL.mkdirSync as unknown as (...a: unknown[]) => void)(lockDir, { recursive: false });
          writeOwner(lockDir, process.pid);
        }
      }
      return (REAL.readFileSync as unknown as (...a: unknown[]) => unknown)(file, ...args);
    }) as never);

    expect(() => writeReceipt(validReceipt(), { receiptDir, tempDir: receiptDir })).toThrow(
      ReceiptChainError,
    );

    // the winner's lock must survive the recoverer's stale-recovery attempt
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(readOwnerPidFrom(lockDir)).toBe(process.pid);
    // the hardened path actually re-reads the owner before deleting
    expect(ownerReads).toBeGreaterThanOrEqual(2);
  });

  it('F1: the release path never removes a lock this process no longer owns', () => {
    const receiptDir = makeReceiptDir();
    const { lockDir } = makeStaleLock(receiptDir);
    const otherPid = deadPid();

    // mid-write: a competing winner replaces our lock with its own owner pid
    renameSyncMock.mockImplementation(((from: unknown, to: unknown) => {
      (REAL.rmSync as unknown as (...a: unknown[]) => void)(lockDir, { recursive: true, force: true });
      (REAL.mkdirSync as unknown as (...a: unknown[]) => void)(lockDir, { recursive: false });
      writeOwner(lockDir, otherPid); // the winner's lock (different owner)
      return (REAL.renameSync as unknown as (...a: unknown[]) => unknown)(from, to);
    }) as never);

    const result = writeReceipt(validReceipt(), { receiptDir, tempDir: receiptDir });

    expect(result).toBeDefined();
    // the winner's lock must NOT be removed by our release path
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(readOwnerPidFrom(lockDir)).toBe(otherPid);
  });

  it('F1: a stale-recovering process never removes a lock owned by a live winner (multi-process)', async () => {
    const receiptDir = makeReceiptDir();
    const { lockDir, staleOwner } = makeStaleLock(receiptDir);

    // Heavy (schema-valid) payload → the child's post-acquisition window
    // (temp write + fsync + rename + verify of a multi-MB receipt) is long
    // enough for the parent to observe the child holding the lock and
    // replace it mid-write.  The payload file lives OUTSIDE the receipt dir
    // so the chain pre-check never scans it as a receipt.
    const payload = {
      marker: 'f1-multi-process',
      entries: Array.from({ length: 250_000 }, (_, i) => `entry-${i}-${'x'.repeat(40)}`),
    };
    const payloadFile = path.join(os.tmpdir(), `receipt-f1-payload-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(payloadFile, JSON.stringify(payload));
    cleanups.push(() => {
      try {
        fs.rmSync(payloadFile, { force: true });
      } catch {
        /* best-effort */
      }
    });

    const distWriter = path.join(__dirname, '..', 'dist', 'receipt-writer.js');
    const startedMarker = path.join(receiptDir, 'child.started');
    const doneMarker = path.join(receiptDir, 'child.done');
    const childScript = [
      `const { writeReceipt } = require(${JSON.stringify(distWriter)});`,
      `const fs = require('node:fs');`,
      `const receiptDir = process.argv[1];`,
      `const payload = JSON.parse(fs.readFileSync(process.argv[4], 'utf-8'));`,
      `fs.writeFileSync(process.argv[2], String(process.pid), 'utf-8');`,
      `const result = writeReceipt({ version: 1, type: 'TASK_COMPLETE', stage_id: 'S01', timestamp: '2025-01-01T00:00:00.000Z', payload }, { receiptDir, tempDir: receiptDir });`,
      `fs.writeFileSync(process.argv[3], result.path, 'utf-8');`,
    ].join('\n');

    const child = spawn(
      process.execPath,
      ['-e', childScript, receiptDir, startedMarker, doneMarker, payloadFile],
      { stdio: 'ignore' },
    );

    // Wait until the child holds the lock mid-write (owner changed from the
    // stale dead pid to the live child pid).
    const deadline = Date.now() + 20_000;
    let sawChildLock = false;
    while (Date.now() < deadline) {
      const owner = readOwnerPidFrom(lockDir);
      if (owner !== undefined && owner !== staleOwner) {
        sawChildLock = true;
        break;
      }
      if (fs.existsSync(doneMarker)) break; // child finished too fast — scenario not reproduced
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(sawChildLock, 'expected to observe the child holding the lock mid-write (heavy-payload window)').toBe(
      true,
    );

    // The winner (parent) re-acquires the lock mid-write — real fs operations,
    // simulating a competing stale recoverer that won the race.
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir, { recursive: false });
    writeOwner(lockDir, process.pid);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', () => resolve(null));
    });
    expect(exitCode).toBe(0);
    expect(fs.existsSync(doneMarker)).toBe(true);

    // the winner's lock must survive the child's release (ownership check)
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(readOwnerPidFrom(lockDir)).toBe(process.pid);
  });

  it('F1 regression: a successful write still releases its own lock', () => {
    const receiptDir = makeReceiptDir();
    const lockDir = path.join(receiptDir, LOCK_DIR_NAME);
    const result = writeReceipt(validReceipt(), { receiptDir, tempDir: receiptDir });
    expect(result).toBeDefined();
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});

// ============================================================
// F1∩F2 repair (PO-S03-I-03, CV initial-001): reused-PID winner
// interleaving — the stale-recovery re-check must compare the FULL
// decision-time metadata (pid AND startTimeTicks), not the pid alone.
// ============================================================

describe.runIf(HAS_PROC)('F1∩F2 — reused-PID winner interleaving (PO-S03-I-03 repair)', () => {
  it('F1∩F2: a winner re-acquiring the judged-stale lock under the same PID with a matching start-time is never deleted (recoverer aborts)', () => {
    const receiptDir = makeReceiptDir();
    const lockDir = path.join(receiptDir, LOCK_DIR_NAME);
    const ownerPath = path.join(lockDir, OWNER_FILE);
    const actualStart = readProcStartTime(process.pid) as number;

    // Decision-time metadata: this PID with a BOGUS start-time → judged
    // stale via the F2 reused-PID path (recorded start-time ≠ /proc).
    fs.mkdirSync(lockDir);
    writeOwnerMetadata(lockDir, { pid: process.pid, startTimeTicks: actualStart + 12345 });

    // Orchestrate the race at the re-check point (owner.pid read #2): a
    // winner re-acquires the judged-stale lock under the NUMERICALLY-SAME
    // live PID with the MATCHING start-time (a real kernel acquisition of
    // the process that currently holds the reused PID).  The re-check must
    // see the start-time change and abort — never delete the winner's lock.
    let ownerReads = 0;
    readFileSyncMock.mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (String(file) === ownerPath) {
        ownerReads += 1;
        if (ownerReads === 2) {
          (REAL.rmSync as unknown as (...a: unknown[]) => void)(lockDir, { recursive: true, force: true });
          (REAL.mkdirSync as unknown as (...a: unknown[]) => void)(lockDir, { recursive: false });
          writeOwnerMetadata(lockDir, { pid: process.pid, startTimeTicks: actualStart });
        }
      }
      return (REAL.readFileSync as unknown as (...a: unknown[]) => unknown)(file, ...args);
    }) as never);

    // The recoverer must abort (contention) — never delete the winner's lock
    expect(() => writeReceipt(validReceipt(), { receiptDir, tempDir: receiptDir })).toThrow(
      ReceiptChainError,
    );

    // the winner's live lock survives with the matching start-time
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(readOwnerMetadataFrom(lockDir)).toEqual({ pid: process.pid, startTimeTicks: actualStart });
    // the re-check actually re-read the metadata after the decision
    expect(ownerReads).toBeGreaterThanOrEqual(2);
  });
});
