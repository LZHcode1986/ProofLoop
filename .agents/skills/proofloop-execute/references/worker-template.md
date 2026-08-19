# Worker 派发模板

本模板供 `proofloop-execute` 由 Brain 直接调度 Worker 使用。它定义跨 harness 的 Worker Contract；通用 Worker 行为、Evidence 顺序、结果输出和主动唤醒协议以 `.agents/skills/proofloop-worker/SKILL.md` 为唯一事实源。Host relay 的启动、等待、读取和 Session 生命周期由所选 transport 的模板负责。

## Host relay 选择

Worker 的目标 Host 由 Brain/dispatch routing 在 Session 创建时确定。Stage 同时支持两种显式 transport；默认迁移路线为 Herdr：

```yaml
host_relay:
  transport: herdr | subagent
  profile_ref: herdr-worker | subagent-worker
  agent_kind: agy # 仅 transport: herdr；默认值
```

- `host_relay` 是一次性派发元数据，不属于 Manifest、Context、Evidence、Receipt 或 Runtime Result Contract。
- `transport: herdr` 时，Brain/adapter 使用固定加载链：`.agents/skills/herdr/SKILL.md`（通用 Herdr 控制面）→ `.agents/skills/proofloop-worker/SKILL.md`（跨 harness Worker 行为）→ 本模板（跨 harness Worker 业务 Contract）→ `references/herdr-worker-template.md`（Herdr relay 映射）。底层 Herdr CLI 参数、Handle/ID 规则和 lifecycle 命令由 Herdr Skill 维护，本模板不重复定义。
- `transport: subagent` 时，Brain/host 使用现有 harness-native Worker wrapper；只加载本模板及该 harness 的 Worker wrapper，不加载 Herdr CLI 控制面。该路由是迁移兼容路径，不是 Herdr 失败后的隐式 fallback。
- `agent_kind` 只适用于 `transport: herdr`：`agy` 为本 Stage 默认 harness，`pi` 表示 Herdr 启动独立 Pi harness，不是 `pi-subagents` 扩展。`transport: subagent` 使用 harness 原生 Worker 目标。
- 同一 Worker Session 的相邻 Task、`finalize-slice` 和 CV repair/recheck 必须保持同一 transport、Session 和 harness binding；切换只能在新 Session 或显式 recovery route 中发生。

## 派发数据包

```yaml
target_agent: worker
caller: brain
skill: proofloop-execute
skill_ref: .agents/skills/proofloop-worker/SKILL.md
contract_mode: vnext-template
mode: implement-task | recover-task | finalize-slice | repair
stage_id: <stage-id>
slice_id: <slice-id>
task_id: <single-current-task-id | null for finalize-slice>
project_root: <canonical-trust-root>
manifest_path: .proofloop/manifests/<stage-id>.json
manifest_digest: <sha256>
plan_digest: <sha256>
context_ref: .proofloop/context/<context-digest>.json
context_digest: <sha256>
snapshot_digest: <sha256>
evidence_path: delivery/stages/<stage-id>/evidence/<slice-id>.md
plan_projection_path: delivery/stages/<stage-id>/tasks.md
scope:
  allowed_paths: []
  mutable_projection_paths: []
  forbidden_paths: []
slice_task_ids: []
completed_task_ids: []
previous_task_receipts: []
current_task_goal: <required for task modes>
execution_scope:
  kind: implementation | evidence-only
  code_paths: []
  test_paths: []
  forbidden_paths: []
required_skills: []
allowed_code_scope: []
forbidden_scope: []
stop_conditions: []
expected_result: TASK_COMPLETE | READY_FOR_CV
host_relay:
  transport: herdr | subagent
  profile_ref: herdr-worker | subagent-worker
  agent_kind: agy # transport: herdr only
  # worker_session_ref is ephemeral and never persisted
```

`host_relay` 仅供 Brain/Herdr adapter 使用；Runtime admission 只消费当前 Worker Contract、Context 和非权威 Worker Result envelope。Herdr 的 lifecycle 状态不能代替 `TASK_COMPLETE`、CV verdict 或 Receipt。

## 必需规则

- `implement-task`、`recover-task` 必须只有一个 `task_id`；
- `implement-task` 必须携带与 Context/Manifest 完全一致的 immutable `execution_scope`；
  `code_paths`、`test_paths` 和 `allowed_code_scope` 非空且 root-bound，不能只有
  Evidence path；`evidence-only` scope 不能路由为 `implement-task`；
- `plan_projection_path` 必须等于 admitted `Manifest.plan.ref` 的 root-bound 路径；
  `scope.mutable_projection_paths` 必须只列出该 path，`scope.allowed_paths` 必须包含
  code/test paths、当前 Slice Evidence path 和该 Plan projection path；
- `allowed_code_scope` 只能是 `execution_scope.code_paths` 与 `test_paths` 的并集，
  不得包含 `plan_projection_path`、Evidence path 或其他 `tasks.md` 路径；
- 不提供未来 Task 正文或完整 `tasks.md`；
- `previous_task_receipts` 必须逐项绑定 evidence path、source/current snapshot 和 result；
- Worker 必须先写 Task Evidence，再更新 checkbox projection；
- Worker 只能修改当前 Slice 的实现范围、当前 Task 的 checkbox/Worker Status
  projection 和指定 Evidence sections；`tasks.md` 不是 implementation code scope；
- `tasks.md` 禁止修改 Stage/Slice/Task goal、refs、dependencies、required_skills、
  `execution_scope`、Proof Index、entity markers、其他 Task/Slice 或 candidate input；
- 若 immutable Plan 内容发生变化，或 Context/packet 的 `plan_digest` 不匹配 admitted
  Plan/Manifest，必须 fail closed 并返回 bounded blocker，不得继续或自行修复 Plan；
- Worker 不写 Receipt、Current CV Status、Gate verdict，不提交 Git；
- `finalize-slice` 只更新 Current Slice Evidence，不能修改实现或 checkbox；
- repair 只能修复 CV 指定的 bounded failure；repair 派发必须要求加载
  `diagnose` 技能（复现 → 根因隔离 → bounded 修复 → 验证）。

## 完成回传与 Runtime 路由

Worker 的完整结果输出、回调时序和 Herdr `idle`/`done` 后读取规则由
`.agents/skills/proofloop-worker/SKILL.md` 定义；本 Contract 只补充以下路由边界：

- `implement-task`、`recover-task` 的完整 Result 读取后，Brain 重读持久化事实，再
  交给 `stage admit-worker`；
- `finalize-slice` 的 `READY_FOR_CV` 只表示 Slice 证据可供 CV，不能按普通
  `TASK_COMPLETE` 接纳；
- `repair`、`diagnose` 的 Result 只能进入 fresh CV recheck。当前 Runtime 不接受
  `mode: repair` 的 `stage admit-worker` 请求，禁止把 repair 伪装成
  `implement-task` 或 `recover-task`；
- callback、`result_available: true`、Herdr lifecycle、模型总结和工作区 diff 都
  不是 Receipt 或完成授权；缺少可解析 Result block 时 fail closed。

## Task Evidence 书写规范

- 每个任务的 Task Evidence 小节标题必须为 `### <task_id>`（该任务的
  task id），同文件内**恰好一个且唯一**——不得出现第二个相同标题；
- 任务内子记录（RED/GREEN Receipt 字段、修复记录、状态等）一律用 `####`
  子标题或 `- label:` 列表项，**不得**使用 `###`；
- 违规后果：admission（`assertCurrentTaskEvidence`）会拒绝该 Worker 结果
  且不写 Receipt——标题缺失时提示缺少 `### <task_id>` 标题（应为
  `### <taskId>`）；标题重复时提示重复位置（行号）并要求子记录改用
  `####` 或 `- label:`。

## 允许的结果

```text
implement-task / recover-task → TASK_COMPLETE 或结构化 blocker
finalize-slice / repair → READY_FOR_CV 或结构化 blocker
```

结构化 blocker 必须包含 `route_code`、`subtype`、`reason`、
`invalidation_scope` 和 `resume_target`。Worker 不得把自身结果写成 CV PASS、Slice COMPLETE 或 Stage COMPLETE。

## 恢复

同 Slice 且 semantic input digest 未变时可以继续原 Worker session；Herdr 路由应复用原 agent/pane。session
丢失时 Brain 从 Manifest、Context、Plan projection、Evidence、Git 和
Receipts 构造 fresh packet。`recover-task` 只负责已存在成果的 Evidence/checkbox
一致性重检：必须携带与当前 Context/Manifest/Plan/snapshot 绑定的 recovery
discriminator，Runtime Result admission 必须能区分 recovery consistency recheck
与新的 implementation，不得静默改写为 `implement-task`；没有可持久化、可校验的
discriminator 时必须返回 `RUNTIME_BLOCKER`，不得绕过，也不得重新实现已存在的
代码。Herdr 恢复只恢复 relay/session，不恢复 Runtime 授权；恢复后必须重新读取
当前 action、Context、Evidence、Git/diff 和 Receipt。session ID 不得进入任何持久化制品。

当 `herdr` transport 被选中时，Worker 最后输出必须使用
`herdr-worker-template.md` 定义的带边界 Worker Result transport payload；Herdr
adapter 严格解析并交给 Runtime admission。当 `subagent` transport 被选中时，
harness-native wrapper 必须产出同一跨 harness Worker Result Contract，并由对应
adapter 做同等绑定校验。任一路由的终端 lifecycle、自由文本和 harness 叙事都不是
完成事实。
