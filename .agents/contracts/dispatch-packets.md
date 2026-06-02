# Brain Dispatch Packets

This file defines fixed packet shapes Brain uses when dispatching subagents.

Brain owns dispatch decisions.  
This file owns Brain-to-subagent packet formats.

## Rules

- Every dispatched task must include verifiable acceptance criteria.
- Preserve Brain intent and acceptance criteria verbatim.
- Keep packets bounded.
- Put detailed background in referenced files.
- If a field is unknown and necessary for execution, do not dispatch; Brain must clarify or narrow the task.

---

## Brain Dispatch Contract

Use this contract inside every Brain dispatch.

```text
Brain Dispatch Contract

Route:
- direct-task | openspec-change

Task Type:
- simple-edit | bugfix | diagnostic-edit | feature | migration | refactor | research

User Goal:
Brain Intent:
Scope:
Out of Scope:

Acceptance Criteria:
- AC-1:
- AC-2:

Verification Method:
- command:
- inspection:
- behavior check:
- manual review:

Expected Evidence:
- files changed:
- command output:
- test result:
- diff summary:
- user-loop proof:
- archive result, if applicable:

Allowed File Scope:
Forbidden File Scope:

Risk Profile:
- normal | security-sensitive | data-sensitive | migration-sensitive | concurrency-sensitive | external-integration

Required Skills:
- diagnose | test-driven-development | None

Required Review Skills:
- code-review-and-quality
- security-and-hardening
- data-migration-safety
- concurrency-correctness
- performance-regression

CodeGraph Use:
- required | optional | forbidden

CodeGraph Anchors:
- symbol:
- file:
- route:
- reason:

Stop Conditions:
- unclear requirement
- acceptance criterion not testable
- required file outside allowed scope
- behavior change larger than assigned scope
- security/data/migration risk discovered
- CodeGraph impact exceeds allowed scope
- required OpenSpec spec change discovered during direct task

Escalation Target:
- Brain
```

---

## General

Use when Brain delegates a Direct Task to `general`.

```text
Brain Dispatch: General

Brain Dispatch Contract:
  <full Brain Dispatch Contract>

Diagnostic Protocol:
- Reproduce:
- Suspected Area:
- Minimal Fix Rule:
- Regression Check:
- Stop / Upgrade Conditions:

Expected Result:
- Edit complete
- Edit blocked
- Edit failed
```

Expected completion receipt:

```text
Edit complete | Edit blocked | Edit failed

Task Type:
Skills used:
Brain Dispatch Contract:
- AC coverage:

What changed:
Files changed:
Commands run:
Verification result:
Acceptance evidence:

CodeGraph Evidence:
- status checked:
- pending sync:
- stale banner encountered:
- queries used:
- anchors:
- fallback direct reads:

Stop conditions encountered:
Upgrade required:
- yes/no
- reason:

Commit requested:
- yes/no

Residual risk:
```

---

## Direct Task Commit

Use only after Brain accepts a Direct Task and the user or Brain wants a commit.

```text
Brain Dispatch: Direct Task Commit

Boundary Type: direct-task-output
Boundary Policy: normal
Expected Receipt Type: commit
Reason:
Accepted Completion Receipt:
Allowed File Scope:
Expected Changed Paths:
Forbidden Paths:
Expected Commit Message:
```

---

## Propose

Use when Brain sends one formal OpenSpec change to `@propose`.

```text
Brain Dispatch: Propose

Brain Dispatch Contract:
  <full Brain Dispatch Contract>

PRD Path:
Existing Change:
Stage ID:
Stage Name:
Stage Objective:
Stage Boundary:
Stage Out Of Scope:
Source Files:
Confirmed Decisions:
Inferred Assumptions:
Open Questions:
Constraints:

Expected Result:
- Proposal ready
- Clarification required
- Stage repartition required
- Planning blocked
```

---

## Execute

Use when Brain sends an implementation-ready OpenSpec change to `@executor`.

```text
Brain Dispatch: Execute

Brain Dispatch Contract:
  <full Brain Dispatch Contract>

Change:
Execution Goal:
Worktree Path:
Stage ID:
Stage Name:
Relevant PRD Decisions:
Relevant Risks:
Relevant OpenSpec Artifacts:
Relevant Planning Contract Result:
Executor Dispatch Contract Source:
- .agents/contracts/executor-dispatch-packets.md

Git Boundary Policy:
- normal | audit

Expected Result:
- Execution complete
- Execution blocked
- Verification failed
```

---

## Stage Review

Use when Brain asks `@implementation-reviewer` for stage-level acceptance or archive-readiness review.

```text
Brain Dispatch: Stage Review

Brain Dispatch Contract:
  <full Brain Dispatch Contract>

Change:
Stage:
Relevant PRD Decisions:
Relevant Artifacts:
Relevant Verifier Results:
Executor Summary:
Completion Receipts:
Evidence Packets:
Slice Commits:
Residual Risks:

Expected Result:
- Stage review passed
- Stage review failed
- Stage review passed with warnings
```

---

## Archive Commit

Use after Implementation Reviewer executes archive and reports archive-output changes.

```text
Brain Dispatch: Archive Commit

Boundary Type: archive-output
Boundary Policy: normal
Expected Receipt Type: commit
Change:
Archive Result:
Dirty Paths:
Allowed File Scope:
Expected Commit Message:
```

---

## External Research

Use when Brain needs external facts before routing, PRD, scope, or acceptance decisions can be made.

```text
Brain Dispatch: External Research

Research Goal:
Question:
Why it matters:
Preferred sources:
Out of scope:
Expected output:
- findings
- source links
- recommendation
- open risks
```
