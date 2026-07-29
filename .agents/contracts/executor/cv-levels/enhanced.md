# CV Level Profile: Enhanced

**Base Contract:** `.agents/contracts/executor/code-verifier.md`

This profile extends the Base CV Contract with enhanced-level verification scope.
All Base Contract rules apply. This document specifies only the enhanced-specific
additions over the standard profile.

## Inheritance

Enhanced includes all standard-level domains plus the additions below.

## Scope

Enhanced verification is used when:

- Risk Policy minimum is `enhanced`
- Actual diff is **broad** (multiple modules, architectural change)
- Dependency change (npm, pip, cargo, etc.)
- High-risk slice affecting security, data integrity, or core infrastructure

## Verification Domains (Enhanced)

| Domain | Required |
|---|---|
| All standard-level domains | Yes |
| Fault injection testing | Yes |
| Clean snapshot verification | Yes |
| Concurrency / permission / migration / recovery special audits | Yes |
| Mutation testing or isolated environment when necessary | Yes |

## Additional Rules

1. **Fault injection**: introduce controlled failures (network errors, disk full,
   permission denied, invalid config) and verify graceful degradation.

2. **Clean snapshot verification**: verify the slice produces the correct result
   starting from a clean state (fresh clone, no prior artifacts).

3. **Special audits**:
   - Concurrency: thread safety, race conditions, deadlocks, atomicity.
   - Permissions: authorization boundaries, least privilege.
   - Migration: forward/backward data migration correctness.
   - Recovery: crash recovery, idempotency, rollback.

4. **Mutation testing** or isolated environment testing when the risk profile
   warrants it. Verify that the test suite catches intentional defects.

5. Return PASS only if all counterexample and fault injection attempts fail,
   clean snapshot passes, and special audits find no defects.

## Output

Same structured verdict as the Base Contract. The `cv_level` field must be set to `enhanced`.

## Risk Escalation

If enhanced-level verification reveals a risk that exceeds CV scope (security
boundary, safety-critical, compliance, or human judgment required), return
`ESCALATION_REQUIRED` with a detailed explanation of what human review is needed.
