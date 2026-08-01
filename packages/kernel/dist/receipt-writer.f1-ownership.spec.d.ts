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
export {};
//# sourceMappingURL=receipt-writer.f1-ownership.spec.d.ts.map