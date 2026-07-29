# Proof Profiles

> Proof Profiles are a Contract reference, not a Skill, and not a persistent verification history.
> Each profile defines both Worker minimum evidence and Code Verifier refutation templates.

## Distinction: Proof Obligation vs Proof Profile

| Concept | Definition | Who Defines |
|---|---|---|
| **Proof Obligation (PO)** | A specific, observable claim that must be proven for a Slice. "The API returns 403 when an unauthenticated user calls DELETE /resource." | Planner (per Slice) |
| **Proof Profile** | A category of risk that defines how evidence of that class is typically gathered and refuted. "permission-boundary" | Referenced by Planner, computed by Validator, audited by SPV |

Proof Obligations are per-Slice specifics. Proof Profiles are reusable templates for evidence strategy.

## Profile selection responsibility

```text
Planner  → declares Risk Facts and candidate Profiles per Slice
Validator → computes required Profiles from Risk Facts and Slice behavior
SPV      → audits whether required Profiles are complete and correctly applied
Worker   → executes evidence per declared Profiles (may not lower requirements)
CV      → may require additional Profiles based on observed risk
```

- **Planner** does not hand-select CV level; it declares Risk Facts.
- **Validator** maps Risk Facts to required Profiles.
- **SPV** checks completeness against Risk Facts.
- **Worker** cannot reduce or skip a declared Profile.
- **CV (Code Verifier)** can demand additional Profiles if evidence is insufficient.

## Profile structure

Each profile specifies:
- **Applies to**: what kind of behavior this profile covers
- **Minimum CV level**: the lowest CV tier that satisfies this profile
- **Applicable Risk Facts**: which Risk Facts trigger this profile
- **Required PO types**: what kinds of POs are needed
- **Forbidden mocks**: what must NOT be mocked/substituted
- **Minimum real boundary**: the minimum real integration surface
- **Worker evidence**: minimum evidence the Worker must produce
- **Verifier refutation**: adversarial refutation the CV must attempt

---

## 1. api-shape

- **Minimum CV level:** 2 (isolated service)
- **Applicable Risk Facts:** public_api_change
- **Required PO types:** response shape, status codes, error shape
- **Forbidden mocks:** none
- **Minimum real boundary:** HTTP request/response or equivalent

Worker evidence:

```text
- backend actual response shape
- frontend fetcher handling
- component fixture source
- command/test proving shape compatibility
```

Verifier refutation:

```text
- feed backend actual response shape into frontend path
- verify fetcher output
- verify component rendering with actual shape
```

## 2. route-default

- **Minimum CV level:** 2 (isolated service)
- **Applicable Risk Facts:** public_api_change
- **Required PO types:** explicit vs default behavior comparison
- **Forbidden mocks:** none
- **Minimum real boundary:** HTTP request/response or equivalent

Worker evidence:

```text
- request explicit route
- request omitted/default route
- prove default value source
```

Verifier refutation:

```text
- call omitted route directly
- fail if 404 / 405 / wrong default behavior
```

## 3. ui-cardinality

- **Minimum CV level:** 1 (unit/component)
- **Applicable Risk Facts:** none specific
- **Required PO types:** element count, item binding
- **Forbidden mocks:** none
- **Minimum real boundary:** rendered UI output

Worker evidence:

```text
- construct N >= 2 items
- assert UI element count = N
- assert item binding correctness
```

Verifier refutation:

```text
- use N >= 2 items
- fail if only one global control appears
- fail if binding points to wrong item
```

## 4. empty-state

- **Minimum CV level:** 1 (unit/component)
- **Applicable Risk Facts:** none specific
- **Required PO types:** state combinations
- **Forbidden mocks:** none
- **Minimum real boundary:** rendered UI output

Worker evidence:

```text
- A empty, B non-empty
- A non-empty, B empty
- A empty, B empty
- assert required copy per state
```

Verifier refutation:

```text
- test single-sided empty states
- fail if section is hidden
- fail if only global empty state appears
```

## 5. integration-path

- **Minimum CV level:** 3 (real environment)
- **Applicable Risk Facts:** external_side_effect, cross_process_behavior
- **Required PO types:** full-path behavior, end-to-end observable outcome
- **Forbidden mocks:** all external collaborators must be real
- **Minimum real boundary:** full system integration surface

Worker evidence:

```text
- realistic backend response
- page route
- user action
- visible result
```

Verifier refutation:

```text
- run full path
- fail if component exists but user-critical path fails
```

## 6. state-transition

- **Minimum CV level:** 2 (isolated service)
- **Applicable Risk Facts:** core_state_machine
- **Required PO types:** legal transition, illegal rejection, state invariance
- **Forbidden mocks:** state store must be real
- **Minimum real boundary:** state machine or domain logic boundary

Worker evidence:

```text
- start state
- trigger action
- end state
- assert state matches expected
- assert illegal transition is rejected
```

Verifier refutation:

```text
- attempt all legal transitions from each state
- attempt illegal transitions
- fail if illegal transition succeeds or legal transition fails
```

## 7. persistence-roundtrip

- **Minimum CV level:** 3 (real environment)
- **Applicable Risk Facts:** persistent_state
- **Required PO types:** save, reload, modify, delete
- **Forbidden mocks:** database/persistence layer must be real
- **Minimum real boundary:** database or persistent store

Worker evidence:

```text
- create entity
- reload from persistence
- assert all fields match
- assert identity is preserved
```

Verifier refutation:

```text
- create, persist, reload
- modify, persist, reload
- delete, persist, verify absence
- fail if data loss, corruption, or identity mismatch
```

## 8. permission-boundary

- **Minimum CV level:** 3 (real environment)
- **Applicable Risk Facts:** authorization
- **Required PO types:** access granted, access denied, unauthenticated rejection, privilege escalation
- **Forbidden mocks:** auth system must be real
- **Minimum real boundary:** real authentication/authorization system

Worker evidence:

```text
- user A can access own resource
- user A cannot access user B's resource
- unauthenticated access is rejected
- role-based access behaves correctly
```

Verifier refutation:

```text
- attempt cross-user access
- attempt unauthenticated access
- attempt privilege escalation
- fail if boundary is bypassed
```

## 9. error-recovery

- **Minimum CV level:** 2 (isolated service)
- **Applicable Risk Facts:** irreversible_operation, external_side_effect
- **Required PO types:** error response, recovery state, resource cleanup
- **Forbidden mocks:** error triggers must be real or realistically simulated
- **Minimum real boundary:** error boundary of the component

Worker evidence:

```text
- trigger error condition
- verify error response
- verify system recovers to known state
- verify no resource leak
```

Verifier refutation:

```text
- trigger error at each stage
- verify recovery path
- verify no orphaned resources
- cancel mid-operation and verify cleanup
```

## 10. idempotency

- **Minimum CV level:** 2 (isolated service)
- **Applicable Risk Facts:** concurrency, irreversible_operation
- **Required PO types:** repeatable operation, side effect idempotence
- **Forbidden mocks:** operation under test must be real
- **Minimum real boundary:** operation boundary

Worker evidence:

```text
- execute operation once
- execute same operation again
- assert second execution does not duplicate or corrupt
```

Verifier refutation:

```text
- execute operation 2+ times
- verify idempotent behavior
- fail if duplicate side effects occur
```

## 11. frontend-backend-contract

- **Minimum CV level:** 2 (isolated service)
- **Applicable Risk Facts:** public_api_change
- **Required PO types:** request shape, response shape, error shape, status codes
- **Forbidden mocks:** both sides must be real or contract-tested
- **Minimum real boundary:** API contract surface

Worker evidence:

```text
- request shape matches contract
- response shape matches contract
- error response shape matches contract
- status codes match contract
```

Verifier refutation:

```text
- send request and verify response shape
- send invalid request and verify error shape
- fail if shape deviates from contract
```

## 12. stream-lifecycle

- **Minimum CV level:** 3 (real environment)
- **Applicable Risk Facts:** cross_process_behavior, external_side_effect
- **Required PO types:** connection, data flow, clean close, error handling, cancel handling
- **Forbidden mocks:** stream infrastructure must be real
- **Minimum real boundary:** real transport (WebSocket, SSE, etc.)

Worker evidence:

```text
- connection established
- data received incrementally
- connection closed cleanly
- error during stream handled
- cancel during stream handled
```

Verifier refutation:

```text
- establish stream and verify data flow
- interrupt stream and verify cleanup
- cancel stream and verify no listener leak
- fail if resource not released
```

## 13. concurrency-conflict

- **Minimum CV level:** 3 (real environment)
- **Applicable Risk Facts:** concurrency
- **Required PO types:** concurrent access, conflict detection, conflict resolution, data integrity
- **Forbidden mocks:** shared resource must be real
- **Minimum real boundary:** real shared resource (database, file, etc.)

Worker evidence:

```text
- two concurrent operations on same resource
- conflict detection triggers
- conflict resolution behaves correctly
- no data corruption after concurrent access
```

Verifier refutation:

```text
- simulate concurrent access
- verify conflict detection
- verify no data corruption
- fail if silent data loss occurs
```

## Profile selection reference

| Risk Fact | Default Profile(s) |
|---|---|
| public_api_change | api-shape, route-default, frontend-backend-contract |
| persistent_state | persistence-roundtrip |
| authorization | permission-boundary |
| migration | persistence-roundtrip (if data), api-shape (if schema) |
| concurrency | concurrency-conflict, idempotency |
| external_side_effect | integration-path, error-recovery |
| irreversible_operation | error-recovery, idempotency |
| cross_process_behavior | stream-lifecycle, integration-path |
| core_state_machine | state-transition |

Use `None` only when no listed profile fits the actual Slice behavior.
