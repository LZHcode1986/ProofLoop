# CONTEXT.md — 当前执行上下文（Working Memory）

> 本文件是 Working Memory，不是 downstream Authority。Planning / Execute / Review 不得把它当 Product 或 Technical Authority。

## 事实来源

- Product Authority：`PRD.md`
- Architecture / Contracts / Acceptance：`tech-spec/`
- Operational execution facts：MES（`.agents/contracts/brain/mes.md`）
- Brain/Role 工作流程：所选 Host 的 Agent 文档（OpenCode `.opencode/agents/*.md`；Pi `.pi/agents/*.md` 与 `.pi/brain-workflow.md`）
- Packet、Result、Finding、生命周期和 Git transaction 语义：`.agents/contracts/brain/` 与 phase templates
- Git/worktree reality：Git 和 `.proofloop/` durable facts

## 当前上下文

本仓库正在使用 Propose → Planning → Execute → Review → `PROJECT_READY` 模型。旧 Admission、Receipt Chain、Manifest credential、Context Gate、Stage Gate 和旧 CLI 控制路径已经退役。MES 是唯一 operational state/traceability 事实源，Brain 是唯一 route、dispatch、arbitration、recovery 和 MES write-back owner。

当前 public CLI 只提供：

- `proofloop boundary close`：机械 Git boundary
- `proofloop integration apply`：机械 Integration
- `proofloop status [--detail]`：只读 MES observation

## MES / Result 规则

- 一级 status 只暴露 scope、phase、required skill 和非零异常计数；detail 才显示 current work、owner、blocking、Result/Finding refs、candidate/integration Git refs 和 cleanup。
- 写入 MES 的只能是 Brain route decision、结构化 Result/Finding、Review verdict 和 Git facts。Agent narrative、transport `sent`/`idle`/`done`、session/transcript、checkbox 和 progress 文本不是业务事实。
- Task Result 必须绑定 stage/slice/task、Plan、Authority、Git basis、`actionToken` 和 `resultId`；接纳后由 MES transaction layer materialize。CV Finding 先回 Brain arbitration，不能直接触发 repair。
- Work Packet 是 Task 开始时从 accepted Plan 和 current facts 投影的 derived input；Worker 每个 Task fresh-read JIT Read Set，不选择 successor、不接收 future Task。

## Brain route

两个 Host 的 Brain 文档各自包含完整流程和 dispatch：

- OpenCode：`.opencode/agents/brain.md`
- Pi：`.pi/brain-workflow.md`

两侧流程语义一致但由各自 Host 独立加载；Role procedure 分别内嵌在 `.opencode/agents/<role>.md` 与 `.pi/agents/<role>.md`。不再依赖共享 Role 流程文件。`role_skill == subagent_type` 必须保持，Host session/transcript/model/message id 只作 ephemeral transport metadata。

### Route 顺序

```text
PROPOSE → PROPOSE_READY
PLANNING → Planner → fresh SPV → PLAN_READY → MES PLAN_ACCEPTANCE
EXECUTE → dependency-ready Slice → Worker Task/ACK → SLICE_CANDIDATE_READY
         → fresh CV → PASS/FINDINGS → candidate ref → Integration
REVIEW → Stage Reviewer: Outcome → Composition → Authority
        → STAGE_ACCEPTED → all planned Stages → PROJECT_READY
```

Planning、Execute、Review 和 recovery 的具体操作分别由当前 Host Agent 文档与对应 Contract/template 执行；Brain 每次接纳 Result 后重新读取 durable facts 和 Git。

## Host transport

- Pi：`Agent` 创建、`resume` continuation、`get_subagent_result` 读取。
- OpenCode：native `task` child dispatch、child `sessionID` continuation、returned result/failure。
- Initial/recheck 的 SPV、CV、Stage Reviewer 默认 fresh；Worker 同一 Slice 只有 binding current 才能 continuation。
- Host 配置变更只影响下一次 dispatch；缺失、非法、权限拒绝、session loss 或 Result 缺失都 fail closed，不 fallback、不 retry、不换 role。

## Recovery

恢复只使用 MES durable facts、accepted/candidate Plan、Authority、structured Result/Finding 和 Git/worktree reality。不能恢复旧 session、隐藏对话、旧 Primary Next Action 或 transport transcript；不确定的 work 标为 recovery，再按当前 binding fresh/continue。S06 integrity hard-freeze 时拒绝 NORMAL continuation，只允许合法 `MES_MAINTENANCE` evidence-only branch。

## 文件边界

四类 Authority 是 `PRD.md`、`tech-spec/architecture.md`、`tech-spec/contracts.md`、`tech-spec/acceptance.md`。共享 `.agents/contracts/brain/` 只保留业务 Contract、MES transaction、生命周期、Finding convergence、Integration 和 technical-unknown 语义；Host-specific Agent 文档拥有实际角色流程和宿主权限。未经授权不得修改 Authority、accepted Plan、MES facts、Result/Finding、Evidence 或 Git boundary。