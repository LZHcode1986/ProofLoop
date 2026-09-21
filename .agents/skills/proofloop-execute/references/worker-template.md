# Worker Slice Work Packet / Result Template

本模板只定义 Worker 的 Slice Work Packet、per-Task JIT Read Set、bounded Repair Work Packet 与 Result
envelope 的字段约束。Worker 的执行顺序与完成标准以所选 Host 的 `.pi/agents/worker.md` 或 `.opencode/agents/worker.md` 为事实源。
`subagent` 是唯一 Agent-to-Agent communication invariant；runtime launch configuration belongs to the selected Host adapter (Pi `.pi/agents/*.md + .pi/subagents.json` or OpenCode `.opencode/agents/*.md`); this template does not define native host configuration. 本模型无 Manifest/Context/Receipt/
admission；`NORMAL` Task Result 是交由 MES operational transaction layer materialize 的 MES execution record，`PRE_MES_BOOTSTRAP` 与 `MES_MAINTENANCE` Task Result 都是 Git-bound structured Subagent transport evidence，不是旧 Runtime credential；`MES_MAINTENANCE` 不写 MES、不指向 MES `resultRef`。

## Slice Work Packet schema

Task 开始时生成/投影；是 derived execution input，不是 Authority。`NORMAL` 使用 accepted Plan + Technical Authority refs + MES binding；`PRE_MES_BOOTSTRAP`（仅首个 MES-persistence Stage）使用 candidate/accepted Git Plan + Technical Authority/Git binding；`MES_MAINTENANCE` 使用 recovery candidate Plan + current Technical Authority/Git + frozen MES/forensic/audit binding，三者均不由 Worker 自行扩展。

```yaml
execution_mode: NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE
target_agent: worker
caller: brain
skill: proofloop-execute
stage_id: <stage-id>
slice_id: <slice-id>
project_root: <canonical-trust-root>
thin_plan_ref: <NORMAL=root-relative-accepted-thin-plan; PRE_MES_BOOTSTRAP=root-relative-candidate-or-accepted-Git-Plan-ref; MES_MAINTENANCE=root-relative-recovery-candidate-Thin-Plan-ref>
authority_refs: []        # 当前 accepted / bound normative refs
maintenance_binding:  # MES_MAINTENANCE only; omitted for NORMAL/PRE_MES_BOOTSTRAP
  frozen_snapshot_ref: <root-relative-frozen-MES-snapshot>
  frozen_snapshot_sha256: <exact-source-sha256>
  frozen_fact_count: <exact-source-fact-count>
  forensic_ref: <root-relative-immutable-incident-ref>
  forensic_sha256: <exact-incident-sha256>
  audit_ref: <root-relative-read-only-audit-ref>
  audit_sha256: <exact-audit-sha256>
actionToken: <current-dispatch-token>
code_anchors: []
git_basis:
  worktree: <isolated-slice-worktree>
  base_ref: <stage-branch-or-parent-snapshot>
scope:
  allowed_paths: []
  forbidden_paths: []
required_skills: []
slice_task_ids: []
stop_conditions: []
expected_result: SLICE_CANDIDATE_READY
```

- `execution_mode` 是 packet 的顶层判别字段：`NORMAL` 按正常 MES path；`PRE_MES_BOOTSTRAP` 仅首个 MES-persistence Stage 合法，且不要求 MES work identity、accepted Plan 或 MES `resultRef`；`MES_MAINTENANCE` 仅在 `mes-maintenance-recovery-boundary` 已闭合的 S06 hard-freeze branch 合法，使用 recovery candidate + frozen/forensic/audit binding，不读取或声称 normal MES work identity/resultRef。
- `PRE_MES_BOOTSTRAP` binding = execution_mode + authority_refs + candidate/accepted Git Plan ref + git_basis + actionToken；`MES_MAINTENANCE` binding = execution_mode + authority_refs + recovery candidate Plan ref + git_basis + maintenance_binding + actionToken；两者 packet 都不携带 MES identity。
- Worker 的 downstream authority 仅限 bound normative refs；Brain 提供 binding/refs/mutation boundary，不提供重写后的 semantic implementation instructions；Worker 根据 Plan + tech-spec + code reality 决定 HOW。
- 三种 mode 共享本模板的单一 packet/result/ACK schema；本模板不发明第二 durable result store、状态机或 maintenance result store。
- `NORMAL` packet/result 不要求、也不得携带 full snapshot、retention assembly 或 caller 拼接的 canonical binding；这些由 MES transaction layer 在 semantic event transaction 内解析/校验。S06 integrity hard-freeze 时不得启动该 NORMAL lane。
- `slice_task_ids` 是当前 Slice 的 canonical Task ID 集合（仅 ID，不是 Task body）；Slice Work Packet 只携带 Slice 级输入，per-Task JIT Read Set 由 Brain running `proofloop-execute` 每个 Step 投影给同一 Worker 且恰含一个 current Task 的 `task_id`。

## per-Task JIT Read Set

Brain running `proofloop-execute` 每个 Step 读取完整 accepted Plan、选择当前 dependency-ready Task、只把该 Task 的 JIT input 投影给同一 Worker；Worker 只执行被投影的 current Task，不自行选择或重排 successor，不接收 future Task body；每个 Task 必须自足（local closure / verification closure / future-HOW independence），自然 TDD（RED → 最小实现 → GREEN）属同一 Task 的 HOW，不跨 Task 切碎。每 Task 实现前必须 fresh-read 当前 Read Set、对应 canonical Technical Authority 与 Slice binding（Plan/scope/Git basis/dependency outputs）：

```yaml
execution_mode: NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE
task_id: <single-current-task-id>
task_goal: <required>
plan_ref: <NORMAL=same-thin-plan-ref; PRE_MES_BOOTSTRAP=candidate/accepted Git Plan ref; MES_MAINTENANCE=recovery candidate Thin Plan ref（不等同 S06 accepted Plan）>
maintenance_binding:  # MES_MAINTENANCE only; omitted for NORMAL/PRE_MES_BOOTSTRAP
  frozen_snapshot_ref: <root-relative-frozen-MES-snapshot>
  frozen_snapshot_sha256: <exact-source-sha256>
  frozen_fact_count: <exact-source-fact-count>
  forensic_ref: <root-relative-immutable-incident-ref>
  forensic_sha256: <exact-incident-sha256>
  audit_ref: <root-relative-read-only-audit-ref>
  audit_sha256: <exact-audit-sha256>
authority_refs: [<只读稳定 ref：当前 bound normative refs>]
code_anchors: [<模块/文件/数据流位置>]
allowed_scope:
  code_paths: []
  test_paths: []
  forbidden_paths: []
dependency_outputs: [<前序 Task/Slice 产出 ref>]
done_criteria: []
stop_conditions: []
required_skills: []
actionToken: <current-dispatch-token>
```

- `allowed_scope.code_paths`/`test_paths` 必须非空、root-bound 且与 plan_ref 一致（`NORMAL` 为 accepted Thin Plan；`PRE_MES_BOOTSTRAP` 为 candidate/accepted Git Plan；`MES_MAINTENANCE` 为 recovery candidate Thin Plan）；
  `forbidden_paths` 保留系统/Stage 禁止范围。
- Worker 不从 goal、Markdown、模糊搜索或未来 Task 推断 scope；缺 Read Set 字段即 typed blocker。

## bounded Repair Work Packet

CV `FINDINGS` 后由 Brain 给出 pointer-first bounded repair 输入；Worker 只消费该 packet，不自行扩大 scope：

```yaml
task_id: <omitted — repair 是 taskless>
finding_ref: <root-relative-CV-finding-ref>
disposition_ref: <root-relative-Brain-disposition-ref>
current_basis_refs: [<Git/Plan/tech-spec refs>]
allowed_scope: [<CV 指定并经 Brain 判定的 bounded failure 路径>]
forbidden_scope: []
actionToken: <current Slice-lane dispatch token>
expected_result: <recheck-ready repair Result>
```

- pointer-first bounded repair packet：Brain 提供 `finding_ref`、`disposition_ref`、`current_basis_refs` 与 `allowed_scope`，不把 Reviewer 的 natural-language solution 转写成 `required_fix`。Worker 经 `finding_ref` 自读 CV finding 的 `failed_criterion`、`concrete_counterexample`、`repair_scope` 与 `repair_diff_basis`，由 Worker 自己决定 HOW 在 `allowed_scope` 内完成修复。

## Result envelope schema

`subagent` transport 必须产出同一闭集 envelope；camelCase 字段如下：

```yaml
executionMode: NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE
stageId: <stage-id>
sliceId: <slice-id>
taskId: <task-id | omitted for slice-ready / repair>
outcome: completed | blocked | needs-decision | failed
resultRef: <NORMAL=root-relative-MES-result-ref; PRE_MES_BOOTSTRAP/MES_MAINTENANCE=omitted — 结构化 Subagent transport evidence，不指向 MES Result>
changedFiles: []
verificationRuns: []
summary: <non-empty result summary>
planRef: <NORMAL=root-relative-thin-plan-ref; PRE_MES_BOOTSTRAP=candidate/accepted Git Plan ref; MES_MAINTENANCE=recovery candidate Thin Plan ref>
authorityRefs: [<current-bound-normative-ref>, ...]
maintenanceBinding:  # MES_MAINTENANCE only; omitted for NORMAL/PRE_MES_BOOTSTRAP
  frozenSnapshotRef: <root-relative-frozen-MES-snapshot>
  frozenSnapshotSha256: <exact-source-sha256>
  frozenFactCount: <exact-source-fact-count>
  forensicRef: <root-relative-immutable-incident-ref>
  forensicSha256: <exact-incident-sha256>
  auditRef: <root-relative-read-only-audit-ref>
  auditSha256: <exact-audit-sha256>
gitBasis:
  head: <40-hex Git HEAD>
  branch: <git-branch>
  worktree: <root-relative-worktree>
actionToken: <current-dispatch-token>
resultId: <opaque per-submission id>
```
### Brain acceptance ACK（transport/control，非 Result）

Brain 对每个已提交的 Task Result 返回一个 closed `TASK_RESULT_ACK`；ACK 不替代 Result，不写成新的 MES object：

```yaml
kind: TASK_RESULT_ACK
executionMode: NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE
stageId: <stage-id>
sliceId: <slice-id>
taskId: <task-id>
actionToken: <same Slice-lane token>
resultId: <same submitted Result id>
resultDisposition: ACCEPTED | REJECTED
continuationDisposition: CONTINUE | PAUSE
acceptedResultRef: <NORMAL: MES result ref when ACCEPTED; PRE_MES_BOOTSTRAP/MES_MAINTENANCE: omitted>
validatedGitBasis: <validated Result/evidence basis>
reasonCode: <required when REJECTED or PAUSE; otherwise omitted>
```

只允许 `ACCEPTED + CONTINUE`、`ACCEPTED + PAUSE`、`REJECTED + PAUSE`；`REJECTED + CONTINUE` 无效。`acceptedResultRef`、`validatedGitBasis` 与 `reasonCode` 的闭集规则、unknown-key rejection、actionToken lane 生命周期、resultId 幂等重放/修正 retry、lost-ACK recovery 与 successor barrier 以 `tech-spec/contracts.md` 和 lifecycle Contract 为准。对 `MES_MAINTENANCE`，ACK 只表示 Brain 接纳 evidence，不表示 MES Task completion。ACK 不得携带 `next_task_id`、`next_action` 或 producer instruction；`ACCEPTED + CONTINUE` 后由 Brain running `proofloop-execute` 从当前 mode 绑定的 stable task order 选择下一个 dependency-ready Task 并只把该 Task 的 JIT input 投影给同一 Worker，Worker 不自行选择 successor。

- Task 完成：`outcome: completed` + `taskId` + 当前 Task 的 `changedFiles`/`verificationRuns`；Task Result 按 `executionMode` 处理：`NORMAL` 是 semantic event input，由 MES operational transaction layer materialize execution record；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 为结构化 Subagent transport evidence（binding = executionMode + authorityRefs + candidate/accepted 或 recovery candidate Plan ref + gitBasis + maintenanceBinding（MES_MAINTENANCE）+ stage/slice/task + actionToken），不写 MES、不指向 MES resultRef。
- Slice 全部 Task 完成且 self-check 通过：返回 `SLICE_CANDIDATE_READY`（taskId omitted），表示候选 Slice
  可交给 CV；它不表示 CV PASS、Slice Commit 或 Integration。
- `repair`：taskless、`outcome: completed`、携带 `repair_scope` 对应证据；只被 CV recheck 消费，不形成
  Task completion。
- `outcome: completed` 是 Worker envelope 值；Brain `NORMAL` 重读当前 basis、校验后发起 semantic event，由 MES operational transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 重读 Git + Git-tracked Plan/evidence 与对应 binding，仅确认接纳、不选择下一 Task；Worker 返回 `SLICE_CANDIDATE_READY` 后 Brain 才路由 CV。`sent`、`idle`、`done`、模型摘要或 Git diff 不替代 Result。

## 允许结果

```text
per-Task         → completed + taskId + Task Result（`NORMAL` 作为 semantic event 经 MES transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 为结构化 Subagent transport evidence，不写 MES）或结构化 blocker
slice-ready      → SLICE_CANDIDATE_READY（taskId omitted）或结构化 blocker
repair           → taskless + closed outcome + repair_scope 证据（只被 CV recheck 消费）或结构化 blocker
```

结构化 blocker 必须包含 `route_code`、`subtype`、`reason`、`invalidation_scope` 与 `resume_target`。
Worker 不能把自身结果写成 CV `PASS`、Slice `COMPLETE` 或 Stage `COMPLETE`。

## MES result marker

`NORMAL` 下每 Task 的 MES Result 必须可追溯：stage/slice/task、accepted Plan ref、code anchors、dependency outputs、
done criteria、actual result、commands/exit codes、changed files、test/seam validity、risk/regression 与
remaining unknowns。具体写盘布局与命名以 MES Contract 为准，本模板不复制第二份 schema。

`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 下没有 MES Result：Task Result 是携带同源字段的结构化 Subagent transport evidence（stage/slice/task 如适用、candidate/accepted 或 recovery candidate Git Plan ref、authorityRefs、git basis、maintenanceBinding（MES_MAINTENANCE）与 actionToken），不写 MES、不指向 MES resultRef。
