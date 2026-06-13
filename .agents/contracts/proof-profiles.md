# Proof Profiles

Proof Profiles are verifier refutation templates and worker minimum evidence requirements.

Worker uses profiles to know what evidence to produce.  
Code Verifier uses profiles to know what refutation to attempt.

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
- call OpenSpec-declared omitted route directly
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

### Runtime dependency blocker

If the real integration path depends on unavailable runtime config, denied secret files, database readiness, external services, browser services, containers, daemons, credentials, or interactive setup, Worker must return blocked with `runtime-config-blocker` or `runtime-dependency-blocker` as defined in:

.agents/contracts/executor/shared-worker-rules.md

Worker must not wait for the dependency, request permission, ask the user, or silently substitute mocked evidence unless the task or Slice Contract explicitly authorizes that fixture path.

