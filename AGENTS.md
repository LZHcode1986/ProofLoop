# ProofLoop Global Rules

This file is loaded by every agent. Keep it short and global.

Detailed role behavior belongs in `.opencode/agents/*.md`.  
Packet formats belong in `.agents/contracts/*.md`.  
OpenSpec artifact rules belong in `openspec/**`.  
Reusable procedures belong in `.agents/skills/**`.

## Mission

ProofLoop ensures that agent work matches Brain and user intent.

Every Brain-dispatched task must be verifiable.  
Every subagent must execute mechanically.  
Every result must return evidence that Brain can use for acceptance.

## Authority order

1. User instruction
2. Brain Dispatch Contract
3. OpenSpec artifacts for formal changes
4. Agent-specific instructions
5. Skills
6. Local conventions

If authority conflicts, stop and return to Brain.

## Routing

Brain chooses one route:

```text
direct-task
openspec-change
```

No active workflow should use `P0 / P1 / P2` as routing levels.

## Direct Task

```text
Brain -> general -> Completion Receipt -> Brain self-check
```

Direct Task does not automatically commit.

## OpenSpec Change

```text
Brain -> Evidence Ledger Seed
      -> Propose
      -> Planning Contract Verifier
      -> Executor
      -> Implementation Reviewer
      -> Brain archive authorization
      -> Implementation Reviewer archive execution
      -> Committer archive-output if needed
```

Executor-owned internals:

```text
- Worker
- Committer task-diff-snapshot
- Code Verifier per slice
- Committer slice-output
```

## Required dispatch contract

Every Brain dispatch must include verifiable acceptance criteria.

Minimum required fields:

```text
Route
Task Type
User Goal
Brain Intent
Scope
Out of Scope
Acceptance Criteria
Verification Method
Expected Evidence
Allowed File Scope
Forbidden File Scope
Risk Profile
Required Skills
Required Review Skills
CodeGraph Use
CodeGraph Anchors
Stop Conditions
Escalation Target
```

For openspec-change:

```text
Evidence Ledger Seed
```

If a task cannot be made verifiable, Brain must clarify or narrow before dispatch.

## Canonical skills

Do not rewrite OpenSpec canonical skills or shared TDD skill as part of ProofLoop flow changes.

ProofLoop usage constraints belong in:

```text
.agents/contracts/proofloop-skill-usage.md
.opencode/agents/*.md
```

## Mechanical subagent rule

Subagents must not reinterpret Brain intent.

They must stop and return to Brain when:

- acceptance criteria are unclear or not testable
- required scope exceeds allowed scope
- required code reality cannot be established
- CodeGraph impact exceeds allowed scope
- the task requires an OpenSpec change not included in the route
- security/data/migration/concurrency risk exceeds the contract

## Verification rule

Do not treat document debt as implementation failure.

Use correct categories:

```text
IMPLEMENTATION DEFECT
EVIDENCE DEFECT
CONTRACT DEFECT
PROTOCOL DEFECT
```

## Slice verification rule

For OpenSpec changes:

- every implementation slice must have Code Verifier
- do not verify every task unless explicitly required
- commit after slice verification passes, not after every task

## CodeGraph rule

CodeGraph is a tool, not an agent.

Use `.agents/contracts/codegraph-tool-protocol.md`.

## Committer rule

Committer closes or records git boundaries. It does not decide task completion.

Default:

```text
task -> task-diff-snapshot receipt
slice verifier PASS -> slice-output commit
archive output -> archive-output commit
```

## Archive rule

Implementation Reviewer performs archive execution only after Brain authorizes archive.

Brain does not run archive directly.  
Implementation Reviewer does not commit archive output.
