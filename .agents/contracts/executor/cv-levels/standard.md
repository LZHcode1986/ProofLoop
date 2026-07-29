# CV Level Profile: Standard

**Base Contract:** `.agents/contracts/executor/code-verifier.md`

This profile extends the Base CV Contract with standard-level verification scope.
All Base Contract rules apply. This document specifies only the standard-specific
additions over the lite profile.

## Inheritance

Standard includes all lite-level domains plus the additions below.

## Scope

Standard verification is used when:

- Risk Policy minimum is `standard`
- Actual diff is **moderate** (single function change, one module)
- Public interface is touched (export, function signature, access modifier)
- No dependency changes

## Verification Domains (Standard)

| Domain | Required |
|---|---|
| All lite-level domains | Yes |
| Code review of changed lines | Yes |
| 1–3 independent counterexample attempts | Yes |
| Error path verification | Yes |
| Public interface and side effect audit | Yes |

## Additional Rules

1. Perform code review of all changed files. Identify logic errors, missing edge
   cases, and concurrency issues in the diff.
2. Design and execute 1–3 concrete counterexample attempts. Each attempt must
   produce a failing test or demonstrate incorrect behavior.
3. Verify error paths: what happens when inputs are invalid, resources are
   unavailable, or preconditions are not met?
4. Audit the public interface: does the change introduce unexpected side effects
   on callers? Are exported types/behaviors consistent with the Slice Goal?
5. Return PASS only if all counterexample attempts fail to refute the Slice
   claim, code review shows no defects, and error paths are properly handled.

## Counterexample Requirements

Each counterexample must:

- Be independently executable (not dependent on Worker's test setup)
- Target a specific PO or behavioral claim
- Document the expected behavior vs actual behavior
- Be reproducible via a single command

## Output

Same structured verdict as the Base Contract. The `cv_level` field must be set to `standard`.
