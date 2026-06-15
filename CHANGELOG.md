# Changelog

ProofLoop 更新记录。其他项目可据此判断是否需要同步更新。

## v1.2.0

### 2026-06-15

- **refactor**: 重构 openspec-apply-change skill 与 Executor 执行状态机，补齐 Proof Profiles 证据反驳闭环，并进行 Executor 瘦身重构
  - `.agents/skills/openspec-apply-change/SKILL.md`: 剥离原生直接实现及与多子代理冲突的行为，改造为纯粹的 OpenSpec apply substrate 接口。
  - `.opencode/agents/executor.md`: 重构为 Dispatch Envelope + Contract Ref 派发逻辑，引入强 Execution State Machine，剥离已手动删除的 `proofloop-skill-usage.md` 依赖；删除臃肿的离散路由规则，整合为精简的 Ownership & Boundaries 章节，彻底降低模型运行干扰。
  - `.opencode/agents/worker.md` & `code-verifier.md` & `committer.md`: 统一接入 Dispatch Envelope + Contract Ref 模型，完全重构允许读取的白名单限制以规避歧义，去除已失效的 `proofloop-skill-usage.md` 引用；允许并规定 Worker 在执行 Reconciliation 任务时可破例写入 Section 4 Execution Summary。
  - `.agents/contracts/executor/worker-implementation.md` & `worker-fix.md` & `code-verification.md` & `git-boundary.md`: 增加 `## Dispatch Envelope Mode` 解析声明；将 `shared-worker-rules.md` 完全内联并物理删除该外部契约文件；在契约中将过时的 `Packet shape` 语义标签规范重命名为 `Resolved Execution Context`，放开 implementation 契约对对账任务 Ledger 段落写入的限制。

## v1.1.2

### 2026-06-15

- **refactor**: 整改 Evidence Ledger 结构与 Worker/Code Verifier 反驳流程
  - `openspec/schemas/proofloop-spec-driven/templates/evidence-ledger.md`: 删除 `Planning Contract Result` Section，重编号 Worker Verification (Section 3) 和 Execution Summary (Section 4)。
  - `openspec/schemas/proofloop-spec-driven/templates/tasks.md`: 为每个 Worker 任务增加 `Evidence Ledger Target` 属性，修改 Verifier gate 审查范围。
  - `.opencode/agents/worker.md`: 增加 `Evidence Ledger responsibility` 章节，定义 Worker 任务完成的准则和写入范围。
  - `.agents/contracts/executor/worker-implementation.md` & `worker-fix.md`: 引入 `Evidence Ledger Target` 必填项，细化更新规则。
  - `.opencode/agents/executor.md`: 强制 Worker 派发必须携带 `Evidence Ledger Target`，重编号 Reconciliation 任务。
  - `.agents/contracts/executor/code-verification.md` & `.opencode/agents/code-verifier.md`: Code Verifier 审查范围扩展至反驳 Worker 证据，增加 contradicted worker evidence 的验证失败卡点。
  - `.opencode/agents/propose.md` & `planning-contract-verifier.md`: 调整 Overlay gates 和 Mechanical Dispatch Readiness 校验以适配新的 Section 4 结构，弱化 CodeGraph 强校验，增加 `Evidence Ledger Target` 卡点。
  - `openspec/schemas/proofloop-spec-driven/schema.yaml`: 更新 `evidence-ledger` 和 `apply` 指令，适配重编号后的 Section 4。
  - `README.md` & `.opencode/agents/implementation-reviewer.md`: 修正所有描述和 Mermaid 流程图中的 Section 5 引用至 Section 4。

## v1.1.1

### 2026-06-14

- **refactor**: ProofLoop 全局与技术规格文档分层瘦身，并细化 Brain 阶段规划与编码纪律
  - `.opencode/agents/brain.md`: 新增 `Stage Planning Discipline` 章节，明确 Brain 将 PRD 分解为阶段（stage）和模块边界的设计准则，强调方案对比并避免浅层包装。
  - `AGENTS.md`: 将 Customization Guide 替换为本项目全局 Agent 行为规范（开发环境模板、编码思考、简单优先、外科手术式修改等），完成文档分层并规范底线规则。
  - `tech-spec.md`: 彻底剥离工作流与 packet 细则，瘦身为精细化项目技术 notes 指南，明确声明技术栈、命令约束及项目约束。

## v1.1

### 2026-06-14

- **refactor**: Simplify Code Verifier flow by removing Evidence Review phase — single verifier gate + recheck continuation after Worker Fix
  - `.opencode/agents/executor.md`: remove Code Verifier Evidence Review dispatch; replace two-phase (Blind Refutation + Evidence Review) with single Code Verification gate; add Worker Fix → same-gate recheck routing; remove Evidence Review Inline Dispatch Rule section; simplify Execution Summary Code Verifier Receipts.
  - `.opencode/agents/code-verifier.md`: add Verification Verdict Rule (passed / failed / blocked semantics) and Recheck Continuation Rule; clean Blind Refutation and Evidence Review references.
  - `.agents/contracts/executor/code-verification.md`: remove Evidence Review semantics; add `Verification Mode: initial | recheck`; add recheck-specific fields; define x.V checkbox ownership; remove Evidence Protocol dependency.
  - `.agents/contracts/executor/shared-code-verification-rules.md`: remove Default review skills; make review skill usage explicit per dispatch packet; recheck defaults to no skill loading.
  - `.opencode/agents/implementation-reviewer.md`: `redo Evidence Review` → `redo Code Verification`.

- **refactor**: Collapse Code Verification contract dependencies and remove unused executor-scoped evidence protocol
  - `.agents/contracts/executor/code-verification.md`: merge shared Code Verification rules directly into the contract; Code Verification now requires only one contract file at dispatch time.
  - `.agents/contracts/executor/shared-code-verification-rules.md`: delete after merging into `code-verification.md`.
  - `.agents/contracts/executor/evidence-protocol.md`: delete unused executor-scoped evidence protocol after Evidence Review removal.
  - `.opencode/agents/executor.md`: reduce Code Verification contract loading to `code-verification.md` only; slim orchestration text to control plane; keep detailed packet rules in contracts.
  - `install/install-proofloop.ps1`, `install/README.md`, `install/manual-install.md`: remove deleted contract files from install lists.

- **refactor**: Move Executor Execution Summary into dedicated contract and tighten review skill ownership
  - `.agents/contracts/executor/execution-summary.md`: add Executor-owned final apply-stage summary contract.
  - `.opencode/agents/executor.md`: replace inline Execution Summary template with contract reference; simplify Parallel Rules and Runtime Blocker Routing.
  - `.opencode/agents/code-verifier.md`: remove skill loading permission (`skill: allow` → `deny`).
  - `.agents/contracts/executor/code-verification.md`: replace `Required Review Skills` with local `Verification Lens`; remove `Review skill usage` section.
  - `.opencode/agents/implementation-reviewer.md`: allow `security-and-hardening` for security-sensitive Stage Review.
  - `openspec/schemas/proofloop-spec-driven/templates/tasks.md`: rename `Required Review Skills` to `Required Stage Review Skills`; change verifier gate to `adversarial verification completed`.
  - `install/*`: add `execution-summary.md` to required contract lists.

- **refactor**: Reuse Evidence Ledger for Execution Summary and remove CodeGraph from workflow gates
  - `.agents/contracts/executor/execution-summary.md`: delete (Execution Summary moves into ledger).
  - `.agents/contracts/codegraph-tool-protocol.md`: delete (CodeGraph becomes optional tool, not required contract).
  - `openspec/schemas/proofloop-spec-driven/templates/evidence-ledger.md`: add `## 5. Execution Summary` section; update Ledger Owners; remove CodeGraph fields.
  - `openspec/schemas/proofloop-spec-driven/schema.yaml`: Execution Summary lives in ledger; apply instruction uses Reconciliation task.
  - `openspec/schemas/proofloop-spec-driven/templates/tasks.md`: Reconciliation changed from Final repo gate to Record Execution Summary; remove Required Stage Review Skills and CodeGraph Anchors; Inspection Scope uses code reality evidence.
  - `.opencode/agents/executor.md`: remove Execution Summary contract loading; Responsibilities dispatch Reconciliation to write ledger; Execution Summary written by Worker task.
  - `.opencode/agents/implementation-reviewer.md`: use evidence-ledger.md as primary stage review index with Section 5.
  - `.opencode/agents/code-verifier.md`: replace `required review skills` with `verification lens`.
  - `AGENTS.md`: add optional CodeGraph usage rule; remove Required Review Skills and CodeGraph from required dispatch contract fields.
  - `README.md`: update mermaid diagram to remove CodeGraph references; update CodeGraph and No P0/P1/P2 sections.
  - `install/*`: remove deleted contract files from install lists.

## v1.0.15

### 2026-06-14

- **fix**: 修复安装脚本缺失 skills 与样例文件不同步问题
  - `openspec/config.yaml.example`: 同步 `openspec/config.yaml` 中的 `rules` 规范定义；重构 `context` 为支持多行占位符（`<project-name>` 等）的结构，明确 ProofLoop 默认规范不可更改的边界，提供清晰的新项目接入模板。
  - `install/install-proofloop.ps1`: 修复安装时遗漏技能的问题，将 `code-review-and-quality`、`diagnose`、`grill-me-prd`、`openspec-explore`、`security-and-hardening`、`workflow-intake` 6 个核心 skill 补充至 `$CanonicalSkills` 列表中。

## v1.0.14

### 2026-06-13

- **refactor**: ProofLoop 契约精确化拆分与重构 — 精准分拆集中式契约、强制 Agent 契约单入单出，杜绝运行时目录索引
  - `.agents/contracts/brain/`: (新增) 新增 `external-research.md` (外部 facts 收集)、`general-edit.md` (非权威文件编辑)、`propose.md` (单阶段 formal planning)、`execute.md` (阶段执行) 以及 `stage-review.md` (阶段与归档就绪评审) 五大专项契约。
  - `.agents/contracts/executor/`: (新增) 新增 `git-boundary.md` (Committer 边界)、`worker-implementation.md` (实现分派)、`worker-fix.md` (修复/诊断分派)、`code-verification.md` (Blind Refutation 与 Evidence Review 阶段验证) 四大交互契约，以及 `shared-worker-rules.md` (Worker 共享规则)、`shared-code-verification-rules.md` (Verifier 共享规则) 与 `evidence-protocol.md` (证据规范)。
  - `.opencode/agents/brain.md`: 移除对已废弃 `dispatch-packets.md` 的引用，新增 `Dispatch Contract Loading` 精确文件载入规则，规定各个分派流程必须精准加载对应的 `brain/*.md` 契约，严禁运行时对契约目录进行索引。
  - `.opencode/agents/executor.md`: 移除对 `executor-dispatch-packets.md` 和 `worker-runtime-contract.md` 的引用，新增 `Dispatch Contract Loading` 章节定义，在各执行子场景（Git Boundary、Worker Implementation、Worker Fix、Code Verification）显式且精准地加载专属的契约文件与共享规则文件。
  - `.opencode/agents/worker.md` & `.opencode/agents/code-verifier.md` & `.opencode/agents/committer.md`: 移除旧的 `worker-runtime-contract.md` 引用，添加并强化安全校验——各子代理严禁在运行时浏览或遍历 `.agents/contracts/` 目录，必须由父代理组装好包后分发接收，缺字段时直接抛出 failure/blocked 退出。
  - `AGENTS.md` & `README.md` & `.agents/contracts/proof-profiles.md` & `.agents/contracts/proofloop-skill-usage.md` & `.agents/skills/README.md`: 替换废弃文件的引用路径为最新的子目录及共享规则位置；在 `AGENTS.md` 中增加 `Dispatch Contract Loading Rule` 全局契约单入单出交互硬规则。
  - `install/install-proofloop.ps1` & `install/README.md` & `install/agent-install-prompt.md` & `install/manual-install.md`: 更新 `$Contracts` 列表与自检的 `$requiredFiles` 列表，升级文档，以适配新的契约文件拆分规范与结构。
  - 删除废弃的集中式契约文件：`dispatch-packets.md`、`executor-dispatch-packets.md`、`worker-runtime-contract.md`。

## v1.0.13

### 2026-06-13

- **fix**: 恢复轻量并行任务语义、删除本地可追溯性路径、收紧 Code Verifier 验证脚本边界
  - `openspec/schemas/proofloop-spec-driven/templates/tasks.md`: 在 Task Order 前恢复 `## Dependencies` 和 `## Parallel Opportunities` 章节，添加带有 `[P]` 并行标记的 Slice 任务示例，在 Readiness Checklist 增加并行配置自检。
  - `openspec/schemas/proofloop-spec-driven/schema.yaml`: 在 `artifacts.tasks.instruction` 任务生成指令中，添加对 dependencies, parallel opportunities 和 `[P]` 标记的规范要求。
  - `openspec/config.yaml`: 在 `rules.tasks` 规则中，补充对任务依赖与并行机制的规范；删除硬编码本地绝对路径的 `traceability` 块，确保环境可移植性并防止敏感信息泄露。
  - `.opencode/agents/propose.md`: 在 `Overlay gates` 流程中新增针对并行章节 `## Dependencies`、`## Parallel Opportunities` 以及 `[P]` 并行标记的自检门槛。
  - `.opencode/agents/planning-contract-verifier.md`: 升级 `Mechanical Dispatch Readiness Check` 与 `Block only when` 校验规则，增加对依赖和并行配置合法性及 Allowed File Scope 的阻断卡点。
  - `.opencode/agents/executor.md`: 引入 `Parallel Rules` 并行调度安全判断规范，规定在无依赖、Allowed File Scope 无交集等场景下方能并发调度，否则降级为串行派发。
  - `.opencode/agents/code-verifier.md`: 收紧 `Code Verifier Runtime Policy`，禁止使用 Write/Edit 写入临时校验脚本（`.py`, `.js`, `.sh` 等）或 scratch 文件，明确 ad-hoc inline 只读标准库指令以及既有测试命令的边界，无法满足时直接返回 `blocked`。
  - `.agents/contracts/executor-dispatch-packets.md`: 在 `Code Verification - Blind Refutation` 和 `Evidence Review` 包的 `Forbidden Actions` 中加入绝对禁止临时校验脚本、Fixture、Scratch 文件写入以及写工具使用的条件，并在 Blind Refutation `Runtime Policy` 中为 ad-hoc 探测和 project behavior verification 分别设立具体的限制规则。

## v1.0.12

### 2026-06-12

- **refactor**: ProofLoop 架构优化与执行链路整改 — grill-me-prd 瘦身、Brain 瘦身为治理控制面并禁用编辑、General 机械执行、Archive Execution 迁移与 Implementation Reviewer 引入阶段级质量透镜
  - `grill-me-prd/SKILL.md`: 瘦身主入口，将核心流程以外 of 规则及长模板抽离至 references 子目录，控制面保持在百行左右，杜绝执行中写入文件。
  - `grill-me-prd/references/`: (新增) 新增 `domain-context-checks.md`（术语校准/交叉验证/场景压测/ADR 候选）、`output-formats.md`（提问及各模式输出格式）和 `examples.md`（提问与决策用例）。
  - `brain.md`: 将 edit 权限收窄为全部禁用 (`edit: "*": deny`)；规定 4 级路由优先级（Continuation -> Specialist -> Committer -> General）；修改归档执行节点为 General，新增澄清持久化 CLARIFY.md 的通用派发规范；大幅精简非核心控制面逻辑与流程，重构为极简治理控制面（正文缩减至约 100 行），定义硬性禁令（Hard prohibitions），删除冗余 of Primary decision、Dispatch rule 及重复 of Direct/OpenSpec 叙述；新增 `Continuation-first routing` 规则，规定在对上一任务做 repair/retry 时必须复用 `task_id` 和 owner。
  - `implementation-reviewer.md`: 移除 `openspec archive` 命令权限及技能挂载权限，删除归档执行模式相关段落，收缩为只读评审与 readiness 推荐；挂载 `code-review-and-quality` 技能，引入为 Stage Review 的跨 slice 阶段级质量审查工具（stage-level quality lens），并明确定义与 Code Verifier 的职责界限（只评不验），在输出模板中加入 Stage Quality Review 结构化技能证据输出区。
  - `proofloop-skill-usage.md`: 同步技能规则，将 `openspec-archive-change` 授权执行者调整为 General，增加 reviewer 纯读与免归档控制约束；新增 `Implementation Reviewer using code-review-and-quality` 节，约束其技能边界，并规范最小证据 (Minimum evidence) 结构。
  - `dispatch-packets.md`: General 不新增专业任务包，仍沿用 `Brain Dispatch: General`，Expected Result 扩充 Task complete / Task blocked / Task failed 完结状态支持；在 `Brain Dispatch: Stage Review` packet 协议中引入 `Required Review Skills: - code-review-and-quality` 字段；在 `Brain Dispatch Contract` 中明确 `Continuation Rule` 复用逻辑；修改 `Archive Commit` 文案以反映 General 执行归档流程。
  - `agent-install-prompt.md` & `README.md`: 同步更新全局角色职责定义，明确 Brain 为治理控制面，Implementation Reviewer 拥有阶段级 code-review-and-quality 质量透镜，禁止任何直接编辑或亲自归档执行行为；重要规则增加 Brain 禁编辑、4级路由原则、General 兜底机械执行等配置提示。
  - `committer.md`: 可选微调，修改 `archive-output` 触发边界场景下的通用文案。

## v1.0.11

### 2026-06-12

- **refactor**: ProofLoop 执行链路整改方案 — 单阶段派发、Fail-Fast 运行时阻塞与内联证据审查
  - `worker-runtime-contract.md`: (新增) 集中定义非交互运行时约束、运行时 Blocker 类型（`runtime-config-blocker` 和 `runtime-dependency-blocker`）及 Blocked Receipt 格式，并扩展至适用于 Worker 与 Code Verifier。
  - `worker.md`: 移除三阶段流程描述，改造为单阶段机械执行 Worker，引入对 `worker-runtime-contract.md` 的运行时与阻碍政策引用，纠正绝对路径为相对路径，删除具体的 Receipt 格式。
  - `executor-dispatch-packets.md`: 在 Worker 和 Code Verifier 各自的 Phase 分发 Packet 模板中细化 `Allowed Actions`、`Forbidden Actions`、`Runtime Policy`、`Expected Result`、`Receipt Format`，合并各自的详细决策树与 Receipt 格式；将 Evidence Review 限制为 `inline content only`。
  - `executor.md`: 引入 `Worker Phase Dispatch Rule` 及 `Worker and Code Verifier Runtime Blocker Routing`，更新 Routing 规则分支以支持 Worker 和 Code Verifier 的运行时 Block 状态及本地补救路由；强制 Evidence Review 以内联内容传输。
  - `code-verifier.md`: 改造为单阶段机械校验 Verifier，引用 `worker-runtime-contract.md` 并在依赖不可用时返回运行时 Blocker，移除详细流程、决策树及 Receipt 格式，交由 Dispatch Packets 权威定义。
  - `proof-profiles.md`: 在 `integration-path` 章节加入对不可用运行时依赖应返回 Blocker 的提示说明。
  - `install/install-proofloop.ps1`: 将新增的 `worker-runtime-contract.md` 和 `proof-profiles.md` 加入安装及自检清单。
  - `install/agent-install-prompt.md`: 新增针对 `worker-runtime-contract.md` 定位的 AI 部署规则。
  - `install/README.md`: 在默认安装清单中同步补充这两个核心合约。
  - `install/manual-install.md`: 在 Required contracts 清单中同步补充。

## v1.0.10

### 2026-06-12

- **refactor**: 优化需求澄清与 PRD 审查工作流 — 将 workflow-intake 与 grill-me-prd 融入 Brain 澄清流程
  - `brain.md`: Primary decision 调整为前置判断 Dispatch Contract 是否可验证，并限制初始 AC 判定范围为非 continuation 请求，强调 continuation 优先；Dispatch rule 补充在产品定义歧义时调用 `workflow-intake`，结构化上下文有漏洞时调用 `grill-me-prd`；OpenSpec Change 限制只在 Dispatch Contract 可验证时才派发 propose。
  - `proofloop-skill-usage.md`: 新增 `Brain using workflow-intake` 和 `Brain using grill-me-prd` 段落，规范了这两个技能的前置调用条件与 Minimum evidence 证据格式。
  - `workflow-intake/SKILL.md`: 将目标及描述变更为聚焦于“结构化 PRD 上下文、决策台账与就绪 AC”，将 ledger 分类中的 `Deferred to grill-me-prd` 替换为 `Optional / Non-blocking follow-up`，在澄清循环中支持遇到多个 open 选项时调用 `grill-me-prd` 找出下一个最高杠杆的问题，并修改就绪状态为 `Ready for Brain Dispatch Contract`。
  - `grill-me-prd/SKILL.md`: 扩展支持对未完稿的“结构化 PRD 上下文（如账本、草稿等）”的审查，统一将源文件的“PRD”指代修改为“structured PRD context”以确保表意一致，新增 `Intake clarification mode` 与 `PRD review mode` 双模式，并在 intake 模式下仅返回单个最高杠杆的问题以加速澄清循环。
  - `agent-install-prompt.md`: 在 ProofLoop overlay 安装清单中补全 `workflow-intake` 和 `grill-me-prd` 技能路径，并在 active workflow 的重要规则中明确说明它们仅作为 pre-dispatch 澄清步骤，不作为路由或门禁。

## v1.0.9

### 2026-06-11

- **feat**: Spec 命名整改 — 4 层防御新增/升级 spec 命名校验，阻止增量违规
  - `openspec/config.yaml`: `specs:` 规则新增 kebab-case 命名规范（禁止数字前缀、版本后缀、fix-/remediation-/visible- 前缀、stage-N- 前缀）
  - `propose.md`: Overlay gates 新增 gate #7 — spec 目录名 kebab-case 校验
  - `planning-contract-verifier.md`: `naming preferences` 免封改为 `minor naming preferences`，新增 Hard gate #7 Spec Naming Compliance
  - `scripts/local-check.sh`: 新增第 5 步 spec 命名检查脚本
  - `install/install-proofloop.ps1`: 新增 `$Scripts` 数组，安装 `scripts/local-check.sh`
  - `install/README.md`: Default installed files 添加 `scripts/local-check.sh`

## v1.0.8

### 2026-06-11

- **chore**: 删除 `openspec/schemas/spec-driven/` — 已被 `proofloop-spec-driven` 替代，清理废弃 schema 目录
  - 删除 `schema.yaml`、`templates/design.md`、`templates/proposal.md`、`templates/spec.md`、`templates/tasks.md`
- **fix**: Propose bash 权限放开 — 从 deny-by-default + 白名单改为 `bash: allow`
  - `propose.md`: 移除 bash 分层配置（`"*": deny` + 具体命令 allow），简化为 `bash: allow`

## v1.0.7

### 2026-06-10

- **fix**: Propose readiness 自证闭环整改 — 禁止 self-certify，强制 post-edit verifier 校验
  - `propose.md`: `Ready判定` 重写为 `Readiness Decision`，强制要求 `planning-contract-verifier` 结果必须产生于最新 artifact 编辑之后，修复后必须重新 dispatch verifer
  - `propose.md`: Responsibilities 第 9 条改为 "after artifact generation and after every Propose artifact repair"
  - `propose.md`: 新增 Spec delta rule — 区分 ADDED / MODIFIED Requirements，分类不清时 blocked

## v1.0.6

### 2026-06-08

- **refactor**: Brain 路由整改 — task_id continuation-first + specialist-owner first + general fallback
  - `brain.md`: 新增 `Continuation-first routing`（有可继续的 `task_id` 必须继续派回原子代理）和 `Specialist-owner routing`（无 continuation 时按 propose/executor/implementation-reviewer/committer/web-scraper 专项 owner 路由）两个路由段
  - `brain.md`: `Direct Task` 从 "small edits/docs/config/script 默认代理" 改为兜底语义，只在无 continuation 且无 specialist owner 时才派 `general`
  - `brain.md`: `OpenSpec Change` 段增加 continuation 优先说明
  - `dispatch-packets.md`: `General` 段增加 fallback 限定（必须确认无 continuation 且无 specialist owner）
  - `dispatch-packets.md`: `Brain Dispatch Contract` 模板新增可选 `Continuation:` 字段（previous task_id / previous owner / continuation reason）
- **fix**: Executor 职责边界修正 — stage review / archive-output 派发回归 Brain
  - `executor.md`: 删除职责 13（派发 Implementation Reviewer stage review）和 14（派发 archive-output commit），改为所有 slice 完成后 return Execution Summary 给 Brain
  - `executor.md`: Git Boundary Policy 移除 `archive -> archive-output commit`
  - `implementation-reviewer.md`: Archive Execution Mode 通知目标从 Executor 改为 Brain
  - `executor-dispatch-packets.md`: Executor Git Boundary 类型列表移除 `stage-output` / `archive-output`
- **fix**: Brain bash 权限收紧 — 从 `bash: allow` 改为 deny-by-default + 语义约束
  - `brain.md`: bash 权限从 `allow` 改为分层配置（只读 git/search/inspection allow，file/git mutation hard-deny，其余 ask）
  - `brain.md`: 新增 `Bash restriction` 段，约束 bash 只能用于 routing / inspection / governance checks

## v1.0.5

### 2026-06-07

- **fix**: Evidence Review dispatch packet checkbox 驱动修复 — 模板默认值 + Rules 内联指令
  - `executor-dispatch-packets.md`: Evidence Review 包 `Checkbox Owner:` 填默认值 `Code Verifier`，Rules 新增内联指令（Final Slice Verdict = pass 后勾选 verifier gate checkbox）

## v1.0.4

### 2026-06-06

- **fix**: Code Verifier 勾选流程补全 — 与 Worker 勾选流程对称
  - `code-verifier.md`: 新增 Checkbox update 段（PASS 勾选 verifier gate checkbox、fail/blocked 不勾选、失败报 PROTOCOL DEFECT），Receipt 新增 `Verifier Gate Checkbox` 字段
  - `executor-dispatch-packets.md`: Blind Refutation / Evidence Review 两个 dispatch packet 新增 `Checkbox Owner` 字段
  - `executor.md`: Responsibilities 统一 checkbox 校验表述，Guardrails 替换为通用 `Task Checkbox Receipt Check`（Worker 勾 task、Verifier 勾 gate、缺失即 PROTOCOL DEFECT）

### 2026-06-05

- **refactor**: 官方 Skill 基底 + ProofLoop Overlay 权威化减法式整改
  - `openspec-propose/SKILL.md`: 回归官方基底，移除 ProofLoop-specific 规则（source decomposition, proofability check, Proof Posture, QUALITY-GATE, batch repair, Stage Acceptance Coverage Map, task metadata standards 等）
  - `openspec-apply-change/SKILL.md`: 回归官方基底，移除 Worker/Code Verifier/Committer orchestration, task-diff-snapshot, slice-output, Hypothesis Verification, Evidence Backfill, Implementation Done Check 等
  - `proofloop-skill-usage.md`: 新增 Canonical Skill Substrate Rule 硬规则，明确 canonical skills 不可修改，ProofLoop 权威在 agents/contracts/schema/config
  - `propose.md`: 新增 Artifact Role Rules（proposal=intent snapshot, specs=behavior contract source of truth, design=technical rationale, tasks=executable projection, evidence-ledger=proof record）和 Ready 判定规则
  - `planning-contract-verifier.md`: 从重型文档审查器减重为 Projection Consistency Checker + Mechanical Dispatch Readiness Checker，移除专项技术检查
  - `executor.md`: 新增 Dispatch Packet Construction Rule，明确不能靠判断调和 artifact 冲突，构造不出完整 dispatch packet 时 blocked
  - `worker.md`: 新增 No Guessing Rule，遇到合同缺失或冲突时 blocked 不猜
  - `code-verifier.md`: 新增 Review Context Rule
  - `config.yaml`: rules 改为通用 source/projection 规则
- **chore**: 移除 `openspec/QUALITY-GATE.md` 及所有引用，QUALITY-GATE 定位为非权威可选清单，已从所有文件中清理
- **fix**: schema/templates 强化 source/projection 关系
  - `templates/design.md`: Binding Decisions 表增加 Type (behavior-binding/implementation-only), Source Spec Requirement, Projects To Tasks/Specs
  - `templates/tasks.md`: Slice Contract 增加 Source Spec Requirements 和 Binding Behavior Summary 必填项，增加 Forbidden File Scope
- **fix**: 补强 Worker No Guessing Rule 和 Code Verifier Review Context Rule 交叉引用
  - `worker.md`: `Stop and return blocked when` 新增两条，直接引用 No Guessing Rule（dispatch packet 冲突 → CONTRACT DEFECT；TDD 任务缺 verification target → untestable task packet）
  - `code-verifier.md`: Phase 1 / Phase 2 Responsibilities 各新增两条，直接引用 Review Context Rule（Slice Contract 不足 → CONTRACT DEFECT；不得从 proposal/design prose 重建 expected behavior）

## v1.0.3

### Breaking Changes

- `spec-verifier` 和 `reality-verifier` 已废弃，替换为 `planning-contract-verifier` + CodeGraph Tool Proof
- P0/P1/P2 路由级别不再使用，改为 `direct-task` / `openspec-change` 路由
- 废弃别名仅通过 `-InstallDeprecatedAliases` 安装

### 2026-06-04

- **fix**: v1 Propose/Planning 阶段综合整改 — schema/template/config overlay 层修复，确保 invalid planning artifacts 在进入 executor 前被挡住
  - `openspec/config.yaml`: 迁移 `classification` / `implementation` unknown artifact rules 到 `proposal` / `tasks`
  - `schema.yaml`: specs instruction 强制 `specs/<capability>/spec.md`，evidence-ledger instruction 改 Worker-owned 模型
  - `templates/proposal.md`: 新增 `## What Changes`（含 In Scope / Out of Scope）
  - `templates/tasks.md`: 新增 `### 2. Blocking`，Reconciliation 加 `bash scripts/local-check.sh`，任务重编号
  - `templates/evidence-ledger.md`: Ledger Owners 改 Worker-owned，移除 Verifier/Reviewer/Archive 结论区，新增 Worker Hypothesis Verification Sections
  - `templates/spec.md`: 补充 delta section 规则说明和 MODIFIED Requirements 示例
  - `planning-contract-verifier.md`: 新增 CLI validate gate、schema/template contract checks、Evidence Ledger 模板禁止项检查（Slice Verification / Code Verifier Result / Stage Review Result / Archive Result / 旧 owner model）、validate 失败不可降级
  - `propose.md`: 新增 Skill Immutability Rule、Overlay gates（6 项硬检查）、Fail-closed rules 扩展 Evidence Ledger 模板冲突条件
- **refactor**: v1 执行流程确定性整改 — Worker/Code Verifier 拆为两阶段，Executor 不再写 Evidence Ledger
  - Worker: Implementation Phase（不读 hypothesis）+ Hypothesis Verification Phase（只写 assigned ledger section）
  - Code Verifier: Blind Slice Refutation（不读 Worker evidence）+ Evidence Review and Task Attribution
  - Executor: 删除 Evidence Ledger 编辑权限，增加 dispatch Worker Hypothesis Verification / Code Verifier Blind Refutation / Evidence Review
  - Implementation Reviewer: Stage Review 输入增加 Executor Summary、Code Verifier Receipts
- **feat**: 新增 `.agents/contracts/proof-profiles.md` — 5 个 verifier 反证模板（api-shape、route-default、ui-cardinality、empty-state、integration-path）
- **chore**: `.gitignore` 添加 `docs/`
- **fix**: dispatch packet 确定性整改 — 补齐 OpenSpec Artifacts 传递、删除 Implementation Reviewer 残留 Ledger 写入字段、删除 Committer ledger 写入例外口子
  - Worker Implementation / Blind Refutation packet 新增 `OpenSpec Artifacts` + `OpenSpec source refs` 显式字段
  - Implementation Reviewer Stage Review Output 删除 `stage review section updated` / `archive section updated`，改为 `worker hypothesis sections checked` + `ledger edited by implementation-reviewer: no`
  - Committer 删除 "unless explicitly dispatched to append boundary receipt" 例外，改为 `Committer never writes Evidence Ledger`
  - Brain Stage Review packet 同步新模型：`Evidence Ledger Path` / `Worker Hypothesis Verification Sections` / `Code Verifier Receipts` / `Committer Receipts`
- **fix**: Code Verifier dispatch packet 行为约束补强 — Blind Refutation per-AC 反例约束、Evidence Review evidence 认识论声明
  - Blind Refutation Rules: 每条 Slice AC 必须尝试反例，否则 verdict 为 inconclusive
  - Evidence Review Rules: Worker evidence is a claim to challenge, not a fact to trust
- **fix**: Worker Evidence Backfill 纳入 Worker 三阶段协议、Worker Fix 补齐 OpenSpec refs、Evidence Review 口径收窄
  - Worker 新增 Phase 3: Evidence Backfill — 不编辑实现、不修失败、只补证据写 assigned Ledger section
  - Worker Evidence Backfill packet 新增 `OpenSpec source refs` / `Slice Contract` / `Hypothesis ID` / `Evidence Ledger` 字段
  - Worker Fix packet 新增 `OpenSpec Artifacts` / `OpenSpec source refs`，规则明确 Verifier Failure 是 defect report 而非 authority
  - Evidence Review 的 `assigned slice sections` 收窄为 `worker task/hypothesis sections for covered tasks`

### 2026-06-03

- **fix**: 清理 `openspec-propose/SKILL.md`、`config.yaml`、`propose-readiness.md`、`reality-readiness.md` 中残留的 `spec-verifier` / `reality-verifier` 引用
- **fix**: Worker 和 Code Verifier 增加 task checkbox 更新流程，Executor 增加 checkbox 验证
- **docs**: workflow-intake 增加 Consequential Clarification Loop，PRD 模板对齐 grill-me-prd
- **docs**: clarify Evidence Ledger materialization path in propose.md

### 2026-06-02

- **docs**: AGENTS.md 增加高层 OpenSpec Change 流程、Executor-owned internals、Evidence Ledger Seed
- **docs**: README 增加 Evidence Ledger 流程概览和 Mermaid 图
- **fix**: installer skills default、Worker/CV/IR output templates、PCV blockers、schema apply.requires、flow drift
- **feat**: Evidence Ledger v1 rectification - contract echo、skill evidence、gate classification、agent boundaries、installer rollback
- **chore**: 完成 v3.3 rectification - 移除废弃 agents、新增 planning-contract-verifier 和 codegraph-tool-protocol
