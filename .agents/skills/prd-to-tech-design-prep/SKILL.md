---
name: prd-to-tech-design-prep
description: Propose 内按需澄清方法（不拥有独立 phase/Gate）：use only when the PRD contribution is ready and product-level technical questions block the architecture step; produce plain-language clarification questions and a technical design input brief that feed the same Propose.
disable-model-invocation: true
---

# prd-to-tech-design-prep

## Method ownership

- 定位: 统一 Propose 内按需加载的澄清方法（不拥有独立 phase，不做独立 phase checkpoint，不发独立完成 Gate）
- Prerequisite: PRD contribution 就绪，且存在阻塞 Propose 架构步骤的产品级技术问题
- Completion: 澄清结果并入同一 Propose；最终完成信号仍是 `PROPOSE_READY`
- Handoff: 澄清产物直接作为 `prd-to-ai-architecture` 的输入；用户确认不是本方法的前置
- Rollback: 澄清结果需要修改时继续本方法；PRD 本身需要修改时回到 `ai-structured-prd`

Prepare the transition from a PRD contribution that is ready to technical design without forcing non-technical users to write architecture. Convert product facts into plain-language technical clarification questions, glossary explanations, and a clean handoff brief for a later technical design workflow.

## Use after PRD contribution is ready

This method assumes the PRD contribution or PRD Context already exists inside the current Propose. If the user still has only a rough idea or an unreviewed PRD, use the PRD-building/review workflow first (`ai-structured-prd`).

## Core boundaries

Do:
- Extract product facts that affect implementation.
- Ask plain-language clarification questions.
- Explain necessary technical terms simply.
- Identify domain terminology conflicts.
- Use scenario pressure tests for ambiguous roles, data visibility, permissions, fallback behavior, and integrations.
- Produce a technical design input brief that another AI or developer can use.
- Hand off to `prd-to-ai-architecture` if the conversation moves into architecture trade-offs, framework choices, data ownership, API contracts, or state design.

Do not:
- Choose a framework, database, hosting provider, architecture pattern, schema, or API contract unless the user explicitly asks to proceed into technical design.
- Turn the PRD into a task breakdown.
- Ask users to understand deep technical terms before explaining them.
- Reopen product discovery unless a product decision blocks technical design.
- Run deep architecture grilling.

## Workflow

1. **Read the PRD first**
   - Extract users, roles, flows, features, non-goals, acceptance criteria, glossary, and open decisions.
   - Preserve PRD scope. Do not expand the product.

2. **Map product facts to implementation-impact areas**
   - Login/account needs.
   - Data saving and history.
   - Roles and permissions.
   - File uploads.
   - Import/export and integrations.
   - Mobile/desktop usage.
   - Privacy, payment, content safety, legal or compliance risk.
   - Admin, moderation, approval, reporting, audit, notifications.

3. **Generate user-answerable technical clarification questions**
   - Use `references/tech-clarification-template.md`.
   - Ask in plain language.
   - Include why it matters and recommended default.
   - Mark severity as `critical` or `optional`.

4. **Create or update glossary**
   - Use `references/glossary-and-domain-checks.md` when terms may be overloaded.
   - Explain necessary technical words in one sentence.
   - Keep business terms and technical terms separate when useful.

5. **Run scenario pressure tests when needed**
   - Use concrete examples instead of vague questions.
   - Focus on permissions, data visibility, fallback behavior, role transitions, ownership, integrations, and failure cases.

6. **Produce technical design input brief**
   - Use `references/technical-design-input-brief.md`.
   - Summarize decisions, open questions, accepted defaults, constraints, risks, and non-goals.
   - This is not an architecture document; it is input for one.

7. **Propose 内交接**
   - 澄清产物并入同一 Propose，直接作为 `prd-to-ai-architecture` 的输入；不产生独立 phase checkpoint，也不需要用户为澄清单独确认。
   - 用户要求修改澄清结果时继续本方法；PRD 需要修改时回到 `ai-structured-prd`。
   - 本方法不发独立完成信号；Propose 的最终完成信号是 `PROPOSE_READY`。

## Output options

### If critical technical clarifications remain

Output:
1. Brief PRD understanding.
2. The single highest-leverage clarification question, or a short prioritized checklist if the user asks for a full list.
3. Recommended default and severity.
4. What document should be updated after the user answers.

### If enough information exists

Output:
1. Technical Clarification Checklist.
2. Glossary and term conflicts.
3. Scenario pressure tests used.
4. Technical Design Input Brief.
5. Recommended next step: continue in the same Propose (prd-to-ai-architecture produces the tech-spec package), or return to PRD review (ai-structured-prd).

## Question format

```md
### Technical Clarification Needed

**Question**
[plain-language question the user can answer]

**Why it matters**
[what this affects in future implementation]

**Recommended default**
[concrete default]

**Severity**
Critical | Optional

**Related PRD section**
[section or requirement id]
```

## Readiness labels

- `ready for technical design`: product facts are clear enough for an AI/developer to propose an implementation.
- `mostly ready`: a few optional or low-risk assumptions remain.
- `blocked`: a missing product decision would cause the technical design to guess incorrectly.

## Reference files

- `references/tech-clarification-template.md`: load when generating clarification questions.
- `references/glossary-and-domain-checks.md`: load when resolving terminology, roles, domain concepts, or simple technical explanations.
- `references/technical-design-input-brief.md`: load when producing the final handoff brief.
