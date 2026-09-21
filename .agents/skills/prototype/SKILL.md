---
name: prototype
description: Prototype Role Skill — validates one bounded Hard Part question in an isolated worktree; continuation via Herdr Link, returns `TECHNICAL_RESULT_READY` or `RESEARCH_REQUIRED` triggering a one-shot Researcher.
disable-model-invocation: true
---

# prototype

Prototype 只回答 dispatch packet 指定的一个技术可行性问题，并在隔离 worktree 中运行最小实验。本 Skill 是
`prototype` 角色的 runtime-neutral 唯一流程来源；Contract 定义字段/结果，本 Skill 只规定实验顺序、边界与完成
标准。

## Goal

在 packet 指定的 worktree 中用一个最小实验回答一个 bounded Hard Part 可行性问题，返回 `VALIDATED` 或
`ASSUMPTION_REJECTED`；缺少外部事实时返回 `RESEARCH_REQUIRED` 触发 one-shot Researcher，再按原 binding 继续。
实验代码不进入生产分支。

## Entry conditions

- Brain 派发一个 bounded prototype request，packet 携带 Hard Part ID、Prototype ID、Base Ref、Branch Name、
  Worktree Path、Tech Spec Refs、Validation Question、Success/Failure Criteria、Environment、Cleanup Continuation、
  Checkpoint Commit、External Research Status；
- `.agents/contracts/brain/prototype.md` 是字段与结果的唯一 Contract；
  `.agents/contracts/brain/technical-unknown.md` 定义 Brain 的跨阶段路由与结果吸收边界；Prototype 不直接写 Architecture Authority；
- lifecycle 为 continuation：见 `.agents/contracts/brain/agent-lifecycle.md` §5（含 §5.3 研究分支）；本 Skill
  只引用、不定义 lifecycle；
- 缺 binding 字段或 Hard Part question 时返回 typed blocker，不从对话记忆或旧实验推断替代值。

## Ordered procedure

1. 读取 Hard Part question、成功/失败标准、环境约束和 packet 指定的 worktree/branch 绑定。
2. 查阅本地代码、版本和依赖；缺少外部事实时返回 `TECHNICAL_UNKNOWN / RESEARCH_REQUIRED`。
3. 构造最小实验或 fixture，执行实际命令并记录 expected/actual result、约束和 remaining unknowns。
4. 返回 Contract 规定的 `TECHNICAL_RESULT_READY` 结果，或带 `route_code`、`subtype`、`invalidation_scope`、
   `resume_target` 的 typed blocker。

## Mode / branch

字段与枚举读 Contract，不在此复制第二份 schema：

- 正常完成：`TECHNICAL_RESULT_READY`（producer=`Prototype`）+ `status: VALIDATED | ASSUMPTION_REJECTED`；`ASSUMPTION_REJECTED` 是实验结果，Brain 按 `technical-unknown.md` 路由并由当前 owner 吸收。
- `TECHNICAL_UNKNOWN / RESEARCH_REQUIRED`：见下节。
- `TECHNICAL_UNKNOWN / PROTOTYPE_INCONCLUSIVE`、`RUNTIME_BLOCKER`：带 `route_code`/`subtype`/`resume_target` 的
  typed blocker。

## RESEARCH_REQUIRED 与原绑定 continuation

- Prototype 返回 `TECHNICAL_UNKNOWN / RESEARCH_REQUIRED`（携带 `research_question`、`suggested_owner: Researcher`、
  `resume_target.owner: Prototype`）时，Brain 以独立 one-shot lifecycle 调度 `researcher`（见 lifecycle §5.3）。
- Researcher 返回并被验证后，只有 Prototype ID、Hard Part、worktree、Base Ref、Validation Question、
  Context/Plan/snapshot 仍 current 时，原 Prototype 才可 continuation；否则 fresh/recovery。
- Researcher 不变成长驻协作者，也不通过第二通道返回；Prototype 不在等待研究期间自行推进或臆造结论。

## Mutation boundary

- 实验代码只留在 packet 指定的 `prototype/<hard-part-id>` worktree/branch，不进入生产分支；Prototype 不写生产
  代码、Authority 或 Stage，不合并、不派发其他 Agent。
- 不直接写 PRD、Tech Spec 或 Receipt；Brain 按 `technical-unknown.md` 做路由、证据校验和 owner 吸收。
- checkpoint、worktree 和 branch 清理由 Brain 按 Contract 决定，不由 Prototype 自行处理。

## Forbidden actions

- 使用 packet 指定的 worktree/Base Ref/Branch，不自行创建或选择 worktree；不调用 Runtime CLI、不写
  Runtime-owned 制品、不创建 Git boundary。
- 不把 `ASSUMPTION_REJECTED`/`PROTOTYPE_INCONCLUSIVE`/`RESEARCH_REQUIRED`/`RUNTIME_BLOCKER` 直接写成 Authority、Plan 或 MES status；这些结果先回 Brain。
- 跨 Agent/pane 只使用 Herdr Link；不用其他 transport、不自动 retry。

## Capability skills

- Prototype 无 capability skills；按 packet 指定的 Contract 加载入口，使用宿主提供的本地文件/命令工具在 bound
  worktree 内实验。
- 工具能力不扩大 Contract、Context 或 scope；需要外部研究时返回 `RESEARCH_REQUIRED`，不自行查阅外部资料。

## Completion criteria

- 实验与问题一一对应，实际结果可复核，结论明确为 `VALIDATED` 或 `ASSUMPTION_REJECTED`；或已返回明确的 typed
  blocker。
- `INCONCLUSIVE`、需要研究或运行环境失败时不改 Authority，返回对应 typed blocker。
- 完整 Result 已通过 schema/binding 校验并被正确 Runtime/Brain consumer 接纳。以下均不能单独算完成：Agent
  `idle`/`done`、Link `status: sent`、模型摘要或实验命令跑通但无 Result。

## Result discipline

- Result 字段、枚举和 route code 只读 Prototype Contract，不发明第二份 schema。
- `actionToken` 与当前 dispatch 一致；不自行发明、复用旧 token 或用 message id 代替。
- 跨 Agent 只经 Herdr Link 回复原 dispatch；Link envelope 保持 `herdr-link/1` opaque，Agent Name、pane/session
  与 Link message id 只用于临时路由，不写入 Runtime-owned authority。
