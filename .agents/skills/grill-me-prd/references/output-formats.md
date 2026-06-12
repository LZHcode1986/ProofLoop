# Output Formats

## Clarification question format

Use this exact structure when asking a question:

```md
### Clarification Needed

**Question**  
[one precise question]

**Why it matters**  
[one to three sentences on what this affects]

**Recommended default**  
[a concrete recommendation, not a vague possibility list]

**Severity**  
`Critical` or `Optional`
```

Ask at most one question per turn.

## Intake clarification mode output

If critical gaps remain:
- ask only the single highest-leverage next question;
- do not output a full PRD Gap Review unless the user asks for a review or no critical gap remains.

When no critical question remains, output:

```md
# PRD Clarification Summary

## 1. Dispatch readiness

Ready | Mostly ready with minor gaps | Blocked by critical unknowns

## 2. Confirmed decisions

## 3. Inferred assumptions

## 4. Accepted recommended defaults

## 5. Critical gaps

## 6. Optional follow-ups

## 7. Domain terminology conflicts

## 8. Code/docs cross-check findings

## 9. Scenario pressure tests used

## 10. ADR candidates

## 11. Recommended next step
```

## PRD review mode output

```md
# PRD Gap Review

## 1. Execution readiness

Ready | Mostly ready with minor gaps | Blocked by critical unknowns

## 2. Confirmed decisions

## 3. Inferred decisions

## 4. Critical gaps

## 5. Optional follow-ups

## 6. Contradictions or risks

## 7. Domain terminology conflicts

## 8. Code/docs cross-check findings

## 9. Scenario pressure tests used

## 10. ADR candidates

## 11. Recommended next step
```
