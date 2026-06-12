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
7. Produce or refresh structured PRD context that lets Brain form a verifiable Brain Dispatch Contract.

## Operating principles

### 1. Prefer reading over asking

Before asking the user anything, inspect the available context:
- current conversation
- existing docs, issues, or planning notes
- repository structure and obvious architecture cues
- screenshots, tables, or linked materials when available

Do not ask for information that is already present or can be inferred with low risk.

### 2. Maintain a decision ledger

Keep a decision ledger with these buckets:
- `Confirmed`: explicitly stated in context
- `Inferred`: strongly implied and low-risk to assume
- `Decided During Intake`: resolved in the clarification loop
- `Optional / Non-blocking follow-up`: open but not blocking a responsible PRD
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

Extract from the user's description:

- the core problem
- who is affected (target user or operator)
- current pain points
- the desired outcome
- any rough solution ideas the user mentions
- the acceptance criteria that would prove the outcome is complete
- the likely stage boundaries that could deliver the outcome in independent increments
- any obvious constraints, non-goals, or deadlines

If the user's description is thin, ask them to elaborate on:
- the problem and who it affects
- current pain points
- a rough idea of the solution
- what success looks like

Record rough solution ideas in the decision ledger:
- `Confirmed`: when explicitly stated by the user as a proposed idea
- `Inferred`: when implied from context

In both cases, mark them as exploration anchors, not binding design decisions.

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
- `Decided During Intake`
- `Optional / Non-blocking follow-up`
- `Open`

### Step 4: Consequential Clarification Loop

Ask at most one consequential question at a time.

After the intake ledger or draft PRD context exists, use `grill-me-prd` to select the single highest-leverage unresolved question when:
- more than one consequential Open item exists;
- there is a scope, workflow, architecture, data, security, rollout, or success-metric ambiguity;
- Brain needs to decide whether the PRD context is ready for dispatch.

Do not ask broad questionnaires.

Do not defer consequential unknowns to a later PRD review.
Resolve them now or label the assumption explicitly for Brain acceptance.

### Step 5: Draft or refresh `PRD.md`

Create or update `PRD.md` at the repository root.

When updating an existing `PRD.md`:
- preserve existing `Confirmed` decisions and acceptance criteria
- do not silently delete sections that still apply
- merge new findings into existing sections
- mark newly added content with the source (e.g., from clarification loop, from codebase exploration)

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
## Rollout / Migration
## Legal / Privacy / Security
## Success Metrics
## Decision Ledger

### Confirmed
### Inferred
### Decided During Intake
### Optional / Non-blocking follow-up

## Open Questions
## Recommended Next Step
```

### Step 6: Report readiness

After drafting the PRD, state whether it is:
- `Ready for Brain Dispatch Contract`
- `Needs one more clarification`
- `Blocked by critical unknowns`

The PRD should expose acceptance criteria clearly enough that Brain can pass them to planning or execution subagents without rewriting them.
The PRD should also expose stage boundaries clearly enough that Brain can dispatch one stage at a time to `@propose`.

## Output expectations

When you finish intake, provide:
- PRD readiness status
- the main `Confirmed` decisions
- the main `Inferred` assumptions
- the main `Decided During Intake` items
- the acceptance criteria that should remain immutable downstream
- the proposed stage plan
- `Optional / Non-blocking follow-up` items, if any
- remaining `Open` questions, if any
- the recommended next step

## Tone

- Be concise.
- Prefer defaults over questionnaires.
- Optimize for a draft that can move into formal planning.