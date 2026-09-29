# Planning Flow Contract

- 位置：`.agents/contracts/brain/planning.md`
- 角色：Brain-owned **Planning Flow orchestration** 的唯一 canonical source。只描述 Brain 在 Planning Flow 内的 event → transition → dispatch / authorization；**不包含 Planner 的 Planning HOW**（MAP CHECK / BIND / TRACE / COMPOSE SLICES / VALIDATE SLICE TOPOLOGY / DECOMPOSE TASKS BY SLICE / RECONCILE / CLOSE / FREEZE 等属于 `planner` Role Skill）。
- 引用：Brain 按 `.agents/contracts/brain/workflow.md` §3.1 的 event-local pointer 进入本 Contract；本文件不复制 workflow body、Planner HOW 或 mechanical 事务正文。

## 1. 进入与退出

- **进入**：Routing Boundary 选择 Planning Flow（`PLANNING_ENTRY`）。前置 predicate = `MES initialized + current PROPOSE_READY`（该判定只属于 Brain，Planner 不重复检查；MES 可提前初始化，只建立 infrastructure metadata）。
- **退出**：`PLAN_ACCEPTANCE` 完成后 Planning 完成，accepted Plan 成为 execution instruction，Brain 按 workflow 进入 Execute Flow（`.agents/contracts/brain/execute.md`）。
- Planning 只有在 fresh SPV 返回 `PLAN_READY` 且 Brain 完成 Plan acceptance 后才允许进入 Execute；candidate Plan 不自动成为 accepted Plan。

## 2. Event → Transition

顶层只保留 event → branch pointer；只有当前 event 对应的 branch 进入 active context。

### 2.1 PLANNING_ENTRY

- Brain 确认 entry predicate（`MES initialized + current PROPOSE_READY`）与四个 canonical Authority path presence observation（present / missing / unreadable，read-only，不判断内容）。
- dispatch Planner：`start(name, config_agent="planner")`；只传 current target / binding / fact refs / mutation boundary（`project_root`、active Map target/path、canonical Authority refs、current MES/Git facts / Git basis、Planner write paths、actionToken），**不携带 Planning method**。
- 期待结果：Planner 返回 `CANDIDATE_PLAN_READY` 或 typed blocker。

### 2.2 CANDIDATE_PLAN_READY

- Brain 消费 Planner 的 `CANDIDATE_PLAN_READY`（携带 `candidate_plan_ref`、`project_stage_map_ref`、`stage_id`、`authority_refs`、`git_basis`、`actionToken`）。**本 §2.2 是 Planner Result envelope 字段闭集与 binding 的唯一 owner**：Planner Role Skill 与 Brain 都引用本 source，Planner Skill 不复制、Brain 不通过加载 Planner Skill 获得该 schema。
- Brain 负责建立 candidate Git boundary（mechanical `stage-plan` boundary，语义按 `.agents/contracts/brain/commit-boundary.md`）。
- Brain dispatch 独立 `stage-plan-verifier`（SPV）：`start(name, config_agent="stage-plan-verifier", with=plannerName)`，basis = candidate Plan + 同 Git basis 的 Map entry + Authority + candidate Git basis。
- 期待结果：SPV 返回 `PLAN_READY | FINDINGS | BLOCKED`。
- 边界：Planner 到 `CANDIDATE_PLAN_READY` 即结束；candidate Git boundary / SPV dispatch / acceptance 均不属于 Planner Role Skill。

### 2.3 SPV_FINDINGS / SPV_BLOCKED

- SPV 结果一律先回 Brain；raw finding 只是 evidence，不是 Planner 指令。
- Brain 重读 Authority / Plan / scope / code reality 后产生 `FINDING_DISPOSITION`（语义与 materialization 按 `.agents/contracts/brain/finding-convergence.md` 与 `mes.md`）。
- 有效 Finding：按 impact 路由 Replan（Plan-local → 只修订 current Thin Plan；Stage-Map impact → Planner 修订 Map + 受影响 Plan），随后 Planner continuation / fresh Planning as current basis requires。
- `VERIFIER_OVERREACH`：`accepted_route_code` 为空，不触发 Replan。
- `BLOCKED`：结构化 blocker 回 Brain；按 blocker 分类 route（`AUTHORITY_GAP` → 当前 Propose Authority owner；`TECHNICAL_UNKNOWN` → Researcher/Prototype；其它 → 对应 typed route）。
- Plan 或 Map material revision 后，必须在新的 exact tuple 上建立 candidate boundary 并调度 **fresh full SPV initial verification**，不复用旧 verdict、不存在默认 bounded recheck。

### 2.4 SPV_PLAN_READY → PLAN_ACCEPTANCE

- `NORMAL` 下 Brain 授权 semantic planning event，经 MES transaction layer 依次 materialize：
  1. `PLANNING_VERIFICATION_RESULT`（`candidate_plan_ref` 必填、`accepted_plan_ref: null`，pre-accept PVR 只是 verification evidence）；
  2. `PLAN_ACCEPTANCE`（accepted Plan binding；同一 (stage, cycle) 内按 append-only `supersedes_plan_acceptance_ref` generation chain 追加，唯一 tip = current；语义按 `mes.md` 与 `tech-spec/architecture.md#/entities/planning-acceptance-succession`）。
- S06 integrity hard-freeze 下禁止 NORMAL acceptance；`MES_MAINTENANCE` 的 recovery candidate `PLAN_READY` 只是 maintenance/recovery evidence，closure 前不写 PVR/PA、不进入 NORMAL Execute。
- 完成后 Planning 完成 → 进入 Execute Flow。

## 3. Replan 与 continuation

- `resume`：不写新 generation，继续使用 current accepted generation。
- `restart`：Planning tuple 未变时于同一 generation 下重开受影响 Slice lane（Work identity 换新），上一 attempt facts 只作历史。
- `replan`：同一 cycle 追加 accepted Plan generation（fresh Planner + candidate boundary + fresh full initial SPV）。三者都不生成新 `delivery_cycle_id`、不 backfill / 改写历史 facts（`tech-spec/contracts.md` §2.2.4a）。
- 路由：Execute/Worker/CV 遇到 `PLAN_GAP` 统一回退 Brain 路由 Planning Flow 进行 Replan；Execute downstream 不直接 claim Product→Technical `AUTHORITY_GAP`。

## 4. Context pointers（本 Flow 内事件所需的唯一 owner）

| WHEN | READ |
|---|---|
| `PLANNING_ENTRY` | 本文件 §2.1；`agent-lifecycle.md`（dispatch）；`mes.md`（initialization / presence observation） |
| `CANDIDATE_PLAN_READY` | 本文件 §2.2；`commit-boundary.md`（candidate Git boundary）；`agent-lifecycle.md`（SPV review-loop） |
| SPV `FINDINGS` / `BLOCKED` | 本文件 §2.3；`finding-convergence.md`；`agent-lifecycle.md` |
| `SPV_PLAN_READY` / Plan acceptance | 本文件 §2.4；`mes.md`（PVR / PA materialization） |
| Replan / continuation 决策 | 本文件 §3；`agent-lifecycle.md`；`mes.md` |

Planner 的 Planning HOW 唯一 owner 是 `.agents/skills/planner/SKILL.md`；本 Contract 不复制 MAP / TRACE / COMPOSE / DECOMPOSE 等 Planner method，也不通过加载 Planner Role Skill 获得这些 method。

## 5. 硬边界

- 本 Contract 只拥有 Planning Flow orchestration（event → transition → dispatch / authorization）；不承担 Planner 分解职责，不复制 Planning method。
- 不修改 Authority / MES / Git 业务语义；MES operational transaction layer 是 NORMAL durable fact 的唯一写入者。
- 不调用旧 Runtime CLI、不写 Receipt/Manifest/Gate；planning 相关机械事务（Git boundary、MES materialization）由对应 Contract 拥有。
