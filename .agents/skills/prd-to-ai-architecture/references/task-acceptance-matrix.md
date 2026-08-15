# Architecture Work Item Matrix Template

Use this file when creating `task-acceptance-matrix.md`.

## Dependency Groups

1. Setup
2. Foundational blocking work items
3. User-visible feature slices
4. Integration and polish
5. Final verification

Do not start user-visible feature slices until foundational blocking work items are complete.

## Matrix

| Work Item ID | Architecture Work Item | Depends on | Files/modules | Definition of done | Test/acceptance evidence | Forbidden shortcuts |
|---|---|---|---|---|---|---|
| AWI-001 |  |  |  |  |  |  |

## Traceability

| PRD requirement | Architecture section | Contract/state row | Work Item IDs | Acceptance evidence |
|---|---|---|---|---|

## Testing Guidance

Use the lightest evidence that genuinely proves completion:

- Unit test for pure logic.
- Contract test for API boundaries.
- Integration test for cross-module flows.
- Browser/UI test for visible workflows.
- Manual evidence only when automation is unreasonable; include exact steps.

## Gate

- [ ] Every must-have PRD requirement maps to at least one work item.
- [ ] Every work item has a definition of done.
- [ ] Every work item has acceptance evidence.
- [ ] Foundational work items are not mixed with feature polish.
- [ ] No work item says only "implement X" without files/modules and acceptance checks.
