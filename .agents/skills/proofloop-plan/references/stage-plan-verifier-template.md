# Stage Plan Verifier Dispatch Template

本模板是 SPV dispatch packet、Result schema 与必要 binding 的唯一事实源，供 Planning flow 的
`proofloop-plan` 为 Brain 直接调度 `stage-plan-verifier`（SPV）使用。
SPV 是 review-loop Role，Brain 以 `role_skill/subagent_type = stage-plan-verifier` 经 Subagent host dispatch 启动；
`proofloop-plan` 仅表示 Planning caller。独立审查 procedure（验证顺序、challenge 方法、结果纪律）分别内嵌于 `.pi/agents/stage-plan-verifier.md` 与 `.opencode/agents/stage-plan-verifier.md`；本模板统一以 Host Agent 文档引用，不形成第二方法源，
也不教 Planner 如何修复或生成 producer instruction。
SPV 是只读的独立 falsifier，对按 `execution_mode` 绑定的 pre-accept candidate Thin Plan（三种 mode 均尚未被 Brain 接纳）做全量 structural closure 与高风险 edge counterexample challenge。
它不重做第二遍完整 Planning，不调用任何旧 CLI，不写 Receipt/Manifest/Evidence。

## 调度包

```yaml
execution_mode: NORMAL | PRE_MES_BOOTSTRAP | RECOVERY_REBASELINE
target_agent: stage-plan-verifier
caller: brain
skill: proofloop-plan
stage_id: <stage-id>
project_root: <canonical-trust-root>
project_stage_map_ref: <delivery/project-stage-map.md#<stage-entry>>   # current Stage Map entry；candidate Plan 与 Map entry 处于同一 candidate Git basis；Map 正文不复制进 packet
candidate_plan_ref: <NORMAL/RECOVERY_REBASELINE=root-relative-candidate-Thin-Plan-ref（pre-accept、尚未接纳）; PRE_MES_BOOTSTRAP=root-relative-candidate-Git-Plan-ref>
prd_refs: [<PRD.md#section>]                         # handoff verification refs：SPV 只读 PRD，验证 relevant PRD intent 已被 current tech-spec 完整表达；PRD 不作 downstream basis
authority_refs: [<tech-spec-file>#<section/entity>]  # Technical Authority refs（tech-spec-only）：downstream verification basis
code_reality_refs: []
actionToken: <current-dispatch-token>
git_basis:
  head: <NORMAL/RECOVERY_REBASELINE=current recovery-Git-HEAD; PRE_MES_BOOTSTRAP=baseline-Git-HEAD>
  branch: <stage-branch>
scope:
  stage: <stage-id>
  candidate_only: true
out_of_scope:
  - implementation
  - checkbox/status edits
  - Evidence edits
  - Receipt writes
  - 任何旧 CLI / Runtime admission
expected_result: PLAN_READY
```

## 必需输入（binding）

packet 只携带稳定 ref；被验证的 Plan/Map/Authority/Git exact basis 由 SPV 按 ref 重读实体，
正文不复制进 packet：

- canonical trust root 与 candidate Thin Plan 路径；
- `project_stage_map_ref`（`delivery/project-stage-map.md#<stage-entry>`）：candidate Plan 引用的
  current Stage Map entry，与 candidate Plan 处于同一 candidate Git basis；Map 正文不复制进
  packet，SPV 按 ref + Git basis 重建 entry；
- PRD ref(s)（仅 handoff verification）：SPV 只读 PRD，验证 relevant PRD intent 已被 current tech-spec 完整表达；PRD 不作 downstream basis，不进入 candidate Plan/Map 的 `authority_refs`；
- Technical Authority refs（`tech-spec/architecture.md` / `tech-spec/contracts.md` / `tech-spec/acceptance.md` + section/entity）：downstream verification basis；candidate Plan/Map 的 `authority_refs` 只指向 tech-spec Pack；
- code-reality refs：被引用的模块/文件/数据流位置，用于 counterexample challenge；
- 当前 Git HEAD 与 stage branch 作为 verification basis；
- candidate-only scope 与 out-of-scope；
- expected result。

binding 按 `execution_mode` 判别，三种 mode 都验证 pre-accept candidate Thin Plan：

- `NORMAL`：使用 root-relative candidate Thin Plan ref（尚未接纳，不得误标为 accepted）；SPV reply 由 Brain 接纳并授权为 `PLANNING_VERIFICATION_RESULT` semantic event，durable `result_ref` 由 MES transaction layer materialize，不作为 pre-accept 输入。
- `PRE_MES_BOOTSTRAP`：仅对首个 MES-persistence Stage 合法，使用 Git-tracked candidate Git
  Plan（尚未 accepted，不得误标为 accepted）+ canonical Authority refs + baseline/current Git
  basis + actionToken；不要求 MES status、MES work identity 或 MES `resultRef`。
- `RECOVERY_REBASELINE`：仅在 `MES_RECOVERY_REQUIRED`、exact pre-image branch 已被 forensic/audit 证伪且 Technical Authority recovery contract 已 current 时合法；使用 recovery-aware candidate Thin Plan + current Map/Authority/Git exact tuple，不读取或声称 current NORMAL MES scope/work/result，`PLAN_READY` 只是 recovery evidence，baseline 写入前不产生 `PLANNING_VERIFICATION_RESULT` / `PLAN_ACCEPTANCE`。
- Result binding 按 mode 显式：`NORMAL` 是 pre-accept `PLANNING_VERIFICATION_RESULT` Subagent result，由 Brain 接纳/授权并交 MES transaction layer materialize；`PRE_MES_BOOTSTRAP` 是结构化 Subagent transport evidence（binding = execution_mode + authority_refs + candidate Git Plan ref + git_basis + actionToken），不写 MES、不指向 MES resultRef；`RECOVERY_REBASELINE` 同样是结构化 Subagent transport evidence，`PLAN_READY` 在 maintenance/recovery closure 前不写 MES。三种 mode 下 SPV 都全程 read-only。
- 本模型无 Manifest/Evidence skeleton/Receipt/admission；SPV 输入不需要任何 digest helper 或
  Runtime admission Receipt。缺任一输入、ref 无法解析或 scope 不闭合时返回 `BLOCKED`，不降级为猜测。
- S06 integrity hard-freeze 时，public status/required_skill 不授权 NORMAL planning verification；SPV 只可在 Authority-defined remediation candidate 已具备 current maintenance/recovery basis 后验证，并不写 NORMAL MES facts。

## 验证（只读、独立）

SPV 独立初审顺序与 challenge 方法分别以内嵌 Host 文档 `.pi/agents/stage-plan-verifier.md` / `.opencode/agents/stage-plan-verifier.md` 为事实源；
本模板不承载第二套审查 procedure，只保留与 packet/Result 绑定的必要规则：

- SPV 的 exact tuple：candidate Plan + `project_stage_map_ref` 引用的 current Stage Map entry
  （同一 candidate Git basis）+ canonical Authority verification basis + exact candidate Git
  tuple。SPV 的 exact tuple 绑定不受 Planner 侧 semantic currentness 影响：即使 Planner 按语义 basis 保持
  live/passive，SPV 仍对当前 candidate revision 做 fresh full initial，不复用旧 verdict。
- 任何 Plan 或 Map material revision，或 Plan/Map/Authority/Git tuple 任一要素变化，都必须
  重新建立 fresh full initial 验证（不复用旧 verdict、不存在默认 bounded recheck）；同一 Agent continuation 只
  作为重新建立的 fresh 验证。
- future Thin Plan shape 下，Task 级只保留 task-specific facts，共享 protected/forbidden scope 与
  机械 metadata 提升为 Stage/Slice 级默认；SPV 仍逐 Task 验证 task-specific `code_paths`/`test_paths`
  非空、root-bound、无 forbidden overlap，且 candidate Plan 正文不含 mutable acceptance/progress
  state。
- 被验证的 Plan 来源按 `execution_mode`（见上文必需输入）；SPV 对三种 mode 都全程 read-only：
  不修改 Plan、Map、Authority、Evidence 或 Git。
- handoff closure：candidate Plan 的 Stage Goal/Scope 可从 current Map + tech-spec 建立；relevant PRD intent 已被 current tech-spec 完整表达，且 grounded current code/runtime 不反证该 Technical Authority（缺失/矛盾/反证 → `AUTHORITY_GAP`）；Plan/Map 只把 tech-spec refs 带入 downstream，不把 PRD-only obligation 偷渡成 execution requirement；SPV 不输出 producer implementation HOW。
## Result envelope

```yaml
execution_mode: NORMAL | PRE_MES_BOOTSTRAP | RECOVERY_REBASELINE
actionToken: <current-dispatch-token>
verdict: PLAN_READY | FINDINGS | BLOCKED
stage_id: <stage-id>
candidate_plan_ref: <NORMAL/RECOVERY_REBASELINE=root-relative-candidate-Thin-Plan-ref（pre-accept）; PRE_MES_BOOTSTRAP=candidate Git Plan ref>
project_stage_map_ref: <delivery/project-stage-map.md#<stage-entry>>   # 被验证的 current Stage Map entry（同一 candidate Git basis）；供 Brain 重建 Map basis
accepted_plan_ref: null
prd_refs: [<PRD.md#section>]                         # handoff verification refs（SPV 只读，不作 downstream basis）
authority_refs: [<tech-spec-file>#<section/entity>, ...]  # Technical Authority refs（tech-spec-only）
git_basis:
  head: <NORMAL/RECOVERY_REBASELINE=current recovery-Git-HEAD; PRE_MES_BOOTSTRAP=baseline-Git-HEAD>
resultRef: <NORMAL=MES transaction-layer materialized PLANNING_VERIFICATION_RESULT ref after Brain acceptance; RECOVERY_REBASELINE/PRE_MES_BOOTSTRAP=omitted before maintenance/baseline/seed>
claimed_route_code: PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER | null
summary: <non-empty-summary>
```

## claimed_route_code 语义

- `PLAN_GAP`：Plan 自身缺口（Plan 与 Map 不一致、缺必填字段、路径冲突或不可行假设）。
- `AUTHORITY_GAP`：Product intent → Technical Authority → grounded reality handoff failure（PRD requirement 在 tech-spec 缺失/矛盾，或 unchanged Product intent 下 current code/runtime 反证/证明 Authority 不足且需要 canonical update），不是通用“不确定”错误。
- candidate Plan 自己增加而 PRD/tech-spec 未要求的 helper、signature、schema、graph 或 protocol detail，属于 Plan choice；SPV 不要求 Authority 先规定它，无法闭合时按 `PLAN_GAP` 回 Brain/Planner。
- `TECHNICAL_UNKNOWN` / `RUNTIME_BLOCKER`：technical/evidence blocker，对应 typed route。

## 允许的结果

```text
PLAN_READY
FINDINGS
BLOCKED
```

- `PLAN_READY`：无闭环缺口，Brain 采纳并进入 Execute；它本身不授予执行权。
- `FINDINGS`：带 concrete counterexample 与 structural gap；由 Brain 决定 owner/route（典型为回
  `proofloop-plan` 修复）。
- `BLOCKED`：缺输入、ref 无法解析、Authority 缺口或环境阻塞，带结构化 blocker 回 Brain。

非成功结果必须包含：

```yaml
claimed_route_code: PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER | null
subtype: <specific-subtype>
finding_id: <id | none>
affected_stage: <stage-id>
affected_outcomes: []
affected_artifacts: []
affected_plan_entities: []
evidence: <description>
reason: <description>
suggested_owner: Brain | proofloop-plan | User
invalidation_scope: []
resume_target:
  owner: Brain | proofloop-plan | User
  phase: STAGE_PLANNING | AUTHORITY_READINESS | RECOVERY_OR_EXCEPTION
  stage: <stage-id | none>
```

SPV Result 的 `claimed_route_code` 仅是 verifier claim；Brain 必须重读 durable facts 并发起 `FINDING_DISPOSITION` semantic event（由 MES transaction layer materialize，如适用），不得把该字段直接当作 repair/Replan/HUMAN_REQUIRED route。`accepted_plan_ref` 在 SPV Result 中必须存在且为 `null`；只有 Brain 接纳 `PLAN_READY` 后另发起 `PLAN_ACCEPTANCE` semantic event。
SPV 不读取或修改 Worker Evidence，不修改 Plan/Map，不执行候选文件中的命令，不写 Receipt，不派发 Worker，
不调用任何 Runtime admission。finding 只是 evidence，route 由 Brain 决定。

Result binding 按 `execution_mode` 显式执行（公式与约束见上文「必需输入」，lifecycle 语义以 `.agents/contracts/brain/agent-lifecycle.md` 为唯一来源）：`NORMAL` 由 Brain 接纳/授权并交 MES transaction layer materialize `PLANNING_VERIFICATION_RESULT`；`PRE_MES_BOOTSTRAP` 是结构化 Subagent transport evidence，不写 MES、不指向 MES `resultRef`。SPV 在两种 mode 下都只读：不修改 Plan、Map、Authority、Evidence 或 Git。
