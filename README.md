# ProofLoop v2 — 流程模板仓库

本仓库是 **ProofLoop v2 通用 CLI 流程**的干净模板：只含迁移到新项目所需的流程文件，
不含任何历史 Stage 数据、测试夹具或机器事实（`.proofloop/`）。

**用途**：把本仓库复制到新项目，按 `MIGRATION.md` 改写需求文档并初始化，即可在新项目
中运行同一套可验证的 AI 流程（规划 → 计划认可 → 派工 → 验证 → 评审 → 验收）。

## 结构

| 路径 | 内容 | 迁移方式 |
|---|---|---|
| `packages/kernel` / `packages/runtime` | 校验核心 + CLI（10 域） | 直接复制 |
| `.agents/skills/` | 流程技能（规划/执行/权威分析等 13 个） | 直接复制 |
| `.agents/contracts/` | Brain 角色契约（评审/提交/验收/研究等） | 直接复制 |
| `.pi/agents/` + `.pi/brain-workflow.md` | Pi harness 角色定义 + Brain 工作流 | 按 harness 选择 |
| `.opencode/agents/` | OpenCode harness 角色定义 | 按 harness 选择 |
| `CONTEXT.md` / `PRD.md` / `tech-spec/` | 需求与权威模板（需改写） | 复制后改写 |
| `AGENTS.md` | 项目规则 | 直接复制 |
| `package.json` 等 | 构建配置 | 直接复制 |

## 快速开始

```bash
npm install
npm run build
node packages/runtime/dist/cli/proofloop.js doctor run --json
```

详细迁移步骤见 **[MIGRATION.md](MIGRATION.md)**。
