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
- [ ] Does `tasks.md` explicitly include `verifier` sub-agent checks after each implementation slice?
- [ ] Does each `verifier` task clearly define inspection scope and a `PASS/FAIL` gate?
- [ ] Does every key task include a file scope and verification command?
- [ ] If the change is `interactive`, is the first `Blocking` item a `Proof Task`?
- [ ] Do proposal, design, specs, and tasks still describe one closed loop?

## 3. Implementation Done Check

- [ ] Have the verification commands in tasks actually been run?
- [ ] Have the implementation-slice verifier checks actually run and produced an explicit `PASS/FAIL` conclusion?
- [ ] Did the verifier read the change artifacts, related implementation, related tests, and verification results independently, rather than inheriting the main agent's spoken conclusions?
- [ ] If the change is `interactive`, does the proof use a real entry path instead of internal direct calls?
- [ ] Are the code, task list, and verification results aligned?

