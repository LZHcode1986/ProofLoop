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
export {};
//# sourceMappingURL=receipt-writer.f2-pid-reuse.spec.d.ts.map