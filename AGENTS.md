# ProofLoop Global Rules

This file is loaded by every agent. Keep it short and global.

Detailed role behavior belongs in `.opencode/agents/*.md`.  
Packet formats live under `.agents/contracts/`:
- Brain dispatch packet formats live under `.agents/contracts/brain/`.
- Executor subagent packet formats live under `.agents/contracts/executor/`.  
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
      -> General archive execution
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

General performs archive execution only after Brain authorizes archive.

Brain does not run archive directly.  
General does not commit archive output.

## Dispatch Contract Loading Rule

Agents must not browse `.agents/contracts/` as a runtime index.

Each dispatch flow must name the exact contract file or file set it may read.

Parent agents are responsible for reading the relevant contract file, constructing the completed packet, and sending that packet to the target agent.

Target agents must validate the packet they receive and must not load unrelated contract files to compensate for missing dispatch context.
