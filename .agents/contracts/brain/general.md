# Brain General Direct Task Dispatch Contract

This contract is self-contained.

Dispatch a bounded, non-authority task to General.

## Use when

A bounded local task that does not require specialist ownership and does not affect authority documents. Also serves as the bounded repair owner when explicitly routed by Brain for Active Stage implementation/composition defects.

## Packet branches and required fields

Dispatch packet 明确区分两个分支：普通直派任务与 pointer-first Finding repair。

### 1. Ordinary direct task（普通直派分支）
用于无 specialist owner 且不改动 Authority 的有界局部任务（如机械编辑、诊断）：
- Objective
- Allowed Scope
- Forbidden Scope
- Acceptance Criteria
- Verification Method

### 2. Pointer-first finding repair（Finding 修复分支）
用于 Brain 已判断并明确授权的 bounded repair（如 Active Stage 实现/组成缺陷修复，经 `direct-fix`）。该分支由 `execution_mode` 区分普通与 maintenance Review repair：
- Execution mode (`execution_mode`): `NORMAL | MES_MAINTENANCE`
- `NORMAL`：实际 verifier Finding ref (`finding_ref`) 与 durable Brain `FINDING_DISPOSITION` ref (`disposition_ref`) 均为必需，保持既有 pointer-first 语义。
- `MES_MAINTENANCE`：仅限 Maintenance Stage Review FINDINGS 后的 bounded-repair exception；使用 Reviewer 结构化 `finding_evidence_refs`、Brain 接纳的 `accepted_route_code`、精确 `maintenanceBinding`，并省略且禁止 durable `finding_ref` / `disposition_ref`。该分支是 evidence-only packet，不创建或要求 MES Finding/FINDING_DISPOSITION。
- Current basis refs (`plan_ref`, `tech_spec_refs`, `git_basis`)；maintenance packet 另须携带 recovery Plan、Technical Authority、Git repair basis 与完整 frozen/forensic/audit binding。
- Allowed Scope (bounded failure scope)
- Forbidden Scope
- Action token (`actionToken`)
- Expected result (`expected_result`)
Pointer-first repair packet 不要求 Brain 提供 Objective、Acceptance Criteria 或 Verification Method；Brain 不构造 synthetic technical repair design 或替代事实。General 按 mode 读取实际 Finding/Review evidence 与 current basis，自主决定 bounded HOW，并在 explicit Allowed Scope 内完成修复。

## Bounded repair rules

When dispatched for pointer-first finding repair:
- Dispatch packet is pointer-first; Brain does not construct synthetic technical repair designs or substitute facts, and does not require Brain Objective, Acceptance Criteria, or Verification Method.
- General independently reads the actual Finding and durable disposition for `NORMAL`; for `MES_MAINTENANCE` it reads the Reviewer structured `finding_evidence_refs`, Brain `accepted_route_code`, maintenance binding, accepted Plan/tech-spec and current code reality, with no durable disposition artifact.
- General decides bounded HOW within the explicit Allowed Scope. Reviewer suggested solutions do not constitute implementation design authorization or mandatory repair HOW.
- Downstream General does not formally claim Product→Technical `AUTHORITY_GAP`. If upstream reconsideration or plan changes are needed, General returns an observable blocker / plan issue (`PLAN_GAP / GENERAL_PLAN_ISSUE`), and Brain routes Planning.
- General does not make specialist judgments beyond bounded repair scope.
- General does not commit directly (Git boundary is handled by Brain via `direct-fix`).
- `MES_MAINTENANCE` General use is only the post-Maintenance-Review bounded-repair exception defined by the Stage Review Contract; it is not a Worker/CV substitute, a generic maintenance fallback, or a Slice lifecycle. The packet remains evidence-only and must not create MES facts.
- If the task exceeds General scope, General returns `GENERAL_SCOPE_EXCEEDED` or `STAGE_OWNED_DEFECT`.

## Return codes (unified route code format)

```yaml
route_code: OWNER_MISMATCH
subtype: GENERAL_SCOPE_EXCEEDED
```

```yaml
route_code: PLAN_GAP
subtype: GENERAL_PLAN_ISSUE
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
