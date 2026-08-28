# ProofLoop v2 — 流程模板仓库

本仓库是 **ProofLoop v2 通用 CLI 流程**的干净模板：包含迁移到新项目所需的流程文件，以及 `packages/runtime/test/` 中的 Runtime 测试与 fixtures；
不含任何历史 Stage 数据或机器事实（`.proofloop/`）。

**用途**：把本仓库复制到新项目，按 `MIGRATION.md` 改写需求文档并初始化。
本模板包含 ProofLoop 的完整目标流程结构；当前可执行能力与尚未闭合的流程项，以 `PRD.md` 和 `tech-spec/` 中标注的 `confirmed/open` 状态为准。

## 结构

| 路径 | 内容 | 迁移方式 |
|---|---|---|
| `packages/kernel` / `packages/runtime` | 校验核心 + public CLI（closed domain set） | 直接复制 |
| `.agents/skills/` | 流程技能（规划/执行/权威分析等） | 直接复制 |
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
