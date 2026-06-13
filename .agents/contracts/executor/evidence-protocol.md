# Executor Evidence Protocol

Dedicated evidence files are not required by default.

Canonical evidence channels:
- Worker required skills evidence
- Worker TDD evidence
- verification command outputs
- git boundary receipts
- diff inspection results

Persistent evidence artifacts:
- Produce only when the assigned task explicitly requires them.
- Store additional persistent artifacts under output/changes/<change-name>/.
- Do not require persistent evidence artifacts when canonical evidence is sufficient.

Verifier rule:
- Worker summaries are claims.
- Boundary receipts, diffs, tests, and command outputs are evidence.
