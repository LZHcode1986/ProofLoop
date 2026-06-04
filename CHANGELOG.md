# Changelog

ProofLoop 更新记录。其他项目可据此判断是否需要同步更新。

## v3.3

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

### 升级指南

从 v3.2 升级到 v3.3 需要更新以下文件：

```text
AGENTS.md
README.md
.opencode/agents/**
.agents/contracts/**
openspec/config.yaml
openspec/gates/**
openspec/schemas/proofloop-spec-driven/**
install/**
```

不需要更新的文件（OpenSpec canonical skills）：

```text
.agents/skills/openspec-propose/SKILL.md
.agents/skills/openspec-apply-change/SKILL.md
.agents/skills/openspec-archive-change/SKILL.md
.agents/skills/test-driven-development/SKILL.md
```
