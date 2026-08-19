# PRD Context

## 1. Current one-sentence understanding

ProofLoop v2 先提供一套不依赖 OpenCode、Pi、Claude Code 等特定 harness 工具 API 的
通用 CLI，让不同 harness 的 Agent 直接调用同一组命令完成机械流程；不同 harness 只需
调整 Agent 定义，不需重写工具。

**2026-08-15 增补**：在通用 CLI 之上，把执行证明的绑定单位从"整个 Stage 计划"整改为
"每个 Slice 自己的契约"（分层绑定），使一个 Slice 的计划调整不再连锁作废其他已完成
Slice 的证明；本整改只改变证明模型，执行仍串行，不引入并行执行。

## 2. Confirmed

- CLI 是 ProofLoop v2 的通用机械执行表面，不依赖任何特定 harness 的 tool registration、
  hook 或 SDK。
- OpenCode、Pi、Claude Code 等 harness 的 Agent 调用相同 CLI 命令；迁移 harness 时只
  调整 Agent 定义、提示和命令权限，不调整 CLI 工具。
- AI 负责理解用户意图、形成 PRD/Tech Spec、规划、实现、反驳和评审；CLI 不替代这些
  语义判断。
- CLI 根据当前阶段和角色机械解析 Authority、Plan、Manifest、Receipt、Evidence、Git 和
  Context 引用，为不同子代理生成不同的最小输入；不把同一份通用原文包发给所有角色。
- （2026-08-15）PRD 必须同时考虑 `docs/流程执行问题.md` 记录的问题整改（迁移使用中发现），
  不能只覆盖连坐问题本身。
  — source: 用户 2026-08-15 明确（"还要考虑流程执行问题.md 的问题"）。
- （2026-08-15）流程执行问题的纪律类问题（#1/#3/#4/#5/#6/#7/#11/#12）也需要整改，
  整改方式是防复发机制固化（机械 fail-closed / 契约规则 / 检查清单），随本次整改一起实施。
  — source: 用户 2026-08-15 确认（"纪律问题，你认为不需要整改吗" → 需要，防复发机制固化）。
- （2026-08-17）S12 是 legacy 过渡 Stage；S13 是首个真实以
  `candidate-input.json` 的 `binding_mode: "slice-local"` 规划/执行的 Stage。该字段必须经
  active Materializer、Runtime candidate adapter 与 public `plan compile` 完整传播，不能
  通过内部 Compiler fixture 绕过。
  — source: S12-REVIEW-001 用户决策 A；S13 首用前置缺口分析。
- （2026-08-17）Replan 的影响范围分级：如果只影响当前 Task 及其后续 Tasks，之前已完成
  且未受影响的工作成果保留；当前 Task 与受影响的后续 Tasks 重新规划/执行。如果 replan
  影响之前已完成的工作成果，则整个 Slice 进入 replan，Slice 内旧成果不能继续作为当前
  执行授权，需按新的 Slice 边界重新考虑并重做。
  — source: 用户 2026-08-17 对 S13 恢复边界的产品决策。
- （2026-08-17）“之前已完成成果”包括：之前 Task 已由 Runtime 接纳
  `TASK_COMPLETE`，但 Slice 尚未完成 CV/Commit/Integration；只要该 Task 的目标、验收
  含义、证明边界和执行范围未改变，就可在 Task-local replan 中保留。当前正在 replan
  的 Task 不属于可保留范围，必须重新规划/执行。
  — source: 用户 2026-08-17 确认推荐规则。
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
- 整改实施需要新的凭证（Receipt）版本演进策略：新绑定字段必须显式升版本，旧版读取方遇到新版凭证必须报错而不是忽略。
  — reason: 历史教训——v2 凭证曾因判别字段未冻结被旧读取方静默消费（流程执行问题 #1/#4 同类风险）。待架构阶段确认。
- 整改的端到端验收必须包含"被整改 Slice 的证据刷新 → 重新 SPV → 重新受理 → 重跑"路径。
  — reason: 流程执行问题 #10 已实证：replan 后证据绑定失效；仓库已有 refresh-vnext-slice-evidence 工具可复用。待架构阶段确认。
- 流程执行问题.md 中拟纳入 PRD 的改进项（推断，待用户确认）：
  - #2 replan 保留已受理 Slice 的执行投影（或新模式下状态由 Receipt 推导、投影重置不影响当前性）；
  - #8 Evidence 标题规则固化到 Worker 派发模板 + admission 错误信息明确"Task 标题必须唯一"；
  - #10 validate 对"已受理且当前有效"的 Slice 豁免绑定校验（不再 EVIDENCE_BINDING_MISMATCH 连坐）；
  - #13 测试 fixture 自包含 + 测试环境隔离（工程卫生，非产品需求）；
  - 纪律类防复发固化：materialize 禁令/投影恢复规则、digest 逐字段核对检查清单、CV 结果立即受理、
    "问题 → 防复发机制 → 固化位置"对照表（#1/#3/#4/#5/#6/#7/#11/#12）。
  — reason: 已修复只代表那次错误已纠正，防复发机制需逐一核对固化。
- CLI 的不同命令共享同一种结构化成功/失败表达，并保持本地、可恢复和可审计。
  — reason: 现有 FR-003、FR-012、FR-016 已确认这些用户可观察结果。

## 4. Decided During Intake

- 权威文档重写采用**全面修订**：保留已确认语义（通用 CLI、CLI-first、插件退役等），叠加
  "Slice 级证明绑定整改"新需求章节，并清理与当前实际状态不符的过时内容。
  — source: 用户 2026-08-15 确认（方式 A）。
- 本次整改是**全新任务/全新需求**：前序项目（S1-S11、PROJECT_ACCEPTANCE `37a30b69`、插件退役）
  已全部完成并归档，不作为整改的前置或收尾项。
  — source: 用户 2026-08-15 明确（"现在是全新的任务，全新的需求"）；Git/Receipts 核实：S11 STAGE_CLOSE
  `7512ced9`、PROJECT_REVIEW_PASS `37a30b69` 均存在，当前 HEAD `68b3bd2`。
- 本次整改验收标准采用初步实施方案 §7 全部 7 项（Case 1-5 + 回归 + 红线）。
  — source: 用户 2026-08-15 确认。
- （2026-08-17）用户提出 Replan 影响范围必须分级：如果变更仅影响当前 Task，
  则保留此前已完成且未受影响的工作成果，只重新规划当前 Task 及可能受影响的后续
  Task；如果变更影响此前工作成果，则升级为整个 Slice 的 Replan，Slice 内相关工作
  重新考虑/执行。跨 Slice 的影响继续沿用既有依赖闭包规则。
  — source: 用户 2026-08-17 对 S13 recovery 讨论的明确要求；待 PRD Context 确认后进入 PRD。

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

- Replan 分级的技术判定、Receipt 保留方式、Evidence 绑定和 Git/Stage admission 迁移路径
  留待 Architecture/Contract 阶段定义；PRD 只规定用户可观察的保留与重做边界。
- 命令命名、单一可执行文件还是多个内部入口、stdin/file 细节属于后续技术合同，不在 PRD 中决定。
- 凭证（Receipt）版本演进策略、三级指纹的精确投影内容等属于技术设计，留待架构阶段（prd-to-ai-architecture）决定。

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
- **本整改版本（Phase 1）明确不做**（蓝图 Phase 2-5 内容）：并行执行 / worktree 工作区 / Brain 并发改造 / 删除 tasks.md 状态 / 改集成 Git 工作流 / 会话 id 持久化 / 固定 repair 次数 / CV PASS 后自动 rebase。执行保持串行。
- 本整改版本不切换 Worker 提交文件边界行为（tasks.md 相关行为变更留到后续阶段）。

## 8. Acceptance Criteria Draft

**Slice 级证明绑定整改验收（2026-08-15 确认）**：

- Case 1（只改 C）：When 一个 Stage 中 A/B 已集成完成、只修改 Slice C 的计划，A/B 的完成证明保持有效，仅 C 失效重跑。
- Case 2（依赖链）：When A→C→D 依赖链中 A 改变，A/C/D 失效，无关 sibling（B）保持有效。
- Case 3（全局契约）：When Stage 全局契约改变，所有 Slice 证明失效（正确连坐）。
- Case 4（仅运行证明）：When 只改运行证明（实现契约未变），Slice 证明保持有效，仅 Stage 门禁重跑，不重跑 Worker/CV。
- Case 5（权威引用）：When 权威文档某节只有 Slice A 引用，其内容改变时仅 A 失效，不引用它的 B 不变。
- Case 6（回归）：When 使用旧模式（无绑定字段）的 Stage，全程行为与现在完全一致（fail-closed 不变，零破坏）。
- Case 7（红线）：When 实施过程中出现蓝图第 38 节禁止的做法（为并行虚报文件范围 / 每工作区一份凭证 / CV PASS 后自动 rebase / AI 修合并冲突保留旧 PASS / 新增并发分析器 / 新增并行规划 Agent / Worker 继续改共享 tasks.md / 用 progress.md 判断完成 / 保存 session id 用于恢复权威 / 一个 Slice 改变就整个 Stage 重跑），应被拒绝。
- Case 8（Task-local Replan）：When 变更仅影响当前 Task 及其后续 Tasks，之前已由 Runtime 接纳 `TASK_COMPLETE` 且边界未变的 Task 成果保持有效，即使 Slice 尚未完成 CV/Commit/Integration；当前 Task 与受影响的后续 Task 重新规划/执行。
- Case 9（Slice-wide Replan）：When 变更影响之前已完成 Task 的目标、验收含义、证明边界、Task 依赖或执行范围，整个 Slice 的相关成果失效并重新规划/执行；不得静默沿用受影响结果。

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
| 2026-08-15 | 新增整改需求：证明绑定从 Stage 级整改为 Slice 级（分层绑定）；只做 Phase 1，执行保持串行 | 用户（蓝图 + 初步实施方案 + 指示） |
| 2026-08-15 | 权威文档过时，需全面重写/更新以纳入新整改 | 用户 |
| 2026-08-17 | Replan 影响范围分级：Task-local 保留未受影响的此前成果；影响此前成果时升级为 Slice-wide Replan | 用户（S13 recovery 讨论） |
| 2026-08-17 | 明确之前 Task 的已接纳 TASK_COMPLETE 可在边界未变时保留；当前正在 replan 的 Task 必须重新执行 | 用户 |
