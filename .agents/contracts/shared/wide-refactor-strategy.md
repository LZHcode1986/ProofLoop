# Wide Refactor Strategy

> Shared Contract for broad structural refactoring across multiple modules.
> Referenced by Planner when a Stage requires cross-module migration that cannot stay green per Slice.

## Applicability

Use this strategy when:

- Renaming a type, interface, or module that is referenced across many files.
- Migrating from one library/framework/pattern to another across multiple packages.
- Restructuring directory layout affecting imports across the codebase.
- Any mechanical change that touches many files and cannot be verified within a single Slice.

## Strategy: EXPAND → MIGRATE BATCHES → CONTRACT

```text
EXPAND   — Add new Type/interface alongside old form.
MIGRATE  — Migrate callers by package/directory in ordered batches.
CONTRACT — Delete old form after all callers migrated.
```

## Rules

1. **EXPAND phase:** Add the new type, interface, or module alongside the existing one. Both coexist. Tests must still pass.

2. **MIGRATE phase:** Migrate callers in ordered batches (by package, directory, or dependency level). Each batch must keep the system green. If a batch cannot stay independently green, use a shared integration branch with a final integrate-and-verify Slice.

3. **CONTRACT phase:** Delete the old form only after all callers have been migrated. Verify by removing old exports and running the full test suite.

## Planner Requirements

When a Stage requires wide refactoring, the Planner must:

- Identify the full scope of files affected per batch.
- State which modules are safe to migrate per batch.
- Declare any temporary duplication risk.
- Ensure each batch has a clear verification path (green tests or integration branch verification).
- Reference the `codebase-design` skill when module boundaries or extraction points are unclear.

## Relationship to Normal Slices

Wide refactor Slices follow the same Slice structure (Goal, Observable Outcome, Public Seam, etc.) with the following differences:

- Proof Obligations focus on behavioral preservation (old behavior still works, new behavior matches).
- Proof Plan emphasizes before/after comparison rather than new feature verification.
- Risk Facts must include `migration` and may include `core_state_machine` or `persistent_state`.
