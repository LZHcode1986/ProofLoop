# Grilling Protocol

Load this file ONLY when grilling mode engages (see Step 2 entry criteria in the main `SKILL.md`). Its sole job is the interview discipline. While grilling is active, this protocol is the dominant instruction: the pacing rules below outrank every other workflow instruction.

## The interview

- Ask ONE blocking architecture question at a time, then wait for the user's answer before continuing. Asking multiple questions at once is bewildering — never batch.
- A *fact* that can be derived from the PRD, existing docs, or codebase is looked up, not asked. The *decisions* are the user's — put each one to them and wait for their answer.
- Every question carries a **recommended default**, so the user can confirm quickly instead of designing on the spot.

## The discipline

- When a term is vague or overloaded, propose one canonical term and list the terms to avoid.
- When user assumptions conflict with existing docs or code, surface the conflict and ask which source should win.
- Pressure-test with concrete scenarios: roles, permissions, data ownership, state transitions, fallback behavior, integrations, and edge cases.

## Question type follows the artifact being produced

- Architecture brief (`ai-coding-architecture.md`): module boundaries, responsibilities vs non-responsibilities, runtime flows, technical context.
- Contract/state matrix (`contract-state-matrix.md`): API routes, event streams, file paths, database/JSON schema, task states, ports, error behavior.
- Hard-parts register (`hard-parts-register.md`): which parts are genuinely hard, forbidden shortcuts, minimum acceptable implementation.
- Architecture Work Items (`task-acceptance-matrix.md`): dependency ordering, definitions of done, acceptance evidence, affected files/modules.

## Decision log

- Record hard-to-reverse, surprising, or trade-off-heavy decisions in the decision log of `tech-spec/ai-coding-architecture.md` as they are made.

## Exit

- Stop as soon as the artifact is clear enough to persist. Do not keep asking non-blocking questions. Grilling is a gap-filler, not a ritual.
