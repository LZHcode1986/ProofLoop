"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
vitest_1.vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        readFileSync: vitest_1.vi.fn(actual.readFileSync),
        writeFileSync: vitest_1.vi.fn(actual.writeFileSync),
        rmSync: vitest_1.vi.fn(actual.rmSync),
        mkdirSync: vitest_1.vi.fn(actual.mkdirSync),
        __real: {
            readFileSync: actual.readFileSync,
            writeFileSync: actual.writeFileSync,
            rmSync: actual.rmSync,
            mkdirSync: actual.mkdirSync,
        },
    };
});
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const receipt_writer_1 = require("./receipt-writer");
const errors_1 = require("./errors");
const LOCK_DIR_NAME = '.receipt-lock';
const OWNER_FILE = 'owner.pid';
const REAL = fs.__real;
const writeFileSyncMock = fs.writeFileSync;
const cleanups = [];
(0, vitest_1.afterEach)(() => {
    writeFileSyncMock.mockImplementation(REAL.writeFileSync);
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        fn?.();
    }
});
function validReceipt(overrides = {}) {
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
function deadPid() {
    const child = (0, node_child_process_1.spawnSync)(process.execPath, ['-e', ''], { timeout: 10_000 });
    (0, vitest_1.expect)(child.status).toBe(0);
    (0, vitest_1.expect)(child.pid).toBeGreaterThan(0);
    return child.pid;
}
/**
 * Test-side oracle: read `/proc/<pid>/stat` field 22 (start-time in clock
 * ticks since boot).  Returns undefined when /proc is unavailable.
 */
function readProcStartTime(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const closeParen = raw.lastIndexOf(')');
        if (closeParen < 0)
            return undefined;
        const after = raw.slice(closeParen + 1).trim().split(/\s+/);
        const ticks = Number(after[19]); // field 22 overall (comm removed)
        return Number.isFinite(ticks) && ticks >= 0 ? ticks : undefined;
    }
    catch {
        return undefined;
    }
}
const HAS_PROC = readProcStartTime(process.pid) !== undefined;
function writeOwner(lockDir, owner) {
    fs.writeFileSync(path.join(lockDir, OWNER_FILE), `${JSON.stringify({ pid: owner.pid, startedAt: Date.now(), ...(owner.startTimeTicks !== undefined ? { startTimeTicks: owner.startTimeTicks } : {}) })}\n`, 'utf-8');
}
function makeReceiptDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-f2-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function lockDirOf(receiptDir) {
    return path.join(receiptDir, LOCK_DIR_NAME);
}
function lockSurvives(receiptDir, owner) {
    const lockDir = lockDirOf(receiptDir);
    fs.mkdirSync(lockDir);
    writeOwner(lockDir, owner);
}
vitest_1.describe.runIf(HAS_PROC)('F2 hardening — PID start-time cross-check (PO-S03-I-04)', () => {
    (0, vitest_1.it)('F2: a reused PID (start-time mismatch) is judged stale and recovered', () => {
        const receiptDir = makeReceiptDir();
        const actualStart = readProcStartTime(process.pid);
        // The lock claims to be owned by this PID but with a DIFFERENT start
        // time — the OS reused the PID since the lock was acquired.
        lockSurvives(receiptDir, { pid: process.pid, startTimeTicks: actualStart + 12345 });
        const result = (0, receipt_writer_1.writeReceipt)(validReceipt(), { receiptDir, tempDir: receiptDir });
        // stale → recovered → the write proceeds
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)(result.path.endsWith('.json')).toBe(true);
        // the recovered lock was released again (no leftover)
        (0, vitest_1.expect)(fs.existsSync(lockDirOf(receiptDir))).toBe(false);
    });
    (0, vitest_1.it)('F2: a matching start-time keeps the lock active (fail-closed, never deleted)', () => {
        const receiptDir = makeReceiptDir();
        const actualStart = readProcStartTime(process.pid);
        lockSurvives(receiptDir, { pid: process.pid, startTimeTicks: actualStart });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(validReceipt(), { receiptDir, tempDir: receiptDir })).toThrow(errors_1.ReceiptChainError);
        // the active lock is never deleted (start-time matched → same owner)
        (0, vitest_1.expect)(fs.existsSync(lockDirOf(receiptDir))).toBe(true);
    });
    (0, vitest_1.it)('F2: owner metadata records PID + /proc start-time on acquisition', () => {
        const receiptDir = makeReceiptDir();
        const ownerPath = path.join(lockDirOf(receiptDir), OWNER_FILE);
        let captured;
        writeFileSyncMock.mockImplementation(((target, ...args) => {
            if (String(target) === ownerPath) {
                captured = String(args[0]);
            }
            return REAL.writeFileSync(target, ...args);
        }));
        const result = (0, receipt_writer_1.writeReceipt)(validReceipt(), { receiptDir, tempDir: receiptDir });
        (0, vitest_1.expect)(result).toBeDefined();
        const parsed = JSON.parse(captured ?? '{}');
        (0, vitest_1.expect)(parsed.pid).toBe(process.pid);
        (0, vitest_1.expect)(typeof parsed.startTimeTicks).toBe('number');
        (0, vitest_1.expect)(parsed.startTimeTicks).toBe(readProcStartTime(process.pid));
    });
});
(0, vitest_1.describe)('F2 hardening — graceful fallbacks (PO-S03-I-04)', () => {
    (0, vitest_1.it)('F2 fallback: a dead PID with recorded start-time is still recovered (no /proc needed)', () => {
        const receiptDir = makeReceiptDir();
        // dead pid + a recorded start-time: /proc/<pid>/stat is gone → PID-only
        // judgement (dead → stale) → recover.  The recorded start-time must not
        // block recovery when the PID itself is dead.
        lockSurvives(receiptDir, { pid: deadPid(), startTimeTicks: 99_999 });
        const result = (0, receipt_writer_1.writeReceipt)(validReceipt(), { receiptDir, tempDir: receiptDir });
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)(fs.existsSync(lockDirOf(receiptDir))).toBe(false);
    });
    (0, vitest_1.it)('F2 fallback: owner metadata without start-time falls back to PID-only judgement', () => {
        const receiptDir = makeReceiptDir();
        // live pid, no startTimeTicks recorded (legacy metadata / non-Linux
        // acquisition) → PID-only judgement → active → contention (fail-closed).
        lockSurvives(receiptDir, { pid: process.pid });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(validReceipt(), { receiptDir, tempDir: receiptDir })).toThrow(errors_1.ReceiptChainError);
        (0, vitest_1.expect)(fs.existsSync(lockDirOf(receiptDir))).toBe(true);
    });
});
//# sourceMappingURL=receipt-writer.f2-pid-reuse.spec.js.map