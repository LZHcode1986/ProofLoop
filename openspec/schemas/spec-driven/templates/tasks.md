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

## Stage Acceptance Coverage Map

<!-- Map each Brain-supplied Stage Acceptance Criterion to the slice verifier gate or reconciliation check that proves it. -->

| Stage Acceptance Criterion | Covered By | Evidence / Gate |
| --- | --- | --- |
| <criterion> | <Slice 1 verifier / Reconciliation task> | <slice acceptance criterion, verification command, or PASS/FAIL gate> |

## Task Order

<!-- Keep the five-stage structure: Setup, Blocking, Slice 1..N, Reconciliation. -->

### Implementation Constraints

- Code-changing tasks must use `test-driven-development` and follow `RED -> GREEN -> REFACTOR`.
- Each code-changing slice must list TDD test files, `RED Verification` (pytest, expected fail), and `GREEN Verification` (pytest, expected pass). `GREEN Verification` targets the TDD test suite for the current slice; the task-level `Verification` field covers additional artifact checks (smoke, grep, import sanity) beyond TDD.
- Non-code tasks (read-only diagnostic runs, docs-only, config-only) omit TDD fields or write `N/A`. Do not invent TDD artifacts for tasks that don't change production or executable code.
- The verifier's inspection scope must include the TDD test files declared for that slice.
- If the change is `interactive`, the first item in `Blocking` must be `Proof Task`.
- If `tasks.md` explicitly defines implementation-slice verifier gates, you must actually invoke the independent `verifier` sub-agent.
- Each slice verifier must state the inspection scope, what the verifier must check, and the `PASS/FAIL` gate conditions.

## 1. Setup

<!-- Project initialization, context prep, and required asset synchronization. -->

- [ ] 1.1 <task-description>
  - **Files:** <file-paths>
  - **Allowed File Scope:** <file-paths>
  - **Boundary Receipt Required:** no-op allowed
  - **Verification:** <verification-command>
- [ ] 1.2 <task-description>
  - **Files:** <file-paths>
  - **Allowed File Scope:** <file-paths>
  - **Boundary Receipt Required:** no-op allowed
  - **Verification:** <verification-command>

## 2. Blocking

<!-- Shared prerequisites for all slices; do not proceed before these are complete. -->

- [ ] 2.1 <task-description>
  - **Files:** <file-paths>
  - **Allowed File Scope:** <file-paths>
  - **Boundary Receipt Required:** no-op allowed
  - **Verification:** <verification-command>

## 3. Slice 1: <slice-name>

### Slice Goal

<!-- Explain what the user or system can do independently when this slice is complete. -->

### Independent Acceptance Criteria

<!-- Explain how to verify the slice without depending on later slices. -->

- [ ] 3.1 [Slice-1] <task-description>
  - **Files:** <file-paths>
  - **Allowed File Scope:** <file-paths>
  - **Boundary Receipt Required:** yes | no-op allowed
  - **TDD Test Files:** <test-file-paths>  *(required if code-changing)*
  - **RED Verification:** <pytest command, expected to fail>  *(required if code-changing)*
  - **GREEN Verification:** <pytest command, expected to pass>  *(required if code-changing)*
  - **Verification:** <verification-command>
- [ ] 3.2 [P] [Slice-1] <task-description>
  - **Files:** <file-paths>
  - **Allowed File Scope:** <file-paths>
  - **Boundary Receipt Required:** yes | no-op allowed
  - **TDD Test Files:** <test-file-paths>  *(required if code-changing)*
  - **RED Verification:** <pytest command, expected to fail>  *(required if code-changing)*
  - **GREEN Verification:** <pytest command, expected to pass>  *(required if code-changing)*
  - **Verification:** <verification-command>
- [ ] 3.3 [Slice-1] <Slice 1 verifier>
  - **Files:** <change-artifacts, Slice 1 implementation, Slice 1 tests, verification results>
  - **Verification:** independent `verifier` sub-agent check
  - **Covered Tasks:** <3.1, 3.2>
  - **Inspection Scope:** <Slice 1 change artifacts + related implementation + related tests + validation results>
  - **Inspection Content:** <what the verifier must check>
  - **Out of Scope:** <stage or later-slice concerns not judged by this gate>
  - **Boundary Evidence Required:** yes
  - **PASS/FAIL Gate:** <conditions for pass or fail>

## 4. Slice 2: <slice-name>

### Slice Goal

<!-- Explain what the user or system can do independently when this slice is complete. -->

### Independent Acceptance Criteria

<!-- Explain how to verify the slice without depending on later slices. -->

- [ ] 4.1 [Slice-2] <task-description>
  - **Files:** <file-paths>
  - **Allowed File Scope:** <file-paths>
  - **Boundary Receipt Required:** yes | no-op allowed
  - **TDD Test Files:** <test-file-paths>  *(required if code-changing)*
  - **RED Verification:** <pytest command, expected to fail>  *(required if code-changing)*
  - **GREEN Verification:** <pytest command, expected to pass>  *(required if code-changing)*
  - **Verification:** <verification-command>
- [ ] 4.2 [Slice-2] <Slice 2 verifier>
  - **Files:** <change-artifacts, Slice 2 implementation, Slice 2 tests, verification results>
  - **Verification:** independent `verifier` sub-agent check
  - **Covered Tasks:** <4.1>
  - **Inspection Scope:** <Slice 2 change artifacts + related implementation + related tests + validation results>
  - **Inspection Content:** <what the verifier must check>
  - **Out of Scope:** <stage or later-slice concerns not judged by this gate>
  - **Boundary Evidence Required:** yes
  - **PASS/FAIL Gate:** <conditions for pass or fail>

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
  - **Allowed File Scope:** <file-paths>
  - **Boundary Receipt Required:** yes | no-op allowed
  - **Verification:** <verification-command>

## Readiness Gate

<!-- Unified checks before entering apply. -->
- [ ] File scope is explicit
- [ ] MVP scope is explicit
- [ ] Stage Acceptance Coverage Map covers every Brain-supplied Stage Acceptance Criterion
- [ ] Blocking tasks are separated
- [ ] Every slice has a slice goal and independent acceptance criteria
- [ ] Parallel opportunities are marked
- [ ] Task order is coherent, numbered consistently, and granular enough to execute without guessing
- [ ] Every implementation slice explicitly includes an independent `verifier` sub-agent check
- [ ] Each implementation task declares `Allowed File Scope`, `Boundary Receipt Required`, and `Verification`; code-changing tasks also declare `TDD Test Files`, `RED Verification`, and `GREEN Verification`
- [ ] Each `verifier` task clearly states covered tasks, inspection scope including declared TDD test files, inspection content, out-of-scope boundaries, `Boundary Evidence Required`, and `PASS/FAIL` gate
- [ ] Each `verifier` task's `PASS/FAIL` gate aligns with the current slice acceptance criteria
- [ ] Each slice verifier must pass before entering the next slice
- [ ] The final slice verifier must pass before entering `Reconciliation`
