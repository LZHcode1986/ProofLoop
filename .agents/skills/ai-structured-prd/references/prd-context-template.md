# PRD Context template

Use this as the working memory between user conversation and final PRD. Keep it short enough to maintain, but explicit enough to prevent forgotten decisions.

```md
# PRD Context

## 1. Current one-sentence understanding
[Plain-language summary of the product or feature.]

## 2. Confirmed
User-stated facts and decisions.

- [confirmed item]

## 3. Inferred
AI assumptions that are low-risk but not yet confirmed. Never treat these as binding.

- [inferred item] — reason: [why inferred]

## 4. Decided During Intake
Items clarified during the current conversation.

- [decision] — source: [user answer / accepted default]

## 5. Open
Consequential unresolved questions that may affect scope, user flow, acceptance criteria, data, permissions, risk, or success metrics.

- [open question] — impact: [why it matters]

## 6. Optional / Non-blocking
Questions that can wait without blocking a responsible PRD.

- [optional question]

## 7. Non-Goals
What this version explicitly will not do.

- [non-goal]

## 8. Acceptance Criteria Draft
User-observable completion conditions.

- When [situation], the user should [observable result].

## 9. Glossary
| Term | Simple explanation | Status |
|---|---|---|
| [term] | [plain explanation] | confirmed / inferred / open |

## 10. Change Log
| Turn / Date | Change | Source |
|---|---|---|
| [turn] | [what changed] | [user / AI inferred / default accepted] |
```

## Update rules

- Update after every 1-3 consequential answers.
- Preserve confirmed decisions unless the user explicitly changes them.
- Move accepted defaults into `Decided During Intake`.
- Keep contradicted terms or decisions visible until resolved.
- Before drafting PRD, summarize open critical items and ask whether to proceed with defaults.
