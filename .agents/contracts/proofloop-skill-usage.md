# ProofLoop Skill Usage Overlay

This document defines how ProofLoop agents use canonical and shared skills.

It does not replace or modify the skill files themselves.

## Canonical Skill Substrate Rule

Canonical OpenSpec skills are substrate only.

The following skills MUST remain official or near-official:

```text
.agents/skills/openspec-propose/SKILL.md
.agents/skills/openspec-apply-change/SKILL.md
.agents/skills/openspec-archive-change/SKILL.md
```

They do not own ProofLoop-specific governance rules.

ProofLoop authority lives in:

```text
.opencode/agents/*.md
.agents/contracts/*.md
openspec/schemas/proofloop-spec-driven/**
openspec/config.yaml
```

Future rule changes MUST only modify the ProofLoop layer, NOT the canonical skills.

## Do not overwrite canonical skills

ProofLoop flow changes must not directly rewrite:

```text
.agents/skills/openspec-propose/SKILL.md
.agents/skills/openspec-apply-change/SKILL.md
.agents/skills/openspec-archive-change/SKILL.md
```

These are OpenSpec canonical skills.

ProofLoop constraints belong in:

```text
.opencode/agents/*.md
.agents/contracts/*.md
openspec/schemas/proofloop-spec-driven/**
openspec/config.yaml
```

## Do not overwrite shared TDD skill

ProofLoop flow changes must not directly rewrite:

```text
.agents/skills/test-driven-development/SKILL.md
```

Worker-specific non-interactive behavior belongs in:

```text
.opencode/agents/worker.md
```

and this overlay.

## Propose using openspec-propose

When `@propose` loads `openspec-propose`:

- Preserve the Brain Dispatch Contract.
- Preserve Brain acceptance criteria.
- Generate OpenSpec artifacts through official OpenSpec behavior.
- Add ProofLoop-specific constraints through schema templates and agent instructions.
- After artifact generation, dispatch `planning-contract-verifier`.
- Do not dispatch `spec-verifier` as active role.
- Do not dispatch `reality-verifier`; use CodeGraph Tool Protocol when code reality is needed.

## Executor using openspec-apply-change

When `@executor` loads `openspec-apply-change`:

- Treat the skill as OpenSpec apply substrate.
- Use `.agents/contracts/executor-dispatch-packets.md` for subagent dispatch.
- Do not implement code directly.
- Dispatch Worker for tasks.
- Dispatch Committer for `task-diff-snapshot` after Worker task completion.
- Dispatch Code Verifier at slice gates.
- Dispatch Committer for `slice-output` only after slice verifier PASS.
- Return contract, evidence, or protocol blockers to Brain.

## Implementation Reviewer using openspec-archive-change

When `@implementation-reviewer` loads `openspec-archive-change`:

- Only do so after Brain authorizes archive.
- Execute official OpenSpec archive behavior.
- Do not commit archive output.
- Return archive result and whether archive-output boundary is needed.

## Worker using test-driven-development

When `@worker` loads `test-driven-development`:

- Do not ask the user directly.
- Treat Brain Dispatch Contract, Task Contract, Slice Contract, and Acceptance Criteria as the approved behavior scope.
- If the behavior or verification target is not testable, return `Implementation blocked`.
- Do not invent product behavior to make TDD possible.
- Return TDD evidence in the Worker Completion Receipt.

## general using diagnose

When `general` handles a Direct Task bugfix:

- Use `diagnose` when requested by Brain.
- Reproduce or characterize the bug.
- Identify root cause.
- Apply minimal fix.
- Run regression or verification.
- Return Completion Receipt.
- If the fix requires requirement/spec/user contract changes, return `Upgrade required: yes`.

## Brain using workflow-intake

When Brain cannot form a verifiable Brain Dispatch Contract from the user's current request because product intent, scope, acceptance criteria, or stage boundaries are still unclear, Brain uses `workflow-intake` as the default clarify-or-narrow procedure.

Use `workflow-intake` when:
- the user presents an idea, bug, initiative, migration, feature, or behavior change;
- no stable PRD or stable planning brief exists;
- requirements are scattered across chat, docs, issues, screenshots, or code;
- Brain cannot produce verifiable acceptance criteria without product-definition work.

Do not treat `workflow-intake` as a new route.
It is Brain-owned pre-dispatch clarification.

Minimum evidence:
- PRD / intake readiness status
- Confirmed decisions
- Inferred assumptions
- Decided During Intake
- Acceptance Criteria
- Stage candidates
- Remaining Open Questions
- Recommended next step

## Brain using grill-me-prd

When Brain has structured PRD context but consequential unknowns remain, Brain uses `grill-me-prd` to identify the single highest-leverage clarification question.

Structured PRD context may include:
- PRD.md
- draft PRD
- intake decision ledger
- CLARIFY.md
- structured planning brief
- workflow-intake organized conversation context

Use `grill-me-prd` during clarification.
Do not wait until PRD.md is finalized.

Minimum evidence:
- Confirmed decisions
- Inferred decisions
- Critical gaps
- Optional gaps
- recommended default for the next question
- readiness assessment

## Skill Evidence Rule (R3)

A required skill name alone is not evidence. The agent output must include structured evidence produced by that skill.

Minimum evidence format per skill:

```text
diagnose:
- symptom reproduced or characterized:
- suspected area:
- root cause:
- minimal fix:
- regression check:

test-driven-development:
- RED:
- GREEN:
- REFACTOR:
- deviation / not applicable reason:

code-review-and-quality:
- contract alignment:
- implementation risks:
- evidence gaps:
- residual risk:

security-and-hardening / data-migration-safety / concurrency-correctness / performance-regression:
- reviewed scope:
- findings:
- evidence:
- residual risk:
```
