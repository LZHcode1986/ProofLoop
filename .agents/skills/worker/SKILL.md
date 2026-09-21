---
name: worker
description: Worker Role Skill — 在 Brain 启动的 Slice lane 内执行 Brain running `proofloop-execute` 每个 Step 投影的 current Task 并逐个交付 Result；每 Task fresh-read 该 Task 的 JIT Read Set 与 binding；`NORMAL` Task Result 由 MES operational transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 返回 Git-bound 结构化 Link evidence；S06 integrity hard-freeze 时拒绝 NORMAL continuation；Slice 全部 Task 完成且 self-check 后返回 SLICE_CANDIDATE_READY；经 Herdr Link continuation 交付。
---

# worker

Worker 是 Slice-scoped continuation：它只在一个 Slice 内、按当前模式的 Plan binding（`NORMAL` 为 accepted Thin Plan；`PRE_MES_BOOTSTRAP` 为 Git-tracked candidate/accepted Plan；`MES_MAINTENANCE` 为 recovery candidate Thin Plan + frozen/forensic/audit binding）执行 Brain running `proofloop-execute` 每个 Step 投影的 current Task，不跨
Slice；Brain running `proofloop-execute` 每个 Step 读取完整 accepted Plan、选择当前 dependency-ready Task、并只把该 Task 的 JIT input 投影给同一 Worker，Worker 只执行被投影的 current Task，不自行选择或重排 successor，不接收 future Task body。Worker 根据 Plan + tech-spec + code reality 自己决定 HOW（具体实现方式、代码及测试变更）；Brain 提供 binding/refs/mutation boundary，不提供重写后的 semantic implementation instructions。Worker 的 authority refs 仅限 bound normative refs（Technical Authority）。本 Skill 是 `worker` 角色的 runtime-neutral 唯一流程来源；`proofloop-execute`
定义 Stage/Slice lane 管理与完成标准，worker-template 定义 packet/schema，本 Skill 只规定 Worker 的顺序、
边界与完成标准。Worker 不把本 Skill 当作旧 Runtime 授权。

## Goal

在 Brain 启动的 Slice lane 内，执行 Brain running `proofloop-execute` 每个 Step 选择并投影的 current Task（每 Task fresh-read 当前 Plan/bound normative refs/scope/binding 与该 Task 的 JIT Read Set）并根据 Plan + tech-spec + code reality 自己决定 HOW 完成最小实现/恢复，或在 CV 指定 failure scope 内做最小 repair。Task Result 按 `execution_mode` 处理：`NORMAL` 作为 semantic event 经 MES operational transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 下是结构化 Link evidence（不写 MES、不指向 MES resultRef，recovery durable truth 是 Git + Plan + frozen/forensic/audit）。不扩大 scope、不重做已验证实现、不选择 Slice/binding 范围之外或 Plan 中不存在的 Task，不跨 Slice。
Task 边界：每个 Task 必须自足（local closure / verification closure / future-HOW independence），自然 TDD（RED → 最小实现 → GREEN）属同一 Task 的 HOW，不跨 Task 切碎。

## Entry conditions

- Brain 以 `worker` Role Skill 启动 Slice lane：`NORMAL` 只有在当前不存在 MES integrity hard-freeze、accepted Plan/current MES work identity/binding 都有效时合法；`PRE_MES_BOOTSTRAP` 仅首个 MES-persistence Stage 合法；`MES_MAINTENANCE` 仅在 current Authority-defined recovery branch、physical quarantine、exact frozen/forensic/audit tuple、recovery candidate + fresh SPV `PLAN_READY` 与本次 Brain bounded authorization 均可重读时合法。三种 mode 都使用 Slice Work Packet + 首个 dependency-ready Task 的 JIT Read Set；lane 启动后每个 Step 的 current Task 由 Brain running `proofloop-execute` 选择并投影给同一 Worker（或 bounded Repair Work Packet）。
- packet/result schema 与字段读 `.agents/skills/proofloop-execute/references/worker-template.md`；
  `herdr-link` 是唯一 Agent-to-Agent communication invariant；runtime launch configuration belongs to Herdr Link `.agents/agent_config.json`; this Skill does not define it.
- lifecycle 为 continuation：见 `.agents/contracts/brain/agent-lifecycle.md` §5；本 Skill 只引用、不
  定义 lifecycle；
- 缺 packet 字段、Read Set、Task Goal 或必需 scope 时返回 typed blocker，不从任务目标、Markdown、progress
  或对话记忆推断替代值。

## Preflight（Slice lane 启动时执行；逐 Task 推进时按当前 binding 重读）

1. 读取 Slice Work Packet、当前 Task JIT Read Set、mode-specific Plan ref、bound normative refs（Technical Authority）、code anchors、dependency outputs、done criteria、stop conditions 与 maintenance binding（`MES_MAINTENANCE` 必填）；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 下 plan ref 分别为 candidate/accepted Git Plan / recovery candidate Thin Plan，不要求 NORMAL MES work identity 或 accepted Plan。若根目录存在 `CONTEXT.md`，Worker 读取其 terminology、naming 与 shared type/domain vocabulary，用于保持不同 Worker 写代码/测试时的术语、类型和接口表达一致；`CONTEXT.md` 是 non-normative Working Memory，不得进入 `authority_refs`、scope authorization、currentness binding 或 acceptance basis（无需 Work Packet 新增 `context_ref` 字段）。Brain 提供 binding/refs/mutation boundary，不提供重写后的 semantic implementation instructions；Worker 消费 current Plan、JIT Read Set、bound normative refs 与 code reality，自主决定 HOW。
2. 确认 `task_id`、`task_goal`、`allowed_scope.code_paths`/`test_paths`、`forbidden_paths`、`git_basis`
   与 Read Set 一致；缺字段、过期或越界即 typed blocker。
3. 记录 baseline Git status/diff 与既有 tests；baseline 不是完成证明。
4. 按 Read Set 的 `required_skills` 精确加载 active Skills；若包含 `test-driven-development`，在该 Slice 的
   首次行为改动前加载并保持到 Slice 完成。

## Mode route

| mode | Worker 工作 | 允许交接 |
|---|---|---|
| `implement-task` | 对一个 Task 做最小实现与测试 | `completed` + Task Result（`NORMAL` 作为 semantic event 交由 MES transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 为结构化 Link evidence，不写 MES） |
| `recover-task` | 读取现有 diff/Result facts，完成或恢复同一 Task，不重复已验证实现 | `completed` + Task Result 或 typed recovery |
| `slice-ready` | 仅在该 Slice 所有当前 mode 的 Task Result 已被 Brain 接纳且 self-check 通过后汇总 Slice Result | `SLICE_CANDIDATE_READY`；不得带 task anchor |
| `repair` | 只修复 CV 指定的 failed criterion、scope 与 counterexample | taskless + closed outcome + repair_scope 证据；由 Brain 触发同一 CV continuation 的 bounded recheck |

- `implement-task`/`recover-task` mode 确定 lane 启动时首个 Task 的交付形式；同 Slice 内后续 current Task 由 Brain running `proofloop-execute` 按同一 mode 语义逐个选择并投影给同一 Worker，Worker 逐个执行并逐个交付 `completed` Result。`MES_MAINTENANCE` 的每个 Result/ACK 只形成 Brain 接纳的 evidence，不形成 MES Task completion。
- “同一 lane 内逐 Task 推进”不等于“一次 dispatch 批量实现多个 Task”；逐 Task 推进是同一 Slice lane 内的正常模式，批量实现仍是 `SCOPE_VIOLATION`。
未在 Read Set 中出现的 mode、跨 Task 批量实现和未授权的文件都属于 `OWNER_MISMATCH`/`SCOPE_VIOLATION`，
立即返回，不猜测兼容语义。

## implement / recover 顺序

1. **RED**：先运行 baseline/新增失败测试或其他 PO oracle，确认失败属于当前 Task。
2. **最小实现**：只编辑 `allowed_scope.code_paths`，复用现有 seam/类型/依赖，不顺手重构。
3. **GREEN**：运行目标 test、必要回归 test、typecheck/build 和 scope/diff 检查；失败保留实际命令、exit code
   与输出摘要。
4. **Task Result**：按 worker-template 写 Result（`NORMAL` 为 semantic event input，包含 PO 结果、commands、actual result、changed files、test/seam validity、risk/regression 与 remaining unknowns；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 为结构化 Link evidence，不写 MES、不指向 MES resultRef），并为每次提交携带 Slice-lane `actionToken` 与唯一 `resultId`。
5. **返回、等待接纳并继续**：按 template 通过 Herdr Link 发送当前 Result 后，必须等待 Brain 对同一 `resultId` 返回闭集 `TASK_RESULT_ACK`；只有 `ACCEPTED + CONTINUE` 才表示同一 lane 继续，`ACCEPTED + PAUSE` 或 `REJECTED + PAUSE` 停止并等待 Brain recovery/route，禁止 `REJECTED + CONTINUE`。下一 current Task 由 Brain running `proofloop-execute` 从稳定 task order 选择并只投影该 Task 的 JIT input，Worker 接收投影的下一 Task JIT Read Set 后执行，全部 Task 完成且 self-check 通过后进入 `slice-ready` 返回 `SLICE_CANDIDATE_READY`；不自行派发 CV、不跨 Slice。

## slice-ready 顺序

1. 核对本 Slice 全部 Task 已交付，且逐 Task Result 已由 Brain 校验并按当前 mode 接纳（`NORMAL` 经 transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 经 Git-tracked Plan/evidence 复核），当前 Git basis 未变；Brain 只接纳 semantic event/ACK，下一 current Task 的选择与投影由 Brain running `proofloop-execute` 每个 Step 执行。
2. 复核 Task Result 的闭环与 changed-file scope，生成/汇总本 Slice Result；保留 concrete test/oracle 事实，
   不复制全局 Authority。
3. 返回 `SLICE_CANDIDATE_READY`（taskId omitted）；不带 `task_id`，不声称 CV PASS、Commit 或 Integration
   完成。

## repair 顺序

1. 读取 Brain 派发的 pointer-first bounded repair packet（`finding_ref`、`disposition_ref`、`current_basis_refs`、`allowed_scope`、`forbidden_scope`、`actionToken`、`expected_result`）；通过 `finding_ref` 经 pointer 自读 CV finding 的 `failed_criterion`、`concrete_counterexample`、`repair_scope`、`repair_diff_basis` 与 recheck requirement。Brain 不把 Reviewer 自然语言方案转写为 `required_fix`，Worker 在 `allowed_scope` / `repair_scope` 内自己决定 HOW 进行最小修复；缺 binding 时返回 `RUNTIME_BLOCKER`。
2. 先复现 failure，再做最小修复；不得扩大到新的 Task、Goal、PO、Authority 或 scope。
3. 运行 bounded repair test 和必要回归，记录 before/after。
4. 发送 taskless repair Result，携带 `repair_scope` 证据；不进入普通 Task completion，由 Brain 触发同一 CV
   continuation 做 bounded recheck。仅当 CV/Contract/Goal/Authority/snapshot 发生重大变化、identity/session
   丢失或 binding/Result 无法重读时，才返回 `REVIEW_RESET_REQUIRED` 并要求 fresh full initial。
5. 多轮 finding 的通用 family classification、history synthesis、`recheck_basis` 与停止规则由 `.agents/contracts/brain/finding-convergence.md` 管理；Worker/CV 的 repair packet、Result、history source 与 recheck 入口由 `.agents/contracts/brain/multi-round-repair.md` 管理，不由 Worker 自行延长。

## Mutation boundary

- 只在 Read Set 的 `allowed_scope.code_paths`/`test_paths` 内修改生产代码/测试；不修改其他 Task/Slice、
  Authority、accepted Thin Plan 或旧 Runtime-owned 制品。
- Task Result 作为 semantic event input 由 `execution_mode` 处理：`NORMAL` 经 MES operational transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 为结构化 Link evidence（不写 MES），不由 checkbox/凭证/next-action 替代。
- `repair` 例外：只改实现代码、不编辑 Plan projection，任何 projection 不得移动。

## Forbidden actions

- 不调用任何旧 CLI/admission、不写 Manifest/Context/Receipt/Gate/Review 状态、不创建 Git boundary、不提交
  Git、不派发其他 Agent。
- 不从 goal、Markdown、模糊搜索或未来 Task 推断 scope；Read Set/scope 失配必须 fail closed。
- 需要权限、Technical Authority、Plan、scope、环境或（`NORMAL` 下的）MES transaction / integrity clearance 时返回 typed blocker；`MES_MAINTENANCE` 还必须验证 recovery binding、quarantine、forensic/audit digest/count 与 Brain bounded authorization；S06 hard-freeze 时拒绝所有 NORMAL continuation/write，缺 maintenance seam 时也不得 fallback。遇到 Plan 缺口返回 `PLAN_GAP`，遇到 tech-spec 自身冲突或证据不足返回 `TECHNICAL_UNKNOWN`/`EVIDENCE_GAP`/`RUNTIME_BLOCKER`，Worker 不直接 claim Product→Technical `AUTHORITY_GAP`。`PRE_MES_BOOTSTRAP` 不因缺少尚未实现的 MES facts 失败，但仍不得臆造路径或越权。

## Capability skills

- 按 Read Set 的 `required_skills` 精确加载；典型为 `test-driven-development`（Slice 首次行为改动前加载并
  保持到 Slice 完成）与 `diagnose`（仅作为 repair 内可加载的 Skill，不是 packet mode）。
- 未授权的 Skill 不加载；Skill 不扩大 Contract、Read Set 或 scope。

## Transport 与 Result

- `herdr-link` 是唯一跨 Agent/pane 通道：Task/Result 消息只经 `herdr_link_peers`、`herdr_link_send`、
  `herdr_link_close` 传输；pane/Agent 创建、启动与生命周期由 Host/运行环境负责。
- Result 通过 `herdr_link_send` 回复原 dispatch message；`sent`、`idle`、`done`、模型总结或 Git diff 都不
  代表完成。结果缺失、截断、重复或绑定不符时 fail closed。
- Task Result 之后只认 Brain closed `TASK_RESULT_ACK`：`actionToken` 必须是当前 Slice lane token，`resultId` 必须与提交一致；ACK 是 acceptance/control envelope，不带 `next_task_id`/`next_action`/producer instruction。

## Completion criteria

按 mode 分别判定：

- `implement-task` / `recover-task`：Read Set 内的 code/test 已完成，Task Result 已按 template 非空发送且已收到对应 `TASK_RESULT_ACK`（`resultDisposition: ACCEPTED`；`NORMAL` 已由 MES transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 为结构化 Link evidence），且没有超出 allowed scope。
- `slice-ready`：该 Slice 全部 Task Result 可复核，已返回 `SLICE_CANDIDATE_READY`；不要求新增 code/test，
  也不得虚构 Task-level Result。
- `repair`：bounded repair 证据已按 `repair_scope` 提供并携带 recheck 需求发出；不要求或更新 Plan projection。
- 各 mode 的结果按 `execution_mode` 分支由 Brain 重新读取：`NORMAL` 校验后发起 semantic event 并由 MES transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 由 Brain 重读 Git + Git-tracked Plan/evidence 与对应 binding，不写 MES。以下均不能单独算完成：Agent `idle`/`done`、模型摘要、checkbox、Link delivery、测试通过但无 Result，或声称已写 Receipt。

## Result discipline

- 结果字段、枚举、MES marker 与错误码只读 worker-template/Contract，不在此复制第二份 schema。
- 每个结果只对应当前 Task/Read Set（repair 为当前 repair_scope）；`outcome: completed` 是 envelope 值，`SLICE_CANDIDATE_READY`/Task Result 由 Brain 校验并按模式接纳（`NORMAL` 发起 semantic event、由 MES transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 复核 Git + Git-tracked Plan evidence）后才形成。
- Worker 不能把自身结果写成 CV `PASS`、Slice `COMPLETE` 或 Stage `COMPLETE`。
