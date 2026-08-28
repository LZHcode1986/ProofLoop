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
task_id: <task-id>
project_root: <canonical-trust-root>
manifest_path: .proofloop/manifests/<stage-id>.json
manifest_digest: <sha256>
plan_digest: <sha256>
proof_index_digest: <sha256>
context_ref: .proofloop/context/<context-digest>.json
context_digest: <sha256>
worker_receipt_digest: <sha256-of-current-worker-chain-tip>
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


## 当前 Evidence gate 状态（未闭合）

Runtime 的真实 CV Evidence gate 是两步、且依赖持久化事实：

```text
node packages/runtime/dist/cli/proofloop.js context prepare --role cv --stage <stage-id> --slice <slice-id> --task <task-id>
node packages/runtime/dist/cli/proofloop.js context admit-refutation-observation --role cv --stage <stage-id> --slice <slice-id> --task <task-id> --observation "<text>"
node packages/runtime/dist/cli/proofloop.js context show --role cv --stage <stage-id> --slice <slice-id> --task <task-id> --ref <pre-refutation-context-ref> --observation-ref <observation-ref>
```

`prepare` 必须先由 Brain 使用已验证的 task anchor 调用并落盘 CV Context；`context admit-refutation-observation` 是 CV-only Runtime operation，CV 在独立反驳完成且尚未读取 Evidence 时，使用 packet 的同一 `task_id` 调用；随后 CV 用 `context show --role cv --stage <stage-id> --slice <slice-id> --task <task-id> --ref <pre-refutation-context-ref> --observation-ref <observation-ref>` 读回持久化 pre-refutation Context，并以 `--observation-ref` 验证 `gate.satisfied: true`，仅此后读取 Evidence。CV 只允许这两个 Context gate operation，不调用 `stage admit-*`、Boundary 或手写 Receipt。`pre_refutation_context_ref` 与 `evidence_read: false` 只是 packet 描述，不能替代持久化 Context/observation。
当前 `RUN_CV` output 没有 `task_id`、CV Context ref 或 `worker_receipt_digest`；packet 必须显式携带可验证的 `task_id` 和当前 Worker chain tip digest，不能由 CV 猜测。closed `CV_RESULT` 没有 `task_id`/observation handoff，且 `stage admit-cv`/`admitVNextCVResult` 不读取 observation 或 `context show` 的 gate；即使 Context CLI 成功，结果也不能证明 Runtime admission 执行了该 gate。
因此当前 route 仍未闭合：缺少已验证 task/Context/observation 或 result-to-observation binding 时，CV 在读取 Evidence 前必须返回非 admission 的 `BLOCKED`，Brain 将其路由为既有 `RUNTIME_BLOCKER`（保留完整 blocker envelope），不得猜字段、继续 `stage admit-cv`，或把 direct fixture 当作 gate coverage。只有 Runtime consumer 明确绑定 observation 后，才能开放 `PASS`/`REPAIR`。
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
schema_version: 2 | 3
type: CV_RESULT
stage_id: <stage-id>
slice_id: <slice-id>
worker_receipt_digest: <sha256-of-current-worker-chain-tip>
manifest_digest: <sha256>
plan_digest: <sha256>
proof_index_digest: <sha256>
context_ref: .proofloop/context/<worker-context-digest>.json
context_digest: <sha256>
snapshot_digest: <sha256>
verification_type: initial | recheck
verdict: PASS | REPAIR
summary: <non-empty-summary>
acceptance_refs_checked: [<all-bound-acceptance-ref-ids>]
seam_refs_checked: [<all-bound-seam-ref-ids>]
oracle_refs_checked: [<all-bound-oracle-ref-ids>]
risk_refs_considered:
  - ref_id: <risk-ref-id>
    applicability: APPLICABLE | NOT_APPLICABLE
    reason: <non-empty-reason>
failed_acceptance_refs: []
invalid_tests: []
counterexamples: []
scope_violations: []
forbidden_substitutions: []
regression_failures: []
# REPAIR only: failed_criterion, failure_signature and required_recheck_scope are required.
# RECHECK only: previous_failure_signature and repair_diff_digest are required.
# schema_version 3 only: include the three slice-local binding digest fields.
```

`BLOCKED`、`REPLAN` 和 `ESCALATION_REQUIRED` 是返回 Brain 的非 admission 结果，不是可提交给 `stage admit-cv` 的 `CV_RESULT`；当前 Evidence gate 缺少真实 handoff 时必须停在该非 admission 路由。
`task_id`、CV Context ref 和 observation ref 是独立 Context gate 事实，不是 `CV_RESULT` 字段；不要为了补 handoff 向 closed result 加未知字段。

Brain 只能将 `PASS` 或 `REPAIR` 交给 Runtime admission；不得将其他结果改写为通过。
