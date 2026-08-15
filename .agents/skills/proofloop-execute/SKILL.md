---
name: proofloop-execute
description: STAGE_EXECUTION 阶段技能：ProofLoop 的执行指导：以 Runtime Primary Next Action 驱动 Worker、CV、Committer、Gate 与 Stage Review 的可恢复 Stage Delivery Loop。
---

# proofloop-execute

## Phase ownership

- 阶段：STAGE_EXECUTION（Brain + `proofloop-execute` + Runtime）
- 进入条件：admitted Manifest、有效 Evidence paths、Runtime 入口 Gate 通过
- 完成信号：所有 Slice 集成且持久化 Stage Gate PASS，随后 Stage Review（`brain/stage-review.md`）
- 交接：Stage Review ACCEPTED 后进入 Stage Close（Committer）；阶段切换由 Runtime admission 与 Stage Review 驱动
- 回退：Stage Review REPAIR 或 Gate FAIL 时，Brain 按 Runtime 指引回到本技能派发 repair；计划变更则回到 `proofloop-plan`

本技能是 Brain 的 Stage Delivery 指导。Runtime 是唯一状态
权威；本技能不替代任何 Agent 的语义判断。

## 职责

Brain 负责：

- Stage 入口条件和全局路由；
- 加载本技能和对应 role template；
- 直接调度 Worker、Code Verifier、Committer、Stage Reviewer；
- 将结构化 Agent 返回交给 Runtime admission；
- CV repair 派发纪律：修复阶段的所有 repair 一律以 `mode: repair` 派发
  （Worker repair 行为见 references/worker-template.md）；
- Stage Close、`progress.md` 和下一个 Stage 的重新选择。

Runtime 负责：

- reconcile、状态派生和唯一 `Primary Next Action`；
- Context Projection、digest 校验和失效；
- Worker/CV/Commit/Integration/Gate/Review admission；
- Receipt 写入和完成判断。

Worker、CV、Committer 和 Stage Reviewer 负责各自的角色工作。它们不能
通过叙事替代 Runtime 状态迁移或 Receipt。

## 入口门禁

执行前必须确认：

- Stage Plan admission Receipt 存在且绑定当前 Manifest digest；
- Manifest schema/version 是当前 vNext 版本；
- Manifest 声明每个 Slice 的 Evidence path；
- Plan、Manifest、Proof Index、Context 和 snapshot digest 可验证；
- 当前 `DISPATCH_WORKER` Task 的 immutable execution scope 可追溯到 Plan/Manifest，且
  Context 同时包含非空 code/test scope、Evidence path 和 forbidden scope；
- Context 必须以 admitted `Manifest.plan.ref` 的 root-bound 值提供
  `plan_projection_path`，并声明对应 mutable projection path（字段约束见
  references/worker-template.md）；
- 当前 Stage 没有未解决的 error-level Finding；
- Git trust root、Stage branch 和当前 snapshot 可确认。

仅有 Validator PASS 与 fresh SPV `PLAN_READY` 不足以执行。没有 Stage Plan
admission 时，返回 `RUNTIME_BLOCKER` 或 `EVIDENCE_GAP`，不得派发 Worker。

## 计划到执行边界

执行入口统一遵循以下顺序，不得把 SPV/admission 放在脏树或最终制品提交
之前；candidate 到 admission 的收尾由 proofloop-plan 执行，本技能通过入口门禁验证
其结果。worktree clean 指除 Git 默认 ignore 的 `.proofloop` Runtime artifacts 外
保持干净：

```text
candidate Plan + candidate input + Evidence skeleton 完成
  → stable Git boundary（canonical root，worktree clean）
  → Runtime 编译 / 校验
  → fresh SPV（snapshot_digest = 当前 Git HEAD）
  → Stage Plan admission（再次强制 clean + HEAD binding）
  → proofloop_stage(next) / Context
  → Worker
  → Worker Result admission
  → Runtime 持久化状态：next Task 或 RUN_CV
  → CV Result admission
  → Slice Commit → Integration → Stage Gate → Stage Review
```

`progress.md`、根 progress 快照、checkbox projection 和 Agent 叙事只能帮助恢复上下文，
不能授权或补全上述任一边界。SPV_PASS 后，若 Plan、Authority、Manifest binding 和
snapshot 未变化，`next/context` 继续使用既有 admission，不自动触发第二次 SPV；真实
HEAD/snapshot、Plan 或 Authority 变化必须 fail closed，并重新执行 fresh SPV。

`implement-task` 的 Context scope 不能默认退化为 Evidence-only path。若 Plan、Manifest
或 Context 缺少非空 code/test scope，Runtime 必须在 `DISPATCH_WORKER` 前返回 bounded
`VALIDATE`/`PLAN_GAP`；Brain 不得通过补写 packet 或扩大 Worker 权限绕过。

`plan_projection_path` 是 `Manifest.plan.ref` 的 root-bound 路径，不是新的 Plan
authority，也不把完整 `tasks.md` 正文注入 Context。`allowed_code_scope` 只能由
admitted `execution_scope.code_paths` 和 `test_paths` 组成；不得把 Plan projection 或
Evidence path 当作生产代码权限。`scope.mutable_projection_paths` 只表示允许进行
checkbox/Worker Status projection 的路径（packet 字段约束见 worker-template.md）。

Planning clean boundary 与 execution dirty boundary 必须明确分开：Stage Plan admission
前的 Plan/Evidence/Authority 相关变更必须让 worktree clean；admission 后，Worker 或 CV
repair 在 admitted execution scope 内产生的 code/test/tasks/Evidence diff 是预期执行状态，
不得再次用 planning clean gate 阻断 `TASK_COMPLETE`、`RUN_CV` 或 bounded repair。Runtime
仍必须逐次验证 changed-file scope、当前 Manifest/Plan/Context/snapshot 和前序 Receipt，
不得把 dirty 解释为新的 Plan/Authority 变化。

## 输入

```yaml
stage_id: <stage-id>
project_root: <canonical-trust-root>
tasks_path: delivery/stages/<stage-id>/tasks.md
manifest_path: .proofloop/manifests/<stage-id>.json
manifest_digest: <sha256>
plan_digest: <sha256>
plan_admission_receipt_ref: <receipt-ref>
current_snapshot_digest: <sha256>
resume_reason: initial | rehydrate | agent_return | repair | recheck
```

Brain 不把完整 `tasks.md`、完整 Authority 或旧 Executor Packet 复制到角色派发。
Runtime 返回的 `context_ref` 是 Agent 的最小上下文入口。

## 可重入控制循环

每一次调用只执行以下一个循环周期，然后返回控制权：

1. 读取 Git、Manifest、Evidence、Receipts、Findings 和 Runtime State；
2. 调用 `proofloop_stage({ operation: "next" })`；
3. 验证返回的 action、owner、digest 和 Context Ref 与持久化事实一致；
4. 执行唯一的 Primary Next Action；完成标准：Agent 返回结构化结果且对应
   Runtime admission 已接受，或返回 bounded blocker；
5. 将 Agent 结构化结果交给对应 Runtime admission；
6. 重新读取持久化事实；
7. 重新计算下一动作，得到唯一的 Primary Next Action。

中断后从持久化事实重新进入这个周期；完成判断只来自持久化事实。

## 动作路由

```text
DISPATCH_WORKER
→ references/worker-template.md

RUN_CV
→ references/code-verifier-template.md

ADMIT_WORKER_RESULT
→ Runtime admission；不由 Worker/Brain 手写 Receipt

ADMIT_CV_RESULT
→ Runtime admission；仅 PASS/REPAIR 可进入 admission

ADMIT_SLICE_COMMIT
→ references/committer-template.md

ADMIT_INTEGRATION
→ Runtime/Git 集成边界

RUN_GATE
→ Runtime 执行 typed RuntimeProof 与 Gate admission

PREPARE/FINALIZE_STAGE_REVIEW
→ Brain 使用 Stage Review 流程调度 fresh Stage Reviewer

VALIDATE
→ Brain 按 Finding 路由，不得绕过阻断状态
```

## Task 与 Slice 循环

Worker 每次只接收一个 Runtime 指定的 Task，并且只接收 admitted Plan 投影的
immutable execution scope（dispatch packet、`mode` 语义和 Worker 角色规则见
`references/worker-template.md`）：

```text
DISPATCH_WORKER
→ RED / minimum implementation / GREEN
→ Task Evidence
→ checkbox projection
→ Worker Result admission
→ Runtime：next Task 或 RUN_CV
```

Evidence path 只允许当前 Slice 的 Manifest-declared Evidence sections；它与
`plan_projection_path` 是两个独立的 mutable artifact boundary。

所有 Task 完成后：

```text
finalize-slice
→ Current Slice Evidence
→ Runtime 派发/允许 fresh vNext CV
```

## CV 循环

CV 不使用 CV Level 或 Proof Profile。

vNext CV 必须有独立的 closed result envelope、Context/Manifest/Plan/snapshot binding 和
独立的 Runtime 消费方；`admit_cv_result` 不得把 v2 `TASK_COMPLETE` 或 CV result 送入
legacy reconcile。Worker Result admission 后，Runtime 必须从持久化事实返回唯一的
`RUN_CV`（或尚未完成当前 Slice 时返回下一个合法 Task），不得只重复
`DISPATCH_WORKER`/`VALIDATE`。

Initial CV 的会话纪律（fresh、先读代码后反驳、反驳固定后才读 Evidence）与 verdict
契约见 `references/code-verifier-template.md`；仅 `PASS`/`REPAIR` 可进入 Runtime
admission（见「动作路由」），其余 verdict 只能进入 Brain 路由。

修复：

- 首次 CV `REPAIR` 使用 `references/worker-template.md` 的正常 `mode: repair`
  上下文；Worker repair 后必须 fresh bounded recheck；
- Goal、Authority refs、Proof Index、Manifest、Plan、Context 或验证边界变化时，必须重新 initial CV；
- Worker repair 后的 fresh CV recheck 再次返回 `REPAIR` 时，进入多轮修复处理。
  Brain 不得继续只把最新反例转发给 Worker；必须先读取当前 Slice 全部已接纳的
  `CV_REPAIR`、相关 Authority refs、当前代码、测试和累计 Git diff，判断跨轮共同根因
  以及上一轮修复方向未能收敛的原因；
- 多轮修复使用 `.agents/contracts/brain/multi-round-repair.md`。常规 Worker template
  不承担多轮历史上下文；
- 多轮修复的收敛分析由 Brain 负责；Worker 仍负责加载 `diagnose`，复现具体故障、
  实现 bounded 修复并验证。Brain 不替代 Worker 修改生产代码；
- “不重复 Worker 的根因诊断”只表示 Brain 不重复具体技术复现和实现工作；不禁止
  Brain 只读核对 Authority、Schema、真实生产端、消费端、测试和 Git diff；
- Brain 必须区分：上一轮遗漏的同一问题族、CV 新发现的独立问题、修复所需路径超出
  admitted execution scope、Plan/Authority 缺口。对同一问题族必须形成一个完整修复方向；
  独立新问题可以单独 bounded repair；scope、Plan 或 Authority 缺口使用现有 route，
  不得继续派发 Worker 或自行扩大权限；
- 不设置固定重试次数，也不增加新的 Runtime Gate。完整修复后再次出现同一问题族时，
  Brain 必须先说明上一轮修复方向遗漏了什么，再决定继续 repair 或使用现有 route；
  不得只追加最新反例后机械重派 Worker。

## 提交、集成与 Gate

`PASS` 后使用 `references/committer-template.md`（提交边界见模板「提交边界」段）：

1. Committer 验证 CV PASS、snapshot 和 changed-file boundary；
2. Committer 提交 Slice 成果：代码、测试、tasks projection、Evidence 和 CV Receipt；
3. Runtime 写入 Slice Commit Receipt；
4. Runtime/Git 执行 no-ff Integration 并写入 Integration Receipt；
5. 所有 Slice 集成后由 Runtime 执行 typed Runtime Proof 与 Stage Gate；
6. Gate Receipt 必须绑定 Manifest、Proof、Authority 和 integrated snapshot digest。

Slice Commit、Integration、Gate 与 Stage Review 必须使用 vNext-aware consumer；每一步都
必须验证前序 Receipt digest、Manifest/Plan digest、适用 snapshot 与 Git changed-file
boundary。Legacy reader 不能把 vNext Receipt 当作普通事实读取。

Brain 不直接 `git commit`。

## 阶段评审与关闭

Gate PASS 持久化后：

1. Brain 派发 fresh、goal-first Stage Reviewer；
2. Reviewer 只返回 `ACCEPTED`、`REJECTED` 或 `BLOCKED`；
3. Runtime/Plugin admission 写 Stage Review Receipt；
4. ACCEPTED 才能进入 Stage Close；
5. Brain 更新 `progress.md`，记录 Stage 划分摘要、完成引用、剩余 AWI、阻塞和恢复方向；
6. Committer 提交 Stage Close boundary；
7. Brain 重新读取 Git/Receipt/Manifest，再选择下一个 Stage。

`progress.md` 是快照，不是 Stage 权威。根目录 `progress.md` 内的插件实施
章节与「pluginv2 流程优化」章节不得混写。

## 恢复与会话转接

- Worker 的 session 继续/恢复条件和 `recover-task` 规则见
  `references/worker-template.md` 的「恢复」段；
- CV initial/recheck 默认 fresh；纯 runtime interruption 且输入完全不变时才允许安全继续；
- Committer 的继续条件见 `references/committer-template.md` 的「恢复」段；
- 任何 Plan、Authority、Context、Manifest、snapshot 或 scope 变化都触发重新判断；
- SPV 复用与 fresh 条件见「计划到执行边界」段。

## 停止与路由

```text
IMPLEMENTATION_DEFECT → Worker repair / proofloop-execute
PLAN_GAP → proofloop-plan
EVIDENCE_GAP → Runtime verification / proofloop-execute
AUTHORITY_GAP → Authority Readiness Loop
TECHNICAL_UNKNOWN → Researcher / Prototype
RUNTIME_BLOCKER → Brain / environment owner / User
USER_DECISION_REQUIRED → User
```

所有路由必须保留 `route_code`、`subtype`、`reason`、
`invalidation_scope` 和 `resume_target`；不得将阻塞结果改写为 PASS、完成或
Stage Review ACCEPTED。

## 禁止事项

- Runtime command 只由 Runtime/Context 返回，不解析完整 Markdown 推断；
- Receipt、Manifest、Runtime State 和 Gate verdict 一律由 Runtime admission 写入；
- 只使用本技能 `references/` 下的 active dispatch template，不把旧 Executor
  Contract 当作 active template；
- 不恢复、重建或重新引用已清理的 legacy 路径（旧 Planner/Executor、旧 Contract、`.agents/runtime`；legacy Manifest/Receipt/Stage 路径仅保留显式 fail-closed 边界）；
- 不在当前 Stage A 启动 S04 Pilot 或任何正式 Stage。
