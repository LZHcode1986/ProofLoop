# MIGRATION.md — 迁移到新项目指南

将本模板复制到新业务项目后，保留 Runtime/MES 语义，按以下边界改写。

## 复制

| 路径 | 说明 |
|---|---|
| `packages/kernel/`、`packages/runtime/` | 校验核心、MES、Task Result/CV/Finding/Integration 与 public CLI |
| `package.json`、`package-lock.json`、`tsconfig.json` | 构建配置 |
| `.agents/contracts/brain/` | 共享 Contract：MES、Result、Finding、生命周期、Integration、Recovery |
| `.agents/skills/proofloop-plan/references/` | Planning/SPV packet 和 schema references |
| `.agents/skills/proofloop-execute/` | Execute lane、Work Packet 与 CV templates |
| `.opencode/agents/*.md` | OpenCode 独立的 Brain/Role 文档；包含流程、边界和 native permission |
| `.pi/agents/*.md`、`.pi/brain-workflow.md` | Pi 独立的 Role/Brain 文档；包含流程、边界和 Host 配置 |
| `.pi/extensions/proofloop-mode.ts` | Pi mode/session 入口 |
| `AGENTS.md`、`opencode.json`、`.opencode/tui.json` | 项目规则和 harness 配置 |

Pi 与 OpenCode 都必须从各自 Agent 文档加载 Role 工作流程；不要再建立共享 Role 流程文件或第二套 Host controller。共享 Contract/template 只拥有字段、binding、MES transaction 和 Result 语义。

## 改写

- `CONTEXT.md`：新项目 Working Memory，不作为 Authority。
- `PRD.md`：产品目标、用户场景、Scope、FR 和验收约束。
- `tech-spec/`：Architecture、Contracts、Acceptance 和 process discipline。
- 每个 Host 的 Agent 文档：按项目调整 model、variant、工具权限和 scope 说明；不得改变 `role_skill == subagent_type`、Result binding、fallback/retry 或 recovery 规则。

主流程保持：Propose → Planning → Execute → Review → `PROJECT_READY`。Planning 由 Planner/SPV 完成，Execute 使用 JIT Work Packet、Worker、CV 和 Integration，Review 使用 Outcome → Composition → Authority 三轴。

## 初始化与验证

新项目首次运行时创建 `.proofloop/`、Stage Map、Plan、MES facts 和 progress snapshot；不要复制历史 delivery 或旧 Receipt/Manifest/Context 数据。

```bash
npm install
npm run build
node packages/runtime/dist/cli/proofloop.js boundary close --json
node packages/runtime/dist/cli/proofloop.js integration apply --json
node packages/runtime/dist/cli/proofloop.js status --json
```

## 历史路径

Admission、Receipt、Manifest、Context Gate、Stage Gate、`stage next`、`run-gate`、`review finalize-stage`、`project finalize-review` 和 `stage close` 已退役，不提供迁移路径，也不作为当前 route。