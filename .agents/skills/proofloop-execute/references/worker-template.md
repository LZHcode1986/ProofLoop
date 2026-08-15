# Worker 派发模板

本模板供 `proofloop-execute` 由 Brain 直接调度 Worker 使用。

## 派发数据包

```yaml
target_agent: worker
caller: brain
skill: proofloop-execute
contract_mode: vnext-template
mode: implement-task | recover-task | finalize-slice | repair
stage_id: <stage-id>
slice_id: <slice-id>
task_id: <single-current-task-id | null for finalize-slice>
project_root: <canonical-trust-root>
manifest_path: .proofloop/manifests/<stage-id>.json
manifest_digest: <sha256>
plan_digest: <sha256>
context_ref: .proofloop/context/<context-digest>.json
context_digest: <sha256>
snapshot_digest: <sha256>
evidence_path: delivery/stages/<stage-id>/evidence/<slice-id>.md
plan_projection_path: delivery/stages/<stage-id>/tasks.md
scope:
  allowed_paths: []
  mutable_projection_paths: []
  forbidden_paths: []
slice_task_ids: []
completed_task_ids: []
previous_task_receipts: []
current_task_goal: <required for task modes>
execution_scope:
  kind: implementation | evidence-only
  code_paths: []
  test_paths: []
  forbidden_paths: []
required_skills: []
allowed_code_scope: []
forbidden_scope: []
stop_conditions: []
expected_result: TASK_COMPLETE | READY_FOR_CV
```

## 必需规则

- `implement-task`、`recover-task` 必须只有一个 `task_id`；
- `implement-task` 必须携带与 Context/Manifest 完全一致的 immutable `execution_scope`；
  `code_paths`、`test_paths` 和 `allowed_code_scope` 非空且 root-bound，不能只有
  Evidence path；`evidence-only` scope 不能路由为 `implement-task`；
- `plan_projection_path` 必须等于 admitted `Manifest.plan.ref` 的 root-bound 路径；
  `scope.mutable_projection_paths` 必须只列出该 path，`scope.allowed_paths` 必须包含
  code/test paths、当前 Slice Evidence path 和该 Plan projection path；
- `allowed_code_scope` 只能是 `execution_scope.code_paths` 与 `test_paths` 的并集，
  不得包含 `plan_projection_path`、Evidence path 或其他 `tasks.md` 路径；
- 不提供未来 Task 正文或完整 `tasks.md`；
- `previous_task_receipts` 必须逐项绑定 evidence path、source/current snapshot 和 result；
- Worker 必须先写 Task Evidence，再更新 checkbox projection；
- Worker 只能修改当前 Slice 的实现范围、当前 Task 的 checkbox/Worker Status
  projection 和指定 Evidence sections；`tasks.md` 不是 implementation code scope；
- `tasks.md` 禁止修改 Stage/Slice/Task goal、refs、dependencies、required_skills、
  `execution_scope`、Proof Index、entity markers、其他 Task/Slice 或 candidate input；
- 若 immutable Plan 内容发生变化，或 Context/packet 的 `plan_digest` 不匹配 admitted
  Plan/Manifest，必须 fail closed 并返回 bounded blocker，不得继续或自行修复 Plan；
- Worker 不写 Receipt、Current CV Status、Gate verdict，不提交 Git；
- `finalize-slice` 只更新 Current Slice Evidence，不能修改实现或 checkbox；
- repair 只能修复 CV 指定的 bounded failure；repair 派发必须要求加载
  `diagnose` 技能（复现 → 根因隔离 → bounded 修复 → 验证）。

## 允许的结果

```text
implement-task / recover-task → TASK_COMPLETE 或结构化 blocker
finalize-slice / repair → READY_FOR_CV 或结构化 blocker
```

结构化 blocker 必须包含 `route_code`、`subtype`、`reason`、
`invalidation_scope` 和 `resume_target`。Worker 不得把自身结果写成 CV PASS、Slice COMPLETE 或 Stage COMPLETE。

## 恢复

同 Slice 且 semantic input digest 未变时可以继续原 Worker session；session
丢失时 Brain 从 Manifest、Context、Plan projection、Evidence、Git 和
Receipts 构造 fresh packet。`recover-task` 只负责已存在成果的 Evidence/checkbox
一致性重检：必须携带与当前 Context/Manifest/Plan/snapshot 绑定的 recovery
discriminator，Runtime Result admission 必须能区分 recovery consistency recheck
与新的 implementation，不得静默改写为 `implement-task`；没有可持久化、可校验的
discriminator 时必须返回 `RUNTIME_BLOCKER`，不得绕过，也不得重新实现已存在的
代码。session ID 不得进入任何持久化制品。
