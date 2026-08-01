/**
 * receipt-writer.f3-digest.spec.ts — PO-S03-I-05 (S03-I-T05, F3)
 *
 * F3（遗留 minor，SR Round 5）：`verifyReceiptDigest` 无针对非对象 JSON 的
 * 专用单测。本 spec 补齐专项矩阵——非对象 JSON（数组/字符串/数字/null/布尔）
 * 与非法 JSON（格式错误/`undefined` 字面量/空文件）必须返回 `false` 且**不抛
 * 异常**（Forbidden shortcut：不允许对非法输入抛未处理异常）；合法对象 JSON
 * 必须正常校验（回归：匹配 true / 篡改 false / 缺 digest false）。
 *
 * `verifyReceiptDigest(filePath: string): boolean` 位于
 * `packages/kernel/src/receipt-writer.ts`（kernel 公开函数）。行为契约：
 *   - 文件不可读 / JSON 解析失败 → false（不抛）；
 *   - 解析结果非对象（数组/字符串/数字/null/布尔）→ false（不抛）；
 *   - 合法对象：`digest` 缺失/非字符串 → false；digest 与内容计算值一致 → true。
 *
 * 纯函数测试：无 mock；真实临时文件。若实现存在缺陷，本矩阵将失败（RED）；
 * 当前预期实现已 fail-closed 符合契约（F3 为测试缺口，非行为缺口）。
 */
export {};
//# sourceMappingURL=receipt-writer.f3-digest.spec.d.ts.map