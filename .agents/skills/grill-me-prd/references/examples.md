# Examples

## Good opening behavior

Good:

```text
The PRD already defines the target user, rollout scope, and success metric.
The main unresolved issue is whether existing permissions inherit by workspace
or must be explicitly assigned per project.
```

Bad:

```text
Who is the user?
What is the metric?
How will rollout work?
Are there dependencies?
```

when those are already covered.

## Terminology conflict example

```text
The PRD uses "account" both as a billing entity and as a login identity.
Recommended default: use "Customer Account" for billing and "User" for login identity.
Severity: Critical
```

## Scenario pressure test example

```text
If an organization owner loses project membership but remains org owner,
should they retain visibility into project audit logs?
```

## ADR candidate example

```text
ADR candidate:
- decision: permission inheritance flows from workspace role, not project assignment
- why durable: affects authorization model and migration path
- why surprising: project-level assignment appears to imply access but does not
- trade-off: simpler admin model vs less granular project isolation
- recommended persistence path: route documentation/planning task after Brain acceptance
```
