# Reality Readiness Gate

This gate is audited by `@reality-verifier` to verify that documented planning assumptions align with current repository reality.

## BLOCKER
Direct mismatches that prevent starting the implementation.

- [ ] Direct contradictions exist that break the minimum closed loop.
- [ ] Direct contradictions exist that impact security, data integrity, or migrations.
- [ ] Critical assumptions for P2 (Audit) tasks remain unverified.
- [ ] Claimed entry paths, handlers, or persistent structures do not exist and have no design mapping.

## WARNING
Unverified minor assumptions or minor mismatches that do not block starting the task.

- [ ] Assumptions for P0/P1 tasks remain unverified (e.g. minor helper or service exists but is not code-anchored yet). These are tracked as risks to be verified by Worker during implementation.
- [ ] Non-project validation docs are referenced but their runtime behavior is not fully confirmed.

## NOTE
Inconsequential findings that do not affect execution safety.

- [ ] Minor class, type, or config file references exist but are not critical for the minimum closed loop.
