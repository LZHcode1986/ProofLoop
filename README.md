# ProofLoop v2 — 流程模板仓库

本仓库是 **ProofLoop v2 新流程模型**（Propose → Planning → Execute → Review →
PROJECT_READY）的干净模板：包含迁移到新项目所需的流程文件、四类 canonical Authority
模板、Role Skill / Contract / Brain host 入口，以及 `packages/runtime/test/` 中的
Runtime 测试与 fixtures；不含任何历史 Stage 数据或机器事实（`.proofloop/`）。

**用途**：把本仓库复制到新项目，按 `MIGRATION.md` 改写需求文档并初始化。

## 主流程

```text
Propose / 规划 (HITL)   → PROPOSE_READY
→ Planning (Automated)  → PLAN_READY
→ Execute (Automated)   → all planned Slices INTEGRATED
→ Review (Automated)    → STAGE_ACCEPTED
→ all Stages accepted   → PROJECT_READY（PM 自行最终验收）
```

- **MES** 是唯一 operational execution state / record / traceability 事实源；
  **status** 是 MES 对 Brain / Agent / PM 的最小默认暴露面（scope / phase /
  required_skill / 非零异常计数）。
- **Brain** 是唯一 cross-phase route / dispatch / recovery owner；Skill 决定方法。
- 当前 public CLI 提供两个机械 Git adapter：`proofloop boundary close` 与 `proofloop integration apply`；
  另提供顶层只读 MES observation entry `proofloop status [--detail]` / `status --json [--detail]`
  （不属于 business-control domain）。

## 结构

| 路径 | 内容 | 迁移方式 |
|---|---|---|
| `packages/kernel` / `packages/runtime` | 校验核心 + public CLI（机械 domain：`boundary close`、`integration apply`；只读 `status` observation entry） | 直接复制 |
| `.agents/skills/` | Pi/AGY 共用的 Role、Capability 和 Phase-Orchestration Skills（`proofloop-plan` / `proofloop-execute` / `stage-reviewer` 等） | 直接复制 |
| `.agents/contracts/` | Brain/Role Contracts（字段、边界和状态语义；含 `brain/mes.md` MES Contract） | 直接复制 |
| `.opencode/agents/brain.md` | OpenCode 唯一 Brain host primary（thin host）；只保留 Brain identity、必要权限与 canonical workflow pointer（`.agents/contracts/brain/workflow.md`） | 按 host 复制并核对 |
| `.pi/extensions/proofloop-mode.ts` | Pi Brain host entry（thin host）；只保留 mode 切换、持久化与同一 canonical workflow pointer（`.agents/contracts/brain/workflow.md`） | 按 host 复制并核对 |
| `CONTEXT.md` / `PRD.md` / `tech-spec/` | 当前执行上下文 + 四类 canonical Authority 示例骨架（`tech-spec/architecture.md` / `contracts.md` / `acceptance.md` / `process-discipline-matrix.md`，仅标题占位，需改写） | 复制后改写 |
| `AGENTS.md` | 项目规则 | 直接复制 |
| `package.json` 等 | 构建配置 | 直接复制 |

## 环境依赖

- **Node.js + npm**：构建并运行 public CLI（见下）。
- **Herdr**（https://herdr.dev/）：Agent runtime，必要环境之一。Brain 经 Herdr Link 启动并调度各 Role Agent
  （`herdr_link_start` / `herdr_link_send` / `herdr_link_close`），Agent 常驻独立 tab / isolated worktree 中运行。
- **Herdr Link** 插件：可替代旧 herdr skill 的跨 Agent dispatch / transport 插件；用户可选 herdr skill 或
  Herdr Link（不做强制要求），**推荐优先使用 Herdr Link**。dispatch 机械细节见
  `.agents/contracts/brain/workflow.md` §5 与 `.agents/contracts/brain/agent-lifecycle.md`。

## 快速开始

```bash
npm install
npm run build
node packages/runtime/dist/cli/proofloop.js boundary close --json    # 机械 Git boundary adapter
node packages/runtime/dist/cli/proofloop.js integration apply --json # 机械 Integration adapter
node packages/runtime/dist/cli/proofloop.js status --json            # 只读 MES observation
```

> Runtime 已交付 root-bound MES snapshot/seed、fact/binding validation、MES operational transaction layer
> （S06-R-A-T01，唯一 normal durable mutator，`packages/runtime/src/mes/transaction.ts`）与只读
> `proofloop status` observation seam；Brain host 接线（经 transaction layer 的 operational write-back）、
> rich aggregation / 完整 cross-runtime E2E 仍为 follow-up。MES/status 语义见 `.agents/contracts/brain/mes.md`。

详细迁移步骤见 **[MIGRATION.md](MIGRATION.md)**。

## Historical / legacy

旧流程控制语义（Admission / Receipt Chain / Manifest credential / Context Gate /
`stage next` / Primary Next Action / Stage Gate / finalize-close / project acceptance /
legacy currentness-recovery）已整体退役。旧 CLI 对应 domain 已从当前 CLI 移除；
上述名称在仓库中仅作为历史说明出现，不作为可执行命令或业务 authority。