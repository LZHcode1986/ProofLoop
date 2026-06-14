# Executor Shared Code Verification Rules

Verification requirements:
- Verify only the assigned slice or verifier gate.
- Use only the supplied gate fields, task packets, boundary receipts, changed files, diffs, and verification commands.
- Inspect boundary receipts and actual diffs for every covered Worker attempt.
- Do not implement fixes.
- Do not commit.
- Do not update normal implementation task checkboxes.
- On Verification passed, update only the assigned x.V verifier gate checkbox.
- On Verification failed, leave the assigned x.V verifier gate checkbox unchecked.
- On recheck, verify only the previous failed criteria, repair diff, new boundary receipt, and necessary regression scope.
- Do not redo full slice verification unless the repair changed the slice boundary, acceptance criteria mapping, allowed scope, or invalidated the original verification context.

Review skill usage:
- Review skills are not default shared behavior.
- Initial Code Verification may use review skills only when Executor explicitly includes them in the current dispatch packet.
- Recheck should not load review skills unless the previous failure specifically requires skill-based review to verify the repair.
- Task Required Skills are evidence metadata only and do not authorize Code Verifier to load Worker skills.

Return contract:
- Return exactly one of:
  - Verification passed
  - Verification failed
  - Verification blocked
- On pass, include x.V checkbox confirmation.
- On failure, include Severity, Failed criteria, Evidence, and Minimal repair instruction.
- On blocked, include missing context or runtime blocker details.
