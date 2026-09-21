# Skills Policy

`.agents/skills/` holds reusable procedures in three categories. This file is
the policy index for that directory: it says which category a skill belongs to
and where each kind of fact lives. It is not a process source — role procedure,
orchestration flow, agent lifecycle, and runtime/model/placement configuration each have
one authoritative home, pointed to below.

## Invocation policy

Set `disable-model-invocation: true` when invocation is already owned by Brain routing,
Herdr dispatch, a packet `required_skills` list, an explicit path pointer, or a human
command. These Skills are loaded explicitly and do not spend always-on description
context. Keep model invocation enabled only while autonomous Skill discovery is the
actual entry mechanism; once an explicit routing pointer exists, remove that duplicate
discovery path.

## Role Skill

- Path: `.agents/skills/<role-name>/SKILL.md`.
- Seven canonical roles: `general`, `worker`, `researcher`, `prototype`,
  `code-verifier`, `stage-plan-verifier`, `stage-reviewer`.
- One Role Skill is the single source for its role's goal, entry conditions,
  procedure, modes/branches, mutation boundary, forbidden actions, capability
  skills, and completion criteria. A single-role Role Skill is the norm: one per
  canonical role.
- Runtime-neutral: the same canonical Role Skill is shared by Pi and AGY; it is
  selected by Brain and consumed by the Herdr-created role instance.
- Role Agent instances are not defined under `.opencode/` or `.pi/`; the only
  OpenCode host primary is `.opencode/agents/brain.md`, while Pi uses its thin
  host entry (`.pi/extensions/proofloop-mode.ts`). Both host entries point at
  the canonical shared workflow Contract `.agents/contracts/brain/workflow.md`.
- The Brain selects the Flow at the Routing Boundary per
  `.agents/contracts/brain/workflow.md`, loads the selected Skill's JIT
  Read Set, and initiates dispatch via Herdr Link configured start.
- Carries no model, runtime, or lifecycle definition — runtime and model configuration
  live in `.agents/agent_config.json` (where dispatch identity maps 1:1 to config key),
  mechanical dispatch order is owned by `.agents/contracts/brain/workflow.md`, and
  ProofLoop lifecycle is owned by `.agents/contracts/brain/agent-lifecycle.md` (see Pointers).

## Capability Skill

Reusable techniques any role may invoke on demand. A Capability Skill owns its
own procedure and completion criteria; roles reach for it, they do not copy it.

| Skill | Purpose |
|---|---|
| `test-driven-development` | RED/GREEN/REFACTOR loop and proof profiles |
| `diagnose` | Disciplined debugging loop for reproducible defects |
| `security-and-hardening` | Trust-boundary, input, and secrets review |
| `codebase-design` | Deep module principles and seam identification |
| `writing-for-agents` | Writing documents an agent consumes |
| `handoff` | Compact a conversation into a handoff document |
| `frontend-execute` | Frontend handoff → self-verified production UI implementation |
| `frontend-review` | Independent read-only frontend quality review against handoff and runtime evidence |

## Phase / Orchestration Skill

Brain-owned procedures for a process phase — product definition, architecture,
stage planning, stage execution, and large-effort wayfinding. The Brain loads
them for the active phase; they define that phase's steps and completion, not any
single role's behavior.

| Skill | Phase |
|---|---|
| `ai-structured-prd` | Product intent → structured PRD |
| `prd-to-tech-design-prep` | Post-PRD technical clarification |
| `prd-to-ai-architecture` | Architecture package under `tech-spec/` |
| `frontend-tech` | Conditional frontend technical handoff → `tech-spec/frontend.md` |
| `proofloop-plan` | Candidate Plan, SPV dispatch, Plan acceptance into MES |
| `proofloop-execute` | Stage/Slice lane management and role dispatch |
| `wayfinder` | Chart and work a shared map for an oversized effort |

`proofloop-plan` also serves as the Planning dispatch skill / runtime Planner input: a
PLANNING dispatch uses `dispatch_skill=proofloop-plan` (runtime label `planner`) and loads
`.agents/skills/proofloop-plan/SKILL.md`; it is not an eighth Role Skill. All seven canonical
Role Skills keep their fixed role bindings. The dispatch key for planning is `proofloop-plan`,
matching its key in `.agents/agent_config.json` (`role_skill == config_agent`).
## Where each fact lives

| Layer | Owns |
|---|---|
| Contract | Semantics, fields, states, error codes |
| Skill | Steps, branches, completion criteria |
| Template | Dispatch packets and schemas |
| Runtime | Mechanical Git boundary close (`proofloop boundary close`) + MES operational facts; no Receipt/admission/Gate/status CLI |
| Brain host entries (`.opencode/agents/brain.md`; `.pi/extensions/proofloop-mode.ts`) | Thin harness loading/routing adaptation only; point at `.agents/contracts/brain/workflow.md`; no Role Agent definitions |

## Pointers, not copies

- Agent lifecycle (`one-shot` / `continuation` / `review-loop` / `recovery` /
  `recall` / `reset`): `.agents/contracts/brain/agent-lifecycle.md`.
- Brain routing workflow (Routing Boundary + Trigger → Flow → Exit) and mechanical dispatch order:
  `.agents/contracts/brain/workflow.md`.
- Herdr Link configured-start configuration (dispatch identity maps 1:1 to config key):
  `.agents/agent_config.json`.

Brain/host entry loads a skill on demand; no `.opencode/` or `.pi/` role file
restates role procedure. Keep each meaning in one place: change a role's procedure in
its Role Skill, a runtime/model/placement configuration in `.agents/agent_config.json`, a dispatch rule in `.agents/contracts/brain/workflow.md`, and a lifecycle rule in `.agents/contracts/brain/agent-lifecycle.md`.
