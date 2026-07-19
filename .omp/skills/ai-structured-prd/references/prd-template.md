# AI-usable structured PRD template

Use plain language. Do not include full technical architecture or implementation plans. Include product facts that affect technical design.

```md
# PRD: [Product / Feature Name]

## 1. One-sentence description
[What this product or feature does, for whom, and why.]

## 2. Background and problem
- Current problem:
- Why it matters now:
- Current workaround or alternative:

## 3. Target users and roles
| Role | Description | Key needs |
|---|---|---|
| [role] | [who they are] | [what they need] |

## 4. User scenarios
- Scenario 1: When [context], the user wants to [goal] so they can [outcome].
- Scenario 2:

## 5. Product goals
- Goal 1:
- Goal 2:

## 6. Success metrics
Use practical signals, not only analytics.

- User can complete [key task] without [current pain].
- [metric or observable success signal].

## 7. Primary user flow
1. User starts by...
2. User then...
3. System responds by...
4. User finishes when...

## 8. Functional requirements

### FR-001: [Feature name]
- Description:
- User story: As a [user], I want to [goal], so that [benefit].
- Acceptance criteria:
  - When [situation], the user should [observable result].
  - If [error or missing condition], the system should [plain-language handling].
- Status: confirmed / inferred / open

### FR-002: [Feature name]
- Description:
- User story:
- Acceptance criteria:
- Status:

## 9. Product-level constraints that affect implementation
Do not specify the technical solution. Explain the product fact.

| Area | Requirement | Status | Simple explanation if needed |
|---|---|---|---|
| Login / account | [needed / not needed / open] | [status] | Login means the product can recognize different users. |
| Data saving | [needed / not needed / open] | [status] | Data saving means users can return later and see previous content. |
| Roles / permissions | [needed / not needed / open] | [status] | Permissions define who can see or change what. |
| Uploads | [files/images/videos?] | [status] | Upload means users send files into the product. |
| Import / export | [needed / not needed / open] | [status] | Import/export moves data in or out of other tools. |
| Mobile use | [web only / mobile friendly / mobile first] | [status] | Mobile friendly means usable on a phone browser. |
| Privacy / payment / content safety | [details] | [status] | Explain any sensitive handling in plain language. |

## 10. Scope for this version

### Must have
- [must-have]

### Can be simplified
- [simplification]

### Explicitly out of scope
- [non-goal]

### Later versions
- [future idea]

## 11. Optional: Product Stage Candidates

Use this section only after the PRD is mostly ready or confirmed.

These are product-delivery slices for Brain dispatch, not technical implementation tasks.

| Candidate | User-visible objective | Product boundary | Out of scope | Acceptance criteria refs |
|---|---|---|---|---|
| 1 | [what user value this stage delivers] | [what product scope is included] | [what remains excluded] | [AC refs] |
| 2 | [what user value this stage delivers] | [what product scope is included] | [what remains excluded] | [AC refs] |

## 12. Risks and edge cases
- If [edge case], the expected behavior is [handling].
- Risk: [risk]. Mitigation or decision needed: [what to clarify].

## Rollout / Migration
- [any deployment, migration, or rollout considerations]

## Legal / Privacy / Security
- [any privacy, legal, compliance, or security requirements]

## 13. Glossary
| Term | Simple explanation |
|---|---|
| [term] | [plain explanation] |

## 14. Decision ledger

### Confirmed
- [decision]

### Inferred
- [assumption]

### Decided During Intake
- [decision]

### Open
- [open question]

### Optional / Non-blocking
- [optional item]

## 15. Readiness for next step
Ready / Mostly ready / Needs revision / Blocked

Recommended next step:
[confirm PRD / answer one question / dispatch brain/technical-handoff.md]
```
