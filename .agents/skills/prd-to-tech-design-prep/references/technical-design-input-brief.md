# Technical design input brief template

This is not a technical architecture document. It is a structured handoff that lets a later technical-design workflow create one without guessing product intent.

```md
# Technical Design Input Brief

## 1. Product scope summary
- Product / feature:
- Target users:
- Main workflow:
- Version 1 scope:
- Explicit non-goals:

## 2. Implementation-impacting product facts
| Area | Decision | Status | Notes |
|---|---|---|---|
| Login / accounts | [decision] | confirmed / inferred / open | [notes] |
| Data saving | [decision] | confirmed / inferred / open | [notes] |
| Roles / permissions | [decision] | confirmed / inferred / open | [notes] |
| Uploads | [decision] | confirmed / inferred / open | [notes] |
| Integrations | [decision] | confirmed / inferred / open | [notes] |
| Mobile | [decision] | confirmed / inferred / open | [notes] |
| Privacy / payment / safety | [decision] | confirmed / inferred / open | [notes] |

## 3. Acceptance criteria to preserve
- [AC-001]
- [AC-002]

## 4. Glossary
| Term | Meaning |
|---|---|
| [term] | [meaning] |

## 5. Open technical design inputs
| ID | Question | Blocking? | Recommended default |
|---|---|---|---|
| TQ-001 | [question] | yes / no | [default] |

## 6. Risks and scenario pressure tests
- Risk:
- Scenario tested:
- Decision needed:

## 7. ADR candidates
Only mark an ADR candidate when a decision is durable, surprising, trade-off-heavy, and likely to affect architecture, data ownership, permissions, integration, or rollout.

| Candidate decision | Why durable | Trade-off | Recommended persistence path |
|---|---|---|---|
| [decision] | [why] | [trade-off] | [where to record] |

## 8. Recommended next step
- Generate technical design.
- Return to PRD review.
- Answer one critical clarification.
- Split scope into stages.
```
