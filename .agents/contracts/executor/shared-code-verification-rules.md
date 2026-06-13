# Executor Shared Code Verification Rules

Default review skills:
- code-review-and-quality
- security-and-hardening, when user input, auth, storage, or external integration is touched

Verification requirements:
- Verify only the assigned slice or gate.
- Use only the supplied gate fields and covered Worker evidence.
- Inspect boundary receipts and actual diffs for every covered Worker attempt.
- Follow the Evidence Protocol.
- Do not implement fixes.
- Do not commit.
- Do not update normal implementation task checkboxes.
- On pass, update only the assigned verifier gate checkbox.

Return contract:
- Return exactly Verification passed or Verification failed.
- On failure, include Severity, Failed criteria, Evidence, and Minimal repair instruction.
