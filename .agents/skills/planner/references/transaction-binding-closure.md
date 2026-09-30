# Transaction Binding Closure

这是 Planning 的方法 reference，用于核对跨边界传递的现有 binding-critical 字段。它不定义 Contract、schema、MES/Runtime object 或新的状态；字段和对象的权威归属仍由现有 Contract/Authority 决定。

## 使用条件

当同一字段、标识、digest、credential 或其他绑定值跨越 producer、validator、persistence、consumer 或 recovery 任一边界传递时加载本 reference。只检查本轮实际涉及的边界；不要求所有边界都存在。

## 闭合方法

1. 列出本轮所有 binding-critical 值，并为每个值追踪实际经过的边界。
2. 对每个值填写闭合表：

| 项目 | 必须明确的事实 |
|---|---|
| 字段 | 现有 Contract/Authority 中的精确字段名和类型 |
| 来源/生产者 | 谁产生它，以及产生时所依据的事实 |
| 输入边界 | 它如何进入当前 packet、Result 或调用 |
| schema/version 兼容边界 | 若字段属于 versioned schema，说明生产者/消费者版本、兼容或迁移规则；否则标记 `not applicable` |
| canonical 校验 | 格式、规范化、排序/去重和等值规则 |
| 持久化位置 | 哪个已有 durable object/fact 保存它 |
| 消费者 | 哪个已有流程、模块或 public seam 消费它 |
| 必须相等的对象 | 与哪些 packet、Result、fact、Plan 或 Git basis 做等值比较 |
| replay/idempotency | 重放键、完整 payload 组成，以及同键异 payload 的行为；不适用时说明原因 |
| restart/recovery | 重启后从哪些 durable facts 重建，以及如何重新校验 currentness |
| 失败 / no-write boundary | 对 mismatch、缺失或过期明确：哪些业务写入必须不发生，以及哪些已有 typed blocker/error record 允许记录 |
| 负向测试 | 至少一个能证明错误传播、错误等值或错误版本被拒绝的 fixture/seam |

3. 从真实 producer、validator、persistence 和 consumer 代码/测试核对每一行；不从字段名、路径或自然语言目标推断缺失的 owner 或 consumer。
4. 对跨边界的集合值、digest、标识和 Git/Authority basis 写出精确的 canonical equality；“shape valid” 不等于 binding closed。
5. 对 replay 与 recovery 分别核对：重放不得把不同 payload 当成同一事实，重启不得依赖隐藏会话、临时 metadata 或未持久化摘要。

## 完成标准

- 每个 binding-critical 值都有一行完整闭合记录，或对 `not applicable` 有具体理由；
- producer、输入边界、持久化位置、consumer 和 equality 对象均能由稳定 Contract/Authority/code refs 复核；
- replay、restart/recovery、失败行为和至少一个负向测试均已明确；
- 现有 schema/object ownership 保持单一事实源，Plan 只引用其稳定边界，不在本 reference 中重新定义；
- 任一无法闭合的值都在冻结 Task/Dependencies 前暴露为当前已有的 planning route 或 typed blocker，而不是由 Planner 猜测补全。