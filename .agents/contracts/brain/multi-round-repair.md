# Brain Multi-Round Repair Dispatch Contract

本 Contract 是当前 vNext Stage Execution 中多轮 repair 的 Brain 侧补充
语义。它只定义跨轮 failure history、收敛分析、字段/状态绑定和路由边界，
不复制 `proofloop-execute`/`proofloop-worker` 的执行步骤或 Host transport，
也不创建新的 Runtime action、Receipt、Context schema、状态或 Gate。

## Use when

仅在以下条件全部满足时使用：

- 当前 active Manifest、Plan、Context、Authority、Proof Index 和 snapshot tuple
  仍是同一 admitted execution binding；
- 当前 Slice 的 CV Receipt chain 已由 Runtime 接纳至少一个 `CV_REPAIR`；
- 至少一个此前的 `mode: repair` Result 已按当前绑定完成校验，并且其后 fresh
  bounded CV recheck 已由 `stage admit-cv` 接纳为 `CV_REPAIR`；
- 当前 `stage next` 的 Primary Next Action 仍明确为 `DISPATCH_WORKER` 且
  `mode: repair`；若 tuple 变化，必须走 fresh initial CV/既有 replan route。

首次 `CV_REPAIR` 后的第一轮 repair 继续完全使用当前
`.agents/skills/proofloop-execute/SKILL.md`、`.agents/skills/proofloop-worker/SKILL.md`
和 `references/worker-template.md` 的正常 `mode: repair` 语义。本 Contract 只
补充跨轮 history 和 Brain synthesis。未 admission 的 CV 叙事、`progress.md` 或
checkbox 不能触发本 Contract，也不能补全缺失事实。

## Runtime dispatch and Result boundary

本 Contract 不定义新的 packet mode 或 NextAction。Runtime `stage next` 产生
`DISPATCH_WORKER` 后，当前 packet 仍使用 `contract_mode: vnext-template`；
本 Contract 是其多轮语义补充，不是 packet schema 的替代。

```yaml
target_agent: worker
caller: brain
skill: proofloop-execute
contract_mode: vnext-template
mode: repair
task_id: <omitted>
repairs_cv_receipt_digest: <sha256>
```

repair Result 必须遵循 `references/worker-template.md` 的 v2 Result envelope，
关键 repair discriminator 如下（字段 casing 保持不变）：

```yaml
schemaVersion: 2
stageId: <stage-id>
sliceId: <slice-id>
taskId: <omitted>
mode: repair
outcome: completed | blocked | needs-decision | failed
repairsCvReceiptDigest: <sha256>
```

`outcome` 是 Worker envelope 的闭集结果，不是 CV verdict，也不表示
TASK_COMPLETE、Slice complete 或 Stage complete。完整字段、digest、changedFiles、
verificationRuns、evidenceRef 等仍以 Template 为唯一 schema 来源。

Repair 不写入新的 `TASK_COMPLETE`/Worker Receipt；`stage admit-cv` 的 bounded recheck
继续绑定该 Slice 当前 Worker Receipt tip。下一轮 `mode: repair` 必须改为绑定最新
已接纳的 `CV_REPAIR` Receipt digest。

`READY_FOR_CV` 仅是 `mode: finalize-slice` 的 Slice closure 语义；本 Contract 的
`mode: repair` Result 不使用该值。

## Required execution binding

Brain 必须从当前持久化事实提供并重新核对：

```yaml
# Runtime packet/Context shared tuple（字段名按其对象保持原样）
stage_id: <stage-id>
slice_id: <slice-id>
task_id: <omitted for repair>
project_root: <canonical-trust-root>       # packet
root_path: <canonical-trust-root>           # Context
root_digest: <sha256>
manifest_path: .proofloop/manifests/<stage-id>.json  # packet
manifest_digest: <sha256>
plan_digest: <sha256>
proof_index_digest: <sha256>
context_ref: .proofloop/context/<context-digest>.json
context_digest: <sha256>
repairs_cv_receipt_digest: <sha256>
snapshot_digest: <sha256>
evidence_path: delivery/stages/<stage-id>/evidence/<slice-id>.md
plan_projection_path: delivery/stages/<stage-id>/tasks.md
allowed_code_scope: <exact code/test union>
execution_scope:
  kind: implementation
  code_paths: <exact union of admitted Slice implementation scopes>
  test_paths: <exact union of admitted Slice implementation scopes>
  forbidden_paths: []
scope:
  allowed_paths: <exact code/test union plus evidence_path>
  mutable_projection_paths: []
  forbidden_paths: <Runtime system-forbidden paths>
required_skills: <Runtime-projected Slice skills>
```

这些绑定继续以 admitted Manifest、Plan、Context 和 Runtime Receipt 为权威；本
Contract 不扩大 `execution_scope`，也不授权修改其他 Slice、Authority、Manifest、
Receipt、Context 或 Git 状态。Repair Context 中 `task_id`/`task_ref` 必须省略而非
写入 `null`；`execution_scope` 是当前 Slice 所有 admitted implementation scope 的
精确 union，`scope.mutable_projection_paths` 必须为空，Evidence path 仍按 Runtime
scope 允许。Result 的变更文件字段使用 Template 的 `changedFiles`（camelCase），不把
`changed_files` 写入 Context 或 Result。

## Multi-round repair context

### 1. Repair history

Brain 必须按 Receipt chain 顺序提供当前 admitted tuple 下全部已接纳的
`CV_REPAIR` 引用，不复制完整 Receipt 正文：

```yaml
repair_history:
  - receipt_ref: <root-relative-receipt-path>
    receipt_digest: <sha256>
    verification_type: initial | recheck
    failure_signature: <string>
    failed_criterion: <string>
    counterexamples: []
    required_recheck_scope: []
    repair_diff_digest: <sha256 | omitted for initial>
```

`repair_diff_digest` 只按 Receipt 中的真实值引用；无法独立隔离某轮累计 diff 时，
Brain 不得把它解释成独立补丁证明。Brain 还必须提供当前实际 Git diff 和 changed-file
集合，不能只依据历史摘要。

### 2. Brain synthesis

Brain 在派发 Worker 前必须完成只读的跨轮收敛分析，并提供：

```yaml
brain_synthesis:
  shared_root_cause: <跨轮共同根因>
  prior_repair_miss: <上一轮修复方向遗漏或误判的内容>
  failure_family: <本次必须一次性闭合的问题族边界>
  independent_new_findings: []
  authority_refs: []
  producer_refs: []
  consumer_refs: []
  test_seam_refs: []
  historical_coverage: []
  complete_repair_scope:
    code_paths: []
    test_paths: []
  scope_decision: IN_SCOPE | PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER
```

分析要求：

- 将全部已接纳的历史反例按共同 Authority、Schema、真实生产端、消费端、public
  seam 或测试夹具归类，不能按 CV 轮次分别定义问题族；
- 区分“上一轮遗漏的同一问题族”和“CV 新发现的独立问题”；
- 涉及 Receipt、Manifest、Context、Schema 或其他机器数据格式时，只读核对真实
  类型定义、生产端、消费端和成功测试 seam；
- `authority_refs`、`producer_refs`、`consumer_refs` 和 `test_seam_refs` 使用稳定引用或
  root-relative path，不复制完整 Authority 正文；不适用时必须给出 bounded reason；
- `complete_repair_scope` 必须完全落在 admitted `execution_scope` 内。超出时将
  `scope_decision` 设为现有 route，不得删减成局部修复后继续派发 Worker；
- `prior_repair_miss` 是 Brain 对修复方向的跨轮复盘，不是代替 Worker 复现具体技术故障。

## Dispatch decision

Brain 只有在 `scope_decision: IN_SCOPE` 且 Runtime `stage next` 返回
`DISPATCH_WORKER`/`mode: repair` 时才派发 Worker；本 Contract 不直接调用
Runtime，也不创建或改写 NextAction。Runtime 的当前闭集分支必须保持：

- 最新 CV 状态为 `REPAIR` 且 `repair_attempt` 为 `0` 或 `1` 时，分别允许第一或
  第二次 `DISPATCH_WORKER mode=repair`；
- 已验证的 repair Result 使状态进入 `PENDING_RECHECK` 后，`stage next` 只返回
  `RUN_CV`，由 fresh bounded CV recheck 继续；
- `repair_attempt >= 2` 且最新 CV verdict 仍为 `REPAIR` 时，Runtime 返回
  `VALIDATE` 与 `UNRESOLVED_CV_FAILURE`，本 Contract 不得绕过该人工介入边界。

其他值使用既有 route：

```text
PLAN_GAP → proofloop-plan
AUTHORITY_GAP → Authority Readiness Loop
TECHNICAL_UNKNOWN → Researcher / Prototype
RUNTIME_BLOCKER → Brain / environment owner / User
```

这是现有路由的提前应用，不是新增 Gate。

## Worker responsibilities

Worker 必须：

- 遵循当前 `proofloop-worker` Skill 对 `mode: repair` 的操作顺序；本 Contract 只规定
  跨轮 failure_family、历史覆盖、绑定和结果边界，不复制具体执行步骤；
- 以 `failure_family` 和 `historical_coverage` 为完整修复边界，不能只修最新反例；
- 涉及机器数据格式时，成功证明应引用真实生产端产物和有效测试 seam；实现与手写夹具
  共同复制的自设格式不能作为唯一证明；
- 只修改 admitted `execution_scope` 内的 code/test，以及 Runtime `scope` 明确允许的
  当前 Slice Evidence；repair Context 的 `scope.mutable_projection_paths` 为空，不得
  修改 Plan/tasks projection；
- 发现完整修复仍需越界、Authority 不明确或验证不可执行时，立即返回结构化 blocker，
  不做局部绕过；
- 不写 Receipt、Manifest、Context、CV verdict，不提交 Git。

Worker 不负责重新汇总多轮 CV，也不替代 Brain 判断共同问题族和全局 route。

## Brain responsibilities after return

- 重新读取 Git、diff、Evidence、Manifest、Context 和 Runtime facts；
- 不从 Worker narrative 判断完成；只接受当前 v2 Result envelope 的 binding 与持久化事实；
- Repair Result 必须保持 `mode: repair`、省略 `taskId`、携带匹配的 `repairsCvReceiptDigest`
  和闭集 `outcome`。它不进入普通 `stage admit-worker`；由 `stage next` 验证
  envelope/Context/最新 `CV_REPAIR` digest 后推进 `PENDING_RECHECK`；
- `PENDING_RECHECK` 只由 Runtime 产生 `RUN_CV`，随后由 fresh bounded CV Result 经
  `stage admit-cv` 接纳；Worker Result 不宣称 CV PASS、Slice 或 Stage 完成；
- 如果 recheck 再次命中同一问题族，Brain 必须先更新 `prior_repair_miss`，说明上一轮
  修复方向遗漏了什么，再在 Runtime 允许的下一轮边界内决定继续或走既有 route；不得只追加最新反例后机械重派 Worker；
- 真正独立的新 finding 按既有 route 处理；不得绕过 Runtime 的 `repair_attempt` 上限或
  `UNRESOLVED_CV_FAILURE` 人工介入。

## Allowed repair Result and routes

Repair Result 必须是 `references/worker-template.md` 定义的 v2 Worker Result envelope：

```yaml
schemaVersion: 2
stageId: <stage-id>
sliceId: <slice-id>
taskId: <omitted>
mode: repair
outcome: completed | blocked | needs-decision | failed
repairsCvReceiptDigest: <sha256>
```

`outcome` 只使用当前 Worker 的闭集值；对 `mode: repair` 而言，任何值都不
转换为 `TASK_COMPLETE` 或 CV verdict。有效 envelope 由 `stage next` 按当前
Context、tuple 和 `repairsCvReceiptDigest` 校验后推进 `PENDING_RECHECK`；普通
`stage admit-worker` 必须拒绝 repair envelope。

若当前事实不能继续 bounded repair，另行返回既有 route envelope（不是向 Worker
Result 添加未知字段）：

```yaml
route_code: IMPLEMENTATION_DEFECT | PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER
subtype: <specific-subtype>
reason: <required for BLOCKED>
invalidation_scope: []
resume_target:
  owner: Brain | proofloop-execute | proofloop-plan | User
  phase: STAGE_EXECUTION | STAGE_PLANNING | AUTHORITY_READINESS | RECOVERY_OR_EXCEPTION
  stage: <stage-id>
```

## Forbidden

- 不改变 `.opencode/agents/brain.md` 中的固定 route；
- 不为多轮修复创建新的 Runtime action、Receipt、Context schema、状态或 Gate；
- 不把本 Contract 用于首次正常 repair；
- 不用未 admission 的 CV 结果或 progress 快照替代 repair history；
- Brain 不实现或修复生产代码，Worker 不承担跨轮收敛归纳；
- 不因修复轮数自动升级或自动放宽权限。
