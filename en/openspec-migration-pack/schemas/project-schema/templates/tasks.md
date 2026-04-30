# Non-goal Reminder

<!-- State what is not included in this change to prevent scope drift during task decomposition. -->

## Recommended MVP Scope

<!-- State the smallest deliverable slice that still forms a closed loop. -->

## File Scope

<!-- List the files or directories that are expected to change. -->

## Dependencies

<!-- List dependencies between tasks or slices. -->

## Parallel Opportunities

<!-- List tasks or task groups that can be done in parallel. -->

## Task Order

<!-- Keep the five-stage structure: Setup, Blocking, Slice 1..N, Reconciliation. -->

### Implementation Constraints

- When entering `apply`, execute `test-driven-development` first and follow `RED -> GREEN -> REFACTOR`.
- `tasks.md` is only for scope breakdown and progress tracking; do not repeat the full TDD details here.
- If the change is `interactive`, the first item in `Blocking` must be `Proof Task`.
- If `tasks.md` explicitly defines implementation-slice verifier gates, you must actually invoke the independent `verifier` sub-agent.
- Each slice verifier must state the inspection scope, what the verifier must check, and the `PASS/FAIL` gate conditions.

## 1. Setup

<!-- Project initialization, context prep, and required asset synchronization. -->

- [ ] 1.1 <task-description>
  - **Files:** <file-paths>
  - **Verification:** <verification-command>
- [ ] 1.2 <task-description>
  - **Files:** <file-paths>
  - **Verification:** <verification-command>

## 2. Blocking

<!-- Shared prerequisites for all slices; do not proceed before these are complete. -->

- [ ] 2.1 <task-description>
  - **Files:** <file-paths>
  - **Verification:** <verification-command>

## 3. Slice 1: <slice-name>

### Slice Goal

<!-- Explain what the user or system can do independently when this slice is complete. -->

### Independent Acceptance Criteria

<!-- Explain how to verify the slice without depending on later slices. -->

- [ ] 3.1 [Slice-1] <task-description>
  - **Files:** <file-paths>
  - **Verification:** <verification-command>
- [ ] 3.2 [P] [Slice-1] <task-description>
  - **Files:** <file-paths>
  - **Verification:** <verification-command>
- [ ] 3.3 [Slice-1] <Slice 1 verifier>
  - **Files:** <change-artifacts, Slice 1 implementation, Slice 1 tests, verification results>
  - **Verification:** independent `verifier` sub-agent check
  - **Inspection Scope:** <Slice 1 change artifacts + related implementation + related tests + validation results>
  - **PASS/FAIL Gate:** <conditions for pass/fail>

## 4. Slice 2: <slice-name>

### Slice Goal

<!-- Explain what the user or system can do independently when this slice is complete. -->

### Independent Acceptance Criteria

<!-- Explain how to verify the slice without depending on later slices. -->

- [ ] 4.1 [Slice-2] <task-description>
  - **Files:** <file-paths>
  - **Verification:** <verification-command>
- [ ] 4.2 [Slice-2] <Slice 2 verifier>
  - **Files:** <change-artifacts, Slice 2 implementation, Slice 2 tests, verification results>
  - **Verification:** independent `verifier` sub-agent check
  - **Inspection Scope:** <Slice 2 change artifacts + related implementation + related tests + validation results>
  - **PASS/FAIL Gate:** <conditions for pass/fail>

## N. More Slices (as needed)

<!-- If the closed loop needs more capability slices, continue adding `Slice 3`, `Slice 4`, ... `Slice N` with the same structure. -->

- Every added slice must include:
  - a slice goal
  - independent acceptance criteria
  - at least one implementation task
  - an explicit `verifier` task
- Slice numbering must stay consecutive, and the previous slice's `verifier PASS` must be reached before the next slice begins.

## 5. Reconciliation

<!-- Wrap-up items, cross-cutting governance, docs, regression, compatibility, observability, etc. -->

- [ ] 5.1 <task-description>
  - **Files:** <file-paths>
  - **Verification:** <verification-command>

## Readiness Gate

<!-- Unified checks before entering apply. -->
- [ ] File scope is explicit
- [ ] MVP scope is explicit
- [ ] Blocking tasks are separated
- [ ] Every slice has a slice goal
- [ ] Every slice has independent acceptance criteria
- [ ] Parallel opportunities are marked
- [ ] Task order is coherent
- [ ] Every implementation slice explicitly includes an independent `verifier` sub-agent check
- [ ] Each `verifier` task clearly states inspection scope and `PASS/FAIL` gate
- [ ] Each slice verifier must pass before entering the next slice
- [ ] The final slice verifier must pass before entering `Reconciliation`
- [ ] Every step has a verification command
- [ ] Task items preserve the `1.1 / 1.2` style and support `[P]` and `[Slice-X]` labels
- [ ] Task granularity is detailed enough that the implementer does not need to guess

