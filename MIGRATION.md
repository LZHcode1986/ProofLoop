# MIGRATION.md — 迁移到新项目指南

把本模板仓库迁移到一个新业务项目，按以下三步操作。

## 第一步：复制（直接复制，不改内容）

| 路径 | 说明 |
|---|---|
| `packages/kernel/`、`packages/runtime/` | 校验核心 + public CLI 源码；复制后执行 `npm run build` 生成 dist。机械 domain：`boundary close`、`integration apply`；另提供只读 `proofloop status [--detail]` / `status --json [--detail]` MES observation entry（不属于 business-control domain） |
| `package.json`、`package-lock.json`、`tsconfig.json` | 构建配置（workspaces 与 TypeScript 项目引用） |
| `.agents/contracts/brain/` | Brain 角色契约（按目录中的当前文件复制；含 `mes.md` MES Contract） |
| `.agents/skills/` | Pi/AGY 共用的 Role、Capability 和 Phase/Orchestration Skills（按当前目录复制） |
| `.opencode/agents/brain.md` | OpenCode 唯一 Brain host primary（thin host）；只保留 Brain identity、必要权限与 canonical workflow pointer（`.agents/contracts/brain/workflow.md`） |
| `.pi/extensions/proofloop-mode.ts` | Pi Brain host entry（thin host）；只保留 mode 切换、持久化与同一 canonical workflow pointer（`.agents/contracts/brain/workflow.md`） |
| `AGENTS.md` | 项目规则（流程纪律、职责边界） |
| `opencode.json`、`.opencode/tui.json` | harness 配置（按需复制；`tui.json` 保持停用的 `{}`，不得恢复旧 plugin dispatch） |

## 第二步：改写（复制后修改内容，保留结构）

| 文件 | 改什么 |
|---|---|
| `CONTEXT.md` | 换成新项目的当前执行上下文（Working Memory；不是 Authority） |
| `PRD.md` | 换成新项目的产品权威（目标、用户场景、验收约束、FR、Scope、Decision ledger） |
| `tech-spec/`（4 个文件） | 换成新项目的架构/合同/难点/验收矩阵（保留结构；语义收敛到四类 canonical Authority：Architecture / Contracts / Acceptance；按 `prd-to-ai-architecture` 技能生成） |

四阶段主流程（Propose → Planning → Execute → Review → PROJECT_READY）、MES/status、
Brain Routing Boundary / 单一 workflow（`.agents/contracts/brain/workflow.md`）、Thin Plan / JIT Work Packet、Slice lane / CV / Integration、
三轴 Stage Review、PROJECT_READY 的语义按模板保留。

## 第三步：初始化（新项目从零生成，不要复制）

| 项 | 做法 |
|---|---|
| `.proofloop/` | 新项目首次运行自动/手工创建；`runtime.lock` 见下 |
| `delivery/stages/` | 从第一个 Stage 的 Planning 开始生成（Planner 产出 Thin Plan 后按 Work Packet 执行） |
| `progress.md` | 新项目自己的进度快照（不是 authority） |
| MES operational facts | 按 `.agents/contracts/brain/mes.md` 定义写入；Brain 是唯一写回 MES 的角色 |

### runtime.lock 初始化

新项目需创建 `.proofloop/runtime.lock`（示例；`host_adapter` 填调用 harness/CLI 标识，不代表 Plugin）：

```json
{
  "runtime_version": "0.1.0",
  "domain_schema_version": 2,
  "risk_policy_version": 1,
  "capability_policy_version": 1,
  "host_adapter": "opencode",
  "extension_package": "@proofloop/runtime",
  "extension_version": "0.1.0"
}
```

## 环境依赖

- **Node.js + npm**：构建并运行 public CLI（见下）。
- **Herdr**（https://herdr.dev/）：Agent runtime，必要环境之一。Brain 经 Herdr Link 启动并调度各 Role Agent
  （`herdr_link_start` / `herdr_link_send` / `herdr_link_close`），Agent 常驻独立 tab / isolated worktree 中运行。
- **Herdr Link** 插件：可替代旧 herdr skill 的跨 Agent dispatch / transport 插件；用户可选 herdr skill 或
  Herdr Link（不做强制要求），**推荐优先使用 Herdr Link**。dispatch 机械细节见
  `.agents/contracts/brain/workflow.md` §5 与 `.agents/contracts/brain/agent-lifecycle.md`。

## 验证模板可用

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

## 注意

- **不要复制历史 Stage 数据**（`delivery/`、旧 `.proofloop/receipts|manifests|context`）——
  旧 Receipt / Manifest / Context credential 语义已整体退役，它们绑定本项目的旧流程事实。
- 不复制 `.pi/agents/` 或 `.opencode/agents/` 的 role Agent 定义；OpenCode 只保留
  `.opencode/agents/brain.md` 这个 host primary（thin host），Pi 只保留 Brain host
  entry（thin host）。唯一 canonical Brain routing workflow 是
  `.agents/contracts/brain/workflow.md`：OpenCode 与 Pi 仅按该路径加载路由入口，
  不复制其流程正文，也不建立第二个 durable workflow/controller state；角色实例由
  Brain 根据 MES status + Skill 经 Herdr 启动（`.agents/contracts/brain/workflow.md` 拥有机械 dispatch 顺序，
  `.agents/contracts/brain/agent-lifecycle.md` 拥有 ProofLoop lifecycle）。跨 runtime 共用 Role Skill、
  Contract 和 Template 语义。
- 流程入口：`ai-structured-prd`（Propose）→ `prd-to-ai-architecture`（Authority）→
  `proofloop-plan`（Planning）→ `proofloop-execute`（Execute）→ `stage-reviewer`（Review）。

## Historical / legacy（单一简短说明，不作为可执行路径）

旧 ProofLoop CLI 的流程控制命令（`stage next`、`context prepare/show/admit-*`、
`stage admit-*`、`run-gate`、`review finalize-stage`、`project finalize-review`、
`stage close`、Manifest / Receipt / Admission / Gate 相关 domain）已随旧控制模型整体退役，
对应 domain 已从当前 CLI 移除；本文档与模板不再提供这些命令的迁移路径，也不引用已删除
文件。需要历史背景时见 `.docs/` 规划与归档材料（仅作历史说明，不形成 route）。