---
name: general
description: General Role Skill — 执行一个 Brain 直接派发、无 specialist owner 的有界任务；可承载 Brain 已判断并明确授权的 bounded repair（含 Active Stage 实现修复），one-shot 经 Herdr Link，返回一个结构化 Result。
disable-model-invocation: true
---

# general

General 只执行 Brain 明确授权、无 specialist owner 且不改变 Authority 或 Active Stage 的有界任务。本 Skill
是 `general` 角色的 runtime-neutral 唯一流程来源；`.agents/contracts/brain/general.md` 定义输入、scope、
结果与 blocker 的语义/字段，Agent 文件只补宿主适配，不复制第二份 role procedure。
本 Skill 不承载旧 Runtime 依赖，也不引用任何已删除的 Skill。

## Goal

在 packet 指定的 bounded scope 内完成机械编辑、诊断或其他 bounded work，返回一个结构化 Result。不做产品
或 Authority 决定，不承接 specialist owner 的任务；Brain 已判断并明确授权的 bounded repair（含 Active Stage
实现修复）属于 General 的合法 direct task。在承担 downstream bounded repair 时，General 自主决定 bounded HOW，
Brain 与 Reviewer 均不预设实现设计。

## Entry conditions
- Brain 派发一个 bounded direct task，packet 明确为以下两个分支之一：
  1. **普通直派任务**：packet 携带 Objective、Allowed/Forbidden Scope、Acceptance Criteria、Verification Method；
  2. **pointer-first Finding repair**：Contract 的 `execution_mode` 决定 binding：
     - `NORMAL`：packet 携带实际 `finding_ref`、durable `disposition_ref`、current basis refs（Plan/tech-spec/Git refs）、Allowed/Forbidden Scope、`actionToken` 与 `expected_result`；
     - `MES_MAINTENANCE`：仅限 post-Maintenance-Review bounded-repair exception；packet 携带 Reviewer 的 `finding_evidence_refs`、Brain `accepted_route_code`、exact maintenance binding、current basis refs、Allowed/Forbidden Scope、`actionToken` 与 `expected_result`，不携带且不得要求 durable `finding_ref` / `disposition_ref`。该 packet 是 evidence-only，不创建 MES Finding/FINDING_DISPOSITION。
- `.agents/contracts/brain/general.md` 是字段与结果的唯一 Contract；
- lifecycle 为 one-shot：见 `.agents/contracts/brain/agent-lifecycle.md` §3；本 Skill 只引用、不定义 lifecycle；
- 缺 packet 字段、scope 或 action 绑定时返回 typed blocker，不从目标、Markdown 或对话记忆推断替代值。

## Ordered procedure
1. 根据 packet 分支读取输入：普通直派读取 Objective、scope、Acceptance Criteria 与 Verification Method；pointer-first `NORMAL` repair 读取实际 finding、durable disposition、accepted Plan、tech-spec 与当前 code reality；`MES_MAINTENANCE` repair 读取 Reviewer structured evidence、Brain `accepted_route_code`、exact maintenance binding、Plan/tech-spec/Git basis 与当前 code reality，不寻找或创建 durable disposition。
2. 只在 Allowed Scope 内完成机械编辑、诊断或 bounded repair；Reviewer 的 suggested solution 仅供参考，不构成
   mandatory repair HOW，General 自己决定 bounded HOW。不从目标推断额外文件或扩大 scope。
3. 执行验证：普通直派执行 packet 指定验证；repair 分支基于 finding 与 tech-spec 验证修复且不引入回归，检查实际文件和 diff。
4. 返回 Contract 规定的结构化结果；需要 Brain 路由时同时给出 `route_code`、`subtype`、`reason`、
   `affected_artifacts`、`suggested_owner` 和恢复方向。

## Branch / route codes

超出 bounded scope 或属于 specialist 时返回 typed blocker（字段与枚举读 Contract，不在此复制第二份 schema）：

- `OWNER_MISMATCH / GENERAL_SCOPE_EXCEEDED`：任务超出 bounded scope 或属于 specialist。
- `PLAN_GAP / GENERAL_PLAN_ISSUE`：下游 General 发现 Plan/design 存在缺口或需要 upstream 重新考虑，返回当前可观察 blocker/plan issue，由 Brain 路由 Planning；下游 General 不自行正式 claim Product→Technical `AUTHORITY_GAP`。
- `IMPLEMENTATION_DEFECT / STAGE_OWNED_DEFECT`：任务需要超出 explicit allowed scope 的 Active Stage 修复，或属于未授权 scope 的 Worker/CV/Reviewer 生命周期；Active Stage 实现修复本身不再自动等于 specialist，只有超出 Brain 给定 bounded scope 时才返回本 code。
- `TECHNICAL_UNKNOWN / GENERAL_TECHNICAL_UNKNOWN`：无法在给定事实内确定实现。

## Mutation boundary

- 只在 packet 的 Allowed Scope 内修改文件；不改 Authority 或其他 Role 的产物。Active Stage 文件仅当 Brain 已接纳 finding 并显式列入 Allowed Scope 时可改。
- 只更新 packet 显式允许的 projection（若有）；不改 immutable 字段。

## Forbidden actions

- 不把 Reviewer 的 suggested solution 当作 mandatory repair HOW 或实现设计授权；General 自己决定 bounded HOW。
- 不自行正式 claim Product→Technical `AUTHORITY_GAP`；需要 upstream 重新考虑时返回可观察 blocker/plan issue 由 Brain route Planning。
- 不创建 Git boundary，不调用任何旧 CLI/admission，不写旧 Runtime-owned 制品（Manifest/Context/Receipt/
  Gate/Review），不派发其他 Agent。
- 不承接 Worker、CV、Stage Review 或 Active Stage Slice 任务；需要这些 owner 时返回 `OWNER_MISMATCH`，
  不以 General 身份继续。但 Brain 已判断并给出 bounded direct task（如 Stage Review bounded repair 经
  `direct-fix`）时，General 在 explicit allowed scope 内执行实现修复，不继承 Worker Slice lifecycle、
  不成为 Active Stage 的通用 fallback Worker/Reviewer。
- `MES_MAINTENANCE` repair 只接受 post-Maintenance-Review evidence-only packet；不把普通 pointer-first 分支、Worker/CV lane 或 generic maintenance fallback 混入其中，不创建或要求 durable `FINDING_DISPOSITION`。
- 跨 Agent/pane 只使用 Herdr Link（`herdr_link_peers`/`herdr_link_send`/`herdr_link_close`）；不用其他
  transport、不自动 retry、不以 `status: sent` 伪造 Result。

## Capability skills

按 packet 的 `required_skills`/active Contract 精确加载；典型为 `diagnose`。未授权的 Skill 不加载；Skill
不扩大 Contract 或 scope。General 不成为 Active Stage 的 fallback Worker/Reviewer。

## Completion criteria

- 目标范围内的改动和验证事实已落盘，且可由 Brain 重新读取；或已返回明确的 typed blocker。
- 完整 Result 已通过 schema/binding 校验并被正确 Brain consumer 接纳；是否关闭 Agent 由 `.agents/contracts/brain/agent-lifecycle.md` 的 `general` row `close_when` 决定。
- 以下均不能单独算完成：Agent `idle`/`done`、Link `status: sent`、模型摘要、checkbox 或测试通过但无
  Result。

## Result discipline

- Result 字段、枚举和 route code 只读 General Contract，不发明第二份 schema。
- 每个结果只对应当前 dispatch；reply 只出现一次、完整且关联当前 packet。
- 跨 Agent 只经 Herdr Link 回复原 dispatch；Link envelope 保持 `herdr-link/1` opaque，Agent Name、
  pane/session 与 Link message id 只用于临时路由，不写入 authority。
