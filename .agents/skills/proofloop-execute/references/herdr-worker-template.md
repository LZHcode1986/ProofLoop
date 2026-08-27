# Herdr Worker Host Relay 模板

本模板只定义 Worker 的 **`herdr-link` Host relay** 适配；Worker 的 Task、Scope、Evidence、Receipt、Runtime admission 和完成语义仍以 `worker-template.md`、当前 Context 和 Runtime Contract 为准。

`herdr-link` 是跨 Agent / 跨 pane 的 Task/Result 消息通道。本模板只保留 ProofLoop 业务协议与 Host relay 映射；pane/Agent 的创建、启动和宿主生命周期由 Host/运行环境负责，不属于本模板，也不属于 `herdr-link`。

## 适用条件

当 Runtime `proofloop_stage(next)` 返回 `DISPATCH_WORKER`，且 Worker routing profile 明确选择 `transport: herdr-link`。本模板不适用于 `transport: subagent`；后者是显式同 harness 兼容路线，使用 harness-native Worker wrapper，但必须遵守同一 `worker-template.md` Contract。

本次 Herdr Worker Stage 优先选择：

```yaml
transport: herdr-link
agent_kind: agy
```

在已有 `.agents/skills/proofloop-execute/SKILL.md` orchestration 上，Brain/adapter 必须按以下顺序加载：

1. `.agents/skills/proofloop-worker/SKILL.md`：跨 harness Worker 行为、结果输出和主动唤醒协议；
2. `.agents/skills/proofloop-execute/references/worker-template.md`：跨 harness 的 Worker 业务 Contract；
3. `.agents/skills/proofloop-execute/references/herdr-worker-template.md`（本模板）：Herdr Host relay、Session 绑定、结果读取映射和恢复规则。

不得仅凭自然语言“你是 worker”假定目标 harness 已加载 Worker 规则；dispatch packet 必须明确 `role: worker`、`skill: proofloop-execute` 和模板引用。

本模板不授权 Worker 执行，也不生成 Manifest、Context、Receipt 或状态迁移。Runtime 返回的 Context、digest 和 `execution_scope` 才是当前 Task 的执行授权。

## Herdr Link 传输

当 `herdr-link` 可用且 Worker 有稳定 Agent Name 时，使用 `herdr_link_send` 发送 Task packet，并接收 Worker 返回的 Result reply。Link 的 `message` 是 opaque transport payload；Runtime 仍是唯一 Result/admission 权威。

`herdr_link_peers` 发现 live peer，`herdr_link_send` 发送消息并携带回复关联，`herdr_link_close` 关闭已命名 Agent。普通消息和 Worker Result 只通过 `herdr_link_send` 传输，pane/Agent 资源由 Host/运行环境负责。

Brain 的 dispatch、continue、recall 三个决策以 `.agents/contracts/brain/herdr-link-worker-lifecycle.md` 为准。

## Harness routing

- `transport` 在 Session 创建时固定为 `herdr-link` 或 `subagent`；本模板承载 `herdr-link`。`subagent` 是显式同 harness 兼容路由，不是跨 pane 通信，也不是 Herdr 失败后的隐式 fallback。
- `agent_kind` 是 Host routing 选择，默认 `agy`；切换为 `pi` 时，表示 Host 启动独立的 Pi harness，不是 `Agent({ subagent_type: "worker" })`，也不是 `pi-subagents` 扩展。`agent_kind` 不适用于 `transport: subagent`。
- `agent_kind` 必须在 Worker Session 创建时确定，并在该 Slice 的相邻 Task、`finalize-slice`、CV repair/recheck 期间保持不变。
- 目标 harness 必须能够读取项目中的 `proofloop-execute` Skill 和本模板；不能把 harness 私有 prompt 当作 ProofLoop Contract 的第二事实源。
- routing profile 只属于 Host/dispatch 层，不写入 Manifest、Context、Evidence、Receipt 或其他 Runtime-owned 制品。

建议的 routing profile（实现适配器时使用；本模板不要求现在创建配置文件）：

```yaml
version: 1
roles:
  worker:
    transport: herdr-link
    agent_kind: agy # Host route only
```

## Session 与 pane 绑定

- 一个逻辑 Worker Session 绑定一个 agent/pane；一个 Session 覆盖一个 Slice 的 Worker Task 回路。pane/Agent 由 Host/运行环境创建与启动，不通过 `herdr-link` 创建。
- 多个逻辑 Worker 可以并行，但每个 Session 必须使用独立 agent/pane、独立 action/context 绑定和独立结果读取。
- Task 完成后不关闭 pane。只有 Runtime 接纳当前 Worker Result 后，Brain 才能向同一 Session 派发下一个 Runtime Primary Next Action。
- Slice 的全部 Task 完成后，Worker 通过 `finalize-slice` 返回 `READY_FOR_CV`，保持 Session 等待 CV。
- CV `REPAIR` 使用同一 Worker Session；只有 Runtime 接纳 canonical CV `PASS` 后才关闭或释放 harness。
- pane、agent、terminal、session 等标识是 relay 诊断信息，不能写入持久化 ProofLoop 制品作为授权依据。

### Pane 布局策略

这是 Host 的显示布局策略，不是 Runtime/Manifest/Context 授权，也不改变 Worker Session 绑定。Host 创建新 Worker harness 时必须显式选择 split 方向，并维护当前 workspace 的 Worker slot（槽位）计数：

- 第 1、2 个新 Worker harness：优先向右分屏（`direction: right`）；第 2 个仍从 Worker 区域的右侧扩展，不移动或重排已有 Pane。
- 第 3、4 个新 Worker harness：在 Worker 区域内向下分屏（`direction: down`）。
- 每次 split 前先固定目标 pane、slot 和 live session 绑定；不能依赖默认方向，不能因为布局调整而关闭、迁移或复用另一个 Worker 的 pane。
- 超过第 4 个 harness 时必须由 Host 明确选择新的布局策略；本规则不隐式推导。

上述 `right`/`down` 是语义策略，不是对底层命令语法的缓存。具体 CLI 参数与 Handle 解析由 Host 环境及其安装版本提供。

## 派发与读取步骤

### 1. 验证入口

Brain/adapter 在派发前必须重新读取并核对：

- 当前唯一 `DISPATCH_WORKER` action、`task_id`、`mode` 和 `actionToken`；
- `context_ref`、`context_digest`、`manifest_digest`、`plan_digest`、`proof_index_digest` 和 `snapshot_digest`；
- Context 的 root-bound `allowed_paths`、`mutable_projection_paths`、Evidence path 和非空 `execution_scope`；
- 当前 Worker Session 是否仍绑定同一个 Slice 和 semantic input digest。

缺少或不一致时返回 bounded blocker；不要让 harness 自行补 Context、猜路径或重新生成 Plan。

### 2. 启动或恢复目标 harness

目标 pane 必须已经由 Host/运行环境创建，并处于可启动 agent 的 shell prompt。Host 负责启动目标 `agent_kind`，并将当前 routing profile、pane 和有界 timeout 作为 Host 输入；本模板不重复规定底层命令语法。

已有 Session 优先复用原 agent/pane。Host 的 session restore 只恢复 Host 会话，不等于恢复 Runtime action；恢复后仍须重新核对 action、Context、Git、Evidence 和 Receipt。

### 3. 提交一个 Task packet

每次只提交当前 Runtime 指定的一个 Task。packet 使用 `worker-template.md` 的完整字段，并增加仅供 Host relay 使用的外层信息：

```yaml
role: worker
skill: proofloop-execute
template_ref: .agents/skills/proofloop-execute/references/worker-template.md
host_template_ref: .agents/skills/proofloop-execute/references/herdr-worker-template.md
host_relay:
  transport: herdr-link
  profile_ref: herdr-worker
  agent_kind: agy
  worker_session_ref: <ephemeral-session-ref>
```

`host_relay` 不进入 Runtime Result Contract；`worker_session_ref` 不得写入 Evidence、Receipt、Manifest、Context 或 Git。

### Link dispatch/result

当 Session 选择 `herdr-link` 且 Agent Name 有效时：

1. Brain 使用 `herdr_link_send` 发送 Task packet，不等待、不轮询；保存返回的 message `id`。
2. Worker 完成代码、测试、Evidence 和允许 projection 后，通过 `herdr_link_send` 向 Brain 发送一个 Result reply，并关联原 dispatch message `id`。
3. `message` 只承载 opaque WorkerResult payload；Brain 校验闭集 schema、`actionToken`、digest、回复关联和当前 Context，再交给 Runtime consumer。
4. Link `status: sent`、Agent `idle`/`done`、模型摘要和 Git diff 都不是完成证据。
5. Result 缺失、截断、重复、错 action、错 digest 或错回复关联时 fail closed；已有成果走 `recover-task`/`recheck`。

### Result envelope

正文必须使用当前 `VNextWorkerResultEnvelope` 的闭集字段：`schemaVersion`、`actionToken`、`stageId`、`sliceId`、`taskId`、`mode`、`outcome`、`evidenceRef`、`changedFiles`、`verificationRuns`、`manifestDigest`、`planDigest`、`proofIndexDigest`、`snapshotDigest`、`contextRef`、`contextDigest`，以及仅 `mode='repair'` 时允许出现的 `repairsCvReceiptDigest`（64hex，非 repair mode 禁止携带）。

- `outcome: completed` 是 Worker envelope 字段；Runtime admission 才形成 `TASK_COMPLETE`，Worker 不伪造 Receipt。
- `actionToken`、digest、`evidenceRef` 和 `changedFiles` 是候选事实；Brain 必须重读 Evidence、tasks.md、Context、Git HEAD/diff 和相关 Receipts。
- 不得把 Host lifecycle、模型叙事或 `git diff` 单独解释为完成，也不得加入 Runtime-owned Receipt、Manifest、Context 或状态字段。

## Session loop

```text
Runtime DISPATCH_WORKER
  → Herdr Link send 当前 Task（`herdr_link_send`）
  → Result reply + Runtime Worker Result admission
  → 同一 Session 保持可续接
  → Brain 派发 Slice 的下一个 Runtime-selected Task
  → 所有 Task 完成后 finalize-slice / READY_FOR_CV
  → 同一 Session 等待 CV
  → CV REPAIR：同一 Session repair/diagnose/recheck
  → canonical CV PASS：关闭或释放 harness
```

每个 Task 的 `TASK_COMPLETE` 必须先被 Runtime 接纳，才能派发下一个 Task。多个 Worker Session 的并行由现有 Brain/Runtime 调度决定；本模板只保证各 Session 的绑定和续接不互串。

## 恢复、超时与回退

| 情况 | 处理 |
|---|---|
| Herdr/agent 暂时不可用，且尚未产生本次 Task diff | 返回 typed blocker，或在新 Session 创建时选择另一个 Host `agent_kind` |
| pane/Session 丢失，但已有代码、Evidence 或 tasks projection | 保留现有 diff，重新读取 Runtime 事实并走 `recover-task`/`recheck`；不得用 `implement-task` 重做 |
| Herdr 重启 | 使用稳定的 Host session restore；恢复后重新校验 action、Context digest、Git/Evidence 和结果块 |
| 超时、`unknown` 或结果块无法解析 | 先读取 agent 状态、持久化制品和 Git diff；返回 blocker 或 recovery route，不盲目重发 |
| CV `REPAIR` | 使用同一 Worker Session 和 `mode: repair`（taskless，携带 `repairs_cv_receipt_digest`）；repair envelope 不进 admit-worker，经 `stage next` 校验绑定置 `PENDING_RECHECK` 后，由 Runtime 发起 fresh bounded CV recheck |
| canonical CV `PASS` | 仅以 Runtime CV PASS Receipt 为关闭条件，随后释放/关闭对应 harness |

Herdr 不可用时，允许在创建显式新/recovery Session 时选择 `transport: subagent` 兼容路由；这是显式同 harness 路线，不是静默 fallback。已有成果、未决 action 或未接纳 diff 存在时，任何切换都必须走 recovery/recheck，不得静默重派实现 Task。`subagent` 路由仍需产出同一 Worker Result Contract，并由其 host adapter 做等价校验。

## 完成标准

本模板的 Host relay 步骤只有在以下事实全部成立时才算完成：

1. 当前 Task 的 transport payload 被严格解析并绑定到当前 action；
2. Brain/adapter 已重新读取持久化 Evidence、tasks.md、Git/diff 和 Context；
3. Runtime Worker Result admission 已明确接受或返回 bounded blocker；
4. 下一 Task、`RUN_CV` 或 repair action 已由 Runtime 重新计算；
5. pane 生命周期按 Slice/CV 规则处理，且没有把 Host 状态写成 Runtime authority。