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
- （2026-08-15）整改同时覆盖迁移使用中记录的流程纪律问题；原始问题记录未随本模板发布，当前防复发机制索引见 `tech-spec/process-discipline-matrix.md`。
  不能只覆盖连坐问题本身。
  — source: 用户 2026-08-15 明确要求把流程执行问题纳入整改。
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
- 当前 Runtime 的 `gate-admission.ts`、`run-gate.ts` 和 `proofloop-gate.ts` 只验证 Slice 集成事实（或显式 `git_facts`），不执行 Manifest `runtime_proof`，也不绑定 `runtime_proof_digest`；构建/测试属于 Stage Review。
- 当前 active vNext candidate/materializer 不接受 `runtime_proof` 投影，`plan compile` 不生成该字段；Kernel 仍保留可选 Runtime Proof 类型/兼容校验。S09 executable proof bootstrap 与 S10 Gate proof execution 不是当前已完成能力，仍是 Historical/open 议题。
- S10 的 public CLI/self-host 方向已确认，但完整 Execution→Review、Stage Gate 和 E2E 不能由文档或旧 Receipt 声称完成。
- OpenCode Plugin 已退役；当前由通用 CLI + kernel/runtime 承担机械流程，Agent 直接调用 CLI，不再有 Plugin 后置实现目标。

## 3. Inferred

- （已由当前 PRD/Contract 确认）通用 CLI 继续基于现有 `packages/kernel` 与 `packages/runtime`，不创建另一套流程语义。
  — reason: 现有 PRD 已确认 Kernel/Runtime 是状态机、Receipt 和流程机械语义的权威。
- （已由当前 Contract 确认）整改实施需要新的凭证（Receipt）版本演进策略：新绑定字段必须显式升版本，旧版读取方遇到新版凭证必须报错而不是忽略。
  — reason: 历史教训——v2 凭证曾因判别字段未冻结被旧读取方静默消费（流程执行问题 #1/#4 同类风险）；当前 `tech-spec/contract-state-matrix.md` §8.3 已闭合 schema_version 3、binding 字段与 v2 消费端 fail-closed 规则。
- （已由当前 PRD/Tech Spec 确认）整改的端到端验收必须包含“被整改 Slice 的证据刷新 → 重新 SPV → 重新受理 → 重跑”路径。
  — reason: 流程执行问题 #10 已实证：replan 后证据绑定失效；当前 `PRD.md` FR-020、`tech-spec/task-acceptance-matrix.md` AWI-029 与 Contract §8.8 已闭合该验收链，具体 Runtime 实现仍由 AWI-032..034 完成。
- 历史流程问题输入中已由当前 PRD/Tech Spec 承接的改进项（不把缺失历史文件当事实源）：
  - #2 replan 保留已受理 Slice 的执行投影（或新模式下状态由 Receipt 推导、投影重置不影响 currentness）；
  - #8 Evidence 标题规则固化到 Worker 派发模板 + admission 错误信息明确“Task 标题必须唯一”；
  - #10 validate 对“已受理且当前有效”的 Slice 豁免绑定校验（不再 EVIDENCE_BINDING_MISMATCH 连坐）；
  - #13 测试 fixture 自包含 + 测试环境隔离（工程卫生，非产品需求）；
  - 纪律类防复发固化：materialize 禁令/投影恢复规则、digest 逐字段核对检查清单、CV 结果立即受理、
    “问题 → 防复发机制 → 固化位置”对照表（#1/#3/#4/#5/#6/#7/#11/#12）。
  — reason: 已修复只代表那次错误已纠正，当前机制与落点以 `tech-spec/process-discipline-matrix.md` 为准。
- （已由当前 PRD/Contract 确认）CLI 的不同命令共享同一种结构化成功/失败表达，并保持本地、可恢复和可审计。
  — reason: 现有 FR-003、FR-012、FR-016 已确认这些用户可观察结果。

## 4. Decided During Intake

- 权威文档重写采用**全面修订**：保留已确认语义（通用 CLI、CLI-first、插件退役等），叠加
  "Slice 级证明绑定整改"新需求章节，并清理与当前实际状态不符的过时内容。
  — source: 用户 2026-08-15 确认（方式 A）。
- 本次整改是**全新任务/全新需求**：前序项目（旧 Stage、项目验收、插件退役）已归档，不作为整改的前置或收尾项。
  — source: 用户明确要求；历史 Receipt/commit 记录不在当前模板中作为授权依据。
- 整改验收标准已迁移到当前 `PRD.md` 与 `tech-spec/`；未随模板发布的外部实施方案不作为当前引用。
- （2026-08-17）用户提出 Replan 影响范围必须分级：如果变更仅影响当前 Task，
  则保留此前已完成且未受影响的工作成果，只重新规划当前 Task 及可能受影响的后续
  Task；如果变更影响此前工作成果，则升级为整个 Slice 的 Replan，Slice 内相关工作
  重新考虑/执行。跨 Slice 的影响继续沿用既有依赖闭包规则。
  — source: 用户 2026-08-17 对 S13 recovery 讨论的明确要求；已纳入当前 `PRD.md` FR-016/FR-017/FR-020/FR-021。

- （Historical / open）旧 S08B（现 canonical S10）首次 compile/Validator PASS 后发现 persisted Manifest 的 `runtime_proof` 仍为 `not_applicable`，暴露出 executable proof seam 缺口。2026-08-09 提出的“一次性 S09 bootstrap、S10 真实 Runtime Proof”是历史规划决策，不是当前 admission 或已完成实现；当前 active candidate/compile/Gate 路径保持 facts-only。
- Runtime status 实测只接受 `^S\d+$`；canonical Stage ID 使用 `S09`/`S10` 的规则仍是当前约束。旧 `S08B0`/`S08B` 仅作历史导航。
- “机械传递用户想法”不是由 CLI 解释或总结原文；AI 先把用户决定写入对应 Authority，
  CLI 再按阶段和角色解析、绑定并投影所需 Authority Context。
  — source: 用户要求结合 PRD/Tech Spec 中不同子代理的不同派发内容理解。
- S10 采用 CLI-first，而不是 `proofloop_*` OpenCode tool-first。
  — source: 用户 2026-08-09 明确要求。

## 5. Open

- Replan 的用户可观察边界已由 `PRD.md` 与 `tech-spec/contract-state-matrix.md` 定义；剩余工作是 AWI-032..034 的 Runtime 实现、失败矩阵与重启验证。
- public CLI operation set、Receipt 版本判别和三级指纹投影已由当前 Contract 闭合；开放项仅是 AWI-032..034 的 Runtime 实现、失败矩阵与重启验证，不在 Context 中另建语义。
## 6. Optional / Non-blocking

- npm 发布形式和包名。
- Windows/macOS 完整验证；本阶段继续以 Linux 为验收平台。
- 各 harness 的示例 Agent 定义可在 CLI 完成后分别补充。

## 7. Non-Goals

- 当前不实现 Pi、Claude Code 或 OpenCode 专用工具适配器；通用 CLI 的跨 harness 可调用性属于本版本范围。
- OpenCode Plugin 已退役；不实现其专用 tools/hooks，也不把它作为当前流程入口。
- CLI 不替代 Brain、Planning Skill、Worker、CV 或 Reviewer 的语义判断。
- CLI 不从任意 Markdown 猜测命令、验收或状态，不允许直接绕过 Runtime 写受保护制品。
- S10 不自动迁移旧 Manifest、Receipt 或 Stage。
- S08-REVIEW-010 的 Runtime Proof 回填与可执行 proof seam 均为 Historical/open；当前 Gate 不执行 Manifest `runtime_proof`，也不绑定 `runtime_proof_digest`。
- **本整改版本（Phase 1）明确不做**：并行执行 / worktree 工作区 / Brain 并发改造 / 删除 tasks.md 状态 / 改集成 Git 工作流 / 会话 id 持久化 / 固定 repair 次数 / CV PASS 后自动 rebase。执行保持串行；Future 范围由当前 Tech Spec 定义。
- 本整改版本不切换 Worker 提交文件边界行为（tasks.md 相关行为变更留到后续阶段）。

## 8. Acceptance Criteria Draft

**Slice 级证明绑定整改验收（2026-08-15 确认）**：

- Case 1（只改 C）：When 一个 Stage 中 A/B 已集成完成、只修改 Slice C 的计划，A/B 的完成证明保持有效，仅 C 失效重跑。
- Case 2（依赖链）：When A→C→D 依赖链中 A 改变，A/C/D 失效，无关 sibling（B）保持有效。
- Case 3（全局契约）：When Stage 全局契约改变，所有 Slice 证明失效（正确连坐）。
- Case 4（Historical/open）：若未来重新引入独立运行证明且实现契约未变，目标是 Slice 证明保持有效、仅 Stage 门禁重跑；当前 vNext 不接受/生成 `runtime_proof`，Gate 不执行该字段，因此不作为当前行为或完成证据。
- Case 5（权威引用）：When 权威文档某节只有 Slice A 引用，其内容改变时仅 A 失效，不引用它的 B 不变。
- Case 6（回归）：When 使用旧模式（无绑定字段）的 Stage，全程行为与现在完全一致（fail-closed 不变，零破坏）。
- Case 7（红线）：When 实施过程中触犯当前 `AGENTS.md`、适用 Contract 或 `tech-spec/process-discipline-matrix.md` 的安全/边界规则（例如虚报文件范围、共享 tasks.md 越权、用 progress 判断完成、保存 session id 作为恢复权威、无关 Slice 连坐），应被拒绝。
- Case 8（Task-local Replan）：When 变更仅影响当前 Task 及其后续 Tasks，之前已由 Runtime 接纳 `TASK_COMPLETE` 且边界未变的 Task 成果保持有效，即使 Slice 尚未完成 CV/Commit/Integration；当前 Task 与受影响的后续 Task 重新规划/执行。
- Case 9（Slice-wide Replan）：When 变更影响之前已完成 Task 的目标、验收含义、证明边界、Task 依赖或执行范围，整个 Slice 的相关成果失效并重新规划/执行；不得静默沿用受影响结果。

## 9. Glossary

| Term | Simple explanation | Status |
|---|---|---|
| Harness | 承载 Agent 的宿主，例如 OpenCode、Pi 或 Claude Code | confirmed |
| 通用 CLI | 不依赖任何 harness 工具 API、由 Agent 直接调用的 ProofLoop 命令表面 | confirmed |
| 机械执行 | 状态派生、引用解析、制品校验、Context 投影、结果受理和本地持久化；不包含语义判断 | confirmed |
| Authority Context | CLI 根据 PRD/Tech Spec 等稳定引用为当前角色解析出的最小权威内容 | confirmed |
| 自举 | S10 以 public CLI 推进自身流程的方向已确认；完整 self-host/Gate/E2E 仍为 open，不以历史 Receipt 声称完成 | confirmed（方向）/ open（验收） |
| Bootstrap Stage | S09 及其 executable Runtime Proof 方案仅为 Historical/open 规划；当前 active candidate/compile/Gate 不提供该执行路径 | open |
| Canonical Stage ID | Runtime 接受 `S` 加数字编号；`S09`/`S10` 仅作历史 bootstrap/CLI 命名导航，不能据此推断 bootstrap 或 self-host 已完成 | confirmed（ID 规则）/ historical-open（bootstrap） |

## 10. Change Log

| Turn / Date | Change | Source |
|---|---|---|
| 2026-08-09 | 明确旧 S08B/现 S10 为 harness-neutral 通用 CLI，而非仅 vNext Stage CLI | 用户 |
| 2026-08-09 | 明确不同 harness 只调整 Agent，不调整工具 | 用户 |
| 2026-08-09 / 2026-08-14 | CLI-first 自举；OpenCode Plugin 随后退役，当前由 CLI + Agent 配置承载 | 用户 |
| 2026-08-09 | Historical 决策：曾批准一次性 S09 bootstrap 和 S10 真实 Runtime Proof；当前未形成 executable proof admission/Gate 执行路径 | 用户/当前代码复核 |
| 2026-08-09 | 批准 canonical Stage ID：S09/S10；旧 S08B0/S08B 仅作历史导航 | 用户 |
| 2026-08-15 | 新增整改需求：证明绑定从 Stage 级整改为 Slice 级（分层绑定）；只做 Phase 1，执行保持串行 | 用户（PRD/Tech Spec 更新指示） |
| 2026-08-15 | 权威文档过时，需全面重写/更新以纳入新整改 | 用户 |
| 2026-08-17 | Replan 影响范围分级：Task-local 保留未受影响的此前成果；影响此前成果时升级为 Slice-wide Replan | 用户（S13 recovery 讨论） |
| 2026-08-17 | 明确之前 Task 的已接纳 TASK_COMPLETE 可在边界未变时保留；当前正在 replan 的 Task 必须重新执行 | 用户 |
