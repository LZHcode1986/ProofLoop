---
name: workflow-intake
description: Turn an unstructured user request into a PRD draft and decision ledger before formal OpenSpec planning.
license: MIT
compatibility: opencode
metadata:
  author: proofloop
  version: "1.0"
---

# Workflow Intake

Turn raw user intent into a stable PRD draft that a Brain agent can own before handing work to formal OpenSpec planning.

## When to use

Use this skill when:
- the user has an idea, bug, initiative, migration, or change request
- there is no stable `PRD.md` yet
- requirements are scattered across chat, docs, issues, screenshots, or code
- you need enough structure to decide whether formal planning should start

## When not to use

Do not use this skill when:
- a solid PRD already exists and only needs gap review; use `grill-me-prd`
- the user already has a stable planning brief and wants formal OpenSpec artifacts now
- the task is pure implementation without product-definition work

## Core behavior

You are not generating design, tasks, or code.

You are here to:

1. Read the available context first.
2. Extract the actual problem, user, goal, and constraints.
3. Draft explicit acceptance criteria that downstream planning and execution can preserve.
4. Partition the PRD into stage candidates before formal planning starts.
5. Build a decision ledger with `Confirmed`, `Inferred`, and `Open` items.
6. Ask only the minimum consequential questions needed to draft a responsible PRD.
7. Produce or refresh a PRD that is ready for a later `grill-me-prd` review.

## Operating principles

### 1. Prefer reading over asking

Before asking the user anything, inspect the available context:
- current conversation
- existing docs, issues, or planning notes
- repository structure and obvious architecture cues
- screenshots, tables, or linked materials when available

Do not ask for information that is already present or can be inferred with low risk.

### 2. Maintain a decision ledger

Keep an internal ledger with these buckets:
- `Confirmed`: explicitly stated in context
- `Inferred`: strongly implied and low-risk to assume
- `Open`: truly unresolved and consequential

Only ask about an `Open` item when the answer would materially affect:
- scope
- user workflow
- architecture boundary
- API or data model
- permissions or security
- rollout or migration
- success criteria

### 3. Ask minimally

Ask at most one consequential question at a time.

Every question should include:
- why it matters
- your recommended default

Do not run a broad discovery interview when a reasonable default and one focused question would move the work forward.

### 4. Draft for execution readiness

The PRD does not need to capture every conceivable edge case.
It needs to be stable enough that a later planning step can produce proposal, design, specs, and tasks without guessing the product intent.

### 5. Partition by stage, not by the whole PRD

Before formal planning starts, break the PRD into stage candidates.

Each stage should:
- deliver one independently valuable function or module boundary
- keep acceptance criteria coherent
- minimize change amplification
- respect information hiding
- avoid mixing unrelated modules or capabilities

Follow the repository's root `AGENTS.md` as the operational source for stage quality rules.

## Intake workflow

### Step 1: Parse the request

Identify:
- the core problem
- the target user or operator
- the desired outcome
- the acceptance criteria that would prove the outcome is complete
- the likely stage boundaries that could deliver the outcome in independent increments
- any obvious constraints, non-goals, or deadlines

### Step 2: Read nearby context

Inspect the most relevant repository and document context needed to understand:
- current behavior
- likely authority sources
- terminology already used by the project
- adjacent constraints that would shape a PRD

### Step 3: Build the ledger

Sort what you know into:
- `Confirmed`
- `Inferred`
- `Open`

### Step 4: Ask the best next question only if needed

Ask only the highest-leverage unresolved question.
If the remaining uncertainty is minor or low-risk, proceed with clearly labeled assumptions.

### Step 5: Draft or refresh `PRD.md`

Write a PRD that captures the stable product definition.

Use this structure:

```md
# PRD

## Objective
## Problem
## Target Users
## Goals
## Non-Goals
## Primary User Loop
## Acceptance Criteria
## Stage Plan
## Constraints
## Authority Sources
## Functional Requirements
## Risks and Edge Cases
## Success Metrics
## Open Questions
## Recommended Next Step
```

### Step 6: Report readiness

After drafting the PRD, state whether it is:
- `Ready for grill-me-prd`
- `Needs one more clarification`
- `Blocked by critical unknowns`

The PRD should expose acceptance criteria clearly enough that Brain can pass them to planning or execution subagents without rewriting them.
The PRD should also expose stage boundaries clearly enough that Brain can dispatch one stage at a time to `@propose`.

## Output expectations

When you finish intake, provide:
- PRD readiness status
- the main `Confirmed` decisions
- the main `Inferred` assumptions
- the acceptance criteria that should remain immutable downstream
- the proposed stage plan
- remaining `Open` questions, if any
- the recommended next step

## Tone

- Be concise.
- Prefer defaults over questionnaires.
- Optimize for a draft that can move into formal planning.