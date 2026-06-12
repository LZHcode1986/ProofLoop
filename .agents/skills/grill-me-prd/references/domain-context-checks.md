# Domain Context Checks

Use this reference only when structured PRD context contains domain terminology, code/docs references, architectural boundaries, or durable decisions.

These checks help select the single highest-leverage clarification question.

They do not authorize file edits.

## 1. Terminology calibration

Identify overloaded, ambiguous, or conflicting terms.

Examples:
- account
- user
- customer
- workspace
- project
- tenant
- organization
- role
- permission
- owner
- admin

If terminology conflict affects scope, UX, API, data model, permissions, security, or execution correctness, ask one precise clarification question.

Question shape:

```text
The term `<term>` appears to mean both `<meaning A>` and `<meaning B>`.
Which meaning should be binding for this PRD?
Recommended default: `<default>`.
Severity: Critical | Optional
```

## 2. Code / docs cross-check

When repository docs, glossary, code names, schemas, routes, configs, or domain models are available, compare PRD wording against them.

If existing code/docs already answer the question:
- do not ask the user to restate it;
- state the finding as Confirmed or Inferred.

If PRD conflicts with code/docs:
- surface the conflict explicitly;
- ask only the decision needed to resolve the conflict.

Do not perform implementation verification.
Do not modify code or docs.

## 3. Scenario pressure test

For ambiguous domain boundaries, ask a concrete scenario-based question instead of a vague general question.

Use the smallest scenario that exposes the decision.

Example:

```text
If a workspace admin creates a project but is not explicitly assigned to it,
should they still see project-level recommendations?
```

Use scenario pressure tests for:
- permission inheritance
- ownership boundaries
- data visibility
- fallback behavior
- migration edge cases
- multi-tenant behavior
- role transitions
- partial failure behavior

## 4. ADR candidate detection

Mark a clarification as an ADR candidate only when the decision is:

- durable or hard to reverse;
- surprising to a future maintainer;
- a real trade-off rather than an obvious implementation detail;
- likely to affect architecture, domain model, data ownership, API contract, or rollout strategy.

Do not create ADR files directly.

Instead, output:

```text
ADR candidate:
- decision:
- why durable:
- why surprising:
- trade-off:
- recommended persistence path:
```

Brain decides whether to route an authorized documentation or planning task.
