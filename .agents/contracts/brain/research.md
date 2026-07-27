# Brain Research Dispatch Contract

This contract is self-contained.

Dispatch external technical research to Researcher.

## Use when

A technical question requires external facts from official documentation, GitHub, or other public sources.

## Target-specific required fields

- Research Goal
- Research Question
- Why It Matters
- Preferred Sources
- Out of Scope

## Expected results

Research findings returned. May resolve a Hard Part or inform a technical decision.

## Return codes (unified route code format)

When returning a finding that requires cross-phase action:

```yaml
route_code: TECHNICAL_UNKNOWN
subtype: RESEARCH_INCONCLUSIVE | RESEARCH_REQUIRES_PROTOTYPE
finding_id: <id>
affected_hard_parts: <list>
evidence: <description>
reason: <description>
invalidation_scope: <list>
resume_target:
  owner: <owner>
  phase: <phase>
```


