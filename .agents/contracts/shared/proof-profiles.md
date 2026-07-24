# Proof Profiles

> Proof Profiles are a Contract reference, not a Skill, and not a persistent verification history.
> Each profile defines both Worker minimum evidence and Code Verifier refutation templates.

Proof Profiles define both Worker minimum evidence and Code Verifier refutation templates.

Each profile specifies:
- **Applies to**: what kind of behavior this profile covers
- **Worker evidence**: minimum evidence the Worker must produce
- **Verifier refutation**: adversarial refutation the CV must attempt

## 1. api-shape

Applies to:

```text
Frontend/backend response shape, schema, fixture, fetcher parsing path.
```

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

Applies to:

```text
Omitted parameters, default/latest/current/default behavior.
```

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

Applies to:

```text
Per-item / all / each / per-item UI requirements.
```

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

Applies to:

```text
Per-section empty state, partial empty state, combined empty state.
```

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

Applies to:

```text
Real user path across page, API, component, and state management.
```

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

Applies to:

```text
State machine transitions, legal and illegal transitions.
```

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

Applies to:

```text
Save and reload behavior, data integrity across sessions.
```

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

Applies to:

```text
Access control, authorization checks, data isolation.
```

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

Applies to:

```text
Error handling, retry, cancel, resource cleanup.
```

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

Applies to:

```text
Repeated identical operations produce the same result.
```

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

Applies to:

```text
API contract compliance between frontend and backend.
```

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

Applies to:

```text
Streaming data, WebSocket, SSE, long-lived connections.
```

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

Applies to:

```text
Concurrent access, race conditions, optimistic locking.
```

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

## Profile selection

Worker selects the relevant profile(s) based on the Slice behavior. CV uses the declared profile for profile-specific refutation after completing independent refutation.

Use `None` only when no listed profile fits the actual Slice behavior.