/**
 * receipt-writer.f2-pid-reuse.spec.ts — PO-S03-I-04 (S03-I-T04, F2 硬化)
 *
 * F2（遗留 minor，SR Round 5）：PID 复用使 stale 锁永久被视为活跃（fail-closed
 * 卡锁，不会 fork）。本 spec 先写断言，驱动 `receipt-writer.ts` 的 F2 硬化：
 *
 *   owner 元数据记录 PID + `/proc/<pid>/stat` start-time（field 22，ticks
 *   since boot，best-effort）；stale 判定对"存活 PID"做 start-time 交叉校验：
 *     - start-time 不匹配 → PID 已被 OS 复用 → 原 owner 已不存在 → stale 可恢复；
 *     - start-time 匹配 → 同一进程仍持有 → 活跃卡锁（fail-closed 可接受残留，
 *       卡锁绝不被删）；
 *     - `/proc` 不可读或无 start-time 记录 → graceful fallback 到仅 PID 判定
 *       （非 Linux 环境即此路径）。
 *
 * 测试覆盖：
 *   - reused PID（判别器）：活 PID + 不匹配 start-time → 判 stale 并恢复
 *     （writeReceipt 成功）；未硬化时仅按 PID 判定为活跃 → 抛错卡锁 → RED；
 *   - matched start-time（守卫）：活 PID + 匹配 start-time → 活跃卡锁
 *     （抛 ReceiptChainError、锁保留）——防"卡锁被误删"；
 *   - fallback：dead PID + 有 start-time 记录 → 仍按 PID 判定 stale 恢复
 *     （无 /proc 也可恢复）；
 *   - fallback：无 start-time 记录（legacy 元数据）→ 仅 PID 判定；
 *   - recording：新获取锁的 owner 元数据记录 PID + start-time（与 /proc 一致）。
 *
 * `/proc` 读取与锁判定均为真实实现；`node:fs` 以 call-through mock 包装
 * （默认全部委托真实实现），仅 recording 用例用于捕获 owner.pid 写入内容。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    rmSync: vi.fn(actual.rmSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    __real: {
      readFileSync: actual.readFileSync,
      writeFileSync: actual.writeFileSync,
      rmSync: actual.rmSync,
      mkdirSync: actual.mkdirSync,
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
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
    writeFileSync: typeof fs.writeFileSync;
    rmSync: typeof fs.rmSync;
    mkdirSync: typeof fs.mkdirSync;
  };
}).__real;

const writeFileSyncMock = fs.writeFileSync as unknown as FnWithMock;

const cleanups: Array<() => void> = [];
afterEach(() => {
  writeFileSyncMock.mockImplementation(REAL.writeFileSync as never);
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

function writeOwner(lockDir: string, owner: { pid: number; startTimeTicks?: number }): void {
  fs.writeFileSync(
    path.join(lockDir, OWNER_FILE),
    `${JSON.stringify({ pid: owner.pid, startedAt: Date.now(), ...(owner.startTimeTicks !== undefined ? { startTimeTicks: owner.startTimeTicks } : {}) })}\n`,
    'utf-8',
  );
}

function makeReceiptDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-f2-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lockDirOf(receiptDir: string): string {
  return path.join(receiptDir, LOCK_DIR_NAME);
}

function lockSurvives(receiptDir: string, owner: { pid: number; startTimeTicks?: number }): void {
  const lockDir = lockDirOf(receiptDir);
  fs.mkdirSync(lockDir);
  writeOwner(lockDir, owner);
}

describe.runIf(HAS_PROC)('F2 hardening — PID start-time cross-check (PO-S03-I-04)', () => {
  it('F2: a reused PID (start-time mismatch) is judged stale and recovered', () => {
    const receiptDir = makeReceiptDir();
    const actualStart = readProcStartTime(process.pid) as number;
    // The lock claims to be owned by this PID but with a DIFFERENT start
    // time — the OS reused the PID since the lock was acquired.
    lockSurvives(receiptDir, { pid: process.pid, startTimeTicks: actualStart + 12345 });

    const result = writeReceipt(validReceipt(), { receiptDir, tempDir: receiptDir });
    // stale → recovered → the write proceeds
    expect(result).toBeDefined();
    expect(result.path.endsWith('.json')).toBe(true);
    // the recovered lock was released again (no leftover)
    expect(fs.existsSync(lockDirOf(receiptDir))).toBe(false);
  });

  it('F2: a matching start-time keeps the lock active (fail-closed, never deleted)', () => {
    const receiptDir = makeReceiptDir();
    const actualStart = readProcStartTime(process.pid) as number;
    lockSurvives(receiptDir, { pid: process.pid, startTimeTicks: actualStart });

    expect(() => writeReceipt(validReceipt(), { receiptDir, tempDir: receiptDir })).toThrow(
      ReceiptChainError,
    );
    // the active lock is never deleted (start-time matched → same owner)
    expect(fs.existsSync(lockDirOf(receiptDir))).toBe(true);
  });

  it('F2: owner metadata records PID + /proc start-time on acquisition', () => {
    const receiptDir = makeReceiptDir();
    const ownerPath = path.join(lockDirOf(receiptDir), OWNER_FILE);
    let captured: string | undefined;
    writeFileSyncMock.mockImplementation(((target: unknown, ...args: unknown[]) => {
      if (String(target) === ownerPath) {
        captured = String(args[0]);
      }
      return (REAL.writeFileSync as unknown as (...a: unknown[]) => unknown)(target, ...args);
    }) as never);

    const result = writeReceipt(validReceipt(), { receiptDir, tempDir: receiptDir });
    expect(result).toBeDefined();

    const parsed = JSON.parse(captured ?? '{}') as { pid?: unknown; startTimeTicks?: unknown };
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.startTimeTicks).toBe('number');
    expect(parsed.startTimeTicks).toBe(readProcStartTime(process.pid));
  });
});

describe('F2 hardening — graceful fallbacks (PO-S03-I-04)', () => {
  it('F2 fallback: a dead PID with recorded start-time is still recovered (no /proc needed)', () => {
    const receiptDir = makeReceiptDir();
    // dead pid + a recorded start-time: /proc/<pid>/stat is gone → PID-only
    // judgement (dead → stale) → recover.  The recorded start-time must not
    // block recovery when the PID itself is dead.
    lockSurvives(receiptDir, { pid: deadPid(), startTimeTicks: 99_999 });

    const result = writeReceipt(validReceipt(), { receiptDir, tempDir: receiptDir });
    expect(result).toBeDefined();
    expect(fs.existsSync(lockDirOf(receiptDir))).toBe(false);
  });

  it('F2 fallback: owner metadata without start-time falls back to PID-only judgement', () => {
    const receiptDir = makeReceiptDir();
    // live pid, no startTimeTicks recorded (legacy metadata / non-Linux
    // acquisition) → PID-only judgement → active → contention (fail-closed).
    lockSurvives(receiptDir, { pid: process.pid });

    expect(() => writeReceipt(validReceipt(), { receiptDir, tempDir: receiptDir })).toThrow(
      ReceiptChainError,
    );
    expect(fs.existsSync(lockDirOf(receiptDir))).toBe(true);
  });
});
