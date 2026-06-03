# Propose Readiness Gate

This gate is audited by `@planning-contract-verifier` to ensure planning artifacts (`proposal.md`, `design.md`, `specs/`, `tasks.md`) are complete and safe for execution.

## BLOCKER
These issues prevent safe task dispatch and will block the execution.

- [ ] Every code-changing slice has a TDD Contract or an explicit reason TDD is not applicable.
- [ ] Every verifier gate has covered tasks and PASS/FAIL criteria.
- [ ] The Stage Acceptance Coverage Map covers every Brain-supplied Stage Acceptance Criterion (no Stage AC is missing).
- [ ] The minimum closed loop's real entry point is explicit.
- [ ] Every task has a declared allowed file scope.
- [ ] Critical runtime assumptions are either confirmed or explicitly marked unverified with mitigation.
- [ ] The final validation method is explicit.
- [ ] Logic contradictions exist between proposal, design, specs, or tasks.

## WARNING
These issues represent minor risks that should be noted but do not block task dispatch.

- [ ] Some non-critical edge cases are deferred.
- [ ] Some assumptions remain unverified but do not block the minimum loop.
- [ ] The design has minor drift risk, but tasks include validation commands.

## NOTE
Formatting, naming, and suggestions for future improvements.

- [ ] Formatting or naming improvements.
- [ ] Optional additional tests.
- [ ] Future cleanup suggestions.
