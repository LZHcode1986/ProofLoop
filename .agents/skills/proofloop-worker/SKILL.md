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

1. `transport: herdr` 时先加载 `.agents/skills/herdr/SKILL.md`：通用 Herdr
   控制面、CLI 和 lifecycle 规则；
2. 本文件 `.agents/skills/proofloop-worker/SKILL.md`：通用 Worker 行为和结果回传；
3. `.agents/skills/proofloop-execute/references/worker-template.md`：ProofLoop
   Worker Contract（任务契约）；
4. `transport: herdr` 时最后加载
   `.agents/skills/proofloop-execute/references/herdr-worker-template.md`：ProofLoop
   的 Herdr relay 映射；
5. `transport: subagent` 时使用 harness-native wrapper（宿主原生包装器），但必须
   产出同一 Worker Result Contract（Worker 结果契约）。

自然语言“你是 Worker”不能替代上述加载链。`skill_ref`、当前 Context 和
`actionToken` 必须来自 Brain 的结构化 packet。

## 执行边界

- 只执行当前 packet 中唯一的 Runtime Primary Next Action；不选择未来 Task，不猜路径，
  不扩大 `Context.allowed_paths`。
- 只修改 admitted `execution_scope` 内的代码/测试、当前 Slice Evidence 允许段，
  以及 `mutable_projection_paths` 授权的当前 Task checkbox/Worker Status。
- 先写 Evidence，再更新 checkbox；不得写 Runtime-owned `## Current CV Status`。
- 不写 Receipt、Manifest、Context、Gate/Review verdict，不提交 Git。
- `repair`/`diagnose` 只修复已接纳 CV 结果指定的 failure family（失败问题族），并
  按当前 repair history 执行 bounded repair（有界修复）；修复后返回 `READY_FOR_CV`，
  不把它当作 `TASK_COMPLETE`。

## 结果模式和 Runtime 路由

| Worker mode（模式） | Worker 允许结果 | Brain/Host 后续路由 |
|---|---|---|
| `implement-task` | `TASK_COMPLETE` 候选 | 重读事实后提交 `stage admit-worker` |
| `recover-task` | `TASK_COMPLETE` 候选 | 重读事实后提交 `stage admit-worker` |
| `finalize-slice` | `READY_FOR_CV` 候选 | 由 Runtime 计算 CV action；不能按普通 Task 接纳 |
| `repair` / `diagnose` | `READY_FOR_CV` 候选 | fresh CV recheck（新的 CV 复核）；当前 Runtime 不把 `repair` 送入 `stage admit-worker` |

`PROOFLOOP-WORKER-READY` 只是唤醒信号。`result_available: true` 是未受信任的
提示字段，不能替代 Result、Evidence、Git/diff 或 Runtime Receipt。

## Worker Result 传输协议

Worker 必须在当前 turn（当前 harness 对话轮次）结束前完成以下顺序：

1. 完成代码、测试、Evidence 和允许的 Plan projection；
2. 将**唯一且完整**的结果块作为 harness 可读取的终端/对话输出发出：

```text
---PROOFLOOP-WORKER-RESULT---
<当前 VNextWorkerResultEnvelope 的闭集 YAML/结构化正文>
---END-PROOFLOOP-WORKER-RESULT---
```

3. 确认结果块已经完整输出后，才发送最小 `PROOFLOOP-WORKER-READY` 回调；
4. 回调发送后立即结束当前 turn，使 Herdr agent 进入 `idle` 或 `done` 可读取状态；
   不在回调之后继续输出长总结、执行命令或发送第二个结果块。

结果块必须在 harness 的可读取 stdout/终端输出通道中出现。内部工具调用返回值、
模型文字“我已经输出了 marker”、隐藏的子会话内容、摘要或用户消息都不算结果块。
结果块不能截断、不能带 ANSI/控制字符污染、不能包含重复 delimiter（分隔符）或
重复 YAML key（键）。

结果正文使用当前 `VNextWorkerResultEnvelope` 字段名：
`schemaVersion`、`actionToken`、`stageId`、`sliceId`、`taskId`、`mode`、`outcome`、
`evidenceRef`、`changedFiles`、`verificationRuns`、`manifestDigest`、`planDigest`、
`proofIndexDigest`、`snapshotDigest`、`contextRef`、`contextDigest`。未知别名或
自由扩展字段必须被 Host adapter（宿主适配器）拒绝。

## Herdr 主动唤醒和读取顺序

`transport: herdr` 使用 Brain packet 临时携带的：

```yaml
host_relay:
  callback:
    brain_target: <brain-agent-target>
    brain_pane_id: <diagnostic-pane-id>
    transport: herdr-agent-prompt
    event: PROOFLOOP-WORKER-READY
```

- `brain_target` 是唯一 ACP（Agent-to-Agent Prompt，代理间提示）回传目标；
  `brain_pane_id` 只用于核对和诊断，不用于 `pane send-text` 或 `send-keys`。
- Brain 派发 Task 使用 `herdr agent prompt <worker> <packet>`，不使用 prompt 的
  `--wait`；主会话立即交还调度器。
- Worker 先输出完整 Result，再发送一次 `PROOFLOOP-WORKER-READY`，回调只携带
  `actionToken`、Stage/Slice/Task、`mode`、`result_available` 及必要的 ephemeral
  Session 标识。
- 回调到达时 Worker 可能仍处于 `working`；Brain **不能立即读取
  `recent-unwrapped`**。Brain 必须先按已安装 Herdr CLI 的实际语法对目标 agent/pane
  做一次有界 lifecycle wait（生命周期等待），接受 `idle` 或 `done`；`done` 表示
  未见后台工作已结束，随后同样可读取。
- Herdr alternate-screen（交替屏幕）在 Worker `working` 时可能拒绝读取并返回
  `agent_not_idle`。这是读取时序错误，不是完成证据；不要轮询或用长时间同步等待。
- 进入可读取状态后读取 bounded `recent-unwrapped`（有限的未包装终端文本；可按
  Host Skill 使用 `visible` 作一次诊断读取），提取**当前 actionToken 对应的唯一完整
  Result block**。没有完整闭合块、读取到旧块、重复块、错 action、截断块或解析失败，
  必须返回 `WORKER_RESULT_MISSING`/typed blocker，不能进入 Runtime admission。
- 读取成功后，Brain 仍必须重读 Evidence、`tasks.md`、Context、Git/diff 和前序
  Receipts；传输载荷只是候选事实，不是 Runtime authority。
- 回调丢失时只能从持久化事实恢复；不得把 Herdr 的 `idle`、`done`、pane 关闭、
  模型总结或 `git diff` 单独解释为完成。

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
- `repair` 结果不能伪装成 `implement-task`/`recover-task`；它直接触发 fresh CV
  recheck，除非当前 Runtime Contract 明确新增了 repair consumer。

## 完成标准

Worker/Host 只有同时满足以下条件才可返回成功 readiness：

1. 当前 Task/repair 的代码、测试、Evidence 和允许 projection 已完成；
2. 完整 Result block 已在可读取通道输出并与当前 action 绑定；
3. 回调只作为唤醒信号发出，且 Worker turn 已结束；
4. Brain 已在 lifecycle 可读取状态读取并解析 Result；
5. Brain 已重读持久化事实，并把适用结果交给正确的 Runtime/CV consumer。

`READY_FOR_CV` 不是 CV PASS，`TASK_COMPLETE` 不是 Slice Complete，任何 lifecycle
状态也不是 Stage Gate 或 Stage Review 结论。
