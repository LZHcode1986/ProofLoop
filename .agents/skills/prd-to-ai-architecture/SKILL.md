---
name: prd-to-ai-architecture
description: Propose 收尾 skill（无独立 ARCHITECTURE phase，不做 artifact-by-artifact 用户确认）：use after the PRD contribution is ready (and on-demand clarification resolved); produce the four core Authority files and, when frontend scope exists, close the conditional `tech-spec/frontend.md` handoff via `frontend-tech`; the final completion signal is PROPOSE_READY.
disable-model-invocation: true
---

# PRD to AI Architecture

## Propose completion 定位

- 定位: 统一 Propose 的收尾部分（不拥有独立 ARCHITECTURE phase，不做 artifact-by-artifact 用户确认，不发独立完成 Gate）
- Prerequisite: 同一 Propose 内 PRD contribution 就绪；需要的产品级技术澄清已并入（按需 `prd-to-tech-design-prep`）
- Completion: canonical Propose 包完整 → 最终完成信号 `PROPOSE_READY`
- Handoff: same Propose 内完成四类 core Authority；存在 frontend scope 时，显式加载 `frontend-tech` 完成条件性的 `tech-spec/frontend.md` handoff，然后才返回 `PROPOSE_READY`；Stage/Slice/Task/dependency execution planning 全部交 `proofloop-plan`（STAGE_PLANNING）；`codebase-design` 仅作为按需加载的 module/seam/domain-boundary capability
- Rollback: 架构需要修改时继续本 skill；PRD 需要修改时回到 `ai-structured-prd`

## Purpose

Transform a PRD into AI-coding-ready technical guidance before implementation starts.

This skill is not a prompt pack. It is a workflow for producing compact, auditable artifacts that constrain later AI coding work.

## When To Use

Use this skill when:

- The user has a PRD, product brief, feature spec, or technical intake brief.
- The user wants to code with an AI agent after architecture planning.
- The project risk includes missing features, interface mismatch, fake/mock implementations, skipped difficult parts, wrong ports, unclear module boundaries, or weak acceptance criteria.
- The user wants reusable SOP, architecture templates, or acceptance mappings.

Do not use this skill for:

- Tiny one-file fixes where a design step would add no value.
- Pure brainstorming with no intent to implement.
- General PRD writing without a technical architecture output.

## Inputs

Required:

- PRD or product requirements document.

Optional:

- Technical clarification brief.
- Existing codebase structure.
- Preferred stack.
- Non-goals.
- Acceptance criteria.
- Known failure cases from prior AI coding attempts.

## Core Workflow: PACT

1. **Parse PRD**
   - Extract product facts, user flows, scope, non-goals, outputs, state, data, dependencies, risks, and acceptance criteria.
   - Mark each item as `confirmed`, `assumed`, or `open`; record missing technical decisions as `open`.

2. **Architecture Grilling With Docs** *(conditional mode — not a mandatory step)*
   Enter grilling mode only when at least one entry criterion is met:
   - An `open` or `assumed` item blocks producing or confirming the current artifact.
   - A term is vague or overloaded, or conflicts with the PRD, existing docs, or codebase.
   - User assumptions conflict with existing docs or code.
   - A hard-to-reverse, surprising, or trade-off-heavy decision needs a decision-log record.

   If no entry criterion is met, skip the interview entirely and produce the artifact directly, labeling decisions `confirmed`/`assumed`/`open`. Do not ask questions for the sake of asking — with a complete PRD, skipping is the expected default, not a failure.

   When grilling engages, you MUST read `references/grilling-protocol.md` and follow it exactly.

### Brownfield seam grounding
当 Architecture 即将 `confirmed` 一个会约束现有系统的 public/cross-module seam 时，先对该 seam 做 bounded grounding：只读取相关 existing public interface、durable fact model、state representation、producer/consumer 与 persistence boundary。该 grounding 不是 repo-wide scan，也不替 Architecture 设计 helper/signature；若现实不可证实，保留为 `open` 并进入技术澄清，不把实现选择固化为 Authority。

3. **Architecture Brief**
   - Create `tech-spec/architecture.md`.
   - Include system context, module boundaries, runtime flows, technical context, hard parts, and the decision log.
   - Every PRD must-implement item maps to a module in the brief; keep it lightweight by default and expand only when risk requires it.

4. **Contracts & Constraints**
   - Create `tech-spec/contracts.md`.
   - Lock API routes, event streams, file paths, database/JSON schema, task states, ports, and error behavior.

5. **Acceptance Mapping**
   - Create `tech-spec/acceptance.md`.
   - Map every PRD must-implement item to acceptance criteria and evidence checks; record non-goals and forbidden shortcuts.
   - No task breakdown, no dependency ordering, and no work-item decomposition here — `proofloop-plan` owns Stage/Slice/Task execution planning.

## Conditional frontend handoff closure

Architecture、Contracts 和 Acceptance current 后，判断当前 must-implement outcome 是否存在 frontend scope。Frontend scope 的判断是：至少一个 must-implement product outcome 要求用户通过 user-visible software interface 查看信息或执行交互；纯 API、CLI、background 或 infrastructure work 不产生 frontend scope。

- 无 frontend scope：skip `frontend-tech`，按四类 core Authority 完成 Propose。
- 有 frontend scope：Brain 显式读取并加载 `.agents/skills/frontend-tech/SKILL.md`，从当前 Product/Technical Authority、可用 design-prototype evidence 和 relevant frontend reality 生成或更新 `tech-spec/frontend.md`。
- `tech-spec/frontend.md` 是 conditional frontend handoff，不是第五类 core Authority，不创建 frontend phase、Gate 或 status。
- blocking handoff gap 只在 frontend implementer 必须猜测产品行为、backend capability/semantics、permission/error behavior 或 frontend↔backend boundary 时成立；普通 implementation HOW 不阻塞。
- blocking gap 必须回真正的 PRD、Architecture、Contracts 或 Acceptance owner 修复，再重新闭合受影响的 `frontend-tech` handoff；不得在 `frontend.md` 内发明语义。
## ProofLoop Propose completion

The canonical Propose package is exactly:
1. `PRD.md`（由 `ai-structured-prd` 在同一 Propose 内贡献）
2. `tech-spec/architecture.md`
3. `tech-spec/contracts.md`
4. `tech-spec/acceptance.md`

No artifact-by-artifact user confirmation and no package-wide user checkpoint are required: this skill closes the applicable four core Authority outputs and, when frontend scope exists, the conditional frontend handoff; the ONLY final completion signal is `PROPOSE_READY`.

A user-requested bounded update may touch only the requested owner (e.g. only `tech-spec/architecture.md`); the four core Authority owners stay fixed. `PROPOSE_READY` is emitted only when all four core owners are current and consistent and, when frontend scope exists, `tech-spec/frontend.md` is current with no blocking frontend handoff gap.
A formal `AUTHORITY_GAP` from Planning/SPV or a blocking frontend handoff gap returns to this current Propose owner when canonical Technical Authority is missing, contradictory, or invalidated by grounded current reality under unchanged Product intent. Complete the bounded Authority update, rerun the affected `frontend-tech` closure when applicable, keep the four-file package current/consistent, and let Brain accept the exact path set before the `authority-update` mechanical boundary; ordinary Technical Authority repair does not require a separate user approval checkpoint.

Stage/Slice/Task/dependency execution planning belongs to `proofloop-plan`（STAGE_PLANNING）, not to this skill. Brain enters PLANNING directly after `PROPOSE_READY`（proofloop-plan → stable Git boundary → fresh SPV → `PLAN_READY` → accepted Plan → proofloop-execute）. `codebase-design` may be loaded on demand by Planner/Architecture as a module/seam/domain-boundary capability; it never emits a workflow status.

If the user requests architecture changes, continue in this skill; if the PRD must change, return to `ai-structured-prd`.

## Downstream entity markers

When a PRD/Tech Spec entity will be referenced by a downstream Authority ref,
an accepted Plan, or a Work Packet, load and
apply `.agents/contracts/brain/authority-entity-markers.md`. The Contract is the
single source for marker syntax, allowed kinds, canonical refs, and completion
checks; this Skill owns applying the rule to architecture output.

## Required Outputs

Produce the canonical Propose package; the outputs live at:

- `PRD.md`（`ai-structured-prd` 在同一 Propose 内产出的 PRD contribution）
- `tech-spec/architecture.md`
- `tech-spec/contracts.md`
- `tech-spec/acceptance.md`
- `tech-spec/frontend.md` only when frontend scope exists（conditional handoff; produced via `frontend-tech`）

For detailed templates, read:

- `references/architecture-template.md`
- `references/contracts-template.md`
- `references/grilling-protocol.md`（only when grilling mode engages, per Step 2）

## Quality Gates

Do not emit the final `PROPOSE_READY` signal unless:

- Scope and non-goals are explicit.
- Technical decisions and architecture-impacting assumptions are labeled as confirmed, assumed, or open.
- Module boundaries include both responsibilities and non-responsibilities.
- APIs/events/files/data/state have a verification path.
- Hard parts include forbidden shortcuts and minimum acceptable implementation.
- Every PRD must-implement item maps to an acceptance check in `tech-spec/acceptance.md`.
- Domain terms that affect architecture are canonicalized.
- Key roles, permissions, ownership, and state transitions have been scenario-tested where not already resolved by the PRD, docs, or codebase.
- Hard-to-reverse or surprising decisions are captured in the architecture decision log（`tech-spec/architecture.md`）.
- All four canonical owners are current and consistent（`PRD.md`、`tech-spec/architecture.md`、`tech-spec/contracts.md`、`tech-spec/acceptance.md`）.
- When frontend scope exists, `tech-spec/frontend.md` is current and every material frontend handoff gap is closed or downgraded to genuinely non-blocking implementation freedom.
## Anti-Patterns

Reject or revise outputs that:

- Read like a generic architecture essay.
- Omit ports, routes, files, data, or task states when they matter.
- Treat mock data, TODOs, fake integrations, or static UI as finished work.
- Ask AI to implement everything in one giant task.
- Hide open questions.
- Claim the architecture guarantees AI will not make mistakes.
