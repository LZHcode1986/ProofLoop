# Skills Policy

`.agents/skills/` 只保留可复用的 capability 与 phase/orchestration references；Pi/OpenCode 的 Role 工作流程由各自 Host Agent 文档独立拥有。

## Host-owned Role procedures

Role procedure、entry、mode、mutation boundary、forbidden actions、completion 和 transport 纪律分别内嵌在：

- OpenCode：`.opencode/agents/<role>.md`
- Pi：`.pi/agents/<role>.md`

两个 Host 都必须保持 `role_skill == subagent_type`，但各自独立加载自己的 Agent 文档。不要新增共享 Role Skill、第二个 Role controller 或跨 Host workflow pointer。MES、Result、Finding、lifecycle 和 packet 字段仍由 `.agents/contracts/brain/` 与 templates 定义。

角色包括 `general`、`worker`、`researcher`、`prototype`、`code-verifier`、`stage-plan-verifier` 和 `stage-reviewer`；`proofloop-plan` 是 Planning dispatch label，不是共享 Role Skill。

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


## Phase / Orchestration references

`proofloop-execute` 仍是 Execute 的 capability/orchestration method source；`proofloop-plan` 仅保留 Planning packet/schema 与 SPV references，Planning procedure 由两个 Host Planner system prompt 直接拥有：

| Skill | Phase |
|---|---|
| `ai-structured-prd` | Product intent → structured PRD |
| `prd-to-tech-design-prep` | Post-PRD technical clarification |
| `prd-to-ai-architecture` | Architecture package under `tech-spec/` |
| `proofloop-plan` | Planning packet/schema 与 SPV references（dispatch label；Planning method 在 Host Planner 文档） |
| `proofloop-execute` | Stage/Slice lane management and Work Packet projection |
| `wayfinder` | Oversized-effort map |

`proofloop-plan` 的 packet/schema 与 SPV references 保留在 `references/`；Planner 工作步骤只在 `.pi/agents/proofloop-plan.md` 与 `.opencode/agents/proofloop-plan.md`。

## Fact ownership

| Layer | Owns |
|---|---|
| Host Agent | Role/Brain workflow, native permission, transport and host entry |
| Contract | Semantics, fields, states, error codes and lifecycle bindings |
| Template | Dispatch packet and Result schema |
| Runtime | Mechanical Git boundary, Integration and MES operational facts |
| Capability Skill | Reusable technical method |

Pi Brain 的完整流程在 `.pi/brain-workflow.md`；OpenCode Brain 的完整流程在 `.opencode/agents/brain.md`。两者各自加载，不存在第三份 canonical workflow 文件。