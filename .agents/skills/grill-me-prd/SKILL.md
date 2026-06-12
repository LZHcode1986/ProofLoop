---
name: grill-me-prd
preamble-tier: 4
version: 1.0.0
description: |
  Review structured PRD context by extracting what is already decided, identifying only
  the consequential unknowns, and asking the minimum number of clarifying questions
  needed to de-risk execution.
---

\# grill-me-prd

# grill-me-prd

Review structured PRD context by extracting what is already decided, identifying only the consequential unknowns, and asking the minimum number of clarifying questions needed to de-risk execution.

## Modes

### Intake clarification mode

Use this mode when Brain has structured PRD context but the PRD is not finalized.

Structured PRD context may include:
- intake decision ledger
- draft PRD
- CLARIFY.md
- structured planning brief
- workflow-intake organized conversation context

The goal is to select the single highest-leverage clarification question before Brain forms a final Dispatch Contract.

### PRD review mode

Use this mode when a stable PRD, spec, RFC, proposal, or planning doc already exists.

The goal is to assess execution readiness and identify remaining critical or optional gaps.

## When to use

Use this skill when:

- Brain has structured PRD context, even if it is not finalized.
- The goal is to find gaps, contradictions, risky assumptions, or unresolved decisions.
- Brain needs targeted clarification, not open-ended discovery.
- The assistant has access to PRD text, draft PRD, intake ledger, CLARIFY.md, linked documents, or surrounding context.

## When not to use

Do not use this skill when:

- There is no structured context at all.
- The user is in unconstrained brainstorming and workflow-intake has not yet extracted a ledger.
- The user wants broad ideation rather than execution-oriented clarification.

## Core behavior

You are not here to interrogate endlessly.

You are here to:

1. Extract what the PRD already answers.
2. Infer what is strongly implied.
3. Identify only the unresolved questions that would materially affect delivery or correctness.
4. Ask the fewest questions necessary.
5. Stop as soon as the critical gaps are resolved.

Your default stance is:

- Prefer reading over asking.
- Prefer inferring over re-asking.
- Prefer proposing a recommendation over dumping uncertainty back on the user.
- Prefer shipping a concise gap analysis over running an unbounded interview.

## Operating principles

### 1) Treat the structured PRD context as the primary source of truth

Before asking anything, carefully review the structured PRD context and any available supporting context.

Extract:

- explicit decisions
- constraints
- goals
- non-goals
- assumptions
- dependencies
- rollout details
- metrics
- unresolved placeholders
- contradictions or ambiguities

Do not ask about anything already stated clearly.

### 2) Maintain a resolved-decisions ledger

Continuously maintain an internal ledger with three buckets:

- **Confirmed**: explicitly stated in the PRD or supporting context
- **Inferred**: not stated verbatim, but strongly implied and low-risk to assume
- **Open**: genuinely unresolved and consequential

Before asking any question, check whether it is already answerable from the ledger.

Never ask about items already in Confirmed.

Only ask about an Inferred item if:

- the inference is risky,
- the PRD is contradictory,
- or the answer would materially change scope, UX, architecture, security, rollout, or measurement.

### 3) Only ask consequential questions

A question is worth asking only if the answer could materially change one or more of:

- product scope
- user experience or workflow
- API or data model
- permissions, privacy, or security
- operational rollout or migration
- dependencies or ownership
- success metrics or decision criteria
- failure handling or fallback behavior

Avoid cosmetic, speculative, or low-leverage questions.

### 4) Ask one question at a time

Ask at most one question per turn.

Do not batch questions.

Do not produce long questionnaires.

### 5) Every question must include a recommendation

Whenever you ask a question, include:

- **Why it matters**
- **Recommended default**
- **Severity**: `Critical` or `Optional`

This reduces back-and-forth and gives the user a fast path to confirm.

### 6) Enforce a question budget

Default maximums:

- **Critical questions**: 10
- **Optional questions**: 5

Do not exceed the budget unless the user explicitly asks for a deeper audit.

If you hit the budget, stop asking and provide the best gap analysis possible with assumptions clearly labeled.

### 7) Stop early

Stop asking questions as soon as:

- no critical unknowns remain, or
- remaining unknowns are optional and non-blocking, or
- the PRD is already sufficiently actionable with clearly labeled assumptions

Do not continue asking questions just because more questions are possible.

### 8) Never ask for information already available

If the answer can be derived from:

- the PRD
- prior messages
- linked docs
- code context
- screenshots
- tables
- earlier answers in the same session

then do not ask the user to restate it.

Instead, state the answer and label it as Confirmed or Inferred.

### 9) Surface contradictions explicitly

If the PRD appears inconsistent, do not ask a vague question.

Instead:

- quote or summarize the conflicting points
- explain why they conflict
- ask for a decision only on the exact conflict

### 10) Prefer execution readiness over completeness theater

Your job is not to exhaust every conceivable branch.

Your job is to determine whether the PRD is ready enough to execute responsibly.

## Review workflow

Follow this sequence:

### Step 1: Parse the PRD

Read the PRD carefully and identify:

- problem statement
- target user
- goals
- non-goals
- key flows
- edge cases
- success metrics
- rollout plan
- dependencies
- technical implications
- legal/privacy/security implications
- unresolved placeholders

### Step 2: Build the ledger

Create an internal ledger with:

- Confirmed
- Inferred
- Open

### Step 3: Assess execution readiness

Determine whether the PRD is:

- **Ready**
- **Mostly ready with minor gaps**
- **Blocked by critical unknowns**

### Step 4: Ask only the highest-leverage open question

Select the single most consequential unresolved question.

For that question, provide:

- `Question`
- `Why it matters`
- `Recommended default`
- `Severity`

### Step 5: Update the ledger after each answer

When the user responds:

- move the item to Confirmed
- update related assumptions
- reassess whether more critical gaps remain

### Step 6: Stop and summarize

When no more critical questions remain, stop and output the final review.

## Preferred question format

Use this exact structure when asking a question:

### Clarification Needed

**Question**  
[one precise question]

**Why it matters**  
[one to three sentences on what this affects]

**Recommended default**  
[a concrete recommendation, not a vague possibility list]

**Severity**  
`Critical` or `Optional`

Keep it tight.

## Final output format

In `Intake clarification mode`, if critical gaps remain, ask only the single highest-leverage next question. Do not output a final PRD Gap Review unless the user asks for a review or no critical question remains.

When you stop asking questions, output the review in this structure:

\# PRD Gap Review



\## 1. Execution readiness

One of:

\- Ready

\- Mostly ready with minor gaps

\- Blocked by critical unknowns



Include a short explanation.



\## 2. Confirmed decisions

Bullet list of decisions explicitly stated in the PRD or confirmed by the user.



\## 3. Inferred decisions

Bullet list of strong inferences the team can likely proceed with.

Mark these clearly as inferred assumptions.



\## 4. Critical gaps

Bullet list of unresolved issues that must be answered before execution.

If none, say `None`.



\## 5. Optional follow-ups

Bullet list of non-blocking questions or improvements.

If none, say `None`.



\## 6. Contradictions or risks

Bullet list of internal inconsistencies, risky assumptions, or rollout concerns.

If none, say `None`.



\## 7. Recommended next step

A concise recommendation for what to do next, such as:

\- begin implementation

\- revise the PRD in specific sections

\- align with engineering/security/data teams

\- define rollout metrics

\- confirm ownership and dependencies



\## Decision rules



\### Ask a question if:

\- the answer is missing

\- the answer is consequential

\- the answer cannot be reliably inferred

\- the answer would change implementation or approval



\### Do not ask a question if:

\- the PRD already answers it

\- prior conversation already answers it

\- the answer can be inferred with low risk

\- it is merely “nice to know”

\- it does not change scope, correctness, or execution



\## High-value gap categories



Prioritize questions in roughly this order:



1\. \*\*Scope and non-goals\*\*

2\. \*\*Primary user and core workflow\*\*

3\. \*\*Success metrics and decision criteria\*\*

4\. \*\*Data model, API contract, and source of truth\*\*

5\. \*\*Permissions, privacy, security, and compliance\*\*

6\. \*\*Failure cases, edge cases, and fallback behavior\*\*

7\. \*\*Dependencies, owners, and rollout sequencing\*\*

8\. \*\*Migration, backward compatibility, and support\*\*

9\. \*\*Observability and post-launch monitoring\*\*

10\. \*\*Nice-to-have polish items\*\*



\## Tone and style



\- Be concise.

\- Be sharp.

\- Be execution-oriented.

\- Do not praise the PRD excessively.

\- Do not generate filler questions.

\- Do not ask the user to repeat what is already written.

\- Do not turn the interaction into a 50-question interview.

\- Default toward progress.



\## Example opening behavior



Given a PRD, do \*\*not\*\* immediately start asking questions.



Instead, first reason through:



\- what is already decided

\- what is inferable

\- what is truly open

\- what is critical versus optional



Then ask only the single best next question.



\## Example of good behavior



Good:

\- “The PRD already defines the target user, rollout scope, and success metric. The main unresolved issue is whether existing permissions inherit by workspace or must be explicitly assigned per project.”



Bad:

\- “Who is the user?”

\- “What is the metric?”

\- “How will rollout work?”

\- “Are there dependencies?”

when all of those are already covered in the PRD.



\## Example invocation



Use this skill when the user says things like:



\- “Review this PRD and tell me what still needs clarification.”

\- “What important questions are still unanswered in this spec?”

\- “Don’t brainstorm from scratch. Just find the gaps.”

\- “Assume the PRD is mostly done. Only ask me what is truly missing.”



\## Default behavior summary



In one sentence:



\*\*Read first, infer aggressively, ask minimally, recommend defaults, and stop once the PRD is executable.\*\*

