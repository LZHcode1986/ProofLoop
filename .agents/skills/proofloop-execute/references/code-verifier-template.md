# Code Verifier 派发模板

本模板供 `proofloop-execute` 由 Brain 直接调度 Code Verifier 使用。

## 派发数据包

```yaml
target_agent: code-verifier
caller: brain
skill: proofloop-execute
contract_mode: vnext-template
verification_type: initial | recheck
stage_id: <stage-id>
slice_id: <slice-id>
project_root: <canonical-trust-root>
manifest_path: .proofloop/manifests/<stage-id>.json
manifest_digest: <sha256>
plan_digest: <sha256>
proof_index_digest: <sha256>
context_ref: .proofloop/context/<context-digest>.json
context_digest: <sha256>
snapshot_digest: <sha256>
pre_refutation_context_ref: .proofloop/context/<pre-refutation-digest>.json
evidence_ref: delivery/stages/<stage-id>/evidence/<slice-id>.md
evidence_read: false
goal_ref: <ref-id>
acceptance_refs: []
seam_refs: []
oracle_refs: []
risk_refs: []
changed_files: []
diff_ref: <ref>
tests_ref: <ref>
previous_failure_signature: null
repair_diff_digest: null
required_recheck_scope: []
forbidden_scope:
  - source edits
  - test edits
  - tasks.md edits
  - Evidence edits
  - Receipt writes
  - commits
expected_results:
  - PASS
  - REPAIR
  - REPLAN
  - BLOCKED
  - ESCALATION_REQUIRED
```

## vNext 验证规则

- 不使用 `cv_level`、CV Profile 或 Proof Profile；
- Initial CV 必须 fresh；
- 必须先读取 Authority/Proof Index、代码、测试、diff 和 snapshot；
- 在独立反驳观察固定前，`evidence_read` 必须保持 `false`；
- 只有反驳完成后才允许读取 Worker Evidence；
- `REPAIR` 必须带失败标准、failure signature 和 bounded recheck scope；
- `REPLAN`、`BLOCKED`、`ESCALATION_REQUIRED` 返回 Brain，不直接 admission；
- CV 是只读的，不修改任何项目文件。

## 允许的结果

```yaml
verdict: PASS | REPAIR | REPLAN | BLOCKED | ESCALATION_REQUIRED
slice_id: <slice-id>
snapshot_digest: <sha256>
manifest_digest: <sha256>
plan_digest: <sha256>
proof_index_digest: <sha256>
context_digest: <sha256>
verification_type: initial | recheck
acceptance_refs_checked: []
seam_refs_checked: []
oracle_refs_checked: []
risk_refs_considered: []
failed_acceptance_refs: []
invalid_tests: []
counterexamples: []
scope_violations: []
forbidden_substitutions: []
regression_failures: []
failed_criterion: <required for REPAIR, otherwise null>
failure_signature: <required for REPAIR, otherwise null>
required_recheck_scope: []
```

Brain 只能将 `PASS` 或 `REPAIR` 交给 Runtime admission；不得将其他结果改写为通过。
