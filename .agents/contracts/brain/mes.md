# MES Execution Facts Contract

`PROJECT_READY` 是绑定自身 planned Stage set 与 delivery/planning basis 的 durable delivery history；它关闭当前 cycle，但不把仓库置于永久终态。后续 cycle 的 facts 可以共存，current workflow state 由 Brain 按新 Routing Boundary 与当前 facts 判断。
MES（内部执行管理层）是 ProofLoop 唯一 operational execution state / record / traceability 事实源。MES operational transaction layer 是唯一 normal durable state mutator：它读取 current root-bound state、校验 semantic event、materialize facts/relations、保留无关历史、闭合 binding/relation、幂等并 atomic persist；`MesSnapshotStore` 只是内部 persistence primitive。MES 不做 Product/Technical reasoning，不复制 canonical Authority 或 Host Role document 正文，不生成 next action，不代替 Brain route/dispatch，也不充当新的 Gate / Receipt 系统。Project Stage Map（`delivery/project-stage-map.md`）是 Git-tracked execution-owned planning artifact，由 Planner 拥有；MES 只持有 Stage operational facts，不维护 Stage graph，不生成 next action 或 Stage selection 决策。Brain/Host 是 semantic event initiator / authorization owner，不组装完整 snapshot；Host Role/phase documents 决定方法；canonical sources / Result / Finding / Git 决定什么是真的。

- S06 integrity incident 时，Brain 必须把 hard-freeze 作为高优先级 recovery/integrity blocker：public `status` 的 `EXECUTE` projection 仅 observation，不能授权 dispatch；`.proofloop/mes` directory quarantine 后，所有 NORMAL operational writes 禁止，直到 Authority-defined maintenance/recovery seam 与后续 controlled recovery 闭合。
## MES 事实类别

```text
Project
Stage
Slice
Task
Work（Agent dispatch / work identity）
Result（structured execution record）
Finding（quality / exception）
Plan binding（candidate → planning verification；accepted Plan → Work）
PLANNING_VERIFICATION_RESULT（pre-accept SPV durable fact）
PLAN_ACCEPTANCE（Brain after PLAN_READY）
FINDING_DISPOSITION（Brain-owned arbitration）
Git candidate / integration ref
`Git candidate / integration ref` 在 NORMAL 可作为 MES operational fact；`MES_MAINTENANCE` 下同类 commit/ref 只保留为 Git + Git-tracked Plan evidence，不写入 MES。
Review outcome / terminal relation（复用 Result/Finding/Stage owners；非独立 fact kind）
Exception / recovery
recovery_baseline（仅经 maintenance/recovery seam 授权、由 MES transaction layer materialized 的 disaster re-baseline incident / epoch）
PROJECT_READY
```

`PROJECT_READY` 的 terminal relation 是 fact-kind-specific：每个 terminal 保存或绑定自己的 planned Stage set 与 delivery/planning basis，并只对该集合验证 accepted-stage support。历史 terminal 不因后续 cycle 的 accepted Stage 变为失效；新的 terminal 可在新的 basis 上独立产生。
`delivery_cycle_id` 是同一 delivery cycle 的 durable identity：Brain 在 NORMAL Propose 完成时生成，candidate/accepted Plan binding 及其 downstream facts 与 `PROJECT_READY` 精确复用；相同 planned set 的不同 cycle 不得由 status 合并。scope-role 与 Review result binding 的 normative semantics 由 `tech-spec/architecture.md#/entities/delivery-cycle-semantics` 与 `tech-spec/contracts.md#/entities/review-result-contract` 持有，本 Contract 只约束 MES 写回与 status 观察。
新 NORMAL `PLANNING_VERIFICATION_RESULT` / `PLAN_ACCEPTANCE` facts 必须携带 stage-only `scope.stage_id`；旧 retained planning facts 缺 scope 或 cycle ID 时仅作 legacy history，不参与 current scope。plan-bound facts 的 cycle ID 位于 `plan_binding`，`project_ready` 的 cycle ID 位于顶层 payload（terminal 仍拒绝 `scope`/`plan_binding`）；唯一 in-flight Stage 必须由同 cycle 且尚无同 cycle accepted-stage support 的唯一 planning/downstream candidate 证明，缺失或重复时 status fail closed。
`MES_RECOVERY_REQUIRED` is a typed Brain recovery/integrity blocker/subtype for a seeded NORMAL snapshot whose exact pre-image is unavailable. It is not `PRE_MES_BOOTSTRAP`, not a new phase, and not a product decision. Brain must first preserve root-bound forensic incident/audit artifacts and run a read-only relational audit; no missing fact may be fabricated. Runtime remediation must not use the unsafe NORMAL writer; it requires the Authority-defined maintenance/recovery seam.

A legal recovery baseline is one atomic `recovery_baseline` semantic transaction materialized by the MES operational transaction layer after maintenance/recovery closure. Its source snapshot SHA-256 and fact count must match the exact observed pre-write snapshot, forensic/audit refs must be re-readable with matching digests, and `preimage_status` must be `UNRECOVERABLE`. The fact creates a recovery epoch, not a delivery cycle; the next NORMAL Propose generates the next `delivery_cycle_id`. Retained facts remain legacy/history-only and cannot authorize current scope, accepted support or `PROJECT_READY` until fresh rehydrate + relational audit proves their use.

The controlled recovery transaction is idempotent and fail-closed. Stale source, invalid/ambiguous refs, conflicting epoch, unknown fields or relation ambiguity is no-write. It is the only supported way to leave `MES_RECOVERY_REQUIRED`, but it is not available until maintenance/recovery implementation, exact regressions, independent verification/review and fresh candidate/SPV close; no stash/reset/checkout/rollback, hidden-session reconstruction, silent snapshot replacement or `PRE_MES_BOOTSTRAP` fallback is allowed. After the transaction, immediately re-quarantine, fresh rehydrate/audit/restart, then Brain chooses the affected Stage/cycle `resume`, `replan` or `restart`; changed Authority/Plan/Map/Git basis requires fresh Planner/SPV.

**Affected Stage/cycle continuation（语义与 no-write 条件以 `tech-spec/contracts.md` §2.2.4a 为准）：** `resume` 沿用 current generation，不写任何 planning fact；`replan`（Authority/Plan/Map/Git tuple 变化）依次经过 fresh Planner、candidate Git boundary 与 fresh full initial SPV，再由 transaction layer 在同一 `delivery_cycle_id` 内追加一代；`restart`（Planning tuple 未变）不新增代，受影响的 Slice 换 fresh Work identity 重开 lane，上一 attempt 的 facts 只作历史、不足以支撑新 attempt 的 completion/Integration/Review；Planning tuple 同时变化时先 `replan`。三者都不产生新 cycle ID、不改写或回填历史 facts；歧义 fail closed。current code reality 已满足的 obligation 以 `EXISTING_SEAM` 表达（§4.1），不用伪造 Work/Task/Result/Git facts 的方式重建历史。

## 写入原则

任何 MES durable fact 至少能回答：

```text
what happened?
to which scope?
under which fact-kind-appropriate candidate/accepted Plan / work identity?
against which Git basis when relevant?
what durable Result/Finding ref supports it?
```

写入只接受：Brain 授权的 semantic event、结构化 Result/Finding、Review verdict、Git 事实（HEAD/branch/worktree/diff）；所有正常 durable materialization 通过唯一 MES operational transaction layer。Agent narrative、transport `sent`/`idle`/`done`、session/transcript 状态、checkbox 或 progress 文本不写入 MES。

Plan binding 经 accepted / candidate Plan 的 `project_stage_map_ref` + `git_basis.head` 间接闭合 current Stage Map entry；Map basis 可从 ref + candidate Git basis 重建，默认不新增独立 Map digest 或 MES fact kind。

<!-- proofloop:entity id="mes-operational-transaction-boundary" kind="seam" -->
### MES operational transaction boundary
- Brain/Host 只提交有界 semantic event 与必要 binding；不提交完整 snapshot、retention set 或由 caller 组装的 `submitted ∪ retained` state。Role Agent/Worker/Verifier 不直接写 MES。
- transaction layer 是唯一 normal durable mutator：读取并锁定 root-bound current snapshot，按 fact kind 校验，解析 current durable relation 的 canonical binding，materialize facts/relations，preserve unrelated facts，执行 idempotency/完整结果校验，再调用内部 `MesSnapshotStore` atomic persist。
- 任何 validation、binding、relation、permission、conflict 或 persistence failure 都 no-write；不自动 retry；正常 caller 少提交 facts 不代表删除旧 durable IDs。transaction result 只报告 materialized refs/basis，不输出 route、next action 或 reasoning。

<!-- proofloop:entity id="mes-binding-critical-identity" kind="oracle" -->
### Binding-critical identity ownership
- `verification_result_ref`、`delivery_cycle_id`、accepted Plan（同 (stage, delivery cycle) 的 current accepted generation = cycle-bearing `plan_acceptance` chain 的唯一 tip）、Work/Task/Result relation 与 terminal predecessor/currentness 等 identity，若可由 current durable relation 唯一解析，必须由 transaction layer 解析/物化；caller 不负责手工拼接。current generation 与其下游 `verification_result_ref` 的对应关系也在此解析；tip 不唯一、链损坏、predecessor 非当前 tip，或 downstream fact 绑到已有后继的那一代时，整个 transaction atomic fail-closed 且不授权执行。
- caller 提交的 binding 必须与 canonical relation exact-match；typo、旧/近似 ref、跨 cycle、缺失或歧义 relation 均 atomic no-write，snapshot bytes/fact IDs 不变；不使用 insertion order、filename、timestamp、Git recency、status projection、newest-wins 或第二 pointer/store。

<!-- proofloop:entity id="mes-invalid-history-oracle" kind="oracle" -->
### Invalid immutable history
- schema-readable、durable、immutable、readable、auditable 但 relation-invalid 的 facts 必须保留；它们不支持 Task/Slice completion、Integration/CLEANED、`STAGE_ACCEPTED`、`PROJECT_READY` 或 continuation。
- restart/rehydrate 后 classification 必须一致；不得 delete、rewrite、silent-correct、backfill，或追加 correction fact 后按时间/插入顺序选择最新有效。

<!-- proofloop:entity id="mes-maintenance-recovery-boundary" kind="seam" -->
### Maintenance/recovery implementation boundary
- S06 hard-freeze 时，Runtime remediation 不得使用 unsafe NORMAL writer，不写 NORMAL PVR/PA/recovery baseline，不 revival `PRE_MES_BOOTSTRAP`，不造 fake facts，不建第二 MES/shadow store/controller。
- entry basis 是 current Authority、exact Git branch/HEAD/worktree、root-bound forensic/audit refs、frozen MES SHA/count 与 Brain bounded authorization；具体 `MES_MAINTENANCE` packet/result/ACK/CV/Review 与 Git lifecycle semantics 由 `tech-spec/contracts.md`、`.agents/contracts/brain/integration.md` 及对应 Role Contracts 闭合，不由 public status 或 stale candidate 推导。
- exit 需 isolated regressions、independent CV/Review、fresh exact-bound recovery candidate/SPV、one controlled recovery transaction、immediate re-quarantine、rehydrate/relational audit/restart；失败保持 quarantine/no-write/no-retry。


### Planning / finding durable facts（NORMAL）

`PLANNING_VERIFICATION_RESULT` 是 Brain 接纳 NORMAL SPV reply 后发起的 semantic planning event，由 MES transaction layer materialize；它验证 pre-accept candidate，不要求 candidate 已 accepted：

```yaml
fact_kind: PLANNING_VERIFICATION_RESULT
result_ref: <MES-generated durable ref>
planning_work_id: <current MES planning work identity>
verifier_role: stage-plan-verifier
candidate_plan_ref: <required pre-accept candidate Thin Plan ref>
scope:
  stage_id: <current Stage>
delivery_cycle_id: <current delivery-cycle identity>
accepted_plan_ref: null
verdict: PLAN_READY | FINDINGS | BLOCKED
finding_refs: []
authority_refs: []
git_basis:
  head: <candidate verification HEAD/ref>
action_token: <SPV dispatch token>
created_by: brain
```

`candidate_plan_ref` 必填，`accepted_plan_ref` key 必须存在且为 `null`；`result_ref` 由 MES transaction layer 在 Brain 接纳 reply 时 materialize。候选 Plan 的 `project_stage_map_ref` 与同一 candidate `git_basis.head` 构成被验证 current Stage Map entry 的重建 basis：SPV / Brain 必须能从 candidate Plan + `project_stage_map_ref` + candidate Git basis 重建被验证的 Map entry，重建失败返回 typed blocker / `PLAN_GAP`，不得以 MES status 或其他 projection 补全 Map basis（无第二 operational state source）。Plan 或 Map material revision 都要求新 tuple 上 fresh full initial SPV。只有 verdict 为 `PLAN_READY` 的该 fact 才能产生：

```yaml
fact_kind: PLAN_ACCEPTANCE
accepted_plan_ref: <candidate_plan_ref promoted to accepted>
source_candidate_plan_ref: <same candidate ref>
verification_result_ref: <PLAN_READY planning verification result ref>
delivery_cycle_id: <same current delivery-cycle identity>
supersedes_plan_acceptance_ref: <null | exact fact_id of this (stage, delivery_cycle_id) chain tip>
scope:
  stage_id: <current Stage>
authority_refs: []
git_basis:
  head: <verified candidate basis>
accepted_by: brain
```

`PLAN_ACCEPTANCE` 之后 downstream Work/Result 才绑定 accepted Plan；candidate revision、`FINDINGS` 或 `BLOCKED` 不得提前写 acceptance。

**Planning acceptance generations（append-only succession；`tech-spec/architecture.md#/entities/planning-acceptance-succession`、`tech-spec/contracts.md` §2.2.2）：**

- `PLANNING_VERIFICATION_RESULT` 只是某次 candidate Plan 验证的 evidence record：它既不是 accepted planning identity，也不参与选择 current accepted generation；同一 candidate 允许被多次独立验证而各自成 fact，由后续 generation 的 `verification_result_ref` 精确绑定。
- 每个 cycle-bearing `PLAN_ACCEPTANCE` 就是一个 accepted Plan generation，其顶层字段 `supersedes_plan_acceptance_ref` 只能取该 (stage, `delivery_cycle_id`) 尚无其它 cycle-bearing generation 时的 `null`，或当时该 (stage, cycle) 唯一 tip 的 `fact_id`。该字段属 `plan_acceptance` 专属顶层 position，其它 fact kind 携带即 invalid。
- transaction layer 必须在 submitted ∪ retained 上把同一 (stage, cycle) 的 cycle-bearing generation 校验成单条无环链：恰有一个不被任何 successor 引用的节点，该节点即 current accepted generation。自引用、target 缺失或非 `plan_acceptance`、跨 stage/cycle edge、重复 target 造成的 branch、有向环、不等于 retained tip 的 predecessor，以及同时存在多个无 successor 节点，任一命中即 no-write；status 侧对应 typed `AUTHORITY_GAP`。选择 current generation 时不得使用 insertion order、fact filename、timestamp、Git recency、newest-wins 或 (ref, digest)/fingerprint；新 generation 必须由一个刚产生的 `PLAN_READY` PVR promote（ref/digest 与前一代相同也合法）。
- 更新前已存在的 generation 若带 `delivery_cycle_id` 却缺 predecessor 字段，只能作为该 (stage, cycle) 链的只读兼容 root 读取，不补写；完全不带 cycle 的 legacy PVR/PA 与本链无关，仅作 history。
- 下游 plan-bound fact 的授权范围由它自己绑定到的那个 generation 决定；绑定非 current generation 的 fact 仍可读、可审计，但不授权 Integration、`STAGE_ACCEPTED`、terminal 支撑闭合、Task/Slice completion 或 continuation。某 Stage 出现新 generation 后，它此前 generation 的 accepted support 立即失去授权力；已被合法 terminal 关闭的 cycle 不再接受新 generation（no-write）；其它 Stage 不受影响。

Verifier 的 `claimed_route_code` 不是 MES route authority。Brain 重读 Authority、Plan、scope 与 code reality 后，发起 semantic disposition event；MES transaction layer 可 materialize `FINDING_DISPOSITION`：

```yaml
fact_kind: FINDING_DISPOSITION
disposition_ref: <MES-generated ref>
finding_ref: <original verifier finding ref>
finding_disposition: ACCEPTED | VERIFIER_OVERREACH
claimed_route_code: <verifier claim>
accepted_route_code: <Brain route; null when overreach>
basis_refs: []
reason: <bounded Brain classification reason>
resume_target: <producer | planner | authority-owner | research | recovery | verifier-lane>
created_by: brain
```

`VERIFIER_OVERREACH` 只能由 Brain disposition 产生；此时 `accepted_route_code` 为空，不自动触发 repair/Replan/HUMAN_REQUIRED。PRE_MES_BOOTSTRAP 不写这些 durable facts，不创建 decision log 或第二 result store；丢失后从 Git、Authority、Plan 与现有 Finding/evidence 重新分类。

### HUMAN_REQUIRED locality

`HUMAN_REQUIRED` 是 Brain 接纳真实用户决策缺口后的 operational pause：affected work 暂停并递增 `human_required`，只有真实 dependency descendants 设置 `blocked_by`，独立 Slice/Task 继续 runnable。counter 只作为 status sparse projection；只有当前 frontier 确实需要 Product/Authority 输入时才形成 PM decision request。人类输入必须先由 canonical owner 吸收，再按 Authority/Plan/goal/proof boundary impact 选择 Replan（Plan 改变时 fresh SPV）或纯 operational resume；不能直接清 counter 复用旧 Plan。
- User presence, whether the user sent another message, and ephemeral Agent/session/transcript transport state are not continuation prerequisites. Only a Brain-confirmed real `USER_DECISION_REQUIRED` creates this pause.
## status 一级视图

status 是 MES 对 Brain / Agent / PM 的最小默认暴露面，只反映已发生的 operational 事实，不复制 Project Stage Map 的 entry criteria 作为 mutable readiness cache，不输出“建议下一步”，也不生成 Stage graph 或 next-stage 决策。
status 的 phase/scope/required_skill 只描述 current operational cycle；新 cycle 未开始时可附带历史 `PROJECT_READY` detail。历史 terminal 不生成 route/next action，只有新用户工作或实质变更才触发 Propose。
status 先从当前唯一 in-flight candidate/accepted Plan binding 的 `delivery_cycle_id` 与 stage-only `scope.stage_id` 取得 current Stage，再过滤 facts：stage-only Review `work`/`result`/`finding` → `REVIEW`；task 或 slice/task-scoped execution fact → `EXECUTE`；否则 current planning binding → `PLANNING`。唯一 in-flight 候选必须是同 cycle 且尚无同 cycle accepted-stage support；缺失、重复、跨 cycle 或无 stage provenance 均 fail closed。`task` fact 必须参与 current scope 候选；current `PROJECT_READY` 只接受匹配 cycle ID 的唯一 terminal；历史 terminal 不参与 current phase/route。详细 scope-role 与 Review relation 以 Technical Authority refs 为准。
status 选取某个 Stage 的 current accepted generation 时只看该 (stage, cycle) 的 generation 链 tip，不看任何 candidate PVR。status 也不解释 Plan 语义（例如 Task 级 `obligation_state`）：Plan 声明的 `EXISTING_SEAM` readiness 属 Brain/agent level 判定，不进入 status，也不新增 public Slice state。

### current PROJECT_READY public observation
- When the current cycle has one legal matching `PROJECT_READY`, the public read-only status surface must expose current ready truth in human, JSON, and detail projections. It reuses the durable current-cycle terminal relation and existing terminal projection; it does not add a cache, second store/controller, Gate, or phase.
- Historical-only terminal, current terminal, pre-terminal `STAGE_ACCEPTED`, and duplicate/conflicting/cross-cycle terminal cases remain distinguishable; ambiguous currentness fails closed. Exact public JSON/detail shape is owned by the Runtime/Plan seam, not by status reasoning.


Brain / Agent 默认只看到：

```text
scope
phase
required_skill
non-zero anomaly counters
```

正常示例：

```text
S03 / EXECUTE
skill=proofloop-execute
```

存在偏离时才追加非零计数：

```text
S03 / EXECUTE
skill=proofloop-execute
replan=1
blocked=1
```

## Sparse anomaly counters

一级 status 支持以下稀疏异常计数（`0` 不显示，`>0` 才显示）：

```text
replan
blocked
repair
recovery
human_required
finding
cleanup
```

一级只显示数量；具体对象/原因通过二级 detail 查看。

## status 二级视图

按需下钻 Stage / Slice / Task / Work 明细，允许包含：

- current work
- owner
- waiting verifier
- blocked_by
- replan / repair / recovery
- latest Result/Finding ref
- candidate / integration Git ref
- cleanup pending

示例：

```text
S03-A  INTEGRATED
S03-B  REPLAN
S03-C  WORKER_DONE / WAITING_CV
S03-D  BLOCKED_BY S03-C
```

MES 不输出“建议下一步”。Verifier 不需要默认读取全量 MES；其 target、Authority/Plan/Git basis 由 dispatch packet 提供。若读取 status，也只读取最小 phase/skill reminder；MES 状态本身不能成为 PASS/FINDING 证据。status 不缓存 Stage Map 的 entry criteria 或 mutable readiness；Stage operational 状态（如 `STAGE_ACCEPTED`）由 MES durable facts 表达。

## 写入边界

- Brain/Host 是唯一 semantic event initiator / authorization owner；MES operational transaction layer 是唯一 normal durable write owner；Agent 通过结构化 Result/Finding 返回输入，不直接写 MES。
- MES 记录 operational 事实，不决定业务动作；route、dispatch、recovery 由 Brain 决定。
- Project Stage Map（`delivery/project-stage-map.md`）是 Git-tracked execution-owned planning artifact，由 Planner 拥有，不是 MES fact 或 status；MES 只持有 Stage operational facts，不维护 Stage graph，不增加 Stage selection 或 next action 逻辑。
- Brain 可联合 current Project Stage Map ref + MES facts 做 route 决策，但 route reasoning 与 next-stage selection 不写入 MES。
- accepted Plan 与 planning verification fact 经 Plan 的 `project_stage_map_ref` + Git basis 间接闭合 Map basis；recovery 与 verification 可据此重建 Map basis，不新增独立 Map fact kind。
- MES 不复制 Authority 正文或 Skill 步骤；这些仍从 canonical path 读取。
- normal semantic event 默认 preserve unrelated durable facts；caller 不提交、计算或覆盖完整 snapshot/retention set；unknown/invalid binding、relation、scope、permission、conflict 或 persistence failure 都 atomic no-write，且不得自动 retry。
- `verification_result_ref`、`delivery_cycle_id`、accepted Plan 与 Work/Task/Result/terminal predecessor 等 canonical identity 若可由 durable relation 唯一解析，由 MES transaction layer 解析/物化；caller typo 或非 canonical binding 不得被接受。
- Recovery/maintenance 输入按事实类别读取：正常 continuation 使用 current MES facts + current Map/Plan/Authority/Result/Finding/Git；S06 integrity maintenance 使用 current MES read-only snapshot + exact frozen SHA/count + root-bound forensic/audit + current Authority + Git reality，不使用 public status route、stale recovery candidate 或 hidden session；eventual controlled recovery 另需 fresh exact-bound candidate/SPV。

## Pre-MES bootstrap（一次性例外）

在 MES persistence 集成并 seed accepted Plan/bootstrap facts 前，MES 尚未运作：accepted Thin Plan 是唯一 Git-tracked durable recovery truth（Git Plan ref + baseline HEAD/current Git facts）。该阶段不写入 MES/Status、不声称任何 MES/Status
事实，不产生 MES Result，不产生 Receipt、Manifest、Gate 或第二状态机，也不把 bootstrap 状态
迁移描述为正式 MES 记录。

bootstrap 上下文（`PRE_MES_BOOTSTRAP`）可以携带结构化 Planner/Worker Subagent transport Results，但它们不是 MES
operational records：其 binding = execution_mode + authority refs + candidate/accepted Git Plan ref +
baseline/current Git basis + Stage/Slice/Task（如适用）+ actionToken，不指向任何 MES resultRef。

该一次性规则只在 MES persistence 集成且 accepted Plan/bootstrap facts 已被 seed 前有效：

- 只有首个 MES-persistence Stage 可 pre-seed 执行；其他 Stage 一律不得 bootstrap。
- seed 后 `PRE_MES_BOOTSTRAP` 永久禁止，恢复正常 Planning → MES transaction → Execute → Review；所有 NORMAL Result/Finding/Review/Git operational events 经 transaction layer materialize。MES integrity hard-freeze 期间只允许 Authority-defined maintenance/recovery evidence，不允许 NORMAL operational write。
- 本 Contract 描述 MES 语义，不代表 MES 已实现；实现状态以 Runtime 与 Git 事实为准。

## 终态

当前 Delivery cycle 的 planned Stage 集合由 Brain 读取 active Project Stage Map（`delivery/project-stage-map.md`）确定，并与 MES 持有的 `STAGE_ACCEPTED` durable facts 进行核对；MES 本身不生成 Stage graph，也不维护计划集合。
当 Brain 核对确认该 cycle 的所有 planned Stages 均达到 `STAGE_ACCEPTED` 时，Brain 发起绑定该 cycle planned set / delivery/planning basis 的 `PROJECT_READY` semantic event；MES transaction layer materialize terminal fact 并提醒 PM：Project ready。
`PROJECT_READY` 必须携带该 cycle 的顶层 `delivery_cycle_id`；相同 planned set 的历史 terminal 可共存，status 只选择与 current in-flight binding 相同 ID 的 terminal。旧 seed/retained terminal 缺少该字段时按 legacy history 读取，不补写、不参与 current cycle 选择。
历史 `PROJECT_READY` 是 durable delivery history：后续 cycle 的 Stage 或 terminal 不覆盖、不否定其自身 relation；current workflow state 由 Brain 按新用户工作 Routing Boundary 与当前 facts 判断。
不 dispatch Project Reviewer，不设置 Human Required；PM 未验收不会把当前 cycle 标记 BLOCKED。
