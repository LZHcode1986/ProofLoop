# Worker Packet / Result Template

本模板只定义 Worker packet、Result envelope、字段约束和 Runtime handoff。Worker 的执行顺序与
Evidence 行为以 `.agents/skills/proofloop-worker/SKILL.md` 为唯一事实源；`herdr-link` Host relay 的
Session/transport 适配以 `herdr-worker-template.md` 为准。

## Dispatch packet schema

```yaml
target_agent: worker
caller: brain
skill: proofloop-execute
skill_ref: .agents/skills/proofloop-worker/SKILL.md
contract_mode: vnext-template
mode: implement-task | recover-task | finalize-slice | repair
stage_id: <stage-id>
slice_id: <slice-id>
task_id: <single-current-task-id | omitted for finalize-slice | repair>
project_root: <canonical-trust-root>
manifest_path: .proofloop/manifests/<stage-id>.json
manifest_digest: <sha256>
plan_digest: <sha256>
context_ref: .proofloop/context/<context-digest>.json
context_digest: <sha256>
repairs_cv_receipt_digest: <sha256> # only mode: repair; taskless Context
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
expected_result: TASK_COMPLETE | READY_FOR_CV | REPAIR_HANDOFF
              # mode: repair → REPAIR_HANDOFF：结果只被 CV recheck 消费，永不形成 TASK_COMPLETE
host_relay:
  transport: herdr-link | subagent
  profile_ref: herdr-worker | subagent-worker
  agent_kind: agy # herdr-link route only
  # worker_session_ref is ephemeral and never persisted
```

## Packet invariants

- `implement-task`/`recover-task` 有且仅有一个 `task_id`；`finalize-slice`/`repair` 为 taskless Context。
- `implement-task`/`recover-task` 的 `execution_scope.kind`、`code_paths`、`test_paths` 和
  `allowed_code_scope` 必须非空、root-bound 且与 Context/Manifest/Plan digest 完全一致；
  `evidence-only` 不得路由为 `implement-task`。
- `plan_projection_path` 必须等于 admitted `Manifest.plan.ref` 的 root-bound 路径；
  `scope.mutable_projection_paths` 只能列该 path，`scope.allowed_paths` 还须包含 code/test、当前
  Slice Evidence 和该 projection path。`repair` 例外：其 `scope.mutable_projection_paths` 为空，
  因为 repair 只改实现代码、不编辑 Plan projection，其结果不可 admit 所以任何 checkbox 不得移动。
- `allowed_code_scope` 只能是 `execution_scope.code_paths ∪ test_paths`，不能包含 Evidence、
  `tasks.md` 或 Plan projection。
- `scope.forbidden_paths`、`execution_scope.forbidden_paths` 和 `forbidden_scope` 必须保留系统/Task
  禁止范围；Worker 不从 goal、Markdown、模糊搜索或未来 Task 推断 scope。
- `previous_task_receipts` 必须逐项绑定 Task、Evidence path、source/current snapshot 和 result；
  `slice_task_ids`/`completed_task_ids` 只能来自 Runtime Context。
- Worker 必须先写/更新允许的 Task Evidence，再更新 checkbox/Worker Status；`tasks.md` 只能改
  Context 允许的 mutable projection，不得改 Goal、refs、Dependencies、Required Skills、Proof Index、
  `execution_scope`、其他 Task/Slice 或 candidate input。
- Worker 不写 Receipt、Current CV Status、Gate/Review verdict，不提交 Git，不修改 Manifest/Context
  authority；immutable Plan/Manifest/Context/snapshot mismatch 必须 fail closed。
- `repair` 必须 taskless、携带 `repairs_cv_receipt_digest`，只修复 CV 指定 bounded failure；普通
  `stage admit-worker` 不接纳 repair envelope。Repair 的诊断/复现/根因/验证顺序由 Worker Skill 负责。

## Result envelope schema

`herdr-link` 和 `subagent` 两条 transport 必须产出同一闭集 envelope；camelCase 字段名如下：

```yaml
schemaVersion: 2
actionToken: <current-runtime-action-token>
stageId: <stage-id>
sliceId: <slice-id>
taskId: <task-id | omitted>
mode: implement-task | recover-task | finalize-slice | repair
outcome: completed | blocked | needs-decision | failed
evidenceRef: <root-relative-evidence-ref>
changedFiles: []
verificationRuns: []
summary: <non-empty result summary>
manifestDigest: <sha256>
planDigest: <sha256>
proofIndexDigest: <sha256>
snapshotDigest: <40-hex Git HEAD>
contextRef: <root-relative-context-ref>
contextDigest: <sha256>
repairsCvReceiptDigest: <sha256> # only mode: repair; forbidden otherwise
```

- `outcome: completed` 是 Worker envelope 值；Runtime admission 才形成 `TASK_COMPLETE`。
- `finalize-slice` 必须 taskless，`evidenceRef` 指向当前 Slice Evidence，并返回 `READY_FOR_CV` 语义；
  它不表示 CV PASS、Slice Commit 或 Integration。
- `repair` 必须 `mode: repair`、`taskId` omitted、当前 `repairsCvReceiptDigest`；`outcome` 仍使用上述
  Runtime closed set，由 `mode` 与 digest 表示 repair handoff；该结果不进入 `stage admit-worker`。
- `actionToken`、所有 digest、`evidenceRef` 和 `changedFiles` 都是候选事实；Brain 必须重读 Evidence、
  tasks projection、Context、Git HEAD/diff 和相关 Receipts，再交给 Runtime consumer。
- Host lifecycle、模型摘要、Link delivery 或 `git diff` 不能替代 envelope，也不能加入 Runtime-owned
  Receipt/Manifest/Context 字段。

## Runtime handoff

```text
implement-task / recover-task + completed
  → Brain re-read durable facts
  → stage admit-worker
  → Runtime computes next action

finalize-slice + completed
  → Brain re-read Slice Evidence/binding
  → Runtime accepts READY_FOR_CV
  → fresh Code Verifier

repair + completed/blocked/needs-decision/failed
  → Brain re-read repair evidence and binding
  → stage next validates the repair handoff by mode + digest
  → Runtime sets PENDING_RECHECK or returns typed blocker
  → fresh bounded CV recheck
```

缺失、截断、重复、错 action、错 digest、错关联或 schema 失败时，Brain 返回 typed blocker 并按
lifecycle/execute recovery；不重发、不补写、不以 `status: sent` 或 Agent `done` 代替 admission。

## Task Evidence marker

每个 Task Evidence 小节标题必须是该 Task 的唯一 `### <task_id>`；Task 内子记录使用 `####` 或
`- label:`，不得再用 `###`。Evidence 至少覆盖 packet 指定 PO 的 expected/actual、commands/exit
codes、changed files、test/seam/oracle validity、risk/regression 和 remaining unknowns；详见
`proofloop-worker/SKILL.md`。Runtime admission 会拒绝缺失、重复或仍为 skeleton/placeholder 的标题。

## 允许结果

```text
implement-task / recover-task → TASK_COMPLETE 或结构化 blocker
finalize-slice              → READY_FOR_CV 或结构化 blocker
repair                       → mode: repair + closed outcome + repairsCvReceiptDigest（handoff，不经 stage admit-worker）或结构化 blocker
```

结构化 blocker 必须包含 `route_code`、`subtype`、`reason`、`invalidation_scope` 和 `resume_target`。
Worker 不能把自身结果写成 CV `PASS`、Slice `COMPLETE` 或 Stage `COMPLETE`。
