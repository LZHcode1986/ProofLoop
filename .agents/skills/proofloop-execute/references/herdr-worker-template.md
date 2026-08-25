# Herdr Worker Host Relay 模板

本模板只定义 Worker 的 **Herdr host relay** 适配；Worker 的 Task、Scope、Evidence、Receipt、Runtime admission 和完成语义仍以 `worker-template.md`、当前 Context 和 Runtime Contract 为准。

底层 Herdr CLI、环境守卫、Handle/ID 规则、pane/agent 生命周期和命令语法由 `.agents/skills/herdr/SKILL.md` 统一提供；本模板只保留 ProofLoop 业务协议与 Host relay 映射，不重复定义底层 CLI。

## 适用条件

当 Runtime `proofloop_stage(next)` 返回 `DISPATCH_WORKER`，且 Worker routing profile 明确选择 `transport: herdr-link` 或显式 `transport: herdr-legacy`。本模板不适用于 `transport: subagent`；后者使用 harness-native Worker wrapper，但必须遵守同一 `worker-template.md` Contract。
本次 Herdr Worker Stage 优先选择：
```yaml
transport: herdr-link # 无 Link Adapter 时显式选择 herdr-legacy
agent_kind: agy
```

在已有 `.agents/skills/proofloop-execute/SKILL.md` orchestration 上，Brain/adapter 必须按以下顺序加载：

1. `.agents/skills/herdr/SKILL.md`：Herdr 通用控制面；执行任何 Herdr 控制命令前先满足其中的 `HERDR_ENV=1` 守卫，并按已安装 CLI 的帮助/返回值使用命令；
2. `.agents/skills/proofloop-worker/SKILL.md`：跨 harness Worker 行为、结果输出和主动唤醒协议；
3. `.agents/skills/proofloop-execute/references/worker-template.md`：跨 harness 的 Worker 业务 Contract；
4. `.agents/skills/proofloop-execute/references/herdr-worker-template.md`（本模板）：Herdr Host relay、Session 绑定、结果读取映射和恢复规则。

不得仅凭自然语言“你是 worker”假定目标 harness 已加载 Worker 规则；dispatch packet 必须明确 `role: worker`、`skill: proofloop-execute` 和模板引用。

本模板不授权 Worker 执行，也不生成 Manifest、Context、Receipt 或状态迁移。Runtime 返回的 Context、digest 和 `execution_scope` 才是当前 Task 的执行授权。
## Herdr Link 优先级

当 `herdr-link/1` 可用且 Worker 有稳定 Agent Name 时，使用 `herdr_link_send` 发送 Task packet，并通过 `reply_to` 回复 Worker Result。Link 的 `message` 是 opaque transport payload；Runtime 仍是唯一 Result/admission 权威。

`.agents/skills/herdr/SKILL.md` 和 Herdr CLI 仍用于 pane 创建/布局、Agent 启动/恢复、identity/lifecycle 检查及显式兼容路由；Link route 下不用于普通消息。Brain 的 dispatch、continue、recall 三个决策以 `.agents/contracts/brain/herdr-link-worker-lifecycle.md` 为准。

后文 ACP/READY/`recent-unwrapped` 仅表示显式选择的 legacy Herdr transport；不能与 Link route 静默混用。

## Harness routing

- `transport` 在 Session 创建时固定为 `herdr-link`、`herdr-legacy` 或 `subagent`；本模板承载前两种 Herdr route。`subagent` 是显式迁移兼容路由，不是 Herdr 失败后的隐式 fallback。
- `agent_kind` 是 Herdr Host routing 选择，默认 `agy`；切换为 `pi` 时，表示 Herdr 启动独立的 Pi harness，不是 `Agent({ subagent_type: "worker" })`，也不是 `pi-subagents` 扩展。`agent_kind` 不适用于 `transport: subagent`。
- `agent_kind` 必须在 Worker Session 创建时确定，并在该 Slice 的相邻 Task、`finalize-slice`、CV repair/recheck 期间保持不变。
- Herdr 支持的目标 harness 必须能够读取项目中的 `proofloop-execute` Skill 和本模板；不能把 harness 私有 prompt 当作 ProofLoop Contract 的第二事实源。
- routing profile 只属于 Host/dispatch 层，不写入 Manifest、Context、Evidence、Receipt 或其他 Runtime-owned 制品。

建议的 routing profile（实现适配器时使用；本模板不要求现在创建配置文件）：

```yaml
version: 1
roles:
  worker:
    transport: herdr-link | herdr-legacy
    agent_kind: agy # Herdr route only
```

## Session 与 pane 绑定

- 一个逻辑 Worker Session 绑定一个 Herdr agent/pane；一个 Session 覆盖一个 Slice 的 Worker Task 回路。
- 多个逻辑 Worker 可以并行，但每个 Session 必须使用独立 agent/pane、独立 action/context 绑定和独立结果读取。
- Task 完成后不关闭 pane。只有 Runtime 接纳当前 Worker Result 后，Brain 才能向同一 Session 派发下一个 Runtime Primary Next Action。
- Slice 的全部 Task 完成后，Worker 通过 `finalize-slice` 返回 `READY_FOR_CV`，保持 Session 等待 CV。
- CV `REPAIR` 使用同一 Worker Session；只有 Runtime 接纳 canonical CV `PASS` 后才关闭或释放 harness。
- Herdr 的 pane、agent、terminal、session 等标识是 relay 诊断信息，不能写入持久化 ProofLoop 制品作为授权依据。

### Pane 布局策略

这是 Host relay 的显示布局策略，不是 Runtime/Manifest/Context 授权，也不改变 Worker
Session 绑定。Host 创建新 Worker harness 时必须显式选择 split 方向，并维护当前
workspace 的 Worker slot（槽位）计数：

- 第 1、2 个新 Worker harness：优先向右分屏（`direction: right`）；第 2 个仍从
  Worker 区域的右侧扩展，不移动或重排已有 Pane。
- 第 3、4 个新 Worker harness：在 Worker 区域内向下分屏（`direction: down`）。
- 每次 split 前先固定目标 pane、slot 和 live session 绑定；不能依赖 Herdr 默认方向，
  不能因为布局调整而关闭、迁移或复用另一个 Worker 的 pane。
- 超过第 4 个 harness 时必须由 Host 明确选择新的布局策略；本规则不隐式推导。

具体 CLI 参数和 Handle 解析始终以 `.agents/skills/herdr/SKILL.md` 及当前安装版本的
`--help` 为准；上述 `right`/`down` 是语义策略，不是对底层命令语法的缓存。

## 派发与读取步骤

### 1. 验证入口

Brain/adapter 在派发前必须重新读取并核对：

- 当前唯一 `DISPATCH_WORKER` action、`task_id`、`mode` 和 `actionToken`；
- `context_ref`、`context_digest`、`manifest_digest`、`plan_digest`、`proof_index_digest` 和 `snapshot_digest`；
- Context 的 root-bound `allowed_paths`、`mutable_projection_paths`、Evidence path 和非空 `execution_scope`；
- 当前 Worker Session 是否仍绑定同一个 Slice 和 semantic input digest。

缺少或不一致时返回 bounded blocker；不要让 harness 自行补 Context、猜路径或重新生成 Plan。

### 2. 启动或恢复目标 harness

目标 pane 必须已经由 Herdr 创建，并处于可启动 agent 的 shell prompt。通过 `.agents/skills/herdr/SKILL.md` 定义的 Herdr agent lifecycle 操作启动目标 `agent_kind`，并将当前 routing profile、pane 和有界 timeout 作为 Host 输入；本模板不重复规定 CLI 参数语法。

已有 Session 优先复用原 agent/pane。Herdr 的 session restore 只恢复 Host 会话，不等于恢复 Runtime action；恢复后仍须重新核对 action、Context、Git、Evidence 和 Receipt。

### 3. 提交一个 Task packet

每次只提交当前 Runtime 指定的一个 Task。packet 使用 `worker-template.md` 的完整字段，并增加仅供 Host relay 使用的外层信息：

```yaml
role: worker
skill: proofloop-execute
template_ref: .agents/skills/proofloop-execute/references/worker-template.md
host_template_ref: .agents/skills/proofloop-execute/references/herdr-worker-template.md
host_relay:
  transport: herdr-link | herdr-legacy
  profile_ref: herdr-worker
  agent_kind: agy
  worker_session_ref: <ephemeral-herdr-session-ref>
```

`host_relay` 不进入 Runtime Result Contract；`worker_session_ref` 不得写入 Evidence、Receipt、Manifest、Context 或 Git。

### Link dispatch/result

当 Session 选择 `herdr-link` 且 Agent Name 有效时：

1. Brain 使用 `herdr_link_send` 发送 Task packet，不等待、不轮询；保存返回的 message `id`。
2. Worker 完成代码、测试、Evidence 和允许 projection 后，通过 Link 向 Brain 发送一个 Result reply，并将 `reply_to` 设为 dispatch message `id`。
3. `message` 只承载 opaque WorkerResult payload；Brain 校验闭集 schema、`actionToken`、digest、reply 目标和当前 Context，再交给 Runtime consumer。
4. Link `status: sent`、Agent `idle`/`done`、模型摘要和 Git diff 都不是完成证据。
5. Result 缺失、截断、重复、错 action、错 digest 或错 `reply_to` 时 fail closed；已有成果走 `recover-task`/`recheck`。

### Legacy Herdr route

只有 Session 显式选择没有 Link Adapter 的 legacy route，才使用 ACP/READY/`recent-unwrapped`。该 route 的完整 marker、idle/done 边界和 fail-closed 规则保留为兼容要求，不得与 Link route 静默混用。

### Result envelope

无论 transport route 如何，正文必须使用当前 `VNextWorkerResultEnvelope` 的闭集字段：`schemaVersion`、`actionToken`、`stageId`、`sliceId`、`taskId`、`mode`、`outcome`、`evidenceRef`、`changedFiles`、`verificationRuns`、`manifestDigest`、`planDigest`、`proofIndexDigest`、`snapshotDigest`、`contextRef`、`contextDigest`，以及仅 `mode='repair'` 时允许出现的 `repairsCvReceiptDigest`（64hex，非 repair mode 禁止携带）。
- `outcome: completed` 是 Worker envelope 字段；Runtime admission 才形成 `TASK_COMPLETE`，Worker 不伪造 Receipt。
- `actionToken`、digest、`evidenceRef` 和 `changedFiles` 是候选事实；Brain 必须重读 Evidence、tasks.md、Context、Git HEAD/diff 和相关 Receipts。
- 不得把 Herdr lifecycle、模型叙事或 `git diff` 单独解释为完成，也不得加入 Runtime-owned Receipt、Manifest、Context 或状态字段。
## Session loop

```text
Runtime DISPATCH_WORKER
  → Herdr Link send 当前 Task（legacy route 才使用 Herdr prompt）
  → `reply_to` Result + Runtime Worker Result admission
  → 同一 Session 保持可续接
  → Brain 派发 Slice 的下一个 Runtime-selected Task
  → 所有 Task 完成后 finalize-slice / READY_FOR_CV
  → 同一 Session 等待 CV
  → CV REPAIR：同一 Session repair/diagnose/recheck
  → canonical CV PASS：关闭或释放 harness
```

每个 Task 的 `TASK_COMPLETE` 必须先被 Runtime 接纳，才能派发下一个 Task。多个 Worker Session 的并行由现有 Brain/Runtime 调度决定；本模板只保证各 Session 的 Herdr 绑定和续接不互串。

## 恢复、超时与回退

| 情况 | 处理 |
|---|---|
| Herdr/agent 暂时不可用，且尚未产生本次 Task diff | 返回 typed blocker，或在新 Session 创建时选择另一个 Herdr `agent_kind` |
| pane/Session 丢失，但已有代码、Evidence 或 tasks projection | 保留现有 diff，重新读取 Runtime 事实并走 `recover-task`/`recheck`；不得用 `implement-task` 重做 |
| Herdr 重启 | 使用稳定的 Herdr session restore；恢复后重新校验 action、Context digest、Git/Evidence 和结果块 |
| 超时、`unknown` 或结果块无法解析 | 先读取 agent 状态、持久化制品和 Git diff；返回 blocker 或 recovery route，不盲目重发 prompt |
| CV `REPAIR` | 使用同一 Worker Session 和 `mode: repair`（taskless，携带 `repairs_cv_receipt_digest`）；repair envelope 不进 admit-worker，经 `stage next` 校验绑定置 `PENDING_RECHECK` 后，由 Runtime 发起 fresh bounded CV recheck |
| canonical CV `PASS` | 仅以 Runtime CV PASS Receipt 为关闭条件，随后释放/关闭对应 harness |

Herdr 不可用时，迁移期允许在创建显式新/recovery Session 时选择另一个 **Herdr 管理的** harness（例如 `agent_kind: pi`），或选择 `transport: subagent` 兼容路由；两者都不是静默 fallback。已有成果、未决 action 或未接纳 diff 存在时，任何切换都必须走 recovery/recheck，不得静默重派实现 Task。`subagent` 路由仍需产出同一 Worker Result Contract，并由其 host adapter 做等价校验。

## 完成标准

本模板的 Host relay 步骤只有在以下事实全部成立时才算完成：

1. 当前 Task 的 transport payload 被严格解析并绑定到当前 action；
2. Brain/adapter 已重新读取持久化 Evidence、tasks.md、Git/diff 和 Context；
3. Runtime Worker Result admission 已明确接受或返回 bounded blocker；
4. 下一 Task、`RUN_CV` 或 repair action 已由 Runtime 重新计算；
5. pane 生命周期按 Slice/CV 规则处理，且没有把 Herdr 状态写成 Runtime authority。
