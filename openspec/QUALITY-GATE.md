# Readiness Gate

This document is used between `propose` and `apply`. It keeps only three gates.

## 1. Proofability Check

- [ ] Is the minimal closed loop's real entry point explicit?
- [ ] Is the user's action order explicit?
- [ ] Is the authority source of truth explicit?
- [ ] Are the things that do not count as completion explicitly stated?
- [ ] Is the final validation method explicit?

## 2. Tasks Readiness Check

- [ ] Does `tasks.md` already break the minimal loop into executable steps?
- [ ] Does `tasks.md` include a Stage Acceptance Coverage Map that covers every Brain-supplied Stage Acceptance Criterion?
- [ ] Does `tasks.md` explicitly include `verifier` sub-agent checks after each implementation slice?
- [ ] Does each `verifier` task clearly define covered tasks, inspection scope, inspection content, out-of-scope boundaries, and a `PASS/FAIL` gate?
- [ ] Does each `verifier` task's `PASS/FAIL` gate align with the current slice acceptance criteria instead of expanding into unrelated full-stage review?
- [ ] Does every key task include a file scope and verification command?
- [ ] If the change is `interactive`, is the first `Blocking` item a `Proof Task`?
- [ ] Do proposal, design, specs, and tasks still describe one closed loop?

## 3. Implementation Done Check

- [ ] Are all executable task checkboxes completed by their assigned owners?
- [ ] Have the verification commands declared in tasks actually been run and recorded?
- [ ] Have the required implementation-slice verifier gates run and reached `PASS`?
- [ ] If the change is `interactive`, is the proof result recorded from a real entry path instead of internal direct calls?
- [ ] Has the Executor prepared the stage-review package with slice verifier results, commands executed, and residual risks?

