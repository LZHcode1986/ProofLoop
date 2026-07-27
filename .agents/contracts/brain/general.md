# Brain General Direct Task Dispatch Contract

Core Packet fields are defined in `core-dispatch-packet.md` — this contract defines only target-specific fields.

Dispatch a bounded, non-authority task to General.

## Use when

A bounded local task that does not require specialist ownership and does not affect authority documents.

## Target-specific required fields

- Objective
- Allowed Scope
- Forbidden Scope
- Acceptance Criteria
- Verification Method

## Rules

- General does not make specialist judgments
- General does not commit
- If the task exceeds General scope, General returns GENERAL_SCOPE_EXCEEDED

## Return codes (unified route code format)

```yaml
route_code: OWNER_MISMATCH
subtype: GENERAL_SCOPE_EXCEEDED
```

```yaml
route_code: AUTHORITY_GAP
subtype: GENERAL_AUTHORITY_IMPACT
```

```yaml
route_code: IMPLEMENTATION_DEFECT
subtype: STAGE_OWNED_DEFECT
```

```yaml
route_code: TECHNICAL_UNKNOWN
subtype: GENERAL_TECHNICAL_UNKNOWN
```

## Expected results

Edit complete, Edit blocked, or GENERAL_SCOPE_EXCEEDED.


