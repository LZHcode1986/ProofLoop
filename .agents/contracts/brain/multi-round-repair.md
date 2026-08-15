# Brain Multi-Round Repair Dispatch Contract

本 Contract 用于 pluginv2 Stage Delivery 中 Worker repair 后仍未收敛的特殊情况。
它补充多轮修复所需的跨轮上下文，不改变 Agent 固定路由、不创建新的 Runtime
状态或 Gate，也不替代 `proofloop-execute` 的处理规则。

## Use when

仅在以下条件全部满足时使用：

- 当前 route 仍为 `IMPLEMENTATION_DEFECT`；
- 当前 Slice 已有至少一次 Worker repair；
- fresh CV recheck 再次返回 `REPAIR`，且该结果已经 Runtime admission；
- Goal、Authority、Proof Index、Manifest、Plan、Context 和验证边界没有变化到需要
  fresh initial CV。

首次 CV `REPAIR` 继续使用
`.agents/skills/proofloop-execute/references/worker-template.md` 的正常
`mode: repair` 上下文。未 admission 的 CV 叙事、`progress.md` 或 checkbox 不能触发
本 Contract，也不能补全缺失事实。

## Target

```yaml
target_agent: worker
caller: brain
skill: proofloop-execute
contract_mode: multi-round-repair
mode: repair
expected_result: READY_FOR_CV | BLOCKED
```

## Required execution binding

Brain 必须从当前持久化事实提供并重新核对：

```yaml
stage_id: <stage-id>
slice_id: <slice-id>
task_id: <current-task-id | null for slice repair>
project_root: <canonical-trust-root>
manifest_path: .proofloop/manifests/<stage-id>.json
manifest_digest: <sha256>
plan_digest: <sha256>
context_ref: .proofloop/context/<context-digest>.json
context_digest: <sha256>
snapshot_digest: <sha256>
evidence_path: delivery/stages/<stage-id>/evidence/<slice-id>.md
plan_projection_path: delivery/stages/<stage-id>/tasks.md
execution_scope:
  kind: implementation | evidence-only
  code_paths: []
  test_paths: []
  forbidden_paths: []
scope:
  allowed_paths: []
  mutable_projection_paths: []
  forbidden_paths: []
changed_files: []
required_skills:
  - diagnose
```

这些绑定继续以 admitted Manifest、Plan、Context 和 Runtime Receipt 为权威；本
Contract 不扩大 `execution_scope`，也不授权修改其他 Slice、Authority、Manifest、
Receipt、Context 或 Git 状态。

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
    required_recheck_scope: []
    repair_diff_digest: <sha256 | null>
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

只有 `scope_decision: IN_SCOPE` 时，Brain 才能派发 Worker。

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

- 加载 `diagnose`，复现具体故障、隔离技术根因、实施 bounded 修复并验证；
- 以 `failure_family` 和 `historical_coverage` 为完整修复边界，不能只修最新反例；
- 涉及机器数据格式时，优先使用真实生产端生成成功测试数据；失败测试应在真实产物
  上进行 bounded 变异。实现与手写夹具共同复制的自设格式不能作为唯一成功证明；
- 只修改 admitted execution scope、当前 Slice Evidence 的允许 section 和当前 Plan
  mutable projection；
- 发现完整修复仍需越界、Authority 不明确或验证不可执行时，立即返回结构化 blocker，
  不做局部绕过；
- 不写 Receipt、Manifest、Context、CV verdict，不提交 Git。

Worker 不负责重新汇总多轮 CV，也不替代 Brain 判断共同问题族和全局 route。

## Brain responsibilities after return

- 重新读取 Git、diff、Evidence、Manifest、Context 和 Runtime facts；
- 不从 Worker narrative 判断完成；
- Worker 返回 `READY_FOR_CV` 后派发 fresh bounded CV recheck；
- 如果 recheck 再次命中同一问题族，Brain 必须先更新 `prior_repair_miss`，说明上一轮
  修复方向遗漏了什么，再决定继续本 Contract 或使用现有 route；不得只追加最新反例
  后机械重派 Worker；
- 真正独立的新 finding 可以作为新的 bounded repair 处理；不设置固定重试次数。

## Allowed results

```yaml
result: READY_FOR_CV | BLOCKED
route_code: IMPLEMENTATION_DEFECT | PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER
subtype: <specific-subtype>
reason: <required for BLOCKED>
invalidation_scope: []
resume_target:
  owner: Brain | proofloop-execute | proofloop-plan | User
  phase: STAGE_EXECUTION | STAGE_PLANNING | AUTHORITY_READINESS | RECOVERY_OR_EXCEPTION
  stage: <stage-id>
```

`READY_FOR_CV` 只表示可以进行 fresh CV recheck，不表示 CV PASS、Slice COMPLETE、
Stage Gate PASS 或 Stage 完成。

## Forbidden

- 不改变 `.opencode/agents/brain.md` 中的固定 route；
- 不为多轮修复创建新的 Runtime action、Receipt、Context schema、状态或 Gate；
- 不把本 Contract 用于首次正常 repair；
- 不用未 admission 的 CV 结果或 progress 快照替代 repair history；
- Brain 不实现或修复生产代码，Worker 不承担跨轮收敛归纳；
- 不因修复轮数自动升级或自动放宽权限。
