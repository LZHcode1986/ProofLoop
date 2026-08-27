# Herdr Link Worker 生命周期契约

## 1. 目的与边界

本契约定义 Brain 如何使用 `herdr-link` 管理 ProofLoop Worker 的三个生命周期阶段：

```text
dispatch → continue → recall
```

本契约不扩展 Herdr Link 协议，也不把 ProofLoop 的 `task`、`stage`、`Receipt`、`Evidence` 或 `WorkerResult` 字段加入 Link envelope。Herdr Link 的 `message` 仍是 opaque business payload；ProofLoop 只在 Brain/Runtime 层解释它。协议唯一规范是 `https://github.com/LZHcode1986/herdr-link/blob/master/PROTOCOL.md` 的 `herdr-link`。

`herdr-link` 是跨 Agent / 跨 pane 的 Task/Result 消息通道。Herdr Link 提供：

- `herdr_link_peers`：按稳定 Agent Name 发现 live peer，返回当前 `self` 与稳定命名的 live `peers`；不承担 Worker 选择或排序。
- `herdr_link_send`：发送 `herdr-link` 消息并关联其回复；`status: sent` 只证明投递，不等待或轮询；回复发送给原 `from`，关联由工具完成。
- `herdr_link_close`：按 Agent Name 显式关闭已命名 Agent。
- `SELF_UNNAMED`、`PEER_NOT_FOUND`、`SEND_FAILED`、`CLOSE_FAILED` 等 Link 工具错误必须保留为 typed blocker，不猜测目标或静默 fallback。

Herdr Link 不创建、选择、调度、复用或回收 Worker，也不决定任务完成。Brain 保留这些生命周期决策。

## 2. Link 的职责边界

`herdr-link` 只承载消息：跨 Agent / 跨 pane 的 Task/Result 通信。Link 的 `message` 是 opaque payload，ProofLoop 只在 Brain/Runtime 层解释它。

Link **不创建也不启动** pane 或 Agent。资源创建、Agent 启动、Session 建立和宿主生命周期由 Host/运行环境负责，不属于 ProofLoop 消息契约，也不属于 Herdr Link。不得把 pane/Agent 的创建、布局或启动能力归给 Link。

`transport` 必须在 Session 创建时固定：

- `herdr-link`：已安装 Link Adapter 且当前 Agent 有稳定 Agent Name，普通消息和 Result 使用 Link；
- `subagent`：显式的同 harness 兼容路线，必须产出同一 Worker Result Contract，不是跨 pane 通信，也不是 Herdr 失败后的 fallback。

`herdr-link` 是唯一跨 Agent / 跨 pane 的 Task/Result 消息通道；不存在自动/隐式的 legacy 派发路线。Link 不可用时不得自动或显式 fallback 到其他消息路线。

Link 不可用且未明确选择 `subagent` 时，返回 typed blocker；不能假定 Link 已加载或混用多个 transport。

## 3. Dispatch：何时派发

只有同时满足以下条件，Brain 才能派发一个 Worker Task：

1. Runtime Primary Next Action 明确为 `DISPATCH_WORKER`；
2. 当前 `actionToken`、Context、Manifest、Plan、snapshot 和 scope 绑定已重新核对；
3. 目标 Agent Name 是 live、唯一且可接受输入的 peer；
4. 当前 Worker Session 没有未处理的 in-flight action；
5. Brain 已决定这是新 Session 还是同一 Slice 的合法 continuation。

派发动作：

1. pane/Agent 创建与启动由 Host/运行环境负责；需要时先完成宿主侧资源操作，不通过 Link 创建；
2. 通过 `herdr_link_send` 发送一个且仅一个当前 Task packet，不等待、不轮询；
3. 将返回的 Link message `id` 与 Runtime `actionToken` 保存在 Brain 的临时调度状态中，不写入 Runtime-owned 制品；
4. Worker 结果必须作为对该消息的 `herdr_link_send` 回复返回；
5. 收到回复后，Brain 先解析并绑定 Result，再重读 Evidence、Context、Git/diff 和 Receipts，最后交给正确的 Runtime consumer。

`herdr_link_send` 返回 `status: sent` 只证明消息已被 Herdr 接受，不证明 Worker 完成。

## 4. Continue：何时续接

Brain 只有在以下条件全部成立时，才向原 Worker Session 发送下一条消息：

- 仍属于同一 Stage/Slice；
- semantic input、Context digest、Manifest/Plan/snapshot binding 未改变；
- 上一个 Runtime action 已被适用的 consumer 接纳；
- 原 Agent Name 仍 live，identity 与 Session 绑定一致；
- 没有 pending、duplicate、stale 或未解释的 Result。

允许的 continuation：

- `implement-task` / `recover-task` 被 Runtime 接纳后，继续同一 Slice 的下一个 Runtime-selected Task；
- Slice Task 全部完成后，按 Runtime action 进入 `finalize-slice` 或等待 CV；
- CV `REPAIR` 只在当前 Contract/Runtime consumer 允许时复用原 Session。

不得续接的情况：

- semantic input、Context 或 snapshot digest 改变；
- pane/Agent 丢失、被替换或 identity 不一致；
- 已有代码/Evidence/tasks projection 但原 Session 丢失；此时保留成果，改走 `recover-task`/`recheck`；
- Result 缺失、截断、重复、错消息关联、错 `actionToken` 或 schema 不合法；
- 仅凭 `idle`、`done`、模型总结或 Git diff 推断 Task 已完成。

## 5. Recall：何时收回

Brain 只能在以下任一条件满足后回收 Worker：

- Runtime 已产生 canonical CV `PASS`，并完成对应 Slice 的关闭/失效动作；
- 用户明确暂停/取消，且当前 Result、Evidence、恢复补丁和临时调度状态已经安全落盘；
- 发送/捕获失败已形成 typed blocker，且不再有未处理的业务结果；
- 对独立只读、文档或非 Runtime 审查 Worker，Brain 已收到完整 Link Result、重读相关事实，并确认没有 continuation、recovery 或 pending action。

回收前必须确认：

1. 没有未处理的 Link reply；
2. 没有正在执行的 Runtime action；
3. 未接纳成果已保留，可由 recovery route 继续；
4. 关闭目标使用稳定 Agent Name，通过 `herdr_link_close` 关闭已命名 Agent。

以下状态不能触发自动回收：

- Stage Worker 的单个 Task 完成（独立只读/文档 Worker 的完整 Result 例外见上）；
- Agent `idle` 或 `done`；
- 暂时没有下一个动作；
- Brain 尚未重读并核对 Result/Runtime 事实。

## 6. 失败关闭与重启

- Link 发送失败：不伪造 Result，不自动重发；返回 typed blocker。
- Link reply 丢失：按 `actionToken`/message `id` 从持久化事实恢复；有成果时走 `recover-task`/`recheck`。
- Agent 重启或 pane 替换：重新发现 peer 和 identity；不得使用旧 pane ID 直接续接。资源重建由 Host/运行环境负责。
- Herdr Link 不承载 Runtime admission；Worker Result 的闭集 schema、digest 和 changed-file 边界仍由 Runtime 验证。

## 7. 验收条件

生命周期整改完成必须证明：

1. Dispatch 只由 Runtime `DISPATCH_WORKER` 驱动；
2. Link 消息和 `herdr_link_send` 可把 Worker Result 绑定到当前 action；
3. 同 Slice 的合法 continuation 复用 Session，digest/identity 变化时 fail closed 或 recovery；
4. 单 Task/idle/done 不会误触发 recall；
5. canonical CV `PASS` 或明确暂停后才会回收；
6. Herdr Link 保持通用层，不新增 ProofLoop 业务字段或状态机。