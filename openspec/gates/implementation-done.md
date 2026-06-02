# Implementation Done Gate

This check is executed by `@executor` and verified by `@code-verifier` after implementation task execution.

## BLOCKER
Unresolved implementation defects or evidence protocol failures that block slice approval.

- [ ] All executable implementation task checkboxes in `tasks.md` are completed by their assigned owners.
- [ ] All verifier task checkboxes in `tasks.md` are confirmed `[x]`.
- [ ] Required slice verifier gates have run and reached `PASS`.
- [ ] Boundary receipts exist for every covered Worker attempt (commit, diff-snapshot, or no-op) and scope checks are clean.
- [ ] Verification commands declared in tasks have been run and recorded.
- [ ] Required execution evidence channels exist (Worker summaries, TDD evidence fields, verification command outputs, diff inspection results).
- [ ] If the change is `interactive`, proof evidence is recorded from a real entry path.

## WARNING
Non-blocking warnings.

- [ ] Some minor residual risks are noted in the verifier output.
- [ ] Non-critical warnings exist in build/test output.

## NOTE
Refactoring or formatting notes.

- [ ] Minor refactoring suggestions or formatting notes.
