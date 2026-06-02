# ProofLoop Skill Usage Overlay

This document defines how ProofLoop agents use canonical and shared skills.

It does not replace or modify the skill files themselves.

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
openspec/QUALITY-GATE.md
openspec/schemas/proofloop-spec-driven/**
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
