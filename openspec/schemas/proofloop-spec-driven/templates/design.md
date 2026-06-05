# Design

## Design Boundary

<!-- Design is technical rationale for implementing specs. It does not redefine behavior contracts. -->

## Goals and Non-goals

### Goals

- 

### Non-goals

- 

## Interfaces / Contracts

## State / Persistence Impact

## Module Boundaries

## Key Decisions

| Decision | Rationale | Alternatives |
| --- | --- | --- |
|  |  |  |

## Verification Strategy

## Git Boundary Strategy

Default:

```text
task -> task-diff-snapshot receipt
slice verifier pass -> slice-output commit
archive output -> archive-output commit
```

If audit behavior is required, describe why and which boundary is stricter.

## CodeGraph Anchors

| Anchor | Type | Used By |
| --- | --- | --- |
|  |  |  |

## Risks and Mitigations

- 

## Binding Decisions

| Decision | Type | Source Spec Requirement | Projects To Tasks | Projects To Specs | Rationale |
| --- | --- | --- | --- | --- | --- |
|  | behavior-binding / implementation-only | REQ-... | yes/no | yes/no |  |

<!-- 
  Rules:
  - behavior-binding: affects observable behavior or external contract. Must already be represented in specs. Must project to tasks.
  - implementation-only: affects implementation plan. May project to tasks. Does not need to appear in specs.
-->
