---
name: grill-me-prd
preamble-tier: 4
version: 1.0.0
description: |
  Review structured PRD context by extracting what is already decided, identifying only
  consequential unknowns, recommending defaults, and asking the single highest-leverage
  clarification question needed before Brain forms a verifiable Dispatch Contract.
---

# grill-me-prd

Review structured PRD context to help Brain clarify or narrow before dispatch.

## Modes

### Intake clarification mode

Use when Brain has structured PRD context but the PRD is not finalized.

Structured PRD context may include:
- intake decision ledger
- draft PRD
- CLARIFY.md
- structured planning brief
- workflow-intake organized conversation context

Goal:
- select the single highest-leverage clarification question before Brain forms a final Dispatch Contract.

### PRD review mode

Use when a stable PRD, spec, RFC, proposal, or planning doc already exists.

Goal:
- assess execution readiness and identify remaining critical or optional gaps.

## When to use

Use this skill when:
- Brain has structured PRD context, even if not finalized;
- the goal is targeted clarification, not open-ended discovery;
- the question concerns gaps, contradictions, risky assumptions, or unresolved decisions;
- the result may affect scope, UX, data model, API, permissions, rollout, metrics, or acceptance criteria.

## When not to use

Do not use this skill when:
- there is no structured context at all;
- the user is still in unconstrained brainstorming and workflow-intake has not extracted a ledger;
- the user wants broad ideation rather than execution-oriented clarification;
- Brain already has enough information to form a verifiable Dispatch Contract.

## Core behavior

You are not here to interrogate endlessly.

You are here to:
1. Extract what structured PRD context already answers.
2. Infer what is strongly implied.
3. Identify only unresolved questions that materially affect delivery or correctness.
4. Ask the fewest questions necessary.
5. Recommend a concrete default.
6. Stop as soon as critical gaps are resolved.

Default stance:
- read before asking;
- infer before re-asking;
- recommend defaults;
- ask one question at a time;
- stop early.

## Domain Context Checks

When structured PRD context contains domain terminology, code/docs references, architectural boundaries, or durable decisions, apply:

`references/domain-context-checks.md`

Use these checks only to select the next highest-leverage clarification question.

Do not turn the session into broad domain modeling.
Do not write CONTEXT.md, ADR, CLARIFY.md, PRD.md, or OpenSpec artifacts directly.

## Output behavior

When asking a question, use the format in:

`references/output-formats.md`

When no critical question remains, output the final review format in:

`references/output-formats.md`

Examples are in:

`references/examples.md`

## Persistence boundary

This skill does not persist decisions to files.

If clarification affects Brain Dispatch Contract readiness, Brain should dispatch `@general` with a bounded update task, such as updating `CLARIFY.md`.

Do not write files directly from this skill.
