---
name: ai-structured-prd
description: convert messy product ideas, chat history, notes, screenshots, or partial requirements into an ai-usable structured prd for non-technical users. use when the user wants to turn an idea into a prd, prepare requirements before ai coding, maintain prd context across a long conversation, review a prd for clarity, or identify missing product decisions before technical design. focuses on intent, users, scenarios, flows, scope, acceptance criteria, decision ledger, glossary, and readiness; does not create full technical architecture or implementation plans.
---

# ai-structured-prd

Create and maintain a structured product requirements document for AI-assisted development. Optimize for non-technical users, but do not make the PRD shallow: capture all product facts that affect implementation, using plain language and short explanations for necessary terms.

## Core principle

Do not generate a PRD directly from a long conversation. First create or update `PRD Context`, then draft or review the PRD from that structured context.

Separate layers:
1. `PRD Context`: rolling working document for confirmed facts, inferred assumptions, open questions, non-goals, draft acceptance criteria, glossary, and change log.
2. `PRD`: user-readable requirements document describing what/why/for whom/when/done, not a full technical solution.
3. `Technical design`: later artifact, outside this skill unless the user only asks for product-level handoff questions.

## Mode selection

Use the smallest mode that fits the request:

1. **intent mode**: user has a vague idea. Restate the desired outcome, user, why now, success, constraints, and out of scope. Ask one high-leverage question if needed.
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

6. **Prepare stage candidates only after PRD readiness**
   - Do not create stage candidates while core PRD facts are still unstable.
   - Stage candidates are product-delivery slices for Brain dispatch, not technical tasks.
   - Each candidate must map to user-visible value or a coherent product capability.
   - Each candidate must preserve PRD acceptance criteria, scope, and non-goals.
   - Do not include file scopes, implementation order, framework choices, database choices, API design, schema, or task breakdown.
   - Output stage candidates only after PRD review is `ready` or `mostly ready`, or when Brain explicitly needs dispatch preparation.
   - Optional reference: `references/prd-template.md` section "Optional: Product Stage Candidates".

7. **Confirm handoff**
   - Ask the user to confirm the PRD before any technical design.
   - If the PRD is confirmed, it is ready for downstream dispatch (technical handoff, stage candidates, or Propose).

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
4. Optional `Product Stage Candidates` only when:
   - the PRD is mostly ready or ready;
   - Brain needs dispatch preparation;
   - the candidates can be expressed as product value boundaries, not technical work packages.

### Review mode

Output:
1. Readiness status.
2. Score and dimension-level gaps.
3. Confirmed decisions and inferred assumptions.
4. Critical gaps, contradictions, terminology conflicts, and scenario pressure tests.
5. Recommended next step.

## Reference files

- `references/prd-context-template.md`: load when creating or updating the rolling PRD Context.
- `references/prd-template.md`: load when drafting the final PRD.
- `references/review-rubric.md`: load when scoring or reviewing a PRD.
- `references/question-patterns.md`: load when choosing clarification questions or converting technical concerns into user-answerable questions.
