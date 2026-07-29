# CV Level Profile: Lite

**Base Contract:** `.agents/contracts/executor/code-verifier.md`

This profile extends the Base CV Contract with lite-level verification scope.
All Base Contract rules (verdicts, evidence read-only, fresh session, recheck)
apply. This document specifies only the lite-specific additions.

## Scope

Lite verification is used when:

- Risk Policy minimum is `lite`
- Actual diff is **trivial** (typo, formatting, comment-only, rename with no semantic change)
- No public interface or dependency changes
- Low-risk internal refactor with zero behavioral change

## Verification Domains (Lite)

| Domain | Required |
|---|---|
| PO coverage — mechanical check | Yes |
| RED/GREEN receipt verification | Yes |
| Skip/xfail detection | Yes |
| Scope boundary check | Yes |
| Related regression check | Yes |
| Independent counterexample design | **No** |
| Code review of changes | **No** |

## Additional Rules

1. Do NOT design or execute independent counterexample tests.
2. Verify that RED receipts show a valid failing test and GREEN receipts show the
   same test passing after implementation.
3. Verify that no tests are silently skipped (`skip`, `xfail`, `it.skip`, `xit`).
4. Verify changed files stay within the declared Scope boundary.
5. Run existing related tests to confirm no regression.
6. Return PASS if all mechanical checks pass; otherwise return REPAIR with the
   specific failed criterion.

## Output

Same structured verdict as the Base Contract. The `cv_level` field must be set to `lite`.

The `failed_po_ids`, `affected_task_ids`, and `failed_criterion` fields are
required when verdict is REPAIR, even at lite level.
