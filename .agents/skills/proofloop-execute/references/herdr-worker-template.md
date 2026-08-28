# `herdr-link` Worker Host Relay Template

本模板只定义 `transport: herdr-link` 的 Host relay、Session 映射和结果读取；Worker 的 Task/Scope/
Evidence/Result schema 读取 `worker-template.md`，行为顺序读取
`.agents/skills/proofloop-worker/SKILL.md`，生命周期语义读取
`.agents/contracts/brain/herdr-link-worker-lifecycle.md`。

## 适用条件与 Host metadata

当 Runtime `proofloop stage next` 返回 `DISPATCH_WORKER`，且 Brain 在 Session 创建时明确选择
`transport: herdr-link` 时使用本模板。`subagent` 是显式同 harness 兼容路线，不使用本模板，但必须
产出同一 Worker Result Contract。

```yaml
role: worker
skill: proofloop-execute
template_ref: .agents/skills/proofloop-execute/references/worker-template.md
host_template_ref: .agents/skills/proofloop-execute/references/herdr-worker-template.md
host_relay:
  transport: herdr-link
  profile_ref: herdr-worker
  agent_kind: agy # Host route only
  worker_session_ref: <ephemeral; never persisted>
```

`host_relay`、`agent_kind`、pane、Agent Name、Session 和 routing profile 都是 Host/relay metadata，
不进入 Manifest、Context、Evidence、Receipt 或 Runtime 状态。pane/Agent 创建、启动、布局和宿主
生命周期由 Host/运行环境负责；`herdr-link` 只承载 message。

## `herdr-link` 工具与消息边界

- `herdr_link_peers`：发现稳定 Agent Name 的 live peer；不选择、不排序 Worker。
- `herdr_link_send`：发送一个 Task packet 或其 Result reply；`status: sent` 只表示 gateway 接收。
- `herdr_link_close`：按稳定 Agent Name 关闭已命名 Agent；不代替 Runtime action 或 Receipt。

普通 Task/Result 以及回复关联只通过 `herdr_link_send` 传输。Link message 是 opaque payload，
ProofLoop 字段只在 Brain/Runtime 层解析；不通过 Link 创建 pane/Agent，不使用其他消息通道。

## Dispatch 前置检查

Brain/adapter 先重新读取并核对：

- 当前唯一 `DISPATCH_WORKER` action、`actionToken`、`stage_id`、`slice_id`、`task_id`、`mode`；
- `context_ref`/`context_digest`、Manifest/Plan/Proof Index/snapshot digest；
- root-bound `allowed_paths`、`mutable_projection_paths`、Evidence path 和非空 `execution_scope`；
- 当前 Session 的 Slice、Agent identity、transport 和 semantic input digest。

缺少或不一致时返回 typed blocker，不让 Host 补 Context、猜路径、重渲染 Plan 或自行选择下一个 action。

## Session 与 pane 映射

1. Host 预先创建目标 pane/Agent，并启动能加载项目 Skill、Worker Template 和当前 Contract 的 harness；
   创建能力不经 `herdr-link`。
2. 一个 Worker Session 绑定一个 Agent/pane 和一个 Slice 的 Worker Task 回路；并行 Session 必须
   使用独立 binding，不能互串。
3. 同一 Slice 的相邻 Task、`finalize-slice`、CV repair/recheck 优先复用同一 Session；只有 Runtime
   接纳前一结果后，Brain 才能发送下一 Task。
4. Task 全部完成后，向同一 Session 发送 `finalize-slice`，等待 `READY_FOR_CV`；canonical CV PASS
   后才可关闭/释放。单 Task、Agent `idle`/`done` 或暂时无 action 都不触发关闭。
5. pane/Agent/Session 标识只留在临时 relay 状态和诊断中，不能写入任何 ProofLoop authority。

## 传输步骤

### Dispatch

1. Brain 调用 `herdr_link_send` 发送 `worker-template.md` 定义的完整当前 Task packet，并保存返回的
   message `id` 与临时 action 关联；不等待、不轮询。
2. Host 将 packet 交给已绑定的 Agent/pane；Worker 按 `proofloop-worker` Skill 运行并生成同一 Result schema。

### Result

1. Worker 通过 `herdr_link_send` 回复原 dispatch message；message 只承载 opaque Result payload。
2. Brain 校验 schema、actionToken、Stage/Slice/Task、所有 digest、scope、回复关联和当前 Context，
   然后重新读取 Evidence、tasks projection、Git/diff、Context 与 Receipts。
3. 只有正确 Runtime consumer 接纳 Result 后，Brain 才能发送下一个 action；delivery `status: sent`、
   Agent 状态、模型摘要或 Git diff 都不是完成事实。

### Session 映射

```text
Runtime DISPATCH_WORKER
  → herdr_link_send 当前 packet
  → Result reply（herdr_link_send）
  → Brain re-read + Runtime Worker admission
  → 同 Session 的下一个 Runtime action
  → finalize-slice / READY_FOR_CV
  → fresh CV 或 repair/recheck
  → canonical CV PASS 后关闭/释放
```

## 恢复与 transport 选择

| 事实 | 路由 |
|---|---|
| Link/tool 失败，尚无本次 Task 成果 | 保留 typed blocker；新 Session 创建时可显式选择 `subagent` |
| pane/Session 丢失但有 code、Evidence 或 projection | 保留成果，重读 Runtime facts，走 `recover-task`/`recheck` |
| reply 缺失、截断、重复、错关联或 digest 不符 | fail closed，不伪造/盲目重发；按 lifecycle recovery |
| Agent 重启或 pane 替换 | 重新发现 peer/identity，Host 重建资源；旧标识不能直接续接 |
| CV `REPAIR` | 同 Session `mode: repair`，携带 `repairs_cv_receipt_digest`；Runtime 校验后触发 fresh CV |
| canonical CV `PASS` | 仅 Runtime Receipt 是关闭条件，随后由 Host 释放/关闭 |

`transport` 一旦创建即固定。`herdr-link` 不可用时只有显式新/recovery Session 可以选择 `subagent`；已有
未接纳 action/成果不能静默切换，也不能把 subagent 当作跨 pane 消息通道。任一路由都必须产出
`worker-template.md` 的同一 Result Contract。

## Host relay 完成标准

本模板仅在以下事实全部成立时返回 relay completion：

1. 当前 packet/result 已严格绑定 action、Context、snapshot 和 Host Session；
2. Brain/adapter 已重读 Evidence、projection、Git/diff 和相关 Receipts；
3. Runtime Worker Result consumer 已明确接受，或已返回 typed blocker；
4. 下一 action、CV、repair 或关闭条件由 Runtime 重新计算；
5. 没有把 Host lifecycle、Link delivery 或模型叙事写成 Runtime authority。
