# Changelog

ProofLoop 更新记录。其他项目可据此判断是否需要同步更新。

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
