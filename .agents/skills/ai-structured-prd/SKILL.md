---
name: ai-structured-prd
description: Propose 阶段内 PRD 贡献（不拥有独立 phase）：use when the user has a rough idea or an existing PRD to review; build PRD Context first, then produce a structured PRD contribution; the unified Propose ends with PROPOSE_READY, not a separate PRD gate.
disable-model-invocation: true
---

# ai-structured-prd

## Propose contribution 定位

- 定位: 统一 Propose 的 PRD 贡献部分；PRD contribution 与后续 tech-spec 包在同一 Propose 内完成，只有一个最终完成信号 `PROPOSE_READY`
- Prerequisite: user has a rough idea, or an existing PRD to review
- Completion: PRD contribution 并入同一 Propose（不由本 Skill 单独确认）
- Handoff: 同一 Propose 内继续——需要产品级技术澄清时按需加载 `prd-to-tech-design-prep`；架构/合同/验收包由 `prd-to-ai-architecture` 产出
- Rollback: if the user later requests PRD changes, Brain reloads this skill

Create and maintain a structured product requirements document for AI-assisted development. Optimize for non-technical users, but do not make the PRD shallow: capture all product facts that affect implementation, using plain language and short explanations for necessary terms.

## Core principle

Do not generate a PRD directly from a long conversation. First create or update `PRD Context`, then draft or review the PRD from that structured context.

Separate layers:
1. `PRD Context`: rolling working document for confirmed facts, inferred assumptions, open questions, non-goals, draft acceptance criteria, glossary, and change log.
2. `PRD`: user-readable requirements document describing what/why/for whom/when/done, not a full technical solution.
3. `Technical design`: later artifact, outside this skill unless the user only asks for product-level handoff questions.

## Mode selection

Use the smallest mode that fits the request:

1. **intent mode**: user has a vague idea. Restate the desired outcome, user, why now, success, constraints, and out of scope.
2. **context mode**: conversation contains scattered decisions. Build or update `PRD Context` and label each item as `confirmed`, `inferred`, `decided during intake`, `open`, or `optional`.
3. **draft mode**: enough context exists. Generate the structured PRD using `references/prd-template.md`.
4. **review mode**: user provides a PRD or draft. Use `references/review-rubric.md` to score readiness and ask only the single most important clarification if blocked.

## Operating rules

- Read all available context before asking.
- Do not ask broad questionnaires.
- Ask at most one consequential question at a time.
- Every question must include why it matters, a recommended default, and severity.
- Prefer recommended defaults over long option lists.
- Do not mark AI guesses as confirmed.
- Update `PRD Context` after every 1-3 consequential user answers.
- Before producing the final PRD, ask the user to confirm the current `PRD Context` when important assumptions remain.
- Keep language accessible to non-programmers. If a term such as login, permission, data saving, import/export, deployment, or integration is necessary, explain it in one sentence.
- Include product facts that affect implementation, such as login, data persistence, roles, permissions, uploads, integrations, mobile use, privacy, payment, content safety, and admin needs.
- Do not choose frameworks, databases, API design, schema, architecture, deployment, or task breakdown inside the PRD.
- When the user is missing a product decision that blocks progress, return `USER_DECISION_REQUIRED`.
- When a product authority gap is identified (e.g., scope, behavior, permission, or acceptance criteria is unclear), return `AUTHORITY_GAP` with a descriptive subtype. Do not turn a purely technical Authority invalidation or implementation defect into a product question; ordinary Technical Authority repair is handled by the current Propose owner and Brain acceptance.

## Standard workflow

1. **Initialize PRD Context**
   - Use `references/prd-context-template.md`.
   - Fill what is already known.
   - Put low-risk guesses under `inferred`, not `confirmed`.

2. **Clarify intent**
   - Produce a short hypothesis and confidence.
   - Ask one question only when the answer materially affects users, scope, flow, acceptance criteria, data, permissions, risk, or success metrics.

3. **Maintain decision ledger**
   - Preserve confirmed decisions across turns.
   - Move user-approved inferred assumptions to `decided during intake` or `confirmed`.
   - Keep unresolved but non-blocking items under `optional`.

4. **Draft PRD**
   - Generate from PRD Context, not raw chat.
   - Use user-observable acceptance criteria: "when..., the user should see/be able to...".
   - Include non-goals and version boundaries.

5. **Review PRD**
   - Score with the 100-point rubric in `references/review-rubric.md`.
   - Output readiness: `ready`, `mostly ready`, `needs revision`, or `blocked`.
   - If blocked, ask only the highest-leverage clarification question.

6. **Propose 内交接**
   - PRD contribution（PRD.md）就绪后，同一 Propose 内继续：产品级技术问题阻塞架构步骤时按需加载 `prd-to-tech-design-prep`；最终 canonical 包（tech-spec/architecture.md、tech-spec/contracts.md、tech-spec/acceptance.md）由 `prd-to-ai-architecture` 产出。
   - 本 Skill 不输出 Stage Candidates 或 Stage decomposition；Stage/Slice/Task 分解由 `proofloop-plan` 负责。
   - 用户要求修改 PRD 时继续在本 Skill；Propose 的最终完成信号是 `PROPOSE_READY`（由收尾 Skill 给出），不是本 Skill 单独确认。
## Clarification question format

```md
### Clarification Needed

**Question**
[one precise question]

**Why it matters**
[what this affects: scope, user flow, acceptance criteria, permissions, data, risk, success metric, or future technical design]

**Recommended default**
[a concrete default written in plain language]

**Severity**
Critical | Optional
```

## Required outputs by mode

### Intent or context mode

Output:
1. `PRD Context Update` using the core ledger sections.
2. One clarification question if a critical gap remains.
3. No full PRD unless the context is sufficiently clear or the user explicitly asks for a draft.

### Draft mode

Output:
1. `PRD Context Snapshot` summary.
2. Full PRD using `references/prd-template.md`.
3. Remaining open questions, separated into critical and optional.
### Review mode

Output:
1. Readiness status.
2. Score and dimension-level gaps.
3. Confirmed decisions and inferred assumptions.
4. Critical gaps, contradictions, terminology conflicts, and scenario pressure tests.
5. Recommended next step.

## Downstream entity markers

When a PRD entity will be referenced by a downstream Authority ref, an accepted
Plan, or a Work Packet, load and apply
`.agents/contracts/brain/authority-entity-markers.md`. The Contract is the single
source for marker syntax, allowed kinds, canonical refs, and completion checks;
this Skill owns when the rule applies to PRD output.

## Reference files

- `references/prd-context-template.md`: load when creating or updating the rolling PRD Context.
- `references/prd-template.md`: load when drafting the final PRD.
- `references/review-rubric.md`: load when scoring or reviewing a PRD.
- `references/question-patterns.md`: load when choosing clarification questions or converting technical concerns into user-answerable questions.
