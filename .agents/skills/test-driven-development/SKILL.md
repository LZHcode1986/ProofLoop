---
name: test-driven-development
description: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
---

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle — consult them before and during the loop, not after.

When exploring the codebase, read `CONTEXT.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists — and survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## PO Binding

Every behavior test must cite one or more PO IDs from the Slice's Proof Obligations.

A passing test without a valid PO mapping does not close Slice proof.

```text
# Example: test file header or docstring
# PO: PO-S01-A-01, PO-S01-A-02
```

The PO-to-test mapping is recorded in the Proof Plan table and later in the Evidence section.

## Seams — where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

### ProofLoop Flow (with upstream Contract)

When used within the ProofLoop pipeline and the Worker Packet contains a **Seam Status**:

- **PRE_AGREED** — The Seam has already been confirmed by Planner and SPV. The Worker must **not** re-negotiate or ask the user for confirmation. Write tests at the agreed seam.
- **TO_CONFIRM** — The Seam is proposed but not yet confirmed. Confirm with the user before proceeding.

If Seam Status is present in the Worker Packet, that status governs seam selection.

### Independent Use (no upstream Contract)

When using the TDD Skill independently — without a ProofLoop Worker Packet or upstream Planner/SPV Contract — the current Agent determines the seams and confirms them with the user before writing tests.

Ask: "What's the public interface, and which seams should we test?"

## RED Receipt

Every RED step (failing test before implementation) must produce a minimal receipt:

```text
- test identifier: <test file + test name>
- command: <command used to run the test>
- failure reason: <the exact failure message>
- expected failure: <what was expected to fail>
- source snapshot: <the test code or key excerpt>
```

The RED Receipt proves that the test was written first and correctly detects the absence of the behavior. It is recorded in the Evidence section's Proof Obligation Coverage table.

## GREEN Receipt

Every GREEN step (passing test after implementation) must produce a minimal receipt:

```text
- same PO: <PO ID(s) this test covers>
- command: <command used to run the test>
- pass result: <output summary or "all tests passed">
- implementation snapshot: <the implementation code or key excerpt>
```

The GREEN Receipt proves that the implementation satisfies the PO. It is recorded alongside the RED Receipt in the Evidence section.

## Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological** — the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth — a known-good literal, a worked example, the spec.
- **Horizontal slicing** — writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead — one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **PO binding.** Every test must be traceable to at least one PO ID.

## Refactoring

- **Minor internal cleanup** (rename local variable, extract small helper, inline dead code) may be performed during the loop as long as behavior does not change and all existing tests stay green.
- **Structural refactoring** (rename public API, extract module, change type signatures, migrate callers) is **not** part of the TDD loop. It belongs to:
  - A code review pass (see `code-review` skill), or
  - A separate Task/Slice dedicated to the refactor.
