# Proposed `apply` Redesign

This document explains how to upgrade OpenSpec `apply` from "implement tasks directly" into a proof-first branch flow driven by the schema.

## Goal

- Make `apply` actually honor the dynamic `apply.instruction` from the schema.
- Enter `test-driven-development` before implementation and execute `RED -> GREEN -> REFACTOR` before coding.
- Keep `tasks.md` focused on scope and progress while `apply` controls the execution order.
- If `tasks.md` explicitly defines verifier gates, `apply` must actually invoke the independent `verifier` sub-agent at those boundaries.
- For `interactive` changes, complete the `Blocking` section's first `Proof Task` before later slice work.

## Recommended changes

1. After `openspec instructions apply --change "<name>" --json`, read the dynamic instruction.
2. Read `test-driven-development` first and only then start coding.
3. Do not treat `tasks.md` as the only source of order; it should track slices, scope, and checkboxes.
4. For `standard` changes, follow tasks in order.
5. For `interactive` changes, complete the first `Proof Task` before later slice work.
6. Each slice verifier must return an explicit `PASS` or `FAIL` before the next stage proceeds.
7. Only mark tasks done after the corresponding TDD step has been completed and verified.
8. Guardrails should explicitly forbid skipping `RED -> GREEN -> REFACTOR`.

## Recommended execution order

1. Select the change
2. Read `openspec status`
3. Read `openspec instructions apply`
4. Enter `test-driven-development` from `apply.instruction`
5. Read the context files
6. Execute implementation according to the required workflow, and insert independent verifier checks at the slice boundaries when they exist

## What to replace during migration

- the exact command names or skill names used by OpenSpec
- the project-specific implementation skill name
- the project-specific TDD skill name
- the project-specific test and verification commands

