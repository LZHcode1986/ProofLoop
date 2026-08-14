# PRD Context

## 1. Current one-sentence understanding

ProofLoop v2 先提供一套不依赖 OpenCode、Pi、Claude Code 等特定 harness 工具 API 的
通用 CLI，让不同 harness 的 Agent 直接调用同一组命令完成机械流程；不同 harness 只需
调整 Agent 定义，不需重写工具。

## 2. Confirmed

- CLI 是 ProofLoop v2 的通用机械执行表面，不依赖任何特定 harness 的 tool registration、
  hook 或 SDK。
- OpenCode、Pi、Claude Code 等 harness 的 Agent 调用相同 CLI 命令；迁移 harness 时只
  调整 Agent 定义、提示和命令权限，不调整 CLI 工具。
- AI 负责理解用户意图、形成 PRD/Tech Spec、规划、实现、反驳和评审；CLI 不替代这些
  语义判断。
- CLI 根据当前阶段和角色机械解析 Authority、Plan、Manifest、Receipt、Evidence、Git 和
  Context 引用，为不同子代理生成不同的最小输入；不把同一份通用原文包发给所有角色。
- CLI 机械保存 AI 的结构化工作结果，验证 scope、引用、digest、snapshot 和前序事实后，
  才写入对应本地制品或 Receipt。
- CLI 在每次阶段转换前机械检查所需制品、依赖、Git 边界和 Receipt chain；缺失或陈旧时
  fail closed，并返回结构化 Finding。
- S10 必须优先使用这套 CLI 自举；在 S10 final Plan boundary 前先完成一次性 S09
  bootstrap，补齐 executable Runtime Proof 和 pristine Evidence refresh。S10-A 最小 CLI
  提交后，后续 Execution→Review 全部走 public CLI，边使用边修复缺口。
- OpenCode Plugin 的工具表面在通用 CLI 成熟后再完善，不是 S10 的执行前提。

## 3. Inferred

- 通用 CLI 继续基于现有 `packages/kernel` 与 `packages/runtime`，不创建另一套流程语义。
  — reason: 现有 PRD 已确认 Kernel/Runtime 是状态机、Receipt 和流程机械语义的权威。
- CLI 的不同命令共享同一种结构化成功/失败表达，并保持本地、可恢复和可审计。
  — reason: 现有 FR-003、FR-012、FR-016 已确认这些用户可观察结果。

## 4. Decided During Intake

- 旧 S08B（现 canonical S10）首次 compile/Validator PASS 后发现 Manifest Runtime Proof 仍为
  `not_applicable`，不能证明通用 CLI；用户同意先建立一次性 S09 bootstrap，禁止沿用无真实
  验证的旧 S08B Plan。
  — source: 用户 2026-08-09 bootstrap 决策与 persisted Manifest 复核。
- Runtime status 实测只接受 `^S\d+$`；用户同意 canonical bootstrap Stage 使用 `S09`，后续
  通用 CLI Stage 使用 `S10`。旧 `S08B0`/`S08B` 仅作历史导航。
  — source: 用户 2026-08-09 决策与 Runtime status persisted result。
- “机械传递用户想法”不是由 CLI 解释或总结原文；AI 先把用户决定写入对应 Authority，
  CLI 再按阶段和角色解析、绑定并投影所需 Authority Context。
  — source: 用户要求结合 PRD/Tech Spec 中不同子代理的不同派发内容理解。
- S10 采用 CLI-first，而不是 `proofloop_*` OpenCode tool-first。
  — source: 用户 2026-08-09 明确要求。

## 5. Open

- 无阻断性产品问题。命令命名、单一可执行文件还是多个内部入口、stdin/file 细节属于后续
 技术合同，不在 PRD 中决定。

## 6. Optional / Non-blocking

- npm 发布形式和包名。
- Windows/macOS 完整验证；本阶段继续以 Linux 为验收平台。
- 各 harness 的示例 Agent 定义可在 CLI 完成后分别补充。

## 7. Non-Goals

- S10 不实现 Pi、Claude Code 或 OpenCode 专用工具适配器。
- S10 不完成 OpenCode Plugin 的全部工具和 hooks。
- CLI 不替代 Brain、Planning Skill、Worker、CV 或 Reviewer 的语义判断。
- CLI 不从任意 Markdown 猜测命令、验收或状态，不允许直接绕过 Runtime 写受保护制品。
- S10 不自动迁移旧 Manifest、Receipt 或 Stage。
- S08-REVIEW-010 的旧 S08 Runtime Proof 回填仍单独排期。

## 8. Acceptance Criteria Draft

- When 同一 ProofLoop v2 项目从 OpenCode、Pi 或 Claude Code 的 Agent 发起机械操作，Agent
  调用同一 CLI 命令和输入合同，不需要新增或修改 harness 专用工具代码。
- When Brain/Skill、Worker、CV、Committer、Stage Reviewer 或 Project Reviewer 即将被派发，
  CLI 依据当前持久事实生成该角色所需且不同的最小 Context ref；缺失引用或绑定时阻断。
- When AI 返回结构化结果，CLI 在验证当前 Context、scope、snapshot、前序 Receipt 和
  changed-file boundary 后保存结果；非法结果不产生完成事实。
- When 流程准备从 Authority 进入 Planning、从 Planning 进入 Execution、从 Slice 进入
  Commit/Integration、从 Stage Gate 进入 Review 或从全部 Stage 进入 Project Acceptance，
  CLI 机械检查所需制品并返回唯一下一动作或明确 Finding。
- When 会话或 harness 更换，CLI 只依赖 Git、Authority、Manifest、Receipt、Evidence 和
  Context 等本地持久事实恢复，不依赖原会话或特定 harness 内存。
- When S10 自身完成，S09 已先闭合 executable proof/Evidence refresh，S10 Manifest
  已实际执行至少一个 Runtime Proof step；S10-A 之后的机械流程通过通用 CLI 自举并留下
  可复核记录，不得用 OpenCode `proofloop_*` tools 替代。

## 9. Glossary

| Term | Simple explanation | Status |
|---|---|---|
| Harness | 承载 Agent 的宿主，例如 OpenCode、Pi 或 Claude Code | confirmed |
| 通用 CLI | 不依赖任何 harness 工具 API、由 Agent 直接调用的 ProofLoop 命令表面 | confirmed |
| 机械执行 | 状态派生、引用解析、制品校验、Context 投影、结果受理和本地持久化；不包含语义判断 | confirmed |
| Authority Context | CLI 根据 PRD/Tech Spec 等稳定引用为当前角色解析出的最小权威内容 | confirmed |
| 自举 | S10 用正在建设的 CLI 推进自身流程，并把暴露的问题纳入修复 | confirmed |
| Bootstrap Stage | S09；一次性补齐 executable Runtime Proof 与 pristine Evidence refresh，不代表通用 CLI 已完成 | confirmed |
| Canonical Stage ID | Runtime 接受的 `S` 加数字编号；本轮使用 S09/S10 | confirmed |

## 10. Change Log

| Turn / Date | Change | Source |
|---|---|---|
| 2026-08-09 | 明确旧 S08B/现 S10 为 harness-neutral 通用 CLI，而非仅 vNext Stage CLI | 用户 |
| 2026-08-09 | 明确不同 harness 只调整 Agent，不调整工具 | 用户 |
| 2026-08-09 | 明确 S10 CLI-first 自举，OpenCode Plugin 后置 | 用户 |
| 2026-08-09 | 批准先执行一次性 S09 bootstrap，再以真实 Runtime Proof 启动 S10 | 用户 |
| 2026-08-09 | 批准 canonical Stage ID：S09 bootstrap、S10 通用 CLI | 用户 |
