# MIGRATION.md — 迁移到新项目指南

把本模板仓库迁移到一个新业务项目，按以下三步操作。

## 第一步：复制（直接复制，不改内容）

| 路径 | 说明 |
|---|---|
| `packages/kernel/`、`packages/runtime/` | 校验核心 + CLI（含 `dist/` 构建产物，复制即用） |
| `package.json`、`package-lock.json`、`tsconfig.json` | 构建配置（workspaces、4-worker OOM 防护） |
| `.agents/contracts/brain/` | Brain 角色契约（评审/提交/验收/研究/原型/多轮修复等 9 个） |
| `.agents/skills/`（13 个） | 流程技能：`proofloop-plan`、`proofloop-execute`、`ai-structured-prd`、`prd-to-ai-architecture`、`prd-to-tech-design-prep`、`codebase-design`、`test-driven-development`、`security-and-hardening`、`diagnose`、`code-review-and-quality`、`handoff`、`wayfinder`、`writing-great-skills` |
| 角色定义（二选一或都带） | Pi：`.pi/agents/`（8 个）+ `.pi/brain-workflow.md` + `.pi/extensions/proofloop-mode.ts`；OpenCode：`.opencode/agents/`（9 个） |
| `AGENTS.md` | 项目规则（流程纪律、职责边界） |
| `opencode.json`、`.pi/subagents.json` | harness 配置（按需） |

## 第二步：改写（复制后修改内容，保留结构）

| 文件 | 改什么 |
|---|---|
| `CONTEXT.md`、`PRD.md` | 换成新项目的需求与上下文（保留章节结构） |
| `tech-spec/`（5 个文件） | 换成新项目的架构/合同/难点/验收矩阵（保留结构；按 `prd-to-ai-architecture` 技能生成） |

## 第三步：初始化（新项目从零生成，不要复制）

| 项 | 做法 |
|---|---|
| `.proofloop/` | 新项目首次运行自动/手工创建；`runtime.lock` 见下 |
| `delivery/stages/` | 从第一个 Stage 的规划开始生成（`plan materialize`） |
| `progress.md` | 新项目自己的进度快照 |

### runtime.lock 初始化

新项目需创建 `.proofloop/runtime.lock`（示例，`host_adapter` 按实际 harness 改）：

```json
{
  "runtime_version": "0.1.0",
  "domain_schema_version": 1,
  "risk_policy_version": 1,
  "capability_policy_version": 1,
  "host_adapter": "opencode",
  "extension_package": "@proofloop/runtime",
  "extension_version": "0.1.0"
}
```

## 验证模板可用

```bash
npm install
npm run build
node packages/runtime/dist/cli/proofloop.js doctor run --json   # 应 exit 0
node packages/runtime/dist/cli/proofloop.js cutover status --json --stage S1   # 应报告 clean（无 legacy）
```

## 注意

- **不要复制历史 Stage 数据**（`delivery/`、`.proofloop/receipts|manifests`）——它们绑定本项目的事实与摘要。
- 角色 harness 二选一：Pi 用 `.pi/agents/`，OpenCode 用 `.opencode/agents/`；不要混用两套定义。
- 流程第一步：`ai-structured-prd`（产品定义）→ `prd-to-ai-architecture`（架构）→ `proofloop-plan`（规划）。
