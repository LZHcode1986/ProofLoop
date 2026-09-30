# Skills Policy

`.agents/skills/` 只保留可复用的 capability 与 phase/orchestration references；Pi/OpenCode 的 Role 工作流程由各自 Host Agent 文档独立拥有。

## Host-owned Role procedures

Role procedure、entry、mode、mutation boundary、forbidden actions、completion 和 transport 纪律分别内嵌在：

- OpenCode：`.opencode/agents/<role>.md`
- Pi：`.pi/agents/<role>.md`

两个 Host 都必须保持 `role_skill == subagent_type`，但各自独立加载自己的 Agent 文档。不要新增共享 Role Skill、第二个 Role controller 或跨 Host workflow pointer。MES、Result、Finding、lifecycle 和 packet 字段仍由 `.agents/contracts/brain/` 与 templates 定义。
角色包括 `general`、`worker`、`researcher`、`prototype`、`planner`、`code-verifier`、`stage-plan-verifier` 和 `stage-reviewer`（`planner` 是第八个 canonical Role Skill，Planning dispatch 的 runtime label）。

## Capability Skill

Capability 是角色按 packet/Contract 按需加载的技术方法，不拥有 Role、Brain route 或业务状态：

| Skill | Purpose |
|---|---|
| `test-driven-development` | RED/GREEN/REFACTOR loop and proof profiles |
| `diagnose` | Reproducible defect diagnosis |
| `security-and-hardening` | Trust boundary, input, and secrets review |
| `codebase-design` | Module principles and seam identification |
| `writing-for-agents` | Writing documents an agent consumes |
| `handoff` | Conversation handoff |


## Brain phase capabilities

Brain-owned capability Skills for a process phase — product definition,
architecture, and large-effort wayfinding. The Brain loads them for the active
phase; they define that phase's capability steps and completion, not any
single role's method behavior. Role Skill methods (e.g. `planner`, `worker`) are loaded
only by the dispatched role instance, never by the Brain's own context.

| Skill | Phase |
|---|---|
| `ai-structured-prd` | Product intent → structured PRD |
| `prd-to-tech-design-prep` | Post-PRD technical clarification |
| `prd-to-ai-architecture` | Architecture package under `tech-spec/` |
| `frontend-tech` | Propose 中按 frontend scope 条件显式加载，生成 `tech-spec/frontend.md` conditional handoff |
| `wayfinder` | Oversized-effort map |

## Brain Flow Contracts

Brain-owned orchestration Contracts for a process flow. Flow Contracts 不是 Skills：
Brain 在 routing/dispatch 时直接读取它们作为 orchestration Contracts；Role Agent 从不把它们当作 Role method 加载，Role 文档也不复述这些 contracts。

| Contract | Flow |
|---|---|
| `.agents/contracts/brain/planning.md` | Brain-owned Planning orchestration（candidate boundary / SPV dispatch / acceptance authorization） |
| `.agents/contracts/brain/execute.md` | Stage/Slice lane orchestration、Worker/CV dispatch、candidate publication authorization |

`planner` 是第八个 canonical Role Skill（Planning dispatch 的 runtime label）：PLANNING dispatch 使用 `planner`，Role method 由两个 Host Planner 文档（`.pi/agents/planner.md` / `.opencode/agents/planner.md`）独立拥有；Planning Flow orchestration（candidate boundary / SPV dispatch / acceptance）属于 `.agents/contracts/brain/planning.md`。`proofloop-plan` / `proofloop-execute` 不再是 active skill 或 orchestration source；Execute orchestration 的唯一 owner 是 `.agents/contracts/brain/execute.md`。

## Fact ownership

| Layer | Owns |
|---|---|
| Host Agent | Role/Brain workflow, native permission, transport and host entry |
| Contract | Semantics, fields, states, error codes and lifecycle bindings |
| Template | Dispatch packet and Result schema |
| Runtime | Mechanical Git boundary, Integration and MES operational facts |
| Capability Skill | Reusable technical method |

Pi Brain 的完整流程在 `.pi/brain-workflow.md`；OpenCode Brain 的完整流程在 `.opencode/agents/brain.md`。两者各自加载，不存在第三份 canonical workflow 文件。