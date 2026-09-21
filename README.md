# ProofLoop v2 — 流程模板仓库

本仓库是 **ProofLoop v2 新流程模型**（Propose → Planning → Execute → Review → `PROJECT_READY`）的模板，包含四类 canonical Authority、MES/Runtime、Pi 与 OpenCode 两套独立 Subagent Agent 文档，以及测试 fixtures；不含历史 Stage 机器事实。

## 主流程

```text
Propose / 规划 → PROPOSE_READY
→ Planning → PLAN_READY
→ Execute → all planned Slices INTEGRATED
→ Review → STAGE_ACCEPTED
→ all Stages accepted → PROJECT_READY
```

- **MES** 是 operational execution state / record / traceability 的唯一事实源。
- **Brain** 是 cross-phase route、dispatch、arbitration 和 recovery owner。
- Public CLI 只提供机械 Git adapters：`proofloop boundary close`、`proofloop integration apply`，以及只读 `proofloop status [--detail]` observation。

## 结构

| 路径 | 内容 | 迁移方式 |
|---|---|---|
| `packages/kernel` / `packages/runtime` | 校验核心、MES、Task Result/CV/Finding/Integration 与 public CLI | 直接复制 |
| `.agents/contracts/` | 共享 MES、Result、Finding、生命周期和领域 Contract | 直接复制 |
| `.agents/skills/proofloop-plan/references/` | Planning/SPV packet 与 schema references | 直接复制 |
| `.agents/skills/proofloop-execute/` | Execute lane 与 Work Packet/CV template | 直接复制 |
| `.opencode/agents/*.md` | OpenCode 独立加载的 Brain/Role 工作流程与权限 | 按 OpenCode 配置调整 |
| `.pi/agents/*.md` | Pi 独立加载的 Role 工作流程与 Host 配置 | 按 Pi 配置调整 |
| `.pi/brain-workflow.md` | Pi Brain 独立加载的 Brain 工作流程 | 按 Pi 入口调整 |
| `.pi/extensions/proofloop-mode.ts` | Pi mode/session 宿主入口 | 直接复制后核对 |
| `CONTEXT.md` / `PRD.md` / `tech-spec/` | Working Memory 与四类 canonical Authority | 复制后改写 |
| `AGENTS.md` | 项目规则和执行边界 | 直接复制 |

Pi 与 OpenCode 各自读取对应目录下的 Agent 文档；Role 工作流程不再放在共享目录。共享文件只保留机器字段、MES、Result、packet/template 和跨角色 Contract 语义。

## 快速开始

```bash
npm install
npm run build
node packages/runtime/dist/cli/proofloop.js boundary close --json
node packages/runtime/dist/cli/proofloop.js integration apply --json
node packages/runtime/dist/cli/proofloop.js status --json
```

详细迁移步骤见 **[MIGRATION.md](MIGRATION.md)**。旧 Admission / Receipt / Manifest / Context Gate / Stage Gate 控制路径已退役，不作为可执行流程。