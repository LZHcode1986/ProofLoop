# Changelog

ProofLoop 更新记录。其他项目可据此判断是否需要同步更新。

## v3.3

### Breaking Changes

- `spec-verifier` 和 `reality-verifier` 已废弃，替换为 `planning-contract-verifier` + CodeGraph Tool Proof
- P0/P1/P2 路由级别不再使用，改为 `direct-task` / `openspec-change` 路由
- 废弃别名仅通过 `-InstallDeprecatedAliases` 安装

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
