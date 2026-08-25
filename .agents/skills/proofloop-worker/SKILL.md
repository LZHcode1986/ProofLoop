---
name: proofloop-worker
description: 跨 harness 的 ProofLoop Worker 行为、Scope/Evidence 纪律、结果传输、主动唤醒与恢复协议；当 dispatch packet 指定 Worker，或处理 Herdr Worker Result/READY 回调时加载。
---

# proofloop-worker

本 Skill 是跨 harness（跨执行宿主）Worker 行为的唯一事实源。它不授予 Runtime
权限，不写 Manifest、Context、Receipt 或 CV 状态；Runtime Context、admitted
Manifest、Plan 和当前 action 才是执行授权。

## 固定加载链

Worker 收到 `contract_mode: vnext-template` packet 后，Host 按以下顺序加载：

1. `transport: herdr-link` 或显式 `herdr-legacy` 时先加载 `.agents/skills/herdr/SKILL.md`：通用 Herdr 控制面、CLI 和 lifecycle 规则；Link route 的普通消息使用 `herdr_link_send`，不使用 raw CLI；
2. 本文件 `.agents/skills/proofloop-worker/SKILL.md`：通用 Worker 行为和结果回传；
3. `transport: herdr-link` 或 legacy Herdr route 时加载 `.agents/skills/proofloop-execute/references/worker-template.md`：ProofLoop Worker Contract（任务契约）；
4. Herdr route 最后加载 `.agents/skills/proofloop-execute/references/herdr-worker-template.md`：Link 优先的 Session/lifecycle 映射和显式 legacy 兼容规则；
5. `transport: subagent` 时使用 harness-native wrapper（宿主原生包装器），但必须产出同一 Worker Result Contract（Worker 结果契约）。

自然语言“你是 Worker”不能替代上述加载链。`skill_ref`、当前 Context 和
`actionToken` 必须来自 Brain 的结构化 packet。

## Herdr Link 传输优先级

当选定的 Herdr Runtime 已加载 `herdr-link/1` Adapter 且当前 Agent 有稳定 Agent Name 时，`herdr_link_send` 是正常的派发和结果通道。Task packet 放入 `message`，Worker 将严格 Result payload 作为 `reply_to` 回复。Brain 校验 `actionToken`/digest 并重读 Runtime 事实后再 admission；Link 的 `status: sent` 只表示消息已投递，不表示完成。

`.agents/skills/herdr/SKILL.md` 和 Herdr CLI 仍是 pane 创建、Agent 启动/恢复、identity 检查及显式兼容路由的控制依赖。Link 可用时，它们不是普通消息通道。下方 ACP/READY 与 `recent-unwrapped` 规则仅适用于显式选择的 legacy Herdr route，不能与 Link route 静默混用。当前 Brain 生命周期规则以 `.agents/contracts/brain/herdr-link-worker-lifecycle.md` 为准。
## 执行边界

- 只执行当前 packet 中唯一的 Runtime Primary Next Action；不选择未来 Task，不猜路径，
  不扩大 `Context.allowed_paths`。
- 只修改 admitted `execution_scope` 内的代码/测试、当前 Slice Evidence 允许段，
  以及 `mutable_projection_paths` 授权的当前 Task checkbox/Worker Status。
- 先写 Evidence，再更新 checkbox；不得写 Runtime-owned `## Current CV Status`。
- 不写 Receipt、Manifest、Context、Gate/Review verdict，不提交 Git。
- `repair`/`diagnose` 只修复已接纳 CV 结果指定的 failure family（失败问题族），并
  按当前 repair history 执行 bounded repair（有界修复）；修复后返回 envelope
  `mode='repair'`（持久化交接事实），不把它当作 `TASK_COMPLETE`。

## 结果模式和 Runtime 路由

| Worker mode（模式） | Worker 允许结果 | Brain/Host 后续路由 |
|---|---|---|
| `implement-task` | `TASK_COMPLETE` 候选 | 重读事实后提交 `stage admit-worker` |
| `recover-task` | `TASK_COMPLETE` 候选 | 重读事实后提交 `stage admit-worker` |
| `finalize-slice` | `READY_FOR_CV` 候选 | 由 Runtime 计算 CV action；不能按普通 Task 接纳 |
| `repair` / `diagnose` | envelope `mode='repair'`（持久化交接事实，非 `TASK_COMPLETE`） | 不进入 `stage admit-worker`（Runtime 显式拒绝）；`stage next` 校验 envelope 绑定后置 `PENDING_RECHECK` → `RUN_CV` fresh recheck |

envelope `mode='repair'` 语义：repair 结果是持久化交接事实而非
`TASK_COMPLETE`；`mode='repair'` 时 `repairsCvReceiptDigest` 必填（64hex，
等于当前 CV_REPAIR receipt digest）、`taskId` 免填；不得调用
`stage admit-worker` 提交 repair envelope——Runtime 在 admission 处显式拒绝，
repair 由 `stage next` 绑定校验消费后触发 fresh bounded CV recheck。

`PROOFLOOP-WORKER-READY` 仅是 legacy ACP route 的兼容唤醒头。Herdr Link route 使用 `reply_to` 关联完整 Result；任何 route 中，`result_available` 都是不受信任提示，不能替代 Result、Evidence、Git/diff 或 Runtime Receipt。

## Worker Result 传输协议

Worker 必须先完成代码、测试、Evidence 和允许的 Plan projection，再通过当前 Session 选定的通信 route 返回一个严格 Result。

### Herdr Link route

当 Herdr Link Adapter 可用且 Worker 有稳定 Agent Name：

1. Brain 使用 `herdr_link_send` 发送 Task packet，保存返回的 Link message `id`；不等待、不轮询。
2. Worker 使用 `herdr_link_send` 向 Brain 回复，设置 `reply_to` 为该 dispatch message `id`，`message` 内放当前 `VNextWorkerResultEnvelope` 的闭集正文。
3. `reply_to` 是传输关联和唤醒信号，不是 Runtime admission；Link `status: sent` 不是完成证据。
4. Brain 收到回复后校验 `reply_to`、`actionToken`、digest 和闭集字段，重读 Evidence、Context、tasks projection、Git/diff 和 Receipts，再交给适用的 Runtime/CV consumer。
5. Worker Result 缺失、截断、重复、错目标、错 `reply_to`、错 action 或 schema 无效时 fail closed；不得由 `idle`、`done`、模型总结或 Git diff 补全。

结果正文仍使用当前字段：`schemaVersion`、`actionToken`、`stageId`、`sliceId`、`taskId`、`mode`、`outcome`、`evidenceRef`、`changedFiles`、`verificationRuns`、`manifestDigest`、`planDigest`、`proofIndexDigest`、`snapshotDigest`、`contextRef`、`contextDigest`，以及仅 `mode='repair'` 时允许出现的 `repairsCvReceiptDigest`（64hex，非 repair mode 禁止携带）。未知别名或自由扩展字段必须拒绝。

### Legacy Herdr route

仅当 Session 显式选择没有 Link Adapter 的 legacy route 时，才使用旧 ACP/READY/`recent-unwrapped` 规则。该 route 必须遵守原有严格 marker、actionToken/digest、idle/done 和 fail-closed 约束；不能与 Herdr Link route 静默混用。

## Herdr Skill/CLI 边界

Herdr Skill/CLI 仍用于 pane 创建/布局、Agent 启动/恢复、identity/lifecycle 检查和显式兼容 route。Link 可用时，不得使用 raw `agent prompt`、`--wait`、`agent.read`、`pane.read`、`send-text` 或 `send-keys` 传输普通消息。Brain 的 dispatch/continue/recall 决策以 `.agents/contracts/brain/herdr-link-worker-lifecycle.md` 为准。
## Subagent 兼容路线

`transport: subagent` 不使用 Herdr wait/read/callback，但必须通过其 adapter 取得
同一完整结果块、校验同一 `actionToken`/digest/闭集字段，并执行同样的持久化事实重读。
两条 transport 不能在同一 Worker Session 中隐式切换。

## 恢复和失败关闭

- 结果块已产生但 Worker/Pane 丢失：保留已有 diff、Evidence 和 tasks projection，
  按 `recover-task`/`recheck` 恢复，不重新实现已有 Task。
- Result 缺失或回调提前：记录 `WORKER_RESULT_MISSING`，不接纳、不派发下一个 Task；
  可对同一 Session 请求一次有界的结果补发，但不能伪造 Result。
- Result 与当前 `actionToken`、Session、Context digest 或 snapshot 不匹配：记录
  stale/mismatch，按 recovery route 处理。
- `repair` 结果不能伪装成 `implement-task`/`recover-task`；它是持久化交接事实，
  由 `stage next` 校验 envelope 绑定（含 `repairsCvReceiptDigest`）后置
  `PENDING_RECHECK` 并触发 fresh CV recheck，不经 `stage admit-worker` 接纳。

## 完成标准

Worker/Host 只有同时满足以下条件才可返回成功 readiness：
1. 当前 Task/repair 的代码、测试、Evidence 和允许 projection 已完成；
2. Herdr Link route 已收到与当前 dispatch message `id` 关联的完整 Result reply；legacy route 才使用完整 ACP/READY block；
3. Brain 已校验 `reply_to`、`actionToken`、digest 和闭集 schema，并重读持久化事实；
4. Brain 已把结果交给正确的 Runtime/CV consumer；Worker 的 `idle`/`done`、Link `status: sent` 或模型总结均不替代这些条件。

`READY_FOR_CV` 不是 CV PASS，`TASK_COMPLETE` 不是 Slice Complete，任何 lifecycle
状态也不是 Stage Gate 或 Stage Review 结论。
