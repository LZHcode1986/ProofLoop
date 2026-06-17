---
name: prd-to-tech-design-prep
description: prepare a non-technical, user-answerable handoff from an approved prd into later technical design. use when a prd has been confirmed and the user wants implementation preparation, technical clarification questions, glossary explanations, domain/term checks, scenario pressure tests, or a technical design input brief before architecture, task planning, or coding. does not create full architecture, database schema, api contracts, or task breakdown unless the user explicitly moves into a separate technical design workflow.
---

# prd-to-tech-design-prep

Prepare the transition from a confirmed PRD to technical design without forcing non-technical users to write architecture. Convert product facts into plain-language technical clarification questions, glossary explanations, and a clean handoff brief for a later technical design workflow.

## Use after PRD confirmation

This skill assumes a PRD or PRD Context already exists. If the user still has only a rough idea or an unreviewed PRD, use a PRD-building/review workflow first.

## Core boundaries

Do:
- Extract product facts that affect implementation.
- Ask plain-language clarification questions.
- Explain necessary technical terms simply.
- Identify domain terminology conflicts.
- Use scenario pressure tests for ambiguous roles, data visibility, permissions, fallback behavior, and integrations.
- Produce a technical design input brief that another AI or developer can use.

Do not:
- Choose a framework, database, hosting provider, architecture pattern, schema, or API contract unless the user explicitly asks to proceed into technical design.
- Turn the PRD into a task breakdown.
- Ask users to understand deep technical terms before explaining them.
- Reopen product discovery unless a product decision blocks technical design.
- Run deep architecture grilling. If the conversation moves into architecture trade-offs, framework choices, data ownership, API contracts, or state design, hand off to `prd-to-ai-architecture`.

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
5. Recommended next step: produce technical design, split stages, or return to PRD review.

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
