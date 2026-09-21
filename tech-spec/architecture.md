# Architecture Authority — ProofLoop 新流程模型

## 1. Metadata

- Project: `proofloop-v2`
- PRD source: `PRD.md`（`CONFIRMED`）
- Context source: `CONTEXT.md`（Working Memory，不是 Authority）
- Design input: current sources 是分阶段的 canonical Authority（Propose/Planning 为 PRD + Technical Authority Pack；`PLAN_READY` 后 downstream 为 tech-spec Pack）与 active Brain/Host Role documents、Contracts 和 phase references；旧 Wayfinder / 旧 MES 实施计划 `.docs` 正文已归档，仅作历史追溯，不作为 active design authority
- Architecture version: `2.7.0`
- Date: `2026-09-13`
- Owner: Brain / `prd-to-ai-architecture`
- Target implementation scope: 四阶段流程（Propose → Planning → Execute → Review →
  PROJECT_READY）、MES/status、Thin Plan / JIT Work Packet、Slice lane / CV / Integration、
  `.agents/`、`.pi/`、`.opencode/` 编排与宿主适配
- Status labels: `confirmed` / `assumed` / `open`

## 2. Product Scope

### Must Implement

- [confirmed] 四阶段生命周期 Propose → Planning → Execute → Review → PROJECT_READY；
  Propose 建 canonical Authority，后续三阶段可 AFK。
- [confirmed] MES 是唯一 operational execution state / record / traceability 事实源；
  status 是最小默认暴露面（scope / phase / required_skill / 非零异常计数）。
- [confirmed] Runtime 提供 root-bound MES snapshot/seed、strict fact/binding validation、只读 `proofloop status`（`--detail` / `--json`）observation 与 MES operational transaction seam；Brain/Host 只发起并授权 semantic event，MES transaction layer 负责 durable fact materialization、完整 resulting-state validation、binding/relation closure、idempotency 与 atomic persistence；`MesSnapshotStore` 仅是内部 persistence primitive，完整跨 runtime E2E 由后续 remediation Plan 验证。
- [confirmed] MES durable mutation ownership：Brain/Host 只发起 semantic event；transaction layer 是唯一 normal durable mutator，负责 preserve-by-default、canonical binding、relation closure、idempotency 与 atomic persistence；relation-invalid immutable history non-authorizing。MES integrity incident 成立时的 physical quarantine 与独立 maintenance/recovery seam 是受影响 Stage/cycle 的 resume gate。
- [confirmed] Brain 是唯一 cross-phase route / dispatch / recovery owner；允许的 operational action 与合法 transition 由所选 Host 的 Brain 文档直接约束：OpenCode `.opencode/agents/brain.md`，Pi `.pi/brain-workflow.md`。进入 Flow 后由对应 Host Role Agent 与 Contract 连续执行。route/dispatch 消费 current Project Stage Map + durable facts；Brain 不创建/修订 Map、不做 Stage/Slice/Task decomposition，Brain→Planner 只传 current target/binding/fact refs，不携带重复 Planning method。`PRE_MES_BOOTSTRAP` 先读取 Git baseline/current、canonical Authority 与 candidate/accepted Git Plan facts，不读取或声称 MES/Status facts。
- [confirmed] Planning acceptance succession：同一 open delivery cycle 内允许合法的 accepted Plan revision——`PLAN_ACCEPTANCE` 以 append-only `supersedes_plan_acceptance_ref` generation chain 表达，唯一 tip 为 current accepted generation；pre-accept `PLANNING_VERIFICATION_RESULT` 只是 verification evidence，不构成 competing accepted identity；`resume` / `replan` / `restart` 三者机械可区分且可写，并复用既有 cycle identity 与 durable facts，不新增 fact kind、store、pointer、phase 或 Gate。
- [confirmed] Dispatch identity 与 host launch identity 一一对应：`role_skill == subagent_type`。Brain/Host 选择 role、创建 session、取得 host session identity、调用所选 Subagent host dispatch 并发送最小 packet；Pi `.pi/agents/*.md + .pi/subagents.json` 或 OpenCode `.opencode/agents/*.md` 是由 Git 跟踪的 Host adapter 配置，不是 Git-tracked business truth，也不是 MES / Plan / SPV / CV / Review currentness 输入；缺失或非法时返回既有 typed `RUNTIME_BLOCKER`。
- [confirmed] Project Stage Map（`delivery/project-stage-map.md`）是 Git-tracked execution-owned planning artifact，
  project-level Rolling-Wave Planning 唯一 active map：保存 Stage id / depends_on / goal / entry criteria /
  Authority refs；唯一 writer 是 Planner（`proofloop-plan` MAP CHECK），readers 为 Brain / Planner / SPV、
  Execute 需要时只读；current `ready / blocked / executing / accepted` 由 MES/Git facts 表达，
  Map 不缓存 operational readiness。
- [confirmed] Thin Plan + JIT Work Packet：Planning 产出执行所需 planning facts（Project Stage Map +
  current Stage Thin Plan，WHAT/WHEN/BOUNDARY）；JIT Work Packet / per-Task Read Set 是 derived execution
  input，由 Brain running `proofloop-execute` 在 execution boundary 读取完整 accepted Plan、选择当前 dependency-ready Task 并只投影该 Task 的 JIT input（Worker 只接收当前 Task，future Task body 不提前披露），不是 Planner 输出、不是 Authority。
- [confirmed] Vertical Slice Execution Lane：one Slice = one Worker lifecycle + one
  isolated worktree + one logical Worker lane；CV 为 Slice-level；CV PASS ≠ INTEGRATED。
- [confirmed] 三轴 Stage Review（Outcome → Composition → Authority）→ STAGE_ACCEPTED。
- [confirmed] 当前 Delivery cycle 的 all planned Stages accepted → PROJECT_READY；PM 自行最终验收；
  无 Project Reviewer / Gate / Acceptance phase。
- [confirmed] `PROJECT_READY` 只关闭当前 Delivery cycle 的 planned Stage set；历史 terminal 按自身 delivery/planning basis 保持有效，后续 cycle 可产生独立 terminal；新的实质工作从 Propose 重新开始。
- [confirmed] Slice-level proof binding：三层 fingerprinting（Stage 全局契约 + per-Slice
  契约 + 执行绑定）：`NORMAL` 使用 accepted Thin Plan + MES work identity + Git basis；
  `PRE_MES_BOOTSTRAP` 使用 candidate/accepted Git Plan + canonical Authority refs + Git basis。Task-local /
  Slice-wide Replan 分类。
- [confirmed] Recovery 从 durable facts 恢复：`NORMAL` 按 role 使用 Planner/SPV candidate 或 Execute/Worker/CV/Review accepted Plan + MES durable state + Authority + structured Results/Findings + Git/worktree reality；`PRE_MES_BOOTSTRAP` 使用 Git + candidate/accepted Git Plan + canonical Authority + structured Subagent transport evidence + Git/worktree reality。
- [confirmed] 旧 Admission / Receipt / Manifest credential / Context Gate / `stage next` /
  Stage Gate / legacy currentness-recovery / project acceptance 整体退役；
  机械安全原语抽取复用。

### Explicit Non-Goals

- [confirmed] 不修改 `subagent/1` envelope，不把业务字段写入通用 envelope。
- [confirmed] 不创建 ProofLoop Launcher、Agent Manager、Registry、Session DB、queue、
  scheduler 或 retry daemon。
- [confirmed] 不实现 quota detection、provider/model fallback、自动 retry、价格/负载路由
  或自动 Subagent host variant migration。
- [confirmed] 不使用 terminal relay 或直接拼接宿主内部 prompt 绕过所选 Host native transport（Pi `Agent`/`resume`/`get_subagent_result`；OpenCode child dispatch/session/result）作为正常业务 transport。
- [confirmed] 不把 Subagent type、agent_id、session_id、transcript ID、message id 或 repair dialogue 写入 MES、
  Result 或其他业务 authority。
- [confirmed] 不为旧 Receipt Chain 建 compatibility layer；不把 MES 扩展为业务解释器、
  Router 或第二套 Runtime。
- [confirmed] 不实现 Project-level 自动总体验收；不新增并发执行器/并行 worktree 基础设施
  或新的 Git 提交流程；但 MES 状态模型必须支持多 Slice lane 状态/依赖隔离（一个 blocked
  不阻断无依赖 Slice）。

### Future / Out of Scope

- [open] 更多 Agent runtime、非 Linux 的完整实机验收和可视化诊断；不改变本次单一控制面。

## 3. PRD to Architecture Mapping

| PRD item | Technical implication | Architecture decision | Status |
|---|---|---|---|
| FR-001 四阶段生命周期 | 主流程唯一化 | Propose → Planning → Execute → Review → PROJECT_READY；每阶段由对应 Skill 承载方法 | confirmed |
| FR-002 Authority Pack | 决策需要阶段化 owner | Propose/Planning = PRD Product Authority + Architecture/Contracts/Acceptance Technical Authority Pack；`PLAN_READY` 后 downstream normative truth 仅 tech-spec Pack，accepted Plan 是 execution instruction | confirmed |
| FR-003 MES + status | 执行事实需要单一来源与安全物化 | Project Stage Map 是 Git-tracked execution-owned planning artifact（writer=Planner）：Map 保存 goal / depends_on / entry criteria / Authority refs，current readiness / executing / accepted 由 MES/Git facts 表达；MES/status 只观察 operational facts，不生成 Stage composition 或 next-Stage decision；Brain/Host 只发起 semantic event，MES operational transaction layer 负责 preserve-by-default、canonical binding/relation validation、idempotency、complete-state validation 与 atomic persistence；Runtime 提供 root-bound snapshot/seed、transaction 与只读 status observation | confirmed |
| FR-004 Brain control plane | route/dispatch 需要 owner | OpenCode `.opencode/agents/brain.md` 与 Pi `.pi/brain-workflow.md` 各自包含四类 Routing Boundary 与 trigger → Flow → Exit；进入 Flow 后由对应 Host Role Agent/Contract 连续执行；Brain 消费 current Project Stage Map + durable facts 做 route，不创建/修订 Map、不做 Stage/Slice/Task decomposition；status 只作 observation | confirmed |
| FR-005 Planning | 规划需要 thin + falsified | Planning 拥有 Project Stage Map + current Stage Thin Plan；每 Stage 先 MAP CHECK（Map absent → Planner 创建首份 Map；Map present → review/revise），再产出 current Stage candidate Thin Plan；SPV basis = candidate Plan + 同 Git basis 的 Map entry + Authority + candidate Git basis；Task 级必须闭合 local closure / verification closure / future-HOW independence，SPV 显式反证 future-HOW independence，不成立即 `PLAN_GAP`；JIT Work Packet projection owner = Execute（Brain running `proofloop-execute` 选择当前 dependency-ready Task 并只投影该 Task 的 JIT input）；impact-based Replan（Plan-local 或 Map+Plan）| confirmed |
| FR-006 Execute | Slice 需要自治 | `NORMAL` 在 Plan/MES 接纳后执行；Brain/Execute 逐 Step 读取完整 accepted Plan、选择并投影当前 dependency-ready Task 给同一 Worker；一次性 `PRE_MES_BOOTSTRAP` 仅允许首个 MES-persistence Stage，Worker Result 为 Git-bound Subagent transport evidence；CV Slice-level；Runtime 提供 dedicated `integration apply` mechanical seam，完整 Slice-lane Execute/Integration lifecycle 属于后续显式实现任务 | confirmed |
| FR-007 Review | 集成后需要三轴验证与可恢复的 Review outcome/finding relation | `stage-review.md` 拥有唯一 Reviewer envelope 与通用 Return codes；Technical Authority 只定义 durable Review / Finding / `STAGE_ACCEPTED` relation semantics；三轴全 PASS 且 snapshot 匹配才写 `STAGE_ACCEPTED` | confirmed | `tech-spec/contracts.md#/entities/review-result-contract`；S04 不在 Plan 中重定义 envelope 或 relation |
| FR-008 PROJECT_READY | 终态无 Project Gate | all Stages accepted → PROJECT_READY；PM 验收 | confirmed |
| FR-009 Recovery | 丢失后可重建 | `NORMAL` 按 role 使用 MES + Planner/SPV candidate 或 Execute/Worker/CV/Review accepted Plan + Authority + Result/Finding + Git；bootstrap 窗口仅使用 Git-tracked Plan + Authority + Git facts，seed 后永久关闭 bootstrap | confirmed |
| FR-010 Subagent host lifecycle | 宿主与流程 authority 分离 | Subagent host dispatch + 当前工作区 versioned Host adapter（Pi `.pi/agents/*.md + .pi/subagents.json`；OpenCode `.opencode/agents/*.md`；干净 checkout 必须包含所选 Host 配置；缺失或非法仍为既有 typed `RUNTIME_BLOCKER`） | ProofLoop identity invariant=`role_skill == subagent_type`；ephemeral metadata 不进业务 | confirmed |
| FR-011 Mechanical primitives | 安全能力不随旧模型删除 | path / process / Git-worktree / protected-scope / ID-schema / replan-impact 抽取复用 | confirmed |
| FR-012 Legacy 退役 | 无双权威 | 旧业务控制语义整体删除；无 compatibility layer | confirmed |
| FR-013 Slice 级证明绑定 | 局部返工不连坐 | 三层 fingerprinting（Thin Plan + MES + Git basis）；Task-local / Slice-wide Replan | confirmed |
| FR-014 Evidence 纪律 | 完成不靠 narrative；正式 `AUTHORITY_GAP` 由 Planning/SPV 在 Product intent、Technical Authority 与 grounded reality 闭合中分类 | Result/Finding 可重读绑定；RED/GREEN Evidence；下游不直接 claim `AUTHORITY_GAP` | confirmed |
| FR-015 可重复 Delivery cycle | terminal relation 绑定自身 planned set / delivery basis；历史与 current workflow 分离；新实质工作回到 Propose | Delivery-cycle continuation flow + explicit append-only terminal succession relation / currentness oracle；不新增事实源 | confirmed | `tech-spec/contracts.md#/entities/review-result-contract`；`tech-spec/contracts.md#/entities/current-terminal-currentness-oracle`；Host Brain documents |
| FR-016 Authority handoff / unattended continuation | Technical Authority invalidation、Authority owner update、用户离线不阻断合法 Flow、真实决策才 HUMAN_REQUIRED | `authority-gap-and-update` seam + Brain/Propose/authority-update route + lifecycle continuation invariant | confirmed | `tech-spec/architecture.md#/entities/authority-gap-and-update`；active Workflow/MES Contracts |
| FR-015 / FR-016 cycle 内 Planning continuation | 同一 open cycle 内 accepted Plan 的合法 revision 必须可表示，否则 recovery 出口承诺的 `resume` / `replan` / `restart` 不可写 | `planning-acceptance-succession` + accepted-Plan generation chain（`supersedes_plan_acceptance_ref`）+ currentness oracle 的 generation 规则 + `EXISTING_SEAM` obligation closure；不新增 cycle、fact kind、store 或 Gate | confirmed | `tech-spec/architecture.md#/entities/planning-acceptance-succession`；`tech-spec/contracts.md#/entities/current-terminal-currentness-oracle` |
| FR-017 Current terminal status | current legal `PROJECT_READY` 在 public status 中可观察且与历史/pre-terminal/ambiguous 场景区分 | `current-terminal-public-status` + `current-terminal-currentness-oracle`；terminal succession relation 与 exact public terminal adjunct（human/JSON/detail）复用 durable facts；不新增状态源 | confirmed | `tech-spec/architecture.md#/entities/current-terminal-public-status`；`tech-spec/contracts.md#/entities/current-terminal-currentness-oracle` |
| FR-018 MES durable ownership / freeze recovery | MES transaction layer、binding safety、maintenance/recovery seam 与 invalid-history isolation | `mes-operational-transaction-boundary`、`mes-maintenance-recovery-boundary`、`mes-invalid-history-oracle`；MES integrity hard-freeze（成立时）是恢复前置，不是新 Stage scope | confirmed |

## 4. Architecture Views

### System Context

- User/PM: Propose 阶段参与决策；`PROPOSE_READY` 后 AFK；终态收 `PROJECT_READY` 提醒并
  自行最终验收。
- `PROJECT_READY` 是当前 Delivery cycle 的历史终点；若用户随后提出新的实质工作，PM/用户输入成为新的 Propose 入口，而不是直接复用历史 terminal。
- Brain: 唯一全局路由、派发与恢复 owner；route/dispatch 消费 current Project Stage Map + durable facts，不创建/修订 Map、不做 Stage/Slice/Task decomposition；`PRE_MES_BOOTSTRAP` 时先读取 Git baseline/current + canonical Authority + candidate/accepted Git Plan facts，不读取/声称 MES；seed 后由 OpenCode `.opencode/agents/brain.md` 或 Pi `.pi/brain-workflow.md` 驱动 route / dispatch / recovery（status 只是 observation input），并通过对应 Host 创建/复用 role instance。Brain 是 semantic mutation initiator / authorization owner，但不维护完整 MES snapshot。Host Agent 文档同时承载对应 Role procedure。
- MES: 内部执行管理层；由唯一 operational transaction layer 读取当前 durable state、物化 semantic event、保留无关历史、闭合 binding/relation、执行幂等与完整结果验证并原子持久化；不做 reasoning、不生成 next action、不持有 Project Stage Map（Map 是 execution-owned planning artifact，不是 MES fact/status）。
- Planner（runtime role）：由所选 Host Planner Agent 文档内嵌 Planning procedure；按 MAP CHECK 维护公共 Project Stage Map（缺失时创建，存在时 review/revise current Stage），按 Slice-first 分层方法产出 current Stage candidate Thin Plan（WHAT/WHEN/BOUNDARY）；不投影 JIT Work Packet。
- Project Stage Map: Git-tracked execution-owned Rolling-Wave planning artifact（`delivery/project-stage-map.md`）；
  writer=Planner，readers=Brain / Planner / SPV / Execute（按需只读）；不承载 operational readiness。
- Workers / Verifiers / Reviewer: 由 Brain 按所选 Host 的当前 Role Agent 文档派发；`subagent` 是唯一 Agent-to-Agent 通道。
- Subagent host: 外部 session、Agent process 和 lifecycle control plane。
- Runtime/Kernel: 机械 CLI（`boundary close`、`integration apply`）、root/path/Git/process 安全原语，以及 MES snapshot/seed、fact/binding validation 与只读 status seam。
- Local boundary: 项目工作区、Git 和 `.proofloop/`；网络默认不作为 ProofLoop 依赖。

### Dispatch seam

```text
`execution_mode` 分支（一次性 bootstrap 与 NORMAL workflow-driven route）
PRE_MES_BOOTSTRAP（MES persistence 集成并 seed 前）
        ↓
Git baseline/current + canonical Authority refs + candidate/accepted Git Plan facts
        ↓
Brain（所选 Host Brain 文档）读取 canonical Authority + 当前 Contract，按 Host-local workflow 路由 Planner/首个 MES-persistence Stage
        ↓
Agent 返回结构化 Subagent transport evidence；Brain 以 Git + Git-tracked Plan 复核（不写 MES）
        ↓
MES persistence 集成并 seed 后永久关闭 PRE_MES_BOOTSTRAP
NORMAL（seed 后）
        ↓
workflow Routing Boundary / Flow completion / blocker / invalidation / recovery 触发 route 决策（不是每轮强制 status-first）
        ↓
Host Brain 按自身文档中的 trigger → Flow → Exit table 选择下一个 Flow 或委托当前 Host Role Agent
        ↓
MES status 仅作为 observation（scope / phase / required_skill / 非零异常计数）
        ↓
Host resolves role/dispatch skill；`subagent_type := role_skill`；Host/Subagent host 创建 session 并返回 host session identity
        ↓
Subagent host dispatch(name, host session identity, subagent_type) ；start 成功后 send minimal role packet
        ↓
对应 Host Role Agent/Contract 执行事务并验证自己的 currentness basis，返回 structured Result / typed blocker
        ↓
Brain 接纳已验证的 Result/Finding，并向 MES operational transaction layer 发起经授权的 semantic event；MES 在 transaction 内 materialize、校验并持久化 operational fact（如适用）

```
Brain/Host 按本 Contract 使用所选 Host native transport：Pi `Agent`/`resume`/`get_subagent_result`；OpenCode child dispatch/session/result；这些调用只产生 transport Result，不构成业务 authority
Runtime 没有 Worker dispatch CLI；派发是 Brain/Host 编排职责，
Runtime 提供机械 CLI、安全原语、MES read/seed/validation/status 与 operational transaction seam；不提供 Brain orchestration、Product/Technical reasoning 或完整 Flow routing。

Planning entry（两种入口；Brain 只传 current target / facts / refs / binding，不携带 Planning method）
Map absent（active `delivery/project-stage-map.md` 缺失）
        ↓
Brain 派发 Planning：project_root、active Map target/path、canonical Authority refs、
current MES/Git facts / Git basis、Planner write paths、actionToken
        ↓
Planner 经 `proofloop-plan` MAP CHECK 创建首份 Map，选定 current dependency-ready Stage
Map present（active Map 已存在）
        ↓
Brain 携带 current Map ref / Stage binding + bounded facts 派发 Planning
        ↓
Planner 经 `proofloop-plan` MAP CHECK：review / revise current Stage goal / dependencies / entry criteria 或保持 Map
汇合
        ↓
current Stage candidate Thin Plan → candidate Git boundary → fresh SPV（basis = candidate Plan +
同 Git basis 的 Map entry + Authority + candidate Git basis）→ `PLAN_READY` → Brain acceptance → Execute

<!-- proofloop:entity id="delivery-cycle-semantics" kind="seam" -->
### Delivery cycle and terminal history
- Delivery cycle 是从一次 `PROPOSE_READY` 到该 cycle 的 `PROJECT_READY` 的一轮 planned delivery；`PROJECT_READY` 只证明其自身 terminal fact 绑定的 planned Stage set 与 delivery/planning basis 已闭合。
- 历史 terminal 的 validity 以自身 planned set、accepted-stage support 与绑定 basis 验证；后续 cycle 的 Stage support 或 terminal 不改写、不否定历史 terminal。多个 terminal 可以共存，current workflow state 与 historical terminal 分开解释。
- 用户在历史 `PROJECT_READY` 后提出新的实质工作、scope 增量或产品 intent 变化时，Brain 通过既有“新用户工作或实质变更” Routing Boundary 进入 Propose；不得直接把历史 terminal 当作当前 Planning/Execute 入口。
- `status` 只观察 current operational cycle：新 cycle 未开始时可暴露历史 ready detail；进入 Propose/Planning/Execute/Review 后显示 current scope/phase/required skill；完成后显示新的 current `PROJECT_READY`。status 不承担 route 或 next-action reasoning。
- 优先复用既有 Authority、Map、Plan、Git 与 MES facts 表达 cycle/basis；只有 bounded grounding 证明无法区分历史与 current terminal 时，才在对应 Technical Authority/Contract 中定义最小新增机器契约。
- **Cycle identity is explicit and durable:** Brain 在每次新的 NORMAL `Propose` 完成时生成不依赖 session、`actionToken`、时间戳或插入顺序的 opaque `delivery_cycle_id`；同一 cycle 的 candidate/accepted Plan binding 及其 Work、Task、Result、Finding、Git、accepted Stage facts 携带同一 ID，`PROJECT_READY` terminal 也携带该 ID。相同 `planned_stage_ids` 但不同 `delivery_cycle_id` 是独立 terminal；active currentness 由唯一 open cycle（无合法 matching terminal 的 cycle-bearing planning facts）识别，所有 cycle 已完成时由 terminal succession relation 的唯一 tip 识别 current ready。
- **Planning provenance and field placement are closed:** Every new NORMAL `PLANNING_VERIFICATION_RESULT` and `PLAN_ACCEPTANCE` carries a stage-only `scope.stage_id` for its current Stage; retained planning facts that lack this scope remain legacy history and are never current-scope candidates. A cycle's in-flight Stage is the unique stage-only candidate/accepted planning binding (or same-cycle stage-scoped downstream facts) with no same-cycle accepted `stage` support; zero or multiple candidates fail closed as typed `AUTHORITY_GAP`. Plan filename, Map lookup, Git ordering, insertion order and opaque ref naming cannot supply this identity. For plan-bound facts, `delivery_cycle_id` is carried in `plan_binding`; `project_ready` carries a top-level `delivery_cycle_id` because it must not carry `plan_binding`.
- **Cross-fact cycle equality is a write invariant:** For every new or changed NORMAL fact, the plan-bound cycle ID must equal the unique same-cycle candidate/accepted planning binding it references; an accepted `stage` and its Review result use the same ID, and a `PROJECT_READY` terminal's top-level ID must equal every accepted-stage support ID in its own terminal relation. The MES write boundary validates this over submitted ∪ retained facts; legacy retained facts may omit the new fields only under explicit compatibility rules and cannot authorize a new current cycle.
- **Scope-role closure is normative:** NORMAL `task` fact 必须是 stage+slice+task scope；NORMAL `work` / `result` / `finding` 在 accepted Plan 下，stage-only（只有 `stage_id`）只表示 Review-owned durable output，Execute-owned facts 必须带 `slice_id` 或 `task_id`，stage-only Execute fact 无效。candidate/integration/cleanup `git` fact 必须带 slice scope；历史 stage-only repair Git fact 不单独推导 current phase。保留的 legacy facts 不被重新解释。
- **Current phase is cycle-filtered:** status first validates terminal relations, then selects the unique open cycle from cycle-bearing PVR/PA cohorts without a legal matching terminal; exactly one open cycle drives current Stage/phase, while zero open cycles selects the validated terminal-chain tip as current `PROJECT_READY`. Different-cycle history cannot override currentness; missing/duplicate/cross-cycle/no-provenance/multiple-open/multiple-tip/chain-invalid cases fail closed as typed `AUTHORITY_GAP`.
- **Planning acceptance is a per-cycle append-only chain:** 同一 (Stage, delivery cycle) 的 cycle-bearing `PLAN_ACCEPTANCE` generations 经顶层 `supersedes_plan_acceptance_ref` 形成一条链，唯一 tip 为 current accepted generation；candidate `PLANNING_VERIFICATION_RESULT` 只是 verification evidence，不参与 currentness 选择。`resume` 不新增 generation，`replan` 在同一 cycle 追加 generation，`restart` 在同一 generation 下以 fresh Work identity 重建执行；三者都不生成新 cycle，也不改写历史 facts（见 `tech-spec/architecture.md#/entities/planning-acceptance-succession`）。
<!-- proofloop:entity id="planning-acceptance-succession" kind="seam" -->
### Planning acceptance succession

- **Verification evidence vs acceptance generation:** 每次 `PLANNING_VERIFICATION_RESULT`（含 pre-accept candidate revision 的验证）只是 verification evidence，不构成 accepted planning identity，也不参与 current accepted generation 选择；一次 `PLAN_ACCEPTANCE` 才是一次 accepted Plan generation。
- **Append-only generation chain:** 每个 cycle-bearing `PLAN_ACCEPTANCE` 在 envelope 顶层携带 `supersedes_plan_acceptance_ref`（`null` 当且仅当 retained facts 中不存在该 (Stage, delivery cycle) 的其它 cycle-bearing generation，否则精确指向当时该链的唯一 tip 的 `fact_id`）。同一 (Stage, cycle) 的所有 cycle-bearing generation 必须形成一条 append-only 无环链，唯一 tip（不被任何 successor 引用）即 current accepted generation；self-reference、missing / non-`plan_acceptance` / 跨 Stage / 跨 cycle target、重复 target（branch）、有向环、stale predecessor 与 multiple tip 全部 fail closed。该字段是 `plan_acceptance`-only 的顶层字段（position 规则同 terminal-only 字段），其它 fact kind 携带即无效。
- **Fresh verification requirement:** 新 generation 必须绑定 fresh `PLAN_READY` PVR（promotion equality 成立）。允许新 generation 与前一 generation 的 `accepted_plan_ref` 乃至 `plan_digest` 相同（应由 fresh Authority/Git basis 上的独立验证支持）；generation 身份由链结构决定，不由 (ref, digest)、fingerprint、时间戳、插入顺序、Git recency 或 newest-wins 决定。
- **Downstream currency:** 下游 plan-bound facts 通过 `verification_result_ref` 绑定其 own generation；绑定旧 generation 的事实保留为 immutable、auditable、non-authorizing history，不得支持 current generation 的 Task/Slice completion、Integration、`STAGE_ACCEPTED`、terminal support closure 或 continuation。同一 Stage 追加新 generation 后，其早前 generation 的 accepted support 不再授权；已由 legal terminal 关闭的 cycle 不接受新 generation（no-write）；其它 Stage 的 generation 与 support 不受影响。
- **Recovery continuation closure:** `resume` 不写新 generation（执行绑定缺失时按 `restart` 重建，不 backfill）；`replan` 在同一 cycle 追加 generation（fresh Planner → candidate boundary → fresh full initial SPV → 新 generation）；`restart` 在同一 generation 下以 fresh Work identity 重开受影响 Slice 的 lane，prior attempt 事实 non-authorizing（Planning tuple 同时变化时先 `replan`）。三者都不生成新 delivery cycle。
- **Existing-reality obligations:** 由 current code reality 已满足的 obligation 以 Thin Plan 的 `EXISTING_SEAM` 表达（`tech-spec/contracts.md` §4.1），其 evidence 是 current snapshot 中可机器复核的 seam（pre-accept SPV 复核、final Stage Review 对 integrated snapshot 重新证明）；不得为重建丢失的 operational history 伪造 Work/Task/Result/Git facts，也不得借此跳过真实实现工作。

<!-- proofloop:entity id="authority-gap-and-update" kind="seam" -->
### Authority gap and authority-update
- Formal `AUTHORITY_GAP` belongs to Planning/SPV handoff closure. It covers both a relevant PRD obligation missing from or contradicting current Technical Authority, and unchanged Product intent whose bounded current code/runtime grounding falsifies or proves insufficient the current Technical Authority such that continued planning requires a canonical update.
- `PLAN_GAP` covers a Planner implementation/schema/test choice; `TECHNICAL_UNKNOWN` covers unverified feasibility or facts; normal implementation/repair covers an Authority-complete Runtime defect; `USER_DECISION_REQUIRED` covers a real product, permission, or acceptance decision gap.
- The Brain routes formal `AUTHORITY_GAP` to the current Propose/Technical Authority owner. The owner completes a bounded update under the current Propose binding; Brain fresh-reads the owner output and canonical package, checks exact paths and consistency, accepts it, and invokes the mechanical `authority-update` boundary. This is not a new phase, fact kind, approval Gate, or user-presence requirement.
- Only a Brain-confirmed real `USER_DECISION_REQUIRED` creates local `HUMAN_REQUIRED`; user absence or lack of a new message never does so.

<!-- proofloop:entity id="current-terminal-public-status" kind="seam" -->
### Current delivery terminal public status
- `PROJECT_READY` remains a delivery/project-level terminal and is not added to the per-Stage phase enum by default.
- When the current cycle has one legal `PROJECT_READY` terminal, the read-only public status surface must express current ready truth in human, JSON, and detail projections. It reuses durable current-cycle identity and existing terminal detail rather than adding a cache, controller, store, Gate, or state machine.
- Historical-only terminal, current terminal, pre-terminal `STAGE_ACCEPTED`, and duplicate/conflicting/cross-cycle terminal cases remain distinguishable; ambiguous currentness fails closed. The exact public terminal adjunct and its `CURRENT_PROJECT_READY` / `HISTORICAL_PROJECT_READY` / `PRE_TERMINAL` states are closed by `tech-spec/contracts.md#/entities/current-terminal-currentness-oracle`, not by status reasoning.
- **Terminal succession is part of the existing terminal relation, not a second source:** each new cycle-bearing `PROJECT_READY` appends an explicit predecessor reference to the immediately prior cycle-bearing terminal; status derives the unique chain tip from the same durable terminal facts. No terminal cache, pointer fact, controller, store, Gate, timestamp, Git recency, filename or insertion order participates.
- Compatibility is field-presence based and immutable: a retained pre-update terminal with `delivery_cycle_id` but no predecessor field is a `legacy_cycle_anchor` that may be the chain root; no-cycle legacy terminals remain history-only. New writes never emit or backfill the anchor shape.
- The exact read-only terminal adjunct and resolution oracle are closed by `tech-spec/contracts.md#/entities/current-terminal-currentness-oracle`; its `CURRENT_PROJECT_READY` / `HISTORICAL_PROJECT_READY` / `PRE_TERMINAL` distinction is projection-only and does not add a MES phase.

<!-- proofloop:entity id="mes-disaster-rebaseline" kind="seam" -->
### MES disaster re-baseline
- `MES_RECOVERY_REQUIRED` is a Brain-owned recovery blocker for a seeded NORMAL MES snapshot whose exact pre-image is unavailable and whose retained relations cannot safely serve as a NORMAL baseline. It is not a product decision, a new delivery phase, or `PRE_MES_BOOTSTRAP`.
- The recovery branch begins only after a read-only forensic capture and relational audit. The capture is immutable, content-addressed, root-bound forensic evidence outside the canonical MES snapshot; the audit may report missing/dangling relations but must not invent or rewrite facts.
- A legal recovery baseline is one atomic semantic recovery transaction authorized by Brain and materialized by the MES operational transaction layer against the exact observed source snapshot digest and count. The fact records `preimage_status: UNRECOVERABLE`, the forensic/audit refs and digests, and a new recovery epoch; it does not assert that missing Work/Task/Result/Git history was restored.
- Retained facts from the damaged snapshot remain legacy/history-only unless a fresh relational audit proves their exact current relation; relation-invalid facts are permanently non-authorizing. They cannot authorize current cycle selection, accepted-stage support, `PROJECT_READY`, or any Stage execution. Any PVR observed in an accidental partial write is forensic input and must be revalidated under the current Authority before a new NORMAL planning fact is accepted.
- The recovery write is fail-closed, idempotent and restart-reconstructable: stale source digest/count, duplicate/conflicting recovery epoch, invalid forensic ref, ambiguous retained relation, or any write-boundary violation produces no-write. No stash, reset, checkout, rollback, silent snapshot replacement, or hidden-session reconstruction is part of this branch.
- After the recovery fact is durably written, Brain performs fresh rehydrate and relational audit before choosing the affected Stage/cycle `resume`, `replan`, or `restart`. A fresh Planning candidate and SPV are required whenever the recovery Authority, Plan, Map or Git tuple changes.
- **Initialization boundary is explicit:** 空 project-local MES 数据属于一次性的 `PRE_MES_BOOTSTRAP` 入口；NORMAL delivery cycle 不新增空项目 init CLI、第二 store 或第二 write-back adapter。缺少 root-bound initialized MES store/seed 时，返回 typed `RUNTIME_BLOCKER`，不得伪造已进入 NORMAL Propose/Planning。
### Protocol closure: acceptance, arbitration and locality

以下是控制面必须实现的三个协议闭环；字段级 schema 以 `tech-spec/contracts.md` 为准：
- **Pre-accept Planning：** Planner 产出 candidate Thin Plan 后，SPV 在 candidate 尚未 accepted 时独立验证。candidate Plan verification basis 必须可重建 same-Git-basis 的 Project Stage Map current entry（经 candidate Plan 的 `project_stage_map_ref` + candidate Git basis），不复制 Map 正文进 packet。NORMAL 下 Brain 先写 `PLANNING_VERIFICATION_RESULT`（`candidate_plan_ref` 必填、`accepted_plan_ref: null`、MES-generated `result_ref`），只有 `PLAN_READY` 才写 `PLAN_ACCEPTANCE` 并提升 accepted Plan binding；Plan/Git tuple 或 Map material revision 变化必须 full fresh SPV initial verification。
- **Slice Result acceptance barrier：** Brain 只启动一次 Slice lane；Worker 每次提交 Task Result 后，Brain 校验 binding/schema 并返回 closed `TASK_RESULT_ACK`。只有 `ACCEPTED` 的 predecessor output 才能被 successor 消费；`ACCEPTED + CONTINUE` 后由 Brain running `proofloop-execute` 按当前 Slice 的 Thin Plan 稳定顺序选择下一 dependency-ready Task 并把该 Task 的 JIT input 投影给同一 Worker，Worker 不自行选择 successor；ACK 不包含 next-task 业务指令。`actionToken` 属于 lane，`resultId` 属于提交 attempt，重放按 durable fact 幂等恢复。
- **Finding arbitration / local human pause：** Verifier 只提交 evidence 与 `claimed_route_code`；Brain 重读 Authority/Plan/scope/code reality 后记录 `FINDING_DISPOSITION`，`VERIFIER_OVERREACH` 只能由 Brain 产生。真实 `HUMAN_REQUIRED` 是局部 operational pause，只沿 dependency descendants 传播；人类输入若改变 Authority/Plan/proof boundary 先 Replan，纯 operational unblock 才直接 resume。

<!-- proofloop:entity id="review-machinery-boundary" kind="seam" -->
### Review machinery boundary

Review 的唯一 envelope / Return-code schema owner 是 `.agents/contracts/brain/stage-review.md`；本 Technical Authority entity 只定义 durable Review outcome、finding evidence 与 terminal relation semantics。Stage Reviewer 只生成 Contract envelope，Brain 负责校验并通过现有 MES Result/Finding/Stage 事实 owner 持久化，不在 Plan 或 Authority 建第二套 envelope schema。
`STAGE_ACCEPTED` 仅在三轴全 `PASS` 且 integrated snapshot 匹配时产生；非 `PASS` 的有序 `finding_evidence_refs` 必须进入现有 Finding / FINDING_DISPOSITION seam，narrative 不作为 durable evidence。`PROJECT_READY` 仅在全部 planned Stage 有 durable accepted-stage support 时产生，support facts 在 snapshot replacement / restart 后可重建。
- `PROJECT_READY` terminal relation additionally carries the top-level `delivery_cycle_id` and the closed `supersedes_project_ready_ref` predecessor field; this append-only edge preserves each terminal's own planned/support closure while making the completed current terminal restart-reconstructable.
- A malformed, branched, cyclic, duplicate, missing-target or cross-cycle terminal chain is ambiguous and must fail closed; it cannot be resolved by fact order or any external pointer.
具体 adapter、fact kind、字段、replay key、hash、store 参数和内部 producer/consumer 不由本 Architecture Authority 固化；只有当 fresh TRACE 证明现有 owner 无法表达真正产品/技术语义时，才进入对应 Contract/Authority 决策。
- accepted Stage 的 `plan_binding.delivery_cycle_id`、stage-only Review `result` 与 accepted Stage 的 cycle ID 必须一致；`stage.result_ref` 必须精确解析到同一 cycle、同一 accepted Plan、stage-only scope 的 Review-owned `result`，不得仅凭通用 `fact_kind: result` 或 opaque `result_ref` 接受 Execute Result。
- 上述 scope-role、cycle identity 与 relation closure 是 durable observable semantics，不新增 Review envelope、Review-specific replay/hash 或第二 Stage schema；具体 helper、字段校验位置和 producer/consumer 仍由 bounded execution Plan 决定。

<!-- proofloop:entity id="mes-operational-transaction-boundary" kind="seam" -->
### MES operational transaction boundary
- Brain/Host 是 semantic mutation initiator / authorization owner：表达已接纳的 semantic event、必要的 route/authorization 与当前 binding；不读取、组装或替换完整 MES snapshot，不承担 retention knowledge。
- MES operational transaction layer 是唯一 normal durable operational state mutator：root-bound 读取 current state，校验 semantic preconditions，materialize fact/relation，默认保留 unrelated durable history，执行 replay/idempotency 与 complete-resulting-state validation，最后调用内部 `MesSnapshotStore` 原子持久化。
- Role Agent / Worker / Verifier 永远不直接写 MES；`MesSnapshotStore` 不作为 Brain-facing full-snapshot API、route、state machine 或第二 store 暴露。
- normal operational write 不能因 caller 少提交旧 facts 而删除 durable fact IDs；destructive replacement 只允许在明确的 bootstrap、verified migration 或 recovery/internal boundary 内发生。

<!-- proofloop:entity id="mes-maintenance-recovery-boundary" kind="seam" -->
### MES maintenance/recovery implementation boundary
- 当 NORMAL MES 因 integrity incident 被 hard-freeze 时，Runtime 修复必须使用独立、bounded、可审计的 maintenance/recovery execution seam；该 seam 不依赖 unsafe NORMAL operational writer，不 revival `PRE_MES_BOOTSTRAP`，不制造 fake Work/Task/Result/Git facts，不建立第二 MES、shadow store 或 controller。
- seam 的进入条件由 Brain 根据当前 Technical Authority、exact Git basis、forensic/audit refs 与 frozen MES snapshot digest/count 授权；具体 mode/API/name 由后续 bounded Planning/Contract closure 确定，不由 status 或旧 recovery candidate 推导。
- seam 的退出条件是 implementation/CV/Review 完成、exact incident regressions 通过、fresh recovery candidate 与 frozen source 精确绑定、独立 SPV 允许一次 recovery transaction，并完成 rehydrate/relational audit/restart reconstruction；任一失败保持 quarantine、no-write、no retry。

<!-- proofloop:entity id="mes-invalid-history-oracle" kind="oracle" -->
### MES invalid immutable history oracle
- durable、immutable、readable、auditable 的 relation-invalid facts 保留为历史，但不得成为 current authorization；currentness 由 canonical durable relation 与 exact binding 判定，不由 insertion order、filename、ref spelling、newest-wins 或 correction fact 判定。
- restart/rehydrate 必须产生相同 non-authorizing classification；invalid history 不能支持 Task/Slice completion、Integration/CLEANED、`STAGE_ACCEPTED`、`PROJECT_READY` 或 S06 continuation。
- submitted binding 与 canonical relation 不一致时 atomic no-write，snapshot bytes 与 fact identities 保持不变；不得 delete、rewrite、silent-correct、backfill 或以新事实掩盖旧事实。

### Containers

| Container | Responsibility | Technology | Path | Persistent state | Does not own |
|---|---|---|---|---|---|
| Brain host documents | OpenCode/Pi Brain 的完整 route、dispatch、recovery、native permission/transport 入口；不创建第二 controller、不写业务 schema | Pi/OpenCode host instructions and commands | `.opencode/agents/brain.md`；`.pi/brain-workflow.md`；Pi extension 仅为 mode/session 入口 | 不写业务 authority；不建立第二事实源 | Runtime schema、MES state、Receipt、Gate、第二 Brain route |
| MES Contract / transaction layer | MES facts、status 一级/二级、semantic mutation boundary、binding/relation validation、异常计数与恢复写语义 | Markdown Contract + Runtime transaction implementation | `.agents/contracts/brain/mes.md` / `packages/runtime/src/mes/` | MES durable facts 与安全 materialization | Product/Technical reasoning、next action、Skill 内容、Gate/Receipt 语义、Project Stage Map；Brain 只拥有 semantic initiation/authorization，不拥有 full snapshot composition |
| Project Stage Map | project-level Rolling-Wave Planning 唯一 active map；保存 Stage id / depends_on / goal / entry criteria / Authority refs；不缓存 operational readiness | Markdown execution-owned artifact | `delivery/project-stage-map.md` | Git-tracked；唯一 writer = Planner（`proofloop-plan` MAP CHECK）；readers = Brain / Planner / SPV / Execute（按需只读） | MES operational state、next-Stage decision、execution scope、mutable readiness |
| Host Role documents | 对应 Host 的 role goal、entry、procedure、branch、mutation boundary、completion、result/transport discipline 与 native config | Markdown/frontmatter | `.opencode/agents/<role>.md`；`.pi/agents/<role>.md` | 无独立业务 state | 共享 MES/Result schema、另一个 Host 的 config、第二业务 authority |
| Subagent host adapter | Subagent host dispatch 从所选 Host 的 versioned 配置读取 runtime/model/variant config；ProofLoop 只依赖 dispatch identity invariant | Host adapter + native config | Pi `.pi/agents/*.md + .pi/subagents.json`；OpenCode `.opencode/agents/*.md` | 由 Subagent host 维护；versioned Host adapter，由 Git 跟踪 | ProofLoop workflow/Skill 不拥有 schema、Profile/Pool 或 variant 选择逻辑 |
| Brain Contracts | lifecycle 的 one-shot/continuation/review-loop/recovery、Result binding 与 close/reset 语义 | Markdown Contract | `.agents/contracts/brain/agent-lifecycle.md`、`multi-round-repair.md` 等 | 无额外状态 | Host native schema、Agent hidden reasoning 与 runtime/model 选择 |
| Subagent host control plane | Agent/session/process 创建、启动、复用、关闭 | Pi/OpenCode native host APIs | Host workspace/sessions | 由 Subagent host/宿主管理 | ProofLoop 业务 Result/admission |
| Subagent host adapters | Agent/session/process dispatch and Result transport | Pi native `Agent`/`resume`/`get_subagent_result`；OpenCode child dispatch/child `sessionID`/returned result | Host-native APIs | 不产生 ProofLoop authority | lifecycle/business route 与 dispatch identity selection |
| Runtime/Kernel | 机械 CLI（`boundary close`、`integration apply`）、MES snapshot/seed、fact/binding/relation validation、operational transaction materialization、status projection，以及 root/path/Git/process 安全原语、ID/schema 校验 | TypeScript / Node | `packages/runtime`, `packages/kernel`; public `proofloop` CLI | `.proofloop/` + Git | Subagent host、harness SDK、Brain route/reasoning、Product/Technical Authority、第二 store/state machine |

### Components

| Component | Responsibility | Does not own | Inputs | Outputs | Dependencies |
|---|---|---|---|---|---|
| `packages/runtime/src/cli/proofloop.ts` | public `<domain> <operation>` dispatcher（`boundary`、`integration`）与顶层只读 MES `status` observation entry | 不派发 Agent，不写 Receipt/Manifest/Context/Evidence，不做 Brain route | closed JSON/request ref 或 status flags | JSON envelope + exit code | Runtime command adapters / MES status projection |
| `packages/runtime/src/cli/proofloop-boundary.ts` | 机械 Git boundary adapter（`boundary close`） | 不承担 Gate/Receipt 业务前置 | boundary request | Git 机械事务结果 | `git-boundary` 安全原语 |
| `.agents/contracts/brain/mes.md` | MES facts/status 语义与一次性 Pre-MES bootstrap write prohibition | 不做 reasoning，不生成 next action，不代表已实现 | Brain 路由决策、Result/Finding、Git facts；bootstrap 前仅 Git/Plan evidence | MES durable facts / status projection | Technical Authority Pack、Host Role documents |
| `packages/runtime/src/cli/proofloop-integration.ts` | dedicated mechanical Integration adapter（`integration apply`） | 不承担 Brain/MES workflow classification | integration request | typed integration result / failure envelope | `git-integration` 安全原语 |
| `packages/runtime/src/mes/{store,bootstrap,validate,binding,status}.ts` | MES root-bound snapshot/seed、strict fact/binding validation、只读 status projection 与 operational transaction materialization | 不做 Brain route/dispatch/reasoning，不复制 Authority/Skill，不建立第二 store/state machine | semantic operational events / recovery authorization / status flags | durable JSON facts、validated relations、bounded status projection | root/path/TOCTOU primitives；`MesSnapshotStore` 仅为内部 full-state atomic persistence primitive |
| `.opencode/agents/brain.md` | OpenCode Brain primary | 完整 Brain route、dispatch、recovery、native permission 和 `task` transport；不复制 Runtime schema、不写业务事实 | current Authority、MES/Git facts、Role Agent 文档与 Contracts | Brain route/dispatch decisions | Runtime transaction 与业务 Result schema |
| `.pi/brain-workflow.md` / `.pi/extensions/proofloop-mode.ts` | Pi Brain workflow / mode-session entry | `.pi/brain-workflow.md` 承载完整流程；extension 只负责 mode/session，不创建第二 route | current Authority、MES/Git facts、Pi Role Agent 文档与 Contracts | Brain route/dispatch decisions | Runtime transaction 与业务 Result schema |
| Planner Agent documents | Planning 方法：MAP CHECK → current Stage candidate Thin Plan；SPV 闭环、impact-based Replan | 不修改 canonical Authority；不投影 JIT Work Packet | Authority + Project Stage Map + code reality + Git/Plan basis | planning artifacts / `CANDIDATE_PLAN_READY` | SPV、MES status（仅 normal） |
| `proofloop-execute` Skill | Execute 方法（Brain-side）：Slice lane、Worker lifecycle、CV、Integration、cleanup；拥有 Slice Work Packet / per-Task JIT Read Set 的 projection——Brain running `proofloop-execute` 读取完整 accepted Plan、逐 Step 选择当前 dependency-ready Task 并只投影该 Task 的 JIT input（accepted Thin Plan + MES/Git/current dependency outputs → execution input；Worker 不自行选择 successor、不重组 future Task）；bootstrap 仅首个 MES-persistence Stage | 不生成 next action；不重新设计 Stage/Slice/Task goal / dependencies | accepted Thin Plan + MES/Git/current dependency outputs；bootstrap 用 Git/Authority binding，不依赖 MES | Slice Work Packet / 当前 Task JIT input、Slice 执行结果 / INTEGRATED | Worker、CV、Git worktree |
| `stage-reviewer` Skill | Review 方法：三轴 Outcome / Composition / Authority | 不 route repair/replan | integrated Stage snapshot + Authority + Acceptance | STAGE_ACCEPTED / FINDINGS / BLOCKED | Existing MES Result/Finding/Stage relations |

## 5. Technical Context

- Language/runtime: TypeScript，Node 25 当前环境；Runtime/Kernel 使用现有 npm workspace。
- Frameworks: 无新增运行时框架；测试使用 Node 内置 `node:test`。
- Build: `npx tsc -b --force packages/kernel packages/runtime`。
- Test/build boundary: Git 测试只在临时 Git fixture 中运行；不修改生产 Runtime 语义。
- `proofloop.ts` public CLI 提供 `boundary close` 与 `integration apply` 两个 mechanical domains，以及顶层只读 `proofloop status [--detail]` / `--json` observation entry；旧 business-control domain（authority/plan/context/stage/review/project/doctor/gate/recovery/cutover）不得存在。
- MES Runtime seam 提供 root-bound JSON snapshot/seed、strict fact/binding validation、只读 status projection 与 operational transaction materialization；Brain/Host 只发起/授权 semantic event，不能维护 full snapshot；完整 Brain/Flow cross-runtime E2E 与 transaction implementation evidence 由后续 remediation Plan 验证，不把 progress 写成 Authority fact。
- `.agents/contracts/brain/mes.md` 定义 MES facts / status 一级二级 / 写入边界；两个 Host Brain 文档各自定义 route/dispatch/recovery，两个 Host 的 Role Agent 文档各自定义角色步骤；Contracts/templates 定义共享生命周期、binding 与 Result schema。
- Storage: `.proofloop/` and Git are durable facts after MES seed; `delivery/project-stage-map.md` 是 Git-tracked execution-owned planning artifact（writer=Planner），accepted/candidate Thin Plan 经 `project_stage_map_ref`（+ 同 Git basis）引用 current Map entry；during one-time `PRE_MES_BOOTSTRAP`, Git baseline/current + canonical Authority refs + candidate/accepted Git Plan facts（when available）是 durable recovery inputs，after `PLAN_READY` accepted Thin Plan is Git-tracked。`.agents/skills/**` 与 `.agents/contracts/**` 是 Git-tracked project specification files；所选 Host adapter（Pi `.pi/agents/*.md + .pi/subagents.json`；OpenCode `.opencode/agents/*.md`）是 versioned Host adapter subagent-dispatch config，不是 Git-tracked project truth，也不是 currentness 输入。
- Target platform: Linux first；其他平台为后续实机验收。
- Security: root-bound paths、受保护 `.proofloop/`/`.git/`、deny-by-default 权限；
  Agent metadata 不成为业务 authority。

## 6. Runtime Flows

### Flow: Propose → PROPOSE_READY

- Trigger: 新项目/新整改进入 Propose。
- Steps: `ai-structured-prd` 建立 Product Authority →（按需 `prd-to-tech-design-prep`
  处理产品级技术澄清）→ `prd-to-ai-architecture` 形成 Architecture / Contracts /
  Acceptance Technical Authority Pack → 一次 `PROPOSE_READY`。
- Success: `PRD.md` Product Authority 与 `tech-spec/` Technical Authority Pack durable；无独立 pipeline gate。
- Failure: 决策级 HITL 未完成或 Authority 缺口时停在 Propose，不进入 Planning。

### Flow: Pre-MES bootstrap Planning → PLAN_READY

- Trigger: stable Git baseline with MES persistence not yet integrated/seeded (`PRE_MES_BOOTSTRAP`).
- Steps: Brain reads PRD + Technical Authority Pack + current code reality + Git baseline/current facts → dispatches `proofloop-plan` without MES status/work identity/accepted Plan → Planner 先 MAP CHECK（active Map 缺失则创建首份 Map 并选定 current dependency-ready Stage）→ current Stage candidate Thin Plan（downstream refs tech-spec-only）→ candidate Git boundary → independently dispatches `stage-plan-verifier`（basis = candidate Plan + 同 Git basis 的 Map entry + PRD/tech-spec handoff basis + candidate Git basis）→ `PLAN_READY`.
- Acceptance: Brain accepts the Git-tracked Thin Plan without MES write; only the first MES-persistence Stage may be routed to Execute with bootstrap bindings.
- Failure: missing Authority/Git/candidate facts or SPV findings remain typed blockers; no MES/status/Receipt/Manifest/Gate/second state machine is claimed.

### Flow: Planning → PLAN_READY

- Trigger: `PROPOSE_READY` 或上一 Delivery Stage 被 `STAGE_ACCEPTED`（rolling-wave；Brain 以 current Map + MES/Git facts 判断下一 Planning entry，不重做 Stage decomposition）。
- Steps: `NORMAL` 下 Brain 从 MES status 读到 `PLANNING / skill=proofloop-plan` → 按两种 entry 派发 Planner（Map 缺失只传 bounded facts/path；Map 存在携带 current Map ref / Stage binding；不携带 Planning method）→ Planner 先 MAP CHECK → 读取 PRD + tech-spec + code reality + MES facts → 产出 current Stage candidate Thin Plan（downstream refs tech-spec-only）→ candidate Git boundary → Brain 独立派发 `stage-plan-verifier` 做只读 falsify（basis = candidate Plan + 同 Git basis 的 Map entry + PRD/tech-spec handoff basis + candidate Git basis）→ `PLAN_READY` → Brain 先写 `PLANNING_VERIFICATION_RESULT(candidate_plan_ref, accepted_plan_ref: null)`，再写 `PLAN_ACCEPTANCE`，之后 MES status 切到 EXECUTE。`PRE_MES_BOOTSTRAP` 使用上一节分支，不要求 MES status/work identity/accepted Plan，且 PLAN_READY 仅写入 Git-tracked Plan。
- Failure: SPV `FINDINGS` → finding 回 Brain（thin arbitration）→ Planner 先判 Plan-local vs Stage-Map impact：
  Plan-local gap → 只修订 current Thin Plan、Map 保持；Stage goal / dependency / boundary gap → Planner revision Map +
  affected Plan；分类按 carry_forward / invalidated / new-changed；Plan 或 Map material revision 都 → fresh full SPV。
- Invariants: `USER_INTENT_COVERED`、`TECH_AUTHORITY_RESPECTED`、
  `CODE_REALITY_GROUNDED`、`WORKER_EXECUTABLE`（Task 级 local closure、verification closure 与 future-HOW independence 成立）。

### Flow: Pre-MES bootstrap Execute（首个 MES-persistence Stage）

- Trigger: bootstrap `PLAN_READY` 已由 Brain 采纳为 Git-tracked Thin Plan，且 MES persistence 尚未集成/seed。
- Steps: 仅首个 MES-persistence Stage 以 `PRE_MES_BOOTSTRAP` Worker binding 执行；每 Task 使用 Plan/Authority/Git facts，Result 是结构化 Subagent transport evidence，不读/写/声称 MES Result；MES persistence 集成后 seed accepted Plan/bootstrap facts。
- Acceptance: seed 完成后永久禁止 `PRE_MES_BOOTSTRAP`，后续 Stage 只走正常 MES status → Execute → Review；不产生 Receipt/Manifest/Gate/第二状态机。
- Failure: 对非首个 Stage 使用 bootstrap、要求 pre-seed MES identity/status/resultRef 或无法从 Git + Plan 恢复时 typed blocker。

### Flow: Execute（Slice lane）

- Trigger: NORMAL：Brain 已完成 `PLAN_ACCEPTANCE`、accepted Plan binding current 且存在 dependency-ready Slice（`PLAN_READY` 仍为必要前置，但不构成完整 NORMAL Execute authorization）；`PRE_MES_BOOTSTRAP`：仅首个 MES-persistence Stage、以 Brain-accepted Git-tracked Thin Plan 为入口。
- Steps: one Slice = one Worker lifecycle + one isolated worktree + one logical Worker lane → Brain running `proofloop-execute` 读取完整 accepted Plan，逐 Step 选择当前 dependency-ready Task 并把该 Task 的 JIT input 投影给同一 Worker；Worker 只按当前 Task 输入实现，`NORMAL` Task Result 写 MES，`PRE_MES_BOOTSTRAP` Result 为 Git-bound Subagent transport evidence → `ACCEPTED + CONTINUE` 后 Brain/Execute 投影 successor current Task → self-check → `SLICE_CANDIDATE_READY` → fresh CV（Slice-level，`PASS | FINDINGS | BLOCKED`）→ CV PASS + candidate ref durable → `READY_TO_INTEGRATE` → Brain/Host
  Integration → `INTEGRATED` → cleanup（`CLEANUP_PENDING → CLEANED`）。
- State changes: `NORMAL` 只有 MES 记录 operational facts；bootstrap 窗口不写入/不声称 MES，CV PASS ≠ INTEGRATED。
- Failure: CV FINDING → Brain → bounded repair Worker → same CV bounded recheck；
  material basis change → fresh CV。Integration conflict → durable finding → Brain；
  仅纯机械且无语义选择的冲突可 bounded resolve。cleanup failure 不回退 `INTEGRATED`。
- 全部计划内 Slice integrated → `EXECUTION_READY_FOR_REVIEW`。

<!-- proofloop:entity id="review-flow" kind="seam" -->
### Flow: Review（三轴）
- Trigger: `EXECUTION_READY_FOR_REVIEW`。
- Steps: fresh runtime Review Agent 加载 `stage-reviewer` → Outcome → Composition → Authority 三轴独立验证 → 按 `.agents/contracts/brain/stage-review.md` 生成唯一 envelope → Brain 校验并通过现有 MES Result/Finding/Stage owner 记录 durable relations。
- 非 `PASS` 必须携带有序 `finding_evidence_refs`，由 Brain 交给现有 Finding / FINDING_DISPOSITION seam；narrative 不作为 durable evidence。
- 只有三个 axis 全部 `PASS` 且 integrated snapshot 匹配当前 Stage，Brain 才记录现有 accepted `stage` fact 与其 `result_ref` / Plan / Git support；不新增 Review 专属 Stage 字段。
- Invariants: Reviewer read-only；finding → Brain；不自行 route repair/replan；一个轴 PASS 不掩盖另一个轴 finding；Review schema 不由 Plan 或 Runtime status projection 重定义。
- Bounded recheck: Goal/Authority/Plan partition/material scope 未变时 same Reviewer fresh-read 新 snapshot + finding + repair diff 后 bounded recheck；重大 basis 变化 → fresh full review。

### Flow: PROJECT_READY

- Trigger: all planned Stages in the current Delivery cycle = `STAGE_ACCEPTED`.
- Steps: Brain 从 active Map 得到当前 Delivery cycle 的 planned Stage 集合，确认每个 ID 有 durable accepted-stage support 后，由现有 MES owner 记录该 cycle 的 `PROJECT_READY`；status 提醒 PM，不让 MES 读取 Map。
- Store invariant: 每个 `PROJECT_READY` terminal 按自身 planned Stage set 与 delivery/planning basis 保持 support 可重建；后续 cycle 的 Stage support 不使历史 terminal relation 失配。缺失或不一致时 fail closed。
- New NORMAL terminal writes append a chain edge: if no retained cycle-bearing terminal exists, the new terminal carries `supersedes_project_ready_ref: null`; otherwise it references the exact current chain tip (a pre-update retained terminal may be a read-only `legacy_cycle_anchor` with the predecessor field omitted). The resulting terminal relation is validated over submitted ∪ retained facts before write; historical/legacy terminal facts are never backfilled or rewritten.
- Success: PM 自行做最终产品验收；不 dispatch Project Reviewer，不设置 Human Required，不标记 BLOCKED。

### Flow: Delivery cycle continuation
- Trigger: 历史 `PROJECT_READY` 已存在，且收到新的实质工作、scope 增量或产品 intent 变化。
- Pre-conditions: current Product/Technical Authority、active Project Stage Map、Git reality 与 MES historical terminal facts 可重读；不把历史 terminal 当作当前 workflow phase。
- Steps: Brain 在“新用户工作或实质变更” Routing Boundary 进入 Propose → 形成新的 `PROPOSE_READY` → 进入 Planning；不得直接复用历史 `PROJECT_READY` 进入 Planning/Execute。
- State changes: 历史 terminal 保持 durable history；新 cycle 的 current Authority/Map/Plan/MES basis 独立推进，完成后产生自己的 `PROJECT_READY`。
- Success: 新 cycle 完成 `PROPOSE_READY` 后由既有 Planning route 接续；历史 terminal 与新 terminal 可按各自 basis 重建。
- Failure: 新工作缺少 Authority 或 scope/basis 不可证明时停在 Propose 或返回 typed blocker；不修改历史 terminal。
### Flow: Recovery

- Trigger: Agent/session/transcript 丢失、Subagent transport 发送失败或 Brain 重启。
- Steps: `PRE_MES_BOOTSTRAP` 时读取 Git baseline/current + canonical Authority + Git Plan facts，按 bootstrap binding recovery；seed 后 `NORMAL` recovery 重读 durable facts（MES status 作为 observation input、accepted Plan/binding、current Project Stage Map（Git-tracked，重建 Planner 基于哪张 Map 规划哪个 Stage）、Git reality、Result/Finding）→ 检查 active Work 是否仍有 live Agent → 不确定 work 标为 recovery → 对受影响节点恢复/重新 dispatch → 不相关节点继续。
- Success: 已有 durable work 不被重复实现；合法 continuation 继续，review trust 丢失则 reset。
- Failure: 无法证明 binding/identity 时 typed blocker；不恢复 hidden conversation、
  旧 session ID 或对话 transcript；不恢复旧 Primary Next Action / credential 链。
- 受影响 Stage/cycle continuation（`resume` / `replan` / `restart`）按 `planning-acceptance-succession` 与 `tech-spec/contracts.md` §2.2.4a 机械区分：`resume` 不写新 generation；`replan` 在同一 cycle 追加 accepted generation（fresh Planner + candidate boundary + fresh full initial SPV）；`restart` 在同一 generation 下以 fresh Work identity 重建执行事实；三者都不生成新 delivery cycle，也不 backfill/改写历史 facts。
- current code reality 已满足的 obligation 由 Thin Plan 的 `EXISTING_SEAM` 分类表达（`tech-spec/contracts.md` §4.1）：其 evidence 是 current snapshot 中可机器复核的 seam（pre-accept SPV 复核、final Stage Review 对 integrated snapshot 重新证明），不得为重建丢失的 operational history 伪造 Work/Task/Result/Git facts。

<!-- proofloop:entity id="mes-maintenance-recovery-flow" kind="seam" -->
### Flow: MES maintenance/recovery execution
- Trigger: 当 MES integrity incident 使受影响 Stage/cycle 的 NORMAL Execute/Review 与 NORMAL operational writes hard-frozen 时；public `status` projection 仍只是 observation。
- Preconditions: immutable root-bound forensic/audit closure; exact frozen MES snapshot digest/count; current canonical Technical Authority; exact Git branch/HEAD/worktree facts; Brain-authorized bounded recovery/maintenance scope; no reliance on `recovery-plan-r2` or `PRE_MES_BOOTSTRAP`.
- Steps: implement and test only against isolated fixture roots; use the MES transaction layer’s controlled internal seam rather than a raw full-snapshot writer; independently verify exact incident regressions, binding/no-write and invalid-history behavior; create a fresh exact-bound recovery candidate and SPV proof before one controlled recovery transaction.
- Success: recovery writes only the authorized recovery fact/epoch, immediately restores quarantine, then fresh rehydrate + relational audit + restart reconstruction pass. Brain 对受影响 Stage/cycle 做 impact-based `resume` / `replan` / `restart` decision。
- Continuation closure: the impact decision must be mechanically writable — `resume` keeps the current accepted generation, `replan` appends a new accepted Plan generation in the same delivery cycle through `planning-acceptance-succession`, and `restart` re-establishes fresh Work identities under the current generation. Recovery never creates a new delivery cycle and never backfills lost operational facts; obligations already satisfied by current code reality are expressed as `EXISTING_SEAM`, not as reconstructed history.
- Failure: any stale digest, missing/ambiguous evidence, transaction failure, audit failure or verification gap leaves MES quarantined and the affected Stage frozen; no retry loop, history surgery, normal write, or status-driven dispatch.
### Flow: Slice-level proof binding（FR-013）

- Trigger: Stage Plan 的局部变更（Task-local 或 Slice-wide）。
- Steps: 三层 fingerprinting —— Stage 全局契约（Stage 级）→ per-Slice 契约（Slice 级）→
  执行绑定（`NORMAL`: accepted Thin Plan ref + MES work identity + Git basis，accepted Plan 经 `project_stage_map_ref` 间接闭合同等 Git basis 的 Map entry；`PRE_MES_BOOTSTRAP`: candidate/accepted Git Plan ref + canonical Authority refs + Git basis + Stage/Slice/Task + actionToken）。
- Success: 只改 Slice C 时 A/B 完成证明保持有效；依赖链 A→C→D 中 A 改变只失效 A/C/D；
  Stage 全局契约改变时全部失效（正确行为）。
- Failure: 边界未证明时 fail closed；禁止"一个 Slice 改变就整个 Stage 重跑"（除非全局契约变）。

### Flow: Subagent host runtime variant change
- Trigger: 用户修改所选 Host 的 versioned Subagent runtime/model/variant 配置（Pi `.pi/agents/*.md + .pi/subagents.json` 或 OpenCode `.opencode/agents/*.md`）；Host 配置变更与业务 Git boundary 分离。
- Preconditions: 所选 Host 的 adapter path 与 native schema 保持稳定（不新增第二业务配置层或 template config）；配置由 Git 跟踪，缺失即配置阻塞。
- Steps: 下一次 `new`、`recovery` 或 `fresh` dispatch 由 Subagent host dispatch fresh-read 当前工作区的 versioned 配置；运行中的 Agent 保持原 runtime/model，不热切换、自动重启或迁移。
- Failure: 所选 Host 配置缺失，或其 native JSON/frontmatter/entry/variant schema 或 runtime 参数无效时，Subagent host adapter 在 launch 前返回既有 typed blocker；ProofLoop 不猜默认值、不 fallback/retry，也不新增第二业务配置源。

## 7. Hard Parts and Risk Register

> Hard Part 是 Architecture Authority 中的风险/未知项，不是独立 phase、Stage 或状态机。Researcher/Prototype 只提供有边界的技术证据；Brain 将结果路由给当前 owner，不能把结果直接当作 Authority 或完成事实。

### Register

| ID | Hard part | Status | Why hard | Forbidden shortcuts | Minimum acceptable implementation | Acceptance evidence | Residual risk |
|---|---|---|---|---|---|---|---|
| HP-001 | MES transaction ownership、snapshot completeness 与 binding-critical relation closure | BLOCKING | caller 组装 full snapshot 或手工复制 relation 会造成 partial replacement、fact loss 或 durable misbinding；MES 还必须保持非 reasoning。 | 不让 Brain/Host 维护 `submitted ∪ retained` snapshot；不让 Agent 直接写；不输出 next action；不以 insertion order/newest-wins/correction fact 选择 currentness；不建第二 store/controller。 | Brain/Host 只发起 semantic event；MES transaction layer preserve-by-default 读取 current state、解析 canonical binding、验证完整 resulting state、幂等并调用内部 `MesSnapshotStore` 原子持久化；relation-invalid history 保留但 non-authorizing。 | Sep 10 partial-replace、Sep 12 result-write、Sep 13 fact-gap/binding mismatch、caller-typo atomic no-write、restart invalid-history isolation、full-snapshot-writer static negative fixtures。 | transaction/API seam 与 snapshot primitive 发生 owner 漂移。 |
| HP-002 | Replan impact 分类与三层证明绑定 | HIGH | Slice-level proof binding 要求局部返工不连坐；分类错误会静默沿用受影响结果或错误失效无关结果。 | 不 blanket rollback；不用进度快照判断完成；不保存 session id 作权威；不为并行虚报允许范围；CV 通过后不自动 rebase。 | Stage 全局契约 + per-Slice 契约 + 执行绑定（`NORMAL`: accepted Thin Plan ref + MES work identity + Git basis，accepted Plan 经 `project_stage_map_ref` 间接闭合 Map basis；`PRE_MES_BOOTSTRAP`: candidate/accepted Git Plan ref + canonical Authority refs + Git basis）；复用 task-local / slice-wide / stage-wide / unresolved 分类和 dependency closure；Replan 先判 Plan-local（只改 Thin Plan、Map 保持）vs Stage-Map impact（Planner revision Map + affected Plan）；Plan 或 Map material revision 都 fresh full SPV。 | FR-013 Case 1-9 fixtures：局部变更、依赖链、全局契约、运行证明变化。 | 依赖闭包不完整导致错误分类。
| HP-003 | 三轴 Review 不互相掩盖 | HIGH | Outcome、Composition、Authority 任一轴缺口都必须可见。 | 不合并三轴分数；不以一个轴覆盖另一个；Reviewer 不修改代码/Plan/Authority，不自行 route。 | 每轴独立输出 `PASS | FINDINGS | BLOCKED` + evidence；三轴全部 PASS 且绑定 integrated snapshot 才 `STAGE_ACCEPTED`。 | Review no-masking fixture：一个轴 PASS、另一个轴 FINDINGS 时不得 accepted。 | Reviewer 可能用平均分掩盖单轴缺口。
| HP-004 | Recovery 不依赖旧凭证链/隐藏会话 | BLOCKING | Agent、session 或 Brain 丢失后必须从 durable facts 恢复，避免重做、伪造或恢复 hidden conversation。 | 不恢复 Primary Next Action、旧 credential chain、hidden conversation、旧 Subagent type/session 或 `idle`/`done`。 | 恢复输入 = `NORMAL`: MES + Planner/SPV candidate 或 Execute/Worker/CV/Review accepted Plan + Authority + structured Result/Finding + Git/worktree reality；`PRE_MES_BOOTSTRAP`: Git + candidate/accepted Git Plan + Authority + structured Subagent transport evidence + Git/worktree reality；受影响节点 recovery/re-dispatch，不重复 durable work。 | Agent loss / Brain restart fixtures；无关 Slice 继续；review trust 丢失时 fresh reset。 | 持久化不足导致状态不可重建。
| HP-005 | Verifier 不被 operational state 污染 | HIGH | Verifier 的 PASS/FINDING 必须基于 packet 的 target/basis/evidence，而非 MES status。 | 不把 status 当证据；不消费全量 MES；不把异常计数当 finding。 | dispatch packet 提供 target、Authority/Plan/Git basis、evidence；verifier read-only，finding 带可重读 refs。 | SPV/CV/Stage Review verifier-basis fixtures。 | Verifier 读 status 后可能产生偏见。
| HP-006 | 机械原语抽取不误删安全能力 | HIGH | 旧业务模型删除时，root/path、process、Git、protected-scope、ID/schema、replan-impact 安全能力必须保留。 | 不整体保留旧 business wrapper；不删除 path/process/Git/protected scope/ID/replan primitives；不建 compatibility layer。 | 机械原语与业务语义解耦：root-bound path、`shell:false`、bounded process、Git dirty/allowed-path、protected roots、closed schemas、replan classifier。 | mechanical primitive fixtures + import graph 复查。 | 抽取时可能把业务语义带回 primitive。
| HP-007 | `proofloop status` 与 MES transaction implementation boundary 不虚构 | MEDIUM | status 只读 observation；transaction layer must be the sole durable mutator, but rich aggregation and cross-runtime details must not be claimed before evidence | 不把 status 当 route/next action；不把未实现 L2 aggregation/progress 写成 runtime fact；不暴露 raw full-snapshot writer；不把 Brain narrative 当 transaction result | Runtime 提供 root-bound snapshot/seed、strict fact/binding/relation validation、atomic transaction seam 与 sparse/detail read-only projection；实现范围以 isolated tests / CV / review 为准 | status no-routing、transaction ownership、incident regression 与 implementation-honesty fixtures | 文档、Runtime 与 active Contract 可能漂移。 |
| HP-008 | Authority leakage 防护 | HIGH | PRD、Working Material 或 `.docs` 被 downstream 当作 Technical Authority 会造成双权威。 | 不把 CONTEXT 当 Authority；不把 PRD-only obligation 带入 accepted Plan/Work Packet/Skill；不把 `.docs` 规划当 tracked 验收权威。 | Planning/SPV 完成 PRD→tech-spec→Map/Plan closure；`PLAN_READY` 后 downstream 仅使用 tech-spec Pack；Thin Plan 只保留 canonical file + section/entity refs。 | STATIC-11；Authority refs fixtures。 | 复制正文或跨阶段读取造成 owner 漂移。 |
| HP-009 | 并行 Slice 的 MES 状态一致性 | MEDIUM | 一个 blocked Slice 不应阻断无依赖 Slice，detail 必须区分依赖阻断与自身异常。 | 不用全局锁串行化；不把所有异常暴露在一级；不吞掉 `blocked_by`；不把 observation DTO 冒充 canonical lifecycle。 | 二级按 Slice 记录 `INTEGRATED`/`REPLAN`/`EXECUTING`/`BLOCKED_BY`；一级只显示非零异常计数；真实 task dependency 由现有 Slice projection 处理。 | Parallel Slice fixtures：无依赖 Slice 可继续，blocked 只沿真实 Slice dependency 传播。 | 状态投影可能有竞态。
| HP-010 | Pre-MES bootstrap 自举闭环 | BLOCKING | 在 MES persistence 尚未集成/seed 时，Planner 与首个 MES-persistence Worker 仍必须可启动并可恢复，且 seed 后例外永久关闭。 | 不要求 pre-existing MES status/work identity/accepted Plan/resultRef；不把 bootstrap evidence 当 MES；不创建第二状态机/Receipt/Manifest/Gate/result store；不把 bootstrap 扩展到其他 Stage。 | `PRE_MES_BOOTSTRAP` 作为 bounded execution mode：Authority + Git baseline/current + candidate/accepted Git Plan binding；PLAN_READY 先落 Git，首个 Stage 用 Git-bound Subagent transport evidence，MES 集成后 seed 并永久切回 NORMAL。 | Pre-MES bootstrap E2E、launch/lifecycle/Worker negative assertions、seed closure fixture。 | 文档例外未贯通入口会导致 Planner 或首个 Worker 死锁。 |
| HP-011 | Historical terminal 与 current Delivery cycle 分离 | HIGH | `PROJECT_READY` 后新增 Stage support 若按全局集合校验，会错误否定历史 terminal，或把历史 terminal 当作当前终态而跳过 Propose。 | 不把仓库唯一 terminal、当前 HEAD、全局 accepted Stage 集合或 status projection 当作历史 terminal 的充分身份；不改写历史 planned set/basis；不新增 Project Gate/第二状态机；不以 terminal chain 之外的 Git、文件名、时间或插入顺序猜测 currentness。 | 每个 terminal 绑定自身 planned Stage set 与 delivery/planning basis；后续 cycle 通过既有新用户工作 Routing Boundary 进入 Propose；new NORMAL terminal 通过 `supersedes_project_ready_ref` 形成同一 durable terminal succession chain；status 由唯一 open cycle 或无 open cycle 时的唯一 chain tip 观察 current terminal；chain relation 与 public terminal adjunct 按 current-terminal-currentness-oracle 闭合。 | E2E-23；STATIC-30；历史/新 terminal rehydrate fixture；terminal-chain/currentness oracle fixture | 实现必须严格执行 Contract 的 terminal-chain oracle；关系损坏时 fail closed，不可退化为历史/Git/插入顺序猜测。 |
| HP-012 | Accepted Plan revision 在 open cycle 内是否可表示 | BLOCKING | recovery 出口承诺 `resume` / `replan` / `restart`，但若 accepted acceptance 只能有一个 (stage, cycle, ref, digest) identity，任何 material Plan revision 都写不进去——S06 post-recovery 实测确认三条出口全部被机械封死（同 cycle 双 plan identity fail closed、新 cycle 多 open cycle fail closed、同 `accepted_plan_ref` 第二 PA atomic no-write）。 | 不把 revision 表达为新 delivery cycle；不用 fingerprint、时间戳、插入顺序、newest-wins 或第二 pointer 选 current generation；不改写、删除或 backfill 历史 generation / support；不把 `EXISTING_SEAM` 当作跳过实现工作的借口；不新增第二 store/controller/state machine。 | `PLAN_ACCEPTANCE` 携带顶层 `supersedes_plan_acceptance_ref` 形成 per-(stage, cycle) append-only generation chain（唯一 tip = current）；新 generation 必须绑定 fresh `PLAN_READY` PVR 且允许 ref/digest 不变；绑定旧 generation 的下游 facts non-authorizing；`resume` / `replan` / `restart` 分别定义为不写 generation / 同 cycle 追加 generation / 同 generation 下 fresh Work identity；current code reality 已满足的 obligation 由 `EXISTING_SEAM` 表达。 | E2E-27/28/29；STATIC-34；generation chain / branch / stale predecessor / closed-cycle / unchanged-digest fixtures；post-recovery continuation fixtures | 实现必须严格执行 generation oracle；链损坏或歧义时 fail closed，不可退化为 (ref, digest) 或顺序猜测。 |


<!-- proofloop:entity id="mes-remediation-risk" kind="risk" -->
### MES integrity hard-freeze risk（conditional mechanism）
- While an integrity incident holds `.proofloop/mes` in quarantine, the affected Stage's NORMAL Execute/Review and all NORMAL MES writes are prohibited; the public `status` projection is observation only and cannot authorize dispatch.
- The implementation must be developed in isolated fixture roots. Real project MES snapshot bytes, fact IDs, forensic copy, the affected accepted Plan/Map, and existing dirty worktree state are not test fixtures and must not be altered.
- Closure requires the Authority-defined maintenance/recovery seam, independent CV/Review, exact incident regressions, fresh recovery candidate/SPV, one controlled recovery transaction, quarantine restoration and rehydrate/audit.
### Technical unknown routing

技术未知统一走 `TECHNICAL_UNKNOWN → Brain → researcher / prototype → structured evidence/result → 当前 owner`，不建立额外的 Hard Part phase：

- Propose 中发现未知：Researcher/Prototype 返回结构化结果；`prd-to-ai-architecture` 将结论吸收进本 Architecture Authority，必要时继续同一 Propose，最终仍只有 `PROPOSE_READY`。
- Planning 中发现未知：Planner 根据结果修订 Thin Plan；若结论改变 Architecture/Contracts，则返回 `AUTHORITY_GAP`，回到 Propose owner 后重新 Planning。
- Execute/Review 中发现未知：finding 先回 Brain，由 Brain 按影响范围路由 Researcher/Prototype、Repair、Replan 或对应 Authority owner；不新增第五阶段。
- 未验证的结果、Agent narrative、checkbox 或进度快照不能直接更新 Authority、Plan 或 MES 完成状态。

## 8. Dispatch identity and Role Contract

### Subagent host adapter

ProofLoop 不拥有 Profile/Pool architecture。所选 Subagent host adapter 的 dispatch 读取当前工作区 versioned config（Pi `.pi/agents/*.md + .pi/subagents.json`；OpenCode `.opencode/agents/*.md`，均由 Git 跟踪）；ProofLoop 只依赖以下 identity invariant：

```text
subagent_type := role_skill
```

- Brain/Host 在 workflow transaction 中选择 `role_skill`，为实例选择唯一 ephemeral live Subagent type/session，创建 session，取得 host session identity，再调用 Subagent dispatch；start 成功后才 send 最小 role packet。
- `role_skill` 与 `subagent_type` 一一对应；live Subagent type/session 只是实例地址，不与 `subagent_type` 相等，也不进入 MES、Result、Finding 或 Authority。
- Subagent host adapter 拥有 JSON/frontmatter schema、runtime/model 参数、variant 选择与 round-robin 语义；Host Agent workflow 不复制这些 native schema，不新增 alias、extends、Pool/Profile mapping 或 compatibility layer。
- 正常 dispatch 不依赖 peer registry；transport failure / launch failure 保持 typed blocker 和 fail-closed。

### Host Role document contract
Host Role 文档包含：role goal、entry conditions、procedure、mode/branch、mutation boundary、forbidden actions、capability skills、completion criteria 和 result discipline；各 Host 文档只引用共享 Contract/template 的字段语义，不复制 Host launch schema 或业务 Result schema。
## 9. Decision Log

| ID | Context | Decision | Consequences | Status |
|---|---|---|---|---|
| ADR-001 | 旧流程由第二套凭证链驱动 | 四阶段生命周期 + MES operational facts | 不再需要 Receipt/Manifest/Context 证明"已合法发生" | confirmed |
| ADR-002 | 流程权威分散 | canonical Authority 按 phase 分层：PRD 为 Product Authority；Architecture/Contracts/Acceptance 为 Technical Authority Pack；`PLAN_READY` 后 tech-spec Pack 是 downstream normative truth | Planning/SPV 负责 PRD→tech-spec handoff；accepted Plan 是 execution instruction；CONTEXT 降为 Working Memory | confirmed |
| ADR-003 | Brain 依赖 Runtime 推导下一动作 | Brain 改为 host-local workflow/event/state/guard-driven control plane：OpenCode `.opencode/agents/brain.md` 与 Pi `.pi/brain-workflow.md` 各自定义允许 action 和合法 transition；status 是 observation input，不是每个 model turn 的强制第一步；进入具体 Role/Contract 后连续工作，直到 completion / transition / blocker / invalidation 再重新路由 | Brain 不消费旧 Primary Next Action；workflow 约束 actions、不约束 internal reasoning；correctness guards 仍要求事务型 fresh validation | confirmed |
| ADR-004 | 整本计划指纹导致连坐 | Slice-level proof binding 三层 fingerprinting | 局部返工不使无关 Slice 失效；Task-local / Slice-wide Replan 分类 | confirmed |
| ADR-005 | Slice 完成定义模糊 | CV PASS ≠ INTEGRATED；Integration 是独立步骤 | 只有 Integration 成功才 INTEGRATED；cleanup failure 不回退 | confirmed |
| ADR-006 | 项目终态不确定 | all Stage accepted → PROJECT_READY；无 Project Reviewer/Gate | PM 自行最终验收；PM 未验收不标记 BLOCKED | confirmed |
| ADR-007 | 宿主与流程 authority 混淆 | Subagent host adapter 承担 Subagent dispatch / launch / transport；所选 Host 的 versioned launch config（Pi `.pi/agents/*.md + .pi/subagents.json`；OpenCode `.opencode/agents/*.md`，不是 Git-tracked project truth）与 ProofLoop 业务语义分离；ProofLoop invariant=`role_skill == subagent_type` | Subagent type/session/session/transcript/message id 只作 ephemeral；Brain 不解析 Profile/Pool 或 Subagent host adapter schema | confirmed |
| ADR-008 | 旧代码删除风险 | 机械原语（path/process/Git/protected-scope/ID-schema/replan-impact）先抽取再删除业务 wrapper | 不丢失安全能力；不建 compatibility layer | confirmed |
| ADR-009 | MES 状态暴露过多 | status 最小暴露（scope/phase/Skill/非零异常计数），二级按需下钻 | Agent 不被全量 MES 灌入；verifier 以 packet basis 为准 | confirmed |
| ADR-010 | `proofloop status` observation seam 与 durable transaction ownership 必须分离 | Runtime 提供 root-bound seed/snapshot read、只读 sparse/detail status 与唯一 MES transaction seam；status 只观察，Brain/Host 只发起 semantic event，transaction layer 负责 durable materialization；不把未完成 aggregation/progress 写成 capability fact | transaction layer 的完整实现与跨 runtime E2E 由 bounded remediation Plan 证明；不暴露 raw full-snapshot writer | confirmed |
| ADR-011 | MES durable write-back ownership 不能依赖 caller full-snapshot assembly | Brain/Host 只发起/授权 semantic event；MES operational transaction layer 是唯一 normal durable mutator，负责 current-state read、fact/relation materialization、canonical binding、preserve-by-default、idempotency、complete-result validation 与 atomic persistence；`PRE_MES_BOOTSTRAP` 只在 seed 前一次性有效，seed 后永久禁止 | 不新增 phase/status/Gate/Receipt/第二 state machine；`MesSnapshotStore` 只作为内部 primitive；normal Result/Finding/Review/Git facts 经 transaction layer 物化 | confirmed |
| ADR-012 | 两侧各自维护完整 Brain workflow | Pi 与 OpenCode 是独立 Host，各自 Agent 文档必须承载完整 Brain/Role 工作流程；共享 Contract/template 只拥有业务字段和事务语义，不再设置第三份 workflow source | 两侧 procedure 语义一致、Host 独立加载；无第二 controller 或第二业务事实源 | confirmed |
| ADR-013 | Planning 的 Stage 集合与 operational readiness 分属两个 source | `delivery/project-stage-map.md` 是唯一 active execution-owned Git-tracked rolling map（writer=Planner 的 MAP CHECK）；current readiness / executing / accepted 由 MES/Git facts 表达；accepted/candidate Plan 经 `project_stage_map_ref` 间接绑定 Map basis | Map 不缓存 readiness，MES 不生成 Stage graph；Plan 或 Map material revision 都 fresh full SPV；不新增 MES fact kind | confirmed |
| ADR-014 | Review envelope 与 durable relation owner 混淆 | `.agents/contracts/brain/stage-review.md` 是唯一 envelope / Return-code schema owner；Technical Authority 仅规定 durable Review / Finding / Stage / Project relation semantics；具体 fields、adapter、replay 与内部实现由对应 owner 在 bounded grounding / TRACE 后确定 | 防止第二套 envelope schema 与 Authority implementation overfit；non-PASS evidence refs 与 terminal support 仍可恢复 | confirmed |
| ADR-015 | fa9d685 将 S04 过度扩展为 Stage graph、Review 专属 replay 与 legacy 双格式 | 以 PRD + current code reality 重做：保留 Slice-level parallel E2E-16、统一 accepted Stage fact shape、durable finding refs/support；撤回 Stage L2/graph、Review-specific replay/hash、legacy dual shape，除非未来独立需求重新证明必要 | S04 scope 收缩；Planning 先 TRACE 后 COMPOSE；既有 S01/S02/S03 facts 不改写 | confirmed |
| ADR-016 | `PROJECT_READY` 被误解为仓库永久终态 | 将 terminal 绑定到自身 Delivery cycle 的 planned set / delivery basis；历史 terminal 与 current workflow 分离，后续实质工作通过既有 Routing Boundary 回到 Propose | 允许多个 terminal 共存并可重建；status 观察 current cycle；不新增 Project Gate 或第二状态机 | confirmed |
| ADR-017 | Authority gap semantics had been narrowed to only PRD→tech-spec omission | Expand `AUTHORITY_GAP` to include grounded invalidation of current Technical Authority with unchanged Product intent; keep implementation choice, technical unknown, and real user decision routes separate | Planning/SPV remains claimed-route owner; ordinary Authority repair returns through Brain acceptance and `authority-update` without a user checkpoint | confirmed |
| ADR-018 | Per-Stage status could hide a legal current delivery terminal | Keep `PROJECT_READY` at delivery level and project current truth through existing terminal/current-cycle facts | Public status is read-only and deterministic; no second state source; current JSON/detail shape closes in Contract/Planning | confirmed |
| ADR-019 | 多个已完成 cycle 时无法从 PVR/PA 唯一推导 current terminal | 在既有 `project_ready` terminal relation 内增加 append-only `supersedes_project_ready_ref`；current terminal 是经 support closure 校验的 cycle-bearing terminal succession chain 的唯一 tip；有唯一 open cycle 时 open cycle 优先 | 不新增 fact kind、pointer/store/controller、Gate 或第二状态机；旧 terminal 不改写；分支/循环/缺失目标/重复 cycle/跨 cycle relation 与 public status 均 fail closed | confirmed |

| ADR-020 | S06 integrity incident exposes an unsafe NORMAL write path | Before any NORMAL continuation of an affected Stage, physically quarantine `.proofloop/mes`; treat public `status` phase/skill as observation only; retain current snapshot, facts, forensic artifacts and dirty worktree reality without rewriting the affected Plan/Map | Development and recovery stay blocked until a canonical maintenance/recovery seam and fresh impact decision are complete | confirmed | `mes-remediation-risk` / S06 incident evidence |
| ADR-021 | 修复 MES writer 不能依赖 writer 自己先写 NORMAL facts | Define a bounded maintenance/recovery implementation seam based on current Authority + exact Git + forensic/audit + frozen MES digest/count; it may validate/repair Runtime without NORMAL PVR/PA/recovery-baseline writes, bootstrap revival or fake facts; only the later controlled recovery transaction may materialize the authorized recovery fact | Requires fresh Authority acceptance, candidate Git boundary and independent SPV; any failure leaves quarantine and no retry | confirmed | `mes-maintenance-recovery-boundary` |
| ADR-022 | Caller-owned binding and invalid history caused durable misclassification | Transaction layer resolves or exact-validates binding-critical identities; mismatch is atomic no-write; immutable relation-invalid history remains auditable but permanently non-authorizing across restart | No correction-by-rewrite, newest-wins, insertion-order inference, backfill or raw full-snapshot normal API | confirmed | `mes-invalid-history-oracle` / `mes-operational-transaction-boundary` |
| ADR-023 | Recovery 出口承诺 `resume` / `replan` / `restart`，但 currentness/acceptance 模型无法表示同一 open cycle 内 accepted Plan 的合法 revision（S06 post-recovery 实测：同 cycle 双 plan identity fail closed、新 cycle 多 open cycle fail closed、同 `accepted_plan_ref` 第二 PA atomic no-write） | 引入 per-(stage, cycle) append-only accepted-Plan generation chain（`PLAN_ACCEPTANCE` 顶层 `supersedes_plan_acceptance_ref`，唯一 tip = current）；pre-accept PVR 降为 verification evidence；允许 fresh 验证后 ref/digest 不变的新 generation；`EXISTING_SEAM` 表达由 current code reality 已满足的 obligation | 不新增 fact kind、cycle、store、pointer、phase 或 Gate；历史 generation/support 不改写且绑定旧 generation 的 facts non-authorizing；branch / 环 / 悬空 / stale predecessor / 多 tip / closed cycle fail closed | confirmed | `planning-acceptance-succession` / `current-terminal-currentness-oracle` |
## 10. Open Questions

| Question | Why it matters | Blocking? | Proposed default |
|---|---|---|---|
| `proofloop status` 的丰富 L2 operational aggregation | MES observation layer 完整落地 | No | `status [--detail]` / `--json` 是最小 projection；按 mes.md 扩展，不输出 route/next action |
| MES operational transaction implementation / rich aggregation | transaction layer 与 status detail 的具体实现仍需后续 bounded Planning；ownership / preserve-by-default / binding / no-write 语义已由本 Propose 确认 | No（实现范围） | root-bound JSON snapshot + internal MesSnapshotStore；不暴露 raw full-snapshot writer 给 Brain/Execute |
| Stage / Slice / Task 最终 machine schema | Thin Plan / Work Packet 机器可校验 | No | 实现时确定，不新增 Authority 文件 |
| Planner packet/result schema、SPV/CV Result schema | dispatch/result 结构化 | No | 在对应 Skill/Contract 中确定 |
| Pi/OpenCode Subagent host adapter 与跨 runtime 闭环 | 跨 runtime dispatch 实机可用 | Yes（实现 gate） | 未证明即 RUNTIME_BLOCKER，不写 workaround |
| terminal succession / currentness oracle implementation | Runtime 必须把既有 terminal relation 的显式 predecessor edge 与 public status adjunct 投影为可重启机器行为 | No（implementation scope） | 严格实现 `tech-spec/contracts.md#/entities/current-terminal-currentness-oracle`；不新增 terminal pointer、store/controller、phase 或第二状态源 |
